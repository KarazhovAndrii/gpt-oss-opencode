#include "calc/eval.hpp"

#include "calc/lexer.hpp"

namespace calc {

// TODO: implement the grammar documented in include/calc/eval.hpp.
double evaluate(std::string_view expression, const Env& env) {
  (void)tokenize(expression);
  (void)env;
  throw EvalError("evaluate() is not implemented yet");
}

}  // namespace calc
