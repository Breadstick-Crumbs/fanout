import { test } from "node:test";
import assert from "node:assert/strict";
import { formatNumber as f } from "../src/index.mjs";

test("numfmt: digits, decimals and grouping", () => {
  assert.equal(f(1234.567, "#,##0.00"), "1,234.57");
  assert.equal(f(0.5, "#.00"), ".50");
  assert.equal(f(0.5, "0.00"), "0.50");
  assert.equal(f(7, "000"), "007");
  assert.equal(f(0, "#,##0"), "0");
  assert.equal(f(1e21, "#,##0"), "1,000,000,000,000,000,000,000");
});

test("numfmt: rounding half away from zero, on printed digits", () => {
  assert.equal(f(1.005, "0.00"), "1.01");
  assert.equal(f(2.675, "0.00"), "2.68");
  assert.equal(f(-1234.5, "#,##0"), "-1,235");
  assert.equal(f(-0.004, "0.00"), "0.00");
  assert.equal(f(9.995, "0.00"), "10.00");
});

test("numfmt: optional decimals", () => {
  assert.equal(f(2.5, "0.##"), "2.5");
  assert.equal(f(2, "0.##"), "2.");
  assert.equal(f(3.14159, "0.0#"), "3.14");
  assert.equal(f(3.1, "0.0#"), "3.1");
});

test("numfmt: percent and scientific", () => {
  assert.equal(f(0.075, "0.0%"), "7.5%");
  assert.equal(f(0.5, "0%"), "50%");
  assert.equal(f(12345.678, "0.00E+00"), "1.23E+04");
  assert.equal(f(0.000123, "0.00E-00"), "1.23E-04");
  assert.equal(f(123, "0.0E-00"), "1.2E02");
  assert.equal(f(9.99, "0.0E+00"), "1.0E+01");
  assert.equal(f(0.000123, "0.0E+0"), "1.2E-4");
});

test("numfmt: sections and literals", () => {
  assert.equal(f(-5, "0;(0)"), "(5)");
  assert.equal(f(5, "0;(0)"), "5");
  assert.equal(f(0, '0.0;-0.0;"zero"'), "zero");
  assert.equal(f(-2.5, '0.0;-0.0;"zero"'), "-2.5");
  assert.equal(f(1500, "$#,##0"), "$1,500");
  assert.equal(f(42, '0 "items"'), "42 items");
  assert.equal(f(7, "\\#0"), "#7");
});

test("numfmt: values that are not numbers, and General", () => {
  assert.equal(f("abc", "0.00"), "abc");
  assert.equal(f(null, "0.00"), "");
  assert.equal(f(true, "0"), "TRUE");
  assert.equal(f(0.1 + 0.2, "General"), "0.30000000000000004");
});
