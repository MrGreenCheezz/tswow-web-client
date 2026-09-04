import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * The loader: what a module ships, in what order it is switched on, and what is left behind when it
 * is switched off.
 *
 * Drawn against the same fake document `window-render.test.mjs` builds, so that the windows here go
 * through the *real* renderer — the element id a rebuilt window comes back under is the whole of
 * the hot-reload claim, and a fake render would have asserted it about itself.
 */
function fakeDocument() {
  const make = (tag) => {
    const style = new Proxy({ setProperty(name, value) { this[name] = value; }, removeProperty(name) { delete this[name]; } }, {});
    const node = {
      tagName: tag.toUpperCase(),
      children: [],
      parent: undefined,
      dataset: {},
      style,
      className: "",
      hidden: false,
      textContent: "",
      value: "",
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
    return node;
  };
  return { createElement: make, body: make("body") };
}

globalThis.document = fakeDocument();
const { usePanelHost } = await import("../dist/code/browser/ui/Widgets.js");
usePanelHost({
  viewport: document.createElement("div"),
  attach: () => {},
  detach: () => {},
});

const { CustomPacketRegistry } = await import("../dist/code/world/CustomPacketRegistry.js");
const { clearWorldContext, game } = await import("../dist/code/browser/game/Context.js");
const { ModuleLoader, prefixModuleCss } = await import("../dist/code/browser/ui/ModuleLoader.js");
const { WindowRegistry } = await import("../dist/code/browser/ui/WindowRegistry.js");
const { renderWindow, windowElementId } = await import("../dist/code/browser/ui/WindowRender.js");

/* ---------------------------------------------------------------------------------------------
 * Fixtures
 * ------------------------------------------------------------------------------------------- */

const shopState = {
  name: "shop.State",
  opcode: 4001,
  direction: "in",
  fields: [{ name: "gold", type: "u32" }],
};

const anchor = (point = "TOPLEFT") => ({ point, relativeTo: "parent", relativePoint: point, x: 0, y: 0 });

/** One window definition, with whatever a test wants to change about it. */
function windowFile(id, params = {}, children = []) {
  return {
    kind: "addon",
    id,
    name: { ru: id, en: "" },
    enabled: true,
    params: {
      screen: {
        id: "root",
        type: "Frame",
        name: "Root",
        width: 200,
        height: 100,
        anchor: anchor("CENTER"),
        children,
        events: [],
      },
      ...params,
    },
  };
}

/**
 * A gateway answering a fixed table of paths, counting what was asked for.
 *
 * The table is mutable, so a test can save a file between two polls and watch what the loader does
 * about it — which is the only way to check hot reload without a clock and a disk.
 */
function fakeGateway(routes) {
  const asked = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    asked.push(path);
    const answer = routes[path];
    if (answer === undefined) return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
    if (answer instanceof Error) throw answer;
    return {
      ok: true,
      status: 200,
      json: async () => answer,
      text: async () => (typeof answer === "string" ? answer : JSON.stringify(answer)),
    };
  };
  return { asked, routes, restore: () => { globalThis.fetch = original; } };
}

/** An index entry, with `messages`, `windows` and `css` all optional exactly as the gateway sends. */
const entry = (module, kinds) => ({
  module,
  ...Object.fromEntries(Object.entries(kinds).map(([key, files]) => [
    key,
    files.map((one) => ({
      file: one.file, source: one.source ?? "module", sha1: one.sha1 ?? "sha-1", mtimeMs: 1, bytes: 10,
    })),
  ])),
});

const index = (...entries) => ({ modules: entries });

/** A loader wired to real registries and to lists that record what it asked the client to do. */
function loaderFor(options = {}) {
  const packets = new CustomPacketRegistry();
  const windows = new WindowRegistry();
  const commands = new Map();
  const bindings = new Map();
  const styles = new Map();
  const timers = [];
  const loader = new ModuleLoader("ws://127.0.0.1:8090/auth", {
    packets,
    windows,
    render: (definition) => renderWindow(definition, {}),
    addCommand: (command) => {
      if (commands.has(command.name)) return `/${command.name} уже занята`;
      commands.set(command.name, command);
      return undefined;
    },
    removeCommands: (module) => {
      for (const [name, command] of [...commands]) if (command.module === module) commands.delete(name);
    },
    addBinding: (binding) => bindings.set(binding.action, binding),
    removeBindings: (module) => {
      for (const [action, binding] of [...bindings]) if (binding.module === module) bindings.delete(action);
    },
    setStyle: (module, css) => { if (css) styles.set(module, css); else styles.delete(module); },
    soundKits: new Set(["questAdded"]),
    schedule: (run, ms) => {
      const timer = { run, ms, stopped: false };
      timers.push(timer);
      return () => { timer.stopped = true; };
    },
    ...options,
  });
  return { loader, packets, windows, commands, bindings, styles, timers };
}

