/**
 * The canonical encoder pins the byte-level choices where Node and Go would
 * otherwise disagree. `connectorv1/canonical_test.go` asserts the same table
 * against the Go implementation.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  byteLength,
  CanonicalEncodeError,
  jsonBoolean,
  jsonInteger,
  jsonNumber,
  jsonString,
} from "../src/canonical.ts";

test("numbers are formatted by the ECMAScript algorithm", () => {
  const cases: [number, string][] = [
    [0, "0"],
    [-0, "0"],
    [1, "1"],
    [-1, "-1"],
    [0.42, "0.42"],
    [1.5, "1.5"],
    [100, "100"],
    [8132, "8132"],
    [8200000000, "8200000000"],
    [9007199254740991, "9007199254740991"],
    [0.000001, "0.000001"],
    [1e-7, "1e-7"],
    [1.25e-8, "1.25e-8"],
    [1e21, "1e+21"],
    [1.5e22, "1.5e+22"],
    [1e20, "100000000000000000000"],
    [0.1, "0.1"],
    [1 / 3, "0.3333333333333333"],
    [1024, "1024"],
  ];
  for (const [value, expected] of cases) {
    assert.equal(jsonNumber(value), expected, `jsonNumber(${String(value)})`);
  }
});

test("strings are escaped the way the Go writer escapes them", () => {
  const cases: [string, string][] = [
    ["plain", '"plain"'],
    ['quote"inside', '"quote\\"inside"'],
    ["back\\slash", '"back\\\\slash"'],
    ["tab\there", '"tab\\there"'],
    ["line\nbreak", '"line\\nbreak"'],
    ["bell", '"bell\\u0007"'],
    ["<tag> & 'amp'", "\"<tag> & 'amp'\""],
    ["日本語", '"日本語"'],
    ["\u{1f680}", '"\u{1f680}"'],
    ["line separator", '"line\\u2028separator"'],
    ["paragraph separator", '"paragraph\\u2029separator"'],
  ];
  for (const [value, expected] of cases) {
    assert.equal(jsonString(value), expected, `jsonString(${JSON.stringify(value)})`);
  }
});

test("non-finite and unsafe numbers are refused", () => {
  assert.throws(() => jsonNumber(Number.POSITIVE_INFINITY), CanonicalEncodeError);
  assert.throws(() => jsonNumber(Number.NaN), CanonicalEncodeError);
  assert.throws(() => jsonInteger(1.5), CanonicalEncodeError);
  assert.throws(() => jsonInteger(Number.MAX_SAFE_INTEGER + 2), CanonicalEncodeError);
});

test("booleans and byte lengths", () => {
  assert.equal(jsonBoolean(true), "true");
  assert.equal(jsonBoolean(false), "false");
  assert.equal(byteLength("abc"), 3);
  assert.equal(byteLength("é"), 2, "bounds are byte bounds, not character counts");
  assert.equal(byteLength(new Uint8Array([1, 2, 3, 4])), 4);
});
