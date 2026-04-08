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

**IR RPM:** Connect sensor **VCC**, **GND**, and **OUT** to the pin above; **common GND** with the Arduino and motor driver. Set **`pulsesPerRevolution`** in the sketch to the number of reflective marks or slots per wheel revolution.

Enable pins **R_EN** and **L_EN** must be driven HIGH for the IBT-2 module to run.

## Distance → RPM range (meters)

Edit the `distBands[]` defaults in the sketch (each row: distance `[min_m,max_m)` and **`rpm_min`…`rpm_max`**). Runtime: `SET_BAND i min_m max_m rpm_min rpm_max`.

## Serial

115200 baud, line-based commands: `TARGET_M 2.5`, `ARM`, `DISARM`, `STOP`.

**Bench test (open-loop):** `TEST_MODE 1` then `TEST_PWM <0…PWM_MAX>` (see `SET_PWM_MAX`). `TEST_MODE 0` or `STOP` exits. While active, other motion commands are ignored. The sketch prints **`ACK TEST_MODE 1`** / **`ACK TEST_MODE 0`** on the serial line when test mode is accepted.
