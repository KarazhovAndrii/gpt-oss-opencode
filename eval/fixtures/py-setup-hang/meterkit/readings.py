"""Meter readings: one CSV line per reading, `meter_id,timestamp,kwh`."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True)
class Reading:
    meter_id: str
    at: datetime
    kwh: float


def parse_reading(line: str) -> Reading:
    parts = [p.strip() for p in line.split(",")]
    if len(parts) != 3:
        raise ValueError(f"expected 3 fields, got {len(parts)}: {line!r}")
    meter_id, ts, kwh = parts
    if not meter_id:
        raise ValueError("empty meter id")
    value = float(kwh)
    if value < 0:
        raise ValueError(f"negative consumption: {value}")
    return Reading(meter_id, datetime.fromisoformat(ts), value)


def total_kwh(readings: list[Reading]) -> float:
    return round(sum(r.kwh for r in readings), 3)


def daily_totals(readings: list[Reading]) -> dict[str, float]:
    out: dict[str, float] = {}
    for r in readings:
        day = r.at.date().isoformat()
        out[day] = round(out.get(day, 0.0) + r.kwh, 3)
    return out