/* ---------------------------------------------------------------------------------------------
 * Message schemas — what М3 loaded, still loading
 * ------------------------------------------------------------------------------------------- */

test("the loader registers every module's schemas and unloading leaves the registry as it was", async () => {
  const bankState = { ...shopState, name: "bank.State", opcode: 4002 };
  const gateway = fakeGateway({
    "/modules/index": index(
      entry("shop", { messages: [{ file: "shop.json" }] }),
      entry("bank", { messages: [{ file: "bank.json", source: "draft" }] }),
    ),
    "/modules/messages/shop/shop.json": { messages: [shopState] },
    "/modules/messages/bank/bank.json": { messages: [bankState] },
  });
  const { loader, packets } = loaderFor();
  try {
    const status = [];
    loader.onStatus = (message, error) => status.push({ message, error });
    // Two calls, one load: the second joins the first rather than fetching everything twice.
    await Promise.all([loader.load(), loader.load()]);

    assert.deepEqual(gateway.asked, [
      "/modules/index", "/modules/messages/shop/shop.json", "/modules/messages/bank/bank.json",
    ]);
    assert.deepEqual(packets.modules(), ["shop", "bank"]);
    assert.equal(loader.messageCount, 2);
    assert.deepEqual([...loader.problems], []);
    assert.deepEqual(status, [{ message: "модули: сообщений 2", error: false }]);
    assert.equal(loader.files[1].source, "draft", "the index says which root answered");

    loader.unload();
    assert.deepEqual(packets.modules(), []);
    assert.deepEqual(packets.messages(), []);
    assert.deepEqual(loader.files, []);
  } finally {
    gateway.restore();
  }
});

test("one bad file is one bad file: the rest of the load lands and the problems name their file", async () => {
  const gateway = fakeGateway({
    "/modules/index": index(
      entry("broken", { messages: [{ file: "broken.json" }] }),
      entry("clash", { messages: [{ file: "clash.json" }] }),
      entry("shop", { messages: [{ file: "shop.json" }] }),
    ),
    // Not a message list at all.
    "/modules/messages/broken/broken.json": { windows: [] },
    // `clash` loads first, so it takes 4001 and `shop` is the one refused. Both names are in the
    // sentence either way.
    "/modules/messages/clash/clash.json": { messages: [{ ...shopState, name: "clash.State" }] },
    "/modules/messages/shop/shop.json": { messages: [shopState] },
  });
  const { loader, packets } = loaderFor();
  try {
    const status = [];
    loader.onStatus = (message, error) => status.push({ message, error });
    await loader.load();

    assert.deepEqual(packets.modules(), ["clash"]);
    assert.equal(loader.messageCount, 1);
    assert.deepEqual([...loader.problems], [
      'broken/broken.json: expected {"messages": [...]} or a bare array of messages',
      'shop/shop.json: module "shop": shop.State wants opcode 4001, which module "clash" already'
        + " claims for clash.State; a custom opcode may only be claimed once",
    ]);
    assert.deepEqual(status, [{ message: "модули: сообщений 1, ошибок 2", error: true }]);
  } finally {
    gateway.restore();
  }
});

test("a gateway with no module route leaves the client exactly as it was", async () => {
  const gateway = fakeGateway({});
  const { loader, packets } = loaderFor();
  try {
    const status = [];
    loader.onStatus = (message, error) => status.push({ message, error });
    let loaded = 0;
    loader.onLoaded = () => loaded++;
    await loader.load();

    assert.deepEqual(status, [{ message: "модули: шлюз ответил 404", error: true }]);
    assert.equal(loaded, 0, "nothing loaded, so nothing announces that it did");
    assert.deepEqual(packets.messages(), []);
  } finally {
    gateway.restore();
  }
});

/* ---------------------------------------------------------------------------------------------
 * Windows
 * ------------------------------------------------------------------------------------------- */

