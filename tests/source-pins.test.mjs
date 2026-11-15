// 13.09 (pins9): the pin helpers fail when the rule they pin is gone, and only then.
import assert from "node:assert/strict";
import test from "node:test";

import {
  assertGuard, assertOrder, conditionTerms, guardOf, inert, memberSource, methodHarness, productFactors, withInertFields,
} from "./source-pins.mjs";

const SOURCE = [
  "class A {",
  "  #first(): void {",
  "    const viewed = a && !b;",
  "    if (!fromCamera && viewed && check(x, y && z)) {",
  "      selected = this.#walk(placed, player);",
  "    }",
  "    if (binds) this.#bind(placed, 1);",
  "    other();",
  "  }",
  "",
  "  async #second(value: number): Promise<void> {",
  "    one();",
  "    two();",
  "  }",
  "}",
  "",
].join("\n");

test("a member's body runs from its declaration to its own closing brace", () => {
  const first = memberSource(SOURCE, "#first");
  assert.ok(first.startsWith("  #first(): void {"));
  assert.ok(first.endsWith("    other();\n  }\n"));
  assert.ok(memberSource(SOURCE, "#second").includes("two();"));
  assert.throws(() => memberSource(SOURCE, "#third"), "a renamed member fails loudly");
});

test("a guard is read as its top-level terms, whatever their order and formatting", () => {
  assert.deepEqual(conditionTerms("a &&\n  b(c && d) && !e"), ["a", "b(c && d)", "!e"]);
  assert.deepEqual(guardOf(SOURCE, "this.#walk(placed, player)"), ["!fromCamera", "viewed", "check(x, y && z)"]);
  assert.deepEqual(guardOf(SOURCE, "this.#bind(placed, 1)"), ["binds"]);
  assertGuard(SOURCE, "this.#walk(placed, player)", ["viewed", "!fromCamera"], "held");
  assert.throws(() => assertGuard(SOURCE, "this.#walk(placed, player)", ["!entered"], "missing"), /holds !entered/);
  assert.throws(() => guardOf(SOURCE, "other()"), /no if/, "an unguarded call has no guard");
  assert.throws(() => guardOf(SOURCE, "this.#gone()"), /is made/);
});

test("a product is read as its top-level factors", () => {
  assert.deepEqual(productFactors("a(b * c, d)\n  * (e ? f : g * h) * 2 ** 3"), ["a(b * c, d)", "(e ? f : g * h)", "2 ** 3"]);
});

test("a method harness runs the member's own code; what the test did not set is inert", async () => {
  const source = "import { helper } from \"./x.js\";\nconst LIMIT = 3;\nexport class Owner {\n  #count = 0;\n  #step(value: number): number {\n    this.#sink.publish(helper(value));\n    if (this.#other.size > 0) return -1;\n    for (const item of this.#list) value += item;\n    return Math.min(value, LIMIT);\n  }\n}\n";
  const Harness = await methodHarness(source, "Owner", ["#step"], { LIMIT: 3 });
  const harness = withInertFields(new Harness());
  assert.equal(harness.step(1), 1, "helper, sink, other and list are inert");
  harness.list = [5];
  assert.equal(harness.step(1), 3, "a field the test sets is the method's own");
  assert.equal(inert.size > 0, false);
  assert.deepEqual([...inert], []);
});

test("an order holds only when every needle follows the one before", () => {
  assertOrder(SOURCE, ["one();", "two();"], "in order");
  assert.throws(() => assertOrder(SOURCE, ["two();", "one();"], "reversed"));
  assertOrder(SOURCE, [/const viewed/, "this.#bind("], "a pattern and a string");
});
