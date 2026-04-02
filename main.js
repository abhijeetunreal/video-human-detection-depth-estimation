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
const calibrationLayer = document.getElementById("calibration-layer");
const calibrateModeCheckbox = document.getElementById("calibrate-mode");
const calibrationDistanceInput = document.getElementById("calibration-distance");
const calibrationApplyBtn = document.getElementById("calibration-apply");
const calibrationClearBtn = document.getElementById("calibration-clear");
const calibrationInvertCheckbox = document.getElementById("calibration-invert");

/** Latest depth + detection sizes for Apply (same tensors as live view). */
let lastDepthState = null;
/** @type {[number, number] | null} */
let lastDetSizes = null;

/**
 * @typedef {{ dRef: number, useInverse: boolean, roiDet: { xmin: number, ymin: number, xmax: number, ymax: number } }} Calibration
 * @type {Calibration | null}
 */
let calibration = null;

/** Mean raw depth in the calibration ROI for the current frame (tracks exposure / lighting drift). */
let calibrationRefRawThisFrame = null;

/** Draft ROI in detection space (while dragging or before Apply). */
let draftRoiDet = null;
let isDrawingRoi = false;
/** @type {{ x: number, y: number } | null} */
let roiDragStartDet = null;

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

/**
 * Mean raw depth over depth pixels whose mapped det-space position lies inside the rectangle.
 * Uses the same det→depth index mapping as sampleDepthAt (inverse mapping from grid).
 */
function meanDepthInRect(data, ow, oh, xmin, ymin, xmax, ymax, wDet, hDet) {
  const x0 = Math.min(xmin, xmax);
  const x1 = Math.max(xmin, xmax);
  const y0 = Math.min(ymin, ymax);
  const y1 = Math.max(ymin, ymax);
  if (x1 <= x0 || y1 <= y0) return { mean: NaN, count: 0 };

  const stride = ow * oh > 320_000 ? 2 : 1;
  let sum = 0;
  let count = 0;
  const xDen = Math.max(1, ow - 1);
  const yDen = Math.max(1, oh - 1);

  for (let iy = 0; iy < oh; iy += stride) {
    for (let ix = 0; ix < ow; ix += stride) {
      const cx = (ix / xDen) * wDet;
      const cy = (iy / yDen) * hDet;
      if (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1) {
        sum += data[iy * ow + ix];
        count += 1;
      }
    }
  }

  if (count === 0) return { mean: NaN, count: 0 };
  return { mean: sum / count, count };
}

function clientToDetSpace(clientX, clientY, wDet, hDet) {
  const rect = container.getBoundingClientRect();
  const x = ((clientX - rect.left) / rect.width) * wDet;
  const y = ((clientY - rect.top) / rect.height) * hDet;
  return { x, y };
}

/**
 * @param {number} raw — depth sample at person center (same frame as rawRefLive).
 * @param {Calibration | null} cal
 * @param {number | null} rawRefLive — mean depth in the marked calibration ROI for this frame only.
 */
function metricDistanceFromRaw(raw, cal, rawRefLive) {
  if (!cal) return null;
  const { dRef, useInverse } = cal;
  if (
    rawRefLive === null ||
    !Number.isFinite(rawRefLive) ||
    Math.abs(rawRefLive) < 1e-12
  ) {
    return null;
  }
  if (useInverse) {
    if (Math.abs(raw) < 1e-12) return Infinity;
    return (dRef * rawRefLive) / raw;
  }
  return (dRef / rawRefLive) * raw;
}

function updateCalibrationUiState() {
  const mode = calibrateModeCheckbox.checked;
  calibrationLayer.classList.toggle("calibration-layer-active", mode);
  calibrationDistanceInput.disabled = !mode;
  const canApply =
    mode &&
    draftRoiDet !== null &&
    lastDepthState !== null &&
    lastDetSizes !== null;
  calibrationApplyBtn.disabled = !canApply;
  calibrationClearBtn.disabled = !calibration && !draftRoiDet;
}

calibrationInvertCheckbox.addEventListener("change", () => {
  if (calibration) {
    calibration.useInverse = calibrationInvertCheckbox.checked;
  }
});

function renderSavedRoiOutline() {
  if (!calibration?.roiDet || !lastDetSizes) return;
  const [wDet, hDet] = lastDetSizes;
  const { xmin, ymin, xmax, ymax } = calibration.roiDet;
  const box = document.createElement("div");
  box.className = "calibration-roi-saved";
  Object.assign(box.style, {
    left: (100 * xmin) / wDet + "%",
    top: (100 * ymin) / hDet + "%",
    width: (100 * (xmax - xmin)) / wDet + "%",
    height: (100 * (ymax - ymin)) / hDet + "%",
  });
  calibrationLayer.appendChild(box);
}

function renderDraftRoiOutline() {
  if (!draftRoiDet || !lastDetSizes) return;
  const [wDet, hDet] = lastDetSizes;
  const { xmin, ymin, xmax, ymax } = draftRoiDet;
  const box = document.createElement("div");
  box.className = "calibration-roi-draft";
  Object.assign(box.style, {
    left: (100 * xmin) / wDet + "%",
    top: (100 * ymin) / hDet + "%",
    width: (100 * (xmax - xmin)) / wDet + "%",
    height: (100 * (ymax - ymin)) / hDet + "%",
  });
  calibrationLayer.appendChild(box);
}

function refreshCalibrationLayer() {
  calibrationLayer.replaceChildren();
  if (calibration) renderSavedRoiOutline();
  if (calibrateModeCheckbox.checked && draftRoiDet) renderDraftRoiOutline();
}

