"""Cache janitor CLI: removes stale cache files."""
import argparse
import os
import time

CACHE_DIR = os.path.expanduser("~/.cache/janitor-demo")
MAX_AGE_DAYS = 14


def stale_files(root, max_age_days):
    cutoff = time.time() - max_age_days * 86400
    for dirpath, _dirs, files in os.walk(root):
        for name in files:
            path = os.path.join(dirpath, name)
            if os.path.getmtime(path) < cutoff:
                yield path


def main(argv=None):
    p = argparse.ArgumentParser(prog="janitor")
    p.add_argument("--dry-run", action="store_true", help="only report what would be removed")
    p.add_argument("--days", type=int, default=MAX_AGE_DAYS)
    args = p.parse_args(argv)
    victims = list(stale_files(CACHE_DIR, args.days))
    if args.dry_run:
        for v in victims:
            print(f"would remove {v}")
        print(f"{len(victims)} file(s) older than {args.days} days would be removed (dry run, nothing deleted)")
        return 0
    for v in victims:
        os.remove(v)
    print(f"removed {len(victims)} file(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
