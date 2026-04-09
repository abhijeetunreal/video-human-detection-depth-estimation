/**
 * WebSocket client to Python ball bridge. Throttles outbound control messages.
 */

const DEFAULT_INTERVAL_MS = 100;

/**
 * @typedef {Object} Telemetry
 * @property {string} [state]
 * @property {number | null} [rpm]
 * @property {number | null} [target_rpm]
 * @property {number | null} [target_rpm_min]
 * @property {number | null} [target_rpm_max]
 * @property {number | null} [dist_m]
 * @property {string | null} [err]
 * @property {boolean} [serial_open]
 * @property {string | null} [serial_port]
 * @property {string[]} [serial_log]
 */

export function createMachineBridge() {
  /** @type {WebSocket | null} */
  let ws = null;
  let url = "";
  /** @type {((t: Telemetry) => void) | null} */
  let onTelemetry = null;
  /** @type {((ev: { type: string, message?: string }) => void) | null} */
  let onConnectionEvent = null;

  let lastSent = "";
  let throttleTimer = 0;
  let throttleMs = DEFAULT_INTERVAL_MS;
  /**
   * @type {{
   *   target_m: number | null,
   *   armed: boolean,
   *   selected_player_id: number | null,
   *   rpm_mode: string,
   *   target_rpm_manual: number | [number, number] | { rpm_min: number, rpm_max: number } | null,
   *   bands: Array<{ min_m: number, max_m: number, rpm_min: number, rpm_max: number }> | undefined,
   *   tuning: Record<string, number> | undefined,
   *   auto_feed_dwell: boolean | undefined,
   *   test_mode: boolean | undefined,
   *   test_pwm: number | undefined,
   *   pan_enable: boolean | undefined,
   *   pan_target: number | null | undefined,
   *   pan_tuning: Record<string, number> | undefined,
   *   pan_force_serial: boolean | undefined,
   * } | null}
   */
  let pending = null;

  /** Fresh merged state after reconnect — avoids stale test_mode / armed from old session. */
  function defaultPending() {
    return {
      target_m: null,
      armed: false,
      selected_player_id: null,
      rpm_mode: "auto",
      target_rpm_manual: null,
      bands: undefined,
      tuning: undefined,
      auto_feed_dwell: true,
      test_mode: false,
      test_pwm: 0,
      pan_enable: false,
      pan_target: null,
      pan_tuning: undefined,
      pan_force_serial: false,
    };
  }

  function emitConn(type, message) {
    onConnectionEvent?.({ type, message });
  }

  function flush() {
    throttleTimer = 0;
    if (!ws || ws.readyState !== WebSocket.OPEN || !pending) return;
    const payload = JSON.stringify(pending);
    if (payload === lastSent) return;
    lastSent = payload;
    ws.send(payload);
  }

  function flushForce() {
    throttleTimer = 0;
    if (!ws || ws.readyState !== WebSocket.OPEN || !pending) return;
    const payload = JSON.stringify(pending);
    lastSent = payload;
    ws.send(payload);
  }

  function scheduleSend() {
    if (throttleTimer) return;
    throttleTimer = window.setTimeout(flush, throttleMs);
  }

  /**
   * @param {number} ms
   */
  function setThrottleMs(ms) {
    const n = Number(ms);
    throttleMs =
      Number.isFinite(n) && n >= 20 && n <= 5000 ? Math.round(n) : DEFAULT_INTERVAL_MS;
  }

  /**
   * @param {Partial<{
   *   target_m: number | null,
   *   armed: boolean,
   *   selected_player_id: number | null,
   *   rpm_mode: string,
   *   target_rpm_manual: number | [number, number] | { rpm_min: number, rpm_max: number } | null,
   *   bands: Array<{ min_m: number, max_m: number, rpm_min: number, rpm_max: number }>,
   *   tuning: Record<string, number>,
   *   auto_feed_dwell: boolean,
   *   test_mode: boolean,
   *   test_pwm: number,
   *   pan_enable: boolean,
   *   pan_target: number | null,
   *   pan_tuning: Record<string, number>,
   *   pan_force_serial: boolean,
   * }>} patch
   */
  function setControl(patch) {
    const prevTestMode = pending?.test_mode ?? false;
    const prevPanEn = pending?.pan_enable ?? false;
    const prevPanTgt = pending?.pan_target ?? null;
    pending = {
      target_m:
        patch.target_m !== undefined ? patch.target_m : pending?.target_m ?? null,
      armed: patch.armed !== undefined ? patch.armed : pending?.armed ?? false,
      selected_player_id:
        patch.selected_player_id !== undefined
          ? patch.selected_player_id
          : pending?.selected_player_id ?? null,
      rpm_mode:
        patch.rpm_mode !== undefined
          ? patch.rpm_mode
          : pending?.rpm_mode ?? "auto",
      target_rpm_manual:
        patch.target_rpm_manual !== undefined
          ? patch.target_rpm_manual
          : pending?.target_rpm_manual ?? null,
      bands: patch.bands !== undefined ? patch.bands : pending?.bands,
      tuning: patch.tuning !== undefined ? patch.tuning : pending?.tuning,
      auto_feed_dwell:
        patch.auto_feed_dwell !== undefined
          ? patch.auto_feed_dwell
          : pending?.auto_feed_dwell ?? true,
      test_mode:
        patch.test_mode !== undefined ? patch.test_mode : pending?.test_mode ?? false,
      test_pwm:
        patch.test_pwm !== undefined ? patch.test_pwm : pending?.test_pwm ?? 0,
      pan_enable:
        patch.pan_enable !== undefined
          ? patch.pan_enable
          : pending?.pan_enable ?? false,
      pan_target:
        patch.pan_target !== undefined ? patch.pan_target : pending?.pan_target ?? null,
      pan_tuning:
        patch.pan_tuning !== undefined ? patch.pan_tuning : pending?.pan_tuning,
      pan_force_serial: patch.pan_force_serial === true,
    };
    const nextTestMode = pending.test_mode;
    const nextPanEn = pending.pan_enable ?? false;
    const nextPanTgt = pending.pan_target ?? null;
    /* Re-enabling test with same slider value reproduces the same JSON as before → flush() would skip send and bridge never sees TEST_MODE 1 again. */
    if (prevTestMode !== nextTestMode) {
      lastSent = "";
    }
    const panTgtEqual =
      (prevPanTgt == null && nextPanTgt == null) ||
      (prevPanTgt != null &&
        nextPanTgt != null &&
        Number.isFinite(Number(prevPanTgt)) &&
        Number.isFinite(Number(nextPanTgt)) &&
        Math.abs(Number(prevPanTgt) - Number(nextPanTgt)) < 1e-9);
    if (prevPanEn !== nextPanEn || !panTgtEqual) {
      lastSent = "";
    }
    if (patch.pan_force_serial === true) {
      lastSent = "";
    }
    scheduleSend();
  }

  function connect(wsUrl) {
    disconnect();
    url = wsUrl;
    emitConn("connecting");
    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      emitConn("error", String(e));
      return;
    }
    ws.addEventListener("open", () => {
      lastSent = "";
      pending = defaultPending();
      emitConn("open");
      flush();
    });
    ws.addEventListener("close", () => {
      emitConn("close");
    });
    ws.addEventListener("error", () => {
      emitConn("error", "WebSocket error");
    });
    ws.addEventListener("message", (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data && typeof data === "object") {
          onTelemetry?.(/** @type {Telemetry} */ (data));
        }
      } catch {
        /* ignore non-JSON */
      }
    });
  }

  function disconnect() {
    if (throttleTimer) {
      clearTimeout(throttleTimer);
      throttleTimer = 0;
    }
    lastSent = "";
    pending = null;
    if (ws) {
      ws.close();
      ws = null;
    }
  }

  function isConnected() {
    return ws !== null && ws.readyState === WebSocket.OPEN;
  }

  function sendStop() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "stop" }));
    lastSent = "";
  }

  function sendBandsReset() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "bands_reset" }));
    lastSent = "";
  }

  function sendFeedOnce() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "feed_once" }));
  }

  function sendServoTest() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "servo_test" }));
  }

  function sendPanHome() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "pan_home" }));
  }

  return {
    connect,
    disconnect,
    setControl,
    flush,
    flushForce,
    isConnected,
    sendStop,
    sendBandsReset,
    sendFeedOnce,
    sendServoTest,
    sendPanHome,
    setThrottleMs,
    setOnTelemetry(fn) {
      onTelemetry = fn;
    },
    setOnConnectionEvent(fn) {
      onConnectionEvent = fn;
    },
  };
}