test("a module's window is drawn, registered, and brings its command, its key and its schemas", async () => {
  const gateway = fakeGateway({
    "/modules/index": index(entry("shop", { windows: [{ file: "shop.json" }] })),
    "/modules/ui/shop/shop.json": windowFile("shop-screen", {
      slash: "shop",
      binding: "Лавка",
      messages: { messages: [{ ...shopState, name: "shop.Inline", opcode: 4100 }] },
    }),
  });
  const { loader, packets, windows, commands, bindings } = loaderFor();
  try {
    await loader.load();
    assert.deepEqual([...loader.problems], []);
    assert.equal(windows.size, 1);
    assert.equal(windows.window("shop-screen").module, "shop");

    // The slash command is offered under the name the file wrote, lowercased by the parser.
    assert.deepEqual([...commands.keys()], ["shop"]);
    commands.get("shop").run("");
    assert.equal(windows.window("shop-screen").visible(), false, "the command toggles its window");

    // The key is offered and is **unbound**: a definition file names a key it would like, and the
    // player is the one who decides whether it gets one.
    assert.deepEqual([...bindings.keys()], ["module:shop:Лавка"]);
    assert.equal(bindings.get("module:shop:Лавка").group, "Модули");

    // The inline schema is owned by the window rather than by the module, so that reloading this
    // one file takes back exactly what this file declared.
    assert.deepEqual(packets.modules(), ["shop/shop-screen"]);
    assert.equal(loader.messageCount, 1);

    loader.unload();
    assert.equal(windows.size, 0);
    assert.deepEqual(packets.modules(), []);
    assert.deepEqual([...commands.keys()], []);
    assert.deepEqual([...bindings.keys()], []);
  } finally {
    gateway.restore();
  }
});

test("two modules that call their screen the same thing are refused by name, and the first one keeps it", async () => {
  const gateway = fakeGateway({
    "/modules/index": index(
      entry("shop", { windows: [{ file: "screen.json" }] }),
      entry("bank", { windows: [{ file: "screen.json" }] }),
    ),
    "/modules/ui/shop/screen.json": windowFile("screen"),
    "/modules/ui/bank/screen.json": windowFile("screen"),
  });
  const { loader, windows } = loaderFor();
  try {
    await loader.load();
    assert.equal(windows.size, 1);
    assert.equal(windows.window("screen").module, "shop", "the first one registered keeps the id");
    assert.equal(loader.problems.length, 1);
    // Both names, because the author of the second is very often not the author of the first.
    assert.ok(loader.problems[0].includes("«shop»"), loader.problems[0]);
    assert.ok(loader.problems[0].includes("«bank»"), loader.problems[0]);
  } finally {
    gateway.restore();
  }
});

test("Ж0 entering the world a second time in one tab registers the same window, not a duplicate", async () => {
  // Measured before this: the second login in one tab gave 0 windows and the refusal «окно
  // "proverochnyy-ekran" уже зарегистрировано модулем «test»», while `/testUI` went on toggling
  // the first session's handle. `enterWorld` builds a fresh loader and overwrites `game.modules`,
  // so nothing ever took the previous session's windows out of the registry — `clearWorldContext`
  // is what does that, and it had no caller anywhere in `src/`.
  const gateway = fakeGateway({
    "/modules/index": index(entry("test", { windows: [{ file: "proverochnyy-ekran.json" }] })),
    "/modules/ui/test/proverochnyy-ekran.json": windowFile("proverochnyy-ekran"),
  });
  const registry = new WindowRegistry();
  try {
    const first = loaderFor({ windows: registry }).loader;
    await first.load();
    assert.equal(registry.size, 1);
    assert.deepEqual([...first.problems], []);

    // What a second login did without the unload: the id is taken, by a loader nobody can reach.
    const clash = loaderFor({ windows: registry }).loader;
    await clash.load();
    assert.equal(registry.size, 1);
    assert.equal(clash.problems.length, 1);
    assert.ok(clash.problems[0].includes("уже зарегистрировано"), clash.problems[0]);

    // And what leaving the world does with it, through the real function rather than a hand-rolled
    // unload: `clearWorldContext` takes the previous session's windows out of the registry, so the
    // window comes back under its own id with nothing to complain about.
    game.modules = first;
    clearWorldContext();
    assert.equal(game.modules, undefined, "and the loader itself goes with the session");
    clash.unload();
    const second = loaderFor({ windows: registry }).loader;
    await second.load();
    assert.equal(registry.size, 1, "one window, once");
    assert.deepEqual([...second.problems], [], "and nothing refused");
    assert.equal(registry.window("proverochnyy-ekran").module, "test");
  } finally {
    gateway.restore();
  }
});

