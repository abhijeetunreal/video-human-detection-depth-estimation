# Video human detection, depth estimation & ball machine control

This repository combines **browser-based person detection and monocular depth** (Transformers.js) with an optional **cricket ball machine** stack: Arduino firmware, a Python serial/WebSocket bridge, and a local control dashboard.

| Area | What it is | Where |
|------|------------|--------|
| **Vision demo** | YOLO-style detection + Depth Anything V2 in the browser, no build step for static hosting | Repo root: `index.html`, `main.js`, `style.css` |
| **Ball machine** | Full operator UI (vision + MCU telemetry + throw tuning), bridge, firmware | [`ball-machine/`](ball-machine/README.md) |

---

## Repository layout

```
video-human-detection-depth-estimation/
├── README.md                 ← This file
├── index.html                # Standalone vision demo entry
├── main.js, style.css        # Vision demo assets (root)
└── ball-machine/
    ├── README.md             # Bridge, protocol, wiring, safety (start here for hardware)
    ├── bridge/               # Python: WebSocket ↔ USB serial, static file server
    ├── web/                  # Dashboard: index.html, main.js, style.css, machineBridge.js
    │   └── README.md         # Static web stack notes
    └── firmware/
        ├── README.md         # Pin map, serial basics
        └── ball_machine_control/
            └── ball_machine_control.ino
```

---

## Vision demo (repository root)

- **Stack:** [Transformers.js](https://github.com/huggingface/transformers.js) in the browser; models load from Hugging Face (first run needs network and disk).
- **Run locally:** serve the repo root over HTTP (any static server). Opening `index.html` as a `file://` URL may block camera or modules depending on the browser.
- **Deploy:** static files only; no `npm` required for the root demo if you already ship `main.js` / WASM assets as in your hosting setup.

For the **full machine UI** (same vision stack plus bridge, serial, throw controls), use **`ball-machine/web`** with the Python bridge — see below.

---

## Ball machine control stack

End-to-end flow:

1. Flash **`ball-machine/firmware/ball_machine_control/ball_machine_control.ino`** (see [`ball-machine/firmware/README.md`](ball-machine/firmware/README.md)).
2. From **`ball-machine/bridge`**, run **`run_bridge.bat`** (Windows) or `python run_bridge.py --static ../web` after installing [`requirements.txt`](ball-machine/bridge/requirements.txt).
3. Open **`http://127.0.0.1:8765/`** — the dashboard talks to the MCU over **WebSocket → bridge → serial** (115200 baud).

**Authoritative instructions**, CLI flags, **serial protocol** (`TARGET_M`, `ARM`, bands, tuning, etc.), **wiring**, and **safety** are documented in **[`ball-machine/README.md`](ball-machine/README.md)**.

### Quick links

| Doc | Contents |
|-----|----------|
| [`ball-machine/README.md`](ball-machine/README.md) | Quick start, bridge usage, protocol, BTS7960/AS5600/servo notes |
| [`ball-machine/web/README.md`](ball-machine/web/README.md) | Static dashboard; CDN Transformers.js; no Node |
| [`ball-machine/firmware/README.md`](ball-machine/firmware/README.md) | Default pins, `DIST_BANDS`, serial commands |

---

## Public demo vs local machine

- A **hosted HTTPS** build of the vision app is useful for demos; browsers **cannot** reach arbitrary **USB serial** on a visitor’s PC from the public web.
- **Local machine control** must use the **bridge** on the same machine as the Arduino (see `ball-machine/README.md`).

---

## Requirements (summary)

| Component | Notes |
|-----------|--------|
| **Browser** | Modern Chromium / Firefox / Safari; WebGPU optional for faster depth on supported GPUs |
| **Ball machine bridge** | Python 3, `pip install -r ball-machine/bridge/requirements.txt` |
| **Firmware** | Arduino IDE or compatible; **115200** baud line-based protocol |
| **Network** | Internet on first model download for Transformers.js workflows |

---

## License / attribution

Model and library licenses follow **Hugging Face** model cards and **Transformers.js** / upstream detection architectures cited in the HTML titles (e.g. YOLOv9, Depth Anything V2). Refer to those projects for redistribution terms.

---

## Contributing / support

- **Firmware or protocol:** edit the sketch and update [`ball-machine/README.md`](ball-machine/README.md) if commands or defaults change.
- **UI or bridge:** `ball-machine/web` and `ball-machine/bridge` — keep the static-web assumption (no mandatory Node build for the dashboard).
