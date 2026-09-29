#include "calc/token.hpp"

namespace calc {

const char* to_string(TokenKind kind) {
  switch (kind) {
    case TokenKind::Number: return "Number";
    case TokenKind::Identifier: return "Identifier";
    case TokenKind::Plus: return "'+'";
    case TokenKind::Minus: return "'-'";
    case TokenKind::Star: return "'*'";
    case TokenKind::Slash: return "'/'";
    case TokenKind::Percent: return "'%'";
    case TokenKind::Caret: return "'^'";
    case TokenKind::LParen: return "'('";
    case TokenKind::RParen: return "')'";
    case TokenKind::Comma: return "','";
    case TokenKind::End: return "end of input";
  }
  return "?";
}

std::ostream& operator<<(std::ostream& os, TokenKind kind) { return os << to_string(kind); }

}  // namespace calc
