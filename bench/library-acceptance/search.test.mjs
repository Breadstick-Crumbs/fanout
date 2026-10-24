import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore, search } from "../src/index.mjs";
import { sample } from "../data/sample.mjs";

const titles = (r) => r.items.map((b) => b.title);

test("search: everything, sorted by title", () => {
  const r = search(createStore(sample), {});
  assert.equal(r.total, 8); assert.equal(r.pages, 1); assert.equal(r.page, 1);
  assert.deepEqual(titles(r), ["Clean Code", "Design Patterns", "Dune", "Neuromancer", "Refactoring", "Snow Crash", "The Hobbit", "The Pragmatic Programmer"]);
});

test("search: every word of q in title or author", () => {
  const s = createStore(sample);
  assert.deepEqual(titles(search(s, { q: "the prag" })), ["The Pragmatic Programmer"]);
  assert.deepEqual(titles(search(s, { q: "MARTIN" })), ["Clean Code", "Refactoring"]);
});

test("search: author, tag, sort by year", () => {
  const s = createStore(sample);
  assert.deepEqual(titles(search(s, { author: "frank herbert" })), ["Dune"]);
  assert.deepEqual(titles(search(s, { tag: "cyberpunk", sort: "year" })), ["Snow Crash", "Neuromancer"]);
});

test("search: year range and availability", () => {
  const s = createStore(sample);
  assert.deepEqual(titles(search(s, { yearFrom: 1990, yearTo: 1999 })).sort(), ["Design Patterns", "Refactoring", "Snow Crash", "The Pragmatic Programmer"]);
  const r = search(s, { available: true });
  assert.equal(r.total, 7);
  assert.ok(!titles(r).includes("Clean Code"));
});

test("search: paging", () => {
  const r = search(createStore(sample), { pageSize: 3, page: 3 });
  assert.equal(r.total, 8); assert.equal(r.pages, 3); assert.equal(r.page, 3);
  assert.deepEqual(titles(r), ["The Hobbit", "The Pragmatic Programmer"]);
});
