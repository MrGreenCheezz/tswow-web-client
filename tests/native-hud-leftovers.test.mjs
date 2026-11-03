// 4.18: once the stock interface is up, nothing of the old one stays on screen. The owner's snapshot showed
// ⚔ «Начать атаку» beside the stock PlayerFrame.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { NATIVE_LANES_REPLACED, NATIVE_LEFTOVERS_CSS } from "../dist/code/browser/ui/NativeHudReplacement.js";

const index = readFileSync(new URL("../index.html", import.meta.url), "utf8");

test("every button the client itself puts in the target's row falls under the hiding rule", () => {
  const row = /<div id="target-actions"[^>]*>([\s\S]*?)<\/div>/.exec(index)?.[1];
  assert.ok(row, "the row is in the page");
  const buttons = [...row.matchAll(/<button\b[^>]*>/g)].map((match) => match[0]);
  assert.ok(buttons.length >= 6);
  for (const button of buttons) assert.match(button, /class="frame-action"/, button);
  assert.match(
    readFileSync(new URL("../src/browser/ui/Frames.ts", import.meta.url), "utf8"),
    /button\.className = "frame-action"/,
    "and the duel button, which is made in code",
  );
  assert.ok(NATIVE_LEFTOVERS_CSS.includes(`body.${NATIVE_LANES_REPLACED} #target-actions > .frame-action`));
});

test("a module's button in the slot is not hidden, and can still be clicked through a rail that takes no clicks", () => {
  assert.doesNotMatch(NATIVE_LEFTOVERS_CSS, /#target-actions\s*[,{]/, "the row itself stays");
  assert.ok(NATIVE_LEFTOVERS_CSS.includes(`#target-rail { pointer-events: none; }`));
  assert.ok(NATIVE_LEFTOVERS_CSS.includes(`#target-actions > * { pointer-events: auto; }`));
});

test("the old raid grid goes too: stock has none of its own to wait for", () => {
  assert.ok(NATIVE_LEFTOVERS_CSS.includes(`body.${NATIVE_LANES_REPLACED} #raid-frames`));
});
