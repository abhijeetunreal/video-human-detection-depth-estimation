/**
 * Ball thrower: IR slot/reflection RPM (interrupt), BTS7960B (single-direction PWM), feeder servo.
 * Serial 115200: TARGET_M, TARGET_RPM [min [max]], AUTO_RPM, SET_BAND*, ARM, DISARM, STOP,
 *   TEST_MODE 0|1, TEST_PWM <0..PWM_MAX>, SET_* tuning
 * Telemetry: STATE, RPM, TARGET_RPM, TARGET_RPM_MIN, TARGET_RPM_MAX, DIST_M, ERR
 */

#include <Servo.h>

// --- Pin map (adjust for your wiring) ---
// Uno: Servo library disables PWM on 9+10 — keep motor PWM off those pins.
static const uint8_t PIN_RPWM = 5;
static const uint8_t PIN_LPWM = 3;
static const uint8_t PIN_REN = 7;
static const uint8_t PIN_LEN = 8;
static const uint8_t PIN_SERVO = 9;
// IR RPM (FC-51-style); Uno/Nano: use pin 2 or 3 for external interrupt.
static const uint8_t PIN_IR_RPM = 2;

// IR wheel: marks/slots per full revolution (must match physical wheel).
static const int pulsesPerRevolution = 20;
// ~20% above max motor speed — rejects impossible glitch intervals.
static const float maxExpectedRPM = 500.0f;
static const unsigned long minPulseInterval =
    (unsigned long)((60000000.0 / (double)maxExpectedRPM) / (double)pulsesPerRevolution);
static const float rpmEmaAlpha = 0.3f;
static const unsigned long rpmPulseTimeoutUs = 500000UL;

// Timing (defaults; runtime-tunable via serial SET_*)
static const uint32_t TELEMETRY_MS = 120;
static const uint32_t RPM_SAMPLE_MS = 30;
static uint32_t g_dwellHoldMs = 280;
static uint32_t g_feedHoldMs = 220;
static uint32_t g_cooldownPeriodMs = 900;
static const uint32_t STALL_CHECK_MS = 2000;
static float g_stallPwmThreshold = 160.0f;
static float g_stallRpmThreshold = 8.0f;

// Distance bands: [min_m, max_m) -> [rpm_min, rpm_max] RPM window (SET_BAND idx m0 m1 r0 r1)
#define MAX_BANDS 6
struct Band {
  float minM;
  float maxM;
  int rpmMin;
  int rpmMax;
};

static Band distBands[MAX_BANDS] = {
    {0.55f, 1.15f, 45, 55},
    {1.15f, 2.20f, 90, 110},
    {2.20f, 30.0f, 140, 160},
    {0.0f, 0.0f, 0, 0},
    {0.0f, 0.0f, 0, 0},
    {0.0f, 0.0f, 0, 0},
};
static int numBands = 3;

static bool manualRpmOverride = false;
/** When false, dwell never auto-triggers FEEDING — use FEED_ONCE from host */
static bool g_autoFeedFromDwell = true;

/** Open-loop bench test: direct PWM; blocks other serial commands until TEST_MODE 0 / STOP / DISARM */
static bool g_testMode = false;
static float g_testPwm = 0.0f;

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
int targetRpmMin = 0;
int targetRpmMax = 0;

float rpmMeasured = 0.0f;
float integral = 0.0f;
float pwmOut = 0.0f;

RunState state = ST_IDLE;
uint32_t lastTelemMs = 0;

volatile unsigned long lastIrPulseUs = 0;
volatile unsigned long irPulseIntervalUs = 0;
volatile bool irNewPulse = false;
volatile bool irIsFirstPulse = true;

uint32_t dwellAccumMs = 0;
uint32_t feedPhaseMs = 0;
uint8_t feedStep = 0;
uint32_t cooldownStartMs = 0;

uint32_t stallAccumMs = 0;
String errMsg = "";

uint32_t lastControlMs = 0;

String rxLine;

static void recordIrPulse() {
  unsigned long t = micros();
  unsigned long dt = t - lastIrPulseUs;

  if (irIsFirstPulse) {
    lastIrPulseUs = t;
    irIsFirstPulse = false;
    return;
  }
  if (dt > minPulseInterval) {
    irPulseIntervalUs = dt;
    lastIrPulseUs = t;
    irNewPulse = true;
  }
}

