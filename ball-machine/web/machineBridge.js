/**
 * WebSocket client to Python ball bridge. Throttles outbound control messages.
 */

const DEFAULT_INTERVAL_MS = 100;

/**
 * @typedef {Object} Telemetry
 * @property {string} [state]
 * @property {number | null} [rpm]
 * @property {number | null} [target_rpm]
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
  /**
   * @type {{
   *   target_m: number | null,
   *   armed: boolean,
   *   selected_player_id: number | null,
   *   rpm_mode: string,
   *   target_rpm_manual: number | null,
   *   bands: Array<{ min_m: number, max_m: number, rpm: number }> | undefined,
   *   tuning: Record<string, number> | undefined,
   *   auto_feed_dwell: boolean | undefined,
   * } | null}
   */
  let pending = null;

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

  function scheduleSend() {
    if (throttleTimer) return;
    throttleTimer = window.setTimeout(flush, DEFAULT_INTERVAL_MS);
  }

  /**
   * @param {Partial<{
   *   target_m: number | null,
   *   armed: boolean,
   *   selected_player_id: number | null,
   *   rpm_mode: string,
   *   target_rpm_manual: number | null,
   *   bands: Array<{ min_m: number, max_m: number, rpm: number }>,
   *   tuning: Record<string, number>,
   *   auto_feed_dwell: boolean,
   * }>} patch
   */
  function setControl(patch) {
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
    };
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

  return {
    connect,
    disconnect,
    setControl,
    flush,
    isConnected,
    sendStop,
    sendBandsReset,
    sendFeedOnce,
    setOnTelemetry(fn) {
      onTelemetry = fn;
    },
    setOnConnectionEvent(fn) {
      onConnectionEvent = fn;
    },
  };
}
