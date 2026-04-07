# Ball machine dashboard (static)

No **Node.js** or **npm** — plain **`index.html`**, **`style.css`**, **`main.js`**, **`machineBridge.js`**.

- Served by the Python bridge with `--static` pointing at this folder.
- **Transformers.js** loads from **[esm.sh](https://esm.sh)** in the browser; models still download from Hugging Face on first run (large, requires internet).

You may delete leftover **`node_modules/`** or **`dist/`** from older Vite builds; they are not used anymore.