calibrateModeCheckbox.addEventListener("change", () => {
  if (!calibrateModeCheckbox.checked) {
    isDrawingRoi = false;
    roiDragStartDet = null;
    draftRoiDet = null;
    refreshCalibrationLayer();
  }
  updateCalibrationUiState();
});

function pointerDownRoi(ev) {
  if (!calibrateModeCheckbox.checked || !lastDetSizes) return;
  ev.preventDefault();
  const [wDet, hDet] = lastDetSizes;
  const p = clientToDetSpace(ev.clientX, ev.clientY, wDet, hDet);
  isDrawingRoi = true;
  roiDragStartDet = p;
  draftRoiDet = { xmin: p.x, ymin: p.y, xmax: p.x, ymax: p.y };
  refreshCalibrationLayer();
  updateCalibrationUiState();
}

function pointerMoveRoi(ev) {
  if (!isDrawingRoi || !roiDragStartDet || !lastDetSizes) return;
  ev.preventDefault();
  const [wDet, hDet] = lastDetSizes;
  const p = clientToDetSpace(ev.clientX, ev.clientY, wDet, hDet);
  draftRoiDet = {
    xmin: Math.min(roiDragStartDet.x, p.x),
    ymin: Math.min(roiDragStartDet.y, p.y),
    xmax: Math.max(roiDragStartDet.x, p.x),
    ymax: Math.max(roiDragStartDet.y, p.y),
  };
  refreshCalibrationLayer();
}

function pointerUpRoi(ev) {
  if (!isDrawingRoi) return;
  ev.preventDefault();
  isDrawingRoi = false;
  roiDragStartDet = null;
  updateCalibrationUiState();
}

calibrationLayer.addEventListener("mousedown", pointerDownRoi);
window.addEventListener("mousemove", pointerMoveRoi);
window.addEventListener("mouseup", pointerUpRoi);

calibrationLayer.addEventListener(
  "touchstart",
  (ev) => {
    if (!calibrateModeCheckbox.checked || !lastDetSizes) return;
    ev.preventDefault();
    const t = ev.changedTouches[0];
    pointerDownRoi({ clientX: t.clientX, clientY: t.clientY, preventDefault: () => {} });
  },
  { passive: false },
);

window.addEventListener(
  "touchmove",
  (ev) => {
    if (!isDrawingRoi || !lastDetSizes) return;
    ev.preventDefault();
    const t = ev.changedTouches[0];
    pointerMoveRoi({ clientX: t.clientX, clientY: t.clientY, preventDefault: () => {} });
  },
  { passive: false },
);

window.addEventListener("touchend", (ev) => {
  if (!isDrawingRoi) return;
  pointerUpRoi(ev);
});

calibrationApplyBtn.addEventListener("click", () => {
  if (!lastDepthState || !lastDetSizes || !draftRoiDet) {
    status.textContent = "No depth frame or region — wait for video, then draw a region.";
    return;
  }
  const dRef = Number(calibrationDistanceInput.value);
  if (!Number.isFinite(dRef) || dRef <= 0) {
    status.textContent = "Enter a positive real distance in meters.";
    return;
  }
  const [wDet, hDet] = lastDetSizes;
  const { data, ow, oh } = lastDepthState;
  const { xmin, ymin, xmax, ymax } = draftRoiDet;
  const { mean, count } = meanDepthInRect(
    data,
    ow,
    oh,
    xmin,
    ymin,
    xmax,
    ymax,
    wDet,
    hDet,
  );
  if (count === 0 || !Number.isFinite(mean)) {
    status.textContent = "Could not sample depth in that region — try a larger area.";
    return;
  }
  if (Math.abs(mean) < 1e-12) {
    status.textContent = "Depth value too small to calibrate — try another region.";
    return;
  }

  calibration = {
    dRef,
    useInverse: calibrationInvertCheckbox.checked,
    roiDet: {
      xmin,
      ymin,
      xmax,
      ymax,
    },
  };
  draftRoiDet = null;
  refreshCalibrationLayer();
  calibrationInvertCheckbox.checked = calibration.useInverse;
  updateCalibrationUiState();
  status.textContent = `Calibrated: ${dRef} m — reference region re-sampled each frame`;
});

calibrationClearBtn.addEventListener("click", () => {
  calibration = null;
  draftRoiDet = null;
  refreshCalibrationLayer();
  updateCalibrationUiState();
  status.textContent = "Calibration cleared";
});

updateCalibrationUiState();

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
  const meters = metricDistanceFromRaw(
    raw,
    calibration,
    calibrationRefRawThisFrame,
  );
  if (meters !== null && Number.isFinite(meters)) {
    depthLabel.textContent = `${meters.toFixed(2)} m`;
  } else if (meters !== null && !Number.isFinite(meters)) {
    depthLabel.textContent = "—";
  } else {
    depthLabel.textContent = `${(rel * 100).toFixed(0)}% · ${raw.toFixed(2)}`;
  }

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

      const sizes = detInputs.reshaped_input_sizes[0].reverse();
      lastDepthState = depthState;
      lastDetSizes = sizes;

      calibrationRefRawThisFrame = null;
      if (calibration) {
        const [wDet, hDet] = sizes;
        const { data, ow, oh } = depthState;
        const { xmin, ymin, xmax, ymax } = calibration.roiDet;
        const { mean, count } = meanDepthInRect(
          data,
          ow,
          oh,
          xmin,
          ymin,
          xmax,
          ymax,
          wDet,
          hDet,
        );
        if (
          count > 0 &&
          Number.isFinite(mean) &&
          Math.abs(mean) >= 1e-12
        ) {
          calibrationRefRawThisFrame = mean;
        }
      }

      overlay.innerHTML = "";

      outputs.tolist().forEach((x) => renderBox(x, sizes, depthState));

      refreshCalibrationLayer();
      updateCalibrationUiState();

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
