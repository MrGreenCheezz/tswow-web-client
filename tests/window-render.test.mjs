import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * The same small document `widget-dom.test.mjs` builds, with one thing added: every node counts
 * the writes made to it.
 *
 * That counter is not decoration. The whole claim of `WindowRender` is that a binding pass writes
 * to the nodes whose value moved and to no others — it is what makes a once-a-frame pass over a
 * live window affordable, and it is invisible from the outside, because a renderer that rebuilt
 * the whole body sixty times a second would pass every assertion about *what* is on screen. So the
 * nodes are instrumented and the tests assert the counts.
 */
function fakeDocument() {
  const make = (tag) => {
    const writes = { text: 0, hidden: 0, style: 0, value: 0, other: 0 };
    const style = new Proxy(
      { setProperty(name, value) { this[name] = value; }, removeProperty(name) { delete this[name]; } },
      {
        set(target, key, value) {
          writes.style++;
          target[key] = value;
          return true;
        },
      },
    );
    const node = {
      tagName: tag.toUpperCase(),
      children: [],
      parent: undefined,
      dataset: {},
      style,
      writes,
      className: "",
      hidden: false,
      listeners: new Map(),
      classList: {
        add(...names) { node.className = [...new Set([...node.className.split(" ").filter(Boolean), ...names])].join(" "); },
        toggle(name, on) { on ? this.add(name) : node.className = node.className.split(" ").filter((c) => c !== name).join(" "); },
        contains(name) { return node.className.split(" ").includes(name); },
      },
      append(...nodes) {
        for (const child of nodes) child.parent = node;
        node.children.push(...nodes);
      },
      replaceChildren(...nodes) {
        for (const child of nodes) child.parent = node;
        node.children = [...nodes];
      },
      remove() {
        if (!node.parent) return;
        node.parent.children = node.parent.children.filter((child) => child !== node);
        node.parent = undefined;
      },
      addEventListener(name, handler) { node.listeners.set(name, handler); },
      getBoundingClientRect() { return { left: 0, top: 0, bottom: 0, right: 0, width: 0, height: 0 }; },
      closest() { return undefined; },
      dispatchEvent() { return true; },
      isConnected: true,
    };
    let text = "";
    let hidden = false;
    Object.defineProperty(node, "textContent", {
      get: () => text,
      set: (value) => { writes.text++; text = value; },
    });
    Object.defineProperty(node, "hidden", {
      get: () => hidden,
      set: (value) => { writes.hidden++; hidden = value; },
    });
    let value = "";
    Object.defineProperty(node, "value", {
      get: () => value,
      set: (next) => { writes.value++; value = next; },
    });
    return node;
  };
  return { createElement: make, body: make("body") };
}

globalThis.document = fakeDocument();
const { usePanelHost } = await import("../dist/code/browser/ui/Widgets.js");
const attached = [];
const detached = [];
const viewport = document.createElement("div");
usePanelHost({
  viewport,
  attach: (element) => attached.push(element),
  detach: (element) => detached.push(element),
});

