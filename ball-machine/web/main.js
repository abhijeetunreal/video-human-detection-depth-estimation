import * as transformers from "https://esm.sh/@huggingface/transformers@3.7.1";
import { createMachineBridge } from "./machineBridge.js";

transformers.env.allowLocalModels = false;
transformers.env.useBrowserCache = true;

const {
  AutoModel,
  AutoProcessor,
  AutoImageProcessor,
  RawImage,
} = transformers;

const PLAYER_PALETTE = [
  "#22C55E",
  "#38BDF8",
  "#A78BFA",
  "#F472B6",
  "#FBBF24",
  "#2DD4BF",
];

const PRESET_KEY = "ballMachineDetectionPresets";
const THEME_STORAGE_KEY = "ballMachineUiTheme";
const THROW_CONFIG_KEY = "ballMachineThrowConfig_v2";
const THROW_CONFIG_KEY_LEGACY = "ballMachineThrowConfig_v1";

/** @type {Array<{ min_m: number, max_m: number, rpm_min: number, rpm_max: number }>} */
const DEFAULT_THROW_BANDS = [
  { min_m: 0.55, max_m: 1.15, rpm_min: 45, rpm_max: 55 },
  { min_m: 1.15, max_m: 2.2, rpm_min: 90, rpm_max: 110 },
  { min_m: 2.2, max_m: 30, rpm_min: 140, rpm_max: 160 },
  { min_m: 0, max_m: 0, rpm_min: 0, rpm_max: 0 },
  { min_m: 0, max_m: 0, rpm_min: 0, rpm_max: 0 },
  { min_m: 0, max_m: 0, rpm_min: 0, rpm_max: 0 },
];

function defaultThrowTuning() {
  return {
    dwell_ms: 280,
    feed_ms: 220,
    cooldown_ms: 900,
    kp: 2.8,
    ki: 0.35,
    pwm_max: 220,
    rpm_tol_ratio: 0.08,
    stall_pwm: 160,
    stall_rpm: 8,
  };
}

function defaultHeadTracking() {
  return {
    enabled: false,
    /** 0 = Player 1 (leftmost in sorted list) */
    trackPlayerSlot: 0,
    distMin: 5,
    distMax: 80,
    outOfRange: "hold_last",
    invertX: false,
    marginLeftPct: 5,
    marginRightPct: 5,
    posDeadband: 0.02,
    emaAlpha: 0.25,
    minSendMs: 100,
    mcuPwmMax: 120,
    mcuSlew: 8,
    mcuPosDeadband: 0.04,
    mcuTimeoutMs: 4000,
    mcuStrokeS: 18,
    homeOnConnect: false,
  };
}

/**
 * @param {unknown} raw
 */
function normalizeHeadTracking(raw) {
  const d = defaultHeadTracking();
  if (!raw || typeof raw !== "object") return d;
  const h = /** @type {Record<string, unknown>} */ (raw);
  const or = h.outOfRange;
  const outOfRange =
    or === "retract" || or === "center" ? or : "hold_last";
  const out = {
    enabled: Boolean(h.enabled),
    trackPlayerSlot: (() => {
      const a = h.trackPlayerSlot;
      const b = h.headTargetPlayer;
      if (typeof a === "number" && Number.isFinite(a))
        return Math.min(7, Math.max(0, Math.round(a)));
      if (typeof b === "number" && Number.isFinite(b))
        return Math.min(7, Math.max(0, Math.round(b)));
      return d.trackPlayerSlot;
    })(),
    distMin:
      typeof h.distMin === "number" && Number.isFinite(h.distMin)
        ? Math.max(0, h.distMin)
        : d.distMin,
    distMax:
      typeof h.distMax === "number" && Number.isFinite(h.distMax)
        ? Math.max(0.1, h.distMax)
        : d.distMax,
    outOfRange,
    invertX: Boolean(h.invertX),
    marginLeftPct:
      typeof h.marginLeftPct === "number" && Number.isFinite(h.marginLeftPct)
        ? Math.min(45, Math.max(0, h.marginLeftPct))
        : d.marginLeftPct,
    marginRightPct:
      typeof h.marginRightPct === "number" && Number.isFinite(h.marginRightPct)
        ? Math.min(45, Math.max(0, h.marginRightPct))
        : d.marginRightPct,
    posDeadband:
      typeof h.posDeadband === "number" && Number.isFinite(h.posDeadband)
        ? Math.min(0.5, Math.max(0, h.posDeadband))
        : d.posDeadband,
    emaAlpha:
      typeof h.emaAlpha === "number" && Number.isFinite(h.emaAlpha)
        ? Math.min(1, Math.max(0.01, h.emaAlpha))
        : d.emaAlpha,
    minSendMs:
      typeof h.minSendMs === "number" && Number.isFinite(h.minSendMs)
        ? Math.min(2000, Math.max(20, Math.round(h.minSendMs)))
        : d.minSendMs,
    mcuPwmMax:
      typeof h.mcuPwmMax === "number" && Number.isFinite(h.mcuPwmMax)
        ? Math.min(255, Math.max(10, Math.round(h.mcuPwmMax)))
        : d.mcuPwmMax,
    mcuSlew:
      typeof h.mcuSlew === "number" && Number.isFinite(h.mcuSlew)
        ? Math.min(255, Math.max(1, Math.round(h.mcuSlew)))
        : d.mcuSlew,
    mcuPosDeadband:
      typeof h.mcuPosDeadband === "number" && Number.isFinite(h.mcuPosDeadband)
        ? Math.min(0.5, Math.max(0.005, h.mcuPosDeadband))
        : d.mcuPosDeadband,
    mcuTimeoutMs:
      typeof h.mcuTimeoutMs === "number" && Number.isFinite(h.mcuTimeoutMs)
        ? Math.min(30000, Math.max(200, Math.round(h.mcuTimeoutMs)))
        : d.mcuTimeoutMs,
    mcuStrokeS:
      typeof h.mcuStrokeS === "number" && Number.isFinite(h.mcuStrokeS)
        ? Math.min(120, Math.max(0.5, h.mcuStrokeS))
        : d.mcuStrokeS,
    homeOnConnect: Boolean(h.homeOnConnect),
  };
  if (out.distMax < out.distMin) {
    const s = out.distMin;
    out.distMin = out.distMax;
    out.distMax = s;
  }
  return out;
}

/**
 * @param {string} id
 * @param {number} num
 * @param {number[]} allowed
 */
function setHeadSelectNearest(id, num, allowed) {
  const el = document.getElementById(id);
  if (!el || el.tagName !== "SELECT") return;
  const s = String(num);
  if ([...el.options].some((o) => o.value === s)) {
    el.value = s;
    return;
  }
  let best = allowed[0];
  let bd = Math.abs(num - best);
  for (const x of allowed) {
    const d = Math.abs(num - x);
    if (d < bd) {
      bd = d;
      best = x;
    }
  }
  el.value = String(best);
}

let lastPlayersSnapshot = [];

/** When set, next `updateHeadTargetPlayerSelect` applies this slot after options are built. */
let pendingHeadTargetSlot = null;

/** Roster identity (length + track order) for head-target select; avoids rebuilding while open. */
let lastHeadTargetRosterSig = "";

function headTargetDistGate() {
  const dMin = parseFloat(document.getElementById("head-dist-min")?.value ?? "5");
  const dMax = parseFloat(document.getElementById("head-dist-max")?.value ?? "80");
  let distMin = Number.isFinite(dMin) ? dMin : 5;
  let distMax = Number.isFinite(dMax) ? dMax : 80;
  if (distMax < distMin) {
    const t = distMin;
    distMin = distMax;
    distMax = t;
  }
  return { distMin, distMax };
}

function refreshHeadTargetOorClass() {
  const sel = document.getElementById("head-target-player");
  if (!sel || sel.disabled) return;
  const opt = sel.options[sel.selectedIndex];
  const oor = opt?.getAttribute("data-oor") === "1";
  sel.classList.toggle("head-target-player--oor", !!oor);
}

/**
 * @param {Array<{ trackId: number, meters: number | null }>} list
 */
function updateHeadTargetOptionLabels(list) {
  const sel = document.getElementById("head-target-player");
  if (!sel || sel.disabled || list.length === 0) return;
  const { distMin, distMax } = headTargetDistGate();
  for (let idx = 0; idx < list.length; idx++) {
    const opt = sel.options[idx];
    if (!opt) return;
    const pl = list[idx];
    const m = pl.meters;
    const hasM = m != null && Number.isFinite(m);
    const inRange = hasM && m >= distMin && m <= distMax;
    const distPart = hasM ? `${m.toFixed(1)} m` : "no distance";
    if (!hasM) {
      opt.textContent = `P${idx + 1} · id ${pl.trackId} · ${distPart}`;
      opt.removeAttribute("data-oor");
    } else if (inRange) {
      opt.textContent = `P${idx + 1} · id ${pl.trackId} · ${distPart}`;
      opt.removeAttribute("data-oor");
    } else {
      opt.textContent = `P${idx + 1} · id ${pl.trackId} · ${distPart} · OUT OF RANGE`;
      opt.setAttribute("data-oor", "1");
    }
  }
  refreshHeadTargetOorClass();
}

/**
 * @param {Array<{ box: DetBox, trackId: number, meters: number | null, score: number, det: number[] }>} players
 */
function updateHeadTargetPlayerSelect(players) {
  const sel = document.getElementById("head-target-player");
  if (!sel) return;

  const list = players.slice(0, 8);
  const distKey = `${document.getElementById("head-dist-min")?.value}|${document.getElementById("head-dist-max")?.value}`;
  const sig = `${list.length}:${list.map((p) => p.trackId).join(",")}@${distKey}`;
  const mustRebuild =
    pendingHeadTargetSlot != null || sig !== lastHeadTargetRosterSig;

  if (!mustRebuild) {
    updateHeadTargetOptionLabels(list);
    return;
  }

  lastHeadTargetRosterSig = sig;

  let prev = parseInt(sel.value, 10);
  if (!Number.isFinite(prev)) prev = 0;
  if (pendingHeadTargetSlot != null) {
    prev = pendingHeadTargetSlot;
    pendingHeadTargetSlot = null;
  }

  sel.replaceChildren();

  if (list.length === 0) {
    const o = document.createElement("option");
    o.value = "";
    o.textContent = "No players detected";
    o.selected = true;
    sel.appendChild(o);
    sel.classList.remove("head-target-player--oor");
    sel.disabled = true;
    return;
  }

  sel.disabled = false;

  for (let idx = 0; idx < list.length; idx++) {
    const pl = list[idx];
    const o = document.createElement("option");
    o.value = String(idx);
    sel.appendChild(o);
  }

  let pick = Math.min(Math.max(0, prev), list.length - 1);
  sel.value = String(pick);

  updateHeadTargetOptionLabels(list);
}

let throwSaveTimer = 0;

async function hasFp16() {
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return adapter?.features?.has("shader-f16") ?? false;
  } catch {
    return false;
  }
}

const statusEl = document.getElementById("status");
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

