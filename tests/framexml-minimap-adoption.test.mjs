import assert from "node:assert/strict";
import test from "node:test";

function fakeStyle() {
  const values = {};
  return new Proxy(values, {
    get(target, property) {
      if (property === "setProperty") return (name, value) => { target[name] = String(value); };
      if (property === "removeProperty") return (name) => { delete target[name]; };
      return target[property] ?? "";
    },
    set(target, property, value) {
      target[property] = String(value);
      return true;
    },
  });
}

const contextStrokes = [];

function fakeContext() {
  return new Proxy({}, {
    get(target, property) {
      if (property === "stroke") {
        return () => contextStrokes.push({ strokeStyle: target.strokeStyle });
      }
      if (!(property in target)) target[property] = () => {};
      return target[property];
    },
  });
}

function fakeNode(tag, ownerDocument) {
  const classes = new Set();
  const listeners = new Map();
  const node = {
    ownerDocument,
    tagName: String(tag).toUpperCase(),
    children: [],
    parentElement: undefined,
    parentNode: undefined,
    style: fakeStyle(),
    hidden: false,
    className: "",
    dataset: {},
    width: 0,
    height: 0,
    clientWidth: 160,
    clientHeight: 160,
    offsetWidth: 160,
    offsetHeight: 160,
    isConnected: true,
    value: "",
    disabled: false,
    get firstChild() { return node.children[0] ?? null; },
    get nextSibling() {
      const siblings = node.parentElement?.children ?? [];
      const index = siblings.indexOf(node);
      return index >= 0 ? siblings[index + 1] ?? null : null;
    },
    classList: {
      add(...names) { for (const name of names) classes.add(name); },
      remove(...names) { for (const name of names) classes.delete(name); },
      toggle(name, force) {
        if (force === undefined ? !classes.has(name) : force) classes.add(name);
        else classes.delete(name);
      },
      contains(name) { return classes.has(name); },
    },
    append(...children) {
      for (const child of children) {
        if (child.parentElement) child.parentElement.removeChild(child);
        child.parentElement = node;
        child.parentNode = node;
        node.children.push(child);
      }
    },
    replaceChildren(...children) {
      for (const child of [...node.children]) node.removeChild(child);
      node.append(...children);
    },
    insertBefore(child, before) {
      if (child.parentElement) child.parentElement.removeChild(child);
      const index = before == null ? -1 : node.children.indexOf(before);
      child.parentElement = node;
      child.parentNode = node;
      if (index < 0) node.children.push(child);
      else node.children.splice(index, 0, child);
    },
    removeChild(child) {
      const index = node.children.indexOf(child);
      if (index >= 0) node.children.splice(index, 1);
      if (child.parentElement === node) child.parentElement = undefined;
      if (child.parentNode === node) child.parentNode = undefined;
    },
    remove() { node.parentElement?.removeChild(node); },
    querySelector(selector) {
      if (selector === 'button[type="submit"]') return fakeNode("button", ownerDocument);
      return null;
    },
    querySelectorAll() { return []; },
    addEventListener(type, listener) {
      const entries = listeners.get(type) ?? [];
      entries.push(listener);
      listeners.set(type, entries);
    },
    removeEventListener(type, listener) {
      const entries = listeners.get(type) ?? [];
      const index = entries.indexOf(listener);
      if (index >= 0) entries.splice(index, 1);
    },
    dispatchEvent(event) {
      event.target ??= node;
      event.currentTarget = node;
      event.cancelBubble ??= false;
      event.stopPropagation ??= () => { event.cancelBubble = true; };
      for (const listener of [...(listeners.get(event.type) ?? [])]) listener.call(node, event);
      if (!event.cancelBubble) node.parentElement?.dispatchEvent(event);
      return true;
    },
    setAttribute(name, value) { node[name] = String(value); },
    getAttribute(name) { return node[name] ?? null; },
    removeAttribute(name) { delete node[name]; },
    getContext(kind) { return kind === "2d" ? fakeContext() : null; },
    getBoundingClientRect() {
      return {
        left: 0, top: 0, width: node.clientWidth, height: node.clientHeight,
        right: node.clientWidth, bottom: node.clientHeight,
      };
    },
  };
  return node;
}

