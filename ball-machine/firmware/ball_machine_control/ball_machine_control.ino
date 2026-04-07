/**
 * Ball thrower: AS5600 RPM, BTS7960B (single-direction PWM), feeder servo.
 * Serial 115200: TARGET_M, TARGET_RPM, AUTO_RPM, SET_BAND*, ARM, DISARM, STOP, SET_* tuning
 * Telemetry: STATE, RPM, TARGET_RPM, DIST_M, ERR
 */

#include <Wire.h>
#include <Servo.h>

// --- Pin map (adjust for your wiring) ---
// Uno: Servo library disables PWM on 9+10 — keep motor PWM off those pins.
static const uint8_t PIN_RPWM = 5;
static const uint8_t PIN_LPWM = 3;
static const uint8_t PIN_REN = 7;
static const uint8_t PIN_LEN = 8;
static const uint8_t PIN_SERVO = 9;

// AS5600
static const uint8_t AS5600_ADDR = 0x36;
static const uint8_t REG_RAW_ANGLE_H = 0x0C;

// Timing (defaults; runtime-tunable via serial SET_*)
static const uint32_t TELEMETRY_MS = 120;
static const uint32_t RPM_SAMPLE_MS = 30;
static uint32_t g_dwellHoldMs = 280;
static uint32_t g_feedHoldMs = 220;
static uint32_t g_cooldownPeriodMs = 900;
static const uint32_t STALL_CHECK_MS = 2000;
static float g_stallPwmThreshold = 160.0f;
static float g_stallRpmThreshold = 8.0f;

// Distance bands: [min_m, max_m) -> target RPM (tunable via SET_BAND / SET_BAND_COUNT)
#define MAX_BANDS 6
struct Band {
  float minM;
  float maxM;
  int rpm;
};

static Band distBands[MAX_BANDS] = {
    {0.55f, 1.15f, 50},
    {1.15f, 2.20f, 100},
    {2.20f, 30.0f, 150},
    {0.0f, 0.0f, 0},
    {0.0f, 0.0f, 0},
    {0.0f, 0.0f, 0},
};
static int numBands = 3;

static bool manualRpmOverride = false;
/** When false, dwell never auto-triggers FEEDING — use FEED_ONCE from host */
static bool g_autoFeedFromDwell = true;

// PI gains (tune on hardware; SET_KP / SET_KI / ...)
static float g_kp = 2.8f;
static float g_ki = 0.35f;
static float g_pwmMax = 220.0f;
static float g_rpmTolRatio = 0.08f;

enum RunState : uint8_t {
  ST_IDLE = 0,
  ST_SPINUP,
  ST_FEEDING,
  ST_COOLDOWN,
  ST_FAULT
};

Servo feeder;

bool armed = false;
float targetDistM = 0.0f;
int targetRpm = 0;

float rpmMeasured = 0.0f;
float integral = 0.0f;
float pwmOut = 0.0f;

RunState state = ST_IDLE;
uint32_t lastTelemMs = 0;
uint32_t lastRpmMs = 0;
uint16_t lastAngle = 0;
bool angleInit = false;

uint32_t dwellAccumMs = 0;
uint32_t feedPhaseMs = 0;
uint8_t feedStep = 0;
uint32_t cooldownStartMs = 0;

uint32_t stallAccumMs = 0;
String errMsg = "";

uint32_t lastControlMs = 0;

String rxLine;

static uint16_t readAngleRaw() {
  Wire.beginTransmission(AS5600_ADDR);
  Wire.write(REG_RAW_ANGLE_H);
  if (Wire.endTransmission(false) != 0) return 0xFFFF;
  if (Wire.requestFrom((int)AS5600_ADDR, 2) != 2) return 0xFFFF;
  uint8_t h = Wire.read();
  uint8_t l = Wire.read();
  return ((uint16_t)h << 8 | l) & 0x0FFF;
}

static int distanceToTargetRpm(float m) {
  if (m < 0.05f) return 0;
  for (int i = 0; i < numBands; ++i) {
    if (m >= distBands[i].minM && m < distBands[i].maxM) {
      return distBands[i].rpm;
    }
  }
  return 0;
}

static void bandsResetDefaults() {
  distBands[0] = {0.55f, 1.15f, 50};
  distBands[1] = {1.15f, 2.20f, 100};
  distBands[2] = {2.20f, 30.0f, 150};
  for (int i = 3; i < MAX_BANDS; ++i) {
    distBands[i] = {0.0f, 0.0f, 0};
  }
  numBands = 3;
  if (!manualRpmOverride) {
    targetRpm = distanceToTargetRpm(targetDistM);
  }
}

