import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore, createServer } from "../src/index.mjs";
import { sample } from "../data/sample.mjs";

async function withServer(fn) {
  const server = createServer(createStore(sample));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
}
const json = async (res) => ({ status: res.status, type: res.headers.get("content-type") ?? "", body: await res.json() });

test("api: books", () => withServer(async (base) => {
  const list = await json(await fetch(`${base}/books?q=martin`));
  assert.equal(list.status, 200);
  assert.match(list.type, /application\/json/);
  assert.equal(list.body.total, 2);
  const one = await json(await fetch(`${base}/books/b3`));
  assert.equal(one.status, 200);
  assert.equal(one.body.title, "Dune");
  const none = await json(await fetch(`${base}/books/nope`));
  assert.deepEqual([none.status, none.body], [404, { error: "not found" }]);
}));

test("api: loans", () => withServer(async (base) => {
  const post = (body) => fetch(`${base}/loans`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(json);
  const ok = await post({ bookId: "b1", memberId: "m2", date: "2026-02-01" });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.due, "2026-02-15");
  const missing = await post({ bookId: "b1", date: "2026-02-01" });
  assert.deepEqual([missing.status, missing.body], [400, { error: "missing memberId" }]);
  const busy = await post({ bookId: "b2", memberId: "m2", date: "2026-02-01" });
  assert.deepEqual([busy.status, busy.body], [409, { error: "no copies available" }]);
}));

test("api: balance and unknown routes", () => withServer(async (base) => {
  const bal = await json(await fetch(`${base}/members/m3/balance?asOf=2026-02-01`));
  assert.deepEqual([bal.status, bal.body], [200, { memberId: "m3", balance: 1.5 }]);
  assert.equal((await fetch(`${base}/nothing`)).status, 404);
}));