const elements = new Map();
let document;
document = {
  createElement(tag) { return fakeNode(tag, document); },
  createElementNS(_namespace, tag) { return fakeNode(tag, document); },
  querySelectorAll() { return []; },
  getElementById(id) {
    let element = elements.get(id);
    if (!element) {
      element = fakeNode("div", document);
      element.id = id;
      elements.set(id, element);
    }
    return element;
  },
};
document.body = fakeNode("body", document);
document.head = fakeNode("head", document);
document.documentElement = fakeNode("html", document);

globalThis.document = document;
globalThis.location = { protocol: "http:", hostname: "localhost", origin: "http://localhost" };
globalThis.window = {
  devicePixelRatio: 2,
  innerWidth: 1024,
  innerHeight: 768,
  addEventListener() {},
  removeEventListener() {},
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
};
globalThis.localStorage = globalThis.window.localStorage;
globalThis.HTMLElement = class {};

const { game } = await import("../dist/code/browser/game/Context.js");
const {
  addMinimapPing, adoptMinimapCanvas, forgetMinimap, minimapSettings, minimapWidgetAdapter,
  updateMinimap,
} = await import("../dist/code/browser/ui/Minimap.js");

function styleSnapshot(canvas) {
  return Object.fromEntries([
    "display", "position", "left", "right", "top", "bottom", "width", "height", "transform",
    "transformOrigin", "zIndex", "opacity", "visibility", "pointerEvents",
  ].map((name) => [name, canvas.style[name] ?? ""]));
}

function nativeParts() {
  const root = document.getElementById("right-rail").children[0];
  const canvas = root.children.find((child) => child.id === "minimap-canvas");
  return { root, canvas };
}

function makeWorld({ position = { x: 0, y: 0, z: 0, orientation: 0 }, pingMinimap = () => {} } = {}) {
  return {
    mapId: 0,
    state: { selfGuid: 1n, objects: new Map([[1n, {
      guid: 1n,
      typeId: 4,
      position,
      fields: new Map(),
    }]]) },
    group: undefined,
    questPoi: new Map(),
    currentGameTime: () => undefined,
    pingMinimap,
  };
}

test("missing or detached minimap inputs are safe no-ops", () => {
  const preTarget = fakeNode("div", document);
  const preHost = fakeNode("div", document);
  preHost.append(preTarget);

  assert.equal(adoptMinimapCanvas(undefined), undefined);
  const detachedBeforeBuild = fakeNode("div", document);
  detachedBeforeBuild.isConnected = false;
  preHost.append(detachedBeforeBuild);
  assert.equal(adoptMinimapCanvas(detachedBeforeBuild), undefined, "detached targets do not materialize the minimap");

  // Mount can run before the first world tick; adoption materializes the same native parts once.
  const beforeUpdateCleanup = adoptMinimapCanvas(preTarget);
  assert.equal(typeof beforeUpdateCleanup, "function");
  const earlyCanvas = preTarget.children.find((child) => child.id === "minimap-canvas");
  assert.ok(earlyCanvas, "the existing native canvas is materialized for an early mount");
  beforeUpdateCleanup();

  game.world = makeWorld();
  updateMinimap(0);
  const { root, canvas } = nativeParts();
  assert.ok(canvas, "the native minimap canvas was built by the existing update pipeline");

  const detached = fakeNode("div", document);
  detached.isConnected = false;
  const detachedHost = fakeNode("div", document);
  detachedHost.append(detached);
  assert.equal(adoptMinimapCanvas(detached), undefined);
  assert.equal(canvas.parentElement, root);

  root.removeChild(canvas);
  assert.equal(adoptMinimapCanvas(preTarget), undefined, "a detached native canvas is unavailable");
  root.insertBefore(canvas, root.children[1] ?? null);
});

