from __future__ import annotations

import asyncio
import json
import logging
import threading
from pathlib import Path
from typing import Any

import serial
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

logger = logging.getLogger("ball_bridge")

SERIAL_LOCK = threading.Lock()


class SerialTelemetry:
    _LOG_MAX = 100
    _BRIDGE_LOG_MAX = 120

    def __init__(self) -> None:
        self.state: str = "IDLE"
        self.rpm: float | None = None
        self.target_rpm: int | None = None
        self.target_rpm_min: int | None = None
        self.target_rpm_max: int | None = None
        self.dist_m: float | None = None
        self.err: str | None = None
        self.serial_open: bool = False
        self.serial_port: str | None = None
        self._serial_lines: list[str] = []
        self._bridge_lines: list[str] = []

    def push_bridge_line(self, line: str) -> None:
        s = line.strip("\r\n")
        if not s:
            return
        self._bridge_lines.append(s[:400])
        if len(self._bridge_lines) > self._BRIDGE_LOG_MAX:
            self._bridge_lines = self._bridge_lines[-self._BRIDGE_LOG_MAX :]

    def push_serial_line(self, line: str) -> None:
        s = line.strip("\r\n")
        if not s:
            return
        self._serial_lines.append(s[:400])
        if len(self._serial_lines) > self._LOG_MAX:
            self._serial_lines = self._serial_lines[-self._LOG_MAX :]

    def snapshot(self) -> dict[str, Any]:
        return {
            "state": self.state,
            "rpm": self.rpm,
            "target_rpm": self.target_rpm,
            "target_rpm_min": self.target_rpm_min,
            "target_rpm_max": self.target_rpm_max,
            "dist_m": self.dist_m,
            "err": self.err,
            "serial_open": self.serial_open,
            "serial_port": self.serial_port,
            "serial_log": list(self._serial_lines),
            "bridge_log": list(self._bridge_lines),
        }

    def ingest_line(self, line: str) -> None:
        line = line.strip()
        if not line:
            return
        parts = line.split(maxsplit=1)
        key = parts[0].upper()
        rest = parts[1] if len(parts) > 1 else ""
        try:
            if key == "STATE":
                self.state = rest.strip().upper() or "IDLE"
            elif key == "RPM":
                self.rpm = float(rest.strip())
            elif key == "TARGET_RPM":
                self.target_rpm = int(float(rest.strip()))
            elif key == "TARGET_RPM_MIN":
                self.target_rpm_min = int(float(rest.strip()))
            elif key == "TARGET_RPM_MAX":
                self.target_rpm_max = int(float(rest.strip()))
            elif key == "DIST_M":
                self.dist_m = float(rest.strip())
            elif key == "ERR":
                self.err = rest.strip() or "UNKNOWN"
        except (ValueError, IndexError):
            logger.debug("unparsed line: %s", line)