const {
  BACKDROP_PRESETS, WINDOW_STATE_ROOTS, parseWindowDefinition,
} = await import("../dist/code/browser/ui/WindowSchema.js");
const {
  anchorBox, renderWindow, textureAssetPath, windowElementId,
} = await import("../dist/code/browser/ui/WindowRender.js");
// The gateway's own validator, so «the renderer completes the path» and «the route accepts it» are
// one assertion rather than two beliefs.
const { validAssetPath } = await import("../dist/code/gateway/AssetPath.js");
const {
  WindowRegistry, closeEscapableWindows, escapableWindowOpen, windowRegistry,
} = await import("../dist/code/browser/ui/WindowRegistry.js");
const {
  PLAYER_FLAGS_RESTING, UNIT_FLAG_IN_COMBAT, buildWindowSnapshot, groupUnitView,
} = await import("../dist/code/browser/ui/WindowBindings.js");
const { unitSnapshot } = await import("../dist/code/browser/ui/UnitSnapshot.js");
const { windowsView, windowsSignature } = await import("../dist/code/browser/ui/WindowsTab.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { unit } = await import("../dist/code/world/Fields.js");

/* ---------------------------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------------------------- */

const anchor = (point, relativeTo, relativePoint, x, y) => ({ point, relativeTo, relativePoint, x, y });

function definition(children, extra = {}, screenExtra = {}) {
  return {
    kind: "addon",
    id: "screen",
    name: { ru: "Экран", en: "" },
    enabled: true,
    params: {
      screen: {
        id: "root",
        type: "Frame",
        name: "Root",
        width: 320,
        height: 200,
        anchor: anchor("CENTER", "parent", "CENTER", 0, 0),
        backdrop: "none",
        strata: "DIALOG",
        movable: true,
        mouse: true,
        hidden: false,
        closeButton: true,
        escClose: true,
        title: { ru: "Заголовок", en: "" },
        children,
        events: [],
        ...screenExtra,
      },
      ...extra,
    },
  };
}

function parse(raw, module = "example") {
  const result = parseWindowDefinition(raw, { module });
  assert.ok(result.window, `the fixture has to parse: ${result.problems.join("; ")}`);
  return result.window;
}

/** Every node under `root`, depth first. */
function walk(root) {
  const list = [root];
  for (const child of root.children) list.push(...walk(child));
  return list;
}

function byWidget(root, id) {
  const found = walk(root).find((node) => node.dataset.widget === id && node.dataset.module !== undefined);
  assert.ok(found, `no node for widget "${id}"`);
  return found;
}

/** The tree as comparable data: what an idempotence assertion actually means. */
function shape(node) {
  return {
    tag: node.tagName,
    className: node.className,
    widget: node.dataset.widget ?? null,
    module: node.dataset.module ?? null,
    left: node.style.left ?? null,
    top: node.style.top ?? null,
    width: node.style.width ?? null,
    text: node.textContent,
    children: node.children.map(shape),
  };
}

function resetWrites(root) {
  for (const node of walk(root)) {
    node.writes.text = 0;
    node.writes.hidden = 0;
    node.writes.style = 0;
    node.writes.value = 0;
  }
}

function totalWrites(root) {
  let total = 0;
  for (const node of walk(root)) {
    total += node.writes.text + node.writes.hidden + node.writes.style + node.writes.value;
  }
  return total;
}

/** A snapshot with the roots the published view carries, so a fixture reads like a real one. */
function snapshot({
  health = 100, maxHealth = 100, name = "Тестий", level = 5, target = false, rows, combat = false,
} = {}) {
  return {
    player: { exists: true, name, level, health, maxHealth, combat, dead: false },
    target: { exists: target, name: target ? "Кабан" : "", health: 10, maxHealth: 20, hostile: target },
    world: { zone: "Дуротар", subzone: "", clock: "09:41", inGroup: false, inRaid: false, rows },
  };
}

const TEXT = (id, extra) => ({
  id, type: "Text", width: 100, height: 20,
  anchor: anchor("TOPLEFT", "parent", "TOPLEFT", 0, 0), ...extra,
});

/* ---------------------------------------------------------------------------------------------
 * The tree
 * ------------------------------------------------------------------------------------------- */

test("a definition becomes a game window with one node per widget", () => {
  const window = parse(definition([
    { id: "panel", type: "Frame", width: 200, height: 80, backdrop: "tooltip",
      anchor: anchor("TOPLEFT", "parent", "TOPLEFT", 8, -8),
      children: [TEXT("hello", { text: { ru: "Привет", en: "" } })] },
    { id: "bar", type: "StatusBar", width: 200, height: 18, bind: "playerHealth",
      anchor: anchor("TOPLEFT", "panel", "BOTTOMLEFT", 0, -4) },
    { id: "press", type: "Button", width: 90, height: 22, text: { ru: "Жать", en: "" },
      anchor: anchor("BOTTOMLEFT", "parent", "BOTTOMLEFT", 8, 8) },
  ]));
  const live = renderWindow(window);
  try {
    // The shell is an ordinary game window: that is what gives it the drag handle, the cascade and
    // the remembered position, and it is why the element id has to be stable across a rebuild.
    assert.equal(live.element.id, windowElementId("example", "screen"));
    assert.equal(live.element.className, "game-window module-window");
    assert.equal(live.element.dataset.strata, "DIALOG");
    assert.equal(live.element.style.zIndex, "26", "DIALOG sits between the chat log at 20 and the window base at 30");
    assert.ok(attached.includes(live.element), "or it will not drag and will not remember its place");

    assert.equal(byWidget(live.element, "panel").className, "wnd-frame");
    assert.equal(byWidget(live.element, "hello").className, "wnd-text");
    assert.equal(byWidget(live.element, "bar").className, "wnd-bar");
    assert.equal(byWidget(live.element, "press").className, "wnd-button");
    assert.equal(byWidget(live.element, "press").tagName, "BUTTON");
    // A bar is the kit's `Bar`, not a second idea of what a bar looks like.
    assert.equal(byWidget(live.element, "bar").children[0].className, "ui-bar ui-bar-text");

    for (const id of ["panel", "hello", "bar", "press"]) {
      assert.equal(byWidget(live.element, id).dataset.module, "example",
        "a module's own CSS is scoped by this attribute, so every node it made has to carry it");
    }
    live.update(snapshot());
    assert.equal(byWidget(live.element, "hello").textContent, "Привет");
    assert.equal(byWidget(live.element, "press").textContent, "Жать");
  } finally {
    live.destroy();
  }
});

test("a texture's layer decides what covers what, and the file's order decides the anchors", () => {
  // Declared last and drawn first: `layer` is the whole of z-ordering inside a frame, and a
  // BACKGROUND texture written at the bottom of the children list is the ordinary way to say
  // "behind everything above".
  const window = parse(definition([
    TEXT("label", { text: { ru: "Сверху", en: "" }, anchor: anchor("TOPLEFT", "parent", "TOPLEFT", 4, -4) }),
    { id: "back", type: "Texture", width: 320, height: 200, layer: "BACKGROUND", solid: true,
      color: [0, 0, 0, 1], anchor: anchor("TOPLEFT", "parent", "TOPLEFT", 0, 0) },
  ]));
  const live = renderWindow(window);
  try {
    const surface = walk(live.element).find((node) => node.className === "wnd-root");
    const order = surface.children.filter((node) => node.dataset.widget).map((node) => node.dataset.widget);
    assert.deepEqual(order, ["back", "label"]);
  } finally {
    live.destroy();
  }
});

test("an anchor is flipped once, and a sibling anchor measures from the sibling's box", () => {
  // The owner's own numbers: `texture-1` sits at TOPLEFT with y −24, which in WoW means
  // twenty-four pixels *down*. Flipping twice — or not at all — puts it off the top of the frame.
  assert.deepEqual(
    anchorBox(anchor("TOPLEFT", "parent", "TOPLEFT", 16, -24), { width: 64, height: 64 },
      { left: 0, top: 0, width: 384, height: 288 }),
    { left: 16, top: 24, width: 64, height: 64 },
  );
  // CENTER on CENTER: the widget's own middle lands on the parent's middle.
  assert.deepEqual(
    anchorBox(anchor("CENTER", "parent", "CENTER", 0, 0), { width: 100, height: 20 },
      { left: 0, top: 0, width: 320, height: 200 }),
    { left: 110, top: 90, width: 100, height: 20 },
  );
  // BOTTOMRIGHT with a positive y is measured up from the bottom edge.
  assert.deepEqual(
    anchorBox(anchor("BOTTOMRIGHT", "parent", "BOTTOMRIGHT", -16, 16), { width: 40, height: 10 },
      { left: 0, top: 0, width: 320, height: 200 }),
    { left: 264, top: 174, width: 40, height: 10 },
  );

  const window = parse(definition([
    { id: "portrait", type: "Texture", width: 64, height: 64, solid: true, color: [1, 0, 0, 1],
      anchor: anchor("TOPLEFT", "parent", "TOPLEFT", 16, -24) },
    TEXT("under", { anchor: anchor("TOPLEFT", "portrait", "BOTTOMLEFT", 0, -2), text: "x" }),
  ]));
  const live = renderWindow(window);
  try {
    assert.equal(byWidget(live.element, "portrait").style.left, "16px");
    assert.equal(byWidget(live.element, "portrait").style.top, "24px");
    // 24 down to the portrait's top, 64 for its height, 2 more for the gap.
    assert.equal(byWidget(live.element, "under").style.top, "90px");
    assert.equal(byWidget(live.element, "under").style.left, "16px");
  } finally {
    live.destroy();
  }
});

/* ---------------------------------------------------------------------------------------------
 * The binding pass
 * ------------------------------------------------------------------------------------------- */

test("a pass writes only where the value moved", () => {
  const window = parse(definition([
    TEXT("name", { bind: "playerName" }),
    TEXT("zone", { bind: "zone", anchor: anchor("TOPLEFT", "parent", "TOPLEFT", 0, -20) }),
    { id: "bar", type: "StatusBar", width: 200, height: 18, bind: "playerHealth",
      anchor: anchor("TOPLEFT", "parent", "TOPLEFT", 0, -40) },
  ]));
  const live = renderWindow(window);
  try {
    live.update(snapshot({ health: 80, maxHealth: 100 }));
    assert.equal(byWidget(live.element, "name").textContent, "Тестий");

    // The same snapshot again writes nothing at all. This is the assertion the whole design is
    // for: a window drawn every frame from a state that has not moved must cost no DOM writes.
    resetWrites(live.element);
    live.update(snapshot({ health: 80, maxHealth: 100 }));
    assert.equal(totalWrites(live.element), 0);
    assert.equal(live.stats.changed, 0);
    assert.ok(live.stats.evaluated > 0, "and it did look: the pass evaluated, it just wrote nothing");

    // One value moves, and only the widgets that read it are touched.
    resetWrites(live.element);
    live.update(snapshot({ health: 60, maxHealth: 100 }));
    assert.equal(byWidget(live.element, "name").writes.text, 0, "the name did not change, so nothing wrote to it");
    assert.equal(byWidget(live.element, "zone").writes.text, 0);
    assert.ok(totalWrites(live.element) > 0, "but the bar did move");
    assert.equal(byWidget(live.element, "bar").children[0].children[0].style.width, "60%");

    // And the name alone moving leaves the bar alone.
    resetWrites(live.element);
    live.update(snapshot({ health: 60, maxHealth: 100, name: "Другой" }));
    assert.equal(byWidget(live.element, "name").textContent, "Другой");
    assert.equal(byWidget(live.element, "bar").children[0].children[0].writes.style, 0);
  } finally {
    live.destroy();
  }
});

test("a binding to a path nobody publishes draws empty, never the word undefined", () => {
  const window = parse(definition([
    TEXT("missing", { text: "{player.nonsense}" }),
    TEXT("formatted", { text: "{fmt(player.nonsense)}", anchor: anchor("TOPLEFT", "parent", "TOPLEFT", 0, -20) }),
    TEXT("mixed", { text: "уровень {player.nonsense}", anchor: anchor("TOPLEFT", "parent", "TOPLEFT", 0, -40) }),
  ]));
  const live = renderWindow(window);
  try {
    live.update(snapshot());
    assert.equal(byWidget(live.element, "missing").textContent, "");
    assert.equal(byWidget(live.element, "formatted").textContent, "");
    assert.equal(byWidget(live.element, "mixed").textContent, "уровень ");
  } finally {
    live.destroy();
  }
});

test("a texture whose path empties lets go of the last picture and asks for nothing", () => {
  const asked = [];
  const window = parse(definition([
    { id: "portrait", type: "Texture", width: 64, height: 64,
      texture: '{target.exists ? "Interface\\\\Boar" : ""}',
      anchor: anchor("TOPLEFT", "parent", "TOPLEFT", 0, 0) },
  ]));
  const live = renderWindow(window, {
    textureUrl: (path) => { asked.push(path); return `/texture?path=${path}`; },
  });
  try {
    const image = byWidget(live.element, "portrait").children[0];
    live.update(snapshot({ target: true }));
    assert.equal(image.hidden, false);
    // `.blp` is the renderer's doing and not the author's: a window definition spells a path the
    // way Lua does, and `/texture` wants a file. See «Ж0 …» below.
    assert.equal(image.src, "/texture?path=Interface\\Boar.blp");

    live.update(snapshot({ target: false }));
    assert.equal(image.hidden, true,
      "a failed fetch only fires `error`, so an image left showing would still be the old target's");
    // An empty path is not an address. `setIconSource` short-circuits on an empty *URL*, and
    // `/texture?path=` is not one — it is a real request that 4xx's on every frame with no target.
    assert.deepEqual(asked, ["Interface\\Boar.blp"],
      "nothing was asked for at build time or with no target, and the boar was asked for once");
  } finally {
    live.destroy();
  }
});

test("Ж0 a texture path with no extension is completed, and one that has an extension is not", () => {
  // The reason `/testUI` opened an empty window. A definition spells its pictures the way the
  // game's own interface code does — `Interface\DialogFrame\UI-DialogBox-Background` — and the
  // gateway's `/texture` refuses a name with no extension, so every picture in every module window
  // ever written was an HTTP 400. Measured live: 13 of 13 non-empty `BACKDROP_PRESETS` strings
  // answer 400 as written and 200 with `.blp` appended.
  for (const preset of BACKDROP_PRESETS) {
    for (const file of [preset.bgFile, preset.edgeFile].filter(Boolean)) {
      assert.equal(validAssetPath(file, { extensions: ["blp"] }), false,
        `${file} would have been served, so this preset proves nothing`);
      assert.equal(validAssetPath(textureAssetPath(file), { extensions: ["blp"] }), true,
        `the route still refuses ${textureAssetPath(file)}`);
    }
  }

  // And the four shapes that must be left exactly as they are.
  assert.equal(textureAssetPath("Interface\\Icons\\Boar.blp"), "Interface\\Icons\\Boar.blp", "no .blp.blp");
  assert.equal(textureAssetPath("Interface\\Icons\\Boar.tga"), "Interface\\Icons\\Boar.tga", "another extension is a choice");
  assert.equal(textureAssetPath("Interface/Icons/Boar"), "Interface/Icons/Boar.blp", "either separator");
  assert.equal(textureAssetPath(""), "", "and an empty path is not a request at all");
  // A dot in a directory is not an extension on the file.
  assert.equal(textureAssetPath("Interface\\Icons.old\\Boar"), "Interface\\Icons.old\\Boar.blp");

  const asked = [];
  const window = parse(definition([
    { id: "portrait", type: "Texture", width: 64, height: 64,
      texture: "Interface\\CharacterFrame\\TemporaryPortrait",
      anchor: anchor("TOPLEFT", "parent", "TOPLEFT", 0, 0) },
  ], {}, { backdrop: "dialog" }));
  const live = renderWindow(window, {
    textureUrl: (path) => { asked.push(path); return `/texture?path=${path}`; },
  });
  try {
    live.update(snapshot({}));
    assert.deepEqual(asked, [
      "Interface\\DialogFrame\\UI-DialogBox-Background.blp",
      "Interface\\CharacterFrame\\TemporaryPortrait.blp",
    ], "the owner's own window asks for its backdrop and its portrait, both as files");
  } finally {
    live.destroy();
  }
});

test("Ж0 a picture that does not arrive says so, with its path and the answer it got", async () => {
  // What made the bug above survive as long as module windows have existed: `setIconSource` turns
  // a failed fetch into an `error` event on the `<img>`, `textureImage` listens for none, and the
  // loader's problem list was empty in the very run that made two 400s. `modules:check` then
  // printed "No problems" and exited 0.
  const problems = [];
  const asked = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    return { ok: false, status: 404, blob: async () => ({}) };
  };
  const window = parse(definition([
    { id: "portrait", type: "Texture", width: 64, height: 64,
      texture: "Interface\\CharacterFrame\\TemporaryPortrait",
      anchor: anchor("TOPLEFT", "parent", "TOPLEFT", 0, 0) },
  ]), "test");
  const live = renderWindow(window, {
    // Absolute and cross-origin, because that is the only shape that is fetched rather than
    // assigned — a gateway route cannot be reached by an `<img src>` at all.
    textureUrl: (path) => `http://127.0.0.1:8090/texture?path=${encodeURIComponent(path)}`,
    onTextureProblem: (problem) => problems.push(problem),
  });
  try {
    live.update(snapshot({}));
    // The fetch is a promise; the report lands on the next turn of the loop.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(problems.length, 1, "a 404 that nobody hears about is how this shipped");
    assert.equal(problems[0].module, "test");
    assert.equal(problems[0].windowId, "screen");
    assert.equal(problems[0].path, "Interface\\CharacterFrame\\TemporaryPortrait",
      "the path the author wrote, so they have something to search their file for");
    assert.equal(problems[0].status, 404);
    assert.match(problems[0].url, /TemporaryPortrait\.blp/, "and the address that was actually asked for");
  } finally {
    live.destroy();
    globalThis.fetch = originalFetch;
  }
});

