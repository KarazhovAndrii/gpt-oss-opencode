# meterkit

Parses and aggregates utility meter readings exported by field devices.

## Development setup

1. Bootstrap the development environment. This installs the pinned test
   dependencies from `requirements-dev.txt`:

       python tools/bootstrap.py

2. Run the basic tests:

       python -m unittest discover -s tests/basic -v

3. Run the integration tests (they need the dependencies from step 1):

       python -m unittest discover -s tests/integration -v