def create_app(
    *,
    serial_port: str,
    baud: int,
    static_dir: Path | None,
    open_browser_url: str | None = None,
) -> FastAPI:
    telemetry = SerialTelemetry()
    telemetry.serial_port = serial_port

    last_bands_sig: str | None = None
    last_tuning_sig: str | None = None
    last_test_on: bool = False

    ser: serial.Serial | None = None
    stop_reader = threading.Event()

    def open_serial() -> None:
        nonlocal ser
        with SERIAL_LOCK:
            if ser and ser.is_open:
                try:
                    ser.close()
                except OSError:
                    pass
            try:
                ser = serial.Serial(serial_port, baud, timeout=0.05)
                telemetry.serial_open = True
                telemetry.push_bridge_line(
                    f"INFO: Serial opened {serial_port} @ {baud} baud"
                )
                logger.info("Opened serial %s", serial_port)
            except OSError as e:
                ser = None
                telemetry.serial_open = False
                telemetry.err = f"SERIAL:{e}"
                logger.error("Serial open failed: %s", e)

    def serial_write(text: str) -> None:
        with SERIAL_LOCK:
            if ser and ser.is_open:
                try:
                    ser.write(text.encode("ascii", errors="ignore"))
                    ser.flush()
                except OSError as e:
                    logger.warning("Serial write failed: %s", e)

    def send_bands_if_changed(bands: Any) -> None:
        nonlocal last_bands_sig
        if not isinstance(bands, list):
            return
        sig = json.dumps(bands, sort_keys=True)
        if sig == last_bands_sig:
            return
        last_bands_sig = sig
        for i, b in enumerate(bands[:6]):
            if not isinstance(b, dict):
                continue
            try:
                mn = float(b["min_m"])
                mx = float(b["max_m"])
            except (KeyError, TypeError, ValueError):
                continue
            try:
                r0 = int(b["rpm_min"])
                r1 = int(b["rpm_max"])
            except (KeyError, TypeError, ValueError):
                try:
                    r0 = int(b["rpm"])
                except (KeyError, TypeError, ValueError):
                    continue
                r1 = r0
            serial_write(f"SET_BAND {i} {mn:.3f} {mx:.3f} {r0} {r1}\n")
        n = min(len(bands), 6)
        if n >= 1:
            serial_write(f"SET_BAND_COUNT {n}\n")

    def send_tuning_if_changed(tuning: Any) -> None:
        nonlocal last_tuning_sig
        if not isinstance(tuning, dict):
            return
        sig = json.dumps(tuning, sort_keys=True)
        if sig == last_tuning_sig:
            return
        last_tuning_sig = sig
        try:
            if "dwell_ms" in tuning:
                v = int(tuning["dwell_ms"])
                if 50 <= v <= 5000:
                    serial_write(f"SET_DWELL_MS {v}\n")
            if "feed_ms" in tuning:
                v = int(tuning["feed_ms"])
                if 50 <= v <= 2000:
                    serial_write(f"SET_FEED_MS {v}\n")
            if "cooldown_ms" in tuning:
                v = int(tuning["cooldown_ms"])
                if 100 <= v <= 10000:
                    serial_write(f"SET_COOLDOWN_MS {v}\n")
            if "kp" in tuning:
                v = float(tuning["kp"])
                if 0.01 <= v <= 100.0:
                    serial_write(f"SET_KP {v:.4f}\n")
            if "ki" in tuning:
                v = float(tuning["ki"])
                if 0.0 <= v <= 50.0:
                    serial_write(f"SET_KI {v:.4f}\n")
            if "pwm_max" in tuning:
                v = float(tuning["pwm_max"])
                if 10.0 <= v <= 255.0:
                    serial_write(f"SET_PWM_MAX {v:.2f}\n")
            if "rpm_tol_ratio" in tuning:
                v = float(tuning["rpm_tol_ratio"])
                if 0.01 <= v <= 0.5:
                    serial_write(f"SET_RPM_TOL {v:.4f}\n")
            if "stall_pwm" in tuning:
                v = float(tuning["stall_pwm"])
                if 10.0 <= v <= 255.0:
                    serial_write(f"SET_STALL_PWM {v:.2f}\n")
            if "stall_rpm" in tuning:
                v = float(tuning["stall_rpm"])
                if 1.0 <= v <= 100.0:
                    serial_write(f"SET_STALL_RPM {v:.2f}\n")
        except (TypeError, ValueError):
            pass

    def reader_loop() -> None:
        buf = bytearray()
        while not stop_reader.is_set():
            with SERIAL_LOCK:
                if not ser or not ser.is_open:
                    telemetry.serial_open = False
            if not ser or not ser.is_open:
                stop_reader.wait(0.2)
                continue
            try:
                with SERIAL_LOCK:
                    chunk = ser.read(256)
            except OSError:
                telemetry.serial_open = False
                stop_reader.wait(0.2)
                continue
            if not chunk:
                continue
            buf.extend(chunk)
            while b"\n" in buf:
                idx = buf.index(b"\n")
                line = bytes(buf[:idx]).decode("ascii", errors="ignore").strip("\r")
                del buf[: idx + 1]
                telemetry.push_serial_line(line)
                telemetry.ingest_line(line)

    reader_thread = threading.Thread(target=reader_loop, daemon=True)

    app = FastAPI(title="Ball machine bridge")

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.on_event("startup")
    async def _startup() -> None:
        open_serial()
        reader_thread.start()
        if open_browser_url:
            import threading
            import time
            import webbrowser

            def open_tab() -> None:
                time.sleep(1.8)
                try:
                    webbrowser.open(open_browser_url)
                    logger.info("Opened browser: %s", open_browser_url)
                except Exception:
                    logger.warning("Could not open browser automatically")

            threading.Thread(target=open_tab, daemon=True).start()

    @app.on_event("shutdown")
    async def _shutdown() -> None:
        stop_reader.set()
        with SERIAL_LOCK:
            if ser and ser.is_open:
                try:
                    ser.close()
                except OSError:
                    pass
        telemetry.serial_open = False

    @app.get("/api/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/telemetry")
    async def get_telemetry() -> dict[str, Any]:
        return telemetry.snapshot()

    @app.websocket("/ws")
    async def ws_endpoint(ws: WebSocket) -> None:
        nonlocal last_bands_sig, last_tuning_sig, last_test_on
        await ws.accept()
        telemetry.push_bridge_line(
            "INFO: WebSocket /ws accepted — telemetry + control (bridge)"
        )
        try:
            while True:
                try:
                    msg = await asyncio.wait_for(ws.receive_text(), timeout=0.05)
                except asyncio.TimeoutError:
                    await ws.send_json(telemetry.snapshot())
                    continue
                try:
                    data = json.loads(msg)
                except json.JSONDecodeError:
                    continue
                if data.get("type") == "stop":
                    telemetry.push_bridge_line("INFO: STOP forwarded to MCU")
                    serial_write("STOP\n")
                    continue
                if data.get("type") == "bands_reset":
                    telemetry.push_bridge_line("INFO: BANDS_RESET forwarded to MCU")
                    serial_write("BANDS_RESET\n")
                    last_bands_sig = None
                    continue
                if data.get("type") == "feed_once":
                    telemetry.push_bridge_line("INFO: FEED_ONCE forwarded to MCU")
                    serial_write("FEED_ONCE\n")
                    continue
                if data.get("type") == "servo_test":
                    telemetry.push_bridge_line("INFO: SERVO_TEST forwarded to MCU")
                    serial_write("SERVO_TEST\n")
                    continue

                test_on = bool(data.get("test_mode", False))
                tun_raw = data.get("tuning")
                tuning_for_test: dict[str, Any] = (
                    tun_raw if isinstance(tun_raw, dict) else {}
                )
                try:
                    pwm_max = float(tuning_for_test.get("pwm_max", 220))
                except (TypeError, ValueError):
                    pwm_max = 220.0
                if pwm_max < 10.0 or pwm_max > 255.0:
                    pwm_max = 220.0
                try:
                    pct = float(data.get("test_pwm", 0))
                except (TypeError, ValueError):
                    pct = 0.0
                pct = max(0.0, min(100.0, pct))
                pwm_cmd = int(pwm_max * (pct / 100.0) + 0.5)

                if test_on:
                    if not last_test_on:
                        telemetry.push_bridge_line("INFO: Motor test mode ON (TEST_MODE 1)")
                        serial_write("TEST_MODE 1\n")
                        last_test_on = True
                    serial_write(f"TEST_PWM {pwm_cmd}\n")
                    continue
                if last_test_on:
                    telemetry.push_bridge_line("INFO: Motor test mode OFF (TEST_MODE 0)")
                    serial_write("TEST_MODE 0\n")
                    last_test_on = False

                send_bands_if_changed(data.get("bands"))
                send_tuning_if_changed(data.get("tuning"))

                if "auto_feed_dwell" in data:
                    af = bool(data["auto_feed_dwell"])
                    serial_write(f"AUTO_FEED {1 if af else 0}\n")

                target_m = data.get("target_m")
                armed = bool(data.get("armed"))
                rpm_mode = (data.get("rpm_mode") or "auto").strip().lower()
                manual_rpm = data.get("target_rpm_manual")

                if armed:
                    try:
                        m = (
                            float(target_m)
                            if target_m is not None
                            else 0.0
                        )
                    except (TypeError, ValueError):
                        continue
                    serial_write(f"TARGET_M {m:.3f}\n")
                    if rpm_mode == "manual" and manual_rpm is not None:
                        try:
                            if isinstance(manual_rpm, (list, tuple)) and len(manual_rpm) >= 2:
                                r0 = max(0, min(500, int(float(manual_rpm[0]))))
                                r1 = max(0, min(500, int(float(manual_rpm[1]))))
                                if r0 > r1:
                                    r0, r1 = r1, r0
                                serial_write(f"TARGET_RPM {r0} {r1}\n")
                            elif (
                                isinstance(manual_rpm, dict)
                                and "rpm_min" in manual_rpm
                                and "rpm_max" in manual_rpm
                            ):
                                r0 = max(0, min(500, int(float(manual_rpm["rpm_min"]))))
                                r1 = max(0, min(500, int(float(manual_rpm["rpm_max"]))))
                                if r0 > r1:
                                    r0, r1 = r1, r0
                                serial_write(f"TARGET_RPM {r0} {r1}\n")
                            else:
                                r = max(0, min(500, int(float(manual_rpm))))
                                serial_write(f"TARGET_RPM {r}\n")
                        except (TypeError, ValueError):
                            serial_write("AUTO_RPM\n")
                    else:
                        serial_write("AUTO_RPM\n")
                    serial_write("ARM\n")
                else:
                    serial_write("DISARM\n")
        except WebSocketDisconnect:
            pass

    if static_dir and static_dir.is_dir():
        app.mount(
            "/",
            StaticFiles(directory=static_dir, html=True),
            name="site",
        )

    return app


def run(
    *,
    serial_port: str,
    baud: int,
    host: str,
    ws_port: int,
    static_dir: Path | None,
    open_browser: bool = False,
) -> None:
    logging.basicConfig(level=logging.INFO)
    display_host = (
        "127.0.0.1" if host in ("0.0.0.0", "::", "[::]", "") else host
    )
    open_url: str | None = None
    if (
        open_browser
        and static_dir is not None
        and static_dir.is_dir()
    ):
        open_url = f"http://{display_host}:{ws_port}/"
    app = create_app(
        serial_port=serial_port,
        baud=baud,
        static_dir=static_dir,
        open_browser_url=open_url,
    )
    import uvicorn

    uvicorn.run(app, host=host, port=ws_port, log_level="info")
