import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore, addBook, exportBooks, importBooks } from "../src/index.mjs";
import { sample } from "../data/sample.mjs";

test("csv: export quotes commas and quotes, joins tags", () => {
  const s = createStore();
  addBook(s, { title: 'Say "hi", world', author: "A", year: 2000, tags: ["x", "y"], copies: 2 });
  assert.equal(exportBooks(s), 'id,title,author,year,tags,copies\nb1000,"Say ""hi"", world",A,2000,x;y,2\n');
});

test("csv: export the sample library", () => {
  const lines = exportBooks(createStore(sample)).split("\n");
  assert.equal(lines.length, 10);
  assert.equal(lines[1], "b1,The Pragmatic Programmer,Andrew Hunt,1999,programming;craft,2");
  assert.equal(lines[9], "");
});

test("csv: import with columns in any order, quoting, and row errors", () => {
  const s = createStore();
  const text = [
    "author,title,year,copies,tags",
    "Gibson,Count Zero,1986,,scifi;cyberpunk",
    "Someone,,2001,1,",
    'X,"Y, the book",abc,1,',
    "X,Z,2001,0,",
    '"Doe, Jane","A ""quoted"" title",2010,3,a;b',
  ].join("\n") + "\n";
  const r = importBooks(s, text);
  assert.equal(r.added, 2);
  assert.deepEqual(r.errors.map((e) => e.line), [3, 4, 5]);
  assert.ok(r.errors.every((e) => typeof e.message === "string" && e.message.length > 0));
  const [a, b] = s.books;
  assert.deepEqual([a.title, a.author, a.year, a.copies, a.tags], ["Count Zero", "Gibson", 1986, 1, ["scifi", "cyberpunk"]]);
  assert.deepEqual([b.title, b.author, b.year, b.copies, b.tags], ['A "quoted" title', "Doe, Jane", 2010, 3, ["a", "b"]]);
});
