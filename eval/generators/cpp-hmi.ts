// Generates a synthetic instrument-cluster HMI code base (a few hundred C++ files) for the
// cpp-feature-search scenario: too large to read in full, with "speed" all over it. The value on
// the speed gauge reaches the screen through two indirections:
//   MainScreen (gauge "gauge.speed") -> GaugeBindings -> ClusterModel::displayedSpeedKmh()
//   <- m_displaySpeed, fed by the subscription to signals::kVehicleSpeedDisplayed ("VehicleSpeedDisplayed").
// Decoys: VehicleSpeedRaw (trip computer, a legacy speedometer that is not built), EngineSpeed (rpm),
// fan, wiper and cruise "speeds", animation/scroll speeds. Deterministic (seeded), so line numbers are stable.

import fs from "node:fs";
import path from "node:path";

/** The answer, for the scenario check. */
export const CPP_HMI = { file: "src/model/ClusterModel.cpp", marker: "subscribe(signals::kVehicleSpeedDisplayed", signal: "VehicleSpeedDisplayed" };

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const MODULES = [
  "Hvac", "Media", "Nav", "Phone", "Seat", "Mirror", "Lighting", "Wiper", "Door", "Window",
  "Tpms", "Parking", "Camera", "Climate", "Charging", "Battery", "Profile", "Settings", "Clock", "Weather",
  "Radio", "Bluetooth", "Voice", "Alerts", "Service", "Diagnostics", "Ota", "Theme", "Locale", "Brightness",
  "Ambient", "Sunroof", "Trunk", "Fuel", "Cruise", "LaneAssist", "SpeedLimitAssist", "Eco", "DriveMode", "Tow",
  "HillAssist", "RainSensor", "KeyFob", "Immobilizer", "Navigation3D",
];

// Module signals; a few mention "speed" on purpose.
const SPECIAL_SIGNALS: Record<string, [string, string][]> = {
  Hvac: [["kHvacFanSpeed", "HvacFanSpeed"], ["kHvacSetTemp", "HvacSetTemp"]],
  Wiper: [["kWiperSpeed", "WiperSpeedStage"], ["kWiperMode", "WiperMode"]],
  Cruise: [["kCruiseSetSpeed", "CruiseSetSpeed"], ["kCruiseState", "CruiseState"]],
  SpeedLimitAssist: [["kNavSpeedLimit", "NavSpeedLimit"], ["kSpeedLimitWarn", "SpeedLimitWarning"]],
  Tpms: [["kTyrePressureFL", "TyrePressureFL"], ["kWheelSpeedFL", "WheelSpeedFL"]],
};

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

