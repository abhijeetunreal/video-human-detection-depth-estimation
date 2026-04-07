"""Pick a likely Arduino / USB-serial port without user input."""

from __future__ import annotations

import re
from typing import NamedTuple

from serial.tools import list_ports


class PortCandidate(NamedTuple):
    device: str
    description: str
    score: int


def _com_sort_key(device: str) -> tuple[int, int]:
    """Sort COM10 after COM9 on Windows."""
    m = re.search(r"(\d+)\s*$", device)
    if m:
        return (0, int(m.group(1)))
    return (1, 0)


def _score_port(description: str, manufacturer: str | None, hwid: str) -> int:
    blob = f"{description} {manufacturer or ''} {hwid}".upper()
    score = 0
    if "ARDUINO" in blob:
        score += 120
    if "WCH.CN" in blob:
        score += 85
    if "CH340" in blob or "CH341" in blob or "CH9102" in blob:
        score += 85
    if "FTDI" in blob or "FT232" in blob or "VID:PID=0403" in blob.replace(" ", ""):
        score += 75
    if "CP210" in blob or "SILICON LABS" in blob or "10C4:EA60" in blob.upper():
        score += 75
    if "USB SERIAL" in blob or "USB-SERIAL" in blob:
        score += 55
    # Common Arduino USB-CDC style
    if "2341" in blob and ("PID" in blob or "VID" in blob):
        score += 100
    if "BLUETOOTH" in blob:
        score -= 80
    if "VIRTUAL" in blob and "COM" in blob:
        score -= 40
    return score


def detect_serial_port(*, allow_single_fallback: bool = True) -> tuple[str | None, str]:
    """
    Returns (device, message). device is None if ambiguous or nothing found.
    """
    ports = list(list_ports.comports())
    if not ports:
        return None, "No serial ports found. Connect the Arduino via USB."

    candidates: list[PortCandidate] = []
    for p in ports:
        desc = (p.description or "").strip()
        man = p.manufacturer
        hwid = p.hwid or ""
        s = _score_port(desc, man, hwid)
        candidates.append(PortCandidate(p.device, desc, s))

    positive = [c for c in candidates if c.score > 0]
    positive.sort(key=lambda c: (-c.score, _com_sort_key(c.device)))

    if len(positive) == 1:
        c = positive[0]
        return c.device, f"Auto-selected {c.device} ({c.description})"

    if len(positive) > 1:
        best_score = positive[0].score
        tied = [c for c in positive if c.score == best_score]
        if len(tied) == 1:
            c = tied[0]
            return c.device, f"Auto-selected {c.device} ({c.description})"
        lines = "\n".join(f"  {c.device} — {c.description}" for c in tied)
        return (
            None,
            "Multiple USB serial devices match; specify one:\n"
            + lines
            + "\n\nUse: run_bridge.bat --port COMn",
        )

    if allow_single_fallback and len(candidates) == 1:
        c = candidates[0]
        return (
            c.device,
            f"Only one serial port found; using {c.device} ({c.description})",
        )

    lines = "\n".join(
        f"  {c.device} — {c.description} (score {c.score})" for c in candidates
    )
    return (
        None,
        "Could not guess Arduino port. Connect the board or pass --port:\n"
        + lines
        + "\n\nUse: run_bridge.bat --port COMn",
    )
