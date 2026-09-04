// Л1, after the review: the two ends of «which body still holds loot» that no test held.
//
// The plate is covered in `nameplate.test.mjs`, the predicates in `loot.test.mjs` and Tab in
// `targeting.test.mjs`. What was left running on nothing but the screen was the minimap dot — the
// bit that decides it and the range that admits it — and the «Обыскать» button, which is marked
// rather than disabled and rewrites its own accessible name.

import assert from "node:assert/strict";
import test from "node:test";

/**
 * A document whose `getElementById` answers the same element for the same id, and whose canvases
 * hand back a 2D context that records every call.
 *
 * `ui/Dom.ts` resolves its elements once, at import, and holds the handles, so a stub that returned
 * a fresh object per call would let both frames paint into elements this file could never read
 * back. The minimap goes further and builds its own frame at runtime — it needs a canvas that has
 * a context, or `build()` throws.
 */
const canvasCalls = [];

function fakeDocument() {
  const byId = new Map();
  const make = (tag) => {
    const node = {
      tagName: String(tag).toUpperCase(), children: [], dataset: {}, className: "", textContent: "",
      title: "", hidden: false, disabled: false, onerror: null, src: "", id: "", value: "", type: "",
      // `clientWidth` is the minimap's own frame (`style.css:556`); the rectangle is the viewport
      // the head overlay projects into. `isConnected` keeps that overlay layer from being rebuilt
      // on every frame, which is what the real DOM does.
      options: [], clientWidth: 160, clientHeight: 160, width: 0, height: 0, isConnected: true,
      style: { setProperty(name, value) { this[name] = value; }, removeProperty(name) { delete this[name]; } },
      classList: {
        add(...names) { node.className = [...new Set([...node.className.split(" ").filter(Boolean), ...names])].join(" "); },
        remove(...names) { node.className = node.className.split(" ").filter((name) => !names.includes(name)).join(" "); },
        toggle(name, on) { if (on) this.add(name); else this.remove(name); },
        contains(name) { return node.className.split(" ").includes(name); },
      },
      append(...nodes) { node.children.push(...nodes); },
      prepend(...nodes) { node.children.unshift(...nodes); },
      appendChild(child) { node.children.push(child); return child; },
      insertBefore(child, reference) {
        const index = node.children.indexOf(reference);
        if (index < 0) node.children.push(child);
        else node.children.splice(index, 0, child);
        return child;
      },
      replaceChildren(...nodes) { node.children = [...nodes]; },
      remove() {}, focus() {}, blur() {},
      addEventListener() {}, removeEventListener() {},
      setAttribute(name, value) { node[name] = value; },
      getAttribute(name) { return node[name] ?? null; },
      removeAttribute(name) { delete node[name]; },
      querySelector() { return make("div"); }, querySelectorAll() { return []; }, closest() { return undefined; },
      getBoundingClientRect() { return { x: 0, y: 0, width: 1280, height: 720, top: 0, left: 0, right: 1280, bottom: 720 }; },
      getContext(kind) { return kind === "2d" ? recordingContext() : null; },
    };
    return node;
  };
  return {
    createElement: make, createElementNS: (_namespace, tag) => make(tag),
    createTextNode: (text) => ({ textContent: text }), createDocumentFragment: () => make("fragment"),
    body: make("body"), documentElement: make("html"), head: make("head"),
    getElementById(id) {
      let node = byId.get(id);
      if (!node) {
        node = make("div");
        node.id = id;
        byId.set(id, node);
      }
      return node;
    },
    querySelector() { return make("div"); }, querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {},
  };
}

/**
 * A 2D context that records what it was asked to draw, in the frame's own coordinates.
 *
 * The minimap translates to the centre of the circle before it draws a single blip, so the arcs
 * arrive as offsets from the character — which is exactly what a dot's *position* means here.
 */
function recordingContext() {
  const state = { fillStyle: "", strokeStyle: "", lineWidth: 0, font: "", textAlign: "", textBaseline: "" };
  const record = (name) => (...args) => { canvasCalls.push({ name, args, fillStyle: state.fillStyle }); };
  return new Proxy(state, {
    get: (target, property) => (property in target ? target[property] : record(property)),
    set: (target, property, value) => { target[property] = value; return true; },
  });
}

globalThis.document = fakeDocument();
globalThis.location = { protocol: "http:", hostname: "127.0.0.1", origin: "http://127.0.0.1:5173" };
globalThis.window = {
  addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1,
  innerWidth: 1280, innerHeight: 800,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
};
globalThis.localStorage = globalThis.window.localStorage;
globalThis.matchMedia = globalThis.window.matchMedia;
globalThis.requestAnimationFrame = () => 0;
globalThis.HTMLElement = class {};