export function generateCppHmi(repo: string, seed = 20261001): void {
  const r = rng(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const files = new Map<string, string>();
  const put = (rel: string, body: string) => files.set(rel, body.replace(/^\n/, ""));

  const moduleSignals = new Map<string, [string, string][]>();
  for (const m of MODULES) {
    const own: [string, string][] = SPECIAL_SIGNALS[m] ?? [
      [`k${m}State`, `${m}State`],
      [`k${m}Level`, `${m}Level`],
    ];
    moduleSignals.set(m, [...own, [`k${m}Fault`, `${m}Fault`]]);
  }

  // ---------------------------------------------------------------- core
  const coreSignals: [string, string, string][] = [
    ["kVehicleSpeedDisplayed", "VehicleSpeedDisplayed", "speed for the driver display (m/s), incl. the legal over-read margin"],
    ["kVehicleSpeedRaw", "VehicleSpeedRaw", "vehicle speed from the wheel sensors (m/s), unfiltered"],
    ["kEngineSpeed", "EngineSpeed", "crankshaft speed (rpm)"],
    ["kCoolantTemp", "CoolantTemp", "engine coolant temperature (degC)"],
    ["kFuelLevel", "FuelLevel", "fuel level (0..1)"],
    ["kOdometer", "OdometerKm", "total distance (km)"],
    ["kGearPosition", "GearPosition", "selected gear"],
    ["kOverspeedWarning", "OverspeedWarning", "speed above the configured warning threshold"],
    ["kOutsideTemp", "OutsideTemp", "outside air temperature (degC)"],
  ];
  const names = [
    "// Signal names on the vehicle bus (see docs/signals.md in the vehicle repo).",
    "#pragma once",
    "",
    "namespace dash::signals {",
    "",
    ...coreSignals.map(([c, n, d]) => `// ${d}\ninline constexpr const char* ${c} = "${n}";`),
    "",
    ...MODULES.flatMap((m) => moduleSignals.get(m)!.map(([c, n]) => `inline constexpr const char* ${c} = "${n}";`)),
    "",
    "}  // namespace dash::signals",
    "",
  ];
  put("src/core/SignalNames.hpp", names.join("\n"));
  put("src/core/Sample.hpp", `
#pragma once
#include <cstdint>

namespace dash {

struct Sample {
    double value = 0.0;
    std::uint64_t timestampUs = 0;
    bool valid = true;
};

}  // namespace dash
`);
  put("src/core/SignalBus.hpp", `
#pragma once
#include <functional>
#include <map>
#include <string>
#include <vector>

#include "core/Sample.hpp"

namespace dash {

// Dispatches decoded bus signals to subscribers by name.
class SignalBus {
public:
    using Handler = std::function<void(const Sample&)>;
    void subscribe(const std::string& name, Handler handler);
    void publish(const std::string& name, const Sample& sample);
    std::size_t subscriberCount(const std::string& name) const;

private:
    std::map<std::string, std::vector<Handler>> m_handlers;
};

}  // namespace dash
`);
  put("src/core/SignalBus.cpp", `
#include "core/SignalBus.hpp"

namespace dash {

void SignalBus::subscribe(const std::string& name, Handler handler) {
    m_handlers[name].push_back(std::move(handler));
}

void SignalBus::publish(const std::string& name, const Sample& sample) {
    auto it = m_handlers.find(name);
    if (it == m_handlers.end() || !sample.valid) return;
    for (auto& h : it->second) h(sample);
}

std::size_t SignalBus::subscriberCount(const std::string& name) const {
    auto it = m_handlers.find(name);
    return it == m_handlers.end() ? 0 : it->second.size();
}

}  // namespace dash
`);
  put("src/core/Filters.hpp", `
#pragma once

namespace dash {

// First-order low-pass filter used to smooth needle movement.
class LowPass {
public:
    explicit LowPass(double alpha) : m_alpha(alpha) {}
    void push(double x) { m_value = m_primed ? m_value + m_alpha * (x - m_value) : x; m_primed = true; }
    double value() const { return m_value; }
    void reset() { m_primed = false; m_value = 0.0; }

private:
    double m_alpha;
    double m_value = 0.0;
    bool m_primed = false;
};

// Limits how fast a displayed value may change per update.
class RateLimiter {
public:
    explicit RateLimiter(double maxStep) : m_maxStep(maxStep) {}
    double step(double target) {
        double d = target - m_value;
        if (d > m_maxStep) d = m_maxStep;
        if (d < -m_maxStep) d = -m_maxStep;
        m_value += d;
        return m_value;
    }

private:
    double m_maxStep;
    double m_value = 0.0;
};

}  // namespace dash
`);
  put("src/core/Units.hpp", `
#pragma once

namespace dash::units {

inline double mpsToKmh(double mps) { return mps * 3.6; }
inline double kmhToMph(double kmh) { return kmh * 0.621371; }
inline double kelvinToCelsius(double k) { return k - 273.15; }

}  // namespace dash::units
`);

  // --------------------------------------------------------------- models
  put("src/model/ClusterModel.hpp", `
#pragma once
#include "core/Filters.hpp"
#include "core/SignalBus.hpp"

namespace dash {

// Values shown on the main cluster screen.
class ClusterModel {
public:
    explicit ClusterModel(SignalBus& bus);
    void connectSignals();

    double displayedSpeedKmh() const;
    double fuelLevel() const { return m_fuel; }
    double outsideTempC() const { return m_outsideTemp; }
    int gear() const { return m_gear; }
    bool overspeed() const { return m_overspeed; }

private:
    SignalBus& m_bus;
    LowPass m_displaySpeed;
    double m_fuel = 0.0;
    double m_outsideTemp = 0.0;
    int m_gear = 0;
    bool m_overspeed = false;
};

}  // namespace dash
`);
  put("src/model/ClusterModel.cpp", `
#include "model/ClusterModel.hpp"

#include "core/SignalNames.hpp"
#include "core/Units.hpp"

namespace dash {

namespace {
// Needle smoothing; tuned on the 12.3" cluster (see HMI-2291).
constexpr double kSpeedNeedleAlpha = 0.35;
}  // namespace

ClusterModel::ClusterModel(SignalBus& bus) : m_bus(bus), m_displaySpeed(kSpeedNeedleAlpha) {}

void ClusterModel::connectSignals() {
    m_bus.subscribe(signals::kFuelLevel, [this](const Sample& s) { m_fuel = s.value; });
    m_bus.subscribe(signals::kOutsideTemp, [this](const Sample& s) { m_outsideTemp = s.value; });
    m_bus.subscribe(signals::kGearPosition, [this](const Sample& s) { m_gear = static_cast<int>(s.value); });

    // The displayed speed is the value the vehicle computes for the driver display; it already
    // contains the legal over-read margin, so it must not be derived from the raw wheel speed here.
    m_bus.subscribe(signals::kVehicleSpeedDisplayed, [this](const Sample& s) {
        m_displaySpeed.push(units::mpsToKmh(s.value));
    });

    m_bus.subscribe(signals::kOverspeedWarning, [this](const Sample& s) { m_overspeed = s.value > 0.5; });
}

double ClusterModel::displayedSpeedKmh() const {
    return m_displaySpeed.value();
}

}  // namespace dash
`);
  put("src/model/TripModel.hpp", `
#pragma once
#include "core/SignalBus.hpp"

namespace dash {

// Trip computer: distance and average speed since reset.
class TripModel {
public:
    explicit TripModel(SignalBus& bus);
    void connectSignals();
    void reset();
    double distanceKm() const { return m_distanceKm; }
    double averageSpeedKmh() const;

private:
    SignalBus& m_bus;
    double m_distanceKm = 0.0;
    double m_seconds = 0.0;
    std::uint64_t m_lastUs = 0;
};

}  // namespace dash
`);
  put("src/model/TripModel.cpp", `
#include "model/TripModel.hpp"

#include "core/SignalNames.hpp"
#include "core/Units.hpp"

namespace dash {

TripModel::TripModel(SignalBus& bus) : m_bus(bus) {}

void TripModel::connectSignals() {
    // Integrate the raw wheel-based speed: the display speed has an over-read margin.
    m_bus.subscribe(signals::kVehicleSpeedRaw, [this](const Sample& s) {
        if (m_lastUs != 0) {
            double dt = (s.timestampUs - m_lastUs) / 1e6;
            m_distanceKm += units::mpsToKmh(s.value) * dt / 3600.0;
            m_seconds += dt;
        }
        m_lastUs = s.timestampUs;
    });
}

void TripModel::reset() {
    m_distanceKm = 0.0;
    m_seconds = 0.0;
    m_lastUs = 0;
}

double TripModel::averageSpeedKmh() const {
    return m_seconds > 0 ? m_distanceKm / (m_seconds / 3600.0) : 0.0;
}

}  // namespace dash
`);
  put("src/model/PowertrainModel.hpp", `
#pragma once
#include "core/Filters.hpp"
#include "core/SignalBus.hpp"

namespace dash {

class PowertrainModel {
public:
    explicit PowertrainModel(SignalBus& bus);
    void connectSignals();
    double engineRpm() const { return m_rpm.value(); }
    double coolantTempC() const { return m_coolant; }

private:
    SignalBus& m_bus;
    LowPass m_rpm{0.5};
    double m_coolant = 0.0;
};

}  // namespace dash
`);
  put("src/model/PowertrainModel.cpp", `
#include "model/PowertrainModel.hpp"

#include "core/SignalNames.hpp"

namespace dash {

PowertrainModel::PowertrainModel(SignalBus& bus) : m_bus(bus) {}

void PowertrainModel::connectSignals() {
    // Engine speed is the crankshaft speed in rpm (the tachometer), not the vehicle speed.
    m_bus.subscribe(signals::kEngineSpeed, [this](const Sample& s) { m_rpm.push(s.value); });
    m_bus.subscribe(signals::kCoolantTemp, [this](const Sample& s) { m_coolant = s.value; });
}

}  // namespace dash
`);

  // ------------------------------------------------------------- bindings
  put("src/bindings/GaugeBindings.hpp", `
#pragma once
#include <functional>
#include <map>
#include <string>

namespace dash {

class ClusterModel;
class TripModel;
class PowertrainModel;

// Maps gauge ids used by the screens to the model values they display.
class GaugeBindings {
public:
    using Source = std::function<double()>;
    GaugeBindings(const ClusterModel& cluster, const TripModel& trip, const PowertrainModel& powertrain);
    Source source(const std::string& gaugeId) const;

private:
    std::map<std::string, Source> m_sources;
};

}  // namespace dash
`);
  put("src/bindings/GaugeBindings.cpp", `
#include "bindings/GaugeBindings.hpp"

#include "model/ClusterModel.hpp"
#include "model/PowertrainModel.hpp"
#include "model/TripModel.hpp"

namespace dash {

GaugeBindings::GaugeBindings(const ClusterModel& cluster, const TripModel& trip, const PowertrainModel& powertrain) {
    m_sources["gauge.speed"] = [&cluster] { return cluster.displayedSpeedKmh(); };
    m_sources["gauge.rpm"] = [&powertrain] { return powertrain.engineRpm(); };
    m_sources["gauge.coolant"] = [&powertrain] { return powertrain.coolantTempC(); };
    m_sources["gauge.fuel"] = [&cluster] { return cluster.fuelLevel(); };
    m_sources["tripinfo.distance"] = [&trip] { return trip.distanceKm(); };
    m_sources["tripinfo.avg_speed"] = [&trip] { return trip.averageSpeedKmh(); };
}

GaugeBindings::Source GaugeBindings::source(const std::string& gaugeId) const {
    auto it = m_sources.find(gaugeId);
    if (it == m_sources.end()) return [] { return 0.0; };
    return it->second;
}

}  // namespace dash
`);

  // ------------------------------------------------------------------- ui
  put("src/ui/widgets/Gauge.hpp", `
#pragma once
#include <functional>
#include <string>

#include "ui/widgets/Widget.hpp"

namespace dash {

enum class GaugeStyle { Large, Small, Bar };

// Needle or bar gauge; reads its value from a source function on every frame.
class Gauge : public Widget {
public:
    Gauge(std::string id, GaugeStyle style);
    void setRange(double min, double max);
    void setUnitLabel(std::string label);
    void setSource(std::function<double()> source);
    void paint(Painter& p) override;

private:
    std::string m_id;
    GaugeStyle m_style;
    double m_min = 0.0;
    double m_max = 100.0;
    std::string m_unit;
    std::function<double()> m_source;
};

}  // namespace dash
`);
  put("src/ui/widgets/Gauge.cpp", `
#include "ui/widgets/Gauge.hpp"

#include <algorithm>

namespace dash {

Gauge::Gauge(std::string id, GaugeStyle style) : m_id(std::move(id)), m_style(style) {}

void Gauge::setRange(double min, double max) { m_min = min; m_max = max; }
void Gauge::setUnitLabel(std::string label) { m_unit = std::move(label); }
void Gauge::setSource(std::function<double()> source) { m_source = std::move(source); }

void Gauge::paint(Painter& p) {
    double v = m_source ? m_source() : 0.0;
    double t = (std::clamp(v, m_min, m_max) - m_min) / (m_max - m_min);
    if (m_style == GaugeStyle::Bar) p.drawBar(rect(), t);
    else p.drawNeedle(rect(), t, m_style == GaugeStyle::Large ? 270.0 : 180.0);
    p.drawText(rect().bottomCenter(), formatValue(v) + " " + m_unit);
}

}  // namespace dash
`);
  put("src/ui/widgets/Widget.hpp", `
#pragma once
#include <string>
#include <vector>

#include "ui/widgets/Painter.hpp"

namespace dash {

class Widget {
public:
    virtual ~Widget() = default;
    virtual void paint(Painter& p) = 0;
    Rect rect() const { return m_rect; }
    void setRect(Rect r) { m_rect = r; }
    void setAnimationSpeed(double factor) { m_animationSpeed = factor; }

protected:
    static std::string formatValue(double v);
    Rect m_rect;
    double m_animationSpeed = 1.0;
};

}  // namespace dash
`);
  put("src/ui/widgets/Painter.hpp", `
#pragma once
#include <string>

namespace dash {

struct Point { int x = 0, y = 0; };
struct Rect {
    int x = 0, y = 0, w = 0, h = 0;
    Point bottomCenter() const { return {x + w / 2, y + h}; }
};

class Painter {
public:
    virtual ~Painter() = default;
    virtual void drawNeedle(Rect r, double t, double sweepDeg) = 0;
    virtual void drawBar(Rect r, double t) = 0;
    virtual void drawText(Point at, const std::string& text) = 0;
};

}  // namespace dash
`);
  put("src/ui/screens/MainScreen.hpp", `
#pragma once
#include "bindings/GaugeBindings.hpp"
#include "ui/screens/Screen.hpp"
#include "ui/widgets/Gauge.hpp"

namespace dash {

class MainScreen : public Screen {
public:
    explicit MainScreen(const GaugeBindings& bindings) : m_bindings(bindings) {}
    void build() override;

private:
    const GaugeBindings& m_bindings;
    Gauge* m_speedGauge = nullptr;
    Gauge* m_rpmGauge = nullptr;
    Gauge* m_fuelGauge = nullptr;
    Gauge* m_coolantGauge = nullptr;
};

}  // namespace dash
`);
  put("src/ui/screens/MainScreen.cpp", `
#include "ui/screens/MainScreen.hpp"

#include "ui/i18n/Tr.hpp"

namespace dash {

void MainScreen::build() {
    m_speedGauge = addChild<Gauge>("gauge.speed", GaugeStyle::Large);
    m_speedGauge->setRange(0, 260);
    m_speedGauge->setUnitLabel(tr("km/h"));
    m_speedGauge->setSource(m_bindings.source("gauge.speed"));

    m_rpmGauge = addChild<Gauge>("gauge.rpm", GaugeStyle::Large);
    m_rpmGauge->setRange(0, 8000);
    m_rpmGauge->setUnitLabel(tr("rpm"));
    m_rpmGauge->setSource(m_bindings.source("gauge.rpm"));

    m_fuelGauge = addChild<Gauge>("gauge.fuel", GaugeStyle::Bar);
    m_fuelGauge->setSource(m_bindings.source("gauge.fuel"));

    m_coolantGauge = addChild<Gauge>("gauge.coolant", GaugeStyle::Small);
    m_coolantGauge->setRange(40, 130);
    m_coolantGauge->setSource(m_bindings.source("gauge.coolant"));
}

}  // namespace dash
`);
  put("src/ui/screens/TripScreen.cpp", `
#include "ui/screens/TripScreen.hpp"

#include "ui/i18n/Tr.hpp"

namespace dash {

void TripScreen::build() {
    auto* distance = addChild<Gauge>("tripinfo.distance", GaugeStyle::Small);
    distance->setUnitLabel(tr("km"));
    distance->setSource(m_bindings.source("tripinfo.distance"));

    auto* avgSpeed = addChild<Gauge>("tripinfo.avg_speed", GaugeStyle::Small);
    avgSpeed->setUnitLabel(tr("km/h"));
    avgSpeed->setSource(m_bindings.source("tripinfo.avg_speed"));
}

}  // namespace dash
`);
  put("src/ui/legacy/LegacySpeedometer.cpp", `
// Speedometer of the old 7" cluster variant. Superseded by Gauge + GaugeBindings (see
// ui/screens/MainScreen.cpp); kept for reference and NOT part of the build (see CMakeLists.txt).
#include "ui/legacy/LegacySpeedometer.hpp"

#include "core/SignalNames.hpp"
#include "core/Units.hpp"

namespace dash::legacy {

void LegacySpeedometer::attach(SignalBus& bus) {
    bus.subscribe(signals::kVehicleSpeedRaw, [this](const Sample& s) {
        m_kmh = units::mpsToKmh(s.value);
        invalidate();
    });
}

}  // namespace dash::legacy
`);
  put("src/app/main.cpp", `
#include "app/ClusterApp.hpp"

int main(int argc, char** argv) {
    dash::ClusterApp app(argc, argv);
    return app.run();
}
`);
  put("src/app/ClusterApp.cpp", `
#include "app/ClusterApp.hpp"

#include "bindings/GaugeBindings.hpp"
#include "model/ClusterModel.hpp"
#include "model/PowertrainModel.hpp"
#include "model/TripModel.hpp"
#include "ui/screens/MainScreen.hpp"
#include "ui/screens/TripScreen.hpp"

namespace dash {

int ClusterApp::run() {
    ClusterModel cluster(m_bus);
    TripModel trip(m_bus);
    PowertrainModel powertrain(m_bus);
    cluster.connectSignals();
    trip.connectSignals();
    powertrain.connectSignals();
    connectModules();

    GaugeBindings bindings(cluster, trip, powertrain);
    MainScreen main(bindings);
    TripScreen tripScreen(bindings);
    main.build();
    tripScreen.build();
    return m_loop.exec({&main, &tripScreen});
}

}  // namespace dash
`);

  // -------------------------------------------------- generated modules
  const sources: string[] = [];
  for (const m of MODULES) {
    const dir = `src/modules/${snake(m)}`;
    const sigs = moduleSignals.get(m)!;
    // Signal suffix without the module name: kHvacFanSpeed -> FanSpeed, kWheelSpeedFL -> WheelSpeedFL.
    const sfx = (c: string) => (c.startsWith(`k${m}`) ? c.slice(1 + m.length) : c.slice(1)) || "Value";
    const members = sigs.map(([c]) => `m_${c.slice(1, 2).toLowerCase()}${c.slice(2)}`);
    const anim = (0.5 + r() * 1.5).toFixed(2);
    const scroll = Math.floor(80 + r() * 400);
    put(`${dir}/${m}Controller.hpp`, `
#pragma once
#include "core/SignalBus.hpp"
#include "modules/${snake(m)}/${m}View.hpp"

namespace dash::${snake(m)} {

class ${m}Controller {
public:
    ${m}Controller(SignalBus& bus, ${m}View& view);
    void connectSignals();
    void onUserAction(int action);

private:
    SignalBus& m_bus;
    ${m}View& m_view;
${members.map((x) => `    double ${x} = 0.0;`).join("\n")}
};

}  // namespace dash::${snake(m)}
`);
    put(`${dir}/${m}Controller.cpp`, `
#include "modules/${snake(m)}/${m}Controller.hpp"

#include "core/SignalNames.hpp"

namespace dash::${snake(m)} {

namespace {
constexpr double kAnimationSpeed = ${anim};
}  // namespace

${m}Controller::${m}Controller(SignalBus& bus, ${m}View& view) : m_bus(bus), m_view(view) {
    m_view.setAnimationSpeed(kAnimationSpeed);
}

void ${m}Controller::connectSignals() {
${sigs.map(([c], i) => `    m_bus.subscribe(signals::${c}, [this](const Sample& s) {\n        ${members[i]} = s.value;\n        m_view.update${sfx(c)}(s.value);\n    });`).join("\n")}
}

void ${m}Controller::onUserAction(int action) {
    switch (action) {
    case 0: m_view.showDetails(); break;
    case 1: m_view.hideDetails(); break;
    default: break;
    }
}

}  // namespace dash::${snake(m)}
`);
    put(`${dir}/${m}View.hpp`, `
#pragma once
#include "ui/widgets/Widget.hpp"

namespace dash::${snake(m)} {

class ${m}View : public Widget {
public:
    void paint(Painter& p) override;
${sigs.map(([c]) => `    void update${sfx(c)}(double v);`).join("\n")}
    void showDetails();
    void hideDetails();

private:
    bool m_details = false;
    int m_scrollSpeedPxPerSec = ${scroll};
${sigs.map(([c]) => `    double m_${sfx(c).toLowerCase()} = 0.0;`).join("\n")}
};

}  // namespace dash::${snake(m)}
`);
    put(`${dir}/${m}View.cpp`, `
#include "modules/${snake(m)}/${m}View.hpp"

namespace dash::${snake(m)} {

void ${m}View::paint(Painter& p) {
    if (!m_details) return;
    p.drawText(rect().bottomCenter(), formatValue(m_${sfx(sigs[0][0]).toLowerCase()}));
}

${sigs.map(([c]) => `void ${m}View::update${sfx(c)}(double v) { m_${sfx(c).toLowerCase()} = v; }`).join("\n")}

void ${m}View::showDetails() { m_details = true; }
void ${m}View::hideDetails() { m_details = false; }

}  // namespace dash::${snake(m)}
`);
    const settings = Array.from({ length: 4 + Math.floor(r() * 6) }, (_, i) => `    {"${snake(m)}.option${i}", ${Math.floor(r() * 100)}},`);
    put(`${dir}/${m}Settings.cpp`, `
#include <map>
#include <string>

namespace dash::${snake(m)} {

// Factory defaults; overridden by the vehicle profile.
const std::map<std::string, int>& defaults() {
    static const std::map<std::string, int> values = {
${settings.join("\n")}
        {"${snake(m)}.transition_speed", ${Math.floor(1 + r() * 9)}},
    };
    return values;
}

}  // namespace dash::${snake(m)}
`);
    const words = ["Status", "Details", "Error", "Ready", "Off", "On", "Level", "Mode", "Speed", "Auto"];
    put(`${dir}/${m}Strings.cpp`, `
#include "ui/i18n/Tr.hpp"

namespace dash::${snake(m)} {

void registerStrings(Catalog& c) {
${Array.from({ length: 5 }, () => pick(words)).map((w, i) => `    c.add("${snake(m)}.${w.toLowerCase()}${i}", "${m.replace(/([a-z])([A-Z])/g, "$1 $2")} ${w.toLowerCase()}");`).join("\n")}
}

}  // namespace dash::${snake(m)}
`);
    sources.push(`${dir}/${m}Controller.cpp`, `${dir}/${m}View.cpp`, `${dir}/${m}Settings.cpp`, `${dir}/${m}Strings.cpp`);
  }

  const built = [...files.keys()].filter((f) => f.endsWith(".cpp") && !f.startsWith("src/ui/legacy/"));
  put("CMakeLists.txt", `
cmake_minimum_required(VERSION 3.20)
project(dash_cluster CXX)
set(CMAKE_CXX_STANDARD 17)

# src/ui/legacy is not built (old 7" cluster variant).
add_executable(dash_cluster
${built.sort().map((f) => `    ${f}`).join("\n")}
)
target_include_directories(dash_cluster PRIVATE src)
`);

  for (const [rel, body] of files) {
    const full = path.join(repo, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
}