const bridgePill = document.getElementById("bridge-pill");
const bridgePillText = document.getElementById("bridge-pill-text");
const bridgeStatusTextEl = document.getElementById("bridge-status-text");
const serialPill = document.getElementById("serial-pill");
const serialPillText = document.getElementById("serial-pill-text");
const serialStatusTextEl = document.getElementById("serial-status-text");
const bridgeLatencyEl = document.getElementById("bridge-latency");
const headerChipHost = document.getElementById("header-chip-host");
const kineticPanel = document.getElementById("kinetic-panel");
const rotorArm = document.getElementById("rotor-arm");
const rotorGhost = document.getElementById("rotor-arm-ghost");
const dwellRingArc = document.getElementById("dwell-ring-arc");
const machineStatusLive = document.getElementById("machine-status-live");
const gaugeBarEl = document.getElementById("gauge-bar");
const armCheckbox = document.getElementById("arm-checkbox");
const btnStop = document.getElementById("btn-stop");
const btnReconnect = document.getElementById("btn-reconnect");
const wsUrlInput = document.getElementById("ws-url");
const btnWsConnect = document.getElementById("btn-ws-connect");
const btnWsDisconnect = document.getElementById("btn-ws-disconnect");
const alertBanner = document.getElementById("alert-banner");
const playersCountEl = document.getElementById("players-count");
const rosterCountEl = document.getElementById("roster-count");
const playerRosterEl = document.getElementById("player-roster");
const mcuStateEl = document.getElementById("mcu-state");
const rpmMeasEl = document.getElementById("rpm-meas");
const rpmTargetEl = document.getElementById("rpm-target");
const gaugeFillEl = document.getElementById("gauge-fill");
const cmdDistEl = document.getElementById("cmd-dist");
const dwellFillEl = document.getElementById("dwell-fill");
const mcuErrEl = document.getElementById("mcu-err");
const rpmBandHintEl = document.getElementById("rpm-band-hint");
const toastHost = document.getElementById("toast-host");
const throwModeAutoEl = document.getElementById("throw-mode-auto");
const throwModeManualEl = document.getElementById("throw-mode-manual");
const throwFixedRpmMinEl = document.getElementById("throw-fixed-rpm-min");
const throwFixedRpmMaxEl = document.getElementById("throw-fixed-rpm-max");
const throwManualFieldsetEl = document.getElementById("throw-manual-fieldset");
const throwBandsWrapEl = document.getElementById("throw-bands-wrap");
const throwAutoHintEl = document.getElementById("throw-auto-hint");
const throwBandCountEl = document.getElementById("throw-band-count");
const btnMcuBandsReset = document.getElementById("btn-mcu-bands-reset");
const throwLiveCmdEl = document.getElementById("throw-live-cmd-m");
const throwLiveMcuEl = document.getElementById("throw-live-mcu-m");
const throwLiveBandEl = document.getElementById("throw-live-band");
const throwLiveRpmEl = document.getElementById("throw-live-rpm");
const throwVizMinEl = document.getElementById("throw-viz-min");
const throwVizMaxEl = document.getElementById("throw-viz-max");
const serialTerminalEl = document.getElementById("serial-terminal");
const activityTerminalEl = document.getElementById("activity-terminal");
const btnTerminalClear = document.getElementById("btn-terminal-clear");
const btnTerminalCopy = document.getElementById("btn-terminal-copy");
const btnManualFire = document.getElementById("btn-manual-fire");
const throwAutoFireEl = document.getElementById("throw-auto-fire");
const throwAutoFireIntervalEl = document.getElementById(
  "throw-auto-fire-interval-s",
);
const motorTestPanelEl = document.getElementById("motor-test-panel");
const motorTestJumpLinkEl = document.getElementById("motor-test-jump-link");
const motorTestEnableEl = document.getElementById("motor-test-enable");
const motorTestSliderEl = document.getElementById("motor-test-slider");
const motorTestPctEl = document.getElementById("motor-test-pct");
const motorTestRpmEl = document.getElementById("motor-test-rpm");
const servoTestFeedBtnEl = document.getElementById("servo-test-feed-btn");
const panTestEnableEl = document.getElementById("pan-test-enable");
const panTestSliderEl = document.getElementById("pan-test-slider");
const panTestPctEl = document.getElementById("pan-test-pct");

const throwTuningIds = [
  ["throw-dwell-ms", "dwell_ms"],
  ["throw-feed-ms", "feed_ms"],
  ["throw-cooldown-ms", "cooldown_ms"],
  ["throw-kp", "kp"],
  ["throw-ki", "ki"],
  ["throw-pwm-max", "pwm_max"],
  ["throw-rpm-tol", "rpm_tol_ratio"],
  ["throw-stall-pwm", "stall_pwm"],
  ["throw-stall-rpm", "stall_rpm"],
];

/* Theme toggle must run before top-level `await` (model load) so the button works immediately. */
initUiTheme();

let lastDepthState = null;
/** @type {[number, number] | null} */
let lastDetSizes = null;

/**
 * @typedef {{ dRef: number, useInverse: boolean, roiDet: { xmin: number, ymin: number, xmax: number, ymax: number } }} Calibration
 * @type {Calibration | null}
 */
let calibration = null;

let calibrationRefRawThisFrame = null;

let draftRoiDet = null;
let isDrawingRoi = false;
/** @type {{ x: number, y: number } | null} */
let roiDragStartDet = null;

/** @type {Array<{ box: DetBox, trackId: number }>} */
let prevTracked = [];
let nextTrackId = 1;

/** @type {Record<number, number>} trackId -> EMA meters */
const distanceEmaByTrack = {};
const EMA_ALPHA = 0.35;

/**
 * @typedef {{ xmin: number, ymin: number, xmax: number, ymax: number, score: number, id: number, cx: number, cy: number }} DetBox
 */

/** @type {number | null} selected slot index 0..n-1 */
let selectedSlotIndex = null;
let noPlayerDisarmTimer = 0;

/** EMA-smoothed pan 0..1 while distance gate passes */
let headPanEma = null;
/** Last pan target sent to bridge (after UI deadband) */
let lastSentPanTarget = null;

/** @type {{ state: string, rpm: number | null, target_rpm: number | null, target_rpm_min: number | null, target_rpm_max: number | null, dist_m: number | null, err: string | null, lastRx: number }} */
let telemetry = {
  state: "IDLE",
  rpm: null,
  target_rpm: null,
  target_rpm_min: null,
  target_rpm_max: null,
  dist_m: null,
  err: null,
  lastRx: 0,
};

let dwellClientMs = 0;
const DWELL_TARGET_MS = 280;

/** Last time auto-fire sent FEED_ONCE (performance.now). */
let lastAutoFeedAtMs = 0;

const ACTIVITY_LOG_MAX = 250;
/** @type {string[]} */
let activityLogLines = [];
/** @type {"serial" | "activity"} */
let terminalSession = "activity";
/** Sync cursor for server `bridge_log` lines (avoid re-appending on each telemetry tick). */
let lastBridgeLogLen = 0;
/** After clearing the activity view, skip replaying existing server bridge lines once. */
let suppressBridgeLogReplay = false;

function escapeHtmlTerminal(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function highlightLogLine(raw) {
  let out = escapeHtmlTerminal(raw);
  out = out.replace(/\b(INFO:)/gi, '<span class="log-token log-token-info">$1</span>');
  out = out.replace(/\b(ERROR:)/gi, '<span class="log-token log-token-err">$1</span>');
  out = out.replace(/\b(WARNING:)/gi, '<span class="log-token log-token-warn">$1</span>');
  out = out.replace(/\b(WARN:)/gi, '<span class="log-token log-token-warn">$1</span>');
  out = out.replace(/\b(200 OK)\b/g, '<span class="log-token log-token-ok">$1</span>');
  out = out.replace(
    /\b(304 Not Modified)\b/gi,
    '<span class="log-token log-token-warn">$1</span>',
  );
  out = out.replace(/(\[accepted\])/gi, '<span class="log-token log-token-ok">$1</span>');
  out = out.replace(
    /\b(connection open|connection closed)\b/gi,
    '<span class="log-token log-token-dim">$1</span>',
  );
  out = out.replace(
    /\b(GET|POST|PUT|PATCH|DELETE)\b/g,
    '<span class="log-token log-token-dim">$1</span>',
  );
  out = out.replace(/\b(WebSocket)\b/gi, '<span class="log-token log-token-dim">$1</span>');
  out = out.replace(
    /^(STATE|RPM|TARGET_RPM|TARGET_RPM_MIN|TARGET_RPM_MAX|DIST_M|ERR)\b/gm,
    '<span class="log-token log-token-mcu">$1</span>',
  );
  out = out.replace(
    /\b(ACK TEST_MODE \d)\b/g,
    '<span class="log-token log-token-mcu">$1</span>',
  );
  out = out.replace(/\b(ACK SERVO_TEST)\b/g, '<span class="log-token log-token-mcu">$1</span>');
  return `<div class="log-line">${out}</div>`;
}

function renderSerialLog(lines) {
  if (!serialTerminalEl) return;
  const arr = Array.isArray(lines) ? lines : [];
  serialTerminalEl.innerHTML = arr.map((l) => highlightLogLine(l)).join("");
  serialTerminalEl.scrollTop = serialTerminalEl.scrollHeight;
}

/**
 * @param {string} message
 * @param {"info" | "warn" | "err"} [level]
 */
function appendActivityLine(message, level = "info") {
  const ts = new Date().toLocaleTimeString(undefined, { hour12: false });
  const tag =
    level === "err" ? "ERROR:" : level === "warn" ? "WARN:" : "INFO:";
  const raw = `[${ts}] ${tag} ${message}`;
  activityLogLines.push(raw);
  if (activityLogLines.length > ACTIVITY_LOG_MAX) {
    activityLogLines = activityLogLines.slice(-ACTIVITY_LOG_MAX);
    if (activityTerminalEl) {
      activityTerminalEl.innerHTML = activityLogLines
        .map((l) => highlightLogLine(l))
        .join("");
      activityTerminalEl.scrollTop = activityTerminalEl.scrollHeight;
    }
    return;
  }
  if (!activityTerminalEl) return;
  activityTerminalEl.insertAdjacentHTML("beforeend", highlightLogLine(raw));
  activityTerminalEl.scrollTop = activityTerminalEl.scrollHeight;
}

/** Full line from bridge (already includes INFO: etc.). */
function appendBridgeServerLine(raw) {
  if (typeof raw !== "string" || !raw.length) return;
  activityLogLines.push(raw);
  if (activityLogLines.length > ACTIVITY_LOG_MAX) {
    activityLogLines = activityLogLines.slice(-ACTIVITY_LOG_MAX);
    if (activityTerminalEl) {
      activityTerminalEl.innerHTML = activityLogLines
        .map((l) => highlightLogLine(l))
        .join("");
      activityTerminalEl.scrollTop = activityTerminalEl.scrollHeight;
    }
    return;
  }
  if (!activityTerminalEl) return;
  activityTerminalEl.insertAdjacentHTML("beforeend", highlightLogLine(raw));
  activityTerminalEl.scrollTop = activityTerminalEl.scrollHeight;
}

function getActiveTerminalStreamEl() {
  return terminalSession === "activity" ? activityTerminalEl : serialTerminalEl;
}

function setTerminalSession(which) {
  terminalSession = which === "activity" ? "activity" : "serial";
  const vSerial = document.getElementById("terminal-view-serial");
  const vAct = document.getElementById("terminal-view-activity");
  const bSerial = document.getElementById("terminal-session-serial");
  const bAct = document.getElementById("terminal-session-activity");
  if (!vSerial || !vAct) return;
  const isAct = terminalSession === "activity";
  vSerial.classList.toggle("vscode-terminal-view--active", !isAct);
  vAct.classList.toggle("vscode-terminal-view--active", isAct);
  bSerial?.classList.toggle("vscode-session--active", !isAct);
  bAct?.classList.toggle("vscode-session--active", isAct);
}

function initTerminalPanelUi() {
  document.querySelectorAll("[data-terminal-target]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const t = btn.getAttribute("data-terminal-target");
      setTerminalSession(t === "activity" ? "activity" : "serial");
    });
  });

  btnTerminalClear?.addEventListener("click", () => {
    if (terminalSession === "activity") {
      activityLogLines = [];
      if (activityTerminalEl) activityTerminalEl.innerHTML = "";
      suppressBridgeLogReplay = true;
    } else if (serialTerminalEl) {
      serialTerminalEl.innerHTML = "";
    }
  });

  btnTerminalCopy?.addEventListener("click", async () => {
    const el = getActiveTerminalStreamEl();
    if (!el) return;
    const text = el.innerText ?? "";
    try {
      await navigator.clipboard.writeText(text);
      showToast("Copied to clipboard");
    } catch {
      showToast("Copy failed", true);
    }
  });

  appendActivityLine(
    "This session shows bridge and UI events. Switch to MCU serial for Arduino lines once the bridge streams serial.",
    "info",
  );
}

