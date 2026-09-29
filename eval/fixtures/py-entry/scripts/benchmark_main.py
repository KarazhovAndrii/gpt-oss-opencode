"""Micro-benchmark harness for app.core.summarize. Not part of the application."""
import time

from app.core import summarize


def main():
    t0 = time.perf_counter()
    for _ in range(100):
        summarize("data/census.csv")
    print(f"100 runs in {time.perf_counter() - t0:.3f}s")


if __name__ == "__main__":
    main()