const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { game } = await import("../dist/code/browser/game/Context.js");
const { updateMinimap, minimapSettings } = await import("../dist/code/browser/ui/Minimap.js");
const { showTarget } = await import("../dist/code/browser/ui/Frames.js");
const { resetHeadOverlay, showChatBubble, updateHeadOverlay } =
  await import("../dist/code/browser/ui/HeadOverlay.js");
const { createCamera, projectPoint } = await import("../dist/code/browser/SimpleScene.js");
const { plateLayout } = await import("../dist/code/browser/NamePlate.js");

/** The default frame: 160 CSS pixels across (`style.css:556`) at the default 266-yard zoom. */
const MINIMAP_SIZE = 160;
const CORPSE_COLOUR = "#b4e650";

function unit(guid, { typeId = 3, x = 0, y = 0, health = 100, dynamicFlags = 0, entry = 0 } = {}) {
  const fields = new Map([
    [UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, entry],
    [UPDATE_FIELDS.UNIT_FIELD_MAXHEALTH.offset, 100],
    [UPDATE_FIELDS.UNIT_DYNAMIC_FLAGS.offset, dynamicFlags],
  ]);
  if (health !== undefined) fields.set(UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, health);
  return { guid, typeId, position: { x, y, z: 0, orientation: 0 }, fields };
}

/** Everything the minimap and the target frame ask a world for, and nothing else. */
function stubWorld(objects, targetGuid) {
  return {
    mapId: 0,
    state: { selfGuid: 1n, objects },
    targetGuid,
    group: undefined,
    questPoi: new Map(),
    raidTargets: new Map(),
    threat: new Map(),
    names: new Map(),
    casts: new Map(),
    questGiverStatus: new Map(),
    castProgress: () => 0,
    currentGameTime: () => undefined,
    displayName: (guid) => `0x${guid.toString(16)}`,
    aurasFor: () => [],
  };
}

/**
 * One minimap frame, and the corpse dots it drew, as offsets in pixels from the character.
 *
 * A blip is `beginPath`, `arc`, then the colour and `fill` — the colour is written *after* the arc,
 * so the two have to be paired rather than filtered on. Everything is in the frame's own
 * coordinates: `drawMinimap` translates to the centre of the circle before any blip is drawn.
 */
function corpseDots(objects) {
  const previous = game.world;
  try {
    game.world = stubWorld(objects, undefined);
    canvasCalls.length = 0;
    updateMinimap(0);
    const dots = [];
    let pending;
    for (const call of canvasCalls) {
      if (call.name === "arc") pending = { column: call.args[0], row: call.args[1] };
      else if (call.name === "fill" && pending && call.fillStyle === CORPSE_COLOUR) {
        dots.push(pending);
        pending = undefined;
      }
    }
    return dots;
  } finally {
    game.world = previous;
  }
}

test("Л1 the minimap dot is the loot bit and nothing else", () => {
  const player = unit(1n, { typeId: 4 });
  const objects = new Map([
    [1n, player],
    // Dead and still lootable: the dot.
    [2n, unit(2n, { x: 20, health: 0, dynamicFlags: 0x01 })],
    // Dead and emptied — the core clears the bit (`LootHandler.cpp:411`) — so no dot. Reading
    // health instead would leave every kill of the day on the map for as long as the body stood.
    [3n, unit(3n, { x: 21, health: 0, dynamicFlags: 0x04 })],
    // Alive. The bit is on it, which the core does not do, but if it ever did the dot must not
    // follow: this dot means «a body worth walking back to».
    [4n, unit(4n, { x: 22, health: 60, dynamicFlags: 0x01 })],
    // A player's corpse is not a creature and carries no creature loot.
    [5n, unit(5n, { typeId: 4, x: 23, health: 0, dynamicFlags: 0x01 })],
  ]);
  assert.equal(corpseDots(objects).length, 1);
  assert.deepEqual(objects.get(2n).fields.get(UPDATE_FIELDS.UNIT_DYNAMIC_FLAGS.offset), 0x01);
});

