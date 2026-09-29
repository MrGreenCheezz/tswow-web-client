import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import { openClientArchives } from "../tools/mpq.mjs";
import { CLASS_ICON_DATA_AVAILABLE, CLASS_ICON_TCOORDS } from "../dist/code/generated/classIcons.js";
import {
  CLASS_ATLAS_CELL_SIZE, CLASS_ATLAS_DEFAULT_SIZE, CLASS_ATLAS_PATH, CLASS_FILE_NAMES,
  CLASS_NAMES, CLASS_PORTRAIT_SIZE, CLASS_ROGUE, RACE_NAMES, classColor, classFileName,
  classIconOffset, className, classPortraitPosition, forgetCreationNames, generatedClassColor,
  hasClassIcon, learnCreationNames, raceName,
} from "../dist/code/browser/ui/UnitSnapshot.js";
import {
  CreationMemo, LatestAppearanceRequest, creationClasses, creationRaces, isCreationData, raceDisplayId,
} from "../dist/code/browser/ui/CharacterCreation.js";
import { loadCharacterCreation } from "../dist/code/gateway/CharacterCreation.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";

/**
 * Enough of a document for two modules that hold element handles at import time.
 *
 * `Frames.ts` and `ItemSlots.ts` reach `ui/Dom.ts`, which resolves 166 elements the moment it is
 * loaded, so neither can be imported into node without one. Everything here answers the shape and
 * nothing else: the two functions under test take a number and return a string.
 */
function domStub() {
  const element = () => ({
    children: [], dataset: {}, style: { setProperty() {} }, className: "", textContent: "",
    value: "", hidden: false, options: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    append() {}, replaceChildren() {}, addEventListener() {}, removeEventListener() {},
    setAttribute() {}, removeAttribute() {}, getAttribute: () => null,
    closest: () => undefined, querySelector: () => element(), querySelectorAll: () => [],
  });
  globalThis.location = { protocol: "http:", hostname: "127.0.0.1", origin: "http://127.0.0.1:5173" };
  globalThis.document = {
    createElement: element, createElementNS: element,
    getElementById: element, querySelector: element, querySelectorAll: () => [],
    body: element(), documentElement: element(), head: element(), addEventListener() {},
  };
  globalThis.window = { addEventListener() {}, devicePixelRatio: 1 };
}
domStub();
const { POWER_NAMES, powerName, visibleEquipmentFor, visibleEquipmentMetadataPendingFor } =
  await import("../dist/code/browser/ui/Frames.js");
const { qualityName } = await import("../dist/code/browser/ui/ItemSlots.js");

let dbcDirectory;
let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  dbcDirectory = paths.dbcDirectory();
  clientDirectory = paths.clientDirectory();
} catch {
  dbcDirectory = undefined;
}
const withDataset = { skip: dbcDirectory ? false : "no tswow dataset on this machine" };
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine" };
const withClassIconData = {
  skip: CLASS_ICON_DATA_AVAILABLE ? false : "no locally generated class-icon data",
};

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

test("late character-look answers cannot replace a newer race, sex or gateway", () => {
  const requests = new LatestAppearanceRequest();
  const human = requests.begin("ws://realm-a", 1, 0);
  assert.equal(human.changed, true);
  const humanRetry = requests.begin("ws://realm-a", 1, 0);
  assert.equal(humanRetry.changed, false, "a retry may keep the currently displayed look");
  assert.equal(requests.isCurrent(human.serial, "ws://realm-a", 1, 0), false);
  assert.equal(requests.isCurrent(humanRetry.serial, "ws://realm-a", 1, 0), true);

  const orc = requests.begin("ws://realm-a", 2, 0);
  assert.equal(orc.changed, true, "changing race must clear the prior indices immediately");
  assert.equal(requests.isCurrent(humanRetry.serial, "ws://realm-a", 1, 0), false);
  assert.equal(requests.isCurrent(orc.serial, "ws://realm-a", 2, 1), false,
    "a changed sex invalidates the answer even before another request starts");
  const otherRealm = requests.begin("ws://realm-b", 2, 0);
  assert.equal(otherRealm.changed, true);
  assert.equal(requests.isCurrent(orc.serial, "ws://realm-a", 2, 0), false);
  assert.equal(requests.isCurrent(otherRealm.serial, "ws://realm-b", 2, 0), true);
});

test("a late look answer for a different class cannot replace the selected class", () => {
  const requests = new LatestAppearanceRequest();
  const warrior = requests.begin("ws://realm-a", 1, 0, 1);
  const deathKnight = requests.begin("ws://realm-a", 1, 0, 6);
  assert.equal(deathKnight.changed, true);
  assert.equal(requests.isCurrent(warrior.serial, "ws://realm-a", 1, 0, 1), false);
  assert.equal(requests.isCurrent(deathKnight.serial, "ws://realm-a", 1, 0, 6), true);
  assert.equal(requests.isCurrent(deathKnight.serial, "ws://realm-a", 1, 0, 1), false);
});