/** Auto mode: set targetRpmMin/Max and midpoint targetRpm from distance bands. */
static void applyBandForDistance(float m) {
  targetRpmMin = 0;
  targetRpmMax = 0;
  targetRpm = 0;
  if (m < 0.05f) return;
  for (int i = 0; i < numBands; ++i) {
    if (m >= distBands[i].minM && m < distBands[i].maxM) {
      targetRpmMin = distBands[i].rpmMin;
      targetRpmMax = distBands[i].rpmMax;
      if (targetRpmMax <= 0) return;
      targetRpm = (targetRpmMin + targetRpmMax) / 2;
      return;
    }
  }
}

static void bandsResetDefaults() {
  distBands[0] = {0.55f, 1.15f, 45, 55};
  distBands[1] = {1.15f, 2.20f, 90, 110};
  distBands[2] = {2.20f, 30.0f, 140, 160};
  for (int i = 3; i < MAX_BANDS; ++i) {
    distBands[i] = {0.0f, 0.0f, 0, 0};
  }
  numBands = 3;
  if (!manualRpmOverride) {
    applyBandForDistance(targetDistM);
  }
}

/** Full line: SET_BAND idx min_m max_m rpm_min rpm_max */
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
  String r4 = r3.substring(c + 1);
  r4.trim();
  int d = r4.indexOf(' ');
  if (d < 0) return;
  int rpmMin = r4.substring(0, d).toInt();
  int rpmMax = r4.substring(d + 1).toInt();
  if (mn >= mx || mn < 0.0f || mx > 120.0f) return;
  if (rpmMin < 0) rpmMin = 0;
  if (rpmMax < 0) rpmMax = 0;
  if (rpmMin > 500) rpmMin = 500;
  if (rpmMax > 500) rpmMax = 500;
  if (rpmMin > rpmMax) return;
  distBands[idx].minM = mn;
  distBands[idx].maxM = mx;
  distBands[idx].rpmMin = rpmMin;
  distBands[idx].rpmMax = rpmMax;
  if (idx + 1 > numBands) numBands = idx + 1;
  if (!manualRpmOverride) {
    applyBandForDistance(targetDistM);
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
  if (g_testMode) {
    Serial.print(F("STATE "));
    Serial.println(F("TEST"));
    Serial.print(F("RPM "));
    Serial.println(rpmMeasured, 2);
    Serial.print(F("TARGET_RPM "));
    Serial.println((int)(g_testPwm + 0.5f));
    Serial.print(F("TARGET_RPM_MIN "));
    Serial.println(0);
    Serial.print(F("TARGET_RPM_MAX "));
    Serial.println(0);
    Serial.print(F("DIST_M "));
    Serial.println(0.0f, 3);
    if (errMsg.length() > 0) {
      Serial.print(F("ERR "));
      Serial.println(errMsg);
      errMsg = "";
    }
    return;
  }

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

  Serial.print(F("TARGET_RPM_MIN "));
  Serial.println(targetRpmMin);

  Serial.print(F("TARGET_RPM_MAX "));
  Serial.println(targetRpmMax);

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

  String upper = s;
  upper.toUpperCase();

  if (s == F("STOP")) {
    g_testMode = false;
    g_testPwm = 0.0f;
    armed = false;
    motorStop();
    pwmOut = 0.0f;
    integral = 0.0f;
    dwellAccumMs = 0;
    stallAccumMs = 0;
    feedStep = 0;
    feeder.write(0);
    setState(ST_IDLE);
    return;
  }

  if (upper.startsWith(F("TEST_MODE"))) {
    int sp = upper.indexOf(' ');
    if (sp < 0) return;
    int v = upper.substring(sp + 1).toInt();
    if (v != 0) {
      g_testMode = true;
      g_testPwm = 0.0f;
      armed = false;
      integral = 0.0f;
      dwellAccumMs = 0;
      stallAccumMs = 0;
      feedStep = 0;
      feeder.write(0);
      pwmOut = 0.0f;
      motorStop();
      if (state != ST_FAULT) setState(ST_IDLE);
      Serial.println(F("ACK TEST_MODE 1"));
    } else {
      g_testMode = false;
      g_testPwm = 0.0f;
      motorStop();
      pwmOut = 0.0f;
      Serial.println(F("ACK TEST_MODE 0"));
    }
    return;
  }

  if (upper.startsWith(F("TEST_PWM"))) {
    int sp = upper.indexOf(' ');
    if (sp < 0) return;
    float p = upper.substring(sp + 1).toFloat();
    if (p < 0.0f) p = 0.0f;
    if (p > g_pwmMax) p = g_pwmMax;
    g_testPwm = p;
    return;
  }

  if (g_testMode) {
    if (s == F("DISARM")) {
      g_testMode = false;
      g_testPwm = 0.0f;
      armed = false;
      motorStop();
      pwmOut = 0.0f;
      integral = 0.0f;
      dwellAccumMs = 0;
      feeder.write(0);
      if (state != ST_FAULT) setState(ST_IDLE);
      return;
    }
    return;
  }

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
  if (s == F("FEED_ONCE")) {
    if (!armed || targetRpmMax <= 0) return;
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
    String rest = s.substring(10);
    rest.trim();
    if (rest.length() == 0) return;
    int sp = rest.indexOf(' ');
    int r0;
    int r1;
    if (sp < 0) {
      r0 = rest.toInt();
      r1 = r0;
    } else {
      r0 = rest.substring(0, sp).toInt();
      String r2 = rest.substring(sp + 1);
      r2.trim();
      r1 = r2.toInt();
    }
    if (r0 < 0) r0 = 0;
    if (r1 < 0) r1 = 0;
    if (r0 > 500) r0 = 500;
    if (r1 > 500) r1 = 500;
    if (r0 > r1) {
      int t = r0;
      r0 = r1;
      r1 = t;
    }
    targetRpmMin = r0;
    targetRpmMax = r1;
    targetRpm = (targetRpmMin + targetRpmMax) / 2;
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
    applyBandForDistance(targetDistM);
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
        applyBandForDistance(targetDistM);
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
      applyBandForDistance(targetDistM);
    }
    integral = 0.0f;
    dwellAccumMs = 0;
    if (armed && state != ST_FEEDING && state != ST_COOLDOWN && state != ST_FAULT) {
      setState(ST_SPINUP);
    }
    return;
  }
}

