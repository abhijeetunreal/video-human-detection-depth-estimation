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

You can delete leftover **`web/node_modules/`** or **`web/dist/`** from old Vite setups; they are unused.

### 3. Arduino firmware

Open `ball-machine/firmware/ball_machine_control/ball_machine_control.ino` in Arduino IDE, select board/port, install **no extra libraries** for AS5600 (Wire only) and **Servo** (built-in). Adjust **pin map** in the sketch to match your wiring, then upload.

## Serial protocol (115200 baud)

**Host → MCU**

- `TARGET_M <float>` — target distance in meters (from vision or manual UI).
- `TARGET_RPM <int>` — manual RPM setpoint (0–500); enables manual-RPM mode until `AUTO_RPM`.
- `AUTO_RPM` — use distance→RPM from bands (clears manual RPM override).
- `SET_BAND <i> <min_m> <max_m> <rpm>` — one distance band row (up to 6 rows; `[min,max)` in meters).
- `SET_BAND_COUNT <n>` — use the first `n` bands.
- `BANDS_RESET` — restore compiled-in default bands.
- `SET_DWELL_MS`, `SET_FEED_MS`, `SET_COOLDOWN_MS` — timing (see firmware for ranges).
- `SET_KP`, `SET_KI`, `SET_PWM_MAX`, `SET_RPM_TOL`, `SET_STALL_PWM`, `SET_STALL_RPM` — control tuning.
- `ARM` / `DISARM` — allow feeder when RPM satisfied.
- `STOP` — disarm, zero motor PWM, reset feeder to idle.

The web UI sends bands, timing, and RPM mode over the Python bridge; **flash the updated firmware** so these commands are recognized.

**MCU → Host** (lines, periodic)

- `STATE <name>` — `IDLE`, `SPINUP`, `HOLDING`, `FEEDING`, `COOLDOWN`, `FAULT`.
- `RPM <float>` — measured RPM.
- `TARGET_RPM <int>` — setpoint from distance bands.
- `DIST_M <float>` — last received target distance (meters).
- `ERR <code>` — e.g. `STALL`, `SERIAL`.

## Wiring notes (BTS7960B + AS5600 + servo)

- **Motor power:** motor supply to BTS7960 **VM**; **common GND** with Arduino.
- **IBT-2 style:** `R_EN` / `L_EN` HIGH; `RPWM` / `LPWM` as in firmware README (Uno uses PWM pins **5** and **3** so **Servo** can use pin **9** without timer clashes).
- **AS5600:** SDA → A4, SCL → A5 (Uno), 3.3 V / 5 V per module spec, GND common.
- **Servo:** signal per firmware README; **use separate 5 V supply** for the servo with common GND — do not power a large servo from the Arduino 5 V pin.

## Safety

- Use a physical **E-stop** or motor enable where possible.
- **ARM** enables automatic feeding when conditions are met; keep the area clear.
- Do not expose the bridge on `0.0.0.0` on untrusted networks without authentication.

## Folder layout

- `firmware/` — Arduino sketch.
- `bridge/` — FastAPI + WebSocket + pyserial.
- `web/` — Static HTML/CSS/JS dashboard (Transformers.js from CDN).
