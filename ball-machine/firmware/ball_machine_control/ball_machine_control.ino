/**
 * Ball thrower: IR slot/reflection RPM (interrupt), BTS7960B (wheel PWM), second BTS7960B (12V linear
 * actuator pan), feeder servo.
 * Serial 115200: TARGET_M, TARGET_RPM [min [max]], AUTO_RPM, SET_BAND*, ARM, DISARM, STOP,
 *   TEST_MODE 0|1, TEST_PWM <0..PWM_MAX>, SERVO_TEST (fast 0°→180°, 1s hold, fast→0°), SET_* tuning,
 *   PAN_ENABLE 0|1, PAN_TARGET 0..1, PAN_HOME (retract to limit), SET_PAN_PWM_MAX, SET_PAN_SLEW,
 *   SET_PAN_DB, SET_PAN_TIMEOUT_MS, SET_PAN_STROKE_S,
 *   SET_RPM_EMA, SET_PWM_SLEW, SET_IR_DROPOUT_MS, SET_IR_SILENCE_MS, SET_RPM_DECAY (gentle IR RPM),
 *   SET_IR_MAX_INSTANT_RPM (reject EMI spikes on IR line),
 *   SET_KD, SET_RPM_FF, SET_D_MAX (PID + feed-forward)
 * Telemetry: STATE, RPM, TARGET_RPM, TARGET_RPM_MIN, TARGET_RPM_MAX, DIST_M, ERR
 */

#include <Servo.h>
#include <math.h>

// --- Pin map (adjust for your wiring) ---
// Uno: Servo library disables PWM on 9+10 — keep motor PWM off those pins.
static const uint8_t PIN_RPWM = 5;
static const uint8_t PIN_LPWM = 3;
static const uint8_t PIN_REN = 7;
static const uint8_t PIN_LEN = 8;
static const uint8_t PIN_SERVO = 9;
/** SG90-class microservo: attach maps 0°–180° to pulse width (use external 5 V + common GND). */
static const int SERVO_US_MIN = 1000;
static const int SERVO_US_MAX = 2000;
/** SERVO_TEST: dwell at 180° before returning home (ms). */
static const uint32_t SERVO_TEST_HOLD_AT_180_MS = 1000u;
// IR RPM (FC-51-style); Uno/Nano: use pin 2 or 3 for external interrupt.
static const uint8_t PIN_IR_RPM = 2;

// Second BTS7960: 12 V linear actuator (head pan). Uno: PWM on 6 and 11 (not 9/10 — servo).
static const uint8_t PIN_PAN_RPWM = 6;
static const uint8_t PIN_PAN_LPWM = 11;
static const uint8_t PIN_PAN_REN = 12;
static const uint8_t PIN_PAN_LEN = 13;
/** INPUT_PULLUP: LOW when fully retracted (optional; PAN_HOME stops here). */
static const uint8_t PIN_PAN_LIMIT = 4;

// IR wheel: marks/slots per full revolution (must match physical wheel).
static const int pulsesPerRevolution = 20;
// ~20% above max motor speed — rejects impossible glitch intervals.
static const float maxExpectedRPM = 500.0f;
static const unsigned long minPulseInterval =
    (unsigned long)((60000000.0 / (double)maxExpectedRPM) / (double)pulsesPerRevolution);
/** Ignore pulse-derived RPM above this (EMI can create bogus intervals). Tunable: SET_IR_MAX_INSTANT_RPM */
static float g_irMaxInstantRpm = maxExpectedRPM * 1.2f;
/** IR RPM EMA blend on each pulse (lower = smoother, slower). Tunable: SET_RPM_EMA */
static float g_rpmEmaAlpha = 0.18f;
/** After this silence (us), start coasting RPM estimate down (not instant zero). Tunable: SET_IR_DROPOUT_MS */
static unsigned long g_irDropoutUs = 650000UL;
/** After this silence (us), force RPM to 0 and reset pulse state. Tunable: SET_IR_SILENCE_MS */
static unsigned long g_irSilenceUs = 1800000UL;
/** Each control tick while in dropout, multiply rpmMeasured by this (0.85–0.99). Tunable: SET_RPM_DECAY */
static float g_rpmDecayPerTick = 0.93f;
/** Max |delta| PWM per control tick toward PI command (gentle torque). Tunable: SET_PWM_SLEW */
static float g_pwmSlewPerTick = 6.0f;

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

