# Ball machine Arduino firmware

## Pins (defaults in sketch — change to match your wiring)

| Signal    | Arduino Uno pin |
|-----------|-----------------|
| AS5600 SDA| A4              |
| AS5600 SCL| A5              |
| BTS7960 RPWM | 5 (PWM)      |
| BTS7960 LPWM | 3 (PWM)      |
| BTS7960 R_EN | 7            |
| BTS7960 L_EN | 8            |
| Servo signal | 9           |

Note: On Uno, **Servo** disables PWM on pins 9 and 10, so the motor PWM uses **3 and 5** instead.

Enable pins **R_EN** and **L_EN** must be driven HIGH for the IBT-2 module to run.

## Distance → target RPM (meters)

Edit `DIST_BANDS` in the sketch if your machine needs different ranges.

## Serial

115200 baud, line-based commands: `TARGET_M 2.5`, `ARM`, `DISARM`, `STOP`.
