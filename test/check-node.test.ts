// The Node.js version check that runs before the TypeScript entry points.

import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error plain JavaScript module without type declarations
import { supportsTypeScript } from "../bin/check-node.mjs";

test("Node.js versions that can run the .ts files without flags", () => {
  for (const v of ["22.18.0", "v22.20.1", "23.6.0", "24.0.0", "25.1.0"]) assert.equal(supportsTypeScript(v), true, v);
  for (const v of ["20.17.0", "v21.7.3", "22.17.1", "22.6.0", "23.5.0", "18.20.4"]) assert.equal(supportsTypeScript(v), false, v);
});
