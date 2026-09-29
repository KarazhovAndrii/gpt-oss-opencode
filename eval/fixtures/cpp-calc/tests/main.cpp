#include <exception>
#include <iostream>
#include <string>

#include "check.hpp"

int main() {
  int failed = 0;
  for (const auto& test : check::registry()) {
    const int before = check::failures();
    try {
      test.fn();
    } catch (const std::exception& e) {
      check::fail(test.name, 0, std::string("unexpected exception: ") + e.what());
    } catch (...) {
      check::fail(test.name, 0, "unexpected exception");
    }
    const bool ok = check::failures() == before;
    if (!ok) ++failed;
    std::cout << (ok ? "ok    " : "FAIL  ") << test.name << "\n";
  }
  const auto total = static_cast<int>(check::registry().size());
  std::cout << "\n" << (total - failed) << " passed, " << failed << " failed\n";
  return failed == 0 ? 0 : 1;
}
