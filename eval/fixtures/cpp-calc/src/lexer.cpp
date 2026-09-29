#include "calc/lexer.hpp"

#include <cctype>
#include <stdexcept>
#include <string>

namespace calc {

namespace {

bool is_digit(char c) { return std::isdigit(static_cast<unsigned char>(c)) != 0; }
bool is_space(char c) { return std::isspace(static_cast<unsigned char>(c)) != 0; }
bool is_ident_start(char c) { return std::isalpha(static_cast<unsigned char>(c)) != 0 || c == '_'; }
bool is_ident_char(char c) { return is_ident_start(c) || is_digit(c); }

// Returns the end offset of the number literal that starts at `i`.
std::size_t scan_number(std::string_view s, std::size_t i) {
  while (i < s.size() && is_digit(s[i])) ++i;
  if (i < s.size() && s[i] == '.') {
    ++i;
    while (i < s.size() && is_digit(s[i])) ++i;
  }
  if (i < s.size() && (s[i] == 'e' || s[i] == 'E')) {
    // Only an exponent when digits follow; otherwise the 'e' starts an identifier.
    std::size_t j = i + 1;
    const std::size_t digits = j;
    while (j < s.size() && is_digit(s[j])) ++j;
    if (j > digits) i = j;
  }
  return i;
}

bool single_char_token(char c, TokenKind& kind) {
  switch (c) {
    case '+': kind = TokenKind::Plus; return true;
    case '-': kind = TokenKind::Minus; return true;
    case '*': kind = TokenKind::Star; return true;
    case '/': kind = TokenKind::Slash; return true;
    case '%': kind = TokenKind::Percent; return true;
    case '^': kind = TokenKind::Caret; return true;
    case '(': kind = TokenKind::LParen; return true;
    case ')': kind = TokenKind::RParen; return true;
    case ',': kind = TokenKind::Comma; return true;
    default: return false;
  }
}

}  // namespace

std::vector<Token> tokenize(std::string_view source) {
  std::vector<Token> tokens;
  std::size_t i = 0;
  while (i < source.size()) {
    const char c = source[i];
    const std::size_t start = i;
    if (is_space(c)) {
      ++i;
      continue;
    }
    if (is_digit(c) || (c == '.' && i + 1 < source.size() && is_digit(source[i + 1]))) {
      i = scan_number(source, i);
      Token t{TokenKind::Number, std::string(source.substr(start, i - start)), 0.0, start};
      try {
        t.number = std::stod(t.text);
      } catch (const std::out_of_range&) {
        throw ParseError("number out of range: " + t.text, start);
      }
      tokens.push_back(std::move(t));
      continue;
    }
    if (is_ident_start(c)) {
      while (i < source.size() && is_ident_char(source[i])) ++i;
      tokens.push_back({TokenKind::Identifier, std::string(source.substr(start, i - start)), 0.0, start});
      continue;
    }
    TokenKind kind;
    if (!single_char_token(c, kind)) {
      throw ParseError(std::string("unexpected character '") + c + "'", start);
    }
    tokens.push_back({kind, std::string(1, c), 0.0, start});
    ++i;
  }
  tokens.push_back({TokenKind::End, "", 0.0, source.size()});
  return tokens;
}

}  // namespace calc