test("Ж0 a window rendered with no gateway behind it reports nothing", () => {
  // The diagnostics pane renders its two example windows through the same host with no session, so
  // `textureUrl` is undefined and no request is made. Nothing was asked for, so nothing failed —
  // and a pane that cried "2 problems" every time a button was pressed would be worse than silence.
  const problems = [];
  const window = parse(definition([
    { id: "portrait", type: "Texture", width: 64, height: 64,
      texture: "Interface\\CharacterFrame\\TemporaryPortrait",
      anchor: anchor("TOPLEFT", "parent", "TOPLEFT", 0, 0) },
  ]));
  const live = renderWindow(window, { onTextureProblem: (problem) => problems.push(problem) });
  try {
    live.update(snapshot({}));
    assert.deepEqual(problems, []);
  } finally {
    live.destroy();
  }
});

test("a condition hides and shows a widget in place", () => {
  const window = parse(definition([
    TEXT("target-name", { bind: "targetName", conditions: [{ when: "noTarget", then: "hide" }] }),
    TEXT("nobody", {
      text: { ru: "Цели нет", en: "" }, hidden: true,
      anchor: anchor("TOPLEFT", "parent", "TOPLEFT", 0, -20),
      conditions: [{ when: "noTarget", then: "show" }],
    }),
  ]));
  const live = renderWindow(window);
  try {
    const named = byWidget(live.element, "target-name");
    const nobody = byWidget(live.element, "nobody");

    live.update(snapshot({ target: false }));
    assert.equal(named.hidden, true);
    assert.equal(nobody.hidden, false);

    live.update(snapshot({ target: true }));
    assert.equal(named.hidden, false);
    assert.equal(nobody.hidden, true, "the base is `hidden`, and the condition no longer overrides it");
    assert.equal(named.textContent, "Кабан");
    // Hidden and shown, never rebuilt: the element the player's pointer is over survives.
    assert.equal(byWidget(live.element, "target-name"), named);

    // A condition that has not changed its mind writes nothing.
    resetWrites(live.element);
    live.update(snapshot({ target: true }));
    assert.equal(named.writes.hidden, 0);
  } finally {
    live.destroy();
  }
});

test("a condition does not cost a widget the look its own file gave it", () => {
  // Two labels of the same font, and the only difference between them is that one carries a
  // condition — a `hide` one, which has nothing to say about colour. Both must be red.
  const window = parse(definition([
    TEXT("warned", {
      text: { ru: "В бою", en: "" }, font: "GameFontRed",
      conditions: [{ when: "outOfCombat", then: "hide" }],
    }),
    TEXT("plain", {
      text: { ru: "Спокойно", en: "" }, font: "GameFontRed",
      anchor: anchor("TOPLEFT", "parent", "TOPLEFT", 0, -20),
    }),
    // A non-solid texture writes its tint into `opacity`, which is the same trap one field over.
    { id: "tinted", type: "Texture", width: 32, height: 32, texture: "Interface\\Icons\\INV_Misc_Rune_01",
      color: [1, 1, 1, 0.4], conditions: [{ when: "inCombat", then: "hide" }],
      anchor: anchor("TOPLEFT", "parent", "TOPLEFT", 0, -40) },
    // And a colour condition that stops holding has to give the widget its own colour back, not
    // hand it to the stylesheet.
    TEXT("flashing", {
      text: "x", font: "GameFontRed",
      conditions: [{ when: "inCombat", then: "color", color: [0, 1, 0, 1] }],
      anchor: anchor("TOPLEFT", "parent", "TOPLEFT", 0, -60),
    }),
  ]));
  const live = renderWindow(window, { textureUrl: (path) => `/texture?path=${path}` });
  try {
    const red = "rgba(255, 26, 26, 1)";
    live.update(snapshot({ combat: true }));
    assert.equal(byWidget(live.element, "plain").style.color, red);
    assert.equal(byWidget(live.element, "warned").style.color, red,
      "a `hide` condition says nothing about colour, and must not answer as though it said white");
    assert.equal(byWidget(live.element, "tinted").style.opacity, "0.4",
      "nor about the tint alpha the texture was built with");

    assert.equal(byWidget(live.element, "flashing").style.color, "rgba(0, 255, 0, 1)");
    live.update(snapshot({ combat: false }));
    assert.equal(byWidget(live.element, "flashing").style.color, red,
      "the condition let go, so the font's own colour is what is left — not nothing at all");
  } finally {
    live.destroy();
  }
});

test("a repeated row obeys its condition on every frame, not only the first", () => {
  // `repeat` and `conditions` both live on `WidgetCommon` and both decide `hidden`, so a row
  // carrying the pair is a supported combination and the two have to agree past the first frame.
  const window = parse(definition([
    TEXT("row", {
      text: "{item}", height: 16,
      repeat: { over: "{world.rows}", as: "item", limit: 3 },
      conditions: [{ when: "inCombat", then: "hide" }],
    }),
  ]));
  const live = renderWindow(window);
  try {
    live.update(snapshot({ rows: ["а", "б", "в"] }));
    const container = walk(live.element).find((node) => node.className === "wnd-repeat");
    assert.deepEqual(container.children.map((node) => node.hidden), [false, false, false]);

    // Three passes, not one. The bug this is for held the condition for exactly one frame: the
    // liveness write put the row back on screen and the condition's fold then declined to look.
    for (let pass = 1; pass <= 3; pass++) {
      live.update(snapshot({ rows: ["а", "б", "в"], combat: true }));
      assert.deepEqual(container.children.map((node) => node.hidden), [true, true, true],
        `pass ${pass}: the condition holds, so every row stays hidden`);
    }

    // Shrinking and regrowing the list must not smuggle a condition-hidden row back on screen.
    live.update(snapshot({ rows: ["а"], combat: true }));
    live.update(snapshot({ rows: ["а", "б", "в"], combat: true }));
    assert.deepEqual(container.children.map((node) => node.hidden), [true, true, true]);

    live.update(snapshot({ rows: ["а", "б", "в"] }));
    assert.deepEqual(container.children.map((node) => node.hidden), [false, false, false],
      "and out of combat they all come back");
  } finally {
    live.destroy();
  }

  // The same collision one field over: a template the file declared hidden must stay hidden.
  const quiet = renderWindow(parse(definition([
    TEXT("row", { text: "{item}", height: 16, hidden: true, repeat: { over: "{world.rows}", as: "item", limit: 2 } }),
  ])));
  try {
    quiet.update(snapshot({ rows: ["а", "б"] }));
    const container = walk(quiet.element).find((node) => node.className === "wnd-repeat");
    assert.deepEqual(container.children.map((node) => node.hidden), [true, true],
      "the row is live and the file still says hidden; liveness is not the only thing that decides");
  } finally {
    quiet.destroy();
  }
});

test("rendering the same definition twice gives the same tree", () => {
  // A `repeat` is in the fixture on purpose. Everything else here is built once from the file and
  // could hardly come out differently; the repeated rows are the one part that is built *later*,
  // out of a growing list, and a list kept anywhere but on the window it belongs to would leave
  // the second window's rows in the first window's container. That is the shape of the bug this
  // assertion is for, and М6's hot reload — build the new window, destroy the old — walks into it.
  const window = parse(definition([
    { id: "panel", type: "Frame", width: 200, height: 80, backdrop: "dialog",
      anchor: anchor("TOPLEFT", "parent", "TOPLEFT", 8, -8),
      children: [TEXT("hello", { bind: "playerName" })] },
    { id: "bar", type: "StatusBar", width: 200, height: 18, bind: "playerHealth",
      anchor: anchor("TOPLEFT", "panel", "BOTTOMLEFT", 0, -4) },
    TEXT("row", { text: "{item}", height: 16, repeat: { over: "{world.rows}", as: "item", limit: 4 },
      anchor: anchor("TOPLEFT", "bar", "BOTTOMLEFT", 0, -4) }),
    { id: "press", type: "Button", width: 90, height: 22, text: { ru: "Жать", en: "" },
      anchor: anchor("BOTTOMLEFT", "parent", "BOTTOMLEFT", 8, 8) },
  ]));
  const first = renderWindow(window);
  const second = renderWindow(window);
  try {
    first.update(snapshot({ rows: ["а", "б", "в"] }));
    second.update(snapshot({ rows: ["а", "б", "в"] }));
    assert.deepEqual(shape(second.element), shape(first.element));
    assert.equal(shape(first.element).children.length, 2, "a header and a body, and nothing invented");
  } finally {
    first.destroy();
    second.destroy();
  }
});

