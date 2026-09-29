// Hidden acceptance test for the cpp-evaluator scenario (never shown to the agent).
// Compiled by the harness against the agent's include/ and src/. Run with one group
// name; prints one line per failed expectation and exits non-zero if any failed.
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <exception>
#include <string>

#include "calc/eval.hpp"

using calc::Env;
using calc::EvalError;
using calc::ParseError;

static int failures = 0;

static void failf(const char* expr, const std::string& what) {
  ++failures;
  std::printf("  \"%s\": %s\n", expr, what.c_str());
}

static void value(const char* expr, double want, const Env& env = {}) {
  try {
    const double got = calc::evaluate(expr, env);
    if (!(std::fabs(got - want) <= 1e-9 * std::max(1.0, std::fabs(want)))) failf(expr, "got " + std::to_string(got) + ", want " + std::to_string(want));
  } catch (const ParseError& e) {
    failf(expr, std::string("ParseError(") + std::to_string(e.position()) + "): " + e.what());
  } catch (const std::exception& e) {
    failf(expr, std::string("threw: ") + e.what());
  }
}

static void parse_error(const char* expr, std::size_t pos) {
  try {
    const double got = calc::evaluate(expr, {});
    failf(expr, "returned " + std::to_string(got) + ", want ParseError at " + std::to_string(pos));
  } catch (const ParseError& e) {
    if (e.position() != pos) failf(expr, "ParseError at " + std::to_string(e.position()) + ", want " + std::to_string(pos));
  } catch (const std::exception& e) {
    failf(expr, std::string("threw another exception (") + e.what() + "), want ParseError at " + std::to_string(pos));
  }
}

static void eval_error(const char* expr, const Env& env = {}) {
  try {
    const double got = calc::evaluate(expr, env);
    failf(expr, "returned " + std::to_string(got) + ", want EvalError");
  } catch (const EvalError&) {
  } catch (const ParseError& e) {
    failf(expr, "ParseError(" + std::to_string(e.position()) + "), want EvalError");
  } catch (const std::exception& e) {
    failf(expr, std::string("threw another exception (") + e.what() + "), want EvalError");
  }
}

static void precedence() {
  value("1 + 2 * 3", 7);
  value("(1 + 2) * 3", 9);
  value("10 - 4 - 3", 3);
  value("100 / 10 / 5", 2);
  value("8 % 3 * 2", 4);
  value("7.5 % 2", 1.5);
  value("-7 % 3", -1);
  value("2 ^ 3 ^ 2", 512);
  value("2 ^ 3 * 2", 16);
  value("1 + 2 * 3 ^ 2", 19);
  value("-2 ^ 2", -4);
  value("2 ^ -1", 0.5);
  value("--3", 3);
  value("+4", 4);
  value("2 * -3", -6);
  value("-(2 + 3) * 2", -10);
  value("((((1))))", 1);
  value("  1 +\t2  ", 3);
}

static void variables_functions() {
  const Env env{{"x", 3}, {"y", 4}, {"_rate2", 0.5}};
  value("x * y + 1", 13, env);
  value("_rate2 * 10", 5, env);
  value("sqrt(x ^ 2 + y ^ 2)", 5, env);
  value("max(1, 5, 3)", 5);
  value("min(3, -1, 2)", -1);
  value("min(4)", 4);
  value("max(-1)", -1);
  value("abs(-2.5)", 2.5);
  value("sqrt(16)", 4);
  value("max(2, min(8, 3) * 2)", 6);
  value("abs(x - y) + max(x, y)", 5, env);
}

static void numbers() {
  value("2.5E-3 * 2", 0.005);
  value("1.5e-3", 0.0015);
  value("6e+2", 600);
  value("1e3 + 1", 1001);
  value(".5 + .25", 0.75);
  value("3.0", 3);
}

static void parse_errors() {
  parse_error("", 0);
  parse_error("   ", 3);
  parse_error("1 +", 3);
  parse_error("(1 + 2", 6);
  parse_error("1 2", 2);
  parse_error(")", 0);
  parse_error("1 + * 2", 4);
  parse_error("2 * (3 + 4))", 11);
  parse_error("max(1,)", 6);
  parse_error("1 $ 2", 2);
  parse_error("1 / 0 +", 7);
  parse_error("nope(1", 6);
  parse_error("unknown_var 5", 12);
}

// Each error case is paired with a near-identical valid expression, so an
// implementation that throws EvalError for everything does not pass.
static void eval_errors() {
  eval_error("foo + 1");
  value("foo + 1", 2, {{"foo", 1}});
  eval_error("x", {});
  eval_error("bar(1)");
  eval_error("1 / 0");
  value("1 / 4", 0.25);
  eval_error("5 % 0");
  value("5 % 4", 1);
  eval_error("1 / (x - 2)", {{"x", 2}});
  value("1 / (x - 2)", 1, {{"x", 3}});
  eval_error("sqrt(-1)");
  value("sqrt(0)", 0);
  eval_error("min()");
  eval_error("sqrt()");
  eval_error("abs(1, 2)");
  value("abs(-1)", 1);
}

int main(int argc, char** argv) {
  const char* group = argc > 1 ? argv[1] : "";
  if (!std::strcmp(group, "precedence")) precedence();
  else if (!std::strcmp(group, "variables-functions")) variables_functions();
  else if (!std::strcmp(group, "numbers")) numbers();
  else if (!std::strcmp(group, "parse-errors")) parse_errors();
  else if (!std::strcmp(group, "eval-errors")) eval_errors();
  else {
    std::printf("unknown group '%s'\n", group);
    return 2;
  }
  std::printf("%s: %d failure(s)\n", group, failures);
  return failures == 0 ? 0 : 1;
}
