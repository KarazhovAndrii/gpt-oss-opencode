// Minimal unit-test framework.
//
//   TEST(name) { ... }             defines and registers a test (name must be a unique identifier in its file)
//   CHECK(cond)                    fails if cond is false
//   CHECK_EQ(a, b)                 fails if !(a == b); both values are printed (they need operator<<)
//   CHECK_NEAR(a, b, eps)          fails if |a - b| > eps
//   CHECK_THROWS(expr, Type)       fails unless evaluating expr throws Type (or a subclass)
//
// A failed check reports file:line and continues with the rest of the test.
// tests/main.cpp runs every registered test.
#pragma once

#include <cmath>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

namespace check {

struct TestCase {
  const char* name;
  void (*fn)();
};

inline std::vector<TestCase>& registry() {
  static std::vector<TestCase> tests;
  return tests;
}

inline int& failures() {
  static int count = 0;
  return count;
}

struct Registrar {
  Registrar(const char* name, void (*fn)()) { registry().push_back({name, fn}); }
};

inline void fail(const char* file, int line, const std::string& message) {
  ++failures();
  std::cout << file << ":" << line << ": FAILED: " << message << "\n";
}

}  // namespace check

#define CHECK_CONCAT_(a, b) a##b
#define CHECK_CONCAT(a, b) CHECK_CONCAT_(a, b)

#define TEST(name)                                                            \
  static void name();                                                         \
  static ::check::Registrar CHECK_CONCAT(name, _registrar_)(#name, &name); \
  static void name()

#define CHECK(cond)                                                         \
  do {                                                                      \
    if (!(cond)) ::check::fail(__FILE__, __LINE__, "CHECK(" #cond ")");     \
  } while (0)

#define CHECK_EQ(a, b)                                                                  \
  do {                                                                                  \
    const auto& check_a_ = (a);                                                         \
    const auto& check_b_ = (b);                                                         \
    if (!(check_a_ == check_b_)) {                                                      \
      std::ostringstream check_os_;                                                     \
      check_os_ << "CHECK_EQ(" #a ", " #b "): " << check_a_ << " != " << check_b_;       \
      ::check::fail(__FILE__, __LINE__, check_os_.str());                               \
    }                                                                                   \
  } while (0)

#define CHECK_NEAR(a, b, eps)                                                           \
  do {                                                                                  \
    const double check_a_ = (a);                                                        \
    const double check_b_ = (b);                                                        \
    if (!(std::fabs(check_a_ - check_b_) <= (eps))) {                                   \
      std::ostringstream check_os_;                                                     \
      check_os_ << "CHECK_NEAR(" #a ", " #b "): " << check_a_ << " vs " << check_b_;    \
      ::check::fail(__FILE__, __LINE__, check_os_.str());                               \
    }                                                                                   \
  } while (0)

#define CHECK_THROWS(expr, Type)                                                        \
  do {                                                                                  \
    bool check_thrown_ = false;                                                         \
    try {                                                                               \
      (void)(expr);                                                                     \
    } catch (const Type&) {                                                             \
      check_thrown_ = true;                                                             \
    } catch (...) {                                                                     \
    }                                                                                   \
    if (!check_thrown_) ::check::fail(__FILE__, __LINE__, "CHECK_THROWS(" #expr ", " #Type ")"); \
  } while (0)