test("Ж0 every way out of a world drops what the realm owned", async () => {
  // The mechanism above is only worth having if somebody calls it, and for the whole life of
  // `clearWorldContext` nobody did — a grep over `src/`, `tests/`, `tools/` and `index.html` found
  // the definition and one comment. Every way out goes through `Login.ts`.
  //
  // There were two of them when this pin was written (changing realm, signing in as somebody
  // else); G6 added three more — a completed logout, a lost connection and a failed enter — and
  // moved the list into `resetWorldUi`, because five hand-copied halves would have been five
  // chances to forget the module loader. So the call is counted once, in the one function, and
  // what is pinned instead is that every exit reaches it.
  const source = await readFile(new URL("../src/browser/app/Login.ts", import.meta.url), "utf8");
  assert.equal((source.match(/\bclearWorldContext\(\)/g) ?? []).length, 1,
    "the drop belongs to one function, so no exit can carry half of it");
  assert.match(source, /export function resetWorldUi\(\): void \{[\s\S]{0,200}?clearWorldContext\(\);/,
    "…and that function is resetWorldUi");
  assert.equal((source.match(/^\s*resetWorldUi\(\);$/gm) ?? []).length, 3,
    "the login form, connectRealm and leaveWorld — the three roads out of a world");
  // And the list of what that is stays in one place: a hand-copied half of it is what this
  // replaced, and the half that was missing was the module loader.
  for (const half of ["game.creatureMetadata = undefined", "game.spells.clear()"]) {
    assert.equal(source.includes(half), false, `Login.ts is keeping its own copy of the list: ${half}`);
  }
});

test("Ж0 a picture a window could not fetch is a problem the «Окна» pane can print", () => {
  // `setIconSource` turned a failed fetch into an `error` event nobody listened for, so a window
  // whose every picture was a 400 reported nothing at all — `loader.problems` was `[]` in the same
  // run that made two of them. The ring is deduplicated because a window is rebuilt whenever it is
  // re-registered or re-skinned, and sixteen copies of one sentence would push everything else out.
  const { loader } = loaderFor();
  const missing = "test/proverochnyy-ekran: картинка «Interface\\CharacterFrame\\TemporaryPortrait» не загрузилась (HTTP 404)";
  loader.noteTextureProblem(missing);
  loader.noteTextureProblem(missing);
  assert.deepEqual([...loader.problems], [missing], "the same picture, once");
  loader.noteTextureProblem(`${missing} — и фон тоже`);
  assert.equal(loader.problems.length, 2);
  loader.unload();
  assert.deepEqual([...loader.problems], [], "and a session that ended takes its complaints with it");
});

test("a definition the schema refuses is skipped and the rest of the module still loads", async () => {
  const gateway = fakeGateway({
    "/modules/index": index(entry("shop", { windows: [{ file: "bad.json" }, { file: "good.json" }] })),
    // `kind` is neither of the two words a `content/ui/` file may carry, which is the schema's
    // first refusal. Not "patch": that is the other real kind (М7) and goes to the other parser.
    "/modules/ui/shop/bad.json": { ...windowFile("bad"), kind: "screen" },
    "/modules/ui/shop/good.json": windowFile("good"),
  });
  const { loader, windows } = loaderFor();
  try {
    await loader.load();
    assert.deepEqual(windows.list().map((window) => window.id), ["good"]);
    assert.equal(loader.problems.length, 1);
    assert.ok(loader.problems[0].includes('"kind" is "screen"'), loader.problems[0]);
  } finally {
    gateway.restore();
  }
});

test("a module's own message file beats the same opcode written inline into one of its screens", async () => {
  // The one place the load order is load-bearing: an opcode may be claimed once, and a screen may
  // declare schemas inline. Messages are loaded before windows, so `content/messages/*.json` wins
  // — which is the way round a module author would guess, and the refusal names both claimants.
  const gateway = fakeGateway({
    "/modules/index": index(entry("shop", {
      messages: [{ file: "shop.json" }],
      windows: [{ file: "screen.json" }],
    })),
    "/modules/messages/shop/shop.json": { messages: [shopState] },
    "/modules/ui/shop/screen.json": windowFile("shop-screen", {
      messages: { messages: [{ ...shopState, name: "shop.Inline" }] },
    }),
  });
  const { loader, packets } = loaderFor();
  try {
    await loader.load();
    assert.deepEqual(packets.messages().map((message) => message.name), ["shop.State"]);
    assert.equal(loader.problems.length, 1);
    assert.ok(loader.problems[0].includes("shop.Inline"), loader.problems[0]);
    assert.ok(loader.problems[0].includes("shop.State"), loader.problems[0]);
  } finally {
    gateway.restore();
  }
});

test("a window whose button opens a screen nobody defines says so when the file loads", async () => {
  const gateway = fakeGateway({
    "/modules/index": index(entry("shop", { windows: [{ file: "shop.json" }] })),
    "/modules/ui/shop/shop.json": windowFile("shop-screen", {}, [{
      id: "press", type: "Button", width: 60, height: 20, text: { ru: "Банк", en: "" },
      actions: [{ do: "open", window: "bank-screen" }],
      anchor: anchor(),
    }]),
  });
  const { loader } = loaderFor();
  try {
    await loader.load();
    assert.equal(loader.problems.length, 1);
    assert.ok(loader.problems[0].includes('"bank-screen"'), loader.problems[0]);
  } finally {
    gateway.restore();
  }
});

/* ---------------------------------------------------------------------------------------------
 * Hot reload
 * ------------------------------------------------------------------------------------------- */

test("an unchanged sha1 rebuilds nothing, and a changed one rebuilds that window and nothing else", async () => {
  const gateway = fakeGateway({
    "/modules/index": index(entry("shop", {
      windows: [{ file: "one.json", sha1: "aaa" }, { file: "two.json", sha1: "bbb" }],
    })),
    "/modules/ui/shop/one.json": windowFile("one"),
    "/modules/ui/shop/two.json": windowFile("two"),
  });
  const { loader, windows } = loaderFor();
  try {
    await loader.load();
    const firstOne = windows.window("one");
    const firstTwo = windows.window("two");
    assert.equal(gateway.asked.length, 3);

    // A poll that finds every hash where it left it costs one round trip and touches nothing: this
    // is what makes a two-second timer affordable while somebody is editing.
    await loader.poll();
    assert.deepEqual(gateway.asked.slice(3), ["/modules/index"]);
    assert.equal(windows.window("one"), firstOne, "an unchanged file is not rebuilt");
    assert.equal(windows.window("two"), firstTwo);

    // Now one file is saved. Only that one is fetched, and only that window is rebuilt.
    gateway.routes["/modules/index"] = index(entry("shop", {
      windows: [{ file: "one.json", sha1: "aaa" }, { file: "two.json", sha1: "ccc" }],
    }));
    gateway.routes["/modules/ui/shop/two.json"] = windowFile("two", {}, [
      { id: "added", type: "Text", width: 40, height: 12, text: { ru: "новое", en: "" }, anchor: anchor() },
    ]);
    await loader.poll();
    assert.deepEqual(gateway.asked.slice(4), ["/modules/index", "/modules/ui/shop/two.json"]);
    assert.equal(windows.window("one"), firstOne, "the sibling is left standing");
    assert.notEqual(windows.window("two"), firstTwo, "and the changed one is a new window");
    assert.equal(windows.window("two").definition.screen.children.length, 1, "with the edit in it");

    // The whole point of a rebuild rather than a reload: `GameWindowManager` remembers a window's
    // place by element id, so the new one comes back where the player dragged the old one.
    assert.equal(windows.window("two").element.id, firstTwo.element.id);
    assert.equal(windows.window("two").element.id, windowElementId("shop", "two"));
  } finally {
    gateway.restore();
  }
});

test("a file that is fixed and saved takes its own complaint off the screen", async () => {
  const gateway = fakeGateway({
    "/modules/index": index(entry("shop", { windows: [{ file: "shop.json", sha1: "aaa" }] })),
    "/modules/ui/shop/shop.json": { ...windowFile("shop-screen"), kind: "patch" },
  });
  const { loader, windows } = loaderFor();
  try {
    await loader.load();
    assert.equal(loader.problems.length, 1);
    assert.equal(windows.size, 0);

    gateway.routes["/modules/index"] = index(entry("shop", { windows: [{ file: "shop.json", sha1: "bbb" }] }));
    gateway.routes["/modules/ui/shop/shop.json"] = windowFile("shop-screen");
    await loader.poll();
    assert.deepEqual([...loader.problems], [], "the complaint belonged to the file, not to the session");
    assert.equal(windows.size, 1);
  } finally {
    gateway.restore();
  }
});

test("a file that disappears from the index is taken back, window, command and key together", async () => {
  const gateway = fakeGateway({
    "/modules/index": index(entry("shop", { windows: [{ file: "shop.json" }] })),
    "/modules/ui/shop/shop.json": windowFile("shop-screen", { slash: "shop", binding: "Лавка" }),
  });
  const { loader, windows, commands, bindings } = loaderFor();
  try {
    await loader.load();
    assert.equal(windows.size, 1);

    gateway.routes["/modules/index"] = index(entry("shop", { windows: [] }));
    await loader.poll();
    assert.equal(windows.size, 0);
    assert.deepEqual([...commands.keys()], []);
    assert.deepEqual([...bindings.keys()], []);
  } finally {
    gateway.restore();
  }
});

test("a file the gateway refused once is asked for again on the next poll", async () => {
  // The index lists the file and the route does not answer it: a gateway restarted mid-load, or one
  // 500. The sha1 is what decides whether the next poll bothers, and the hash on disk will never
  // move again — so recording it here left that window missing, with its red line, for the whole
  // session.
  const gateway = fakeGateway({
    "/modules/index": index(entry("shop", { windows: [{ file: "shop.json", sha1: "aaa" }] })),
  });
  const { loader, windows } = loaderFor();
  try {
    await loader.load();
    assert.equal(windows.size, 0);
    assert.equal(loader.problems.length, 1);
    assert.ok(loader.problems[0].includes("404"), loader.problems[0]);

    gateway.routes["/modules/ui/shop/shop.json"] = windowFile("shop-screen");
    await loader.poll();
    assert.equal(windows.size, 1, "the same unchanged sha1 has to be tried again after a refusal");
    assert.deepEqual([...loader.problems], [], "and the complaint goes with the file that caused it");

    // Once it has landed, the unchanged hash costs one round trip and nothing else, exactly as
    // before: a file that failed is retried, a file that loaded is not.
    const asked = gateway.asked.length;
    await loader.poll();
    assert.equal(gateway.asked.length, asked + 1);
  } finally {
    gateway.restore();
  }
});

test("a load still in flight when the world is left registers nothing, and the next login is clean", async () => {
  // `unload()` is synchronous and a round is a chain of fetches, so a logout can land in the middle
  // of one. The round then went on to register its window, its schemas and its slash command into
  // registries the loader had already let go of — an orphan nothing could take back, repainted
  // every frame, and every module window of the next login refused as a duplicate of it.
  const routes = {
    "/modules/index": index(entry("shop", { windows: [{ file: "shop.json" }] })),
    "/modules/ui/shop/shop.json": windowFile("shop-screen", {
      slash: "shop", binding: "Лавка", messages: { messages: [shopState] },
    }),
  };
  let release = () => {};
  let reached = () => {};
  const held = new Promise((resolve) => { release = resolve; });
  const asking = new Promise((resolve) => { reached = resolve; });
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    // Only the window file waits, so the round is stopped exactly where a definition is in flight.
    if (path === "/modules/ui/shop/shop.json") {
      reached();
      await held;
    }
    const answer = routes[path];
    return { ok: true, status: 200, json: async () => answer, text: async () => JSON.stringify(answer) };
  };
  const { loader, packets, windows, commands, bindings } = loaderFor();
  try {
    const round = loader.load();
    await asking;
    loader.unload();
    // The next login, started while the abandoned round is still in flight. A `load()` that joined
    // it would return the moment that round gave up, with nothing loaded and no error to show for
    // it — which is what the client does on a reconnect.
    const again = loader.load();
    release();
    await Promise.all([round, again]);

    assert.equal(windows.size, 1, "the next login has to be a load of its own, not the old one's promise");
    assert.deepEqual([...commands.keys()], ["shop"]);
    assert.deepEqual(packets.modules(), ["shop/shop-screen"]);
    assert.deepEqual([...loader.problems], [], "and nothing was registered twice on the way");
    assert.equal(loader.windows.length, 1);

    // What the abandoned round left behind is nothing at all: one window, one command, one key.
    assert.deepEqual([...bindings.keys()], ["module:shop:Лавка"]);

    // And unloading the second load takes back exactly what it registered, with nothing left over
    // from the first: a window the abandoned round had registered would still be on screen here.
    loader.unload();
    assert.equal(windows.size, 0);
    assert.deepEqual(packets.modules(), []);
    assert.deepEqual([...commands.keys()], []);
    assert.deepEqual([...bindings.keys()], []);
    assert.deepEqual(loader.windows, []);
    assert.deepEqual([...loader.problems], []);
  } finally {
    globalThis.fetch = original;
  }
});

