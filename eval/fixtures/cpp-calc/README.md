# calc

A small C++17 library that tokenizes and evaluates arithmetic expressions, plus a
`calc` command-line tool.

## Layout

- `include/calc/` — public headers: `token.hpp`, `lexer.hpp`, `eval.hpp`
  (the expression grammar and error rules are documented in `eval.hpp`)
- `src/` — library sources (every `.cpp` here is part of the library)
- `app/main.cpp` — the command-line tool
- `tests/` — unit tests; `tests/check.hpp` is the test framework and every
  `tests/*.cpp` is compiled into the test binary
- `tools/build.mjs` — build script

## Build and test

No CMake or Makefile: the build script finds g++, clang++ or MSVC by itself
(set `CXX` to choose a compiler).

```
npm test         # build and run the unit tests (build/tests)
npm run build    # build the command-line tool (build/calc)
```

## Status

The lexer is done. `calc::evaluate` (`src/eval.cpp`) is still a stub.
