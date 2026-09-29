import assert from "node:assert/strict";
import test from "node:test";
import { add } from "../examples/add.js";

test("2つの数値を足せる", () => {
  assert.equal(add(2, 3), 5);
  assert.equal(add(-2, 2), 0);
  assert.equal(add(0, 0), 0);
});
