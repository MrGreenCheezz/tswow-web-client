import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function source(path) {
  return await readFile(new URL(path, root), "utf8");
}

function escapedRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function finalRule(css, selector) {
  const rules = [...css.matchAll(/(?:^|\n)\s*([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, header]) => header.replace(/\/\*[\s\S]*?\*\//g, "")
      .split(",").map((part) => part.trim()).includes(selector));
  return rules.at(-1)?.[2] ?? "";
}

function declaration(rule, property) {
  const escaped = escapedRegex(property);
  return rule.match(new RegExp(`(?:^|;)\\s*${escaped}\\s*:\\s*([^;]+)`))?.[1].trim() ?? "";
}

function effectiveDeclaration(css, selector, property, fallbacks = []) {
  for (const candidate of [selector, ...fallbacks]) {
    const value = declaration(finalRule(css, candidate), property);
    if (value) return value;
  }
  return "";
}

function effectiveCascadeDeclaration(css, selector, property) {
  const values = [...css.matchAll(/(?:^|\n)\s*([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, header]) => header.replace(/\/\*[\s\S]*?\*\//g, "")
      .split(",").map((part) => part.trim()).includes(selector))
    .map(([, , body]) => declaration(body, property))
    .filter(Boolean);
  return values.at(-1) ?? "";
}

function boxEdges(value) {
  const values = [...value.matchAll(/(-?\d+(?:\.\d+)?)px/g)].map(([, number]) => Number(number));
  if (values.length === 1) return [values[0], values[0], values[0], values[0]];
  if (values.length === 2) return [values[0], values[1], values[0], values[1]];
  if (values.length === 3) return [values[0], values[1], values[2], values[1]];
  if (values.length >= 4) return values.slice(0, 4);
  return [0, 0, 0, 0];
}

function firstPx(value) {
  return Number(value.match(/-?\d+(?:\.\d+)?px/)?.[0]?.replace("px", "") ?? NaN);
}

function firstNumber(value) {
  return Number(value.match(/-?\d+(?:\.\d+)?/)?.[0] ?? NaN);
}

function gridColumnCount(value) {
  const repeat = value.match(/repeat\(\s*(\d+)/);
  return repeat ? Number(repeat[1]) : 1;
}

function gridTrackWidth(value) {
  return firstPx(value);
}

function cssRgb(value) {
  const hex = value.match(/#([0-9a-f]{6,8})/i)?.[1];
  if (!hex) return undefined;
  return [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
}

function relativeLuminance(rgb) {
  return rgb.reduce((sum, channel, index) => {
    const linear = channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
    return sum + linear * [0.2126, 0.7152, 0.0722][index];
  }, 0);
}

function contrastRatio(foreground, background) {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function mediaBlocks(css, query) {
  const blocks = [];
  let cursor = 0;
  while (cursor < css.length) {
    const start = css.indexOf("@media", cursor);
    if (start < 0) break;
    const open = css.indexOf("{", start);
    if (open < 0) break;
    let depth = 0;
    let close = open;
    for (; close < css.length; close++) {
      if (css[close] === "{") depth++;
      if (css[close] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (css.slice(start, open).includes(query)) blocks.push(css.slice(open + 1, close));
    cursor = close + 1;
  }
  return blocks;
}

function withoutMedia(css) {
  let result = "";
  let cursor = 0;
  while (cursor < css.length) {
    const start = css.indexOf("@media", cursor);
    if (start < 0) {
      result += css.slice(cursor);
      break;
    }
    result += css.slice(cursor, start);
    const open = css.indexOf("{", start);
    if (open < 0) break;
    let depth = 0;
    let close = open;
    for (; close < css.length; close++) {
      if (css[close] === "{") depth++;
      if (css[close] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    cursor = close + 1;
  }
  return result;
}

async function pngDimensions(path) {
  const bytes = await readFile(new URL(path, root));
  assert.equal(bytes.subarray(1, 4).toString("ascii"), "PNG", `${path} must be a PNG asset`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test("the production HUD owns a WotLK-shaped native skin and paperdoll", async () => {
  const [html, css, skin, portraits, frames, unitSnapshot] = await Promise.all([
    source("index.html"),
    source("src/browser/style.css"),
    source("src/browser/ui/NativeUiSkin.ts"),
    source("src/browser/ui/Portraits.ts"),
    source("src/browser/ui/Frames.ts"),
    source("src/browser/ui/UnitSnapshot.ts"),
  ]);

  assert.match(html,
    /id="bottom-hud"[^>]+data-window-reserve-bottom[\s\S]*id="bottom-hud-center"[\s\S]*id="action-bar"[\s\S]*id="hud-utilities"[\s\S]*id="bag-bar"[\s\S]*id="game-buttons"/,
    "combat actions, bags, and micro controls need one ordered bottom HUD");
  assert.doesNotMatch(html, /id="main-menu-art"/,
    "the non-interactive gryphon deck must not cover the world behind live controls");
  assert.match(html, /id="character-model"[^>]+data-portrait-model-placeholder="true"/,
    "the native character sheet keeps a real full-body portrait target");
  assert.match(html, /id="character-identity"/, "race and class have a visible native home");
  assert.match(css, /body\.native-wow-ui/, "the stock-like rules must not leak into login/creation UI");
  assert.match(css, /--wow-quickslot/, "action sockets use the shipped client art when it is available");
  assert.match(skin, /Fonts\\\\FRIZQT__\.TTF/, "the native HUD uses the client's own readable UI face");
  assert.doesNotMatch(skin, /UI-MainMenuBar(?:-EndCap)?-Dwarf/,
    "removed bottom decoration must not keep fetching unused main-bar textures");
  for (const quadrant of skin.split(/\r?\n/).filter((line) => /UI-SpellbookPanel-(?:Top|Bot)/.test(line))) {
    assert.match(quadrant, /--wow-mail-(?:top|bottom)-right/,
      "stock spellbook quadrants belong only to the reference mailbox composite");
  }
  assert.match(skin, /UI-Quest-BulletPoint\.blp/, "quest objectives use the real client bullet asset");
  assert.doesNotMatch(skin, /UI-Tooltip-Border\.blp/,
    "an eight-piece edge atlas must not be passed raw to CSS border-image");
  assert.match(skin, /Button-Backpack-Up\.blp/, "inventory keeps the client backpack microbutton art");
  assert.doesNotMatch(skin, /--wow-micro-professions/,
    "professions must not masquerade as the quest-log microbutton");
  for (const art of ["UI-MicroButton-Quest-Up", "UI-MicroButton-Socials-Up",
    "UI-MicroButton-World-Up", "UI-MicroButton-MainMenu-Up"]) {
    assert.match(skin, new RegExp(`${art}\\.blp`),
      `${art} dresses its microbutton with client art`);
  }
  assert.doesNotMatch(skin, /--wow-(?:quest-details|skill-bar(?:-border|-highlight)?)/,
    "full framed and neutral status textures must not be stretched over unrelated native surfaces");
  assert.match(css, /body\.native-wow-ui #game-buttons #inventory-toggle[\s\S]*var\(--wow-micro-inventory/,
    "inventory keeps its text-accessible button while using backpack art");
  assert.doesNotMatch(css, /#(?:professions|diagnostics)-toggle/,
    "skills and diagnostics no longer keep dead standalone microbutton selectors");
  assert.match(html, /id="character-toggle"[\s\S]*id="character-micro-icon"/,
    "the empty character microbutton BLP needs the portrait layer authored for its opening");
  assert.doesNotMatch(html, /micro-button-label/,
    "native microbutton art must not be covered by duplicate shortcut-letter stickers");
  for (const [id, key] of [["character-toggle", "C"], ["inventory-toggle", "B"],
    ["spellbook-toggle", "P"], ["talents-toggle", "N"], ["game-menu-toggle", "Escape"]]) {
    assert.match(html, new RegExp(`id="${id}"[^>]+aria-label="[^"]+"[^>]+aria-keyshortcuts="${key}"`),
      `${id} keeps its shortcut in accessibility metadata instead of painting it over the icon`);
  }
  assert.match(html, /id="game-menu-toggle"[\s\S]*micro-button-glyph[^>]*aria-hidden="true"[^>]*>☰</,
    "the sixth control is a menu symbol, not another shortcut letter");
  assert.match(frames, /characterMicroIcon[\s\S]*CLASS_ATLAS_PATH/,
    "the character microbutton portrait follows the player's class art");
  assert.match(frames, /image\.onerror\s*=\s*\(\)\s*=>\s*\{[\s\S]*delete image\.dataset\["atlas"\]/,
    "a transient class-atlas failure must clear its marker so the next HUD paint retries it");
  const characterFrame = finalRule(withoutMedia(css),
    "body.native-wow-ui #game-buttons #character-toggle::after");
  const characterPortrait = finalRule(withoutMedia(css), "body.native-wow-ui #character-micro-icon");
  assert.ok(firstNumber(declaration(characterPortrait, "z-index"))
    > firstNumber(declaration(characterFrame, "z-index")),
  "the portrait OVERLAY must be painted above the opaque character-button BLP");
  assert.equal(declaration(characterPortrait, "bottom"), "4px",
    "the portrait follows the compact microbutton anchor instead of drifting a pixel down");
  assert.match(unitSnapshot, /clientHeight[\s\S]*classIconOffset/,
    "a rectangular micro portrait must centre the atlas cell on both axes");
  assert.match(css, /@media \(max-width: 620px\)[\s\S]*#bottom-hud[\s\S]*#action-bar/,
    "the narrow HUD keeps micro buttons and actions in the same responsive container");
  assert.doesNotMatch(css, /outline:\s*1px solid var\(--wow-skill-bar-highlight/,
    "a texture URL must never be parsed as the skill bar outline color");
  const slotRules = [...css.matchAll(/body\.native-wow-ui \.ui-icon-button\s*\{([^}]*)\}/gs)];
  const finalSlotRule = slotRules.at(-1)?.[1] ?? "";
  assert.match(css, /--action-slot-size:\s*clamp\(40px,\s*2\.1vw,\s*48px\)/,
    "wide native action slots should grow toward the authored 48px silhouette");
  assert.match(css, /--side-bar-slot:\s*var\(--action-slot-size\)/,
    "vertical action rows use the same published slot size as the main row");
  assert.match(finalSlotRule, /width:\s*var\(--action-slot-size\)/,
    "all action rows must consume the same measured slot size");
  assert.doesNotMatch(finalSlotRule, /var\(--wow-action-border/,
    "the default socket must not stack an action border over its slot art");
  const finalActionRule = finalRule(withoutMedia(css), "body.native-wow-ui .ui-action-button");
  assert.match(declaration(finalActionRule, "background-image"), /var\(--wow-action-slot/,
    "action buttons must win the cascade with their authored QuickSlot BLP");
  assert.ok(css.lastIndexOf("body.native-wow-ui .ui-action-button {")
    > css.lastIndexOf("body.native-wow-ui .ui-icon-button {"),
  "the action-specific texture rule must follow the generic slot rule of equal specificity");
  const micro = css.match(/body\.native-wow-ui #game-buttons\s*\{([^}]*)\}/s)?.[1] ?? "";
  const microButton = css.match(/body\.native-wow-ui #game-buttons button\s*\{([^}]*)\}/s)?.[1] ?? "";
  assert.match(micro, /display:\s*grid/);
  assert.match(micro, /grid-template-columns:\s*repeat\(10,\s*24px\)/,
    "character, bags, spellbook, talents, quest, socials, map, calendar, dungeon finder and menu share one row");
  assert.match(micro, /width:\s*262px/);
  assert.match(micro, /height:\s*54px/);
  assert.match(micro, /box-sizing:\s*border-box/);
  assert.match(micro, /padding:\s*2px/);
  assert.match(micro, /position:\s*static/,
    "the micro strip must follow the shared HUD flow instead of a separate viewport offset");
  assert.match(microButton, /width:\s*24px/);
  assert.match(microButton, /height:\s*48px/);
  // The stock 32x64 plates scaled to three quarters, undistorted: 10 buttons, 9 gaps,
  // and the padding make the strip width exactly.
  assert.equal(10 * 24 + 9 * 2 + 2 * 2, 262);
  assert.match(css, /#game-buttons #character-toggle,[\s\S]*?background-size:\s*24px 48px/,
    "button art scales with the buttons instead of cropping");
  assert.match(portraits, /mountNativeCharacterPortrait/, "the native paperdoll target is registered explicitly");
});

test("generated spellbook surface keeps names, ranks, and controls readable at every breakpoint", async () => {
  const [css, spellbookSize] = await Promise.all([
    source("src/browser/style.css"),
    pngDimensions("public/ui/spellbook-background-v2.png"),
  ]);
  const desktopCss = withoutMedia(css);
  const windowSelector = "body.native-wow-ui .spellbook-window";
  const listSelector = "body.native-wow-ui .spellbook-window .spellbook-list";
  const cardSelector = "body.native-wow-ui .spellbook-window .spellbook-list .spell-button";
  const iconSelector = "body.native-wow-ui .spellbook-window .spellbook-list .spell-icon";
  const cooldownSelector = "body.native-wow-ui .spellbook-window .spellbook-list .spell-cooldown";
  const labelSelector = "body.native-wow-ui .spellbook-window .spellbook-list .spell-label";
  const rankSelector = "body.native-wow-ui .spellbook-window .spellbook-list .spell-button small";
  const controlsSelector = "body.native-wow-ui .spellbook-window .spellbook-controls";
  const searchSelector = "body.native-wow-ui .spellbook-window .spellbook-controls input[type=\"search\"]";
  const tabsSelector = "body.native-wow-ui .spellbook-window .spellbook-tabs";
  const tabSelector = "body.native-wow-ui .spellbook-window .spellbook-tab";
  const spineSelector = "body.native-wow-ui .spellbook-window::after";

  const windowRule = finalRule(desktopCss, windowSelector);
  const listRule = finalRule(desktopCss, listSelector);
  const cardRule = finalRule(desktopCss, cardSelector);
  const iconRule = finalRule(desktopCss, iconSelector);
  const labelRule = finalRule(desktopCss, labelSelector);
  const rankRule = finalRule(desktopCss, rankSelector);
  const controlsRule = finalRule(desktopCss, controlsSelector);
  const searchRule = finalRule(desktopCss, searchSelector);
  const tabsRule = finalRule(desktopCss, tabsSelector);
  const tabRule = finalRule(desktopCss, tabSelector);

  const listMargins = boxEdges(effectiveDeclaration(
    desktopCss, listSelector, "margin", ["body.native-wow-ui .spellbook-list", ".spellbook-list"],
  ));
  const listPadding = boxEdges(effectiveDeclaration(
    desktopCss, listSelector, "padding", ["body.native-wow-ui .spellbook-list", ".spellbook-list"],
  ));
  const columnCount = gridColumnCount(effectiveDeclaration(
    desktopCss, listSelector, "grid-template-columns", ["body.native-wow-ui .spellbook-list", ".spellbook-list"],
  ));
  const columnGap = firstNumber(effectiveDeclaration(
    desktopCss, listSelector, "column-gap", ["body.native-wow-ui .spellbook-list", ".spellbook-list"],
  ) || effectiveDeclaration(desktopCss, listSelector, "gap", ["body.native-wow-ui .spellbook-list", ".spellbook-list"]));
  const windowWidth = firstPx(declaration(windowRule, "width"));
  const listContentWidth = windowWidth - listMargins[1] - listMargins[3]
    - listPadding[1] - listPadding[3];
  const columnWidth = (listContentWidth - (columnCount - 1) * columnGap) / columnCount;
  const cardBorder = firstPx(effectiveDeclaration(
    desktopCss, cardSelector, "border", ["body.native-wow-ui .spellbook-list .spell-button", ".spell-button"],
  ));
  const cardPadding = boxEdges(effectiveDeclaration(
    desktopCss, cardSelector, "padding", ["body.native-wow-ui .spellbook-list .spell-button", ".spell-button"],
  ));
  const iconTrack = gridTrackWidth(effectiveDeclaration(
    desktopCss, cardSelector, "grid-template-columns", ["body.native-wow-ui .spellbook-list .spell-button", ".spellbook-list .spell-button", ".spell-button"],
  ));
  const labelPadding = boxEdges(effectiveDeclaration(
    desktopCss, labelSelector, "padding", ["body.native-wow-ui .spellbook-list .spell-label", ".spellbook-list .spell-label", ".spell-label"],
  ));
  const nameTrack = columnWidth - cardBorder * 2 - cardPadding[1] - cardPadding[3]
    - iconTrack - labelPadding[1] - labelPadding[3];
  const labelFont = firstPx(effectiveDeclaration(
    desktopCss, labelSelector, "font-size", ["body.native-wow-ui .spellbook-list .spell-label", ".spellbook-list .spell-label", ".spell-label"],
  ));
  const labelLineHeight = firstNumber(effectiveDeclaration(
    desktopCss, labelSelector, "line-height", [cardSelector, "body.native-wow-ui .spellbook-list .spell-button", ".spellbook-list .spell-button", ".spell-button"],
  ));
  const rowMinHeight = firstPx(effectiveDeclaration(
    desktopCss, cardSelector, "min-height", ["body.native-wow-ui .spellbook-list .spell-button", ".spellbook-list .spell-button", ".spell-button"],
  ));
  const rowHeight = firstPx(effectiveDeclaration(
    desktopCss, cardSelector, "height", ["body.native-wow-ui .spellbook-list .spell-button", ".spellbook-list .spell-button", ".spell-button"],
  ));
  const iconWidth = firstPx(effectiveDeclaration(
    desktopCss, iconSelector, "width", ["body.native-wow-ui .spellbook-list .spell-icon", ".spellbook-list .spell-icon", ".spell-icon"],
  ));
  const iconHeight = firstPx(effectiveDeclaration(
    desktopCss, iconSelector, "height", ["body.native-wow-ui .spellbook-list .spell-icon", ".spellbook-list .spell-icon", ".spell-icon"],
  ));
  const cardColor = cssRgb(effectiveDeclaration(
    desktopCss, cardSelector, "background", ["body.native-wow-ui .spellbook-list .spell-button", ".spellbook-list .spell-button", ".spell-button"],
  ));
  const labelColor = cssRgb(effectiveDeclaration(
    desktopCss, labelSelector, "color", ["body.native-wow-ui .spellbook-list .spell-label", ".spellbook-list .spell-label", ".spell-label"],
  ));
  const contrast = cardColor && labelColor ? contrastRatio(labelColor, cardColor) : NaN;

  assert.ok(windowWidth >= 540 && windowWidth <= 590
    && nameTrack >= 160 && labelFont >= 13 && labelLineHeight >= 1.25
    && contrast >= 4.5 && rowMinHeight >= 60 && rowHeight >= 60
    && iconWidth >= 46 && iconHeight >= 46,
  `desktop metrics must be readable: width=${windowWidth}, columns=${columnCount}, `
    + `nameTrack=${nameTrack}, label=${labelFont}/${labelLineHeight}, `
    + `contrast=${Number.isFinite(contrast) ? contrast.toFixed(2) : "n/a"}, `
    + `row=${rowMinHeight}/${rowHeight}, icon=${iconWidth}/${iconHeight}, `
    + `math=${listContentWidth}/${columnWidth}, parts=${cardBorder}/${cardPadding.join("/")}/`
    + `${iconTrack}/${labelPadding.join("/")}`);
  assert.match(declaration(windowRule, "width"),
    /^min\(560px,\s*calc\(100vw\s*-\s*var\(--side-bars-width\)\s*-\s*32px\)\)$/);
  assert.match(declaration(windowRule, "height"),
    /^min\(660px,\s*var\(--game-window-max-height,\s*calc\(100vh\s*-\s*96px\)\)\)$/);
  assert.match(declaration(windowRule, "min-height"),
    /^min\(360px,\s*var\(--game-window-max-height,\s*360px\)\)$/);
  assert.match(windowRule, /overflow:\s*hidden/);
  assert.match(windowRule, /resize:\s*none/);
  const background = declaration(windowRule, "background-image");
  assert.match(background, /url\(["']?\/ui\/spellbook-background-v2\.png["']?\)/,
    "the spellbook owns one purpose-built high-resolution background");
  assert.doesNotMatch(background, /--wow-spellbook-|\/texture/,
    "the generated surface must not be mixed with legacy client panel quadrants");
  assert.ok(spellbookSize.width >= 1000 && spellbookSize.height >= 1000,
    `spellbook art must stay sharp, got ${spellbookSize.width}x${spellbookSize.height}`);
  assert.match(declaration(windowRule, "background-size"), /cover/,
    "the dedicated surface keeps its aspect ratio instead of being independently stretched");
  assert.equal(firstNumber(declaration(listRule, "column-gap")), 0);
  assert.ok(firstPx(declaration(listRule, "row-gap")) >= 8);
  assert.equal(columnCount, 1, "the moderately wider grimoire remains one predictable reading column");
  assert.match(declaration(listRule, "overflow-y"), /^auto$/);
  assert.match(declaration(listRule, "min-height"), /^0$/);
  assert.match(declaration(listRule, "flex"), /1/);
  assert.match(declaration(labelRule, "white-space"), /nowrap/);
  assert.match(declaration(labelRule, "text-overflow"), /ellipsis/);
  assert.equal(declaration(labelRule, "text-shadow"), "none");
  assert.match(declaration(iconRule, "width"), /48px/);
  assert.match(declaration(iconRule, "height"), /48px/);
  assert.equal(declaration(rankRule, "position"), "static");
  assert.match(declaration(rankRule, "grid-row"), /2/);
  assert.ok(firstPx(declaration(rankRule, "font-size")) >= 12);
  assert.ok(firstNumber(declaration(rankRule, "line-height")) >= 1.15);
  assert.match(declaration(cooldownSelector ? finalRule(desktopCss, cooldownSelector) : "", "inset"), /8px\s+auto\s+auto\s+8px/);
  assert.match(declaration(finalRule(desktopCss, cooldownSelector), "width"), /48px/);
  assert.match(declaration(finalRule(desktopCss, cooldownSelector), "height"), /48px/);
  assert.ok(firstPx(declaration(searchRule, "min-height")) >= 34);
  assert.ok(firstPx(declaration(searchRule, "font-size")) >= 13);
  assert.match(declaration(finalRule(desktopCss,
    "body.native-wow-ui .spellbook-window .spellbook-controls label"), "flex"), /0\s+0\s+auto/,
  "the full rank-filter label must not be squeezed into unreadable clipped text");
  assert.ok(firstPx(declaration(finalRule(desktopCss, "body.native-wow-ui .spellbook-window #spell-status"), "font-size")) >= 12);
  assert.ok(firstPx(declaration(tabRule, "min-height")) >= 32);
  assert.ok(firstPx(declaration(tabRule, "font-size")) >= 12);
  assert.match(declaration(controlsRule, "order"), /1/);
  assert.match(declaration(tabsRule, "order"), /2/);
  assert.match(declaration(finalRule(desktopCss, listSelector), "order"), /3/);
  assert.match(declaration(tabsRule, "flex"), /0\s+0\s+auto/);
  assert.match(declaration(tabsRule, "max-width"), /calc\(/);
  const tabsMaxHeight = effectiveCascadeDeclaration(desktopCss, tabsSelector, "max-height");
  const tabsOverflowY = effectiveCascadeDeclaration(desktopCss, tabsSelector, "overflow-y");
  assert.match(tabsMaxHeight, /^(?:none|unset|initial|inherit)$/,
    `spellbook tabs must be unbounded in the effective cascade, got ${tabsMaxHeight || "missing"}`);
  assert.match(tabsOverflowY, /^visible$/,
    `spellbook tabs must not retain a scrolling overflow axis, got ${tabsOverflowY || "missing"}`);

  assert.equal(finalRule(desktopCss, spineSelector), "",
    "the generated grimoire must not invent a false center spine");
  assert.ok(css.lastIndexOf(windowSelector) > css.lastIndexOf(".spellbook-tab {"),
    "the native tab rule must come after generic spellbook-tab styling");

  const mobile760 = mediaBlocks(css, "max-width: 760px").at(-1) ?? "";
  const mobileWindowRule = finalRule(mobile760, windowSelector);
  const mobileListRule = finalRule(mobile760, listSelector);
  const mobileCardRule = finalRule(mobile760, cardSelector);
  const mobileColumns = gridColumnCount(declaration(mobileListRule, "grid-template-columns"));
  assert.equal(mobileColumns, 1, "the narrow grimoire remains one page");
  assert.match(declaration(mobileWindowRule, "width"), /^min\(560px,\s*calc\(100vw\s*-\s*24px\)\)$/);
  assert.ok(firstPx(declaration(mobileListRule, "margin")) >= 0);
  const mobileWindowWidth = firstPx(declaration(mobileWindowRule, "width"));
  const mobileMargins = boxEdges(declaration(mobileListRule, "margin"));
  const mobilePadding = boxEdges(declaration(mobileListRule, "padding"));
  const mobileCardWidth = mobileWindowWidth - mobileMargins[1] - mobileMargins[3]
    - mobilePadding[1] - mobilePadding[3];
  const mobileCardBorder = firstPx(declaration(mobileCardRule, "border")) || cardBorder;
  const mobileCardPadding = boxEdges(declaration(mobileCardRule, "padding"));
  const mobileIconTrack = gridTrackWidth(declaration(mobileCardRule, "grid-template-columns")) || iconTrack;
  const mobileLabelPadding = labelPadding;
  const mobileNameTrack = mobileCardWidth - mobileCardBorder * 2
    - mobileCardPadding[1] - mobileCardPadding[3] - mobileIconTrack
    - mobileLabelPadding[1] - mobileLabelPadding[3];
  assert.ok(mobileNameTrack >= 180, `760px name track remains usable: ${mobileNameTrack}px`);
  assert.equal(finalRule(mobile760, spineSelector), "");

  const mobile520 = mediaBlocks(css, "max-width: 520px").at(-1) ?? "";
  const narrowWindowRule = finalRule(mobile520, windowSelector);
  const narrowListRule = finalRule(mobile520, listSelector);
  const narrowCardRule = finalRule(mobile520, cardSelector);
  const narrowIconRule = finalRule(mobile520, iconSelector);
  const narrowControlsRule = finalRule(mobile520, controlsSelector);
  const narrowSearchRule = finalRule(mobile520, searchSelector);
  const narrowControlsLabelRule = finalRule(mobile520,
    "body.native-wow-ui .spellbook-window .spellbook-controls label");
  assert.match(declaration(narrowWindowRule, "width"), /^calc\(100vw\s*-\s*16px\)$/);
  assert.match(declaration(narrowWindowRule, "height"),
    /^min\(660px,\s*var\(--game-window-max-height,\s*calc\(100vh\s*-\s*96px\)\)\)$/,
    "the phone grimoire uses the same bounded reading height instead of a BLP-derived ratio");
  assert.equal(declaration(narrowControlsRule, "flex-wrap"), "wrap",
    "phone controls wrap so the rank label never escapes the authored folio");
  assert.equal(declaration(narrowSearchRule, "flex-basis"), "100%");
  assert.equal(declaration(narrowControlsLabelRule, "white-space"), "normal");
  assert.ok(firstPx(declaration(narrowIconRule, "width")) >= 44);
  assert.ok(firstPx(declaration(narrowIconRule, "height")) >= 44);
  assert.ok(firstPx(declaration(narrowCardRule, "min-height")) >= 60);
  assert.ok(firstPx(declaration(narrowCardRule, "font-size")) >= 13
    || firstPx(declaration(labelRule, "font-size")) >= 13);
  const narrowViewport = 375;
  const narrowWindowWidth = narrowViewport - 16;
  const narrowMargins = boxEdges(declaration(narrowListRule, "margin"));
  const narrowPadding = boxEdges(declaration(narrowListRule, "padding"));
  assert.ok(narrowWindowWidth - narrowMargins[1] - narrowMargins[3]
    - narrowPadding[1] - narrowPadding[3] > 0,
  "375px folio retains positive list width without horizontal overflow");
});

test("generated talent map replaces stretched client quadrants and never scrolls the whole window", async () => {
  const [css, talents, talentSize] = await Promise.all([
    source("src/browser/style.css"),
    source("src/browser/ui/Talents.ts"),
    pngDimensions("public/ui/talents-background-v2.png"),
  ]);
  const desktop = withoutMedia(css);
  const windowRule = finalRule(desktop, "body.native-wow-ui .talents-window");
  const bodyRule = finalRule(desktop, "body.native-wow-ui .talents-window > .ui-panel-body");
  const gridRule = finalRule(desktop, "body.native-wow-ui .talents-grid");
  const tabsRule = finalRule(desktop, "body.native-wow-ui .talents-tabs");

  assert.match(declaration(windowRule, "width"),
    /^min\(640px,\s*calc\(100vw\s*-\s*24px\)\)$/);
  assert.match(declaration(windowRule, "background-image"),
    /url\(["']?\/ui\/talents-background-v2\.png["']?\)/);
  assert.match(declaration(windowRule, "background-size"), /cover/);
  assert.equal(declaration(windowRule, "overflow"), "hidden");
  assert.equal(declaration(windowRule, "resize"), "none");
  assert.equal(declaration(bodyRule, "overflow"), "hidden",
    "the panel itself must not grow a scrollbar around the talent tree");
  assert.match(declaration(bodyRule, "--talent-size"), /clamp\(/,
    "talent cells shrink with viewport height so the complete tree stays visible");
  assert.equal(declaration(tabsRule, "overflow-x"), "visible",
    "three branches wrap as tabs instead of forming another scrollbar");
  assert.match(declaration(gridRule, "max-width"), /100%/);
  assert.ok(talentSize.width >= 1400 && talentSize.height >= 900,
    `talent art must stay sharp, got ${talentSize.width}x${talentSize.height}`);
  assert.doesNotMatch(talents, /talent-tree-backdrop|drawTalentTreeBackdrop|talentTabBackgroundPaths/,
    "no low-resolution client quadrant may be stretched behind the generated talent map");
  assert.doesNotMatch(css, /\.talent-tree-backdrop/);
});

test("native action items retain their full tooltip and stack count", async () => {
  const actionBar = await source("src/browser/ui/ActionBar.ts");
  assert.match(actionBar, /itemTooltipFor\(content\.action/,
    "an action item must reuse the complete item tooltip rather than a name-only substitute");
  assert.match(actionBar, /dataset\["count"\]/,
    "an action item must publish its carried stack count on the button");
});

test("native bottom controls share one flow without a decorative deck", async () => {
  const [html, css] = await Promise.all([source("index.html"), source("src/browser/style.css")]);
  const desktop = withoutMedia(css);
  const hud = finalRule(desktop, "body.native-wow-ui #bottom-hud");
  const utilities = finalRule(desktop, "body.native-wow-ui #hud-utilities");
  const action = finalRule(desktop, "body.native-wow-ui #action-bar");
  const extras = finalRule(desktop, "body.native-wow-ui #action-bar-extras");
  const micro = finalRule(desktop, "body.native-wow-ui #game-buttons");
  const bags = finalRule(desktop, "body.native-wow-ui .bag-bar");

  assert.doesNotMatch(html, /main-menu-art/);
  assert.doesNotMatch(css, /#main-menu-art|--wow-mainbar-(?:art|endcap)/,
    "the removed full-width plate and gryphons must leave no rendering layer behind");
  assert.match(hud, /position:\s*absolute/);
  assert.match(hud, /display:\s*grid/);
  assert.match(hud, /grid-template-columns:\s*minmax\(190px,\s*1fr\)\s+auto\s+minmax\(190px,\s*1fr\)/,
    "equal side tracks keep the combat bar on the viewport centre line");
  assert.equal(effectiveCascadeDeclaration(desktop, "body.native-wow-ui #bottom-hud-center", "display"), "flex");
  assert.equal(effectiveCascadeDeclaration(desktop, "body.native-wow-ui #bottom-hud-center", "flex-direction"), "column");
  assert.equal(effectiveCascadeDeclaration(desktop, "body.native-wow-ui #bottom-hud-center", "align-items"), "center");
  assert.match(utilities, /flex-direction:\s*column/);
  assert.match(utilities, /align-items:\s*flex-end/);
  for (const [name, rule] of [["action bar", action], ["extra rows", extras],
    ["micro buttons", micro], ["bags", bags]]) {
    assert.match(rule, /position:\s*static/, `${name} must participate in the shared layout flow`);
  }
  assert.match(css, /--hud-safe-bottom:\s*calc\([^;]*var\(--bottom-bars\)/,
    "the shared safe edge must rise with enabled extra action rows");
  assert.match(css, /--chat-bottom:\s*calc\([^;]*var\(--hud-safe-bottom\)/,
    "chat must consume the same bottom HUD measurement instead of covering it");

  const compact = mediaBlocks(css, "max-width: 1280px").join("\n");
  assert.match(finalRule(compact, "body.native-wow-ui #bottom-hud"), /grid-template-columns:\s*1fr/);
  assert.match(finalRule(compact, "body.native-wow-ui #hud-utilities"), /flex-direction:\s*row/,
    "compact utility groups form one deliberate row above the combat stack");
});

test("compact native rails and component icons keep their own readable geometry", async () => {
  const css = await source("src/browser/style.css");
  const narrow = mediaBlocks(css, "max-width: 800px").join("\n");
  const target = finalRule(narrow, "body.native-wow-ui .target-rail");
  const unit = finalRule(narrow, "body.native-wow-ui .unit-frame");
  const right = finalRule(narrow, "body.native-wow-ui .right-rail");
  const chat = finalRule(narrow, "body.native-wow-ui .chat-window");
  assert.match(target, /right:\s*calc\(20px\s*\+\s*var\(--side-bars-width\)\)/,
    "the target stays left of any visible full-size side action column");
  assert.match(target, /left:\s*auto/,
    "the target frame must stay inside the compact viewport instead of keeping left: 310px");
  assert.match(finalRule(narrow, "body.world-active .target-rail"), /transform-origin:\s*top right/,
    "a scaled compact target expands away from the reserved side-action edge");
  assert.match(unit, /width:\s*100%/);
  assert.match(right, /top:\s*180px/,
    "the minimap rail starts below the compact target frame");
  assert.match(right, /right:\s*calc\(20px\s*\+\s*var\(--side-bars-width\)\)/,
    "the compact minimap column must not sit under the side action rail");
  assert.match(chat, /width:\s*min\(440px,\s*calc\(100vw\s*-\s*24px\)\)/,
    "compact chat text needs the available viewport width, not 42vw");

  const desktop = withoutMedia(css);
  assert.match(desktop,
    /body\.native-wow-ui \.target-rail\s*\{[^}]*left:\s*calc\(52px\s*\+\s*258px\s*\*\s*var\(--ui-scale-effective\)\)/s,
    "desktop target placement must include the painted width of the scaled player rail");
  assert.match(finalRule(desktop, "body.native-wow-ui .tracking-row .ui-icon-button"),
    /width:\s*28px[\s\S]*min-height:\s*28px/);
  assert.match(finalRule(desktop, "body.native-wow-ui .pet-bar .ui-icon-button"),
    /width:\s*32px[\s\S]*min-height:\s*32px/);
  assert.match(finalRule(desktop, "body.native-wow-ui .action-bar-side-column .ui-icon-button"),
    /width:\s*var\(--side-bar-slot\)[\s\S]*height:\s*var\(--side-bar-slot\)[\s\S]*min-height:\s*var\(--side-bar-slot\)/,
    "side actions must use the same published slot geometry as the main row");

  const phone = mediaBlocks(css, "max-width: 480px").join("\n");
  assert.match(finalRule(phone, "body.native-wow-ui #action-bar"),
    /width:\s*min\(100%,\s*306px\)[\s\S]*repeat\(6/,
    "phone actions wrap into two readable six-slot rows");
  assert.match(finalRule(phone, "body.native-wow-ui .right-rail"),
    /bottom:\s*calc\(var\(--chat-bottom\)\s*\+\s*var\(--chat-height\)\s*\+\s*8px\)/,
    "the compact minimap rail ends before the readable chat surface begins");
  const compactRoot = finalRule(mediaBlocks(css, "max-width: 620px").join("\n"), ":root");
  assert.match(declaration(compactRoot, "--side-bars"), /^0\s*!important$/,
    "once phone CSS hides the side rail it must release the reserved horizontal gutter");
  assert.doesNotMatch(declaration(compactRoot, "--hud-safe-bottom"), /--bottom-bars/,
    "hidden extra rows must not leave a phantom mobile safe-area gap");
});

test("native BLP composites stay on their authored owner instead of tiling arbitrary children", async () => {
  const [css, skin] = await Promise.all([
    source("src/browser/style.css"),
    source("src/browser/ui/NativeUiSkin.ts"),
  ]);
  const desktop = withoutMedia(css);
  const quest = finalRule(desktop, "body.native-wow-ui .quest-log");
  const questList = finalRule(desktop, "body.native-wow-ui .quest-log-list");
  const questDetails = finalRule(desktop, "body.native-wow-ui .quest-log-details");
  const questSection = finalRule(desktop, "body.native-wow-ui .quest-detail-section");
  const questMarker = finalRule(desktop, "body.native-wow-ui .quest-log-list-entry::before");
  const objectiveMarker = finalRule(
    desktop, "body.native-wow-ui .quest-detail-objectives > .ui-line::before");
  const tooltip = finalRule(desktop, "body.native-wow-ui .ui-tooltip");

  const questBackground = declaration(quest, "background-image");
  assert.equal((questBackground.match(/--wow-quest-folio-left/g) ?? []).length, 1);
  assert.equal((questBackground.match(/--wow-quest-folio-right/g) ?? []).length, 1);
  assert.match(declaration(quest, "background-position"), /left top,\s*right top/);
  assert.match(declaration(quest, "background-repeat"), /no-repeat/);
  assert.doesNotMatch(declaration(questList, "background-image"), /--wow-quest-folio/,
    "the left 512px composite belongs to the whole authored frame, not a scrolling list tile");
  assert.doesNotMatch(declaration(questDetails, "background-image"), /--wow-quest-details/,
    "a framed top-left panel must not repeat underneath readable quest text");
  assert.doesNotMatch(declaration(tooltip, "border-image"), /--wow-tooltip-border/,
    "the tooltip's horizontal eight-tile atlas is not a CSS 9-slice image");
  assert.doesNotMatch(declaration(questSection, "border-image"), /--wow-quest-break/);
  assert.match(declaration(questSection, "background-image"), /--wow-quest-break/,
    "the 256x32 quest ornament is painted as an ornament rather than collapsed into a 1px border");
  assert.equal(effectiveCascadeDeclaration(
    desktop, "body.native-wow-ui .quest-log-list-entry", "position"), "relative");
  assert.equal(declaration(questMarker, "position"), "absolute");
  assert.doesNotMatch(questMarker, /grid-(?:row|column)/,
    "the decorative book must not consume the title's first grid cell and displace its state");
  assert.equal(declaration(objectiveMarker, "position"), "absolute",
    "the quest bullet must not become a third flex item and space itself away from the objective");
  assert.equal(finalRule(desktop, "body.native-wow-ui .quest-detail-objectives .ui-line::before"), "",
    "nested objective rows already own an icon and must not receive a second decorative bullet");
  assert.doesNotMatch(skin, /--wow-tooltip-border|--wow-quest-details|--wow-skill-bar/,
    "known composite/neutral BLPs are not published for structurally invalid consumers");
});

test("native rails keep dynamic player information reachable and clear of the compact minimap", async () => {
  const css = await source("src/browser/style.css");
  const desktop = withoutMedia(css);
  assert.equal(declaration(finalRule(desktop, ".left-rail"), "overflow-y"), "auto",
    "bounded player frames must scroll instead of silently clipping party/pet/focus rows");
  assert.equal(declaration(finalRule(desktop, ".left-rail > *"), "flex-shrink"), "0",
    "fixed player frames and aura icons retain their full height inside the scrolling rail");
  assert.doesNotMatch(desktop, /\.left-rail\s*>\s*\.combat-log|(?:^|})\s*\.combat-log\s*\{/,
    "combat history belongs to the chat tab and must not reserve space in the player rail");
  assert.equal(declaration(finalRule(desktop, ".right-rail"), "overflow-y"), "auto",
    "the minimap/tracker rail must keep later actionable rows reachable");
  const chatForm = finalRule(desktop, "#chat-form");
  assert.equal(declaration(chatForm, "margin"), "0",
    "the chat reserve assumes the dock form does not inherit the global 48px vertical margin");
  assert.equal(declaration(chatForm, "gap"), "0");

  const auraCompact = mediaBlocks(css, "max-width: 1024px").join("\n");
  const playerAuras = finalRule(auraCompact, "body.native-wow-ui .player-auras");
  assert.equal(declaration(playerAuras, "position"), "static",
    "player auras rejoin their rail before the desktop width formula collapses to one icon");
  assert.match(finalRule(desktop, "body.native-wow-ui .aura-icon"), /flex:\s*0\s+0\s+40px/,
    "compact horizontal aura rows must scroll full icons instead of shrinking them into slivers");

  const narrow = mediaBlocks(css, "max-width: 800px").join("\n");
  const auraRule = finalRule(narrow, "body.native-wow-ui .aura-strip");
  const right = finalRule(narrow, "body.native-wow-ui .right-rail");
  assert.equal(declaration(auraRule, "flex-wrap"), "nowrap");
  assert.equal(declaration(auraRule, "overflow-x"), "auto",
    "compact auras remain one bounded row instead of growing through the minimap");
  assert.ok(firstPx(declaration(right, "top")) >= 176,
    "the compact right rail starts below the target frame, its action row, and one aura row");
  assert.equal(declaration(right, "overflow-y"), "auto");
  assert.ok(firstPx(declaration(finalRule(narrow, "body.native-wow-ui .minimap"), "width")) <= 124);
  assert.ok(firstPx(declaration(finalRule(narrow, "body.native-wow-ui #minimap-canvas"), "width")) <= 116);
  assert.match(finalRule(narrow, "body.native-wow-ui .right-rail > *"), /max-width:\s*100%/,
    "every compact tracker/frame stays inside the 130px rail");

  const short = mediaBlocks(css, "max-height: 720px").join("\n");
  const shortSide = finalRule(short, "body.native-wow-ui #action-bar-side");
  assert.equal(declaration(shortSide, "top"), "8px",
    "the full-size side rail moves upward on a short viewport instead of disappearing");
  assert.doesNotMatch(shortSide, /display:\s*none/,
    "height alone must not hide the player's secondary action bar");
  assert.equal(declaration(finalRule(desktop, "body.native-wow-ui #action-bar-side"), "overflow-y"), "auto",
    "full-size side actions remain reachable through bounded scrolling");
  assert.doesNotMatch(finalRule(short, ":root"), /--side-bars:\s*0/,
    "a short screen still reserves the visible secondary-action gutter");
});

test("native windows reserve the live bottom deck and action keys do not cover spell art", async () => {
  const [html, css, actionBar, petBar, windows] = await Promise.all([
    source("index.html"),
    source("src/browser/style.css"),
    source("src/browser/ui/ActionBar.ts"),
    source("src/browser/ui/PetBar.ts"),
    source("src/browser/GameWindows.ts"),
  ]);

  assert.match(html, /id="bottom-hud"[^>]+data-window-reserve-bottom/,
    "the single bottom container publishes the full live HUD height");
  for (const id of ["action-bar", "bag-bar", "game-buttons"]) {
    assert.doesNotMatch(html, new RegExp(`id="${id}"[^>]+data-window-reserve-bottom`),
      `${id} must not publish an independent competing bottom inset`);
  }
  assert.doesNotMatch(actionBar, /bottom\.dataset\["windowReserveBottom"\]/,
    "dynamic bottom rows are measured through their shared parent");
  assert.match(actionBar, /windowReserveRight/, "vertical action rows reserve the right edge");
  assert.match(actionBar, /closest<HTMLElement>\("#world-viewport"\)/,
    "the right action rail must stay mounted to the viewport edge");
  assert.match(petBar, /getElementById\("bottom-hud-center"\)/,
    "the pet or vehicle bar joins the ordered combat stack");
  assert.doesNotMatch(petBar, /windowReserveBottom/,
    "the pet row is measured once through #bottom-hud");
  assert.match(windows, /\[data-window-reserve-bottom\]/,
    "window placement measures the visible deck instead of carrying another height guess");
  assert.match(windows, /\[data-window-reserve-right\]/,
    "remembered window positions cannot return underneath vertical action rows");
  assert.match(windows, /--game-window-max-height/,
    "window height is published from the measured free area");
  assert.match(finalRule(withoutMedia(css), ".game-window"),
    /max-height:\s*min\(72vh,\s*var\(--game-window-max-height,\s*72vh\)\)/);

  const keyRule = finalRule(withoutMedia(css),
    "body.native-wow-ui #action-bar .ui-action-button > .ui-icon-key");
  assert.match(declaration(keyRule, "background"), /transparent/);
  assert.match(declaration(keyRule, "border"), /^0$/);
  assert.match(declaration(keyRule, "padding"), /^(?:0|1px 0)$/);
  assert.ok(firstPx(declaration(keyRule, "font-size")) <= 11,
    "a shortcut remains a corner label, not an opaque panel over the icon");
});

test("native character and target frames expose class identity", async () => {
  const [sheet, frames] = await Promise.all([
    source("src/browser/ui/CharacterSheet.ts"),
    source("src/browser/ui/Frames.ts"),
  ]);
  assert.match(sheet, /characterIdentity\.textContent/);
  assert.match(sheet, /raceName\(/);
  assert.match(sheet, /className\(/);
  assert.match(frames, /className\(unit\.classId\(target\)\)/,
    "a targeted player should not lose the class line that the original frame exposes");
});
