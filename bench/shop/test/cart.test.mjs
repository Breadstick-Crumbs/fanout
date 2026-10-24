import { test } from "node:test";
import assert from "node:assert/strict";
import { makeProduct, makeCart, addItem, total, formatPrice } from "../src/index.mjs";

test("cart total", () => {
  const cart = addItem(addItem(makeCart(), makeProduct("pen", 2.5), 2), makeProduct("pad", 4));
  assert.equal(total(cart), 9);
  assert.equal(formatPrice(total(cart)), "$9.00");
});