/** Full line: SET_BAND idx min max rpm */
static void handleSetBandLine(const String& s) {
  if (!s.startsWith(F("SET_BAND"))) return;
  String rest = s.substring(8);
  rest.trim();
  int a = rest.indexOf(' ');
  if (a < 0) return;
  int idx = rest.substring(0, a).toInt();
  if (idx < 0 || idx >= MAX_BANDS) return;
  String r2 = rest.substring(a + 1);
  r2.trim();
  int b = r2.indexOf(' ');
  if (b < 0) return;
  float mn = r2.substring(0, b).toFloat();
  String r3 = r2.substring(b + 1);
  r3.trim();
  int c = r3.indexOf(' ');
  if (c < 0) return;
  float mx = r3.substring(0, c).toFloat();
  int rpm = r3.substring(c + 1).toInt();
  if (mn >= mx || mn < 0.0f || mx > 120.0f) return;
  if (rpm < 0) rpm = 0;
  if (rpm > 500) rpm = 500;
  distBands[idx].minM = mn;
  distBands[idx].maxM = mx;
  distBands[idx].rpm = rpm;
  if (idx + 1 > numBands) numBands = idx + 1;
  if (!manualRpmOverride) {
    targetRpm = distanceToTargetRpm(targetDistM);
  }
}

static void motorPwmForward(float pwm) {
  if (pwm < 0) pwm = 0;
  if (pwm > g_pwmMax) pwm = g_pwmMax;
  int p = (int)(pwm + 0.5f);
  analogWrite(PIN_RPWM, p);
  analogWrite(PIN_LPWM, 0);
}

static void motorStop() {
  analogWrite(PIN_RPWM, 0);
  analogWrite(PIN_LPWM, 0);
}

static void setState(RunState s) {
  state = s;
}

static void reportTelemetry() {
  Serial.print(F("STATE "));
  switch (state) {
    case ST_IDLE:
      Serial.print(F("IDLE"));
      break;
    case ST_SPINUP:
      Serial.print(F("SPINUP"));
      break;
    case ST_FEEDING:
      Serial.print(F("FEEDING"));
      break;
    case ST_COOLDOWN:
      Serial.print(F("COOLDOWN"));
      break;
    case ST_FAULT:
      Serial.print(F("FAULT"));
      break;
  }
  Serial.println();

  Serial.print(F("RPM "));
  Serial.println(rpmMeasured, 2);

  Serial.print(F("TARGET_RPM "));
  Serial.println(targetRpm);

  Serial.print(F("DIST_M "));
  Serial.println(targetDistM, 3);

  if (errMsg.length() > 0) {
    Serial.print(F("ERR "));
    Serial.println(errMsg);
    errMsg = "";
  }
}

