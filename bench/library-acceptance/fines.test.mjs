import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore, finesFor, memberBalance, payFine } from "../src/index.mjs";
import { sample } from "../data/sample.mjs";

test("fines: open loan, 2-day grace, 25 cents a day", () => {
  const s = createStore(sample);
  assert.deepEqual(finesFor(s, "m1", "2026-02-10"), [{ loanId: "l3", bookId: "b2", daysLate: 5, amount: 1.25 }]);
  assert.deepEqual(finesFor(s, "m1", "2026-02-05"), []);
});

test("fines: returned late loan, and the $10 cap", () => {
  const s = createStore(sample);
  assert.deepEqual(finesFor(s, "m3", "2026-06-01"), [{ loanId: "l4", bookId: "b4", daysLate: 6, amount: 1.5 }]);
  assert.deepEqual(finesFor(s, "m2", "2026-06-01"), [{ loanId: "l2", bookId: "b3", daysLate: 131, amount: 10 }]);
});

test("fines: balance and payments", () => {
  const s = createStore(sample);
  assert.deepEqual(s.payments, []);
  assert.equal(memberBalance(s, "m3", "2026-02-01"), 1.5);
  assert.equal(payFine(s, "m3", 1, "2026-02-01"), 0.5);
  assert.equal(s.payments.length, 1);
  assert.equal(memberBalance(s, "m3", "2026-02-01"), 0.5);
});