test("adoption reuses one canvas, follows FrameXML ancestors, and restores state exactly once", () => {
  const { root, canvas } = nativeParts();
  assert.ok(canvas);
  const previousWorld = game.world;
  const originalClientSize = [canvas.clientWidth, canvas.clientHeight];
  const originalOrder = [...root.children];
  canvas.className = "native-minimap";
  canvas.hidden = true;
  canvas.dataset.nativeState = "yes";
  canvas.style.position = "relative";
  canvas.style.left = "3px";
  canvas.style.top = "4px";
  canvas.style.width = "160px";
  canvas.style.height = "160px";
  canvas.style.transform = "rotate(2deg)";
  canvas.style.zIndex = "7";
  canvas.style.pointerEvents = "auto";
  canvas.width = 321;
  canvas.height = 123;
  const originalStyle = styleSnapshot(canvas);
  const originalDataset = { ...canvas.dataset };
  const originalClass = canvas.className;
  const originalHidden = canvas.hidden;
  const originalBacking = [canvas.width, canvas.height];

  const host = fakeNode("div", document);
  host.hidden = true;
  const target = fakeNode("div", document);
  target.style.position = "absolute";
  target.style.left = "12px";
  target.style.top = "24px";
  target.style.width = "140px";
  target.style.height = "140px";
  target.offsetWidth = 140;
  target.offsetHeight = 140;
  const authoredControl = fakeNode("button", document);
  target.append(authoredControl);
  host.append(target);

  let cleanup;
  try {
    cleanup = adoptMinimapCanvas(target);
    assert.equal(typeof cleanup, "function");
    assert.equal(canvas.parentElement, target, "the same native canvas is placed in the FrameXML slot");
    assert.deepEqual(target.children, [canvas, authoredControl], "stock controls remain above the map");
    assert.equal(canvas.hidden, false, "the canvas does not copy a blank child hidden bit");
    assert.equal(host.hidden, true, "the FrameXML ancestor remains the visibility owner");
    assert.equal(canvas.style.position, "absolute");
    assert.equal(canvas.style.left, "0px");
    assert.equal(canvas.style.top, "0px");
    assert.equal(canvas.style.width, "140px");
    assert.equal(canvas.style.height, "140px");
    assert.equal(canvas.style.zIndex, "0");
    assert.equal(canvas.style.pointerEvents, "auto",
      "the native canvas keeps Ctrl-click; propagation guards prevent a duplicate stock path");
    assert.equal(canvas.width, 280, "the existing DPR-capped resize path follows authored width");
    assert.equal(canvas.height, 280);
    assert.equal(adoptMinimapCanvas(target), cleanup, "re-adopting one target is idempotent");

    const targetEvents = { mousedown: 0, mouseup: 0, click: 0 };
    const rootEvents = { mousedown: 0, mouseup: 0, click: 0 };
    for (const type of Object.keys(targetEvents)) {
      target.addEventListener(type, () => { targetEvents[type]++; });
      root.addEventListener(type, () => { rootEvents[type]++; });
    }
    canvas.clientWidth = 140;
    canvas.clientHeight = 140;
    const calls = [];
    game.world = makeWorld({
      position: { x: 100, y: 200, z: 0, orientation: 0 },
      pingMinimap: (x, y) => calls.push({ x, y }),
    });
    canvas.dispatchEvent({ type: "mousedown" });
    canvas.dispatchEvent({ type: "mouseup" });
    canvas.dispatchEvent({ type: "click", ctrlKey: true, clientX: 70, clientY: 70 });
    assert.equal(canvas.style.pointerEvents, "auto");
    assert.deepEqual(targetEvents, { mousedown: 0, mouseup: 0, click: 0 },
      "adopted pointer events do not reach stock Minimap handlers");
    assert.deepEqual(rootEvents, { mousedown: 0, mouseup: 0, click: 0 },
      "the native Ctrl-click has no duplicate ancestor path");
    assert.equal(calls.length, 1, "stopPropagation leaves the native canvas click listener live");

    cleanup();
    cleanup();
    game.world = undefined;
    canvas.dispatchEvent({ type: "mousedown" });
    canvas.dispatchEvent({ type: "mouseup" });
    canvas.dispatchEvent({ type: "click", ctrlKey: true, clientX: 70, clientY: 70 });
    assert.deepEqual(rootEvents, { mousedown: 1, mouseup: 1, click: 1 },
      "cleanup removes all propagation guards");
    assert.equal(canvas.parentElement, root);
    assert.deepEqual(root.children, originalOrder, "native parent and sibling order are restored");
    assert.equal(canvas.className, originalClass);
    assert.equal(canvas.hidden, originalHidden);
    assert.deepEqual(canvas.dataset, originalDataset);
    assert.deepEqual(styleSnapshot(canvas), originalStyle);
    assert.deepEqual([canvas.width, canvas.height], originalBacking);
  } finally {
    cleanup?.();
    canvas.clientWidth = originalClientSize[0];
    canvas.clientHeight = originalClientSize[1];
    game.world = previousWorld;
  }
});

