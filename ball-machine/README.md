# Ball machine control stack

Self-contained firmware, Python serial bridge, and local web dashboard (vision + machine control). The parent repo’s detection app is unchanged.

**Repo overview (vision demo + this stack):** [../README.md](../README.md).

## Public demo vs machine control

- **Public (HTTPS) demo** of the original vision app: [video-human-detection-depth-estimation](https://abhijeet.codefrydev.in/video-human-detection-depth-estimation/) — useful for sharing; **do not rely on it** to reach USB serial on your PC (browser security).
- **Machine control:** run **`run_bridge.bat`** (or `python run_bridge.py --static ../web`) so the dashboard is served at **`http://127.0.0.1:8765/`** with WebSocket on the same host.

## Quick start

### 1. Web dashboard (no Node.js)

The UI lives in **`ball-machine/web/`** as plain **`index.html`**, **`main.js`**, **`style.css`**, and **`machineBridge.js`**. There is **no `npm install`**. Transformers.js is loaded from a **CDN** in the browser; models still download from Hugging Face on first use (large, needs internet).

### 2. Python bridge (Windows: double-click)

From **`ball-machine/bridge`**, run **`run_bridge.bat`**. It will:

1. Check that **`web/index.html`**, **`main.js`**, and **`style.css`** exist  
2. Create **`.venv`** if needed and **`pip install -r requirements.txt`**  
3. **Auto-pick the Arduino / USB-serial port** (unless you pass `--port`)  
4. Start the bridge with **`--static`** pointing at **`../web`**, open **`http://127.0.0.1:8765/`**, and **open your browser** (unless `--no-browser`)  

The console **stays open** with server logs. On errors or after exit, it **pauses** so you can read messages.

```bat
cd ball-machine\bridge
run_bridge.bat
```

```bat
run_bridge.bat --port COM5
run_bridge.bat --no-browser
```

**Linux / macOS** (from `bridge/` with venv activated):

```bash
pip install -r requirements.txt
python run_bridge.py --static ../web
```

**Dashboard:** `http://127.0.0.1:8765/` — **WebSocket:** `ws://127.0.0.1:8765/ws` (same origin when using `--static ../web`).

The in-page **Activity** log shows bridge-side INFO lines (e.g. motor test forwarded to serial). The **Serial** tab shows the MCU’s UART output (`STATE`, `ACK TEST_MODE`, etc.). See [web/README.md](web/README.md).

You can delete leftover **`web/node_modules/`** or **`web/dist/`** from old Vite setups; they are unused.

### 3. Arduino firmware

Open `ball-machine/firmware/ball_machine_control/ball_machine_control.ino` in Arduino IDE, select board/port, install **Servo** (built-in) only. Adjust **pin map** and **`pulsesPerRevolution`** in the sketch to match your wiring and wheel, then upload.

## Serial protocol (115200 baud)

Only **one program** may open the Arduino COM port at a time. Close **Arduino Serial Monitor** and any other serial tools while **`run_bridge.bat`** is running, or commands like `TEST_MODE` will never reach the MCU and the log can look corrupted.

**Host → MCU**

- `TARGET_M <float>` — target distance in meters (from vision or manual UI).
- `TARGET_RPM <int>` or `TARGET_RPM <rpm_min> <rpm_max>` — manual RPM window (0–500 each); enables manual-RPM mode until `AUTO_RPM`. One value sets min=max; two values set a range: firmware **regulates toward the midpoint** of that range and uses dwell tolerance around the midpoint (see firmware README).
- `AUTO_RPM` — use distance→RPM from bands (clears manual RPM override).
- `SET_BAND <i> <min_m> <max_m> <rpm_min> <rpm_max>` — one distance band row (up to 6 rows; distance `[min,max)` in meters; in auto mode the MCU targets the **midpoint** of `[rpm_min,rpm_max]` and dwell uses tolerance around that midpoint).
- `SET_BAND_COUNT <n>` — use the first `n` bands.
- `BANDS_RESET` — restore compiled-in default bands.
- `SET_DWELL_MS`, `SET_FEED_MS`, `SET_COOLDOWN_MS` — timing (see firmware for ranges).
- `SET_KP`, `SET_KI`, `SET_KD`, `SET_RPM_FF`, `SET_D_MAX`, `SET_PWM_MAX`, `SET_RPM_TOL`, `SET_STALL_PWM`, `SET_STALL_RPM` — control tuning (see [firmware/README.md](firmware/README.md) for PI+D+FF and tuning order).
- `SET_RPM_EMA`, `SET_PWM_SLEW`, `SET_IR_DROPOUT_MS`, `SET_IR_SILENCE_MS`, `SET_RPM_DECAY`, `SET_IR_MAX_INSTANT_RPM` — softer IR RPM handling and EMI spike rejection; see [firmware/README.md](firmware/README.md).

IR dropout is softened in firmware; use **`SET_PWM_SLEW`** / **`SET_KP`** / **`SET_KI`** to trade smoothness vs responsiveness.
- `ARM` / `DISARM` — allow feeder when RPM satisfied.
- `FEED_ONCE` — start one feeder cycle (requires **`ARM`** only; does not require `TARGET_RPM` to be non-zero). Sent by the dashboard “manual fire” button.
- `AUTO_FEED 0|1` — when `1`, dwell can auto-trigger feeding; when `0`, use `FEED_ONCE` only (manual mode uses `0`).
- `STOP` — disarm, zero motor PWM, reset feeder to idle.
- `TEST_MODE 0|1` — bench open-loop mode (`1` = on, direct PWM only; normal PI/arm/feed ignored; **feeder is held at 0°** unless you run **`SERVO_TEST`**). Pair with `TEST_PWM`.
- `SERVO_TEST` — one **0° → 180° → 0°** sweep for the feeder servo (also available as the **Run servo sweep** button under Motor test in the web UI).
- `TEST_PWM <0…PWM_MAX>` — motor PWM while `TEST_MODE 1` (accelerator / bench).

The web UI sends bands, timing, and RPM mode over the Python bridge; **flash the updated firmware** so these commands are recognized.

**MCU → Host** (lines, periodic)

- `STATE <name>` — `IDLE`, `SPINUP`, `FEEDING`, `COOLDOWN`, `FAULT`, `TEST` (open-loop bench).
- `RPM <float>` — measured RPM.
- `TARGET_RPM <int>` — midpoint of the active RPM window (auto) or manual setpoint.
- `TARGET_RPM_MIN <int>` / `TARGET_RPM_MAX <int>` — active RPM window from bands (auto) or both equal to manual `TARGET_RPM`.
- `DIST_M <float>` — last received target distance (meters).
- `ERR <code>` — e.g. `STALL`, `SERIAL`.

## Wiring notes (BTS7960B + IR RPM + servo)

- **Motor power:** motor supply to BTS7960 **VM**; **common GND** with Arduino.
- **IBT-2 style:** `R_EN` / `L_EN` HIGH; `RPWM` / `LPWM` as in firmware README (Uno uses PWM pins **5** and **3** so **Servo** can use pin **9** without timer clashes).
- **IR RPM:** reflective/slot sensor (e.g. FC-51) **OUT** → default pin **2** (interrupt-capable); **VCC/GND** per module; align marks or slots on the wheel with **`pulsesPerRevolution`** in the firmware.
- **Servo:** signal per firmware README; **use separate 5 V supply** for the servo with common GND — do not power a large servo from the Arduino 5 V pin.

## Safety

- Use a physical **E-stop** or motor enable where possible.
- **ARM** enables automatic feeding when conditions are met; keep the area clear.
- Do not expose the bridge on `0.0.0.0` on untrusted networks without authentication.

## Folder layout

- `firmware/` — Arduino sketch.
- `bridge/` — FastAPI + WebSocket + pyserial.
- `web/` — Static HTML/CSS/JS dashboard (Transformers.js from CDN).