const MACHINE_CLASSES = [
  "machine-idle",
  "machine-spinup",
  "machine-feeding",
  "machine-cooldown",
  "machine-fault",
  "machine-test",
];

let armAngleDeg = 0;
let ghostAngleDeg = 0;
let lastArmFrameMs = performance.now();
/** @type {string} */
let lastMcuState = "IDLE";
let lastAnnouncedState = "";

const DWELL_CIRC = 2 * Math.PI * 44;

const bridge = createMachineBridge();

function updateBandRowVisibility() {
  if (!throwBandCountEl) return;
  const n = Math.min(6, Math.max(1, parseInt(throwBandCountEl.value, 10) || 3));
  for (let i = 0; i < 6; i++) {
    const row = document.getElementById(`throw-band-row-${i}`);
    if (row) row.style.display = i < n ? "" : "none";
  }
}

/**
 * @param {number | null} m
 * @param {{ bandCount: number, bands: Array<{ min_m: number, max_m: number, rpm_min: number, rpm_max: number }> }} cfg
 */
function findActiveBandIndex(m, cfg) {
  if (m == null || !Number.isFinite(m)) return -1;
  for (let i = 0; i < cfg.bandCount; i++) {
    const b = cfg.bands[i];
    if (!b) continue;
    if (m >= b.min_m && m < b.max_m) return i;
  }
  return -1;
}

function updateThrowPanelDisabledState() {
  const auto = throwModeAutoEl?.checked ?? true;
  if (throwManualFieldsetEl) {
    throwManualFieldsetEl.disabled = !!auto;
  }
  if (throwBandsWrapEl) {
    throwBandsWrapEl.querySelectorAll("input, select, button").forEach((el) => {
      el.disabled = !auto;
    });
  }
  if (throwAutoHintEl) {
    throwAutoHintEl.style.opacity = auto ? "1" : "0.42";
    throwAutoHintEl.style.pointerEvents = auto ? "auto" : "none";
  }
}

function updateThrowLiveReadout() {
  const cfg = readThrowConfigFromDom();
  const auto = cfg.throwMode === "auto";

  let cmdM = null;
  if (
    lastPlayersSnapshot.length > 0 &&
    selectedSlotIndex != null &&
    selectedSlotIndex < lastPlayersSnapshot.length
  ) {
    const pl = lastPlayersSnapshot[selectedSlotIndex];
    if (pl.meters != null && Number.isFinite(pl.meters)) cmdM = pl.meters;
  }

  document
    .querySelector(".throw-live-row-cmd")
    ?.classList.toggle("hidden", !auto);

  if (throwLiveCmdEl) {
    throwLiveCmdEl.textContent =
      cmdM != null && Number.isFinite(cmdM) ? `${cmdM.toFixed(2)} m` : "—";
  }
  const mcuD = telemetry.dist_m;
  if (throwLiveMcuEl) {
    throwLiveMcuEl.textContent =
      mcuD != null && Number.isFinite(mcuD) ? `${mcuD.toFixed(2)} m` : "—";
  }
  const tr = telemetry.target_rpm;
  const trLo = telemetry.target_rpm_min;
  const trHi = telemetry.target_rpm_max;
  if (throwLiveRpmEl) {
    if (
      trLo != null &&
      trHi != null &&
      Number.isFinite(trLo) &&
      Number.isFinite(trHi)
    ) {
      throwLiveRpmEl.textContent =
        trLo === trHi ? String(trLo) : `${trLo}–${trHi}`;
    } else if (tr != null && Number.isFinite(tr)) {
      throwLiveRpmEl.textContent = String(tr);
    } else {
      throwLiveRpmEl.textContent = "—";
    }
  }

  const distForBand =
    mcuD != null && Number.isFinite(mcuD) ? mcuD : cmdM;
  const bi = auto
    ? findActiveBandIndex(distForBand, cfg)
    : -1;
  if (throwLiveBandEl) {
    if (auto && bi >= 0) {
      const b = cfg.bands[bi];
      throwLiveBandEl.textContent = `Row ${bi + 1}: ${b.min_m.toFixed(2)}–${b.max_m.toFixed(2)} m → ${b.rpm_min}–${b.rpm_max} RPM`;
    } else if (auto) {
      throwLiveBandEl.textContent =
        distForBand != null
          ? "No band (check min/max)"
          : "—";
    } else {
      throwLiveBandEl.textContent = "—";
    }
  }

  for (let i = 0; i < 6; i++) {
    const row = document.getElementById(`throw-band-row-${i}`);
    if (row) {
      row.classList.toggle("band-row--active", auto && i === bi && i < cfg.bandCount);
    }
  }

  const rowBand = document.querySelector(".throw-live-row-band");
  if (rowBand) rowBand.classList.toggle("hidden", !auto);

  const h = document.getElementById("throw-live-heading");
  if (h) {
    h.textContent = auto
      ? "Live — auto (player + bands)"
      : "Live — manual (RPM range + fire)";
  }
}

/**
 * @param {Record<string, unknown>} cfg
 */
function migrateThrowConfig(cfg) {
  if (!cfg || typeof cfg !== "object") return cfg;
  const o = { ...cfg };
  if (o.throwMode == null) {
    o.throwMode = o.rpmMode === "manual" ? "manual" : "auto";
  }
  if (o.fixedRpm == null) o.fixedRpm = o.manualRpm ?? 100;
  if (o.fixedRpmMin == null && o.fixedRpmMax == null && o.fixedRpm != null) {
    o.fixedRpmMin = o.fixedRpm;
    o.fixedRpmMax = o.fixedRpm;
  }
  if (o.fixedRpmMin == null) o.fixedRpmMin = o.fixedRpm ?? 100;
  if (o.fixedRpmMax == null) o.fixedRpmMax = o.fixedRpm ?? 100;
  if (Array.isArray(o.bands)) {
    o.bands = o.bands.map((b) => {
      if (!b || typeof b !== "object") return b;
      const x = { ...b };
      if (
        (x.rpm_min == null || x.rpm_max == null) &&
        x.rpm != null &&
        Number.isFinite(Number(x.rpm))
      ) {
        const r = Number(x.rpm);
        x.rpm_min = r;
        x.rpm_max = r;
      }
      return x;
    });
  }
  const baseH = defaultHeadTracking();
  o.headTracking = normalizeHeadTracking(o.headTracking);
  return o;
}

/**
 * @param {Record<string, unknown>} cfg
 */
function applyThrowConfigToDom(cfg) {
  if (!cfg || typeof cfg !== "object") return;
  const c = migrateThrowConfig(cfg);
  if (throwModeAutoEl && throwModeManualEl) {
    if (c.throwMode === "manual") throwModeManualEl.checked = true;
    else throwModeAutoEl.checked = true;
  }
  if (throwFixedRpmMinEl && c.fixedRpmMin != null) {
    throwFixedRpmMinEl.value = String(c.fixedRpmMin);
  }
  if (throwFixedRpmMaxEl && c.fixedRpmMax != null) {
    throwFixedRpmMaxEl.value = String(c.fixedRpmMax);
  }
  if (throwBandCountEl && c.bandCount != null) {
    throwBandCountEl.value = String(
      Math.min(6, Math.max(1, Number(c.bandCount))),
    );
  }
  const bands = Array.isArray(c.bands) ? c.bands : DEFAULT_THROW_BANDS;
  for (let i = 0; i < 6; i++) {
    const b = bands[i];
    const minEl = document.getElementById(`throw-band-${i}-min`);
    const maxEl = document.getElementById(`throw-band-${i}-max`);
    const rminEl = document.getElementById(`throw-band-${i}-rpm-min`);
    const rmaxEl = document.getElementById(`throw-band-${i}-rpm-max`);
    if (!minEl || !maxEl || !rminEl || !rmaxEl) continue;
    if (b && typeof b === "object") {
      if (b.min_m != null) minEl.value = String(b.min_m);
      if (b.max_m != null) maxEl.value = String(b.max_m);
      if (b.rpm_min != null) rminEl.value = String(b.rpm_min);
      if (b.rpm_max != null) rmaxEl.value = String(b.rpm_max);
    }
  }
  const tun = {
    ...defaultThrowTuning(),
    ...(c.tuning && typeof c.tuning === "object" ? c.tuning : {}),
  };
  for (const [id, key] of throwTuningIds) {
    const el = document.getElementById(id);
    if (el && tun[key] != null) el.value = String(tun[key]);
  }
  if (throwVizMinEl && c.vizDistMin != null) {
    throwVizMinEl.value = String(c.vizDistMin);
  }
  if (throwVizMaxEl && c.vizDistMax != null) {
    throwVizMaxEl.value = String(c.vizDistMax);
  }
  const ht = normalizeHeadTracking(c.headTracking);
  const he = document.getElementById("head-enable");
  if (he) he.value = ht.enabled ? "1" : "0";
  if ("headTracking" in cfg) {
    pendingHeadTargetSlot = Math.min(7, Math.max(0, ht.trackPlayerSlot));
    lastHeadTargetRosterSig = "";
  }
  setHeadSelectNearest("head-dist-min", ht.distMin, [1, 2, 3, 5, 6, 8, 10, 12, 15]);
  setHeadSelectNearest(
    "head-dist-max",
    ht.distMax,
    [15, 20, 30, 40, 60, 80, 100, 120, 200],
  );
  const hor = document.getElementById("head-out-of-range");
  if (hor) {
    hor.value =
      ht.outOfRange === "retract" || ht.outOfRange === "center"
        ? ht.outOfRange
        : "hold_last";
  }
  const hix = document.getElementById("head-invert-x");
  if (hix) hix.value = ht.invertX ? "1" : "0";
  setHeadSelectNearest("head-margin-left", ht.marginLeftPct, [0, 5, 10, 15, 20]);
  setHeadSelectNearest("head-margin-right", ht.marginRightPct, [0, 5, 10, 15, 20]);
  setHeadSelectNearest("head-pos-deadband", ht.posDeadband, [
    0.01, 0.02, 0.03, 0.05, 0.08, 0.12,
  ]);
  setHeadSelectNearest("head-ema-alpha", ht.emaAlpha, [
    0.1, 0.15, 0.25, 0.35, 0.5, 0.65,
  ]);
  setHeadSelectNearest("head-min-send-ms", ht.minSendMs, [
    50, 80, 100, 150, 200, 300, 500,
  ]);
  setHeadSelectNearest("head-mcu-pwm-max", ht.mcuPwmMax, [80, 100, 120, 160, 200]);
  setHeadSelectNearest("head-mcu-slew", ht.mcuSlew, [4, 6, 8, 12, 16, 24]);
  setHeadSelectNearest("head-mcu-pos-db", ht.mcuPosDeadband, [
    0.02, 0.03, 0.04, 0.06, 0.08,
  ]);
  setHeadSelectNearest("head-mcu-timeout-ms", ht.mcuTimeoutMs, [
    2000, 4000, 6000, 8000, 12000, 20000,
  ]);
  setHeadSelectNearest("head-mcu-stroke-s", ht.mcuStrokeS, [
    10, 12, 15, 18, 22, 28, 35,
  ]);
  const hhc = document.getElementById("head-home-on-connect");
  if (hhc) hhc.value = ht.homeOnConnect ? "1" : "0";
  updateBandRowVisibility();
  updateThrowPanelDisabledState();
}