test("switching FrameXML slots restores native ownership before adopting the next target", () => {
  const { root, canvas } = nativeParts();
  const originalOrder = [...root.children];
  const hostA = fakeNode("div", document);
  const targetA = fakeNode("div", document);
  targetA.style.width = "120px";
  targetA.style.height = "120px";
  hostA.append(targetA);
  const hostB = fakeNode("div", document);
  const targetB = fakeNode("div", document);
  targetB.style.width = "180px";
  targetB.style.height = "180px";
  hostB.append(targetB);

  const cleanupA = adoptMinimapCanvas(targetA);
  assert.equal(canvas.parentElement, targetA);
  const cleanupB = adoptMinimapCanvas(targetB);
  assert.equal(canvas.parentElement, targetB);
  cleanupB?.();
  assert.equal(canvas.parentElement, root, "cleanup of the replacement restores the original root");
  assert.deepEqual(root.children, originalOrder, "replacement cleanup restores original sibling order");
  cleanupA?.();
});

test("adopted geometry tracks target changes in the existing update and ping projection", () => {
  const { canvas } = nativeParts();
  const previous = game.world;
  const host = fakeNode("div", document);
  const target = fakeNode("div", document);
  target.style.width = "140px";
  target.style.height = "140px";
  target.offsetWidth = 140;
  target.offsetHeight = 140;
  host.append(target);
  const cleanup = adoptMinimapCanvas(target);
  try {
    const calls = [];
    game.world = makeWorld({
      position: { x: 100, y: 200, z: 0, orientation: 0 },
      pingMinimap: (x, y) => calls.push({ x, y }),
    });
    // Keep this projection case at the stock middle (266-yard) view.
    minimapWidgetAdapter.setZoom(1);
    updateMinimap(performance.now());
    assert.equal(canvas.width, 280);

    target.style.width = "180px";
    target.style.height = "120px";
    target.offsetWidth = 180;
    target.offsetHeight = 120;
    updateMinimap(performance.now());
    assert.equal(canvas.style.width, "180px");
    assert.equal(canvas.style.height, "120px");
    assert.equal(canvas.width, 240, "the backing store follows the smaller changed target side at DPR 2");
    assert.equal(canvas.height, 240);

    minimapWidgetAdapter.pingLocation(0, 60);
    assert.equal(calls.length, 1);
    assert.ok(Math.abs(calls[0].x - 233) < 1e-9, "adapter projection uses the current 120px map size");
    assert.equal(calls[0].y, 200);
  } finally {
    game.world = previous;
    cleanup?.();
  }
});

test("optimistic local pings deduplicate only a matching immediate server echo", () => {
  const { canvas } = nativeParts();
  const previous = game.world;
  forgetMinimap();
  const host = fakeNode("div", document);
  const target = fakeNode("div", document);
  target.style.width = "140px";
  target.style.height = "140px";
  target.offsetWidth = 140;
  target.offsetHeight = 140;
  host.append(target);
  const cleanup = adoptMinimapCanvas(target);
  try {
    const calls = [];
    game.world = makeWorld({
      position: { x: 100, y: 200, z: 0, orientation: 0 },
      pingMinimap: (x, y) => calls.push({ x, y }),
    });
    // Stock index 1 is the middle 266-yard view; the adapter owns the direction conversion.
    minimapWidgetAdapter.setZoom(1);
    const drawPings = (now) => {
      const before = contextStrokes.length;
      updateMinimap(now);
      return contextStrokes.slice(before).filter(({ strokeStyle }) => String(strokeStyle).startsWith("rgba(")).length;
    };

    minimapWidgetAdapter.pingLocation(0, 0);
    assert.equal(drawPings(performance.now()), 1, "the optimistic marker is drawn");
    const local = calls.at(-1);
    addMinimapPing(local.x, local.y, performance.now());
    assert.equal(drawPings(performance.now()), 1, "an immediate matching echo does not add a second marker");

    addMinimapPing(local.x + 10, local.y, performance.now());
    assert.equal(drawPings(performance.now()), 2, "a distinct server ping remains visible");

    minimapWidgetAdapter.pingLocation(10, 0);
    const lateLocal = calls.at(-1);
    addMinimapPing(lateLocal.x, lateLocal.y, performance.now() + 2_000);
    assert.equal(drawPings(performance.now()), 4, "a matching late echo remains distinct");
  } finally {
    game.world = previous;
    cleanup?.();
  }
});

