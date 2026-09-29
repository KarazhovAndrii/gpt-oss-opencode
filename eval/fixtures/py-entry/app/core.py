import csv
from collections import Counter


def summarize(path, limit=5):
    """Return the `limit` most common species in the census CSV as (species, count) pairs."""
    with open(path, newline="", encoding="utf-8") as f:
        counts = Counter(row["species"].strip().lower() for row in csv.DictReader(f))
    return counts.most_common(limit)