test("repeat draws a row per element and stops at its limit", () => {
  const window = parse(definition([
    TEXT("row", {
      text: "{item}",
      height: 16,
      repeat: { over: "{world.rows}", as: "item", limit: 3 },
    }),
  ]));
  const live = renderWindow(window);
  try {
    live.update(snapshot({ rows: ["а", "б", "в", "г", "д"] }));
    const container = walk(live.element).find((node) => node.className === "wnd-repeat");
    assert.ok(container);
    assert.equal(container.children.length, 3, "five elements, a limit of three");
    assert.deepEqual(container.children.map((node) => node.textContent), ["а", "б", "в"]);
    assert.deepEqual(container.children.map((node) => node.style.top), ["0px", "16px", "32px"]);

    const rows = [...container.children];
    live.update(snapshot({ rows: ["я"] }));
    assert.equal(container.children.length, 3, "the rows are kept and hidden, not thrown away");
    assert.deepEqual(container.children.map((node) => node.hidden), [false, true, true]);
    assert.equal(container.children[0].textContent, "я");
    assert.deepEqual([...container.children], rows, "and they are the same nodes");

    // A list that is not a list at all leaves nothing showing rather than throwing.
    live.update(snapshot({ rows: undefined }));
    assert.deepEqual(container.children.map((node) => node.hidden), [true, true, true]);
  } finally {
    live.destroy();
  }
});

test("a window's own state is readable by its own expressions", () => {
  const window = parse(definition(
    [TEXT("greeting", { text: "здравствуйте, {state.who}" })],
    { state: { who: "модер" } },
  ));
  const live = renderWindow(window);
  try {
    live.update(snapshot());
    assert.equal(byWidget(live.element, "greeting").textContent, "здравствуйте, модер");
  } finally {
    live.destroy();
  }
});

test("a button records the press and says it did nothing, because actions arrive in М6", () => {
  const window = parse(definition([
    { id: "press", type: "Button", width: 90, height: 22, text: { ru: "Жать", en: "" },
      action: { type: "chat", text: { ru: "/say привет", en: "" } },
      anchor: anchor("BOTTOMLEFT", "parent", "BOTTOMLEFT", 8, 8) },
  ]));
  const live = renderWindow(window);
  try {
    byWidget(live.element, "press").listeners.get("click")();
    assert.equal(live.actionPresses.asked, 1);
    assert.equal(live.actionPresses.ran, 0, "there is no runner yet, and the pane says so");
  } finally {
    live.destroy();
  }

  // With a runner, the same press hands over the parsed action list untouched.
  const seen = [];
  const wired = renderWindow(window, { runActions: (actions, context) => seen.push({ actions, context }) });
  try {
    byWidget(wired.element, "press").listeners.get("click")();
    assert.equal(wired.actionPresses.ran, 1);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].actions[0].do, "chat");
    assert.equal(seen[0].context.widget, "press");
    assert.equal(seen[0].context.window, "screen");
  } finally {
    wired.destroy();
  }
});

test("an input publishes what the player typed under the window's state", () => {
  const window = parse(definition([
    { id: "qty", type: "EditBox", width: 80, height: 20, numeric: true,
      anchor: anchor("TOPLEFT", "parent", "TOPLEFT", 0, 0) },
    TEXT("echo", { text: "{state.qty}", anchor: anchor("TOPLEFT", "parent", "TOPLEFT", 0, -22) }),
  ]));
  const live = renderWindow(window);
  try {
    const input = byWidget(live.element, "qty").children[0];
    input.value = "17";
    input.listeners.get("input")();
    live.update(snapshot());
    assert.equal(live.state.qty, 17, "«только числа» publishes a number, because f64 refuses text");
    assert.equal(byWidget(live.element, "echo").textContent, "17");
  } finally {
    live.destroy();
  }
});

test("a tick box publishes its own state before anyone has touched it", () => {
  const window = parse(definition([
    { id: "flag", type: "CheckButton", width: 120, height: 20, state: "flag", checked: true,
      text: { ru: "Показывать", en: "" }, anchor: anchor("TOPLEFT", "parent", "TOPLEFT", 0, 0) },
    TEXT("echo", { text: "[{state.flag}]", anchor: anchor("TOPLEFT", "parent", "TOPLEFT", 0, -22) }),
  ]));
  const live = renderWindow(window);
  try {
    live.update(snapshot());
    // The box draws checked, so a label reading the same key has to read checked too. The edit
    // box, the slider and the drop-down all seed their key; a box that did not left the label
    // beside it empty until the player clicked twice.
    assert.equal(live.state.flag, true);
    assert.equal(byWidget(live.element, "echo").textContent, "[да]");
  } finally {
    live.destroy();
  }
});

test("a module's item slot writes a stack the way every other slot in the client writes it", () => {
  const window = parse(definition([
    { id: "slot", type: "ItemButton", width: 36, height: 36, count: "{state.n}",
      anchor: anchor("TOPLEFT", "parent", "TOPLEFT", 0, 0) },
  ], { state: { n: 20_000 } }));
  const live = renderWindow(window);
  try {
    live.update(snapshot());
    // `.ui-slot-count` is `SlotGrid`'s badge and is sized for what `SlotGrid` writes into it.
    // «20000» in a .66 rem badge pinned to a 36 px corner is five figures where three fit.
    assert.equal(byWidget(live.element, "slot").children[1].textContent, "20k");
    live.state.n = 1;
    live.update(snapshot({ name: "иной" }));
    assert.equal(byWidget(live.element, "slot").children[1].textContent, "",
      "and a stack of one is not written at all");
  } finally {
    live.destroy();
  }
});

/* ---------------------------------------------------------------------------------------------
 * The registry
 * ------------------------------------------------------------------------------------------- */

test("the registry gives one id to one window and takes back exactly what it gave", () => {
  const registry = new WindowRegistry();
  const mine = renderWindow(parse(definition([TEXT("a", { text: "x" })]), "mine"));
  const theirs = renderWindow(parse(definition([TEXT("a", { text: "x" })]), "theirs"));
  try {
    assert.equal(registry.register(mine), undefined);
    const refusal = registry.register(theirs);
    assert.ok(refusal?.includes("mine") && refusal.includes("theirs"),
      "the second author is not the first, so the refusal has to name both modules");
    assert.equal(registry.size, 1);

    assert.equal(registry.definition("screen"), mine.definition);
    assert.deepEqual(registry.list().map((window) => window.id), ["screen"]);

    registry.close("screen");
    assert.equal(mine.visible(), false);
    registry.toggle("screen");
    assert.equal(mine.visible(), true);
    registry.open("screen");
    assert.equal(mine.visible(), true);
    assert.equal(registry.open("nobody"), false);

    assert.equal(viewport.children.includes(mine.element), true);
    assert.equal(registry.forget("mine"), 1);
    assert.equal(registry.size, 0);
    assert.equal(viewport.children.includes(mine.element), false, "forget leaves nothing on the screen");
    // And nothing in the layout either. Every built-in panel is built once and only ever hidden,
    // so `attach` used to have no opposite; a module window is rebuilt whenever its file changes,
    // and a layout that kept the discarded ones would keep a list entry and a live watcher per
    // rebuild for the rest of the session.
    assert.ok(detached.includes(mine.element), "the layout has to be told, or it keeps watching a dead node");
    // A destroyed window is inert: a late tick from the frame it was dropped on does nothing at
    // all, which is why the counters from its last live pass are still the ones standing.
    const before = mine.stats.evaluated;
    resetWrites(mine.element);
    mine.update(snapshot({ name: "кто-то ещё" }));
    assert.equal(mine.stats.evaluated, before);
    assert.equal(totalWrites(mine.element), 0);
  } finally {
    theirs.destroy();
  }
});

test("a condition on the root may not reopen a window the player closed", () => {
  // `color` and `alpha` on the root say how the window looks, not whether it is open. The window's
  // `hidden` belongs to the player — they opened it, pressed Escape or clicked the ×  — and a base
  // that says "visible" folded in sixty times a second would take the close button away from them.
  const shy = renderWindow(parse(definition([TEXT("a", { text: "x" })], {}, {
    conditions: [{ when: "inCombat", then: "color", color: [1, 0, 0, 1] }],
  })));
  try {
    assert.equal(shy.visible(), true);
    shy.hide();
    shy.update(snapshot({ combat: true }));
    assert.equal(shy.visible(), false, "the colour condition fired; the player's close still stands");
    shy.update(snapshot({ combat: false }));
    assert.equal(shy.visible(), false, "and it does not come back when the condition lets go either");
  } finally {
    shy.destroy();
  }

  // A `show`/`hide` condition is the other half: that one *is* about being open, and it wins.
  const hud = renderWindow(parse(definition([TEXT("a", { text: "x" })], {}, {
    hidden: true, conditions: [{ when: "inCombat", then: "show" }],
  })));
  try {
    assert.equal(hud.visible(), false);
    hud.update(snapshot({ combat: true }));
    assert.equal(hud.visible(), true, "«показать в бою» is how a definition writes a HUD that comes and goes");
  } finally {
    hud.destroy();
  }
});

