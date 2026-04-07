#!/usr/bin/env python3
"""Run from this directory: run_bridge.bat  OR  python run_bridge.py [--port COM3]"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

from ball_bridge.port_detect import detect_serial_port
from ball_bridge.server import run

logger = logging.getLogger("ball_bridge")


def main() -> None:
    p = argparse.ArgumentParser(
        description="Ball machine WebSocket + serial bridge (auto-detects Arduino port if omitted)",
    )
    p.add_argument(
        "--port",
        default=None,
        help="Serial port (e.g. COM3). If omitted, a likely Arduino/USB-serial port is chosen automatically.",
    )
    p.add_argument(
        "--no-auto-fallback",
        action="store_true",
        help="Do not use the only available port when it does not match known USB-serial profiles.",
    )
    p.add_argument("--baud", type=int, default=115200)
    p.add_argument("--host", default="127.0.0.1", help="HTTP/WS bind address")
    p.add_argument("--ws-port", type=int, default=8765, help="HTTP + WebSocket port")
    p.add_argument(
        "--static",
        type=Path,
        default=None,
        help="Optional path to Vite dist/ (serves site + /ws)",
    )
    p.add_argument(
        "--no-browser",
        action="store_true",
        help="When using --static, do not open the dashboard in the default browser",
    )
    args = p.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    port = args.port
    if not port:
        chosen, msg = detect_serial_port(allow_single_fallback=not args.no_auto_fallback)
        if chosen:
            logger.info("%s", msg)
            port = chosen
        else:
            logger.error("%s", msg)
            sys.exit(1)
    else:
        logger.info("Using serial port %s", port)

    static = args.static.resolve() if args.static else None
    open_browser = bool(static) and not args.no_browser
    if static:
        logger.info(
            "Dashboard (after start): http://%s:%s/  |  WebSocket: ws://%s:%s/ws",
            args.host if args.host not in ("0.0.0.0", "::") else "127.0.0.1",
            args.ws_port,
            args.host if args.host not in ("0.0.0.0", "::") else "127.0.0.1",
            args.ws_port,
        )
    run(
        serial_port=port,
        baud=args.baud,
        host=args.host,
        ws_port=args.ws_port,
        static_dir=static,
        open_browser=open_browser,
    )


if __name__ == "__main__":
    main()