test("Л1 the corpse dot is ranged, and its range is where the rim stops lying", () => {
  // The review's finding: `settings.zoom / 2` is exactly `radius` pixels, while the drawing loop
  // clamps every blip to `radius - 4`, so the outer four pixels admitted dots and then pinned them
  // all to the same circle. At the default 160 px frame and 266 yards across — 1.6625 yards to the
  // pixel — that was every body between 126.35 and 133 yards drawn at radius 76: 5% of the radius
  // and 9.75% of the area, over exactly the band where «walk back for it» is a real decision.
  const { zoom } = minimapSettings();
  assert.equal(zoom, 266, "the default zoom, which the arithmetic below is taken at");
  const radius = MINIMAP_SIZE / 2;
  const yardsPerPixel = zoom / (radius * 2);
  const reach = (radius - 4) * yardsPerPixel;
  assert.ok(Math.abs(reach - 126.35) < 1e-9, `${reach}`);

  const player = unit(1n, { typeId: 4 });
  const at = (yards) => corpseDots(new Map([
    [1n, player],
    [2n, unit(2n, { x: yards, health: 0, dynamicFlags: 0x01 })],
  ]));

  // Just inside: drawn, and drawn where the body is rather than on the rim. `minimapBlip` puts
  // north — falling row — at rising X, so the row is the negated distance in pixels.
  const near = at(reach - 1);
  assert.equal(near.length, 1);
  assert.ok(Math.abs(near[0].row + (reach - 1) / yardsPerPixel) < 1e-6,
    `the dot was clamped: row ${near[0].row}`);
  assert.ok(Math.hypot(near[0].row, near[0].column) < radius - 4);

  // Just outside: no dot at all, rather than a dot on the rim saying «somewhere that way».
  assert.deepEqual(at(reach + 1), []);
  assert.deepEqual(at(zoom / 2 - 1), [], "including the whole band the old range admitted");
});

test("Л1 «Обыскать» is marked rather than disabled, and says which it is", () => {
  const previous = game.world;
  try {
    const lootButton = document.getElementById("loot-button");
    const objects = new Map([[1n, unit(1n, { typeId: 4 })]]);
    const withTarget = (target) => {
      objects.set(target.guid, target);
      game.world = stubWorld(objects, target.guid);
      game.creatureMetadata = { get: () => undefined, load: async () => false };
      game.gameObjectMetadata = { get: () => undefined, load: async () => false };
      showTarget();
    };

    // A body that still holds something.
    withTarget(unit(2n, { x: 2, health: 0, dynamicFlags: 0x01 }));
    assert.equal(lootButton.hidden, false);
    assert.equal(lootButton.getAttribute("aria-disabled"), null);
    assert.equal(lootButton.title, "Обыскать");
    assert.equal(lootButton.getAttribute("aria-label"), "Обыскать");
    assert.equal(lootButton.disabled, false,
      "marked, never disabled: the client's copy of the bit lags a round-robin handover");

    // The same body, emptied. The button stays, and stays clickable — `Player::SendLoot` judges by
    // the raw flag (`Player.cpp:8898-8902`) and the copy the client holds has been through
    // `isAllowedToLoot` per viewer — but it says so and reads so.
    withTarget(unit(2n, { x: 2, health: 0, dynamicFlags: 0x04 }));
    assert.equal(lootButton.hidden, false);
    assert.equal(lootButton.getAttribute("aria-disabled"), "true");
    assert.equal(lootButton.title, "Здесь нечего обыскивать");
    assert.equal(lootButton.getAttribute("aria-label"), "Здесь нечего обыскивать",
      "the markup's static aria-label outranks the tooltip, so the name is rewritten too");
    assert.equal(lootButton.disabled, false);

    // A living creature is not a body, so the button is not there at all.
    withTarget(unit(3n, { x: 3, health: 60, dynamicFlags: 0x01 }));
    assert.equal(lootButton.hidden, true);
  } finally {
    game.world = previous;
  }
});

test("Л1 a creature that speaks as it dies keeps the bubble, brought down onto the body", () => {
  // The fourth of the four filters, and the one that was never about the name: `HeadOverlay` is the
  // anchor for chat bubbles and rising damage numbers. Dropping every dead unit there cut the
  // dying creature's own line off mid-sentence and hid the killing blow's number, which is raised
  // at the instant health reaches zero. The body is kept and the anchor is brought down to it: the
  // renderer lays a corpse along its own facing and `unitHeight` still answers the standing figure,
  // so hanging a bubble from `position.z + unitHeight` puts it a body's length above empty ground.
  const previous = game.world;
  const previousRenderer = game.renderer;
  try {
    const player = unit(1n, { typeId: 4 });
    const speaker = unit(2n, { x: 12, health: 60 });
    game.world = stubWorld(new Map([[1n, player], [2n, speaker]]), undefined);
    game.renderer = { unitHeight: () => 2 };

    const bubbleY = () => {
      resetHeadOverlay();
      showChatBubble(2n, "Ты за это заплатишь!");
      updateHeadOverlay(performance.now());
      const layer = document.getElementById("world-viewport").children.at(-1);
      const node = layer.children.at(-1);
      assert.equal(node.hidden, false, "the bubble has to be on the screen at all");
      const match = /translate\((-?\d+)px, (-?\d+)px\)$/.exec(node.style.transform);
      assert.ok(match, node.style.transform);
      return Number(match[2]);
    };

    const camera = createCamera(player.position, game.camera.yaw, game.camera.viewPitch, game.camera.view,
      { pivotHeight: game.camera.pivotHeight });
    const standing = projectPoint({ x: 12, y: 0, z: 2 }, camera, 1280, 720);
    // 0.9 yards: `#shapeCapsule` rests a dead unit at its own radius, so a body is about as high
    // off the ground as an ordinary unit is wide.
    const lying = projectPoint({ x: 12, y: 0, z: 0.9 }, camera, 1280, 720);
    assert.ok(standing && lying);

    const alive = bubbleY();
    const tallestPlate = plateLayout({ target: true, cast: {} }, standing.x, standing.y);
    const raidMarkTop = tallestPlate.y - 18 * tallestPlate.scale;
    assert.ok(alive < raidMarkTop, "the bubble clears the readable name/health/cast rows and raid mark");

    speaker.fields.set(UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 0);
    const dead = bubbleY();
    assert.equal(dead - alive, Math.round(lying.y) - Math.round(standing.y),
      "death moves the bubble by the projected head-to-body displacement, keeping the same clearance");
    assert.ok(dead > alive, `${dead} has to be lower on the screen than ${alive}`);
  } finally {
    resetHeadOverlay();
    game.world = previous;
    game.renderer = previousRenderer;
  }
});