static void handleCommand(const String& line) {
  String s = line;
  s.trim();
  if (s.length() == 0) return;

  if (s == F("ARM")) {
    armed = true;
    integral = 0.0f;
    dwellAccumMs = 0;
    if (state != ST_FEEDING && state != ST_COOLDOWN && state != ST_FAULT) {
      setState(ST_SPINUP);
    }
    return;
  }
  if (s == F("DISARM")) {
    armed = false;
    motorStop();
    pwmOut = 0;
    integral = 0.0f;
    dwellAccumMs = 0;
    feeder.write(0);
    if (state != ST_FAULT) setState(ST_IDLE);
    return;
  }
  if (s == F("STOP")) {
    armed = false;
    motorStop();
    pwmOut = 0;
    integral = 0.0f;
    dwellAccumMs = 0;
    feedStep = 0;
    feeder.write(0);
    setState(ST_IDLE);
    return;
  }
  if (s == F("FEED_ONCE")) {
    if (!armed || targetRpm <= 0) return;
    if (state == ST_FAULT) return;
    if (state == ST_FEEDING || state == ST_COOLDOWN) return;
    feedStep = 0;
    feedPhaseMs = millis();
    dwellAccumMs = 0;
    setState(ST_FEEDING);
    return;
  }
  if (s.startsWith(F("AUTO_FEED"))) {
    int sp = s.indexOf(' ');
    if (sp < 0) return;
    int v = s.substring(sp + 1).toInt();
    g_autoFeedFromDwell = (v != 0);
    return;
  }
  if (s.startsWith(F("TARGET_RPM"))) {
    int sp = s.indexOf(' ');
    if (sp < 0) return;
    int r = s.substring(sp + 1).toInt();
    if (r < 0) r = 0;
    if (r > 500) r = 500;
    targetRpm = r;
    manualRpmOverride = true;
    integral = 0.0f;
    dwellAccumMs = 0;
    if (armed && state != ST_FEEDING && state != ST_COOLDOWN && state != ST_FAULT) {
      setState(ST_SPINUP);
    }
    return;
  }
  if (s == F("AUTO_RPM")) {
    manualRpmOverride = false;
    targetRpm = distanceToTargetRpm(targetDistM);
    integral = 0.0f;
    dwellAccumMs = 0;
    if (armed && state != ST_FEEDING && state != ST_COOLDOWN && state != ST_FAULT) {
      setState(ST_SPINUP);
    }
    return;
  }
  if (s.startsWith(F("SET_BAND_COUNT"))) {
    int sp = s.indexOf(' ');
    if (sp < 0) return;
    int n = s.substring(sp + 1).toInt();
    if (n >= 1 && n <= MAX_BANDS) {
      numBands = n;
      if (!manualRpmOverride) {
        targetRpm = distanceToTargetRpm(targetDistM);
      }
    }
    return;
  }
  if (s.startsWith(F("SET_BAND"))) {
    handleSetBandLine(s);
    return;
  }
  if (s == F("BANDS_RESET")) {
    bandsResetDefaults();
    return;
  }
  if (s.startsWith(F("SET_DWELL_MS"))) {
    int sp = s.indexOf(' ');
    if (sp < 0) return;
    uint32_t v = (uint32_t)s.substring(sp + 1).toInt();
    if (v >= 50u && v <= 5000u) g_dwellHoldMs = v;
    return;
  }
  if (s.startsWith(F("SET_FEED_MS"))) {
    int sp = s.indexOf(' ');
    if (sp < 0) return;
    uint32_t v = (uint32_t)s.substring(sp + 1).toInt();
    if (v >= 50u && v <= 2000u) g_feedHoldMs = v;
    return;
  }
  if (s.startsWith(F("SET_COOLDOWN_MS"))) {
    int sp = s.indexOf(' ');
    if (sp < 0) return;
    uint32_t v = (uint32_t)s.substring(sp + 1).toInt();
    if (v >= 100u && v <= 10000u) g_cooldownPeriodMs = v;
    return;
  }
  if (s.startsWith(F("SET_KP"))) {
    int sp = s.indexOf(' ');
    if (sp < 0) return;
    float v = s.substring(sp + 1).toFloat();
    if (v >= 0.01f && v <= 100.0f) g_kp = v;
    return;
  }
  if (s.startsWith(F("SET_KI"))) {
    int sp = s.indexOf(' ');
    if (sp < 0) return;
    float v = s.substring(sp + 1).toFloat();
    if (v >= 0.0f && v <= 50.0f) g_ki = v;
    return;
  }
  if (s.startsWith(F("SET_PWM_MAX"))) {
    int sp = s.indexOf(' ');
    if (sp < 0) return;
    float v = s.substring(sp + 1).toFloat();
    if (v >= 10.0f && v <= 255.0f) g_pwmMax = v;
    return;
  }
  if (s.startsWith(F("SET_RPM_TOL"))) {
    int sp = s.indexOf(' ');
    if (sp < 0) return;
    float v = s.substring(sp + 1).toFloat();
    if (v >= 0.01f && v <= 0.5f) g_rpmTolRatio = v;
    return;
  }
  if (s.startsWith(F("SET_STALL_PWM"))) {
    int sp = s.indexOf(' ');
    if (sp < 0) return;
    float v = s.substring(sp + 1).toFloat();
    if (v >= 10.0f && v <= 255.0f) g_stallPwmThreshold = v;
    return;
  }
  if (s.startsWith(F("SET_STALL_RPM"))) {
    int sp = s.indexOf(' ');
    if (sp < 0) return;
    float v = s.substring(sp + 1).toFloat();
    if (v >= 1.0f && v <= 100.0f) g_stallRpmThreshold = v;
    return;
  }
  if (s.startsWith(F("TARGET_M"))) {
    int sp = s.indexOf(' ');
    if (sp < 0) return;
    float v = s.substring(sp + 1).toFloat();
    if (v < 0.0f || v > 80.0f) return;
    targetDistM = v;
    if (!manualRpmOverride) {
      targetRpm = distanceToTargetRpm(targetDistM);
    }
    integral = 0.0f;
    dwellAccumMs = 0;
    if (armed && state != ST_FEEDING && state != ST_COOLDOWN && state != ST_FAULT) {
      setState(ST_SPINUP);
    }
    return;
  }
}