test("visible ranged equipment carries its subclass and reports late item metadata", async () => {
  const first = UPDATE_FIELDS.PLAYER_VISIBLE_ITEM_1_ENTRYID.offset;
  const stride = UPDATE_FIELDS.PLAYER_VISIBLE_ITEM_2_ENTRYID.offset - first;
  const object = { fields: new Map([[first + 17 * stride, 1234]]) };
  const unresolved = { get: () => undefined, load: async () => undefined };
  assert.equal(visibleEquipmentMetadataPendingFor(object, unresolved), true);
  const itemMetadata = {
    get: (entry) => entry === 1234 ? {
      displayId: 8106, inventoryType: 15, subClass: 2,
    } : undefined,
    load: async () => undefined,
  };
  assert.equal(visibleEquipmentMetadataPendingFor(object, itemMetadata), false);
  assert.deepEqual(visibleEquipmentFor(object, itemMetadata), [{
    slot: 17, inventoryType: 15, displayId: 8106, subClass: 2,
  }]);
  assert.equal(visibleEquipmentMetadataPendingFor(object, {
    get: () => ({ displayId: 8106, inventoryType: 15 }), load: async () => undefined,
  }), true, "the ranged row stays pending until ItemSubClass arrives");
});

/**
 * Every string literal in a source file, as the compiler sees it: raw text and runtime value.
 *
 * Read with TypeScript's own parser rather than with a regular expression because the thing being
 * looked for lives in string literals and is *written out in prose* in the comment above the
 * constant it broke — a text scan would find the documentation and call it a defect.
 */
function stringLiterals(source, fileName) {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true);
  const found = [];
  const visit = (node) => {
    const kind = node.kind;
    if (kind === ts.SyntaxKind.StringLiteral
      || kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral
      || kind === ts.SyntaxKind.TemplateHead) {
      const text = node.getText(file);
      // Strip the delimiters: a quote or a backtick either side, and `${` closing a template head.
      const raw = kind === ts.SyntaxKind.TemplateHead
        ? text.slice(1, -2)
        : text.slice(1, -1);
      // `String.raw` hands the raw text through untouched; everything else is cooked by the
      // language, which is exactly where a lone backslash disappears. The tag is the parent for
      // a template with no substitutions and the grandparent for one with them.
      const isRaw = [node.parent, node.parent?.parent].some((ancestor) =>
        ancestor?.kind === ts.SyntaxKind.TaggedTemplateExpression
        && ancestor.tag?.getText(file) === "String.raw");
      const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
      found.push({ raw, value: isRaw ? raw : node.text, line });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

async function typeScriptFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await typeScriptFiles(absolute));
    else if (entry.name.endsWith(".ts")) files.push(absolute);
  }
  return files;
}

/** The top-level directories of a 3.3.5 MPQ, which is what makes a literal look like a path. */
const ARCHIVE_ROOTS = [
  "Interface", "Character", "Creature", "World", "Textures", "Tileset", "Item", "Spells",
  "Sound", "Environments", "Cameras", "DBFilesClient", "XTextures", "Shaders",
];
const LOOKS_LIKE_A_PATH = new RegExp(`^(?:${ARCHIVE_ROOTS.join("|")})\\\\`, "i");

/** How many separators the author wrote, against how many the compiler let through. */
function separators(literal) {
  // `\\` first in the alternation, so an escaped separator counts once and not twice; in a
  // `String.raw` literal the raw text and the value are the same string and both count alike.
  const written = literal.raw.split(/\\\\|\\/).length - 1;
  const kept = literal.value.split("\\").length - 1;
  return { written, kept };
}

