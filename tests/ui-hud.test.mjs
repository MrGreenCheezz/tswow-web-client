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
  assert.doesNotMatch(source, /`Заклинание \$\{content\.action\}/,
    "an unresolved action must not leak its internal spell id to the player");
  assert.match(source, /title:\s*"Данные заклинания загружаются"/,
    "an occupied unresolved action remains distinguishable from an empty slot without an id");
});

test("the action key label stays readable without covering the spell icon", async () => {
  const css = await readFile(styleSource, "utf8");
  const keyRules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/gs)]
    .filter(([, selector]) => selector.includes(".ui-action-button") && selector.includes(".ui-icon-key"));
  const keyRule = keyRules.at(-1)?.[2] ?? "";
  assert.match(keyRules.at(-1)?.[1] ?? "", /body\.native-wow-ui/,
    "the native key label must be the final high-specificity rule");
  assert.ok(keyRule, "action bars need a dedicated key overlay rule");
  assert.match(keyRule, /background:\s*transparent/, "the label must leave the icon visible");
  assert.match(keyRule, /border:\s*0/, "a border must not grow into a plaque over the icon");
  assert.match(keyRule, /font-size:\s*1[01]px/, "the compact corner label must remain readable");
  assert.match(keyRule, /text-shadow:/, "text shadow keeps the label legible over bright icon art");
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

test("aura display filtering removes known hidden entries before applying the limit", async () => {
  const { visibleAuraEntries } = await import("../dist/code/browser/ui/Auras.js");
  const hidden = { slot: 0, spellId: 100, flags: 0, applications: 1 };
  const passive = { slot: 1, spellId: 101, flags: 0, applications: 1 };
  const unknown = { slot: 2, spellId: 102, flags: 0, applications: 1 };
  const hiddenAfter = { slot: 3, spellId: 103, flags: 0, applications: 1 };
  const visible = { slot: 4, spellId: 104, flags: 0, applications: 1 };
  const metadata = new Map([
    [100, { hidden: true, passive: false }],
    [101, { hidden: false, passive: true }],
    [103, { hidden: true, passive: false }],
    [104, { hidden: false, passive: false }],
  ]);

  assert.deepEqual(
    visibleAuraEntries([hidden, passive, unknown, hiddenAfter, visible], 3, (id) => metadata.get(id)),
    [passive, unknown, visible],
    "known client-hidden auras cannot consume the visible limit, while passive and unresolved rows stay visible",
  );
});

test("native aura icons reserve readable space for duration and stacks", async () => {
  const css = await readFile(styleSource, "utf8");
  const rule = css.match(/body\.native-wow-ui \.aura-icon\s*\{([^}]*)\}/s)?.[1] ?? "";
  assert.match(rule, /width:\s*(?:38|39|40)px/);
  assert.match(rule, /height:\s*(?:38|39|40)px/);
});

test("the bottom HUD owns one ordered layout without gryphon art", async () => {
  const [html, action, css] = await Promise.all([
    readFile(indexSource, "utf8"),
    readFile(actionBarSource, "utf8"),
    readFile(styleSource, "utf8"),
  ]);
  assert.match(action, /--bottom-bars/, "ActionBar must publish the number of enabled bottom rows");
  assert.doesNotMatch(html, /\bid=["']main-menu-art["']/,
    "the obsolete main-menu plate and gryphons must not exist");
  assert.doesNotMatch(css, /#main-menu-art\b/,
    "no hidden or breakpoint-specific gryphon deck may survive");
  assert.match(html,
    /id="bottom-hud"[^>]+data-window-reserve-bottom[\s\S]*id="bottom-hud-center"[\s\S]*id="action-bar"[\s\S]*id="hud-utilities"[\s\S]*id="bag-bar"[\s\S]*id="game-buttons"/,
    "combat, bag, and character/menu controls must belong to one ordered HUD");
  for (const id of ["action-bar", "bag-bar", "game-buttons"]) {
    const tag = html.match(new RegExp(`<div\\b(?=[^>]*\\bid=["']${id}["'])[^>]*>`, "i"))?.[0] ?? "";
    assert.ok(tag, `${id} must exist`);
    assert.doesNotMatch(tag, /\bdata-window-reserve-bottom\b/,
      `${id} must not reserve the viewport independently of #bottom-hud`);
  }
  assert.doesNotMatch(action, /bottom\.dataset\["windowReserveBottom"\]/,
    "dynamic bottom rows are measured through #bottom-hud");
});

test("empty action slots are visually quieter without hiding their shortcut", async () => {
  const [action, css] = await Promise.all([
    readFile(actionBarSource, "utf8"),
    readFile(styleSource, "utf8"),
  ]);
  assert.match(action, /dataset\["empty"\]/,
    "ActionBar must identify genuinely empty slots without guessing from missing icon metadata");
  assert.match(css, /\.ui-action-button\[data-empty\]/,
    "native empty slots need a dedicated low-emphasis treatment");
});

test("native action keys use the final unobtrusive high-specificity rule", async () => {
  const css = await readFile(styleSource, "utf8");
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/gs)]
    .filter(([, selector]) => selector.includes(".ui-action-button") && selector.includes(".ui-icon-key"));
  const final = rules.at(-1);
  assert.ok(final, "action bars need a final key overlay rule");
  assert.match(final[1], /body\.native-wow-ui/, "the authored rule must beat the generic key rule");
  assert.match(final[2], /background:\s*transparent/, "keys must not cover the icon art");
  assert.match(final[2], /border:\s*0/, "keys must not grow an overlapping plaque");
  assert.match(final[2], /font-size:\s*1[01]px/,
    "keys must remain readable as compact corner labels");
});

test("the native right action rail keeps full-size slots and scrolls beside the inset minimap", async () => {
  const css = await readFile(styleSource, "utf8");
  const rail = [...css.matchAll(/body\.native-wow-ui #action-bar-side\s*\{([^}]*)\}/gs)]
    .find(([, body]) => body.includes("top:"))?.[1] ?? "";
  assert.match(rail, /top:\s*14px/, "the rail may use the full right edge because the minimap reads its width reserve");
  assert.match(rail, /bottom:/, "the rail remains bounded by the viewport on short screens");
  assert.match(rail, /overflow-y:\s*auto/, "short screens scroll instead of shrinking twelve action icons");
});