function readThrowConfigFromDom() {
  const throwMode = throwModeManualEl?.checked ? "manual" : "auto";
  const bandCount = Math.min(
    6,
    Math.max(1, parseInt(throwBandCountEl?.value ?? "3", 10) || 3),
  );
  /** @type {Array<{ min_m: number, max_m: number, rpm_min: number, rpm_max: number }>} */
  const bands = [];
  for (let i = 0; i < 6; i++) {
    const minEl = document.getElementById(`throw-band-${i}-min`);
    const maxEl = document.getElementById(`throw-band-${i}-max`);
    const rminEl = document.getElementById(`throw-band-${i}-rpm-min`);
    const rmaxEl = document.getElementById(`throw-band-${i}-rpm-max`);
    if (!minEl || !maxEl || !rminEl || !rmaxEl) continue;
    const min_m = parseFloat(minEl.value);
    const max_m = parseFloat(maxEl.value);
    const rpm_min = parseInt(rminEl.value, 10);
    const rpm_max = parseInt(rmaxEl.value, 10);
    bands.push({
      min_m: Number.isFinite(min_m) ? min_m : 0,
      max_m: Number.isFinite(max_m) ? max_m : 0,
      rpm_min: Number.isFinite(rpm_min) ? rpm_min : 0,
      rpm_max: Number.isFinite(rpm_max) ? rpm_max : 0,
    });
  }
  /** @type {Record<string, number>} */
  const tuning = {};
  for (const [id, key] of throwTuningIds) {
    const el = document.getElementById(id);
    if (!el) continue;
    const v = parseFloat(el.value);
    if (Number.isFinite(v)) tuning[key] = v;
  }
  let fixedRpmMin = Math.max(
    0,
    Math.min(500, parseInt(throwFixedRpmMinEl?.value ?? "100", 10) || 0),
  );
  let fixedRpmMax = Math.max(
    0,
    Math.min(500, parseInt(throwFixedRpmMaxEl?.value ?? "100", 10) || 0),
  );
  if (fixedRpmMin > fixedRpmMax) {
    const t = fixedRpmMin;
    fixedRpmMin = fixedRpmMax;
    fixedRpmMax = t;
  }
  const horEl = document.getElementById("head-out-of-range");
  const orRaw = horEl?.value ?? "hold_last";
  const outOfRange =
    orRaw === "retract" || orRaw === "center" ? orRaw : "hold_last";

  const hev = document.getElementById("head-enable")?.value ?? "0";
  const htpRaw = document.getElementById("head-target-player")?.value ?? "";
  let trackPlayerSlot = 0;
  if (htpRaw !== "") {
    const p = parseInt(htpRaw, 10);
    if (Number.isFinite(p) && p >= 0) trackPlayerSlot = Math.min(7, p);
  }
  const headTracking = normalizeHeadTracking({
    enabled: hev === "1",
    trackPlayerSlot,
    distMin: parseFloat(document.getElementById("head-dist-min")?.value ?? "5"),
    distMax: parseFloat(document.getElementById("head-dist-max")?.value ?? "80"),
    outOfRange,
    invertX: (document.getElementById("head-invert-x")?.value ?? "0") === "1",
    marginLeftPct: parseFloat(
      document.getElementById("head-margin-left")?.value ?? "5",
    ),
    marginRightPct: parseFloat(
      document.getElementById("head-margin-right")?.value ?? "5",
    ),
    posDeadband: parseFloat(
      document.getElementById("head-pos-deadband")?.value ?? "0.02",
    ),
    emaAlpha: parseFloat(
      document.getElementById("head-ema-alpha")?.value ?? "0.25",
    ),
    minSendMs: parseFloat(
      document.getElementById("head-min-send-ms")?.value ?? "100",
    ),
    mcuPwmMax: parseFloat(
      document.getElementById("head-mcu-pwm-max")?.value ?? "120",
    ),
    mcuSlew: parseFloat(document.getElementById("head-mcu-slew")?.value ?? "8"),
    mcuPosDeadband: parseFloat(
      document.getElementById("head-mcu-pos-db")?.value ?? "0.04",
    ),
    mcuTimeoutMs: parseFloat(
      document.getElementById("head-mcu-timeout-ms")?.value ?? "4000",
    ),
    mcuStrokeS: parseFloat(
      document.getElementById("head-mcu-stroke-s")?.value ?? "18",
    ),
    homeOnConnect:
      (document.getElementById("head-home-on-connect")?.value ?? "0") === "1",
  });

  return {
    throwMode,
    fixedRpmMin,
    fixedRpmMax,
    bandCount,
    bands,
    tuning,
    vizDistMin: parseFloat(throwVizMinEl?.value ?? "0.5") || 0.5,
    vizDistMax: parseFloat(throwVizMaxEl?.value ?? "12") || 12,
    headTracking,
  };
}

/**
 * @param {number} rm
 * @param {number} tolRatio
 */
function isMeasuredRpmInTargetWindow(rm, tolRatio) {
  const tmin = telemetry.target_rpm_min;
  const tmax = telemetry.target_rpm_max;
  const tr = telemetry.target_rpm;
  if (rm == null || !Number.isFinite(rm)) return false;
  if (
    tmin != null &&
    tmax != null &&
    Number.isFinite(tmin) &&
    Number.isFinite(tmax)
  ) {
    if (tmin === tmax) {
      const tol = Math.max(2, Math.abs(tmin) * tolRatio);
      return Math.abs(rm - tmin) <= tol;
    }
    return rm >= tmin && rm <= tmax;
  }
  if (tr != null && tr > 0) {
    return Math.abs(rm - tr) / tr <= tolRatio;
  }
  return false;
}

function saveThrowConfigToStorage() {
  try {
    const cfg = readThrowConfigFromDom();
    localStorage.setItem(THROW_CONFIG_KEY, JSON.stringify(cfg));
  } catch {
    /* ignore */
  }
}

function scheduleSaveThrowConfig() {
  if (throwSaveTimer) clearTimeout(throwSaveTimer);
  throwSaveTimer = window.setTimeout(() => {
    throwSaveTimer = 0;
    saveThrowConfigToStorage();
  }, 400);
}

function loadThrowConfigFromStorage() {
  try {
    let raw = localStorage.getItem(THROW_CONFIG_KEY);
    if (!raw) raw = localStorage.getItem(THROW_CONFIG_KEY_LEGACY);
    if (!raw) return null;
    return migrateThrowConfig(JSON.parse(raw));
  } catch {
    return null;
  }
}

function onThrowSettingsChanged() {
  refreshHeadTargetOorClass();
  scheduleSaveThrowConfig();
  pushBridgeControl(lastPlayersSnapshot);
}

/**
 * @param {number | null} rawPan
 * @param {boolean} gateOk
 * @param {number | null} sentPan
 * @param {boolean} panActive
 */
function updateHeadTrackingLiveLabels(
  rawPan,
  gateOk,
  sentPan,
  panActive,
  panTestOn = false,
) {
  const rawEl = document.getElementById("head-live-raw");
  const gateEl = document.getElementById("head-live-gate");
  const sentEl = document.getElementById("head-live-sent");
  if (rawEl) {
    rawEl.textContent =
      rawPan != null && Number.isFinite(rawPan) ? rawPan.toFixed(3) : "—";
  }
  if (gateEl) {
    if (!panActive) gateEl.textContent = "off";
    else if (panTestOn) gateEl.textContent = "test";
    else gateEl.textContent = gateOk ? "ok" : "blocked";
  }
  if (sentEl) {
    sentEl.textContent =
      sentPan != null && Number.isFinite(sentPan) ? sentPan.toFixed(3) : "—";
  }
}

/**
 * @param {Array<{ box: { cx: number }, trackId: number, meters: number | null, score: number, det: number[] }>} players
 * @param {ReturnType<typeof normalizeHeadTracking>} ht
 * @param {boolean} motorTestOn
 * @param {boolean} panTestOn
 */
function computeHeadPanForBridge(players, ht, motorTestOn, panTestOn) {
  const plist = Array.isArray(players) ? players : [];
  /** @type {Record<string, number>} */
  const pan_tuning = {
    pan_pwm_max: ht.mcuPwmMax,
    pan_slew: ht.mcuSlew,
    pan_db: ht.mcuPosDeadband,
    pan_timeout_ms: ht.mcuTimeoutMs,
    pan_stroke_s: ht.mcuStrokeS,
  };

  if (motorTestOn) {
    return {
      panEnable: false,
      panTarget: null,
      pan_tuning,
      rawPan: null,
      gateOk: false,
      sentForDisplay: null,
      panTestOn: false,
    };
  }

  if (panTestOn) {
    const v = Math.min(
      1,
      Math.max(0, (parseFloat(panTestSliderEl?.value ?? "0") || 0) / 100),
    );
    return {
      panEnable: true,
      panTarget: v,
      pan_tuning,
      rawPan: v,
      gateOk: true,
      sentForDisplay: v,
      panTestOn: true,
    };
  }

  if (!ht.enabled) {
    headPanEma = null;
    lastSentPanTarget = null;
    return {
      panEnable: false,
      panTarget: null,
      pan_tuning,
      rawPan: null,
      gateOk: false,
      sentForDisplay: null,
      panTestOn: false,
    };
  }

  const slot = ht.trackPlayerSlot;
  if (plist.length === 0 || slot < 0 || slot >= plist.length) {
    headPanEma = null;
    lastSentPanTarget = null;
    return {
      panEnable: false,
      panTarget: null,
      pan_tuning,
      rawPan: null,
      gateOk: false,
      sentForDisplay: null,
      panTestOn: false,
    };
  }

  const pl = plist[slot];
  const wDet = lastDetSizes?.[0] ?? 640;
  const ml = ht.marginLeftPct / 100;
  const mr = ht.marginRightPct / 100;
  let span = 1 - ml - mr;
  if (span < 0.05) span = 0.05;
  let t = (pl.box.cx / wDet - ml) / span;
  t = Math.min(1, Math.max(0, t));
  if (ht.invertX) t = 1 - t;
  const rawPan = t;

  const m = pl.meters;
  const gateOk =
    m != null && Number.isFinite(m) && m >= ht.distMin && m <= ht.distMax;

  let cmd;
  if (gateOk) {
    headPanEma =
      headPanEma == null
        ? t
        : ht.emaAlpha * t + (1 - ht.emaAlpha) * headPanEma;
    cmd = headPanEma;
  } else if (ht.outOfRange === "hold_last") {
    cmd = headPanEma ?? 0.5;
  } else if (ht.outOfRange === "retract") {
    cmd = 0;
  } else {
    cmd = 0.5;
  }

  let sendPan = cmd;
  if (
    lastSentPanTarget != null &&
    Math.abs(cmd - lastSentPanTarget) < ht.posDeadband
  ) {
    sendPan = lastSentPanTarget;
  } else {
    lastSentPanTarget = cmd;
  }

  return {
    panEnable: true,
    panTarget: sendPan,
    pan_tuning,
    rawPan,
    gateOk,
    sentForDisplay: sendPan,
    panTestOn: false,
  };
}

