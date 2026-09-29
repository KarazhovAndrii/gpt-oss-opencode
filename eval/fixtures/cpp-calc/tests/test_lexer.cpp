#include "calc/lexer.hpp"

#include "check.hpp"

using calc::ParseError;
using calc::TokenKind;
using calc::tokenize;

TEST(lexer_empty_input_is_just_end) {
  const auto tokens = tokenize("   ");
  CHECK_EQ(tokens.size(), 1u);
  CHECK_EQ(tokens[0].kind, TokenKind::End);
  CHECK_EQ(tokens[0].pos, 3u);
}

TEST(lexer_operators_and_positions) {
  const auto tokens = tokenize("(a+b) * c");
  CHECK_EQ(tokens.size(), 8u);
  CHECK_EQ(tokens[0].kind, TokenKind::LParen);
  CHECK_EQ(tokens[1].kind, TokenKind::Identifier);
  CHECK_EQ(tokens[1].text, "a");
  CHECK_EQ(tokens[2].kind, TokenKind::Plus);
  CHECK_EQ(tokens[4].kind, TokenKind::RParen);
  CHECK_EQ(tokens[5].kind, TokenKind::Star);
  CHECK_EQ(tokens[5].pos, 6u);
  CHECK_EQ(tokens[6].text, "c");
  CHECK_EQ(tokens[7].kind, TokenKind::End);
  CHECK_EQ(tokens[7].pos, 9u);
}

TEST(lexer_integers_and_fractions) {
  const auto tokens = tokenize("42 3.25 .5");
  CHECK_EQ(tokens.size(), 4u);
  CHECK_EQ(tokens[0].number, 42.0);
  CHECK_EQ(tokens[1].number, 3.25);
  CHECK_EQ(tokens[2].number, 0.5);
  CHECK_EQ(tokens[2].text, ".5");
}

TEST(lexer_exponents) {
  const auto plain = tokenize("1e3");
  CHECK_EQ(plain.size(), 2u);
  CHECK_EQ(plain[0].number, 1000.0);

  const auto negative = tokenize("2.5E-3");
  CHECK_EQ(negative.size(), 2u);
  CHECK_EQ(negative[0].text, "2.5E-3");
  CHECK_NEAR(negative[0].number, 0.0025, 1e-12);

  const auto positive = tokenize("6e+2");
  CHECK_EQ(positive.size(), 2u);
  CHECK_EQ(positive[0].number, 600.0);
}

TEST(lexer_identifiers) {
  const auto tokens = tokenize("max(_x1, y2)");
  CHECK_EQ(tokens.size(), 7u);
  CHECK_EQ(tokens[0].kind, TokenKind::Identifier);
  CHECK_EQ(tokens[0].text, "max");
  CHECK_EQ(tokens[2].text, "_x1");
  CHECK_EQ(tokens[3].kind, TokenKind::Comma);
  CHECK_EQ(tokens[4].text, "y2");
}

TEST(lexer_rejects_unknown_characters) {
  CHECK_THROWS(tokenize("1 $ 2"), ParseError);
  try {
    tokenize("12 # 3");
    CHECK(false);
  } catch (const ParseError& e) {
    CHECK_EQ(e.position(), 3u);
  }
}
