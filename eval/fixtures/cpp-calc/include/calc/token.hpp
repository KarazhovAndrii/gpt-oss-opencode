#pragma once

#include <cstddef>
#include <ostream>
#include <stdexcept>
#include <string>

namespace calc {

enum class TokenKind {
  Number,
  Identifier,
  Plus,
  Minus,
  Star,
  Slash,
  Percent,
  Caret,
  LParen,
  RParen,
  Comma,
  End,
};

struct Token {
  TokenKind kind;
  std::string text;     // exact source text of the token ("" for End)
  double number = 0.0;  // value of a Number token
  std::size_t pos = 0;  // byte offset in the source; for End, the length of the source
};

const char* to_string(TokenKind kind);
std::ostream& operator<<(std::ostream& os, TokenKind kind);

// Malformed input. Thrown by the lexer (unexpected character) and by the parser.
class ParseError : public std::runtime_error {
 public:
  ParseError(const std::string& message, std::size_t position)
      : std::runtime_error(message), position_(position) {}

  // Byte offset of the offending character or token in the source.
  std::size_t position() const noexcept { return position_; }

 private:
  std::size_t position_;
};

}  // namespace calc
