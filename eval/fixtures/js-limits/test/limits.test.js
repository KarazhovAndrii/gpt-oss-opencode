import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_ITEMS_PER_PAGE, MAX_RETRIES } from "../src/limits.js";

test("paging and retry limits are unchanged", () => {
  assert.equal(MAX_ITEMS_PER_PAGE, 100);
  assert.equal(MAX_RETRIES, 3);
});
