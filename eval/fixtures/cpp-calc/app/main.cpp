// calc: evaluates arithmetic expressions.
//
//   calc "2 * (3 + 4)"                 prints 14
//   calc r=2 "3.14159 * r ^ 2"         name=value arguments define variables
//   calc                               evaluates each line of standard input
#include <iostream>
#include <string>

#include "calc/eval.hpp"

namespace {

bool run(const std::string& expression, const calc::Env& env) {
  try {
    std::cout << calc::evaluate(expression, env) << "\n";
    return true;
  } catch (const calc::ParseError& e) {
    std::cerr << "syntax error at " << e.position() << ": " << e.what() << "\n";
  } catch (const calc::EvalError& e) {
    std::cerr << "error: " << e.what() << "\n";
  }
  return false;
}

}  // namespace

int main(int argc, char** argv) {
  calc::Env env;
  std::string expression;
  for (int i = 1; i < argc; ++i) {
    const std::string arg = argv[i];
    const auto eq = arg.find('=');
    if (eq != std::string::npos && eq > 0) {
      env[arg.substr(0, eq)] = std::stod(arg.substr(eq + 1));
    } else {
      expression = arg;
    }
  }
  if (!expression.empty()) return run(expression, env) ? 0 : 1;

  bool ok = true;
  for (std::string line; std::getline(std::cin, line);) {
    if (!line.empty()) ok = run(line, env) && ok;
  }
  return ok ? 0 : 1;
}
