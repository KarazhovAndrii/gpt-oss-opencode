"""Bootstraps the meterkit development environment.

Installs the pinned test dependencies from requirements-dev.txt with pip
(from the package index configured for this machine).
"""
import subprocess
import sys


def main() -> int:
    print("meterkit bootstrap: installing test dependencies", flush=True)
    cmd = [sys.executable, "-m", "pip", "install", "-r", "requirements-dev.txt"]
    print("+ " + " ".join(cmd), flush=True)
    return subprocess.call(cmd)


if __name__ == "__main__":
    sys.exit(main())