static void updateRpm(uint32_t now) {
  if (now - lastRpmMs < RPM_SAMPLE_MS) return;
  uint32_t dt = now - lastRpmMs;
  lastRpmMs = now;

  uint16_t ang = readAngleRaw();
  if (ang == 0xFFFF) {
    return;
  }
  if (!angleInit) {
    lastAngle = ang;
    angleInit = true;
    return;
  }

  int32_t d = (int32_t)ang - (int32_t)lastAngle;
  if (d > 2048) d -= 4096;
  if (d < -2048) d += 4096;
  lastAngle = ang;

  if (dt == 0) return;
  float rev = (float)d / 4096.0f;
  float rps = rev / ((float)dt / 1000.0f);
  float instant = rps * 60.0f;
  rpmMeasured = rpmMeasured * 0.65f + instant * 0.35f;
}

static void updateControl(uint32_t now) {
  if (now - lastControlMs < RPM_SAMPLE_MS) return;
  uint32_t dt = now - lastControlMs;
  lastControlMs = now;

  if (!armed || targetRpm <= 0) {
    motorStop();
    pwmOut = 0;
    integral = 0.0f;
    dwellAccumMs = 0;
    stallAccumMs = 0;
    if (state != ST_FEEDING && state != ST_COOLDOWN && state != ST_FAULT) {
      setState(ST_IDLE);
    }
    return;
  }

  if (state == ST_FAULT) {
    motorStop();
    return;
  }

  if (state == ST_FEEDING || state == ST_COOLDOWN) {
    return;
  }

  float err = (float)targetRpm - rpmMeasured;
  integral += err * ((float)dt / 1000.0f);
  if (integral > 120.0f) integral = 120.0f;
  if (integral < -120.0f) integral = -120.0f;
  pwmOut = g_kp * err + g_ki * integral;
  if (pwmOut < 0) pwmOut = 0;
  if (pwmOut > g_pwmMax) pwmOut = g_pwmMax;
  motorPwmForward(pwmOut);

  float tol = (float)targetRpm * g_rpmTolRatio;
  if (tol < 2.0f) tol = 2.0f;
  bool inBand = fabs(err) <= tol;

  if (inBand) {
    dwellAccumMs += dt;
  } else {
    dwellAccumMs = 0;
    setState(ST_SPINUP);
  }

  if (g_autoFeedFromDwell && inBand && dwellAccumMs >= g_dwellHoldMs) {
    feedStep = 0;
    feedPhaseMs = now;
    dwellAccumMs = 0;
    setState(ST_FEEDING);
  }

  if (pwmOut >= g_stallPwmThreshold && fabs(rpmMeasured) < g_stallRpmThreshold) {
    stallAccumMs += dt;
    if (stallAccumMs > STALL_CHECK_MS) {
      errMsg = F("STALL");
      motorStop();
      armed = false;
      setState(ST_FAULT);
    }
  } else {
    stallAccumMs = 0;
  }
}

static void updateFeeder(uint32_t now) {
  if (state == ST_FEEDING) {
    if (feedStep == 0) {
      feeder.write(180);
      if (now - feedPhaseMs >= g_feedHoldMs) {
        feedStep = 1;
        feedPhaseMs = now;
      }
    } else if (feedStep == 1) {
      feeder.write(0);
      if (now - feedPhaseMs >= g_feedHoldMs) {
        setState(ST_COOLDOWN);
        cooldownStartMs = now;
        dwellAccumMs = 0;
      }
    }
    return;
  }

  if (state == ST_COOLDOWN) {
    if (now - cooldownStartMs >= g_cooldownPeriodMs) {
      if (armed && targetRpm > 0) {
        setState(ST_SPINUP);
      } else {
        setState(ST_IDLE);
      }
    }
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN_REN, OUTPUT);
  pinMode(PIN_LEN, OUTPUT);
  digitalWrite(PIN_REN, HIGH);
  digitalWrite(PIN_LEN, HIGH);
  pinMode(PIN_RPWM, OUTPUT);
  pinMode(PIN_LPWM, OUTPUT);
  motorStop();

  Wire.begin();
  feeder.attach(PIN_SERVO);
  feeder.write(0);

  uint32_t t0 = millis();
  lastRpmMs = t0;
  lastTelemMs = t0;
  lastControlMs = t0;
}

void loop() {
  uint32_t now = millis();

  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\r') continue;
    if (c == '\n') {
      handleCommand(rxLine);
      rxLine = "";
    } else if (rxLine.length() < 120) {
      rxLine += c;
    }
  }

  updateRpm(now);
  updateFeeder(now);
  updateControl(now);

  if (now - lastTelemMs >= TELEMETRY_MS) {
    lastTelemMs = now;
    reportTelemetry();
  }
}