static void updateRpm(uint32_t) {
  if (irNewPulse) {
    noInterrupts();
    unsigned long interval = irPulseIntervalUs;
    irNewPulse = false;
    interrupts();

    if (interval > 0) {
      float instantRpm = (60000000.0f / (float)interval) / (float)pulsesPerRevolution;
      rpmMeasured = rpmEmaAlpha * instantRpm + (1.0f - rpmEmaAlpha) * rpmMeasured;
    }
  }

  unsigned long since;
  noInterrupts();
  since = micros() - lastIrPulseUs;
  interrupts();

  if (since > rpmPulseTimeoutUs && rpmMeasured > 0.0f) {
    rpmMeasured = 0.0f;
    irIsFirstPulse = true;
  }
}

static void updateControl(uint32_t now) {
  if (now - lastControlMs < RPM_SAMPLE_MS) return;
  uint32_t dt = now - lastControlMs;
  lastControlMs = now;

  if (!armed || targetRpmMax <= 0) {
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

  int lo = targetRpmMin;
  int hi = targetRpmMax;
  float err;
  if (lo == hi) {
    err = (float)lo - rpmMeasured;
  } else if (rpmMeasured < (float)lo) {
    err = (float)lo - rpmMeasured;
  } else if (rpmMeasured > (float)hi) {
    err = (float)hi - rpmMeasured;
  } else {
    err = 0.0f;
  }

  integral += err * ((float)dt / 1000.0f);
  if (integral > 120.0f) integral = 120.0f;
  if (integral < -120.0f) integral = -120.0f;
  pwmOut = g_kp * err + g_ki * integral;
  if (pwmOut < 0) pwmOut = 0;
  if (pwmOut > g_pwmMax) pwmOut = g_pwmMax;
  motorPwmForward(pwmOut);

  bool inBand;
  if (lo == hi) {
    float tol = (float)lo * g_rpmTolRatio;
    if (tol < 2.0f) tol = 2.0f;
    inBand = fabs((float)lo - rpmMeasured) <= tol;
  } else {
    inBand = rpmMeasured >= (float)lo && rpmMeasured <= (float)hi;
  }

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
      if (armed && targetRpmMax > 0) {
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

  pinMode(PIN_IR_RPM, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(PIN_IR_RPM), recordIrPulse, FALLING);

  feeder.attach(PIN_SERVO);
  feeder.write(0);

  uint32_t t0 = millis();
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
  if (g_testMode) {
    motorPwmForward(g_testPwm);
    pwmOut = g_testPwm;
    feeder.write(0);
  } else {
    updateFeeder(now);
    updateControl(now);
  }

  if (now - lastTelemMs >= TELEMETRY_MS) {
    lastTelemMs = now;
    reportTelemetry();
  }
}
