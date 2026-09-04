import assert from "node:assert/strict";
import test from "node:test";
import {
  GLUE_LOGICAL_HEIGHT, glueViewportMetrics, glueStageMapping, gluePinnedSize,
} from "../dist/code/browser/glue/GlueRuntime.js";

// What the glue screens believe the screen is, before there is a document to measure.
//
// `LoginScreen_OnLoad` runs while the TOC is still being walked — nothing is mounted, so nothing
// can be measured — and the first thing it does is `local width, height = GlueParent:GetSize()`.
// Everything on the login screen is sized from that answer: the scene frame, the background plate
// and all thirty-two model widgets. The answer therefore has to honour the pillarbox `GlueParent`
// gave *itself* two files earlier, and that is what these tests pin.

/** A frame the bridge would build, reduced to the fields `gluePinnedSize` reads. */
function frame(fields) {
  return {
    parent: undefined, points: [], attributes: {}, setAllPoints: false,
    ...fields,
  };
}

/** `setAllPoints="true"` as the parser expands it: TOPLEFT and BOTTOMRIGHT at zero. */
function filling(parent) {
  return frame({
    parent,
    setAllPoints: true,
    points: [
      { point: "TOPLEFT", relativeTo: parent, relativePoint: "TOPLEFT", x: 0, y: 0 },
      { point: "BOTTOMRIGHT", relativeTo: parent, relativePoint: "BOTTOMRIGHT", x: 0, y: 0 },
    ],
  });
}

/**
 * `GlueParent` after `GlueParent_OnLoad` has run, at one viewport.
 *
 * The corpus' own arithmetic, copied from `GlueParent.lua:174-184`: past 16:9 it clears its anchors
 * and re-pins both corners inwards by half the excess width.
 */
function glueParentAt(stageWidth) {
  const height = GLUE_LOGICAL_HEIGHT;
  if (stageWidth / height <= 16 / 9) return filling(undefined);
  const bar = (stageWidth - (height * 16) / 9) / 2;
  return frame({
    setAllPoints: true,
    points: [
      { point: "TOPLEFT", relativePoint: "TOPLEFT", x: bar, y: 0 },
      { point: "BOTTOMRIGHT", relativePoint: "BOTTOMRIGHT", x: -bar, y: 0 },
    ],
  });
}

test("height is the fixed axis and width follows the viewport's aspect", () => {
  // Measured from `GlueParent.xml`: `setAllPoints` with no size, so 768 UI units tall and as wide
  // as the display is. A fixed 1024x768 letterbox would distort every glue texture.
  assert.equal(glueViewportMetrics(1024, 768).virtualWidth, 1024);
  assert.equal(Math.round(glueViewportMetrics(1280, 720).virtualWidth), 1365);
  assert.equal(Math.round(glueViewportMetrics(1920, 1080).virtualWidth), 1365);
  assert.equal(Math.round(glueViewportMetrics(2560, 1440).virtualWidth), 1365);
  // A browser window is not a display: the chrome eats height, so the page is wider than 16:9.
  assert.equal(Math.round(glueViewportMetrics(1920, 969).virtualWidth), 1522);
  assert.equal(Math.round(glueViewportMetrics(3440, 1440).virtualWidth), 1835);
  // A window with no size at all falls back rather than dividing by zero.
  assert.equal(glueViewportMetrics(0, 0).virtualWidth, 1024);
});

test("the glue's display mode is capped at 16:9 and the panel does the stretching", () => {
  // `GlueParent_OnLoad` refuses to lay itself out wider than 16:9 — it pillarboxes instead — so a
  // mode wider than that is not something the corpus has a layout for. The stage stops there and
  // the two scales part company, which is exactly what a monitor does with a narrower mode: the
  // owner's «в оригинале растянуто».
  //
  //  viewport      virtual width  scaleX     scaleY
  const matrix = [
    [1024, 768, 1024, 1, 1],                          // 4:3 — the design mode, untouched
    [1280, 1024, 960, 1.3333333, 1.3333333],          // 5:4 — narrower than the design, still uniform
    [1680, 1050, 1228.8, 1.3671875, 1.3671875],       // 16:10 — uniform
    [1920, 1080, 1365.3333, 1.40625, 1.40625],        // 16:9 — the cap, still exactly uniform
    [2560, 1440, 1365.3333, 1.875, 1.875],            // 16:9 again
    [1920, 969, 1365.3333, 1.40625, 1.2617188],       // a maximised browser window: 11.5 % stretch
    [3440, 1440, 1365.3333, 2.5195313, 1.875],        // 21:9: 34.4 %
    [1722, 563, 1365.3333, 1.2612305, 0.7330729],     // the owner's short-wide window
  ];
  for (const [width, height, virtualWidth, scaleX, scaleY] of matrix) {
    const mapping = glueStageMapping(width, height);
    const at = `${width}x${height}`;
    assert.ok(Math.abs(mapping.virtualWidth - virtualWidth) < 0.001, `virtual width at ${at}: ${mapping.virtualWidth}`);
    assert.ok(Math.abs(mapping.scaleX - scaleX) < 1e-6, `scaleX at ${at}: ${mapping.scaleX}`);
    assert.ok(Math.abs(mapping.scaleY - scaleY) < 1e-6, `scaleY at ${at}: ${mapping.scaleY}`);
    assert.equal(mapping.virtualHeight, GLUE_LOGICAL_HEIGHT);
    // Whatever the shape, the stage covers the viewport exactly: no bars of ours and none left for
    // the corpus to draw, because it is never told about an aspect it would pillarbox.
    assert.ok(Math.abs(mapping.virtualWidth * mapping.scaleX - width) < 1e-9, `covers width at ${at}`);
    assert.ok(Math.abs(GLUE_LOGICAL_HEIGHT * mapping.scaleY - height) < 1e-9, `covers height at ${at}`);
    assert.ok(mapping.virtualWidth / GLUE_LOGICAL_HEIGHT <= 16 / 9 + 1e-9, `mode is never wider than 16:9 at ${at}`);
    // At or below 16:9 the stretch is the identity: the mapping shipped before this one, unchanged.
    if (width / height <= 16 / 9) {
      assert.equal(mapping.scaleX, mapping.scaleY, `uniform at ${at}`);
      assert.ok(Math.abs(mapping.virtualWidth - glueViewportMetrics(width, height).virtualWidth) < 1e-9,
        `same virtual width as the uniform fit at ${at}`);
    }
  }
  // A window with no size at all falls back rather than dividing by zero.
  assert.equal(glueStageMapping(0, 0).virtualWidth, 1024);
});

