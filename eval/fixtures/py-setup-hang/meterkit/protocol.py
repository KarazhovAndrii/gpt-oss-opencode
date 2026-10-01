"""Live device access. Needs the meter-protocol package (see requirements-dev.txt)."""
import meter_protocol  # noqa: F401  (installed by tools/bootstrap.py)


def read_live(device: str) -> float:
    return meter_protocol.Client(device).read_kwh()
