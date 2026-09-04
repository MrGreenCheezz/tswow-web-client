import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

function finalRule(css, selectorFragment) {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/gs)]
    .filter(([, selector]) => selector.split(",").some((part) => part.trim() === selectorFragment))
    .at(-1)?.[2] ?? "";
}

test("bag-bar art fills the complete button instead of a smaller inner socket", async () => {
  const css = await read("src/browser/style.css");
  const button = finalRule(css, "body.native-wow-ui .bag-bar-button");
  const image = finalRule(css, "body.native-wow-ui .bag-bar-button > img");

  assert.match(button, /overflow:\s*hidden/);
  assert.match(button, /background-origin:\s*border-box/);
  assert.match(button, /box-sizing:\s*border-box/);
  assert.match(button, /min-height:\s*36px/,
    "the generic button minimum must not stretch a bag icon into a tall inner socket");
  assert.match(image, /position:\s*absolute/);
  assert.match(image, /inset:\s*0/);
  assert.match(image, /width:\s*100%/);
  assert.match(image, /height:\s*100%/);
  assert.match(image, /margin:\s*0/);
});

test("hovering an action never paints an opaque BLP over its icon", async () => {
  const css = await read("src/browser/style.css");
  const overlay = finalRule(css, "body.native-wow-ui .ui-action-button::before");
  assert.doesNotMatch(overlay, /background(?:-image)?:\s*var\(--wow-action-border/,
    "the decoded ActionButton-Border texture contains an opaque black field and cannot cover the icon");
  assert.match(overlay, /box-shadow:\s*inset/,
    "hover feedback should be a transparent inset edge");
});

test("an item tooltip applies and then clears quality on the tooltip frame itself", async () => {
  const [widgets, css] = await Promise.all([
    read("src/browser/ui/Widgets.ts"),
    read("src/browser/style.css"),
  ]);
  assert.match(widgets, /tooltipElement\.dataset\["quality"\]\s*=\s*String\(shown\.quality\)/);
  assert.match(widgets, /delete tooltipElement\.dataset\["quality"\]/,
    "a spell tooltip shown after an item must not inherit the item's border");
  for (const quality of [0, 1, 2, 3, 4, 5, 6, 7]) {
    assert.match(css, new RegExp(`body\\.native-wow-ui \\.ui-tooltip\\[data-quality=["']${quality}["']\\][^{}]*\\{[^}]*border-color:`, "s"),
      "the quality selector must outrank the native tooltip's default ridge border");
  }
});

test("close controls have accessible names but no font-dependent multiplication glyph", async () => {
  const [html, widgets, css] = await Promise.all([
    read("index.html"),
    read("src/browser/ui/Widgets.ts"),
    read("src/browser/style.css"),
  ]);
  assert.doesNotMatch(html, /class=["'][^"']*(?:window-close|frame-close)[^"']*["'][^>]*>\s*[×Ч]\s*</,
    "the bundled WoW font maps × to the visible Cyrillic-looking glyph Ч");
  assert.doesNotMatch(widgets, /close\.textContent\s*=\s*["'][×Ч]["']/);
  assert.match(widgets, /close\.setAttribute\(["']aria-label["'],\s*["']Закрыть["']\)/);
  assert.match(css, /body\.native-wow-ui\s+:is\(\.window-close,\s*\.frame-close\)::before/);
  assert.match(css, /body\.native-wow-ui\s+:is\(\.window-close,\s*\.frame-close\)::after/);
});

test("active unresolved auras are retried and repainted when metadata later becomes available", async () => {
  const [auras, metadata, client] = await Promise.all([
    read("src/browser/ui/Auras.ts"),
    read("src/gateway/SpellMetadata.ts"),
    read("src/browser/SpellMetadata.ts"),
  ]);
  assert.match(auras, /scheduleAuraMetadataRetry\(world,/,
    "one empty or transient metadata answer must not leave a live buff unknown for the session");
  assert.match(auras, /clearAuraMetadataRetry\(world\)/,
    "a successful or stale load must retire its retry timer");
  assert.match(auras, /showAuras\(\)/,
    "metadata arrival must repaint the visible name and icon");
  assert.match(metadata, /\[61418,\s*26023\]/,
    "the server-only Pursuit of Justice aura must inherit its client-visible owner's metadata");
  assert.match(metadata, /metadata\.set\(effectId,\s*\{\s*\.\.\.owner,\s*id:\s*effectId\s*\}\)/,
    "a linked effect must be returned under the aura id requested by the browser");
  assert.match(client, /\/dbc\/spells\?ids=\$\{[^}]+\}&v=10/,
    "the current recipe metadata version also invalidates cached empty v=8 linked-aura responses");
});