test("GlueParent measures its own pillarbox, not the stage", () => {
  // The matrix, all of it through the same function the page installs. `stage` is what
  // `GetScreenWidth()` answers; `GlueParent` is what `GetSize()` must answer after its OnLoad.
  const matrix = [
    // viewport            stage   GlueParent
    [1024, 768, 1024, 1024],
    [1280, 720, 1365, 1365],
    [1366, 768, 1366, 1365],
    [1920, 1080, 1365, 1365],
    [1920, 969, 1522, 1365],
    [2560, 1440, 1365, 1365],
    [2560, 1329, 1479, 1365],
    [1600, 900, 1365, 1365],
    [3440, 1440, 1835, 1365],
  ];
  for (const [width, height, expectedStage, expectedParent] of matrix) {
    const stageWidth = Math.round(glueViewportMetrics(width, height).virtualWidth);
    assert.equal(stageWidth, expectedStage, `stage width at ${width}x${height}`);
    const stage = { width: stageWidth, height: GLUE_LOGICAL_HEIGHT };
    const box = gluePinnedSize(glueParentAt(stageWidth), stage);
    assert.ok(box, `GlueParent measurable at ${width}x${height}`);
    assert.equal(Math.round(box.width), expectedParent, `GlueParent width at ${width}x${height}`);
    assert.equal(box.height, GLUE_LOGICAL_HEIGHT);
    // Which is the whole point: at or past 16:9 the login scene is authored 16:9 and stays it.
    if (stageWidth / GLUE_LOGICAL_HEIGHT >= 16 / 9) {
      assert.ok(Math.abs(box.width / box.height - 16 / 9) < 0.002,
        `aspect at ${width}x${height}: ${(box.width / box.height).toFixed(3)}`);
    }
  }
});

test("a screen inside GlueParent inherits the pillarboxed box, not the stage", () => {
  // `AccountLogin` is `parent="GlueParent" setAllPoints="true"`, and `AccountLoginUI` inside it is
  // `setAllPoints` again: the chain the login buttons are anchored to.
  const stage = { width: 1522, height: GLUE_LOGICAL_HEIGHT };
  const parent = glueParentAt(stage.width);
  const login = filling(parent);
  const ui = filling(login);
  assert.equal(Math.round(gluePinnedSize(parent, stage).width), 1365);
  assert.equal(Math.round(gluePinnedSize(login, stage).width), 1365);
  assert.equal(Math.round(gluePinnedSize(ui, stage).width), 1365);
});

test("a frame with a size of its own keeps it, and an unpinned one is left to the caller", () => {
  const stage = { width: 1365, height: GLUE_LOGICAL_HEIGHT };
  // `LoginScene` is `CreateFrame("Frame")` plus `SetSize(width, height)`: attribute-backed.
  const scene = frame({ attributes: { width: "1365", height: "768" } });
  assert.deepEqual(gluePinnedSize(scene, stage), { width: 1365, height: 768 });
  // A single-corner anchor and no size pins nothing; the bridge falls back to the declaration.
  const loose = frame({ points: [{ point: "CENTER", x: 0, y: 0 }] });
  assert.equal(gluePinnedSize(loose, stage), undefined);
});

test("the y axis is read the way FrameXML writes it — positive is up", () => {
  const stage = { width: 1000, height: 768 };
  // A frame inset 100 from the top and 50 from the bottom: TOP y is negative going down,
  // BOTTOM y is positive going up.
  const inset = frame({
    points: [
      { point: "TOPLEFT", relativePoint: "TOPLEFT", x: 0, y: -100 },
      { point: "BOTTOMRIGHT", relativePoint: "BOTTOMRIGHT", x: 0, y: 50 },
    ],
  });
  assert.deepEqual(gluePinnedSize(inset, stage), { width: 1000, height: 768 - 100 - 50 });
});

