# dash-cluster

Instrument cluster HMI for the 12.3" driver display.

- `src/core` – signal bus, filters, units
- `src/model` – values derived from vehicle signals
- `src/ui` – widgets and screens
- `src/modules` – feature modules (HVAC, media, navigation, ...)

Build: `cmake -B build && cmake --build build`
