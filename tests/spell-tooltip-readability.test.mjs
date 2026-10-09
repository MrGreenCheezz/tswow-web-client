import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

function finalRule(css, selector) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...clean.matchAll(/([^{}]+)\{([^{}]*)\}/gs)]
    .filter(([, selectors]) => selectors.split(",").some((part) => part.trim() === selector))
    .at(-1)?.[2] ?? "";
}

function allRules(css, selector) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...clean.matchAll(/([^{}]+)\{([^{}]*)\}/gs)]
    .filter(([, selectors]) => selectors.split(",").some((part) => part.trim() === selector))
    .map(([, , declarations]) => declarations)
    .join("\n");
}

test("spell descriptions are readable body copy, separate from the muted action hint", async () => {
  const [spellbook, widgets, css] = await Promise.all([
    read("src/browser/ui/Spellbook.ts"),
    read("src/browser/ui/Tooltip.ts"), // the tooltip module since 4.01
    read("src/browser/style.css"),
  ]);

  assert.match(widgets, /TooltipTone\s*=\s*[^;]*["']description["']/,
    "the tooltip DOM needs a semantic class for description body copy");
  assert.match(spellbook,
    /lines\.push\(\{\s*text:\s*description,\s*tone:\s*["']description["']\s*\}\)/s,
    "a spell description must not be rendered as a small, muted footer line");
  assert.match(spellbook, /footer:\s*metadata\.passive\s*\?\s*undefined\s*:\s*\[["']Перетащите на панель команд["']\]/,
    "the interaction hint remains a distinct footer instead of sharing the description style");

  // A compact-viewport media query adds a later min-width override, so inspect the complete cascade
  // for this exact selector rather than pretending its last declaration is the desktop rule.
  const tooltip = allRules(css, "body.native-wow-ui .ui-tooltip");
  assert.match(tooltip, /width:\s*min\(420px,\s*calc\(100vw\s*-\s*16px\)\)/,
    "long Russian descriptions need a stable readable measure");
  assert.match(tooltip, /overflow-wrap:\s*break-word/,
    "ordinary words must wrap at word boundaries before breaking internally");
  assert.match(tooltip, /word-break:\s*normal/);

  const description = finalRule(css, "body.native-wow-ui .ui-tooltip > .ui-tooltip-description");
  assert.match(description, /color:\s*#f2ead8/,
    "description body copy needs high contrast instead of the footer's muted grey");
  assert.match(description, /font-size:\s*14px/);
  assert.match(description, /line-height:\s*1\.5/);
  assert.match(description, /padding-top:\s*6px/);
  assert.match(description, /border-top:\s*1px solid #5b4824/,
    "description text must be visually separated from spell mechanics");

  const footer = finalRule(css, "body.native-wow-ui .ui-tooltip > .ui-tooltip-footer");
  assert.match(footer, /color:\s*#a9a08c/);
  assert.match(footer, /font-size:\s*12px/,
    "the action hint may be quieter, but must remain legible");
});
