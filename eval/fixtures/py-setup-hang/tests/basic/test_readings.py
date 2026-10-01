import unittest
from datetime import datetime

from meterkit import Reading, daily_totals, parse_reading, total_kwh


class ParseReadingTest(unittest.TestCase):
    def test_parses_fields(self):
        r = parse_reading("M-17, 2026-03-02T08:15:00, 1.25")
        self.assertEqual(r, Reading("M-17", datetime(2026, 3, 2, 8, 15), 1.25))

    def test_rejects_wrong_field_count(self):
        with self.assertRaises(ValueError):
            parse_reading("M-17,2026-03-02T08:15:00")

    def test_rejects_negative_consumption(self):
        with self.assertRaises(ValueError):
            parse_reading("M-17,2026-03-02T08:15:00,-3")

    def test_rejects_empty_meter_id(self):
        with self.assertRaises(ValueError):
            parse_reading(" ,2026-03-02T08:15:00,1")


class AggregateTest(unittest.TestCase):
    rows = [
        "M-1,2026-03-01T23:00:00,0.5",
        "M-1,2026-03-02T01:00:00,0.25",
        "M-2,2026-03-02T02:00:00,1.0",
    ]

    def test_total(self):
        self.assertEqual(total_kwh([parse_reading(x) for x in self.rows]), 1.75)

    def test_daily_totals(self):
        self.assertEqual(daily_totals([parse_reading(x) for x in self.rows]), {"2026-03-01": 0.5, "2026-03-02": 1.25})


if __name__ == "__main__":
    unittest.main()