test("Escape closes the windows that asked for it and leaves the rest alone", () => {
  const hud = definition([TEXT("a", { text: "x" })], {}, { escClose: false });
  // The window's own id, not the root widget's: two windows sharing one id is a refusal, and a
  // refused registration would leave this test watching a single window and passing for it.
  hud.id = "hud";
  const asked = renderWindow(parse(definition([TEXT("a", { text: "x" })]), "asked"));
  const quiet = renderWindow(parse(hud, "quiet"));
  assert.equal(windowRegistry.register(asked), undefined);
  assert.equal(windowRegistry.register(quiet), undefined);
  try {
    asked.show();
    quiet.show();
    assert.equal(escapableWindowOpen(), true);
    closeEscapableWindows();
    assert.equal(asked.visible(), false);
    assert.equal(quiet.visible(), true, "a HUD that never asked must not swallow the game-menu key");
    assert.equal(escapableWindowOpen(), false,
      "and with nothing escapable open, Escape has to reach the game menu");
  } finally {
    windowRegistry.clear();
  }
});

/* ---------------------------------------------------------------------------------------------
 * The published view
 * ------------------------------------------------------------------------------------------- */

function unitObject(guid, fields) {
  const map = new Map();
  for (const [name, value] of Object.entries(fields)) {
    if (value !== undefined) map.set(UPDATE_FIELDS[name].offset, value);
  }
  return { guid, typeId: 4, fields: map };
}

test("the published view answers all twelve of the studio's bindings", () => {
  const self = unitObject(42n, {
    UNIT_FIELD_LEVEL: 71,
    UNIT_FIELD_HEALTH: 4_100,
    UNIT_FIELD_MAXHEALTH: 9_000,
    UNIT_FIELD_BYTES_0: (2 << 8) | (0 << 24),
    UNIT_FIELD_POWER1: 3_300,
    UNIT_FIELD_MAXPOWER1: 8_000,
    // The literal, not the constant: a fixture built from the value under test agrees with any
    // value at all, and the bit is the whole claim here.
    UNIT_FIELD_FLAGS: 0x0008_0000,
    PLAYER_XP: 12_345,
    PLAYER_NEXT_LEVEL_XP: 20_000,
    PLAYER_FIELD_COINAGE: 987_654,
    PLAYER_FLAGS: 0x0000_0020,
  });
  const view = buildWindowSnapshot({
    self, selfName: "Тестий", zone: "Дуротар", subzone: "Раздорожье", clock: "09:41",
    groupType: 0x02, groupSize: 5,
  });
  // Read off the core's own headers, not guessed: `UnitDefines.h:154` and `Player.h:355`.
  assert.equal(UNIT_FLAG_IN_COMBAT, 0x0008_0000);
  assert.equal(PLAYER_FLAGS_RESTING, 0x0000_0020);
  assert.equal(view.player.health, 4_100);
  assert.equal(view.player.maxHealth, 9_000);
  assert.equal(view.player.power, 3_300);
  assert.equal(view.player.maxPower, 8_000);
  assert.equal(view.player.xp, 12_345);
  assert.equal(view.player.maxXp, 20_000);
  assert.equal(view.player.money, 987_654);
  assert.equal(view.player.name, "Тестий");
  assert.equal(view.player.level, 71);
  assert.equal(view.player.combat, true, "UNIT_FLAG_IN_COMBAT is 0x00080000 and nothing else says so");
  assert.equal(view.player.resting, true, "PLAYER_FLAGS_RESTING is 0x20; 0x10 beside it is GHOST");
  assert.equal(view.world.zone, "Дуротар");
  assert.equal(view.world.subzone, "Раздорожье");
  assert.equal(view.world.clock, "09:41");
  assert.equal(view.world.inGroup, true);
  assert.equal(view.world.inRaid, true);
  assert.equal(view.target.exists, false);
  // The guid is text, not a bigint: `compare` refuses to order a bigint and the formatter has no
  // case for one, so a guid published as a number would print as an empty string.
  assert.equal(typeof view.player.guid, "string");
  assert.equal(view.player.guid, "42");
  // Frozen, and one level deep is not enough: a widget must not be able to change what the next
  // widget of the same frame reads.
  assert.throws(() => { view.player.health = 1; }, TypeError);
  assert.throws(() => { view.world.zone = "нет"; }, TypeError);
});

test("resting and combat are read off the bits the core actually sets", () => {
  const quiet = buildWindowSnapshot({
    self: unitObject(1n, { UNIT_FIELD_FLAGS: 0, PLAYER_FLAGS: 0x10, UNIT_FIELD_HEALTH: 100 }),
  });
  assert.equal(quiet.player.combat, false);
  assert.equal(quiet.player.resting, false, "0x10 is PLAYER_FLAGS_GHOST — a corpse is not resting");
  assert.equal(quiet.player.dead, false, "and 100 health is not a corpse either");

  const dead = buildWindowSnapshot({ self: unitObject(1n, { UNIT_FIELD_HEALTH: 0 }) });
  assert.equal(dead.player.dead, true);
  const unknown = buildWindowSnapshot({ self: unitObject(1n, {}) });
  assert.equal(unknown.player.dead, false, "health that has not arrived is not a corpse");
  assert.equal(unknown.player.health, undefined);
});

test("rage reaches a window as the number the HUD prints, not as the number on the wire", () => {
  // Rage and runic power are sent at ten times what any interface shows: `POWER_DISPLAY_SCALE[1]`
  // is 10 and `Frames.ts:186` divides before it prints. The studio's `playerPower` binding is
  // `fmt(player.power) + " / " + fmt(player.maxPower)` and has nowhere to put a division, so a raw
  // pair here would put «570 / 1000» in a window standing beside a HUD reading 57/100.
  const warrior = unitObject(7n, {
    UNIT_FIELD_BYTES_0: (1 << 8) | (1 << 24),
    UNIT_FIELD_POWER2: 570,
    UNIT_FIELD_MAXPOWER2: 1_000,
    UNIT_FIELD_HEALTH: 3_000,
  });
  const raged = buildWindowSnapshot({ self: warrior });
  assert.equal(raged.player.powerType, 1, "the fixture is a warrior, or this proves nothing");
  assert.equal(raged.player.powerScale, 10);
  assert.equal(raged.player.power, 57);
  assert.equal(raged.player.maxPower, 100);
  // Taken from `Frames.ts` itself rather than written out again: the claim is that the two agree.
  assert.equal(raged.player.power, Math.round(unit.power(warrior) / unit.powerScale(warrior)));

  // Mana is scale 1, so nothing about it moves.
  const mage = unitObject(8n, {
    UNIT_FIELD_BYTES_0: (8 << 8) | (0 << 24), UNIT_FIELD_POWER1: 3_300, UNIT_FIELD_MAXPOWER1: 8_000,
  });
  const full = buildWindowSnapshot({ self: mage });
  assert.equal(full.player.powerScale, 1);
  assert.equal(full.player.power, 3_300);
  assert.equal(full.player.maxPower, 8_000);
});

test("a target's reaction reaches the hostile condition, and no target reaches none of it", () => {
  const target = unitObject(9n, { UNIT_FIELD_HEALTH: 50, UNIT_FIELD_MAXHEALTH: 100 });
  const hostile = buildWindowSnapshot({ target, targetName: "Кабан", targetReaction: -1 });
  assert.equal(hostile.target.exists, true);
  assert.equal(hostile.target.hostile, true);
  assert.equal(hostile.target.friendly, false);
  const friendly = buildWindowSnapshot({ target, targetName: "Страж", targetReaction: 1 });
  assert.equal(friendly.target.hostile, false);
  assert.equal(friendly.target.friendly, true);
  const none = buildWindowSnapshot({});
  assert.equal(none.target.exists, false);
  assert.equal(none.target.hostile, false, "with no target at all, nothing about a target is true");
  assert.equal(none.target.name, "");
});

/* ---------------------------------------------------------------------------------------------
 * The roots М6 filled in
 * ------------------------------------------------------------------------------------------- */

/** A member of a group, a raid, a boss list or an arena, as `groupUnitView` shapes one. */
const groupRow = (guid, name, extra = {}) => ({
  exists: true, guid, name, level: 80, health: 50, maxHealth: 100, power: 10, maxPower: 100,
  powerType: 0, powerScale: 1, race: undefined, class: 5, gender: undefined, displayId: undefined,
  dead: false, combat: false, mounted: false, online: true, away: false, inGrid: true,
  raidMark: undefined, subGroup: 0, ...extra,
});

const aura = (spellId, name, harmful) => ({ spellId, name, icon: 100 + spellId, stacks: 1, remaining: 12, harmful });

/** Every root the whole view can carry, with a counter on each supplier. */
function fullSources(extra = {}) {
  const asked = [];
  const supplier = (name, value) => () => { asked.push(name); return value; };
  return {
    asked,
    sources: {
      self: unitObject(42n, { UNIT_FIELD_HEALTH: 100, UNIT_FIELD_MAXHEALTH: 100 }),
      selfName: "Тестий",
      focus: supplier("focus", { exists: true, guid: "9", name: "Фокус" }),
      pet: supplier("pet", { exists: true, guid: "8", name: "Волк" }),
      party: supplier("party", [groupRow("2", "Второй")]),
      raid: supplier("raid", [groupRow("42", "Тестий"), groupRow("2", "Второй")]),
      boss: supplier("boss", [groupRow("100", "Босс")]),
      arena: supplier("arena", [groupRow("200", "Враг")]),
      bag: supplier("bag", [{
        id: 255, size: 2, free: 1,
        slot: [
          { itemId: 6948, count: 1, icon: 4, quality: 1, name: "Камень возвращения", guid: "5", bag: 255, index: 23 },
          { itemId: 0, count: 0, icon: 0, quality: undefined, name: "", guid: "0", bag: 255, index: 24 },
        ],
      }]),
      quest: supplier("quest", [{
        id: 26, title: "Волки у ворот", complete: false, failed: false, timer: 0,
        objectives: [{ text: "Волк", have: 3, need: 8, done: false }],
      }]),
      aura: supplier("aura", [aura(1459, "Магия разума", false), aura(589, "Слово Тьмы: Боль", true)]),
      messages: supplier("messages", new Map([["shop.State", { gold: 12 }], ["ping", 7]])),
      settings: supplier("settings", { chatBubbles: false }),
      ...extra,
    },
  };
}

