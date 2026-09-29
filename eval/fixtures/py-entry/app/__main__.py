"""Command-line entry point: ``python -m app`` (installed as the ``zoo`` script)."""
import argparse
import sys

from app.core import summarize


def main(argv=None):
    parser = argparse.ArgumentParser(prog="zoo", description="Summarize a zoo census CSV.")
    parser.add_argument("csv", nargs="?", default="data/census.csv", help="census file to read")
    parser.add_argument("--limit", type=int, default=5, help="how many species to show")
    parser.add_argument("--format", choices=["text", "json"], default="text")
    args = parser.parse_args(argv)

    rows = summarize(args.csv, limit=args.limit)
    if args.format == "json":
        import json
        print(json.dumps(rows))
    else:
        for species, count in rows:
            print(f"{species:<12} {count:>5}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