test("the poll runs on a timer only while something is watching, and unloading stops it", async () => {
  const gateway = fakeGateway({ "/modules/index": index() });
  const { loader, timers } = loaderFor();
  try {
    await loader.load();
    assert.equal(loader.watching, false, "nothing is looking, so nothing is polled");
    loader.watch(true);
    assert.equal(loader.watching, true);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, 2000);
    // Asking twice must not start a second timer, or closing the pane once would leave one running.
    loader.watch(true);
    assert.equal(timers.length, 1);

    loader.unload();
    assert.equal(loader.watching, false);
    assert.equal(timers[0].stopped, true, "a timer left running would poll a gateway nobody is reading");
  } finally {
    gateway.restore();
  }
});

/* ---------------------------------------------------------------------------------------------
 * Stylesheets
 * ------------------------------------------------------------------------------------------- */

test("a module stylesheet is scoped to the module, so body { display: none } cannot escape", () => {
  const scoped = prefixModuleCss("body { display: none } .row, .cell { color: red }", "shop");
  assert.equal(scoped.rules, 2);
  assert.ok(scoped.css.includes('[data-module="shop"] body {'),
    "the rule is kept and made unreachable rather than dropped: nothing is inside a window's body");
  // A type selector gets the descendant form and nothing else. `[data-module="shop"]body` is a CSS
  // parse error — the type has to come first in a compound — and one of those in a selector list
  // takes the whole rule down with it, which would hand `display: none` to whatever came after.
  assert.ok(!scoped.css.includes('[data-module="shop"]body'), scoped.css);
  // Two selectors, each prefixed twice: under the mark, and attached to it. Prefixing only the
  // first would let `.cell` reach the whole page; leaving out the attached form would mean a module
  // could style everything inside its own window except the window (М7).
  assert.ok(scoped.css.includes(
    '[data-module="shop"] .row, [data-module="shop"].row,'
    + ' [data-module="shop"] .cell, [data-module="shop"].cell {'), scoped.css);
  assert.deepEqual([...scoped.problems], []);
});