test("active quest creature and game-object targets get projected badges, but item targets do not", () => {
  const previous = {
    world: game.world,
    renderer: game.renderer,
    creatureMetadata: game.creatureMetadata,
    itemMetadata: game.itemMetadata,
  };
  try {
    const questId = 77;
    const questBase = UPDATE_FIELDS.PLAYER_QUEST_LOG_1_1.offset;
    const player = unit(1n, { typeId: 4 });
    player.fields.set(questBase, questId);
    player.fields.set(questBase + 2, 3); // 3 / 10 wolves; the GO counter stays zero.
    const creature = unit(2n, { x: 12, entry: 299 });
    const gameObject = unit(3n, { typeId: 5, x: 14, entry: 1617 });
    const world = stubWorld(new Map([[1n, player], [2n, creature], [3n, gameObject]]), undefined);
    world.questTemplates = new Map([[questId, {
      questId,
      title: "Волки у ворот",
      objectives: [
        { entry: 299, count: 10, gameObject: false, itemDrop: 0, text: "" },
        { entry: 1617, count: 1, gameObject: true, itemDrop: 0, text: "" },
      ],
      itemObjectives: [{ itemId: 769, count: 8 }],
    }]]);
    world.creatureTemplates = new Map();
    world.gameObjectTemplates = new Map([[1617, { name: "Сундук Братства" }]]);
    world.itemTemplates = new Map([[769, { name: "Кусок мяса вепря" }]]);
    const creatureNames = new Map([[299, { name: "Лесной волк" }]]);
    game.world = world;
    game.renderer = { unitHeight: () => 2 };
    game.creatureMetadata = { get: (id) => creatureNames.get(id) };
    game.itemMetadata = { get: () => undefined };

    const badges = (now) => {
      resetHeadOverlay();
      updateHeadOverlay(now);
      const layer = document.getElementById("world-viewport").children.at(-1);
      return layer.children.filter((node) => node.className === "quest-world-marker");
    };

    const active = badges(1_000);
    assert.equal(active.length, 2, "only the loaded creature and GO are honest 3D anchors");
    const byKind = new Map(active.map((node) => [node.dataset.kind, node]));
    assert.equal(byKind.get("creature").dataset.label, "Лесной волк");
    assert.equal(byKind.get("creature").children[1].textContent, "3 / 10");
    assert.equal(byKind.get("gameObject").dataset.label, "Сундук Братства");
    assert.equal(byKind.get("gameObject").children[1].textContent, "0 / 1");
    assert.match(byKind.get("creature").style.transform, /translate\(-50%, -100%\) translate\(/);
    assert.equal(active.some((node) => node.dataset.label === "Кусок мяса вепря"), false,
      "an item id never becomes a guessed creature/dropper marker");

    player.fields.set(questBase + 2, 10);
    assert.deepEqual(badges(1_200).map((node) => node.dataset.kind), ["gameObject"],
      "a completed target leaves the live-world overlay immediately on the next refresh");

    player.fields.set(questBase + 2, 3);
    creatureNames.clear();
    assert.equal(badges(1_400).find((node) => node.dataset.kind === "creature").dataset.label,
      "Существо #299", "cache clear degrades to a stable typed id, never an empty badge");
    creatureNames.set(299, { name: "Седой волк" });
    assert.equal(badges(1_600).find((node) => node.dataset.kind === "creature").dataset.label,
      "Седой волк", "a refilled cache is reflected without retaining a stale resolver result");
  } finally {
    resetHeadOverlay();
    game.world = previous.world;
    game.renderer = previous.renderer;
    game.creatureMetadata = previous.creatureMetadata;
    game.itemMetadata = previous.itemMetadata;
  }
});
