#pragma once

#include <functional>
#include <map>
#include <stdexcept>
#include <string>
#include <string_view>

#include "calc/token.hpp"

namespace calc {

// Variable values available to an expression.
using Env = std::map<std::string, double, std::less<>>;

// A syntactically valid expression that cannot be evaluated.
class EvalError : public std::runtime_error {
 public:
  using std::runtime_error::runtime_error;
};

// Evaluates an arithmetic expression (tokens as described in lexer.hpp).
//
// Grammar, from lowest to highest precedence:
//
//   expr    := term (('+' | '-') term)*              left-associative
//   term    := unary (('*' | '/' | '%') unary)*      left-associative; '%' is std::fmod
//   unary   := ('+' | '-') unary | power
//   power   := primary ('^' unary)?                  right-associative
//   primary := NUMBER
//            | IDENT                                 variable, looked up in env
//            | IDENT '(' [expr (',' expr)*] ')'      function call
//            | '(' expr ')'
//
// So:  2 ^ 3 ^ 2 == 512,  -2 ^ 2 == -4,  2 ^ -1 == 0.5,  10 - 4 - 3 == 3.
//
// Functions: abs(x), sqrt(x), min(x, ...), max(x, ...).
// abs and sqrt take exactly one argument; min and max take one or more.
//
// Errors:
//   ParseError  the expression does not match the grammar: empty input, unexpected
//               token, missing ')', trailing input. position() is the offset of the
//               offending token; at the end of the input it is expression.size().
//   EvalError   unknown variable, unknown function, wrong number of arguments,
//               division or modulo by zero, sqrt of a negative number.
//
// The whole expression is parsed before anything is evaluated, so syntax errors win:
// "1 / 0 +" throws ParseError (position 7), not EvalError.
double evaluate(std::string_view expression, const Env& env = {});

}  // namespace calc