test("Д3 every archive path literal still has its backslashes after the compiler is done", async (t) => {
  // `CLASS_ATLAS_PATH` was written `"Interface\TargetingFrame\UI-Classes-Circles.blp"`. Neither
  // `\T` nor `\U` is an escape sequence, so TypeScript threw both backslashes away and the client
  // shipped a 45-character path with no separators in it; the gateway answered 404 and the class
  // portrait had never been drawn. Nothing in `npm run build` noticed, and the same mistake is
  // available to every path literal under `src/` — so all of it is swept, gateway included, and
  // not only the two directories the constant that broke happens to live between.
  const files = await typeScriptFiles(join(projectRoot, "src"));
  const paths = [];
  const collapsed = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const literal of stringLiterals(source, file)) {
      if (!LOOKS_LIKE_A_PATH.test(literal.raw)) continue;
      paths.push(`${file}:${literal.line} ${literal.raw}`);
      // Counted, not merely looked for: `"Interface\\Icons\Foo.blp"` keeps one backslash and
      // loses the other, which is the same defect wearing half a disguise and would walk past a
      // test that only asked whether any survived.
      const { written, kept } = separators(literal);
      if (kept < written) {
        collapsed.push(`${file}:${literal.line} ${literal.raw} → ${literal.value} (${written} → ${kept})`);
      }
    }
  }
  assert.deepEqual(collapsed, [], "these path literals lose separators when compiled");
  // The sweep has to be able to fail: a matcher that finds nothing passes for the wrong reason.
  // Fifteen today — the class atlas, the default equipment-set icon, two world-map tile patterns,
  // three weather textures, the minimap directory and six texture directories in the gateway's
  // own appearance code — so fourteen is a floor with room to refactor one away.
  assert.ok(paths.length >= 14,
    `expected the sweep to find path literals, it found ${paths.length}:\n${paths.join("\n")}`);
  for (const path of paths) t.diagnostic(path);
  t.diagnostic(`${paths.length} archive path literals across ${files.length} files under src/`);
});

test("Д3 the class atlas is addressed by a path the archives actually hold", withClient, async () => {
  assert.ok(CLASS_ATLAS_PATH.includes("\\"), `CLASS_ATLAS_PATH is ${CLASS_ATLAS_PATH}`);
  assert.equal(CLASS_ATLAS_PATH, "Interface\\TargetingFrame\\UI-Classes-Circles.blp");
  const chain = await openClientArchives(clientDirectory);
  try {
    // The live-gateway form of this is `/texture?path=…` answering 200; the archives are what that
    // route reads, and asking them directly needs no gateway to be running.
    const data = await chain.read(CLASS_ATLAS_PATH);
    assert.ok(data && data.byteLength > 0, `${CLASS_ATLAS_PATH} did not resolve`);
    assert.equal(await chain.has("InterfaceTargetingFrameUI-Classes-Circles.blp"), false,
      "the collapsed path should resolve to nothing, which is why it was a 404");
  } finally {
    chain.close();
  }
});

/**
 * The element with that id and every element it stands inside, read out of the page itself.
 *
 * Written down here it would be a copy of the markup that cannot notice the markup changing, and
 * what decides whether `.unit-frame > img` reaches the portrait at all is exactly that: which box
 * the `<img>` is a child of.
 */
function elementChain(html, id) {
  const VOID = new Set(["img", "br", "input", "meta", "link", "hr", "source", "area", "col"]);
  const tags = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  const stack = [];
  for (let match = tags.exec(html); match; match = tags.exec(html)) {
    if (match[0].startsWith("<!--")) continue;
    const [, closing, name, attributes] = match;
    const tag = name.toLowerCase();
    if (closing) {
      for (let depth = stack.length - 1; depth >= 0; depth--) {
        if (stack[depth].tag === tag) { stack.length = depth; break; }
      }
      continue;
    }
    const node = {
      tag,
      id: (/\bid="([^"]*)"/.exec(attributes) ?? [])[1] ?? "",
      classes: ((/\bclass="([^"]*)"/.exec(attributes) ?? [])[1] ?? "").split(/\s+/).filter(Boolean),
    };
    if (node.id === id) return { element: node, ancestors: [...stack] };
    if (!VOID.has(tag) && !attributes.trimEnd().endsWith("/")) stack.push(node);
  }
  return undefined;
}

/** Every style rule in a stylesheet, in file order, with the `@media` it stands under if any. */
function styleRules(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [];
  const walk = (from, to, media) => {
    let at = from;
    let prelude = "";
    while (at < to) {
      const character = clean[at];
      if (character === "}") { prelude = ""; at++; continue; }
      if (character !== "{") { prelude += character; at++; continue; }
      let depth = 1;
      let end = at + 1;
      while (end < to && depth > 0) {
        if (clean[end] === "{") depth++;
        else if (clean[end] === "}") depth--;
        end++;
      }
      const head = prelude.trim();
      // `@media` is walked into; every other at-rule — `@keyframes`, `@font-face` — is stepped
      // over whole, since nothing inside one styles an element.
      if (/^@media\b/i.test(head)) walk(at + 1, end - 1, head);
      else if (!head.startsWith("@")) rules.push({ selector: head, body: clean.slice(at + 1, end - 1), media });
      prelude = "";
      at = end;
    }
  };
  walk(0, clean.length, undefined);
  return rules;
}

/** The last value a block gives that property, which is the one the block means. */
function declaration(body, property) {
  let value;
  for (const piece of body.split(";")) {
    const colon = piece.indexOf(":");
    if (colon < 0) continue;
    if (piece.slice(0, colon).trim().toLowerCase() !== property) continue;
    value = piece.slice(colon + 1).trim();
  }
  return value;
}

