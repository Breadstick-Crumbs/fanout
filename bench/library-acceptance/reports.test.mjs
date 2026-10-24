import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore, overdueReport, popularBooks, memberActivity, addMember } from "../src/index.mjs";
import { sample } from "../data/sample.mjs";

test("reports: overdue", () => {
  const s = createStore(sample);
  assert.deepEqual(overdueReport(s, "2026-02-10"), [
    { loanId: "l2", bookId: "b3", title: "Dune", memberId: "m2", memberName: "Alan Turing", daysOverdue: 22 },
    { loanId: "l3", bookId: "b2", title: "Clean Code", memberId: "m1", memberName: "Ada Lovelace", daysOverdue: 7 },
  ]);
  assert.deepEqual(overdueReport(s, "2026-01-19"), []);
});

test("reports: popular books", () => {
  const s = createStore(sample);
  assert.deepEqual(popularBooks(s, { from: "2026-01-01", to: "2026-01-31" }), [
    { bookId: "b3", title: "Dune", loans: 2 },
    { bookId: "b2", title: "Clean Code", loans: 1 },
    { bookId: "b4", title: "Neuromancer", loans: 1 },
  ]);
  assert.equal(popularBooks(s, { from: "2026-01-01", to: "2026-01-31", limit: 2 }).length, 2);
  assert.deepEqual(popularBooks(s, { from: "2026-01-04", to: "2026-01-20" }).map((b) => b.title), ["Clean Code", "Dune"]);
});

test("reports: member activity", () => {
  const s = createStore(sample);
  assert.deepEqual(memberActivity(s, "m1"), { memberId: "m1", totalLoans: 2, openLoans: 1, lastOut: "2026-01-20" });
  const m = addMember(s, { name: "New", email: "n@example.com" });
  assert.deepEqual(memberActivity(s, m.id), { memberId: m.id, totalLoans: 0, openLoans: 0, lastOut: null });
});
