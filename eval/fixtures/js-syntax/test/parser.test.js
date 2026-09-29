import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, parseLine } from "../src/parser.js";

test("plain fields", () => {
  assert.deepEqual(parseLine("a,b,c"), ["a", "b", "c"]);
});

test("quoted fields with commas and escaped quotes", () => {
  assert.deepEqual(parseLine('"x, y","say ""hi""",z'), ["x, y", 'say "hi"', "z"]);
});

test("multiple lines, blank lines skipped", () => {
  assert.deepEqual(parse("a,b\r\n\r\nc,d\n"), [["a", "b"], ["c", "d"]]);
});
