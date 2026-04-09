# Ball machine Arduino firmware

## Pins (defaults in sketch — change to match your wiring)

| Signal    | Arduino Uno pin |
|-----------|-----------------|
| IR RPM (FC-51-style signal) | 2 (INT0) |
| BTS7960 RPWM | 5 (PWM)      |
| BTS7960 LPWM | 3 (PWM)      |
| BTS7960 R_EN | 7            |
| BTS7960 L_EN | 8            |
| Servo signal | 9           |

Note: On Uno, **Servo** disables PWM on pins 9 and 10, so the motor PWM uses **3 and 5** instead.

**SG90 feeder:** The sketch uses **Servo.write(0)** and **Servo.write(180)** (full 0°–180° with `attach(pin, 1000, 2000)`). Power the servo from a **separate 5 V supply** (common GND with Arduino and motor driver); **USB-powered** Arduinos often cannot deliver enough current and the servo will not move reliably.

**IR RPM:** Connect sensor **VCC**, **GND**, and **OUT** to the pin above; **common GND** with the Arduino and motor driver. Keep sensor leads **away from motor and PWM wires**; EMI from the driver can cause false pulses. Set **`pulsesPerRevolution`** in the sketch to the number of reflective marks or slots per wheel revolution. If the wheel can exceed **`maxExpectedRPM`** in the sketch, raise that constant so real pulses are not rejected.

Enable pins **R_EN** and **L_EN** must be driven HIGH for the IBT-2 module to run.

## Distance → RPM range (meters)

Edit the `distBands[]` defaults in the sketch (each row: distance `[min_m,max_m)` and **`rpm_min`…`rpm_max`**). Runtime: `SET_BAND i min_m max_m rpm_min rpm_max`.

## Serial

115200 baud, line-based commands: `TARGET_M 2.5`, `ARM`, `DISARM`, `STOP`.

**Bench test (open-loop):** `TEST_MODE 1` then `TEST_PWM <0…PWM_MAX>` (see `SET_PWM_MAX`). `TEST_MODE 0` or `STOP` exits. While active, other motion commands are ignored. The sketch prints **`ACK TEST_MODE 1`** / **`ACK TEST_MODE 0`** on the serial line when test mode is accepted. **`SERVO_TEST`** runs a short **0° → 180° → 0°** sweep (about **3 × SERVO_TEST_HOLD_MS** in the sketch, default 400 ms per step) **without** a full feed cycle; works in **or** out of `TEST_MODE` (not in `FEEDING`/`COOLDOWN`). The dashboard **“Run servo sweep”** button sends this command.

**Gentle IR / RPM (less jerk):** After a short IR gap the firmware **coasts** the RPM estimate down instead of snapping to zero; PWM is **slew-limited** per control tick. Stall detection runs only while IR pulses are still arriving (dropout is not treated as a stall). Tunables (see sketch for ranges): **`SET_RPM_EMA`** (pulse EMA 0.05–0.8), **`SET_PWM_SLEW`** (max PWM delta per tick, 0.5–50), **`SET_IR_DROPOUT_MS`** (start coast, 200–5000 ms), **`SET_IR_SILENCE_MS`** (then force RPM 0, 500–10000 ms; must be greater than dropout), **`SET_RPM_DECAY`** (coast factor per tick, 0.85–0.995). **`SET_IR_MAX_INSTANT_RPM`** (80–800): drop single pulse intervals that imply RPM above this (reduces motor EMI spikes); default ~`1.2 × maxExpectedRPM` in the sketch.

**IR noise with motor on:** Pulse intervals are **median-of-3** before blending into the RPM EMA so one bogus edge from driver EMI is largely ignored. **`ARM`** clears that buffer for a clean spin-up.

**RPM loop (PI + filtered D + optional FF):** **`SET_KP`**, **`SET_KI`**, **`SET_KD`** (derivative on filtered RPM, 0–5; 0 disables D), **`SET_RPM_FF`** (feed-forward PWM per target RPM, 0–0.8; load-dependent), **`SET_D_MAX`** (cap on |D term| in PWM units, 1–80). Integral **anti-windup** skips I accumulation when the PI output is saturated and still pushing in that direction; near the setpoint, Kp/Ki are scaled down slightly to reduce limit cycling. **Tuning order:** raise **`SET_RPM_FF`** until open-loop is roughly on target, then trim with **`SET_KP`** / **`SET_KI`**, then add a small **`SET_KD`** if you need less overshoot.

**RPM window (`rpm_min`…`rpm_max` with min≠max):** The controller targets the **midpoint** of the window (e.g. 350 RPM for 200–500). Dwell / feed eligibility requires measured RPM both inside `[rpm_min,rpm_max]` and within **`SET_RPM_TOL`** (ratio × midpoint, floored at 2 RPM, capped to half the window width) of that midpoint.