test("the FrameXML adapter preserves stock zoom direction and ignores invalid or duplicate writes", () => {
  const original = minimapWidgetAdapter.getZoom();
  assert.equal(minimapWidgetAdapter.getZoomLevels(), 5);
  // WoW's Minimap:GetZoom() is a distance index: stock ZoomInClick increments it.  The native
  // canvas stores the same levels as yards across the circle, so its array is intentionally the
  // opposite direction (index 0 is the nearest/100-yard view).
  const stockToYards = [400, 266, 200, 133, 100];
  assert.deepEqual(stockToYards[original], minimapSettings().zoom);

  for (const [index, value] of stockToYards.entries()) {
    minimapWidgetAdapter.setZoom(index);
    assert.equal(minimapWidgetAdapter.getZoom(), index);
    assert.equal(minimapSettings().zoom, value, `${index} maps to ${value} yards`);
  }
  const unchanged = minimapSettings();
  minimapWidgetAdapter.setZoom(4);
  assert.equal(minimapSettings(), unchanged, "setting the active index is a no-op");

  minimapWidgetAdapter.setZoom(4.9);
  assert.equal(minimapWidgetAdapter.getZoom(), 4, "fractional levels truncate and clamp");
  assert.equal(minimapSettings().zoom, 100);
  minimapWidgetAdapter.setZoom(-10);
  assert.equal(minimapWidgetAdapter.getZoom(), 0);
  assert.equal(minimapSettings().zoom, 400);
  minimapWidgetAdapter.setZoom(Number.NaN);
  assert.equal(minimapWidgetAdapter.getZoom(), 0, "non-finite zoom does not mutate settings");
  minimapWidgetAdapter.setZoom(original);
});

test("native plus/minus controls agree with the stock adapter direction", () => {
  const previous = game.world;
  try {
    game.world = makeWorld();
    updateMinimap(performance.now());
    const { root } = nativeParts();
    const controls = root.children.find((child) => child.className === "minimap-controls");
    assert.ok(controls, "native minimap controls are mounted");
    const [out, into] = controls.children;
    assert.ok(out && into, "native minimap has both zoom controls");

    minimapWidgetAdapter.setZoom(2);
    assert.equal(minimapSettings().zoom, 200);
    into.dispatchEvent({ type: "click" });
    assert.equal(minimapSettings().zoom, 133, "+ narrows the visible yard range");
    assert.equal(minimapWidgetAdapter.getZoom(), 3, "+ increments stock Minimap:GetZoom()");

    out.dispatchEvent({ type: "click" });
    assert.equal(minimapSettings().zoom, 200, "− widens the visible yard range");
    assert.equal(minimapWidgetAdapter.getZoom(), 2, "− decrements stock Minimap:GetZoom()");
  } finally {
    game.world = previous;
  }
});

test("the FrameXML adapter projects one local ping through the current minimap geometry", () => {
  const calls = [];
  const previous = game.world;
  const host = fakeNode("div", document);
  const target = fakeNode("div", document);
  target.style.width = "140px";
  target.style.height = "140px";
  target.offsetWidth = 140;
  target.offsetHeight = 140;
  host.append(target);
  const cleanup = adoptMinimapCanvas(target);
  try {
    const position = { x: 100, y: 200, z: 0, orientation: 0 };
    game.world = makeWorld({ position, pingMinimap: (x, y) => calls.push({ x, y }) });
    // Stock index 1 is the middle 266-yard view; the adapter owns the direction conversion.
    minimapWidgetAdapter.setZoom(1);
    minimapWidgetAdapter.pingLocation(20, -20);
    assert.equal(calls.length, 1, "stock Minimap OnMouseUp reaches one live ping path");
    assert.deepEqual(calls[0], { x: 62, y: 162 },
      "stock local Y is positive upward and is inverted for the map's down-growing row");

    game.world = undefined;
    minimapWidgetAdapter.pingLocation(20, -20);
    minimapWidgetAdapter.pingLocation(Number.NaN, 0);
    assert.equal(calls.length, 1, "missing world and invalid points are no-ops");
  } finally {
    game.world = previous;
    cleanup?.();
  }
});