function initThrowTuningUi() {
  const saved = loadThrowConfigFromStorage();
  applyThrowConfigToDom({
    throwMode: "auto",
    fixedRpmMin: 100,
    fixedRpmMax: 100,
    bandCount: 3,
    bands: DEFAULT_THROW_BANDS,
    tuning: defaultThrowTuning(),
    vizDistMin: 0.5,
    vizDistMax: 12,
    ...(saved && typeof saved === "object" ? saved : {}),
  });

  const onCh = () => onThrowSettingsChanged();
  [throwBandCountEl, throwVizMinEl, throwVizMaxEl, throwFixedRpmMinEl, throwFixedRpmMaxEl].forEach(
    (el) => el?.addEventListener("input", onCh),
  );
  [throwModeAutoEl, throwModeManualEl].forEach((el) =>
    el?.addEventListener("change", () => {
      updateThrowPanelDisabledState();
      lastAutoFeedAtMs = 0;
      onCh();
    }),
  );

  for (let i = 0; i < 6; i++) {
    for (const suf of ["min", "max", "rpm-min", "rpm-max"]) {
      document.getElementById(`throw-band-${i}-${suf}`)?.addEventListener("input", onCh);
    }
  }
  for (const [id] of throwTuningIds) {
    document.getElementById(id)?.addEventListener("input", onCh);
  }

  throwBandCountEl?.addEventListener("change", () => {
    updateBandRowVisibility();
    onCh();
  });

  btnMcuBandsReset?.addEventListener("click", () => {
    bridge.sendBandsReset();
    applyThrowConfigToDom({
      bands: DEFAULT_THROW_BANDS,
      bandCount: 3,
    });
    if (throwBandCountEl) throwBandCountEl.value = "3";
    saveThrowConfigToStorage();
    showHeaderChip("MCU bands reset to firmware defaults.", {
      variant: "ok",
      ttl: 6000,
    });
    onThrowSettingsChanged();
  });

  updateBandRowVisibility();
  updateThrowPanelDisabledState();
  updateThrowLiveReadout();
  updateHeadTargetPlayerSelect(lastPlayersSnapshot);

  btnManualFire?.addEventListener("click", () => {
    bridge.sendFeedOnce();
    appendActivityLine("Sent FEED_ONCE (manual fire).", "info");
  });
  servoTestFeedBtnEl?.addEventListener("click", () => {
    bridge.sendServoTest();
    appendActivityLine("Sent SERVO_TEST (0°→180°→0°).", "info");
  });
  throwAutoFireEl?.addEventListener("change", () => {
    lastAutoFeedAtMs = 0;
  });
  throwAutoFireIntervalEl?.addEventListener("input", () => {
    lastAutoFeedAtMs = 0;
  });

  if (motorTestPctEl && motorTestSliderEl) {
    motorTestPctEl.textContent = `${motorTestSliderEl.value}%`;
  }
  if (panTestPctEl && panTestSliderEl) {
    panTestPctEl.textContent = `${panTestSliderEl.value}%`;
  }
  motorTestEnableEl?.addEventListener("change", () => {
    if (motorTestEnableEl?.checked && panTestEnableEl) panTestEnableEl.checked = false;
    syncMotorTestUi();
    pushBridgeControl(lastPlayersSnapshot);
  });
  motorTestJumpLinkEl?.addEventListener("click", (e) => {
    e.preventDefault();
    motorTestPanelEl?.scrollIntoView({ behavior: "smooth", block: "start" });
    motorTestPanelEl?.focus({ preventScroll: true });
  });

  motorTestSliderEl?.addEventListener("input", () => {
    if (motorTestPctEl) motorTestPctEl.textContent = `${motorTestSliderEl.value}%`;
    if (motorTestEnableEl?.checked && bridge.isConnected()) {
      const cfg = readThrowConfigFromDom();
      const panT = computeHeadPanForBridge(
        lastPlayersSnapshot,
        cfg.headTracking,
        true,
        false,
      );
      bridge.setControl({
        target_m: null,
        armed: false,
        selected_player_id: null,
        rpm_mode: "auto",
        target_rpm_manual: null,
        bands: null,
        tuning:
          Object.keys(cfg.tuning).length > 0 ? cfg.tuning : undefined,
        auto_feed_dwell: false,
        test_mode: true,
        test_pwm: parseFloat(motorTestSliderEl.value) || 0,
        pan_enable: false,
        pan_target: null,
        pan_tuning: panT.pan_tuning,
      });
      bridge.flush();
    }
  });
  panTestEnableEl?.addEventListener("change", () => {
    if (panTestEnableEl?.checked && motorTestEnableEl) motorTestEnableEl.checked = false;
    syncMotorTestUi();
    pushBridgeControl(lastPlayersSnapshot, { panForceSerial: true });
  });
  panTestSliderEl?.addEventListener("input", () => {
    if (panTestPctEl) panTestPctEl.textContent = `${panTestSliderEl.value}%`;
    if (panTestEnableEl?.checked && bridge.isConnected()) {
      pushBridgeControl(lastPlayersSnapshot);
    }
  });
  syncMotorTestUi();

  const headFieldIds = [
    "head-enable",
    "head-target-player",
    "head-dist-min",
    "head-dist-max",
    "head-out-of-range",
    "head-invert-x",
    "head-margin-left",
    "head-margin-right",
    "head-pos-deadband",
    "head-ema-alpha",
    "head-min-send-ms",
    "head-mcu-pwm-max",
    "head-mcu-slew",
    "head-mcu-pos-db",
    "head-mcu-timeout-ms",
    "head-mcu-stroke-s",
    "head-home-on-connect",
  ];
  for (const id of headFieldIds) {
    document.getElementById(id)?.addEventListener("change", onCh);
  }

  document.getElementById("btn-pan-home")?.addEventListener("click", () => {
    bridge.sendPanHome();
    appendActivityLine("Sent PAN_HOME (MCU retract / homing).", "info");
  });

  bridge.setThrottleMs(readThrowConfigFromDom().headTracking.minSendMs);
}

function setMachineVisualState(stateRaw) {
  const st = String(stateRaw || "IDLE").toLowerCase();
  const map = {
    idle: "machine-idle",
    spinup: "machine-spinup",
    feeding: "machine-feeding",
    cooldown: "machine-cooldown",
    fault: "machine-fault",
    holding: "machine-spinup",
    test: "machine-test",
  };
  const cls = map[st] || "machine-idle";
  MACHINE_CLASSES.forEach((c) => {
    document.body.classList.remove(c);
    kineticPanel?.classList.remove(c);
  });
  document.body.classList.add(cls);
  kineticPanel?.classList.add(cls);
}

function announceMachineState(text) {
  if (machineStatusLive) machineStatusLive.textContent = text;
}

function setBridgeOrbVisual(kind) {
  bridgePill.classList.remove(
    "status-orb-offline",
    "status-orb-connecting",
    "status-orb-online",
  );
  bridgePill.classList.add(`status-orb-${kind}`);
}

function setSerialOrbVisual(online) {
  serialPill.classList.toggle("status-orb-muted", !online);
  serialPill.classList.toggle("status-orb-online", !!online);
  serialPill.classList.toggle("status-orb-serial", !!online);
}

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
  const slot = container.parentElement;
  const availW = slot?.clientWidth ?? 720;
  const maxW = Math.min(720, Math.max(200, availW - 6));
  let cw = maxW;
  let ch = cw / ar;
  const maxH = 480;
  if (ch > maxH) {
    ch = maxH;
    cw = ch * ar;
  }
  const rw = Math.round(cw);
  const rh = Math.round(ch);
  container.style.width = `${rw}px`;
  container.style.height = `${rh}px`;
  depthContainer.style.width = `${rw}px`;
  depthContainer.style.height = `${rh}px`;
}

const HEADER_CHIP_MAX = 5;

/**
 * Critical / important feedback in the title bar only (dismissible chips).
 * @param {string} message
 * @param {{ variant?: "error" | "warn" | "info" | "ok", ttl?: number }} [opts]
 */
function showHeaderChip(message, opts = {}) {
  const variant = opts.variant ?? "warn";
  const ttl = opts.ttl ?? 9000;
  if (!headerChipHost || !message) return;

  const chip = document.createElement("div");
  chip.className = `header-chip header-chip--${variant}`;
  chip.setAttribute("role", "status");

  const text = document.createElement("span");
  text.className = "header-chip-text";
  text.textContent = message;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "header-chip-dismiss";
  btn.setAttribute("aria-label", "Dismiss");
  btn.textContent = "\u00d7";
  btn.addEventListener("click", () => chip.remove());

  chip.appendChild(text);
  chip.appendChild(btn);

  while (headerChipHost.children.length >= HEADER_CHIP_MAX) {
    headerChipHost.firstChild?.remove();
  }
  headerChipHost.appendChild(chip);

  if (ttl > 0) {
    window.setTimeout(() => {
      if (chip.parentNode === headerChipHost) chip.remove();
    }, ttl);
  }
}

function showToast(message, isError = false) {
  if (isError) {
    showHeaderChip(message, { variant: "error", ttl: 8000 });
    return;
  }
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = message;
  toastHost.appendChild(t);
  setTimeout(() => t.remove(), 4500);
}

function setAlertBanner(text) {
  alertBanner.classList.add("hidden");
  alertBanner.textContent = "";
  if (!text) return;
  showHeaderChip(text, { variant: "warn", ttl: 14000 });
}

function shortBridgeStatusLabel(full) {
  const s = String(full || "");
  if (/connecting/i.test(s)) return "Connecting";
  if (/online/i.test(s)) return "Online";
  if (/offline/i.test(s)) return "Offline";
  if (/error/i.test(s)) return "Error";
  return s.replace(/^bridge\s*/i, "").trim() || "\u2014";
}

function shortSerialStatusLabel(sText) {
  const s = String(sText || "");
  if (/closed/i.test(s)) return "Closed";
  if (/open/i.test(s)) {
    const m = s.match(/(COM\d+|\/dev\/[^\s,]+)/i);
    return m ? m[1] : "Open";
  }
  return "\u2014";
}

function initUiTheme() {
  /** @param {"workbench" | "pitch"} id */
  function apply(id) {
    const pitch = id === "pitch";
    document.body.classList.toggle("theme-pitch", pitch);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, id);
    } catch {
      /* ignore */
    }
    const btn = document.getElementById("btn-theme");
    if (btn) {
      btn.title = pitch
        ? "Switch to workbench (classic gray) theme"
        : "Switch to pitch (stadium green) theme";
      btn.setAttribute(
        "aria-label",
        pitch ? "Switch to workbench theme" : "Switch to pitch theme",
      );
    }
  }
  let saved = "pitch";
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    if (v === "pitch" || v === "workbench") saved = v;
  } catch {
    /* ignore */
  }
  apply(saved);
  document.getElementById("btn-theme")?.addEventListener("click", () => {
    apply(document.body.classList.contains("theme-pitch") ? "workbench" : "pitch");
  });
}

function initRightPanelTabs() {
  const tabBtns = document.querySelectorAll("[data-right-tab]");
  /** @type {Record<string, HTMLElement | null>} */
  const panes = {
    bridge: document.getElementById("right-tab-pane-bridge"),
    calibration: document.getElementById("right-tab-pane-calibration"),
    motor: document.getElementById("right-tab-pane-motor"),
  };
  tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.getAttribute("data-right-tab");
      if (!key || !(key in panes)) return;
      tabBtns.forEach((b) => {
        const on = b === btn;
        b.classList.toggle("panel-local-tab--active", on);
        b.setAttribute("aria-selected", String(on));
      });
      Object.entries(panes).forEach(([k, el]) => {
        if (!el) return;
        const on = k === key;
        el.toggleAttribute("hidden", !on);
        el.classList.toggle("right-tab-pane--active", on);
      });
    });
  });
}

function iou(a, b) {
  const x1 = Math.max(a.xmin, b.xmin);
  const y1 = Math.max(a.ymin, b.ymin);
  const x2 = Math.min(a.xmax, b.xmax);
  const y2 = Math.min(a.ymax, b.ymax);
  const iw = Math.max(0, x2 - x1);
  const ih = Math.max(0, y2 - y1);
  const inter = iw * ih;
  const areaA = Math.max(0, a.xmax - a.xmin) * Math.max(0, a.ymax - a.ymin);
  const areaB = Math.max(0, b.xmax - b.xmin) * Math.max(0, b.ymax - b.ymin);
  const u = areaA + areaB - inter;
  return u > 0 ? inter / u : 0;
}

