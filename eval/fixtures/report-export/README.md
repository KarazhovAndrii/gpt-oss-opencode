# incident-export

Nightly export of the incident tracker. `data/report.json` is regenerated every night
by the tracker's export job; do not edit it by hand.

Format: `{"export": {...metadata...}, "items": [ {incident}, ... ]}`.