test("the view publishes every root the schema's tables are allowed to name", () => {
  const { sources } = fullSources();
  const view = buildWindowSnapshot(sources);
  // `state` and `slot` are the two roots that are not here: one belongs to a window and the other to
  // the place a patch's widget was drawn into, and the renderer folds each into the scope as it
  // updates. Everything else has to come from the view or every expression over it reads blank.
  const supplied = new Set(["state", "slot"]);
  const published = [...WINDOW_STATE_ROOTS].filter((root) => !supplied.has(root));
  for (const root of published) {
    assert.notEqual(view[root], undefined, `nothing publishes "${root}", so every expression over it is blank`);
  }
});

test("a group, a raid, a boss and an arena row all read as one unit does", () => {
  const { sources } = fullSources();
  const view = buildWindowSnapshot(sources);
  assert.equal(view.party[0].name, "Второй");
  // `party` leaves the player out and `raid` puts them in, exactly as `party1..4` and `raid1..40`
  // do in the original client — and `SMSG_GROUP_LIST` leaves the receiving player out of its own
  // member list, so the raid form is the one that has to put them back.
  assert.deepEqual(view.raid.map((row) => row.name), ["Тестий", "Второй"]);
  assert.equal(view.boss[0].name, "Босс");
  assert.equal(view.arena[0].name, "Враг");
  // Half a raid is out of the client's grid entirely and reaches the screen through
  // `SMSG_PARTY_MEMBER_STATS`, which carries no race and no flags: `inGrid` is how a window tells
  // «out of range» from «not sent yet».
  assert.equal(view.party[0].inGrid, true);
  assert.equal(view.party[0].race, undefined);
  // Frozen a row at a time, not only the list: a widget must not be able to change what the next
  // widget of the same frame reads.
  assert.throws(() => { view.party[0].health = 1; }, TypeError);
  assert.throws(() => { view.raid.push(groupRow("3", "Третий")); }, TypeError);
});

test("bags, quests and auras reach a window in the shape the widgets read", () => {
  const { sources } = fullSources();
  const view = buildWindowSnapshot(sources);
  assert.equal(view.bag[0].slot[0].itemId, 6948);
  // The bag and slot numbers the item opcodes want ride along, so a button can `useItem` on what
  // it is drawing without a second lookup.
  assert.equal(view.bag[0].slot[0].bag, 255);
  assert.equal(view.bag[0].slot[0].index, 23);
  assert.equal(view.bag[0].free, 1);
  assert.equal(view.quest[0].objectives[0].have, 3);
  assert.equal(view.aura[0].spellId, 1459);
  assert.throws(() => { view.bag[0].slot[0].count = 9; }, TypeError);
  assert.throws(() => { view.quest[0].objectives[0].have = 8; }, TypeError);
  // The list itself and not only its rows, exactly as `bag.slot`: the objectives were the one array
  // in the whole view a reader could still push to.
  assert.throws(() => { view.quest[0].objectives.push({ text: "х", have: 0, need: 1, done: false }); }, TypeError);
  assert.throws(() => { view.bag[0].slot.push({}); }, TypeError);
});

test("hasBuff and hasDebuff read a map by name, and the two are kept apart", () => {
  const { sources, asked } = fullSources();
  const view = buildWindowSnapshot(sources);
  // The grammar has no `find` and no `any`, so a lookup by key is the only spelling of «is there an
  // aura called X on me» — which is what the studio's `hasBuff` condition compiles to.
  assert.equal(view.player.buff["Магия разума"].spellId, 1459);
  assert.equal(view.player.debuff["Слово Тьмы: Боль"].spellId, 589);
  assert.equal(view.player.buff["Слово Тьмы: Боль"], undefined, "a debuff is not a buff");
  // A null prototype, so a name out of the dataset cannot reach anything on `Object.prototype`.
  assert.equal(view.player.buff["constructor"], undefined);
  // One pass over the aura list however many conditions ask: two widgets asking `hasBuff` in one
  // tick have to be given one answer, and the view is frozen, so the cache is a closure.
  assert.equal(asked.filter((name) => name === "aura").length, 1);
  view.player.buff;
  view.player.debuff;
  assert.equal(asked.filter((name) => name === "aura").length, 1);
});

test("a message is reachable both by its dotted name and as a path through it", () => {
  const { sources } = fullSources();
  const view = buildWindowSnapshot(sources);
  // The studio names a message `shop.State`, so `msg.shop.State.gold` is the spelling an author
  // reaches for and it needs `msg.shop` to be a container.
  assert.equal(view.msg.shop.State.gold, 12);
  // And the flat key beside it, which is the only spelling left when a module ships both a `shop`
  // message and a `shop.State` one.
  assert.equal(view.msg["shop.State"].gold, 12);
  assert.equal(view.msg.ping, 7);

  // The collision, spelled out: `shop` is a value, so `msg.shop.State` cannot also be a container,
  // and the plain value wins because it is the one somebody named exactly.
  const clashing = buildWindowSnapshot({
    messages: () => new Map([["shop", { total: 1 }], ["shop.State", { gold: 2 }]]),
  });
  assert.deepEqual(clashing.msg.shop, { total: 1 });
  assert.equal(clashing.msg["shop.State"].gold, 2);
  // And the decoded value the registry still owns was not written into on the way past.
  assert.equal(clashing.msg.shop.State, undefined);
});

test("the settings a window may read are the ones the settings window declares", () => {
  const view = buildWindowSnapshot({ settings: () => ({ chatBubbles: false, somethingElse: 7 }) });
  assert.equal(view.setting.chatBubbles, false);
  // A declared option that is missing from the blob reads as its own default, which is what every
  // other reader of the blob does.
  assert.equal(view.setting.chatTimestamps, false);
  assert.equal(view.setting.volumeMaster, 70);
  // And an id nothing declares is not published at all: the blob comes back from the server and
  // from `localStorage`, and neither is state this client hands to a module.
  assert.equal(view.setting.somethingElse, undefined);
});

test("the position, the instance flag and the frame rate are published beside the rest", () => {
  const self = unitObject(42n, { UNIT_FIELD_HEALTH: 10 });
  self.position = { x: 1.5, y: -2.5, z: 30, orientation: 3.14 };
  const view = buildWindowSnapshot({ self, inInstance: true, fps: 58.6 });
  assert.equal(view.player.x, 1.5);
  assert.equal(view.player.y, -2.5);
  assert.equal(view.player.z, 30);
  assert.equal(view.player.o, 3.14);
  assert.equal(view.world.inInstance, true);
  // Rounded, because a bound label showing 58.60000000000001 is not a frame rate.
  assert.equal(view.world.fps, 59);
  const outside = buildWindowSnapshot({});
  assert.equal(outside.world.inInstance, false);
  assert.equal(outside.player.x, undefined, "no position yet is not a position of zero");
});

test("only the roots some window reads are built, and each of them once", () => {
  const { sources, asked } = fullSources();
  // A client whose one window shows the clock must not assemble a raid of forty, five bags of
  // thirty-six, the quest log and the aura strip sixty times a second. The renderer collects the
  // set from the expressions it actually evaluates, so it cannot fall behind a binding.
  const cheap = buildWindowSnapshot({ ...sources, roots: new Set(["player", "world"]) });
  assert.deepEqual(asked, [], "nothing but the player and the world was asked for");
  assert.equal(cheap.bag, undefined, "and an unbuilt root is absent, which reads as a blank label");
  assert.equal(cheap.player.health, 100, "the cheap roots are still there");

  asked.length = 0;
  buildWindowSnapshot({ ...sources, roots: new Set(["player", "party", "aura"]) });
  assert.deepEqual(asked.sort(), ["aura", "party"]);
});

test("a window reports the roots its own bindings read, and the registry unions them", () => {
  const registry = new WindowRegistry();
  const one = renderWindow(parse(definition([TEXT("a", { bind: "playerHealth" })])));
  // A second window with a `repeat` and a condition, because both are expressions the pass
  // evaluates and neither goes through the ordinary binding list.
  const two = renderWindow(parse({
    ...definition([
      { id: "rows", type: "Text", width: 80, height: 16, text: "{row.name}",
        repeat: { over: "{raid}", as: "row" }, anchor: anchor("TOPLEFT", "parent", "TOPLEFT", 0, 0) },
      { id: "flag", type: "Text", width: 80, height: 16, text: { ru: "х", en: "" },
        conditions: [{ when: "expr", value: "{setting.chatBubbles}", then: "hide" }],
        anchor: anchor("TOPLEFT", "parent", "TOPLEFT", 0, -20) },
    ]),
    id: "second",
  }, "other"));
  try {
    assert.deepEqual([...one.roots].sort(), ["player"]);
    // `row` is the repeat's own loop variable and not a root of the published view: asking the
    // snapshot builder for a root called `row` would be asking for a name nothing publishes.
    assert.deepEqual([...two.roots].sort(), ["raid", "setting"]);
    registry.register(one);
    // Asked between the two registrations, because that is when the cache can go stale: the loader
    // registers a module's windows one file at a time and the frame pass runs in between.
    assert.deepEqual([...registry.roots()].sort(), ["player"]);
    registry.register(two);
    assert.deepEqual([...registry.roots()].sort(), ["player", "raid", "setting"]);
    // Cached, and invalidated when the map moves — the pass that reads it runs sixty times a second
    // and the answer changes only when a window is registered or dropped.
    assert.equal(registry.roots(), registry.roots());
    registry.remove(two.id);
    assert.deepEqual([...registry.roots()].sort(), ["player"]);
  } finally {
    one.destroy();
    two.destroy();
  }
});