/** Linear actuator pan (second BTS7960); host sends PAN_TARGET 0=retracted .. 1=extended */
static bool g_panEnabled = false;
static float g_panTarget = 0.5f;
static float g_panEstimated = 0.5f;
static float g_panPwmMax = 120.0f;
static float g_panSlewPerTick = 8.0f;
static float g_panDb = 0.04f;
static uint32_t g_panTimeoutMs = 4000;
static float g_panStrokeSec = 18.0f;
static float g_panSlewOut = 0.0f;
static bool g_panHoming = false;
static uint32_t g_panHomeStartMs = 0;
static uint32_t g_panLastTickMs = 0;
static int8_t g_panMoveSign = 0;
static uint32_t g_panMoveStartMs = 0;

// PI + filtered D on measurement; SET_KP / SET_KI / SET_KD / SET_RPM_FF / SET_D_MAX
static float g_kp = 2.0f;
static float g_ki = 0.24f;
/** Derivative on filtered RPM (0 = off). Typical 0.02–0.12 */
static float g_kd = 0.05f;
/** Feed-forward PWM bias: pwm += g_rpmFf * targetMid (0 = off). Load-dependent. */
static float g_rpmFf = 0.0f;
/** Clamp |derivative term| in PWM units (noise limiter). */
static float g_dMax = 20.0f;
/** When |err| below this (RPM), scale Kp/Ki by g_gainScaleInBand for less limit cycle. */
static const float g_errRelaxRpm = 5.0f;
static const float g_gainScaleInBand = 0.75f;
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
/** Slew-limited PWM actually driving the motor (PI target is smoothed into this). */
static float pwmApplied = 0.0f;
/** Low-pass copy of rpm for derivative (same alpha as IR EMA). */
static float rpmForD = 0.0f;
static float rpmForD_prev = 0.0f;
static bool g_pidDInitialized = false;

RunState state = ST_IDLE;
uint32_t lastTelemMs = 0;

volatile unsigned long lastIrPulseUs = 0;
volatile unsigned long irPulseIntervalUs = 0;
volatile bool irNewPulse = false;
volatile bool irIsFirstPulse = true;

/** Last 3 accepted pulse intervals (us); median rejects single EMI glitches when the motor runs. */
static unsigned long g_irIvMed[3];
static uint8_t g_irMedW = 0;
static uint8_t g_irMedFilled = 0;

uint32_t dwellAccumMs = 0;
uint32_t feedPhaseMs = 0;
uint8_t feedStep = 0;
uint32_t cooldownStartMs = 0;

uint32_t stallAccumMs = 0;
String errMsg = "";

/** Bench / UI: fast 0°→180°, hold, fast→0° without full FEEDING state. */
static bool g_servoTestActive = false;
static uint32_t g_servoTestPhaseMs = 0;

uint32_t lastControlMs = 0;
static uint32_t lastIrDecayMs = 0;

String rxLine;

static unsigned long medianIntervalU3(unsigned long a, unsigned long b, unsigned long c) {
  unsigned long t;
  if (a > b) {
    t = a;
    a = b;
    b = t;
  }
  if (b > c) {
    t = b;
    b = c;
    c = t;
  }
  if (a > b) {
    t = a;
    a = b;
    b = t;
  }
  return b;
}

static void resetIrMedianIntervals() {
  g_irIvMed[0] = 0;
  g_irIvMed[1] = 0;
  g_irIvMed[2] = 0;
  g_irMedW = 0;
  g_irMedFilled = 0;
}