/**
 * @param {DetBox[]} sortedDets
 * @param {Array<{ box: DetBox, trackId: number }>} prev
 */
function matchTracks(sortedDets, prev) {
  const used = new Set();
  /** @type {Array<{ box: DetBox, trackId: number }>} */
  const out = [];
  for (const det of sortedDets) {
    let best = -1;
    let bestIou = 0.28;
    for (let i = 0; i < prev.length; i++) {
      if (used.has(i)) continue;
      const v = iou(det, prev[i].box);
      if (v > bestIou) {
        bestIou = v;
        best = i;
      }
    }
    let trackId;
    if (best >= 0) {
      trackId = prev[best].trackId;
      used.add(best);
    } else {
      trackId = nextTrackId++;
    }
    out.push({ box: det, trackId });
  }
  return out;
}

statusEl.textContent = "Loading detection model...";

const detModelId = "Xenova/gelan-c_all";
const detModel = await AutoModel.from_pretrained(detModelId);
const detProcessor = await AutoProcessor.from_pretrained(detModelId);

statusEl.textContent = "Loading depth model...";

const depthModelId = "onnx-community/depth-anything-v2-small";
let depthModel;
try {
  depthModel = await AutoModel.from_pretrained(depthModelId, {
    device: "webgpu",
    dtype: (await hasFp16()) ? "fp16" : "fp32",
  });
} catch (err) {
  statusEl.textContent = `WebGPU depth load failed, trying default: ${err.message}`;
  depthModel = await AutoModel.from_pretrained(depthModelId);
}

const depthProcessor = await AutoImageProcessor.from_pretrained(depthModelId);

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

function loadPresets() {
  try {
    const raw = localStorage.getItem(PRESET_KEY);
    if (!raw) return;
    const p = JSON.parse(raw);
    if (p.threshold != null) {
      threshold = p.threshold;
      thresholdSlider.value = String(threshold);
      thresholdLabel.textContent = threshold.toFixed(2);
    }
  } catch {
    /* ignore */
  }
}

function savePreset(name) {
  const data = { threshold, name, savedAt: Date.now() };
  localStorage.setItem(PRESET_KEY, JSON.stringify(data));
  showToast(`Saved preset: ${name}`);
}

document.querySelectorAll("[data-preset]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const id = btn.getAttribute("data-preset");
    if (id === "indoor") {
      threshold = 0.32;
    } else if (id === "outdoor") {
      threshold = 0.2;
    }
    thresholdSlider.value = String(threshold);
    thresholdLabel.textContent = threshold.toFixed(2);
    savePreset(id);
  });
});

loadPresets();

statusEl.textContent = "Ready";

function isPersonClass(id) {
  const label = detModel.config.id2label?.[id];
  if (label && String(label).toLowerCase() === "person") return true;
  return id === 0;
}

function sampleDepthAt(data, ow, oh, cx, cy, wDet, hDet, min, max) {
  const ix = Math.min(ow - 1, Math.max(0, Math.round((cx / wDet) * (ow - 1))));
  const iy = Math.min(oh - 1, Math.max(0, Math.round((cy / hDet) * (oh - 1))));
  const raw = data[iy * ow + ix];
  const range = max - min;
  const rel = range > 0 ? (raw - min) / range : 0.5;
  return { raw, rel };
}

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
    pointerDownRoi({
      clientX: t.clientX,
      clientY: t.clientY,
      preventDefault: () => {},
    });
  },
  { passive: false },
);

window.addEventListener(
  "touchmove",
  (ev) => {
    if (!isDrawingRoi || !lastDetSizes) return;
    ev.preventDefault();
    const t = ev.changedTouches[0];
    pointerMoveRoi({
      clientX: t.clientX,
      clientY: t.clientY,
      preventDefault: () => {},
    });
  },
  { passive: false },
);

window.addEventListener("touchend", (ev) => {
  if (!isDrawingRoi) return;
  pointerUpRoi(ev);
});

calibrationApplyBtn.addEventListener("click", () => {
  if (!lastDepthState || !lastDetSizes || !draftRoiDet) {
    statusEl.textContent =
      "No depth frame or region — wait for video, then draw a region.";
    return;
  }
  const dRef = Number(calibrationDistanceInput.value);
  if (!Number.isFinite(dRef) || dRef <= 0) {
    statusEl.textContent = "Enter a positive real distance in meters.";
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
    statusEl.textContent =
      "Could not sample depth in that region — try a larger area.";
    return;
  }
  if (Math.abs(mean) < 1e-12) {
    statusEl.textContent =
      "Depth value too small to calibrate — try another region.";
    return;
  }

  calibration = {
    dRef,
    useInverse: calibrationInvertCheckbox.checked,
    roiDet: { xmin, ymin, xmax, ymax },
  };
  draftRoiDet = null;
  refreshCalibrationLayer();
  calibrationInvertCheckbox.checked = calibration.useInverse;
  updateCalibrationUiState();
  statusEl.textContent = `Calibrated: ${dRef} m — reference region re-sampled each frame`;
});

calibrationClearBtn.addEventListener("click", () => {
  calibration = null;
  draftRoiDet = null;
  refreshCalibrationLayer();
  updateCalibrationUiState();
  statusEl.textContent = "Calibration cleared";
});

updateCalibrationUiState();

/**
 * @typedef {{ det: number[], wDet: number, hDet: number, depthState: object, playerSlot: number, trackId: number, color: string, meters: number | null, selected: boolean }} RenderPlayer
 */
/**
 * @param {RenderPlayer} p
 */
function renderPlayerBox(p) {
  const [xmin, ymin, xmax, ymax, score, id] = p.det;
  const { data, ow, oh, min, max } = p.depthState;
  const { wDet, hDet } = p;
  const cx = (xmin + xmax) / 2;
  const cy = (ymin + ymax) / 2;
  const { raw, rel } = sampleDepthAt(data, ow, oh, cx, cy, wDet, hDet, min, max);

  const boxElement = document.createElement("div");
  boxElement.className = "bounding-box";
  Object.assign(boxElement.style, {
    borderColor: p.color,
    left: (100 * xmin) / wDet + "%",
    top: (100 * ymin) / hDet + "%",
    width: (100 * (xmax - xmin)) / wDet + "%",
    height: (100 * (ymax - ymin)) / hDet + "%",
    boxShadow: p.selected ? `0 0 0 2px ${p.color}` : undefined,
  });

  const badge = document.createElement("span");
  badge.className = "bounding-box-badge";
  badge.textContent = `P${p.playerSlot}`;
  badge.style.background = p.color;

  const dot = document.createElement("span");
  dot.className = "bounding-box-center-dot";
  dot.style.boxShadow = `0 0 0 2px ${p.color}`;
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

  boxElement.appendChild(badge);
  boxElement.appendChild(dot);
  boxElement.appendChild(depthLabel);
  overlay.appendChild(boxElement);
}

/**
 * @param {Array<{ box: DetBox, trackId: number, meters: number | null, score: number, det: number[] }>} players
 */
function updateRoster(players) {
  playersCountEl.textContent = String(players.length);
  if (rosterCountEl) rosterCountEl.textContent = `(${players.length})`;

  if (players.length === 0) {
    selectedSlotIndex = null;
    playerRosterEl.innerHTML =
      '<p class="player-deck-empty">No targets</p>';
    updateHeadTargetPlayerSelect(players);
    return;
  }

  if (
    selectedSlotIndex === null ||
    selectedSlotIndex >= players.length
  ) {
    selectedSlotIndex = 0;
  }

  playerRosterEl.replaceChildren();
  const tc = readThrowConfigFromDom();
  let distMin = tc.vizDistMin;
  let distMax = tc.vizDistMax;
  if (!(distMax > distMin) || !Number.isFinite(distMin) || !Number.isFinite(distMax)) {
    distMin = 0.5;
    distMax = 12;
  }

  players.forEach((pl, idx) => {
    const slot = idx + 1;
    const color =
      PLAYER_PALETTE[pl.trackId % PLAYER_PALETTE.length];
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `player-token${idx === selectedSlotIndex ? " selected" : ""}`;
    btn.dataset.slot = String(idx);
    btn.style.color = color;
    const label =
      pl.meters != null && Number.isFinite(pl.meters)
        ? `Player ${slot}, ${pl.meters.toFixed(1)} meters`
        : `Player ${slot}, calibrate for distance`;
    btn.setAttribute("aria-label", label);
    btn.title = label;

    const ring = document.createElement("span");
    ring.className = "player-token-ring";
    ring.setAttribute("aria-hidden", "true");

    const sil = document.createElement("span");
    sil.className = "player-token-silhouette";
    sil.setAttribute("aria-hidden", "true");

    const num = document.createElement("span");
    num.className = "player-token-num";
    num.textContent = `P${slot}`;

    const distWrap = document.createElement("div");
    distWrap.className = "player-token-dist";
    const distFill = document.createElement("div");
    distFill.className = "player-token-dist-fill";
    if (pl.meters != null && Number.isFinite(pl.meters)) {
      const t = Math.min(
        1,
        Math.max(0, (pl.meters - distMin) / (distMax - distMin)),
      );
      distFill.style.width = `${(t * 100).toFixed(0)}%`;
      distFill.style.background = color;
    }
    distWrap.appendChild(distFill);

    btn.appendChild(ring);
    btn.appendChild(sil);
    btn.appendChild(num);
    btn.appendChild(distWrap);

    btn.addEventListener("click", () => {
      selectedSlotIndex = idx;
      updateRoster(players);
    });

    playerRosterEl.appendChild(btn);
  });

  updateHeadTargetPlayerSelect(players);
}

