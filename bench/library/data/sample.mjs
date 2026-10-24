// A small seed library used by the tests.
export const sample = {
  nextId: 100,
  books: [
    { id: "b1", title: "The Pragmatic Programmer", author: "Andrew Hunt", year: 1999, tags: ["programming", "craft"], copies: 2 },
    { id: "b2", title: "Clean Code", author: "Robert Martin", year: 2008, tags: ["programming"], copies: 1 },
    { id: "b3", title: "Dune", author: "Frank Herbert", year: 1965, tags: ["fiction", "scifi"], copies: 3 },
    { id: "b4", title: "Neuromancer", author: "William Gibson", year: 1984, tags: ["fiction", "scifi", "cyberpunk"], copies: 1 },
    { id: "b5", title: "The Hobbit", author: "J. R. R. Tolkien", year: 1937, tags: ["fiction", "fantasy"], copies: 2 },
    { id: "b6", title: "Refactoring", author: "Martin Fowler", year: 1999, tags: ["programming"], copies: 1 },
    { id: "b7", title: "Snow Crash", author: "Neal Stephenson", year: 1992, tags: ["fiction", "scifi", "cyberpunk"], copies: 1 },
    { id: "b8", title: "Design Patterns", author: "Erich Gamma", year: 1994, tags: ["programming"], copies: 1 },
  ],
  members: [
    { id: "m1", name: "Ada Lovelace", email: "ada@example.com" },
    { id: "m2", name: "Alan Turing", email: "alan@example.com" },
    { id: "m3", name: "Grace Hopper", email: "grace@example.com" },
  ],
  loans: [
    { id: "l1", bookId: "b3", memberId: "m1", out: "2026-01-02", due: "2026-01-16", returned: "2026-01-10" },
    { id: "l2", bookId: "b3", memberId: "m2", out: "2026-01-05", due: "2026-01-19", returned: null },
    { id: "l3", bookId: "b2", memberId: "m1", out: "2026-01-20", due: "2026-02-03", returned: null },
    { id: "l4", bookId: "b4", memberId: "m3", out: "2026-01-03", due: "2026-01-17", returned: "2026-01-25" },
  ],
};