/** Ids, then classes, then element names — the three numbers the cascade compares in that order. */
function specificity(selector) {
  const ids = (selector.match(/#[\w-]+/g) ?? []).length;
  const classes = (selector.match(/\.[\w-]+/g) ?? []).length;
  const types = (selector.replace(/[.#][\w-]+/g, "").match(/[a-z][\w-]*/gi) ?? []).length;
  return ids * 10_000 + classes * 100 + types;
}

function compoundMatches(compound, node) {
  const tag = /^[a-z][\w-]*/i.exec(compound);
  if (tag && tag[0].toLowerCase() !== node.tag) return false;
  for (const id of compound.match(/#[\w-]+/g) ?? []) if (id.slice(1) !== node.id) return false;
  for (const name of compound.match(/\.[\w-]+/g) ?? []) if (!node.classes.includes(name.slice(1))) return false;
  return true;
}

/**
 * Whether one selector reaches that element, given what it stands inside.
 *
 * Right to left, the way the cascade resolves it, and only over the two combinators this
 * stylesheet uses on the portrait. A selector carrying anything else — a pseudo-class, an
 * attribute — is reported as not matching rather than guessed at, and the test says so.
 */
function selectorMatches(selector, element, ancestors) {
  if (/[:[\]+~*]/.test(selector)) return false;
  const parts = selector.trim().split(/\s*(>)\s*|\s+/).filter(Boolean);
  let index = parts.length - 1;
  if (!compoundMatches(parts[index], element)) return false;
  const above = [...ancestors];
  index--;
  while (index >= 0) {
    const child = parts[index] === ">";
    if (child) index--;
    const compound = parts[index];
    if (compound === undefined) return false;
    if (child) {
      const parent = above.pop();
      if (!parent || !compoundMatches(compound, parent)) return false;
    } else {
      let at = -1;
      for (let depth = above.length - 1; depth >= 0; depth--) {
        if (compoundMatches(compound, above[depth])) { at = depth; break; }
      }
      if (at < 0) return false;
      above.length = at;
    }
    index--;
  }
  return true;
}

test("Д3 the portrait's own object-fit is the one that wins, in the box it is really drawn in", withClassIconData, async () => {
  // The path was only half of why the class icon had never been seen. `object-fit: none` is what
  // makes the browser draw the sheet at natural size so that `object-position` can pick one cell
  // out of it — and it was written `.class-portrait`, which is one class, against the frame's own
  // `.unit-frame > img`, which is one class and one element name and therefore wins whatever order
  // the two stand in. Computed `cover`, the whole 256px sheet is squeezed into the 58px ring and
  // then shoved by an offset counted in the sheet's own pixels: the ring shows nothing at all.
  const html = await readFile(join(projectRoot, "index.html"), "utf8");
  const css = await readFile(join(projectRoot, "src", "browser", "style.css"), "utf8");
  const found = elementChain(html, "player-icon");
  assert.ok(found, "index.html should still carry the portrait as #player-icon");
  assert.ok(found.element.classes.includes("class-portrait"),
    `#player-icon is ${found.element.classes.join(" ")}`);

  // The matcher above reads two combinators and nothing else, and says so by not matching. If a
  // pseudo-class or an attribute selector ever names this element, the cascade below would stop
  // seeing it and this test would go on passing — so that case is caught here rather than there.
  const unreadable = styleRules(css).map((rule) => rule.selector)
    .filter((selector) => /[:[\]+~*]/.test(selector) && /class-portrait|player-icon/.test(selector));
  assert.deepEqual(unreadable, [], "these reach the portrait in a form this test cannot resolve");

  const applying = [];
  for (const [order, rule] of styleRules(css).entries()) {
    const matched = rule.selector.split(",").map((one) => one.trim())
      .filter((one) => selectorMatches(one, found.element, found.ancestors));
    if (matched.length === 0) continue;
    applying.push({ ...rule, order, weight: Math.max(...matched.map(specificity)), matched });
  }
  const winner = (property, media) => applying
    .filter((rule) => rule.media === media && declaration(rule.body, property) !== undefined)
    .sort((left, right) => left.weight - right.weight || left.order - right.order)
    .pop();

  const fit = applying.filter((rule) => declaration(rule.body, "object-fit") !== undefined);
  assert.ok(fit.length >= 2,
    `the portrait's rule should be competing with the frame's, and only ${fit.length} reached it`);
  const drawn = winner("object-fit", undefined);
  assert.equal(declaration(drawn.body, "object-fit"), "none",
    `\`${drawn.selector}\` outranks the portrait's own rule and draws the sheet ${declaration(drawn.body, "object-fit")}`);
  for (const rule of fit) {
    if (rule.media === undefined) continue;
    assert.equal(declaration(rule.body, "object-fit"), "none", `${rule.media} { ${rule.selector} }`);
  }

  // Every width the stylesheet gives this box, not only the one the code was written against: the
  // ring is 58px, and 46px under `@media (max-width: 760px)`, and a 64px cell centred on the wrong
  // one of those shows a strip of the neighbouring class's circle inside the ring.
  const boxes = new Set();
  for (const rule of applying) {
    const width = declaration(rule.body, "width");
    if (width && width.endsWith("px")) boxes.add(Number.parseInt(width, 10));
  }
  assert.ok(boxes.has(CLASS_PORTRAIT_SIZE), `the stylesheet draws this box at ${[...boxes].join(", ")}px`);
  assert.ok(boxes.size >= 2, "the narrow-screen box should be in here too, or this only checks one");
  for (const box of boxes) {
    const inset = (box - CLASS_ATLAS_CELL_SIZE) / 2;
    // The rogue, whose column starts at 127 of 256 — a cell the four-column table used to miss by
    // a pixel, and one no offset of zero can be mistaken for.
    assert.equal(
      classPortraitPosition({ clientWidth: box, clientHeight: box, naturalWidth: 256, naturalHeight: 256 }, CLASS_ROGUE),
      `${-127 + inset}px ${inset}px`, `the cell is not centred in the ${box}px ring`);
  }
  // A hidden element measures nothing, and the first offset is written while it is still hidden.
  assert.equal(
    classPortraitPosition({ clientWidth: 0, naturalWidth: 256, naturalHeight: 256 }, CLASS_ROGUE),
    classPortraitPosition({ clientWidth: CLASS_PORTRAIT_SIZE, naturalWidth: 256, naturalHeight: 256 }, CLASS_ROGUE));
  assert.equal(
    classPortraitPosition({ clientWidth: 18, clientHeight: 25, naturalWidth: 256, naturalHeight: 256 }, CLASS_ROGUE),
    "-150px -19.5px",
    "the 18x25 microbutton opening centres the class cell vertically instead of treating it as 18x18");
  assert.equal(
    classPortraitPosition(
      { clientWidth: 0, clientHeight: 0, naturalWidth: 256, naturalHeight: 256 }, CLASS_ROGUE, 18, 25),
    "-150px -19.5px",
    "the authored microbutton dimensions keep a hidden portrait on the same cell");
});

test("Д3 a class cell comes from the dataset's own coordinates and the sheet's own size", withClassIconData, () => {
  const size = 58;
  const inset = (size - CLASS_ATLAS_CELL_SIZE) / 2;
  // Measured on this dataset: the stock four columns start at 0, 64, 127 and 190 of 256, not at
  // multiples of 64 — the original client's coordinates trim a pixel of bleed off three of them,
  // and the hand-written table this replaces put rogue and druid one and two pixels out.
  assert.equal(classIconOffset(1, size), `${inset}px ${inset}px`, "warrior is the first cell");
  assert.equal(classIconOffset(8, size), `${-64 + inset}px ${inset}px`, "mage is beside it");
  assert.equal(classIconOffset(4, size), `${-127 + inset}px ${inset}px`, "the rogue is at 127, not 128");
  assert.equal(classIconOffset(11, size), `${-190 + inset}px ${inset}px`, "the druid is at 190, not 192");
  assert.equal(classIconOffset(3, size), `${inset}px ${-64 + inset}px`, "hunter starts the second row");
  assert.equal(classIconOffset(6, size), `${-64 + inset}px ${-128 + inset}px`, "the death knight is last");

  // Ten classes, ten cells, and nothing for a number that is not one of them.
  const cells = new Set();
  for (const classId of [1, 2, 3, 4, 5, 6, 7, 8, 9, 11]) {
    const offset = classIconOffset(classId, size);
    assert.ok(offset, `class ${classId} has no cell`);
    assert.ok(!cells.has(offset), `class ${classId} shares a cell with another`);
    cells.add(offset);
  }
  assert.equal(classIconOffset(10, size), undefined, "there is no class 10");
  assert.equal(classIconOffset(undefined, size), undefined);
  // Which is also the question the frame asks before it unhides the portrait at all, since an
  // empty bordered circle says less than no circle.
  assert.equal(hasClassIcon(11), true);
  assert.equal(hasClassIcon(10), false);
  assert.equal(hasClassIcon(undefined), false);

  // An image that has not decoded yet reports zero, and dividing the sheet by it would stack every
  // class on the first cell. The size this build knows about stands in until `load` fires.
  assert.equal(classIconOffset(8, size, 0, 0), classIconOffset(8, size, CLASS_ATLAS_DEFAULT_SIZE));
});

test("Д3 a re-stitched 512-pixel sheet moves every cell with it", withClassIconData, () => {
  // What tswow does the moment a module gives any class an icon: all three class sheets are
  // redrawn at 512x512 in eight columns and every stock class's coordinates are rewritten to
  // 0.125 steps (`ClassIcon.ts:33-51`). The coordinates are fractions in both worlds, so the only
  // thing that has to change is the size they are multiplied by — and a client that assumed 256
  // would point every portrait at a quarter of the wrong icon.
  const size = 58;
  const inset = (size - CLASS_ATLAS_CELL_SIZE) / 2;
  assert.equal(classIconOffset(8, size, 256, 256), `${-64 + inset}px ${inset}px`);
  assert.equal(classIconOffset(8, size, 512, 512), `${-128 + inset}px ${inset}px`,
    "the mage is 64 pixels in on a 256 sheet and 128 in on a 512 one");
  const pixels = (offset) => offset.split(" ").map((part) => Number.parseFloat(part) - inset);
  for (const classId of [1, 2, 3, 4, 5, 6, 7, 8, 9, 11]) {
    const at256 = pixels(classIconOffset(classId, size, 256, 256));
    const at512 = pixels(classIconOffset(classId, size, 512, 512));
    assert.deepEqual(at512, at256.map((value) => value * 2), `class ${classId} does not scale`);
  }
});

test("Д3 the dataset's names win over the ten this build was compiled with", () => {
  try {
    assert.equal(raceName(4), "Ночной эльф");
    assert.equal(className(11), "Друид");
    assert.equal(raceName(22), "Раса 22", "an unknown race is named by its number, not left blank");
    assert.equal(classFileName(6), "DEATHKNIGHT");
    assert.equal(classFileName(14), undefined);

    learnCreationNames(
      [{ id: 4, name: "Калдорай" }, { id: 22, name: "Ворген" }, { id: 23, name: "" }],
      [{ id: 11, name: "Друид" }, { id: 14, name: "Монах", fileName: "MONK" }],
    );
    assert.equal(raceName(4), "Калдорай", "a stock race a module renamed is renamed everywhere");
    assert.equal(raceName(22), "Ворген", "a custom race is named at last");
    assert.equal(raceName(23), "Раса 23", "an empty name is not a name; the number is better");
    assert.equal(className(14), "Монах");
    assert.equal(classFileName(14), "MONK", "which is how a custom class reaches a cell of the atlas");
    assert.equal(classIconOffset(14, 58), undefined,
      "and until a module stitches a MONK cell there is no picture to point at, so no portrait");
  } finally {
    forgetCreationNames();
  }
  assert.equal(raceName(4), "Ночной эльф", "and the compiled names are back when the session is");
  assert.equal(className(14), "Класс 14");
});

test("Д3 a class with no colour of its own still gets one, and always the same one", () => {
  // 3.3.5 has no DBC source for class colours, so a custom class had none and `classColor`
  // answered undefined — which drew an uncoloured nameplate and an uncoloured guild line, i.e.
  // looked like a bug rather than like a class nobody wrote a colour for.
  assert.equal(classColor(11), "#ff7d0a", "the ten real colours are untouched");
  assert.equal(classColor(undefined), undefined, "no class is still no colour");
  const generated = classColor(14);
  assert.ok(generated, "a class outside the table should still have a colour");
  assert.equal(generated, generatedClassColor(14));
  assert.equal(classColor(14), generated, "and the same one on the next call");
  const hues = new Set([12, 13, 14, 15, 16].map((id) => generatedClassColor(id)));
  assert.equal(hues.size, 5, "neighbouring ids should not land on the same hue");
});

test("Д3 the creation lists are the dataset's, and the compiled ten when there is no gateway", () => {
  const data = {
    races: [
      { id: 1, name: "Человек", playable: true, classes: [1, 2, 8] },
      { id: 4, name: "Ночной эльф", playable: true, classes: [1, 4, 11] },
      { id: 9, name: "Гоблин", playable: false, classes: [] },
      { id: 22, name: "", playable: true, classes: [14] },
    ],
    classes: [
      { id: 1, name: "Воин", playable: true },
      { id: 2, name: "Паладин", playable: true },
      { id: 4, name: "Разбойник", playable: true },
      { id: 8, name: "Маг", playable: true },
      { id: 11, name: "Друид", playable: true },
      { id: 12, name: "Ничей", playable: false },
      { id: 14, name: "Монах", playable: true },
    ],
  };
  assert.deepEqual(creationRaces(data).map((race) => race.id), [1, 4, 22],
    "the goblin is in ChrRaces and not offered; the custom race is offered");
  assert.equal(creationRaces(data)[2].name, "Раса 22", "a nameless row is labelled, not dropped");
  assert.deepEqual(creationClasses(data, 4).map((entry) => entry.id), [1, 4, 11],
    "a night elf has no paladin and no mage, which is what CharBaseInfo says");
  assert.deepEqual(creationClasses(data, 1).map((entry) => entry.id), [1, 2, 8]);
  assert.deepEqual(creationClasses(data, 22).map((entry) => entry.id), [14]);
  assert.equal(creationClasses(data, undefined).some((entry) => entry.id === 12), false,
    "a class no race may take is never offered");

  // The gateway being down is the case this screen has to survive: it is the screen you are on
  // when you find out the gateway is down.
  assert.deepEqual(creationRaces(undefined).map((race) => race.id), Object.keys(RACE_NAMES).map(Number));
  assert.deepEqual(creationClasses(undefined, 4).map((entry) => entry.id), Object.keys(CLASS_NAMES).map(Number));
  assert.equal(isCreationData({ races: [], classes: [] }), true);
  assert.equal(isCreationData({ races: [] }), false);
  assert.equal(isCreationData("<html>404</html>"), false);
});

test("G1 a race's display ids arrive when the gateway has them and are absent, not zero, when it does not", () => {
  const human = { id: 1, name: "Человек", playable: true, classes: [1], maleDisplayId: 49, femaleDisplayId: 50 };
  assert.equal(raceDisplayId(human, 0), 49);
  assert.equal(raceDisplayId(human, 1), 50);

  // The two ways there is no answer, and they are one answer here because a caller can do nothing
  // different with them: an older gateway that never carried the columns, and a dataset row that
  // names no model. What must not happen is either becoming display id 0 — `CreatureDisplayInfo`
  // has no row 0, so a preview asking for it would fetch, miss, and show nothing with no reason.
  const older = { id: 1, name: "Человек", playable: true, classes: [1] };
  assert.equal(raceDisplayId(older, 0), undefined);
  assert.equal(raceDisplayId({ ...older, maleDisplayId: 0, femaleDisplayId: 0 }, 0), undefined);
  assert.equal(raceDisplayId(undefined, 0), undefined, "and no race at all is the same no answer");

  // The whole payload from such a gateway still validates: its races and classes are perfectly
  // good, and refusing it would drop the form back to the ten compiled names over a preview.
  assert.equal(isCreationData({ races: [older], classes: [{ id: 1, name: "Воин", playable: true }] }), true);
});

test("Д3 a second gateway keeps neither the first one's races nor the first one's names", () => {
  const alpha = {
    races: [{ id: 1, name: "Человек", playable: true, classes: [1] },
      { id: 22, name: "Ворген", playable: true, classes: [1] }],
    classes: [{ id: 1, name: "Воитель", playable: true }],
  };
  const beta = {
    races: [{ id: 1, name: "Человек", playable: true, classes: [1] }],
    classes: [{ id: 1, name: "Воин", playable: true }],
  };
  const memo = new CreationMemo();
  try {
    assert.equal(memo.aimAt("http://alpha:8090"), "http://alpha:8090");
    assert.equal(memo.aimAt("http://alpha:8090"), undefined,
      "asked once per gateway, and this runs on every visit to the form");
    // The world address is what the field actually holds, and it is a websocket one.
    assert.equal(memo.accept("http://alpha:8090", alpha), true);
    assert.deepEqual(creationRaces(memo.data).map((race) => race.id), [1, 22]);
    assert.equal(raceName(22), "Ворген");
    assert.equal(className(1), "Воитель");

    // The player edits the address: a second server, running a build with no creation route on it
    // — which is the case `isCreationData` exists to survive, and the case where nothing arrives
    // to overwrite what the first server said.
    assert.equal(memo.aimAt("ws://beta:8090/world"), "http://beta:8090", "ws:// is the same origin");
    assert.equal(memo.data, undefined, "alpha's races are not beta's races");
    assert.equal(raceName(22), "Раса 22", "and alpha's names are not beta's names");
    assert.equal(className(1), "Воин", "not even for a class both of them have");
    assert.deepEqual(creationRaces(memo.data).map((race) => race.id), Object.keys(RACE_NAMES).map(Number));
    assert.equal(memo.accept("http://beta:8090", undefined), false);
    assert.equal(memo.aimAt("ws://beta:8090/world"), "http://beta:8090",
      "a gateway that could not be reached is asked again, not written off");

    // And an answer from the gateway the player has already left is dropped rather than learned:
    // both were in flight at once, and this is the one that landed second.
    assert.equal(memo.accept("http://alpha:8090", alpha), false);
    assert.equal(memo.data, undefined);
    assert.equal(raceName(22), "Раса 22");

    assert.equal(memo.accept("http://beta:8090", beta), true);
    assert.equal(memo.aimAt("http://"), undefined, "half typed is not an address");
    assert.ok(memo.data, "and does not wipe the form that is standing");
  } finally {
    forgetCreationNames();
  }
});

test("Д3 the three tables read the way the creation form needs them", withDataset, async () => {
  const data = await loadCharacterCreation(dbcDirectory);
  const { openDbcFile } = await import("../tools/dbc.mjs");
  const [races, classes, pairs] = await Promise.all([
    openDbcFile(dbcDirectory, "ChrRaces"), openDbcFile(dbcDirectory, "ChrClasses"),
    openDbcFile(dbcDirectory, "CharBaseInfo"),
  ]);
  assert.deepEqual(data.races.map((race) => race.id).sort((a, b) => a - b),
    [...races.rows()].map((row) => races.id(row)).sort((a, b) => a - b));
  assert.deepEqual(data.classes.map((entry) => entry.id).sort((a, b) => a - b),
    [...classes.rows()].map((row) => classes.id(row)).sort((a, b) => a - b));

  // `Flags` bit 0 is CHRRACES_FLAGS_NOT_PLAYABLE, so playability is the bit being *clear*. Reading
  // it the other way round offers the goblin, the naga and the fel orc and hides all ten races
  // anybody can create — which is exactly the ten this client used to have hardcoded.
  for (const race of data.races) {
    const row = races.rowOf(race.id);
    assert.equal(race.playable, (races.int(row, "Flags") & 1) === 0, `race ${race.id}`);
    const expectedClasses = [...new Set([...pairs.rows()]
      .filter((pair) => (pairs.int(pair, "RaceID") & 0xff) === race.id)
      .map((pair) => pairs.int(pair, "ClassID") & 0xff)
      .filter((id) => data.classes.some((entry) => entry.id === id)))].sort((a, b) => a - b);
    assert.deepEqual(race.classes, expectedClasses, `CharBaseInfo for race ${race.id}`);
  }

  for (const race of data.races) {
    const row = races.rowOf(race.id);
    assert.equal(race.name, races.locstring(row, "Name_lang"));
    assert.equal(race.clientPrefix, races.string(row, "ClientPrefix"));
    assert.equal(race.side, races.int(row, "Alliance"));
    assert.equal(race.baseLanguage, races.int(row, "BaseLanguage"));
  }
  // Race/class restrictions belong to the active dataset; synthetic custom-pair cases in
  // gateway.test.mjs pin the fixed reader contract without forbidding module changes here.

  for (const entry of data.classes) {
    const row = classes.rowOf(entry.id);
    assert.equal(entry.name, classes.locstring(row, "Name_lang"));
    assert.equal(entry.fileName, classes.string(row, "Filename"));
    assert.equal(entry.powerType, classes.int(row, "DisplayPower"));
    assert.equal(entry.expansion, classes.int(row, "Required_expansion"));
    assert.equal(entry.classMask, entry.id >= 1 && entry.id <= 32 ? 1 << (entry.id - 1) : 0);
    assert.equal(entry.playable, data.races.some((race) => race.classes.includes(entry.id)), `class ${entry.id}`);
  }

  // Every token the atlas table knows is a class the dataset knows, and the other way round: this
  // is the join that turns a class id on the wire into a cell of a picture.
  const tokens = new Set(data.classes.map((entry) => entry.fileName));
  assert.deepEqual([...Object.keys(CLASS_ICON_TCOORDS)].filter((token) => !tokens.has(token)), []);
  for (const [id, token] of Object.entries(CLASS_FILE_NAMES)) {
    assert.equal(data.classes.find((entry) => entry.id === Number(id)).fileName, token,
      `the compiled fallback for class ${id} should be what ChrClasses says`);
  }
});

test("Д3 a quality and a power outside the client's own lists are named by their number", () => {
  // Both are dense arrays that end where 3.3.5 ends, and both are indexed with a number a module
  // is free to choose. `QUALITY_NAMES[8]` was `undefined` and the tooltip simply dropped the line,
  // so an item of an unknown quality looked like an item with no quality — beside a coloured
  // border drawn from that very number. `POWER_NAMES` had a fallback, but an anonymous one: two
  // different unknown powers read identically.
  assert.equal(qualityName(4), "Эпический");
  assert.equal(qualityName(7), "Наследие", "the last one 3.3.5 has");
  assert.equal(qualityName(8), "Качество 8");
  assert.equal(qualityName(11), "Качество 11");
  assert.equal(powerName(0), "Мана");
  assert.equal(powerName(POWER_NAMES.length - 1), "Сила рун");
  assert.equal(powerName(POWER_NAMES.length), `Сила ${POWER_NAMES.length}`);
  assert.notEqual(powerName(8), powerName(9), "an unnamed bar should still say which one it is");
});