function updateMachinePanel() {
  const st = telemetry.state || "IDLE";
  const stLower = st.toLowerCase();

  setMachineVisualState(stLower);
  mcuStateEl.textContent = st;
  mcuStateEl.className = "state-pill state-" + stLower;

  if (lastAnnouncedState !== st) {
    if (stLower === "fault") {
      showHeaderChip("Machine fault — check MCU and serial.", {
        variant: "error",
        ttl: 15000,
      });
    }
    lastAnnouncedState = st;
    const msg =
      stLower === "fault"
        ? `Fault: machine state ${st}`
        : `Machine state ${st}`;
    announceMachineState(msg);
  }

  rpmMeasEl.textContent =
    telemetry.rpm != null && Number.isFinite(telemetry.rpm)
      ? telemetry.rpm.toFixed(0)
      : "—";
  {
    const tr = telemetry.target_rpm;
    const tlo = telemetry.target_rpm_min;
    const thi = telemetry.target_rpm_max;
    if (
      tlo != null &&
      thi != null &&
      Number.isFinite(tlo) &&
      Number.isFinite(thi)
    ) {
      rpmTargetEl.textContent = tlo === thi ? String(tlo) : `${tlo}–${thi}`;
    } else if (tr != null) {
      rpmTargetEl.textContent = String(tr);
    } else {
      rpmTargetEl.textContent = "—";
    }
  }

  cmdDistEl.textContent =
    telemetry.dist_m != null && Number.isFinite(telemetry.dist_m)
      ? telemetry.dist_m.toFixed(2)
      : "—";

  const tr = telemetry.target_rpm;
  const tlo = telemetry.target_rpm_min;
  const thi = telemetry.target_rpm_max;
  const rm = telemetry.rpm;
  let pct = 0;
  let gaugeClass = "";
  const mid =
    tlo != null &&
    thi != null &&
    Number.isFinite(tlo) &&
    Number.isFinite(thi)
      ? (tlo + thi) / 2
      : tr;
  if (mid != null && mid > 0 && rm != null && Number.isFinite(rm)) {
    pct = Math.min(100, (Math.abs(rm) / mid) * 100);
    if (isMeasuredRpmInTargetWindow(rm, 0.08)) {
      gaugeClass = "";
    } else {
      const errRatio = Math.abs(rm - mid) / mid;
      if (errRatio <= 0.2) gaugeClass = "gauge-warn";
      else gaugeClass = "gauge-bad";
    }
  }
  gaugeFillEl.style.width = `${pct.toFixed(0)}%`;
  gaugeFillEl.className = "gauge-fill" + (gaugeClass ? ` ${gaugeClass}` : "");
  if (gaugeBarEl) {
    gaugeBarEl.setAttribute("aria-valuenow", String(Math.round(pct)));
  }

  const dwellPct = Math.min(100, (dwellClientMs / DWELL_TARGET_MS) * 100);
  if (dwellRingArc) {
    const off = DWELL_CIRC * (1 - dwellPct / 100);
    dwellRingArc.style.strokeDashoffset = String(off);
  }
  if (dwellFillEl) dwellFillEl.style.width = `${dwellPct.toFixed(0)}%`;

  if (telemetry.err) {
    mcuErrEl.classList.remove("hidden");
    mcuErrEl.textContent = telemetry.err;
  } else {
    mcuErrEl.classList.add("hidden");
    mcuErrEl.textContent = "";
  }

  rpmBandHintEl.textContent =
    tlo != null && thi != null && Number.isFinite(tlo) && Number.isFinite(thi)
      ? tlo === thi
        ? `MCU target window: ${tlo} RPM`
        : `MCU target window: ${tlo}–${thi} RPM`
      : tr != null
        ? `MCU target speed: ${tr} RPM`
        : "Target RPM shows here when the MCU reports it over serial.";

  if (motorTestRpmEl) {
    motorTestRpmEl.textContent =
      telemetry.rpm != null && Number.isFinite(telemetry.rpm)
        ? telemetry.rpm.toFixed(0)
        : "—";
  }

  updateThrowLiveReadout();
}

function maybeAutoFeedOnce() {
  const cfg = readThrowConfigFromDom();
  if (cfg.throwMode !== "manual" || !throwAutoFireEl?.checked) return;
  if (motorTestEnableEl?.checked || panTestEnableEl?.checked) return;
  if (!bridge.isConnected() || !armCheckbox.checked) return;
  const intervalMs =
    (parseFloat(String(throwAutoFireIntervalEl?.value ?? "5")) || 5) * 1000;
  const st = String(telemetry.state || "").toUpperCase();
  if (st === "FEEDING" || st === "COOLDOWN" || st === "FAULT") return;
  const tr = telemetry.target_rpm;
  const rm = telemetry.rpm;
  const tol = cfg.tuning?.rpm_tol_ratio ?? 0.08;
  if (tr == null || tr <= 0 || rm == null || !Number.isFinite(rm)) return;
  if (!isMeasuredRpmInTargetWindow(rm, tol)) return;
  const now = performance.now();
  if (now - lastAutoFeedAtMs < intervalMs) return;
  lastAutoFeedAtMs = now;
  bridge.sendFeedOnce();
}

bridge.setOnTelemetry((t) => {
  telemetry.lastRx = performance.now();
  const prevErr = telemetry.err;
  if (t.state != null) telemetry.state = String(t.state).toUpperCase();
  if (t.rpm !== undefined) telemetry.rpm = t.rpm;
  if (t.target_rpm !== undefined) telemetry.target_rpm = t.target_rpm;
  if (t.target_rpm_min !== undefined) telemetry.target_rpm_min = t.target_rpm_min;
  if (t.target_rpm_max !== undefined) telemetry.target_rpm_max = t.target_rpm_max;
  if (t.dist_m !== undefined) telemetry.dist_m = t.dist_m;
  if (t.err !== undefined) telemetry.err = t.err;
  if (
    t.err !== undefined &&
    t.err &&
    String(t.err) !== String(prevErr ?? "")
  ) {
    showHeaderChip(`MCU reported error: ${t.err}`, {
      variant: "error",
      ttl: 12000,
    });
  }

  if (Array.isArray(t.serial_log)) {
    renderSerialLog(t.serial_log);
  }

  if (Array.isArray(t.bridge_log)) {
    const lines = t.bridge_log;
    if (suppressBridgeLogReplay) {
      lastBridgeLogLen = lines.length;
      suppressBridgeLogReplay = false;
    } else {
      if (lines.length < lastBridgeLogLen) lastBridgeLogLen = 0;
      for (let i = lastBridgeLogLen; i < lines.length; i++) {
        appendBridgeServerLine(lines[i]);
      }
      lastBridgeLogLen = lines.length;
    }
  }

  if (t.serial_open != null) {
    setSerialOrbVisual(!!t.serial_open);
    const sText = t.serial_port
      ? `Serial ${t.serial_port}${t.serial_open ? ", open" : ", closed"}`
      : t.serial_open
        ? "Serial open"
        : "Serial closed";
    serialPill.setAttribute("aria-label", sText);
    serialPill.title = sText;
    if (serialPillText) serialPillText.textContent = sText;
    if (serialStatusTextEl) {
      serialStatusTextEl.textContent = shortSerialStatusLabel(sText);
    }
  }

  const rm = telemetry.rpm;
  if (rm != null && Number.isFinite(rm) && isMeasuredRpmInTargetWindow(rm, 0.08)) {
    dwellClientMs = Math.min(DWELL_TARGET_MS + 80, dwellClientMs + 50);
  } else {
    dwellClientMs = Math.max(0, dwellClientMs - 80);
  }

  const stNow = String(telemetry.state || "IDLE").toUpperCase();
  if (stNow === "FEEDING" && lastMcuState !== "FEEDING" && kineticPanel) {
    kineticPanel.classList.add("feeder-cycle");
    window.setTimeout(() => kineticPanel.classList.remove("feeder-cycle"), 520);
  }
  lastMcuState = stNow;

  updateMachinePanel();
  maybeAutoFeedOnce();
});

function setBridgeStatusText(text) {
  bridgePill.setAttribute("aria-label", text);
  bridgePill.title = text;
  if (bridgePillText) bridgePillText.textContent = text;
  if (bridgeStatusTextEl) bridgeStatusTextEl.textContent = shortBridgeStatusLabel(text);
}

bridge.setOnConnectionEvent((ev) => {
  if (ev.type === "connecting") {
    setBridgeOrbVisual("connecting");
    setBridgeStatusText("Bridge connecting");
    appendActivityLine("Connecting to bridge WebSocket…", "info");
  } else if (ev.type === "open") {
    setBridgeOrbVisual("online");
    setBridgeStatusText("Bridge online");
    syncMotorTestUi();
    btnStop.disabled = false;
    setAlertBanner("");
    appendActivityLine("WebSocket connection open — telemetry streaming.", "info");
    bridge.flush();
    try {
      const c = readThrowConfigFromDom();
      if (c.headTracking.homeOnConnect) {
        bridge.sendPanHome();
        appendActivityLine("Sent PAN_HOME (on connect).", "info");
      }
    } catch {
      /* ignore */
    }
    if (panTestEnableEl?.checked) {
      pushBridgeControl(lastPlayersSnapshot, { panForceSerial: true });
    }
  } else if (ev.type === "close") {
    setBridgeOrbVisual("offline");
    setBridgeStatusText("Bridge offline");
    armCheckbox.disabled = true;
    armCheckbox.checked = false;
    btnStop.disabled = true;
    syncMotorTestUi();
    lastBridgeLogLen = 0;
    appendActivityLine("WebSocket connection closed.", "warn");
    showHeaderChip("Bridge disconnected — controls disabled.", {
      variant: "warn",
      ttl: 10000,
    });
  } else if (ev.type === "error") {
    setBridgeOrbVisual("offline");
    setBridgeStatusText("Bridge error");
    appendActivityLine(ev.message || "WebSocket error", "err");
    showToast(ev.message || "WebSocket error", true);
  }
});

function tickBridgeLatency() {
  const age = performance.now() - telemetry.lastRx;
  if (bridge.isConnected() && telemetry.lastRx > 0) {
    bridgeLatencyEl.textContent =
      age < 2000 ? `${Math.round(age)}ms` : "stale";
    bridgeLatencyEl.classList.toggle("muted", age < 800);
  } else {
    bridgeLatencyEl.textContent = "";
  }
  requestAnimationFrame(() => setTimeout(tickBridgeLatency, 500));
}
tickBridgeLatency();

function kineticAnimationFrame(now) {
  if (rotorArm && rotorGhost) {
    const dt = Math.min(0.08, (now - lastArmFrameMs) / 1000);
    lastArmFrameMs = now;
    const rm = telemetry.rpm;
    if (rm != null && Number.isFinite(rm) && Math.abs(rm) > 0.2) {
      armAngleDeg += ((Math.abs(rm) / 60) * 360 * dt) / 2.2;
      armAngleDeg %= 360;
    }
    rotorArm.style.transform = `rotate(${armAngleDeg}deg)`;

    const tr = telemetry.target_rpm;
    if (tr != null && tr > 0) {
      ghostAngleDeg += ((tr / 60) * 360 * dt) / 2.8;
      ghostAngleDeg %= 360;
    }
    rotorGhost.style.transform = `rotate(${ghostAngleDeg}deg)`;
  }
  requestAnimationFrame(kineticAnimationFrame);
}
requestAnimationFrame(kineticAnimationFrame);

btnWsConnect.addEventListener("click", () => {
  const u = wsUrlInput.value.trim();
  if (!u) {
    showToast("Enter WebSocket URL", true);
    return;
  }
  bridge.connect(u);
});

btnWsDisconnect.addEventListener("click", () => {
  bridge.disconnect();
  setBridgeOrbVisual("offline");
  setBridgeStatusText("Bridge offline");
});

btnReconnect.addEventListener("click", () => {
  const u = wsUrlInput.value.trim();
  if (u) bridge.connect(u);
});

armCheckbox.addEventListener("change", () => {
  const cfg = readThrowConfigFromDom();
  const needCal = cfg.throwMode === "auto";
  if (needCal && !calibration) {
    setAlertBanner("Calibrate distance before arming for metric TARGET_M.");
    armCheckbox.checked = false;
    return;
  }
  if (
    cfg.throwMode === "manual" &&
    armCheckbox.checked &&
    cfg.fixedRpmMax <= 0
  ) {
    setAlertBanner("Set manual RPM max greater than zero before arming.");
    armCheckbox.checked = false;
    return;
  }
  bridge.setControl({
    armed: armCheckbox.checked,
    test_mode: false,
    test_pwm: 0,
  });
  announceMachineState(
    armCheckbox.checked ? "Machine armed" : "Machine disarmed",
  );
});

btnStop.addEventListener("click", () => {
  if (motorTestEnableEl) motorTestEnableEl.checked = false;
  if (motorTestSliderEl) motorTestSliderEl.value = "0";
  if (motorTestPctEl) motorTestPctEl.textContent = "0%";
  syncMotorTestUi();
  armCheckbox.checked = false;
  bridge.setControl({
    armed: false,
    target_m: null,
    selected_player_id: null,
    test_mode: false,
    test_pwm: 0,
  });
  bridge.sendStop();
  announceMachineState("Stop sent, machine disarmed");
  showHeaderChip("Emergency stop sent — machine disarmed.", {
    variant: "warn",
    ttl: 7000,
  });
});

