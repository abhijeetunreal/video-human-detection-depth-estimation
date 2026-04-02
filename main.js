import {
  AutoModel,
  AutoProcessor,
  AutoImageProcessor,
  RawImage,
} from "@huggingface/transformers";

async function hasFp16() {
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return adapter?.features?.has("shader-f16") ?? false;
  } catch {
    return false;
  }
}

// Reference the elements that we will need
const status = document.getElementById("status");
const container = document.getElementById("container");
const depthContainer = document.getElementById("depth-container");
const overlay = document.getElementById("overlay");
const canvas = document.getElementById("canvas");
const depthCanvas = document.getElementById("depth-canvas");
const video = document.getElementById("video");
const thresholdSlider = document.getElementById("threshold");
const thresholdLabel = document.getElementById("threshold-value");
const sizeSlider = document.getElementById("size");
const sizeLabel = document.getElementById("size-value");
const scaleSlider = document.getElementById("scale");
const scaleLabel = document.getElementById("scale-value");
const depthSizeSlider = document.getElementById("depth-size");
const depthSizeLabel = document.getElementById("depth-size-value");

function setStreamSize(width, height) {
  video.width = canvas.width = Math.round(width);
  video.height = canvas.height = Math.round(height);
}

function syncPanelSizes() {
  let vw = video.videoWidth;
  let vh = video.videoHeight;
  if (!vw || !vh) {
    const track = video.srcObject?.getVideoTracks?.()?.[0];
    if (track) {
      const s = track.getSettings();
      vw = s.width;
      vh = s.height;
    }
  }
  if (!vw || !vh) return;
  const ar = vw / vh;
  const [cw, ch] = ar > 720 / 405 ? [720, 720 / ar] : [405 * ar, 405];
  container.style.width = `${cw}px`;
  container.style.height = `${ch}px`;
  depthContainer.style.width = `${cw}px`;
  depthContainer.style.height = `${ch}px`;
}

status.textContent = "Loading detection model...";

const detModelId = "Xenova/gelan-c_all";
const detModel = await AutoModel.from_pretrained(detModelId);
const detProcessor = await AutoProcessor.from_pretrained(detModelId);

status.textContent = "Loading depth model...";

const depthModelId = "onnx-community/depth-anything-v2-small";
let depthModel;
try {
  depthModel = await AutoModel.from_pretrained(depthModelId, {
    device: "webgpu",
    dtype: (await hasFp16()) ? "fp16" : "fp32",
  });
} catch (err) {
  status.textContent = `WebGPU depth load failed, trying default: ${err.message}`;
  depthModel = await AutoModel.from_pretrained(depthModelId);
}

const depthProcessor = await AutoImageProcessor.from_pretrained(depthModelId);

// Set up controls
let scale = 0.5;
scaleSlider.addEventListener("input", () => {
  scale = Number(scaleSlider.value);
  setStreamSize(video.videoWidth * scale, video.videoHeight * scale);
  scaleLabel.textContent = scale;
  syncPanelSizes();
});
scaleSlider.disabled = false;

let threshold = 0.25;
thresholdSlider.addEventListener("input", () => {
  threshold = Number(thresholdSlider.value);
  thresholdLabel.textContent = threshold.toFixed(2);
});
thresholdSlider.disabled = false;

let size = 128;
detProcessor.feature_extractor.size = { shortest_edge: size };
sizeSlider.addEventListener("input", () => {
  size = Number(sizeSlider.value);
  detProcessor.feature_extractor.size = { shortest_edge: size };
  sizeLabel.textContent = size;
});
sizeSlider.disabled = false;

let depthSize = 504;
depthProcessor.size = { width: depthSize, height: depthSize };
depthSizeSlider.addEventListener("input", () => {
  depthSize = Number(depthSizeSlider.value);
  depthProcessor.size = { width: depthSize, height: depthSize };
  depthSizeLabel.textContent = depthSize;
});
depthSizeSlider.disabled = false;

status.textContent = "Ready";

const PERSON_COLOR = "#22C55E";

function isPersonClass(id) {
  const label = detModel.config.id2label?.[id];
  if (label && String(label).toLowerCase() === "person") return true;
  return id === 0;
}

