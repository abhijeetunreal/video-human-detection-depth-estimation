# Ball machine dashboard (static)

No **Node.js** or **npm** — plain **`index.html`**, **`style.css`**, **`main.js`**, **`machineBridge.js`**.

- Served by the Python bridge with `--static` pointing at this folder.
- **Transformers.js** loads from **[esm.sh](https://esm.sh)** in the browser; models still download from Hugging Face on first run (large, requires internet).

You may delete leftover **`node_modules/`** or **`dist/`** from older Vite builds; they are not used anymore.

## Activity vs Serial (bottom terminal)

- **Activity** — WebSocket / bridge events (e.g. `INFO: Motor test mode ON` when the Python bridge enables test mode on the serial port). This is **not** the raw UART stream.
- **Serial** — Lines **read from the Arduino** (MCU telemetry and firmware prints). Motor test entry/exit is echoed by the firmware as `ACK TEST_MODE 1` / `ACK TEST_MODE 0`; periodic lines include `STATE TEST` while in bench test.