let isProcessing = false;
let previousTime;
const context = canvas.getContext("2d", { willReadFrequently: true });
const depthContext = depthCanvas.getContext("2d", { willReadFrequently: true });

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
      imageData[o + 3] = Math.round(255 * (1 - (data[i] - min) / range));
    }
  }
  depthContext.putImageData(new ImageData(imageData, ow, oh), 0, 0);
}

function syncMotorTestUi() {
  const wheelOn = motorTestEnableEl?.checked ?? false;
  const panOn = panTestEnableEl?.checked ?? false;
  const benchOn = wheelOn || panOn;
  const connected = bridge.isConnected();
  document.body.classList.toggle("app-motor-test", wheelOn);
  document.body.classList.toggle("app-pan-test", panOn);
  if (motorTestSliderEl) motorTestSliderEl.disabled = !connected || panOn;
  if (motorTestEnableEl) motorTestEnableEl.disabled = panOn;
  /* Pan slider: same rule as wheel slider — online + mode on (see CSS for stacking). */
  if (panTestSliderEl) {
    panTestSliderEl.disabled = !connected || !panOn;
  }
  if (panTestEnableEl) panTestEnableEl.disabled = wheelOn;
  if (servoTestFeedBtnEl) servoTestFeedBtnEl.disabled = !connected || benchOn;
  if (armCheckbox) {
    armCheckbox.disabled = !connected || benchOn;
    if (benchOn) armCheckbox.checked = false;
  }
  if (btnManualFire) btnManualFire.disabled = !connected || benchOn;
  if (throwAutoFireEl) throwAutoFireEl.disabled = benchOn;
  if (throwAutoFireIntervalEl) throwAutoFireIntervalEl.disabled = benchOn;
  if (panTestPctEl && panTestSliderEl) {
    panTestPctEl.textContent = `${panTestSliderEl.value}%`;
  }
}

/**
 * @param {unknown} players
 * @param {{ panForceSerial?: boolean }} [opts]
 */
function pushBridgeControl(players, opts = {}) {
  const panForceSerial = opts.panForceSerial === true;
  const rawPl = Array.isArray(players) ? players : lastPlayersSnapshot;
  const plArr = Array.isArray(rawPl) ? rawPl : [];
  updateHeadTargetPlayerSelect(plArr);

  const cfg = readThrowConfigFromDom();
  bridge.setThrottleMs(cfg.headTracking.minSendMs);
  const motorTestOn = motorTestEnableEl?.checked ?? false;
  const panTestOn = panTestEnableEl?.checked ?? false;
  const pan = computeHeadPanForBridge(
    plArr,
    cfg.headTracking,
    motorTestOn,
    panTestOn,
  );
  updateHeadTrackingLiveLabels(
    pan.rawPan,
    pan.gateOk,
    pan.panEnable ? pan.sentForDisplay : null,
    pan.panEnable,
    pan.panTestOn,
  );

  if (!bridge.isConnected()) return;

  if (motorTestOn) {
    bridge.setControl({
      target_m: null,
      armed: false,
      selected_player_id: null,
      rpm_mode: "auto",
      target_rpm_manual: null,
      bands: null,
      tuning: Object.keys(cfg.tuning).length > 0 ? cfg.tuning : undefined,
      auto_feed_dwell: false,
      test_mode: true,
      test_pwm: parseFloat(motorTestSliderEl?.value ?? "0") || 0,
      pan_enable: false,
      pan_target: null,
      pan_tuning: pan.pan_tuning,
    });
    bridge.flush();
    if (noPlayerDisarmTimer) {
      clearTimeout(noPlayerDisarmTimer);
      noPlayerDisarmTimer = 0;
    }
    return;
  }

  const isAuto = cfg.throwMode === "auto";
  const wantArm =
    armCheckbox.checked &&
    (isAuto ? calibration != null : cfg.fixedRpmMax > 0);
  let targetM = null;
  let selectedId = null;

  if (isAuto) {
    if (plArr.length > 0 && selectedSlotIndex != null) {
      const pl = plArr[selectedSlotIndex];
      selectedId = selectedSlotIndex + 1;
      if (pl.meters != null && Number.isFinite(pl.meters)) {
        targetM = pl.meters;
      }
    }
  } else {
    targetM = 0;
  }

  const effectiveArm =
    wantArm &&
    (isAuto ? targetM != null : cfg.fixedRpmMax > 0);

  if (
    !effectiveArm &&
    armCheckbox.checked &&
    isAuto &&
    plArr.length > 0 &&
    !targetM
  ) {
    setAlertBanner(
      "Selected player has no metric distance — finish calibration.",
    );
  } else if (
    !effectiveArm &&
    armCheckbox.checked &&
    !isAuto &&
    cfg.fixedRpmMax <= 0
  ) {
    setAlertBanner("Set manual RPM max greater than zero.");
  } else if (effectiveArm) {
    setAlertBanner("");
  }

  const bandsPayload = [];
  for (let i = 0; i < cfg.bandCount; i++) {
    const minEl = document.getElementById(`throw-band-${i}-min`);
    const maxEl = document.getElementById(`throw-band-${i}-max`);
    const rminEl = document.getElementById(`throw-band-${i}-rpm-min`);
    const rmaxEl = document.getElementById(`throw-band-${i}-rpm-max`);
    if (!minEl || !maxEl || !rminEl || !rmaxEl) continue;
    const min_m = parseFloat(minEl.value);
    const max_m = parseFloat(maxEl.value);
    const rpm_min = parseInt(rminEl.value, 10);
    const rpm_max = parseInt(rmaxEl.value, 10);
    if (!Number.isFinite(min_m) || !Number.isFinite(max_m)) continue;
    if (min_m >= max_m) continue;
    const r0 = Math.max(0, Math.min(500, Number.isFinite(rpm_min) ? rpm_min : 0));
    const r1 = Math.max(0, Math.min(500, Number.isFinite(rpm_max) ? rpm_max : 0));
    if (r0 > r1) continue;
    bandsPayload.push({
      min_m,
      max_m,
      rpm_min: r0,
      rpm_max: r1,
    });
  }

  bridge.setControl({
    target_m: effectiveArm ? targetM : null,
    armed: effectiveArm,
    selected_player_id: selectedId,
    rpm_mode: isAuto ? "auto" : "manual",
    target_rpm_manual: isAuto
      ? null
      : [cfg.fixedRpmMin, cfg.fixedRpmMax],
    bands:
      isAuto && bandsPayload.length > 0 ? bandsPayload : null,
    tuning: Object.keys(cfg.tuning).length > 0 ? cfg.tuning : undefined,
    auto_feed_dwell: isAuto,
    test_mode: false,
    test_pwm: 0,
    pan_enable: pan.panEnable,
    pan_target: pan.panTarget,
    pan_tuning: pan.pan_tuning,
    pan_force_serial: panForceSerial,
  });
  if (panForceSerial) {
    bridge.flushForce();
  } else if (panTestOn) {
    bridge.flush();
  }

  const disarmWhenNoPlayers = isAuto;
  if (plArr.length === 0 && armCheckbox.checked && disarmWhenNoPlayers) {
    if (!noPlayerDisarmTimer) {
      noPlayerDisarmTimer = window.setTimeout(() => {
        armCheckbox.checked = false;
        bridge.setControl({
          armed: false,
          target_m: null,
          selected_player_id: null,
          test_mode: false,
          test_pwm: 0,
        });
        showHeaderChip("Disarmed: no players in frame.", {
          variant: "info",
          ttl: 7000,
        });
        noPlayerDisarmTimer = 0;
      }, 900);
    }
  } else if (noPlayerDisarmTimer) {
    clearTimeout(noPlayerDisarmTimer);
    noPlayerDisarmTimer = 0;
  }
}

function updateCanvas() {
  const { width, height } = canvas;
  context.drawImage(video, 0, 0, width, height);

  if (!isProcessing) {
    isProcessing = true;
    (async function () {
      try {
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
      const [wDet, hDet] = sizes;
      lastDepthState = depthState;
      lastDetSizes = sizes;

      calibrationRefRawThisFrame = null;
      if (calibration) {
        const { data: dd, ow: oww, oh: ohh } = depthState;
        const { xmin, ymin, xmax, ymax } = calibration.roiDet;
        const { mean, count } = meanDepthInRect(
          dd,
          oww,
          ohh,
          xmin,
          ymin,
          xmax,
          ymax,
          wDet,
          hDet,
        );
        if (count > 0 && Number.isFinite(mean) && Math.abs(mean) >= 1e-12) {
          calibrationRefRawThisFrame = mean;
        }
      }

      /** @type {DetBox[]} */
      const rawDets = [];
      for (const x of outputs.tolist()) {
        const [xmin, ymin, xmax, ymax, score, id] = x;
        if (score < threshold) continue;
        if (!isPersonClass(id)) continue;
        rawDets.push({
          xmin,
          ymin,
          xmax,
          ymax,
          score,
          id,
          cx: (xmin + xmax) / 2,
          cy: (ymin + ymax) / 2,
        });
      }
      rawDets.sort((a, b) => a.cx - b.cx);

      const matched = matchTracks(rawDets, prevTracked);
      prevTracked = matched.map((m) => ({ box: m.box, trackId: m.trackId }));

      /** @type {Array<{ box: DetBox, trackId: number, meters: number | null, score: number, det: number[] }>} */
      const players = matched.map((m) => {
        const { data: d2, ow: ow2, oh: oh2, min: mn, max: mx } = depthState;
        const cx = m.box.cx;
        const cy = m.box.cy;
        const { raw } = sampleDepthAt(d2, ow2, oh2, cx, cy, wDet, hDet, mn, mx);
        let meters = metricDistanceFromRaw(
          raw,
          calibration,
          calibrationRefRawThisFrame,
        );
        if (meters != null && !Number.isFinite(meters)) meters = null;
        if (meters != null && Number.isFinite(meters)) {
          const prev = distanceEmaByTrack[m.trackId];
          distanceEmaByTrack[m.trackId] =
            prev == null
              ? meters
              : EMA_ALPHA * meters + (1 - EMA_ALPHA) * prev;
          meters = distanceEmaByTrack[m.trackId];
        }
        return {
          box: m.box,
          trackId: m.trackId,
          meters,
          score: m.box.score,
          det: [
            m.box.xmin,
            m.box.ymin,
            m.box.xmax,
            m.box.ymax,
            m.box.score,
            m.box.id,
          ],
        };
      });

      overlay.innerHTML = "";
      players.forEach((pl, idx) => {
        const color =
          PLAYER_PALETTE[pl.trackId % PLAYER_PALETTE.length];
        renderPlayerBox({
          det: pl.det,
          wDet,
          hDet,
          depthState,
          playerSlot: idx + 1,
          trackId: pl.trackId,
          color,
          meters: pl.meters,
          selected: selectedSlotIndex === idx,
        });
      });

      updateRoster(players);
      lastPlayersSnapshot = players;
      pushBridgeControl(players);

      refreshCalibrationLayer();
      updateCalibrationUiState();

      if (previousTime !== undefined) {
        const fps = 1000 / (performance.now() - previousTime);
        statusEl.textContent = `FPS: ${fps.toFixed(2)}`;
      }
      previousTime = performance.now();
      } finally {
        isProcessing = false;
      }
    })();
  }

  window.requestAnimationFrame(updateCanvas);
}

initThrowTuningUi();
initTerminalPanelUi();
initRightPanelTabs();

navigator.mediaDevices
  .getUserMedia({ video: true })
  .then((stream) => {
    video.srcObject = stream;
    video.play();

    const videoTrack = stream.getVideoTracks()[0];
    const { width, height } = videoTrack.getSettings();

    setStreamSize(width * scale, height * scale);

    syncPanelSizes();
    window.addEventListener("resize", () => syncPanelSizes());

    window.requestAnimationFrame(updateCanvas);
  })
  .catch((error) => {
    alert(error);
  });