// The same question put to the owner's own corpus rather than to a hand-built frame: load the real
// GlueXML out of the MPQ chain at three viewports and read what the login scene came out as. A
// machine without the client skips.
let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine" };

function fakeDocument() {
  const doc = { createElement: (tag) => make(tag) };
  function make(tag) {
    const attributes = new Map();
    const listeners = new Map();
    const style = {
      setProperty(name, value) { this[name] = String(value); },
      removeProperty(name) { delete this[name]; },
    };
    const node = {
      ownerDocument: doc, tagName: tag.toUpperCase(), children: [], parentElement: undefined,
      style, hidden: false, className: "", textContent: "", value: "", disabled: false,
      classList: { add(...names) { node.className = [...names].join(" "); } },
      addEventListener(name, listener) { listeners.set(name, [...(listeners.get(name) ?? []), listener]); },
      dispatchEvent(event) { for (const listener of listeners.get(event.type) ?? []) listener(event); },
      setAttribute(name, value) { attributes.set(name, String(value)); },
      getAttribute(name) { return attributes.get(name) ?? null; },
      removeAttribute(name) { attributes.delete(name); },
      append(...children) {
        for (const child of children) { child.parentElement = node; node.children.push(child); }
      },
      remove() {
        const index = node.parentElement?.children.indexOf(node) ?? -1;
        if (index >= 0) node.parentElement.children.splice(index, 1);
        node.parentElement = undefined;
      },
    };
    return node;
  }
  doc.head = make("head");
  return doc;
}
globalThis.document = fakeDocument();

test("the real login scene comes out 16:9 at every aspect at or past 16:9", withClient, async () => {
  const { GlueRuntime } = await import("../dist/code/browser/glue/GlueRuntime.js");
  const { clientArchives } = await import("../tools/mpq.mjs");
  const chain = await clientArchives(clientDirectory);
  const provider = {
    async read(path) {
      const data = await chain.read(path.replaceAll("/", "\\"));
      return data ? new TextDecoder("utf-8").decode(data) : undefined;
    },
  };

  // 16:9 exactly, a maximised 1080p browser window (the chrome makes it 1.98:1), and 21:9.
  for (const [width, height, expected] of [[1280, 720, 1365], [1920, 969, 1365], [3440, 1440, 1365]]) {
    const stage = {
      width: Math.round(glueStageMapping(width, height).virtualWidth),
      height: GLUE_LOGICAL_HEIGHT,
    };
    // The stage is the mode the corpus is told about, and it is capped where the corpus caps
    // itself — so `GlueParent_OnLoad` never takes the pillarbox branch and never puts a black bar
    // down the sides of the owner's window. `GlueParent` therefore *is* the stage at every aspect.
    assert.equal(stage.width, expected, `stage width at ${width}x${height}`);
    const luaErrors = [];
    const runtime = new GlueRuntime({
      provider,
      lua: { onError: (message) => luaErrors.push(message) },
      api: { locale: "ruRU", screen: () => ({ width: stage.width, height: stage.height }) },
    });
    // Exactly what `Bootstrap.ts` installs, minus the renderer, which has no layout here — and that
    // is the state the corpus' OnLoad runs in on the live page too.
    runtime.bridge.setMeasure((frame) => {
      const pinned = gluePinnedSize(frame, stage);
      return pinned && pinned.width > 0 && pinned.height > 0 ? pinned : undefined;
    });
    await runtime.load();
    runtime.api.setGlueScreen("login");
    assert.deepEqual(luaErrors, [], `Lua errors at ${width}x${height}`);

    const parent = runtime.bridge.getFrame("GlueParent");
    assert.equal(Math.round(runtime.bridge.measure(parent).width), expected,
      `GlueParent width at ${width}x${height} (stage ${stage.width})`);

    // `lgzg.lua` sizes every one of its model widgets from `GlueParent:GetSize()`; they are the
    // corpus' only anonymous Model widgets, so that is how they are picked out.
    const scene = [...runtime.bridge.modelFrames].filter((f) => !f.named && f.type === "Model");
    assert.equal(scene.length, 32, `login scene models at ${width}x${height}`);
    for (const model of scene) {
      const box = runtime.bridge.measure(model);
      assert.equal(Math.round(box.width), expected, `model widget width at ${width}x${height}`);
      assert.equal(Math.round(box.height), GLUE_LOGICAL_HEIGHT);
    }
    runtime.close();
  }
  chain.close();
});

test("an anchor to another frame is skipped, because nothing about it is measurable yet", () => {
  const stage = { width: 1365, height: 768 };
  const other = frame({ attributes: { width: "100", height: "20" } });
  const anchored = frame({
    attributes: { width: "150", height: "38" },
    points: [{ point: "BOTTOM", relativeTo: other, relativePoint: "TOP", x: 0, y: 0 }],
  });
  assert.deepEqual(gluePinnedSize(anchored, stage), { width: 150, height: 38 });
});
