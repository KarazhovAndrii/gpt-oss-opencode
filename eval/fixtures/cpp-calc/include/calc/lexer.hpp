#pragma once

#include <string_view>
#include <vector>

#include "calc/token.hpp"

namespace calc {

// Splits an expression into tokens; the result always ends with exactly one End token.
// Whitespace separates tokens and is otherwise ignored.
//
//   Number      digits with an optional fraction and an optional exponent
//               (e or E, an optional sign, digits): 42  3.14  .5  1e9  2.5E-3  6e+2
//   Identifier  a letter or '_', followed by letters, digits or '_'
//   Operators   + - * / % ^ ( ) ,
//
// Any other character throws ParseError at that character's position.
std::vector<Token> tokenize(std::string_view source);

}  // namespace calc
