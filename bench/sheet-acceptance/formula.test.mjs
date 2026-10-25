import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFormula, refsOf, evaluate } from "../src/index.mjs";

const cells = { A1: 2, A2: 3, A3: "x", A4: null, B1: "4", B2: true, B3: "#DIV/0!", C1: 10 };
const ev = (f, env = cells) => evaluate(parseFormula(f), (a) => (a in env ? env[a] : null));

test("formula: precedence and associativity", () => {
  assert.equal(ev("1+2*3"), 7);
  assert.equal(ev("(1+2)*3"), 9);
  assert.equal(ev("-2^2"), 4);
  assert.equal(ev("2^3^2"), 64);
  assert.equal(ev("10-4-3"), 3);
  assert.equal(ev(" 1 + 2 & 3 "), "33");
  assert.equal(ev("1+2=3"), true);
  assert.equal(ev(".5*1e3"), 500);
});

test("formula: references, coercion and errors", () => {
  assert.equal(ev("a1*$A$2+A$4"), 6);
  assert.equal(ev("B1+B2"), 5);
  assert.equal(ev("A3+1"), "#VALUE!");
  assert.equal(ev("1/0"), "#DIV/0!");
  assert.equal(ev("B3+A3"), "#DIV/0!");
  assert.equal(ev("A3+B3"), "#DIV/0!");
  assert.equal(ev("A1:A2+1"), "#VALUE!");
  assert.equal(ev("10^400"), "#NUM!");
  assert.equal(ev('"say ""hi"""&A4&B2'), 'say "hi"TRUE');
});

test("formula: comparisons across types", () => {
  assert.equal(ev('"abc"="ABC"'), true);
  assert.equal(ev('A4=0'), true);
  assert.equal(ev('A4=""'), true);
  assert.equal(ev('9<"1"'), true);
  assert.equal(ev('"z"<TRUE'), true);
  assert.equal(ev("FALSE<TRUE"), true);
  assert.equal(ev("2<>2"), false);
});

test("formula: aggregate functions", () => {
  assert.equal(ev("SUM(A1:B2)"), 5);
  assert.equal(ev("sum(A1,B1,B2)"), 7);
  assert.equal(ev("AVERAGE(A1:A4)"), 2.5);
  assert.equal(ev("AVERAGE(A3:A4)"), "#DIV/0!");
  assert.equal(ev("MAX(A3:A4)"), 0);
  assert.equal(ev("MIN(C1,A1:A2)"), 2);
  assert.equal(ev("COUNT(A1:B3, 5, \"7\")"), 3);
  assert.equal(ev("SUM(A1:B3)"), "#DIV/0!");
  assert.equal(ev("SUM(B2:A1)"), 5);
});

test("formula: logic and text functions", () => {
  assert.equal(ev('IF(A1>1,"big",1/0)'), "big");
  assert.equal(ev("IF(A4,1)"), false);
  assert.equal(ev('IF("maybe",1,2)'), "#VALUE!");
  assert.equal(ev("AND(A1,B2)"), true);
  assert.equal(ev("OR(A3:A4,FALSE)"), false);
  assert.equal(ev("NOT(0)"), true);
  assert.equal(ev("ROUND(2.5,0)+ROUND(-2.5,0)"), 0);
  assert.equal(ev("ROUND(1234.5,-2)"), 1200);
  assert.equal(ev("ABS(-3)"), 3);
  assert.equal(ev('LEN(UPPER("ab")&LOWER("C"))'), 3);
  assert.equal(ev('CONCAT(A1:A3,"-",B2)'), "23x-TRUE");
  assert.equal(ev("NOPE(1)"), "#NAME?");
  assert.equal(ev("ABS(1,2)"), "#VALUE!");
});

test("formula: refsOf and syntax errors", () => {
  assert.deepEqual(refsOf(parseFormula("SUM(b1:A2)+$a$1*C3")), ["A1", "B1", "A2", "B2", "C3"]);
  for (const bad of ["1+", "(1", "SUM(1,", '"open', "1 2"]) assert.throws(() => parseFormula(bad), SyntaxError, bad);
});