static void pushIrIntervalForMedian(unsigned long iv) {
  g_irIvMed[g_irMedW] = iv;
  g_irMedW = (uint8_t)((g_irMedW + 1u) % 3u);
  if (g_irMedFilled < 3u) {
    g_irMedFilled++;
  }
}

static unsigned long irMedianIntervalUs() {
  if (g_irMedFilled == 0u) {
    return 0;
  }
  if (g_irMedFilled == 1u) {
    return g_irIvMed[0];
  }
  if (g_irMedFilled == 2u) {
    return (g_irIvMed[0] + g_irIvMed[1]) / 2UL;
  }
  return medianIntervalU3(g_irIvMed[0], g_irIvMed[1], g_irIvMed[2]);
}

static void recordIrPulse() {
  unsigned long t = micros();
  unsigned long dt = t - lastIrPulseUs;

  if (irIsFirstPulse) {
    lastIrPulseUs = t;
    irIsFirstPulse = false;
    return;
  }
  /* Too soon: noise burst or PWM coupling; real slots cannot repeat faster than minPulseInterval. */
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

static void resetPidDerivativeState() {
  rpmForD = 0.0f;
  rpmForD_prev = 0.0f;
  g_pidDInitialized = false;
}

static void motorStop() {
  analogWrite(PIN_RPWM, 0);
  analogWrite(PIN_LPWM, 0);
  pwmApplied = 0.0f;
  resetPidDerivativeState();
}

static void panMotorStop() {
  analogWrite(PIN_PAN_RPWM, 0);
  analogWrite(PIN_PAN_LPWM, 0);
  g_panSlewOut = 0.0f;
}

static void panMotorExtend(float pwm) {
  if (pwm < 0.0f) pwm = 0.0f;
  if (pwm > g_panPwmMax) pwm = g_panPwmMax;
  int p = (int)(pwm + 0.5f);
  analogWrite(PIN_PAN_RPWM, p);
  analogWrite(PIN_PAN_LPWM, 0);
}

static void panMotorRetract(float pwm) {
  if (pwm < 0.0f) pwm = 0.0f;
  if (pwm > g_panPwmMax) pwm = g_panPwmMax;
  int p = (int)(pwm + 0.5f);
  analogWrite(PIN_PAN_RPWM, 0);
  analogWrite(PIN_PAN_LPWM, p);
}

static void panResetMotionTimeout() {
  g_panMoveSign = 0;
  g_panMoveStartMs = 0;
}

static void updatePanMotor(uint32_t now) {
  if (g_testMode) {
    panMotorStop();
    g_panHoming = false;
    return;
  }

  if (g_panHoming) {
    bool atLimit = (digitalRead(PIN_PAN_LIMIT) == LOW);
    if (atLimit) {
      g_panEstimated = 0.0f;
      g_panHoming = false;
      panMotorStop();
      return;
    }
    if (now - g_panHomeStartMs > 12000UL) {
      g_panHoming = false;
      panMotorStop();
      return;
    }
    panMotorRetract(85.0f);
    return;
  }

  if (!g_panEnabled) {
    panMotorStop();
    panResetMotionTimeout();
    return;
  }

  if (g_panLastTickMs == 0) g_panLastTickMs = now;
  uint32_t dt = now - g_panLastTickMs;
  if (dt < 25) return;
  g_panLastTickMs = now;
  float dtSec = (float)dt / 1000.0f;

  float err = g_panTarget - g_panEstimated;
  if (fabs(err) < g_panDb) {
    panMotorStop();
    panResetMotionTimeout();
    return;
  }

  int8_t sign = (err > 0.0f) ? 1 : -1;
  if (g_panMoveSign != sign) {
    g_panMoveSign = sign;
    g_panMoveStartMs = now;
  }
  if (g_panMoveStartMs > 0 && (now - g_panMoveStartMs) > g_panTimeoutMs) {
    panMotorStop();
    panResetMotionTimeout();
    return;
  }

  float want = fabs(err) * 3.5f * g_panPwmMax;
  if (want < 28.0f) want = 28.0f;
  if (want > g_panPwmMax) want = g_panPwmMax;

  if (want > g_panSlewOut + g_panSlewPerTick) {
    g_panSlewOut += g_panSlewPerTick;
  } else if (want < g_panSlewOut - g_panSlewPerTick) {
    g_panSlewOut -= g_panSlewPerTick;
  } else {
    g_panSlewOut = want;
  }

  float rate = (g_panSlewOut / g_panPwmMax) * (dtSec / g_panStrokeSec);
  if (g_panStrokeSec < 0.5f) g_panStrokeSec = 0.5f;

  if (sign > 0) {
    panMotorExtend(g_panSlewOut);
    g_panEstimated += rate;
    if (g_panEstimated > 1.0f) g_panEstimated = 1.0f;
  } else {
    panMotorRetract(g_panSlewOut);
    g_panEstimated -= rate;
    if (g_panEstimated < 0.0f) g_panEstimated = 0.0f;
  }
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

static void beginServoTest() {
  g_servoTestActive = true;
  g_servoTestPhaseMs = millis();
  feeder.write(180);
}

static void updateServoTest(uint32_t now) {
  if (!g_servoTestActive) {
    return;
  }
  if (now - g_servoTestPhaseMs >= SERVO_TEST_HOLD_AT_180_MS) {
    feeder.write(0);
    g_servoTestActive = false;
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
    g_servoTestActive = false;
    motorStop();
    panMotorStop();
    g_panHoming = false;
    g_panEnabled = false;
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
      g_servoTestActive = false;
      integral = 0.0f;
      dwellAccumMs = 0;
      stallAccumMs = 0;
      feedStep = 0;
      feeder.write(0);
      pwmOut = 0.0f;
      motorStop();
      panMotorStop();
      g_panHoming = false;
      if (state != ST_FAULT) setState(ST_IDLE);
      Serial.println(F("ACK TEST_MODE 1"));
    } else {
      g_testMode = false;
      g_testPwm = 0.0f;
      g_servoTestActive = false;
      motorStop();
      panMotorStop();
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

  if (s == F("SERVO_TEST")) {
    if (state == ST_FEEDING || state == ST_COOLDOWN) {
      return;
    }
    beginServoTest();
    Serial.println(F("ACK SERVO_TEST"));
    return;
  }

  if (upper.startsWith(F("PAN_ENABLE"))) {
    int sp = upper.indexOf(' ');
    if (sp < 0) return;
    int v = upper.substring(sp + 1).toInt();
    g_panEnabled = (v != 0);
    if (!g_panEnabled) {
      panMotorStop();
      panResetMotionTimeout();
    }
    Serial.print(F("ACK PAN_ENABLE "));
    Serial.println(g_panEnabled ? 1 : 0);
    return;
  }
  if (upper.startsWith(F("PAN_TARGET"))) {
    int sp = upper.indexOf(' ');
    if (sp < 0) return;
    float p = upper.substring(sp + 1).toFloat();
    if (p < 0.0f) p = 0.0f;
    if (p > 1.0f) p = 1.0f;
    g_panTarget = p;
    Serial.print(F("ACK PAN_TARGET "));
    Serial.println(p, 3);
    return;
  }
  if (s.equalsIgnoreCase("PAN_HOME")) {
    g_panHoming = true;
    g_panHomeStartMs = millis();
    Serial.println(F("ACK PAN_HOME"));
    return;
  }

  if (g_testMode) {
    if (s == F("DISARM")) {
      g_testMode = false;
      g_testPwm = 0.0f;
      armed = false;
      motorStop();
      panMotorStop();
      pwmOut = 0.0f;
      integral = 0.0f;
      dwellAccumMs = 0;
      g_servoTestActive = false;
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
    resetIrMedianIntervals();
    rpmForD = rpmMeasured;
    rpmForD_prev = rpmMeasured;
    g_pidDInitialized = true;
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
    g_servoTestActive = false;
    feeder.write(0);
    if (state != ST_FAULT) setState(ST_IDLE);
    return;
  }
  if (s == F("FEED_ONCE")) {
    if (!armed) return;
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
  if (s.startsWith(F("SET_KD"))) {
    int sp = s.indexOf(' ');
    if (sp < 0) return;
    float v = s.substring(sp + 1).toFloat();
    if (v >= 0.0f && v <= 5.0f) g_kd = v;
    return;
  }
  if (s.startsWith(F("SET_RPM_FF"))) {
    int sp = s.indexOf(' ');
    if (sp < 0) return;
    float v = s.substring(sp + 1).toFloat();
    if (v >= 0.0f && v <= 0.8f) g_rpmFf = v;
    return;
  }
  if (s.startsWith(F("SET_D_MAX"))) {
    int sp = s.indexOf(' ');
    if (sp < 0) return;
    float v = s.substring(sp + 1).toFloat();
    if (v >= 1.0f && v <= 80.0f) g_dMax = v;
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
  if (s.startsWith(F("SET_RPM_EMA"))) {
    int sp = s.indexOf(' ');
    if (sp < 0) return;
    float v = s.substring(sp + 1).toFloat();
    if (v >= 0.05f && v <= 0.8f) g_rpmEmaAlpha = v;
    return;
  }
  if (s.startsWith(F("SET_PWM_SLEW"))) {
    int sp = s.indexOf(' ');
    if (sp < 0) return;
    float v = s.substring(sp + 1).toFloat();
    if (v >= 0.5f && v <= 50.0f) g_pwmSlewPerTick = v;
    return;
  }
  if (s.startsWith(F("SET_IR_DROPOUT_MS"))) {
    int sp = s.indexOf(' ');
    if (sp < 0) return;
    uint32_t ms = (uint32_t)s.substring(sp + 1).toInt();
    if (ms >= 200u && ms <= 5000u) {
      g_irDropoutUs = (unsigned long)ms * 1000UL;
      if (g_irSilenceUs <= g_irDropoutUs) {
        g_irSilenceUs = g_irDropoutUs + 500000UL;
      }
    }
    return;
  }
  if (s.startsWith(F("SET_IR_SILENCE_MS"))) {
    int sp = s.indexOf(' ');
    if (sp < 0) return;
    uint32_t ms = (uint32_t)s.substring(sp + 1).toInt();
    if (ms >= 500u && ms <= 10000u) {
      unsigned long u = (unsigned long)ms * 1000UL;
      if (u <= g_irDropoutUs) {
        u = g_irDropoutUs + 500000UL;
      }
      g_irSilenceUs = u;
    }
    return;
  }
  if (s.startsWith(F("SET_RPM_DECAY"))) {
    int sp = s.indexOf(' ');
    if (sp < 0) return;
    float v = s.substring(sp + 1).toFloat();
    if (v >= 0.85f && v <= 0.995f) g_rpmDecayPerTick = v;
    return;
  }
  if (s.startsWith(F("SET_IR_MAX_INSTANT_RPM"))) {
    int sp = s.indexOf(' ');
    if (sp < 0) return;
    float v = s.substring(sp + 1).toFloat();
    if (v >= 80.0f && v <= 800.0f) g_irMaxInstantRpm = v;
    return;
  }
  if (s.startsWith(F("SET_PAN_PWM_MAX"))) {
    int sp = s.indexOf(' ');
    if (sp < 0) return;
    float v = s.substring(sp + 1).toFloat();
    if (v >= 10.0f && v <= 255.0f) g_panPwmMax = v;
    return;
  }
  if (s.startsWith(F("SET_PAN_SLEW"))) {
    int sp = s.indexOf(' ');
    if (sp < 0) return;
    float v = s.substring(sp + 1).toFloat();
    if (v >= 1.0f && v <= 255.0f) g_panSlewPerTick = v;
    return;
  }
  if (s.startsWith(F("SET_PAN_DB"))) {
    int sp = s.indexOf(' ');
    if (sp < 0) return;
    float v = s.substring(sp + 1).toFloat();
    if (v >= 0.005f && v <= 0.5f) g_panDb = v;
    return;
  }
  if (s.startsWith(F("SET_PAN_TIMEOUT_MS"))) {
    int sp = s.indexOf(' ');
    if (sp < 0) return;
    uint32_t v = (uint32_t)s.substring(sp + 1).toInt();
    if (v >= 200u && v <= 30000u) g_panTimeoutMs = v;
    return;
  }
  if (s.startsWith(F("SET_PAN_STROKE_S"))) {
    int sp = s.indexOf(' ');
    if (sp < 0) return;
    float v = s.substring(sp + 1).toFloat();
    if (v >= 0.5f && v <= 120.0f) g_panStrokeSec = v;
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
      float rawInstant =
          (60000000.0f / (float)interval) / (float)pulsesPerRevolution;
      if (rawInstant > g_irMaxInstantRpm) {
        return;
      }
      pushIrIntervalForMedian(interval);
      unsigned long medIv = irMedianIntervalUs();
      if (medIv == 0) {
        return;
      }
      float instantRpm =
          (60000000.0f / (float)medIv) / (float)pulsesPerRevolution;
      if (instantRpm > g_irMaxInstantRpm) {
        return;
      }
      rpmMeasured =
          g_rpmEmaAlpha * instantRpm + (1.0f - g_rpmEmaAlpha) * rpmMeasured;
    }
  }
  /* Dropout / decay / full silence: applyIrRpmDropoutDecay in loop (~RPM_SAMPLE_MS). */
}

/** Microseconds since last IR edge (for dropout / silence and irSignalLive). */
static unsigned long irSincePulseUs() {
  unsigned long sp;
  noInterrupts();
  sp = micros() - lastIrPulseUs;
  interrupts();
  return sp;
}

/** Coast RPM estimate down on IR dropout; zero after long silence. Runs even when disarmed so telemetry does not stick at the last value when the wheel stops. */
static void applyIrRpmDropoutDecay(unsigned long sincePulse) {
  if (sincePulse >= g_irSilenceUs) {
    rpmMeasured = 0.0f;
    resetIrMedianIntervals();
    noInterrupts();
    irIsFirstPulse = true;
    interrupts();
  } else if (sincePulse >= g_irDropoutUs && rpmMeasured > 0.05f) {
    rpmMeasured *= g_rpmDecayPerTick;
    if (rpmMeasured < 0.4f) {
      rpmMeasured = 0.0f;
    }
  }
}

static void updateControl(uint32_t now) {
  if (now - lastControlMs < RPM_SAMPLE_MS) return;
  uint32_t dt = now - lastControlMs;
  lastControlMs = now;

  unsigned long sincePulse = irSincePulseUs();
  const bool irSignalLive = (sincePulse < g_irDropoutUs);

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

  if (sincePulse >= g_irDropoutUs && sincePulse < g_irSilenceUs &&
      rpmMeasured > 0.05f) {
    integral *= 0.92f;
  }

  int lo = targetRpmMin;
  int hi = targetRpmMax;
  float rpmMid;
  float err;
  if (lo == hi) {
    rpmMid = (float)lo;
    err = rpmMid - rpmMeasured;
  } else {
    rpmMid = 0.5f * ((float)lo + (float)hi);
    err = rpmMid - rpmMeasured;
  }

  float dtSec = (float)dt / 1000.0f;
  if (dtSec < 0.001f) dtSec = 0.001f;

  if (!g_pidDInitialized) {
    rpmForD = rpmMeasured;
    rpmForD_prev = rpmMeasured;
    g_pidDInitialized = true;
  }

  float kpEff = g_kp;
  float kiEff = g_ki;
  if (fabs(err) < g_errRelaxRpm) {
    kpEff *= g_gainScaleInBand;
    kiEff *= g_gainScaleInBand;
  }

  float pwmCmdPi = kpEff * err + kiEff * integral;
  bool windup =
      (pwmCmdPi >= g_pwmMax && err > 0.0f) ||
      (pwmCmdPi <= 0.0f && err < 0.0f);
  if (!windup) {
    integral += err * dtSec;
    if (integral > 120.0f) integral = 120.0f;
    if (integral < -120.0f) integral = -120.0f;
  }

  pwmCmdPi = kpEff * err + kiEff * integral;

  rpmForD =
      g_rpmEmaAlpha * rpmMeasured + (1.0f - g_rpmEmaAlpha) * rpmForD;
  float dRpmDt = (rpmForD - rpmForD_prev) / dtSec;
  rpmForD_prev = rpmForD;
  float dTerm = -g_kd * dRpmDt;
  if (dTerm > g_dMax) dTerm = g_dMax;
  else if (dTerm < -g_dMax) dTerm = -g_dMax;

  float pwmFf = g_rpmFf * rpmMid;

  float pwmCmd = pwmCmdPi + dTerm + pwmFf;
  if (pwmCmd < 0) pwmCmd = 0;
  if (pwmCmd > g_pwmMax) pwmCmd = g_pwmMax;

  float slew = g_pwmSlewPerTick;
  if (slew < 0.5f) slew = 0.5f;
  float d = pwmCmd - pwmApplied;
  if (d > slew) d = slew;
  else if (d < -slew) d = -slew;
  pwmApplied += d;
  if (pwmApplied < 0) pwmApplied = 0;
  if (pwmApplied > g_pwmMax) pwmApplied = g_pwmMax;
  pwmOut = pwmApplied;
  motorPwmForward(pwmApplied);

  bool inBand;
  if (lo == hi) {
    float tol = (float)lo * g_rpmTolRatio;
    if (tol < 2.0f) tol = 2.0f;
    inBand = fabs((float)lo - rpmMeasured) <= tol;
  } else {
    float halfW = 0.5f * ((float)hi - (float)lo);
    float tol = rpmMid * g_rpmTolRatio;
    if (tol < 2.0f) tol = 2.0f;
    if (tol > halfW) tol = halfW;
    inBand = (rpmMeasured >= (float)lo && rpmMeasured <= (float)hi) &&
             (fabs(rpmMeasured - rpmMid) <= tol);
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

  /* Stall only when IR still reports pulses — dropout is not a mechanical stall. */
  if (irSignalLive && pwmApplied >= g_stallPwmThreshold &&
      fabs(rpmMeasured) < g_stallRpmThreshold) {
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

  pinMode(PIN_PAN_REN, OUTPUT);
  pinMode(PIN_PAN_LEN, OUTPUT);
  digitalWrite(PIN_PAN_REN, HIGH);
  digitalWrite(PIN_PAN_LEN, HIGH);
  pinMode(PIN_PAN_RPWM, OUTPUT);
  pinMode(PIN_PAN_LPWM, OUTPUT);
  pinMode(PIN_PAN_LIMIT, INPUT_PULLUP);
  panMotorStop();

  feeder.attach(PIN_SERVO, SERVO_US_MIN, SERVO_US_MAX);
  feeder.write(0);
  delay(400);

  uint32_t t0 = millis();
  lastTelemMs = t0;
  lastControlMs = t0;
  lastIrDecayMs = t0;
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
  if (now - lastIrDecayMs >= RPM_SAMPLE_MS) {
    lastIrDecayMs = now;
    applyIrRpmDropoutDecay(irSincePulseUs());
  }
  updatePanMotor(now);
  if (g_testMode) {
    motorPwmForward(g_testPwm);
    pwmOut = g_testPwm;
    if (g_servoTestActive) {
      updateServoTest(now);
    } else {
      feeder.write(0);
    }
  } else {
    updateFeeder(now);
    updateControl(now);
    if (g_servoTestActive) {
      updateServoTest(now);
    }
  }

  if (now - lastTelemMs >= TELEMETRY_MS) {
    lastTelemMs = now;
    reportTelemetry();
  }
}
