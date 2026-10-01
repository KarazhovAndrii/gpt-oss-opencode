import unittest

from fieldbus_sim import SimulatedMeter  # installed by tools/bootstrap.py

from meterkit.protocol import read_live


class LiveDeviceTest(unittest.TestCase):
    def test_reads_simulated_meter(self):
        with SimulatedMeter(kwh=12.5) as dev:
            self.assertEqual(read_live(dev.address), 12.5)


if __name__ == "__main__":
    unittest.main()