test("@media is recursed into, @keyframes is copied through, and @import is dropped with a word", () => {
  const scoped = prefixModuleCss(
    "@import url('http://example.invalid/x.css');\n"
    + "@media (max-width: 600px) { .row { color: red } }\n"
    + "@keyframes pulse { 0% { opacity: 0 } 100% { opacity: 1 } }\n"
    + "@font-face { font-family: X; src: url(x.ttf) }\n",
    "shop",
  );
  assert.equal(scoped.rules, 1, "only the rule inside @media is a rule");
  assert.ok(scoped.css.includes(
    '@media (max-width: 600px) {\n[data-module="shop"] .row, [data-module="shop"].row {'), scoped.css);
  // The percentages inside @keyframes are not selectors: prefixing `50%` would quietly break every
  // animation a module ships, and the breakage would look like a bug in the module.
  assert.ok(scoped.css.includes("@keyframes pulse { 0% { opacity: 0 } 100% { opacity: 1 } }"), scoped.css);
  assert.ok(scoped.css.includes("@font-face {"), scoped.css);
  assert.ok(!scoped.css.includes("@import"), "an @import would fetch a stylesheet nothing here scopes");
  assert.equal(scoped.problems.length, 1);
  assert.ok(scoped.problems[0].includes("@import"), scoped.problems[0]);
});

