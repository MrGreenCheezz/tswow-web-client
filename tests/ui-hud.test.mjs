import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const actionBarSource = new URL("../src/browser/ui/ActionBar.ts", import.meta.url);
const aurasSource = new URL("../src/browser/ui/Auras.ts", import.meta.url);
const styleSource = new URL("../src/browser/style.css", import.meta.url);
const indexSource = new URL("../index.html", import.meta.url);

function fakeDocument() {
  const make = (tag) => {
    const node = {
      tagName: String(tag).toUpperCase(), children: [], dataset: {}, className: "", textContent: "",
      hidden: false, tabIndex: -1, listeners: new Map(), attributes: new Map(), style: {},
      append(...children) { node.children.push(...children); for (const child of children) child.parentNode = node; },
      prepend(...children) { node.children.unshift(...children); for (const child of children) child.parentNode = node; },
      replaceChildren(...children) { node.children = [...children]; for (const child of children) child.parentNode = node; },
      remove() {},
      addEventListener(name, handler) { node.listeners.set(name, handler); },
      querySelector() { return make("button"); },
      setAttribute(name, value) { node.attributes.set(name, String(value)); node[name] = String(value); },
      getAttribute(name) { return node.attributes.get(name) ?? null; },
      classList: {
        add(...names) { node.className = [...new Set([...node.className.split(" ").filter(Boolean), ...names])].join(" "); },
        contains(name) { return node.className.split(" ").includes(name); },
        toggle(name, enabled) { enabled ? this.add(name) : node.className = node.className.split(" ").filter((item) => item !== name).join(" "); },
      },
      getBoundingClientRect() { return { left: 0, top: 0, bottom: 20, width: 40, height: 40, right: 40 }; },
    };
    return node;
  };
  return {
    createElement: make,
    body: make("body"),
    documentElement: make("html"),
    getElementById: () => make("div"),
    querySelectorAll: () => [],
  };
}

test("action keys use the readable overlay even before icon metadata arrives", async () => {
  const source = await readFile(actionBarSource, "utf8");
  // Empty and unresolved slots still have a useful binding. Passing it as `label` routes it
  // through the low-contrast caption style instead of the WoW-like corner key plaque.
  assert.doesNotMatch(source, /setContent\(\{ label: key, title:/,
    "an empty action slot must render its binding through the key overlay");
  assert.match(source, /setContent\(\{ key, title:/,
    "the empty-slot path keeps the binding visible as a key");
  assert.doesNotMatch(source, /label: metadata \? undefined : key/,
    "unknown spell/item content does not downgrade its key into a caption");
  assert.doesNotMatch(source, /key: metadata \? key : undefined/,
    "known spell/item content keeps the same overlay branch as unknown content");
});

test("the action key plaque has a high-contrast, keyboard-safe fantasy HUD treatment", async () => {
  const css = await readFile(styleSource, "utf8");
  const keyRule = /(?:#action-bar|action-bar-extra|action-bar-side-column)[^{}]*\.ui-icon-key[^{}]*\{([^}]*)\}/s.exec(css)?.[1] ?? "";
  assert.ok(keyRule, "action bars need a dedicated key overlay rule");
  assert.match(keyRule, /background:/, "a dark plaque must separate keys from bright icon art");
  assert.match(keyRule, /border:/, "the key plaque needs a crisp gold edge");
  assert.match(keyRule, /font-size:\s*\.6[4-9]rem|font-size:\s*\.7rem/, "keys must not be tiny");
  assert.match(css, /\.ui-icon-button:focus-visible[^{}]*\{[^}]*outline:/s,
    "keyboard focus must remain visible on the action bar");
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/,
    "HUD motion must respect reduced-motion preferences");
});

test("the obsolete controls legend is not left behind the movable panels", async () => {
  const [html, css] = await Promise.all([readFile(indexSource, "utf8"), readFile(styleSource, "utf8")]);
  assert.doesNotMatch(html, /class=["']controls["']/,
    "the static legend competes with windows and keybindings");
  assert.doesNotMatch(css, /\.controls\s*\{/,
    "there should be no obsolete legend layer behind panels");
});

test("a positive, non-passive aura on the player is eligible for CMSG_CANCEL_AURA", async () => {
  globalThis.document = fakeDocument();
  globalThis.location = { origin: "http://127.0.0.1:5173", protocol: "http:", hostname: "127.0.0.1" };
  globalThis.window = { innerWidth: 1280, innerHeight: 720, addEventListener() {}, removeEventListener() {} };
  const { isRemovablePlayerBuff } = await import("../dist/code/browser/ui/Auras.js");
  const base = { flags: 0x10 | 0x08, casterGuid: undefined };
  assert.equal(isRemovablePlayerBuff(base, { passive: false }), true);
  assert.equal(isRemovablePlayerBuff({ ...base, flags: 0x80 | 0x08 }, { passive: false }), false,
    "negative aura flags are never cancellable from the player strip");
  assert.equal(isRemovablePlayerBuff({ ...base, flags: 0x10, casterGuid: 0x9999n }, { passive: false }), true,
    "the aura owner is the player even when another unit cast the buff");
  assert.equal(isRemovablePlayerBuff(base, { passive: true }), false,
    "passive positive auras are refused by TrinityCore");
  assert.equal(isRemovablePlayerBuff(base, undefined), false,
    "unknown spell metadata is not safe to send as a cancel request");
});

test("a removable player buff is a keyboard-focusable cancel control, while a debuff is inert", async () => {
  globalThis.document = fakeDocument();
  globalThis.location = { origin: "http://127.0.0.1:5173", protocol: "http:", hostname: "127.0.0.1" };
  globalThis.window = { innerWidth: 1280, innerHeight: 720, addEventListener() {}, removeEventListener() {} };
  const { renderAuraStrip } = await import("../dist/code/browser/ui/Auras.js");
  const { playerAuras } = await import("../dist/code/browser/ui/Dom.js");
  const { game } = await import("../dist/code/browser/game/Context.js");
  const self = 0x1234n;
  let cancelled = [];
  game.gatewayOrigin = undefined;
  game.spells = new Map([
    [101, { id: 101, name: "Щит", iconId: 1, passive: false }],
    [102, { id: 102, name: "Яд", iconId: 1, passive: false }],
  ]);
  game.world = { state: { selfGuid: self }, cancelAura: (spellId) => cancelled.push(spellId) };
  renderAuraStrip(playerAuras, [
    { slot: 0, spellId: 101, flags: 0x10 | 0x08, casterLevel: 80, applications: 1 },
    { slot: 1, spellId: 102, flags: 0x80 | 0x08, casterLevel: 80, applications: 1 },
  ], 24);
  const [buff, debuff] = playerAuras.children;
  assert.equal(buff.getAttribute("role"), "button");
  assert.equal(buff.tabIndex, 0);
  assert.ok(buff.classList.contains("is-removable"));
  let prevented = false;
  buff.listeners.get("contextmenu")({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true, "the native context menu must not cover the aura after right-click");
  assert.deepEqual(cancelled, [101]);
  assert.equal(debuff.getAttribute("role"), null);
  assert.equal(debuff.listeners.has("contextmenu"), false);
  game.world = undefined;
  game.spells = new Map();
});