test("a root read only inside a repeated row is registered before the window is", () => {
  // A row is a copy of a template, and a template's expressions register their roots as they are
  // bound. Built on the first pass that had something to put in it, those roots arrived *after*
  // `WindowRegistry` had unioned the window's — and the union is what the snapshot builder is
  // handed. So a label reading `{aura[0].name}` inside a `repeat` stayed blank for the rest of the
  // session, its supplier never called, with nothing on screen to say why. The list itself was
  // safe, because `repeat.over` is noted when the container is built; everything inside the row
  // was not.
  const registry = new WindowRegistry();
  const live = renderWindow(parse(definition([
    { id: "rows", type: "Text", width: 160, height: 16, text: "{row.name}: {aura[0].name}",
      repeat: { over: "{party}", as: "row" }, anchor: anchor("TOPLEFT", "parent", "TOPLEFT", 0, 0) },
  ])));
  try {
    assert.deepEqual([...live.roots].sort(), ["aura", "party"],
      "the list and what the row reads, both of them before one pass has run");
    registry.register(live);

    // Driven exactly as `refreshModuleWindows` drives it: the registry answers which roots to
    // build, and only those are built.
    const { sources, asked } = fullSources();
    registry.update(buildWindowSnapshot({ ...sources, roots: registry.roots() }));
    assert.ok(asked.includes("aura"), "the supplier for the root only the template reads was not called");

    const container = walk(live.element).find((node) => node.className === "wnd-repeat");
    assert.deepEqual(container.children.filter((node) => !node.hidden).map((node) => node.textContent),
      ["Второй: Магия разума"]);
  } finally {
    live.destroy();
  }
});

test("a press inside a repeated row carries the row it was drawn from", () => {
  // The row lives in the scope the update pass folds and nowhere else, so a press has to be told
  // which row it is on. It was not, and `selectTarget("{row.guid}")` on a repeated button therefore
  // evaluated to `undefined` — which clears the player's target and says «Цель сброшена».
  const seen = [];
  const live = renderWindow(parse(definition([
    { id: "pick", type: "Button", width: 90, height: 20, text: "{row.name}",
      repeat: { over: "{party}", as: "row" },
      actions: [{ do: "command", name: "selectTarget", args: ["{row.guid}"] }],
      anchor: anchor("TOPLEFT", "parent", "TOPLEFT", 0, 0) },
    { id: "plain", type: "Button", width: 90, height: 20, text: { ru: "Закрыть", en: "" },
      actions: [{ do: "close", window: "" }],
      anchor: anchor("BOTTOMLEFT", "parent", "BOTTOMLEFT", 0, 0) },
  ])), { runActions: (_actions, context) => seen.push(context) });
  try {
    live.update({ party: [{ name: "Аня", guid: "77" }, { name: "Боря", guid: "88" }] });
    const rows = walk(live.element).find((node) => node.className === "wnd-repeat").children;
    assert.deepEqual(rows.map((node) => node.textContent), ["Аня", "Боря"]);
    rows[0].listeners.get("click")();
    rows[1].listeners.get("click")();
    assert.deepEqual(seen.map((context) => context.row), [
      { row: { name: "Аня", guid: "77" } },
      { row: { name: "Боря", guid: "88" } },
    ]);

    // Read at the press and not at the build: the same element is reused as the list under it moves.
    live.update({ party: [{ name: "Вера", guid: "99" }] });
    rows[0].listeners.get("click")();
    assert.deepEqual(seen[2].row, { row: { name: "Вера", guid: "99" } });

    // And a widget that is not inside a `repeat` carries no row at all, rather than an empty one:
    // an action scope that always held a `row` key would shadow a published root called `row`.
    byWidget(live.element, "plain").listeners.get("click")();
    assert.equal(seen[3].row, undefined);
  } finally {
    live.destroy();
  }
});

/* ---------------------------------------------------------------------------------------------
 * The examples the diagnostics window can open without a module
 * ------------------------------------------------------------------------------------------- */

test("the bundled example screen parses and draws", () => {
  const raw = JSON.parse(readFileSync(join("examples", "module-example", "ui", "example.json"), "utf8"));
  const result = parseWindowDefinition(raw, { module: "example" });
  assert.deepEqual(result.problems, [], "the example a modder is told to copy has to be clean");
  const live = renderWindow(result.window);
  try {
    // The owner's screens are saved closed — `hidden: true` on the root is the studio's «окно
    // закрыто при входе» — so the pane's button opens it, and nothing under a closed root is drawn.
    assert.equal(live.visible(), false);
    live.show();
    live.update(snapshot({ health: 70, maxHealth: 100, target: false }));
    assert.equal(byWidget(live.element, "player-name").textContent, "Тестий");
    assert.equal(byWidget(live.element, "player-level").textContent, "Уровень 5 · Дуротар · 09:41");
    assert.equal(byWidget(live.element, "target-health").hidden, true);
    assert.equal(byWidget(live.element, "no-target").hidden, false);
    assert.equal(byWidget(live.element, "in-combat").hidden, true);
    live.update(snapshot({ health: 70, maxHealth: 100, target: true }));
    assert.equal(byWidget(live.element, "target-health").hidden, false);
    assert.equal(byWidget(live.element, "no-target").hidden, true);
  } finally {
    live.destroy();
  }
});

test("the owner's screen draws with its texture, its title and its model placeholder", () => {
  const path = join("examples", "module-example", "ui", "proverochnyy-ekran.json");
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const result = parseWindowDefinition(raw, { module: "test" });
  assert.deepEqual(result.problems, []);
  const live = renderWindow(result.window, {
    textureUrl: (texture) => `/texture?path=${encodeURIComponent(texture.replaceAll("/", "\\"))}`,
    viewport: { width: 1920, height: 1080 },
  });
  try {
    live.show();
    live.update(snapshot());
    assert.equal(live.element.dataset.window, "proverochnyy-ekran");
    assert.equal(live.element.children[0].children[0].textContent, "Моё окно");
    // `escClose` and `closeButton` are both true in the owner's file.
    assert.equal(live.escClose, true);
    assert.equal(live.element.children[0].children.length, 2, "and a close button in the header");
    const texture = byWidget(live.element, "texture-1");
    assert.equal(texture.style.left, "16px");
    assert.equal(texture.style.top, "24px");
    assert.equal(texture.children[0].className, "wnd-texture-image");
    // The owner's file writes the path Lua-style, as the studio's picker offers it; the renderer
    // is what turns it into a file the route will serve. Before Ж0 this exact request was the 400
    // that made his `/testUI` window open empty.
    assert.equal(texture.children[0].src,
      "/texture?path=Interface%5CCharacterFrame%5CTemporaryPortrait.blp");
    const model = byWidget(live.element, "model-1");
    assert.equal(model.dataset.unit, "player");
    assert.ok(model.children[0].textContent.includes("игрок"),
      "a placeholder that names its unit, so 'not drawn yet' cannot read as 'wrong unit'");
    // The window opens where the studio anchored it: CENTER of a 1920×1080 viewport, offset −76/+9.
    assert.equal(live.element.style.left, `${Math.round(1920 / 2 - 76 - 384 / 2)}px`);
    assert.equal(live.element.style.top, `${Math.round(1080 / 2 - 9 - 288 / 2)}px`);
  } finally {
    live.destroy();
  }

  // The copy kept beside the client is the owner's file, byte for byte, when the install is here.
  const installed = join("F:", "CleanTswow", "tswow-install", "modules", "test", "content", "ui", "proverochnyy-ekran.json");
  if (existsSync(installed)) {
    assert.equal(readFileSync(path, "utf8"), readFileSync(installed, "utf8"));
  }
});

test("the «Окна» pane says how many windows are live and that it is watching their files", () => {
  const empty = windowsView([], []);
  assert.equal(empty.statusKind, "muted");
  assert.ok(empty.status.includes("ни одного окна"));

  const live = renderWindow(parse(definition([TEXT("a", { bind: "playerName" })])));
  try {
    live.update(snapshot());
    const view = windowsView([live], []);
    assert.equal(view.rows.length, 1);
    assert.equal(view.rows[0].open, true);
    assert.equal(view.rows[0].widgets, 2, "the root frame counts too");
    // М6 turned this sentence around: it used to say why a press did nothing, and now that presses
    // run it says that the files behind these windows are re-read while the pane is open — which is
    // the one thing about the pane an author cannot find out by looking at it.
    assert.ok(view.status.includes("2 с"), "and the pane says it is watching the files");
    assert.ok(view.rows[0].counts.includes("выражений"));
  } finally {
    live.destroy();
  }
});