/** Sample depth tensor [1,H,W] at detection-space center mapped onto the depth map. */
function sampleDepthAt(data, ow, oh, cx, cy, wDet, hDet, min, max) {
  const ix = Math.min(
    ow - 1,
    Math.max(0, Math.round((cx / wDet) * (ow - 1))),
  );
  const iy = Math.min(
    oh - 1,
    Math.max(0, Math.round((cy / hDet) * (oh - 1))),
  );
  const raw = data[iy * ow + ix];
  const range = max - min;
  const rel = range > 0 ? (raw - min) / range : 0.5;
  return { raw, rel };
}

function renderBox(
  [xmin, ymin, xmax, ymax, score, id],
  [wDet, hDet],
  depthState,
) {
  if (score < threshold) return;
  if (!isPersonClass(id)) return;

  const { data, ow, oh, min, max } = depthState;
  const cx = (xmin + xmax) / 2;
  const cy = (ymin + ymax) / 2;
  const { raw, rel } = sampleDepthAt(data, ow, oh, cx, cy, wDet, hDet, min, max);

  const boxElement = document.createElement("div");
  boxElement.className = "bounding-box";
  Object.assign(boxElement.style, {
    borderColor: PERSON_COLOR,
    left: (100 * xmin) / wDet + "%",
    top: (100 * ymin) / hDet + "%",
    width: (100 * (xmax - xmin)) / wDet + "%",
    height: (100 * (ymax - ymin)) / hDet + "%",
  });

  const dot = document.createElement("span");
  dot.className = "bounding-box-center-dot";
  dot.setAttribute("aria-hidden", "true");

  const depthLabel = document.createElement("span");
  depthLabel.className = "bounding-box-depth-label";
  depthLabel.textContent = `${(rel * 100).toFixed(0)}% · ${raw.toFixed(2)}`;

  boxElement.appendChild(dot);
  boxElement.appendChild(depthLabel);
  overlay.appendChild(boxElement);
}

let isProcessing = false;
let previousTime;
const context = canvas.getContext("2d", { willReadFrequently: true });
const depthContext = depthCanvas.getContext("2d", { willReadFrequently: true });

/** Red channel + alpha from normalized depth (same visualization as depth-estimation-video). */
function drawDepthHeatmap(data, ow, oh, min, max) {
  depthCanvas.width = ow;
  depthCanvas.height = oh;
  const range = max - min;
  const imageData = new Uint8ClampedArray(4 * data.length);
  if (!Number.isFinite(range) || range <= 0) {
    for (let i = 0; i < data.length; ++i) {
      const o = 4 * i;
      imageData[o] = 255;
      imageData[o + 3] = 128;
    }
  } else {
    for (let i = 0; i < data.length; ++i) {
      const o = 4 * i;
      imageData[o] = 255;
      imageData[o + 3] = Math.round(
        255 * (1 - (data[i] - min) / range),
      );
    }
  }
  depthContext.putImageData(new ImageData(imageData, ow, oh), 0, 0);
}

function updateCanvas() {
  const { width, height } = canvas;
  context.drawImage(video, 0, 0, width, height);

  if (!isProcessing) {
    isProcessing = true;
    (async function () {
      const pixelData = context.getImageData(0, 0, width, height).data;
      const image = new RawImage(pixelData, width, height, 4);

      const depthInputs = await depthProcessor(image);
      const { predicted_depth } = await depthModel(depthInputs);
      const dData = predicted_depth.data;
      const [, oh, ow] = predicted_depth.dims;

      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < dData.length; ++i) {
        const v = dData[i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      drawDepthHeatmap(dData, ow, oh, min, max);
      const depthState = { data: dData, ow, oh, min, max };

      const detInputs = await detProcessor(image);
      const { outputs } = await detModel(detInputs);

      overlay.innerHTML = "";

      const sizes = detInputs.reshaped_input_sizes[0].reverse();
      outputs
        .tolist()
        .forEach((x) => renderBox(x, sizes, depthState));

      if (previousTime !== undefined) {
        const fps = 1000 / (performance.now() - previousTime);
        status.textContent = `FPS: ${fps.toFixed(2)}`;
      }
      previousTime = performance.now();
      isProcessing = false;
    })();
  }

  window.requestAnimationFrame(updateCanvas);
}

navigator.mediaDevices
  .getUserMedia({ video: true })
  .then((stream) => {
    video.srcObject = stream;
    video.play();

    const videoTrack = stream.getVideoTracks()[0];
    const { width, height } = videoTrack.getSettings();

    setStreamSize(width * scale, height * scale);

    syncPanelSizes();

    window.requestAnimationFrame(updateCanvas);
  })
  .catch((error) => {
    alert(error);
  });