test("a comment, a quoted brace and a selector with a comma inside brackets survive the prefixer", () => {
  const scoped = prefixModuleCss(
    "/* a } inside a comment */ .a[title=\"x, y}\"] , .b:not(.c, .d) { content: \"}\" }",
    "shop",
  );
  assert.equal(scoped.rules, 1);
  assert.ok(scoped.css.includes(
    '[data-module="shop"] .a[title="x, y}"], [data-module="shop"].a[title="x, y}"],'
    + ' [data-module="shop"] .b:not(.c, .d), [data-module="shop"].b:not(.c, .d)'), scoped.css);
  assert.ok(scoped.css.includes('content: "}"'), scoped.css);
});

test("@scope and any at-rule this client cannot scope are dropped rather than let through", () => {
  // The whole security argument for allowing module CSS is that every selector is prefixed, and
  // `@scope` holds ordinary selectors. An at-rule the prefixer had not been taught used to be
  // copied through verbatim with a note, which handed a module `body { display: none }` — the one
  // rule the prefix exists to make unreachable — in any browser that implements it.
  const scoped = prefixModuleCss("@scope (:root) { body { display: none } }", "shop");
  assert.equal(scoped.rules, 1);
  assert.ok(scoped.css.includes('[data-module="shop"] body'), scoped.css);
  assert.deepEqual([...scoped.problems], []);

  const unknown = prefixModuleCss("@nonsense (x) { body { display: none } }\n.row { color: red }", "shop");
  assert.ok(!unknown.css.includes("body"), unknown.css);
  assert.ok(unknown.css.includes('[data-module="shop"] .row'), "and the rest of the file still loads");
  assert.equal(unknown.problems.length, 1);
  assert.ok(unknown.problems[0].includes("@nonsense"), unknown.problems[0]);
});