test("the «Окна» pane redraws when a button is pressed and not on a frame that moved nothing", () => {
  // The pane is redrawn only when its signature moves — the same guard the «Пакеты» pane uses, and
  // it has to be, since these counters are read on the frame tick. A press that the signature did
  // not carry left «нажатий 0» standing on screen after the button had been pressed, which reads
  // as "not even noticed" rather than "noticed and not run" — the one thing this pane is here to
  // say until М6 runs actions.
  const window = parse(definition([
    // A bound label as well as the button, so that the frame below really does move `stats`:
    // a signature that carried the per-frame counters would redraw the pane on it.
    TEXT("name", { bind: "playerName" }),
    { id: "press", type: "Button", width: 90, height: 22, text: { ru: "Жать", en: "" },
      action: { type: "chat", text: { ru: "/say привет", en: "" } },
      anchor: anchor("BOTTOMLEFT", "parent", "BOTTOMLEFT", 8, 8) },
  ]));
  const live = renderWindow(window);
  try {
    live.update(snapshot());
    live.update(snapshot());
    assert.equal(live.stats.changed, 0, "the window has settled");
    const quiet = windowsSignature([live], 0);
    live.update(snapshot({ name: "кто-то" }));
    assert.equal(live.stats.changed, 1, "and this frame moved one label");
    assert.equal(windowsSignature([live], 0), quiet,
      "`stats` moves nearly every frame, so it must stay out of the signature or the guard is gone");

    byWidget(live.element, "press").listeners.get("click")();
    assert.notEqual(windowsSignature([live], 0), quiet, "the press has to reach the pane");
    assert.ok(windowsView([live], []).rows[0].counts.includes("нажатий 1 (выполнено 0)"));
  } finally {
    live.destroy();
  }
});

/* ---------------------------------------------------------------------------------------------
 * The budget
 * ------------------------------------------------------------------------------------------- */

/**
 * What one frame of one window costs, measured rather than assumed.
 *
 * The number that matters is the *unchanged* pass: the interface draws sixty times a second and
 * most frames move nothing, so a renderer that costs the same either way is one that cannot be
 * left running. Both are measured, the median of five cycles after three warm-ups, exactly as the
 * expression budget in `window-expression.test.mjs` is — a single sample of anything on this
 * machine is worth about half of what it says.
 */
test("a pass over a window with twenty bound widgets stays inside its budget", () => {
  const widgets = [];
  for (let index = 0; index < 20; index++) {
    widgets.push(TEXT(`row-${index}`, {
      text: `{target.exists ? fmt(pct(player.health, player.maxHealth), 1) + "% " + player.name : "—"}`,
      anchor: anchor("TOPLEFT", "parent", "TOPLEFT", 0, -index * 8),
    }));
  }
  const live = renderWindow(parse(definition(widgets)));
  try {
    const passes = 1_000;
    const changing = () => {
      const start = performance.now();
      for (let index = 0; index < passes; index++) {
        live.update(snapshot({ health: 100 - (index % 100), target: true }));
      }
      return performance.now() - start;
    };
    const still = () => {
      const frozen = snapshot({ health: 55, target: true });
      live.update(frozen);
      const start = performance.now();
      for (let index = 0; index < passes; index++) live.update(frozen);
      return performance.now() - start;
    };
    const median = (run) => {
      for (let warm = 0; warm < 3; warm++) run();
      return [...Array.from({ length: 5 }, run)].sort((a, b) => a - b)[2];
    };
    const moving = median(changing);
    const quiet = median(still);
    // Printed before it is judged, so that a run which fails the budget still says by how much.
    console.log(`  window pass: moving ${(moving / passes).toFixed(4)} ms, still ${(quiet / passes).toFixed(4)} ms`);
    assert.equal(live.stats.evaluated, 21, "twenty labels and the title");
    assert.equal(live.stats.changed, 0, "and after a still frame, nothing was written");

    // Measured on this machine, node 20.18, median of five cycles after three warm-ups, per pass
    // over twenty-one bindings: alone, 0.0150 / 0.0154 / 0.0155 ms moving and
    // 0.0133 / 0.0138 / 0.0140 ms still; with the whole folder running in parallel
    // (`node --test tests`), 0.0377 / 0.0386 / 0.0391 ms moving and 0.0263 / 0.0275 / 0.0288 ms
    // still. The parallel number is the one a budget is written against — it is two and a half
    // times the single run, and a ceiling set on the single run would be spending itself on the
    // scheduler — so the budgets below are roughly two and a half times the worst parallel median.
    //
    // What they guard is the design the rest of this interface uses: drawing by whole content.
    // Rebuilding this same window every frame instead of mutating it costs 0.0408 / 0.0436 /
    // 0.0468 ms here, three times a still pass, and that is the *flattering* comparison — in this
    // document creating an element is one object literal, while in a browser it is a node, a
    // style resolution and a layout.
    //
    // The "has it moved" check itself is worth little on the clock here for the same reason: with
    // it removed the still pass is 0.0174 ms against 0.0133, because a write to this document is a
    // property assignment. What it saves in a browser is a style recalculation per widget per
    // frame, which no clock in this file can see — so the write counters in the test above are the
    // proof that it works, and this budget is not.
    assert.ok(moving / passes < 0.10,
      `a pass where every value moved took ${(moving / passes).toFixed(4)} ms`);
    assert.ok(quiet / passes < 0.08,
      `a pass where nothing moved took ${(quiet / passes).toFixed(4)} ms`);
  } finally {
    live.destroy();
  }
});

test("assembling the whole view costs what it costs, and a window that reads two roots pays for two", () => {
  // The reason the roots are gated at all, on the clock. Every supplier here builds its rows on
  // the call, exactly as `liveWindowSnapshot`'s do — a benchmark whose suppliers hand back a
  // ready-made array would measure the freezing and nothing else, and the freezing is not the part
  // a frame pays for.
  const groupRows = (count) => Array.from({ length: count }, (_, index) => groupUnitView(
    unitSnapshot(BigInt(index + 1), `Игрок${index}`, {
      // Twelve of forty are in the client's grid and the rest reach the screen through
      // `SMSG_PARTY_MEMBER_STATS`, which is what a real raid looks like.
      object: index < 12 ? unitObject(BigInt(index + 1), {
        UNIT_FIELD_LEVEL: 80, UNIT_FIELD_HEALTH: 40_000, UNIT_FIELD_MAXHEALTH: 50_000,
        UNIT_FIELD_BYTES_0: 5 << 8, UNIT_FIELD_POWER1: 8_000, UNIT_FIELD_MAXPOWER1: 20_000,
      }) : undefined,
      stats: { health: 40_000, maxHealth: 50_000, power: 8_000, maxPower: 20_000, powerType: 0, level: 80, status: 1 },
      online: true,
    }),
    Math.floor(index / 5),
  ));
  const bagRows = () => Array.from({ length: 5 }, (_, bag) => {
    const slot = Array.from({ length: 36 }, (_, at) => ({
      itemId: at % 4 === 3 ? 0 : 6948 + at, count: at % 5, icon: 100 + at, quality: 2,
      name: `Вещь ${at}`, guid: String(1000 + bag * 36 + at), bag: bag === 0 ? 255 : 18 + bag, index: at,
    }));
    return { id: bag === 0 ? 255 : 18 + bag, size: 36, free: 9, slot };
  });
  const sources = {
    self: unitObject(42n, { UNIT_FIELD_HEALTH: 50_000, UNIT_FIELD_MAXHEALTH: 50_000 }),
    selfName: "Тестий", zone: "Дуротар", clock: "09:41", groupSize: 39, inInstance: true, fps: 60,
    focus: () => groupRows(1)[0],
    pet: () => groupRows(1)[0],
    party: () => groupRows(4),
    raid: () => groupRows(40),
    boss: () => groupRows(5),
    arena: () => groupRows(5),
    bag: bagRows,
    quest: () => Array.from({ length: 25 }, (_, index) => ({
      id: 26 + index, title: `Задание ${index}`, complete: false, failed: false, timer: 0,
      objectives: Array.from({ length: 4 }, (_, at) => ({ text: `Цель ${at}`, have: at, need: 8, done: false })),
    })),
    aura: () => Array.from({ length: 40 }, (_, index) => aura(1000 + index, `Аура ${index}`, index % 3 === 0)),
    messages: () => new Map(Array.from({ length: 8 }, (_, index) => [`shop.Msg${index}`, { gold: index }])),
    settings: () => ({ chatBubbles: true, volumeMaster: 70 }),
  };

  const builds = 200;
  const cycle = (roots) => () => {
    const start = performance.now();
    for (let index = 0; index < builds; index++) buildWindowSnapshot(roots ? { ...sources, roots } : sources);
    return (performance.now() - start) / builds;
  };
  const median = (run) => {
    for (let warm = 0; warm < 3; warm++) run();
    return [...Array.from({ length: 5 }, run)].sort((a, b) => a - b)[2];
  };
  const whole = median(cycle(undefined));
  const gated = median(cycle(new Set(["player", "world"])));
  console.log(`  view build: whole ${whole.toFixed(4)} ms, player+world ${gated.toFixed(4)} ms`);

  // Measured on this machine, node 20.18, median of five cycles after three warm-ups, over a
  // deliberately heavy world — a raid of forty (twelve of them in the grid), five bags of
  // thirty-six, twenty-five quests of four objectives, forty auras, eight messages. Alone, the
  // whole view is 0.1319 / 0.1130 / 0.1328 / 0.1143 ms against 0.0159 / 0.0200 / 0.0187 / 0.0171 ms
  // for `player`+`world`: between 5.7 and 8.3 times cheaper over four runs. With the whole folder
  // running in parallel (`node --test tests`), 0.2635 / 0.2107 / 0.2078 ms against
  // 0.0135 / 0.0106 / 0.0117 ms.
  //
  // That ratio is the whole argument for gating. A client whose one module window shows the clock
  // would otherwise pay the first number sixty times a second for a raid nothing reads — 0.26 ms
  // out of a 16 ms frame, for nothing on the screen.
  assert.ok(gated * 2 < whole,
    `gating saved nothing: whole ${whole.toFixed(4)} ms against ${gated.toFixed(4)} ms`);
  // The ceiling is on the whole view and is written against the parallel number, as the pass budget
  // above is — about two and a half times the worst parallel median. A snapshot is built once a
  // frame however many windows read it, which is why one ceiling is enough.
  assert.ok(whole < 0.70, `the whole view took ${whole.toFixed(4)} ms to assemble`);
});
