import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore, placeHold, cancelHold, holdsFor, checkout, checkin, availableCopies } from "../src/index.mjs";
import { sample } from "../data/sample.mjs";

test("holds: start empty, reject duplicates and unknown books", () => {
  const s = createStore(sample);
  assert.deepEqual(s.holds, []);
  placeHold(s, "b2", "m2", "2026-02-01");
  assert.throws(() => placeHold(s, "b2", "m2", "2026-02-02"));
  assert.throws(() => placeHold(s, "nope", "m2", "2026-02-02"));
});

test("holds: a returned copy goes to the first in the queue", () => {
  const s = createStore(sample);
  placeHold(s, "b2", "m2", "2026-02-01");
  assert.equal(holdsFor(s, "b2").length, 1);
  checkin(s, "l3", "2026-02-02");
  assert.equal(availableCopies(s, "b2"), 0);
  assert.throws(() => checkout(s, "b2", "m3", "2026-02-03"), /no copies available/);
  checkout(s, "b2", "m2", "2026-02-03");
  assert.deepEqual(holdsFor(s, "b2"), []);
});

test("holds: queue position within free copies may check out", () => {
  const s = createStore(sample);
  placeHold(s, "b1", "m1", "2026-02-01");
  placeHold(s, "b1", "m2", "2026-02-01");
  assert.equal(availableCopies(s, "b1"), 0);
  checkout(s, "b1", "m2", "2026-02-02");
  assert.deepEqual(holdsFor(s, "b1").map((h) => h.memberId), ["m1"]);
  assert.throws(() => checkout(s, "b1", "m3", "2026-02-02"), /no copies available/);
});

test("holds: cancel frees the copy", () => {
  const s = createStore(sample);
  const h = placeHold(s, "b5", "m3", "2026-02-01");
  assert.equal(availableCopies(s, "b5"), 1);
  cancelHold(s, h.id);
  assert.deepEqual(holdsFor(s, "b5"), []);
  assert.equal(availableCopies(s, "b5"), 2);
});
