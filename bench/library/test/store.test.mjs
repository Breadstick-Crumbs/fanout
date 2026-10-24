import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore, checkout, checkin, availableCopies, addDays } from "../src/index.mjs";
import { sample } from "../data/sample.mjs";

test("checkout and checkin", () => {
  const s = createStore(sample);
  assert.equal(availableCopies(s, "b2"), 0);
  assert.throws(() => checkout(s, "b2", "m2", "2026-02-01"), /no copies available/);
  const loan = checkout(s, "b1", "m2", "2026-02-01");
  assert.equal(loan.due, addDays("2026-02-01", 14));
  assert.equal(availableCopies(s, "b1"), 1);
  checkin(s, loan.id, "2026-02-05");
  assert.equal(availableCopies(s, "b1"), 2);
});