test("a window's own stylesheet is replaced on a reload and taken away with the file", async () => {
  // `params.css` is listed under a name no index can hold — `<окно>.inline` — so the ordinary drop
  // never reaches it. Without a drop of its own the rules were appended to the module's `<style>`
  // again on every save, which on a two-second poll is once every two seconds for as long as
  // somebody is editing; and deleting the file left them on the page.
  const gateway = fakeGateway({
    "/modules/index": index(entry("shop", { windows: [{ file: "shop.json", sha1: "aaa" }] })),
    "/modules/ui/shop/shop.json": windowFile("shop-screen", { css: ".panel { color: red }" }),
  });
  const { loader, styles } = loaderFor();
  // Counted by declarations rather than by prefixes: one rule now carries two selectors, the
  // descendant form and the attached one, so the mark appears twice per copy of the rule.
  const copies = () => styles.get("shop").split("color:").length - 1;
  try {
    await loader.load();
    assert.equal(loader.styles.length, 1);
    assert.equal(copies(), 1);

    for (const [sha, colour] of [["bbb", "blue"], ["ccc", "green"]]) {
      gateway.routes["/modules/index"] = index(entry("shop", { windows: [{ file: "shop.json", sha1: sha }] }));
      gateway.routes["/modules/ui/shop/shop.json"] = windowFile("shop-screen", { css: `.panel { color: ${colour} }` });
      await loader.poll();
      assert.equal(loader.styles.length, 1, `after saving ${colour}: one file, one stylesheet`);
      assert.equal(copies(), 1, `after saving ${colour}: one copy of its rule in the node`);
      assert.ok(styles.get("shop").includes(colour), styles.get("shop"));
    }
    assert.ok(!styles.get("shop").includes("red"), "and the first save is not still on the page");

    gateway.routes["/modules/index"] = index(entry("shop", { windows: [] }));
    await loader.poll();
    assert.deepEqual(loader.styles, []);
    assert.deepEqual([...styles.keys()], [], "the file is gone, and so is its styling");
  } finally {
    gateway.restore();
  }
});

test("a module's stylesheets become one style node, and unloading takes it away", async () => {
  const gateway = fakeGateway({
    "/modules/index": index(entry("shop", { css: [{ file: "a.css" }, { file: "b.css" }] })),
    "/modules/css/shop/a.css": ".a { color: red }",
    "/modules/css/shop/b.css": ".b { color: blue }",
  });
  const { loader, styles } = loaderFor();
  try {
    await loader.load();
    assert.deepEqual([...styles.keys()], ["shop"], "one node per module, or half of it could be left behind");
    assert.ok(styles.get("shop").includes('[data-module="shop"] .a'));
    assert.ok(styles.get("shop").includes('[data-module="shop"] .b'));
    assert.equal(loader.styles.length, 2);

    loader.unload();
    assert.deepEqual([...styles.keys()], []);
  } finally {
    gateway.restore();
  }
});
