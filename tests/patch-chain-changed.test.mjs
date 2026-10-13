import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import {
  GATEWAY_RESTARTING_MESSAGE, PATCH_CHAIN_CHANGED_MESSAGE, PatchChainChangedError, bootPatchGeneration, describePatchState,
  formatRestartCountdown, installPatchChainWatch, isPatchChainChangedResponse, notePatchResourceEntries, patchChainChanged,
  readPatchStatus, reportPatchChainChanged, resetPatchChainWatch, restartRemainingMs,
} from "../dist/code/browser/PatchChainChanged.js";
import { createHttpFileProvider } from "../dist/code/browser/glue/GlueLoader.js";
import { GlueBrowserAudio } from "../dist/code/browser/glue/GlueAudio.js";
import { fetchFrameXmlClientAddons } from "../dist/code/browser/framexml/FrameXmlClientAddons.js";
import { ModelTextureLoader } from "../dist/code/browser/TextureLoad.js";

const LATCH = { error: "client_patch_chain_changed", message: "The client patch set changed while the gateway was running." };

/** Just enough DOM for the banner: elements that hold children, text, attributes and listeners. */
function fakeDocument() {
  const node = (tag) => {
    const element = {
      tagName: tag.toUpperCase(), children: [], parent: undefined, attributes: {}, dataset: {},
      listeners: {}, textContent: "", className: "", id: "", type: "",
      append(...children) { for (const child of children) { child.parent = element; element.children.push(child); } },
      remove() {
        if (element.parent) element.parent.children = element.parent.children.filter((child) => child !== element);
        element.parent = undefined;
      },
      setAttribute(name, value) { element.attributes[name] = String(value); },
      addEventListener(type, listener) { (element.listeners[type] ??= []).push(listener); },
    };
    return element;
  };
  return { head: node("head"), body: node("body"), createElement: node };
}

function banners(document) {
  return document.body.children.filter((child) => child.id === "patch-chain-banner");
}

function withDocument(run) {
  return async () => {
    const previous = globalThis.document;
    const document = fakeDocument();
    globalThis.document = document;
    resetPatchChainWatch();
    try {
      await run(document);
    } finally {
      resetPatchChainWatch();
      if (previous === undefined) delete globalThis.document;
      else globalThis.document = previous;
    }
  };
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("only the gateway's latch body is the patch-chain 409", async () => {
  assert.equal(await isPatchChainChangedResponse(json(409, LATCH)), true);
  assert.equal(await isPatchChainChangedResponse(json(409, { error: "conflict" })), false);
  assert.equal(await isPatchChainChangedResponse(new Response("busy", { status: 409 })), false);
  assert.equal(await isPatchChainChangedResponse(json(404, LATCH)), false);
  // The shape the injected test fetchers have: a status and text() only.
  assert.equal(await isPatchChainChangedResponse({ status: 409, text: async () => JSON.stringify(LATCH) }), true);
});

test("the interface file provider throws PatchChainChangedError, raises one banner, keeps 404 a skip", withDocument(async (document) => {
  const provider = createHttpFileProvider({
    gatewayOrigin: "http://127.0.0.1:8090",
    fetch: async (url) => {
      if (url.includes("Missing.lua")) return { status: 404, ok: false, text: async () => "" };
      if (url.includes("Busy.lua")) return { status: 409, ok: false, text: async () => "{\"error\":\"other\"}" };
      return { status: 409, ok: false, text: async () => JSON.stringify(LATCH) };
    },
  });
  assert.equal(await provider.read("Interface/FrameXML/Missing.lua"), undefined, "404 is still a skip");
  await assert.rejects(provider.read("Interface/FrameXML/Busy.lua"), /returned 409/, "another 409 stays a plain failure");
  assert.equal(patchChainChanged(), false);
  await assert.rejects(provider.read("Interface/FrameXML/UIParent.lua"), (error) => {
    assert.ok(error instanceof PatchChainChangedError);
    assert.equal(error.message, PATCH_CHAIN_CHANGED_MESSAGE);
    assert.equal(error.route, "/client/file");
    return true;
  });
  await assert.rejects(provider.read("Interface/FrameXML/UIParent.xml"), PatchChainChangedError);
  assert.equal(patchChainChanged(), true);
  const shown = banners(document);
  assert.equal(shown.length, 1, "one banner however many files hit the latch");
  const [title, reload, detail] = shown[0].children;
  assert.equal(title.textContent, "Патчи TSWoW обновились — перезапустите шлюз и обновите страницу");
  assert.equal(reload.textContent, "Обновить страницу");
  assert.equal(reload.listeners.click.length, 1);
  assert.match(detail.textContent, /409 client_patch_chain_changed на \/client\/file/);
  assert.equal(shown[0].attributes.role, "alert");
}));

test("the add-on list no longer turns the latch into an empty list", withDocument(async () => {
  await assert.rejects(
    fetchFrameXmlClientAddons("http://127.0.0.1:8090", async () => json(409, LATCH)),
    (error) => error instanceof PatchChainChangedError && error.route === "/client/addons",
  );
  await assert.rejects(
    fetchFrameXmlClientAddons("http://127.0.0.1:8090", async () => json(404, {})),
    (error) => !(error instanceof PatchChainChangedError) && /returned 404/.test(error.message),
    "an older gateway without the route keeps its old failure",
  );
}));

test("the page-wide watch sees a latched 409 on any fetch and leaves the body to its caller", withDocument(async (document) => {
  const previousFetch = globalThis.fetch;
  let latched = false;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/client/patch-status")) return json(200, { schema: 1, generation: "a".repeat(40), stale: latched });
    if (url.includes("/texture")) {
      latched = true;
      return json(409, LATCH);
    }
    return new Response("ok", { status: 200 });
  };
  try {
    installPatchChainWatch(() => "http://127.0.0.1:8090");
    const wrapped = globalThis.fetch;
    installPatchChainWatch(() => "http://127.0.0.1:8090");
    assert.equal(globalThis.fetch, wrapped, "installing twice does not wrap twice");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(bootPatchGeneration(), "a".repeat(40), "the boot generation is remembered for Diagnostics");

    const plain = await fetch("http://127.0.0.1:8090/dbc/spells");
    assert.equal(await plain.text(), "ok");
    assert.equal(patchChainChanged(), false);

    const refused = await fetch("http://127.0.0.1:8090/texture?path=Tileset%5CA.blp");
    assert.deepEqual(await refused.json(), LATCH, "the caller still reads the body");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(patchChainChanged(), true);
    assert.equal(banners(document).length, 1);
    // The banner then asks the gateway where it stands: latched, and nothing restarts it by itself.
    await new Promise((resolve) => setImmediate(resolve));
    const detail = banners(document)[0].children[2];
    assert.match(detail.textContent, /перезапустите шлюз \(bat\\11 Шлюз - перезапустить\.bat\), затем обновите страницу/);
    assert.equal(detail.dataset.tone, "error");
  } finally {
    globalThis.fetch = previousFetch;
  }
}));

test("a page opened on an already latched gateway says so at once", withDocument(async (document) => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => json(200, { schema: 1, generation: "b".repeat(40), stale: true, supervised: false });
  try {
    installPatchChainWatch(() => "http://127.0.0.1:8090");
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(banners(document).length, 1);
  } finally {
    globalThis.fetch = previousFetch;
  }
}));

test("the status sentence covers stale, supervised, restarted, current, old and absent gateways", async () => {
  const boot = "1".repeat(40);
  const status = (overrides) => ({ kind: "ok", status: { generation: boot, stale: false, ...overrides } });
  assert.deepEqual(describePatchState(boot, status({})), {
    tone: "ok", text: "Поколение патчей 11111111 — как при загрузке страницы.", reload: false,
  });
  const stale = describePatchState(boot, status({ stale: true, changedAt: "2026-09-25T10:04:00.000Z" }));
  assert.equal(stale.tone, "error");
  assert.match(stale.text, /перезапустите шлюз \(bat\\11 Шлюз - перезапустить\.bat\), затем обновите страницу/);
  const supervised = describePatchState(boot, status({ stale: true, supervised: true }));
  assert.equal(supervised.tone, "warning");
  assert.match(supervised.text, /перезапустится сам/);
  const restarted = describePatchState(boot, status({ generation: "2".repeat(40) }));
  assert.deepEqual([restarted.tone, restarted.reload], ["error", true]);
  assert.match(restarted.text, /22222222.*11111111 — обновите страницу/);
  assert.deepEqual(describePatchState(null, status({ generation: "2".repeat(40) })), {
    tone: "muted", text: "Шлюз отдаёт поколение патчей 22222222.", reload: false,
  }, "without a boot generation there is nothing to compare, and nothing is claimed");
  // The page met the 409 from a gateway too old to report a generation; not stale now = restarted.
  const back = describePatchState(null, status({ generation: "2".repeat(40) }), { pageLatched: true });
  assert.deepEqual([back.reload, back.text], [true, "Шлюз перезапущен (поколение патчей 22222222) — обновите страницу."]);
  assert.equal(describePatchState(boot, status({ stale: true }), { pageLatched: true }).reload, false,
    "still latched: a reload would only meet the 409 again");
  assert.match(describePatchState(boot, { kind: "unsupported" }).text, /собран до \/client\/patch-status/);
  assert.match(describePatchState(boot, { kind: "unreachable", error: "refused" }).text, /не отвечает/);

  const reads = [
    [async () => json(404, {}), "unsupported"],
    [async () => { throw new TypeError("Failed to fetch"); }, "unreachable"],
    [async () => json(500, {}), "unreachable"],
    [async () => json(200, { nope: true }), "unreachable"],
    [async () => json(200, { generation: boot, stale: false }), "ok"],
  ];
  for (const [fetcher, kind] of reads) {
    assert.equal((await readPatchStatus("http://127.0.0.1:8090", { summary: true, fetch: fetcher })).kind, kind);
  }
});

test("reporting is idempotent and does nothing without a document", async () => {
  resetPatchChainWatch();
  const previous = globalThis.document;
  delete globalThis.document;
  try {
    reportPatchChainChanged("/sound");
    reportPatchChainChanged("/sound");
    assert.equal(patchChainChanged(), true);
  } finally {
    resetPatchChainWatch();
    if (previous !== undefined) globalThis.document = previous;
  }
});

const GATEWAY = "http://127.0.0.1:8090";
const settle = async () => {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
};

/**
 * A gateway whose status the test moves: `generation`, `stale`, a forced restart (`restartAt`,
 * `restartInMs`, sent only when set), `down` (nothing answers), and how often it was asked.
 */
function statusGateway(initial) {
  const gateway = { generation: "a".repeat(40), stale: false, supervised: false, statusCalls: 0, down: false, ...initial };
  gateway.fetch = async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/client/patch-status")) {
      gateway.statusCalls++;
      if (gateway.down) throw new TypeError("Failed to fetch");
      return json(200, {
        schema: 1, generation: gateway.generation, stale: gateway.stale, supervised: gateway.supervised,
        restartAt: gateway.restartAt, restartInMs: gateway.restartInMs,
      });
    }
    return new Response("ok", { status: 200 });
  };
  return gateway;
}

test("a gateway restarted under a quiet page is noticed by the next answer it serves", withDocument(async (document) => {
  const previousFetch = globalThis.fetch;
  const gateway = statusGateway();
  globalThis.fetch = gateway.fetch;
  let now = 1_000;
  try {
    installPatchChainWatch(() => GATEWAY, { now: () => now });
    await settle();
    assert.equal(bootPatchGeneration(), "a".repeat(40));
    assert.equal(gateway.statusCalls, 1, "the boot read");

    now += 5_000;
    await fetch(`${GATEWAY}/client/addons`);
    await settle();
    assert.equal(gateway.statusCalls, 1, "an ordinary answer within ten seconds of the last read asks nothing");

    // The page asks for nothing while a TSWoW build latches the gateway and the supervisor restarts
    // it (no /auth or /world socket held it back): no 409 ever reaches this page.
    gateway.generation = "b".repeat(40);
    now += 20_000;
    await fetch("http://127.0.0.1:5173/src/browser/main.ts");
    await settle();
    assert.equal(gateway.statusCalls, 1, "traffic to anything but the gateway is not a reason to ask it");
    const answer = await fetch(`${GATEWAY}/client/addons`);
    assert.equal(await answer.text(), "ok", "the caller keeps its answer");
    await settle();
    assert.equal(patchChainChanged(), true);
    assert.equal(banners(document).length, 1);
    const detail = banners(document)[0].children[2];
    assert.match(detail.textContent, /поколение патчей bbbbbbbb, а страница загружена с aaaaaaaa — обновите страницу/);
    assert.equal(banners(document)[0].children[1].dataset.ready, "true", "a reload now loads the new patches");
  } finally {
    globalThis.fetch = previousFetch;
  }
}));

test("the same generation after a plain restart raises nothing, however long the page runs", withDocument(async (document) => {
  const previousFetch = globalThis.fetch;
  const gateway = statusGateway();
  globalThis.fetch = gateway.fetch;
  let now = 1_000;
  try {
    installPatchChainWatch(() => GATEWAY, { now: () => now });
    await settle();
    for (let i = 0; i < 3; i++) {
      now += 11_000;
      await fetch(`${GATEWAY}/texture?path=A.blp`);
      await settle();
    }
    assert.equal(gateway.statusCalls, 4, "one read per ten seconds of activity");
    assert.equal(patchChainChanged(), false);
    assert.equal(banners(document).length, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
}));

test("an <img> texture or <audio> that met the latch raises the banner through its error callback", withDocument(async (document) => {
  const previousFetch = globalThis.fetch;
  const previousLoad = THREE.TextureLoader.prototype.load;
  const previousAudio = globalThis.Audio;
  const gateway = statusGateway();
  globalThis.fetch = gateway.fetch;
  THREE.TextureLoader.prototype.load = function (_url, _onLoad, _onProgress, onError) {
    const texture = new THREE.Texture();
    queueMicrotask(() => onError(new Event("error")));
    return texture;
  };
  let now = 1_000;
  try {
    installPatchChainWatch(() => GATEWAY, { now: () => now });
    await settle();
    const loader = new ModelTextureLoader();
    now += 3_000;
    loader.load("http://elsewhere.test/visual/texture/x.png");
    await settle();
    assert.equal(gateway.statusCalls, 1, "a failure off the gateway is not ours to judge");

    loader.load(`${GATEWAY}/visual/texture/${"0".repeat(40)}.png`);
    await settle();
    assert.equal(gateway.statusCalls, 2, "a gateway texture that failed makes the page ask");
    assert.equal(patchChainChanged(), false, "the gateway is current: a missing texture is just missing");

    gateway.stale = true;
    loader.load(`${GATEWAY}/visual/texture/${"1".repeat(40)}.png`);
    await settle();
    assert.equal(gateway.statusCalls, 2, "a burst of failures asks once");
    now += 3_000;
    loader.load(`${GATEWAY}/visual/texture/${"2".repeat(40)}.png`);
    await settle();
    assert.equal(patchChainChanged(), true);
    assert.equal(banners(document).length, 1);
    assert.match(banners(document)[0].children[2].textContent, /перезапустите шлюз \(bat\\11 Шлюз - перезапустить\.bat\)/);

    // The glue screen's <audio> goes through the same door.
    resetPatchChainWatch();
    globalThis.fetch = gateway.fetch;
    const elements = [];
    globalThis.Audio = class {
      listeners = {};
      addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
      play() { return Promise.resolve(); }
      pause() {}
      constructor() { elements.push(this); }
    };
    // Current at page load; latched afterwards, with no fetch meeting it.
    gateway.stale = false;
    installPatchChainWatch(() => GATEWAY, { now: () => now });
    await settle();
    assert.equal(patchChainChanged(), false);
    gateway.stale = true;
    now += 3_000;
    const sink = new GlueBrowserAudio({
      gatewayOrigin: GATEWAY,
      fetch: gateway.fetch,
      gestureTarget: { addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } },
    });
    sink.playSound("Sound\\Interface\\uChatScrollButton.wav");
    const element = elements.at(-1);
    assert.ok(element, "an element was made for the sound");
    for (const listener of element.listeners.error ?? []) listener();
    await settle();
    assert.equal(patchChainChanged(), true, "a latched /sound raises it too");
  } finally {
    globalThis.fetch = previousFetch;
    THREE.TextureLoader.prototype.load = previousLoad;
    if (previousAudio === undefined) delete globalThis.Audio;
    else globalThis.Audio = previousAudio;
  }
}));

test("resource timing reports an <img> 409 the fetch wrapper never sees", withDocument(async (document) => {
  const previousFetch = globalThis.fetch;
  const previousObserver = globalThis.PerformanceObserver;
  const observers = [];
  globalThis.PerformanceObserver = class {
    static supportedEntryTypes = ["resource"];
    constructor(callback) { this.callback = callback; this.options = undefined; this.connected = true; observers.push(this); }
    observe(options) { this.options = options; }
    disconnect() { this.connected = false; }
  };
  const gateway = statusGateway({ stale: true });
  let now = 1_000;
  try {
    // The boot read sees the latch at once; here the gateway latches after the page loaded.
    gateway.stale = false;
    globalThis.fetch = gateway.fetch;
    installPatchChainWatch(() => GATEWAY, { now: () => now });
    await settle();
    assert.equal(observers.length, 1);
    assert.deepEqual(observers[0].options, { type: "resource", buffered: false });
    gateway.stale = true;
    now += 3_000;
    const entries = (list) => ({ getEntries: () => list });
    observers[0].callback(entries([
      { name: `${GATEWAY}/client/addons`, initiatorType: "fetch", responseStatus: 409 },
      { name: "http://elsewhere.test/texture", initiatorType: "img", responseStatus: 409 },
    ]));
    await settle();
    assert.equal(gateway.statusCalls, 1, "a fetch 409 is the wrapper's; a foreign one is nobody's");
    observers[0].callback(entries([{ name: `${GATEWAY}/texture?path=A.blp`, initiatorType: "img", responseStatus: 409 }]));
    await settle();
    assert.equal(gateway.statusCalls, 3, "the probe, then the banner's own first read");
    assert.equal(banners(document).length, 1);

    resetPatchChainWatch();
    assert.equal(observers[0].connected, false, "reset disconnects the observer");
    // An idle page's own status reads are gateway traffic too, and must not keep it asking.
    globalThis.fetch = gateway.fetch;
    gateway.stale = false;
    installPatchChainWatch(() => GATEWAY, { now: () => now });
    await settle();
    const before = gateway.statusCalls;
    now += 60_000;
    notePatchResourceEntries([{ name: `${GATEWAY}/client/patch-status?summary=1`, initiatorType: "fetch", responseStatus: 200 }]);
    await settle();
    assert.equal(gateway.statusCalls, before);
    notePatchResourceEntries([{ name: `${GATEWAY}/visual/model?path=A.m2`, initiatorType: "img", responseStatus: 200 }]);
    await settle();
    assert.equal(gateway.statusCalls, before + 1, "any other gateway entry counts as activity");
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.PerformanceObserver = previousObserver;
  }
}));

test("coming back to the tab asks the gateway at once", withDocument(async (document) => {
  const previousFetch = globalThis.fetch;
  const gateway = statusGateway();
  globalThis.fetch = gateway.fetch;
  const listeners = {};
  document.visibilityState = "hidden";
  document.addEventListener = (type, listener) => { (listeners[type] ??= []).push(listener); };
  document.removeEventListener = (type, listener) => { listeners[type] = (listeners[type] ?? []).filter((entry) => entry !== listener); };
  let now = 1_000;
  try {
    installPatchChainWatch(() => GATEWAY, { now: () => now });
    await settle();
    gateway.generation = "c".repeat(40);
    now += 3_000;
    for (const listener of listeners.visibilitychange ?? []) listener();
    await settle();
    assert.equal(gateway.statusCalls, 1, "hidden: nothing to do");
    document.visibilityState = "visible";
    for (const listener of listeners.visibilitychange ?? []) listener();
    await settle();
    assert.equal(gateway.statusCalls, 3, "the probe, then the banner's own first read");
    assert.equal(banners(document).length, 1);
    resetPatchChainWatch();
    assert.deepEqual(listeners.visibilitychange, [], "reset removes the listener");
  } finally {
    globalThis.fetch = previousFetch;
  }
}));

test("the banner collapses to a tab and opens again once a reload would help", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  await withDocument(async (document) => {
    const previousFetch = globalThis.fetch;
    const gateway = statusGateway({ stale: true, supervised: true });
    globalThis.fetch = gateway.fetch;
    try {
      installPatchChainWatch(() => GATEWAY);
      await settle();
      const [banner] = banners(document);
      assert.ok(banner, "a latched gateway at page load");
      await settle();
      const [, reload, detail, collapse, pill] = banner.children;
      assert.match(detail.textContent, /перезапустится сам/);
      assert.equal(collapse.textContent, "Свернуть");
      assert.equal(banner.dataset.collapsed, "false");
      collapse.listeners.click[0]();
      assert.equal(banner.dataset.collapsed, "true", "a player kept in the world can fold it away");
      pill.listeners.click[0]();
      assert.equal(banner.dataset.collapsed, "false");
      collapse.listeners.click[0]();

      t.mock.timers.tick(3_000);
      await settle();
      assert.equal(banner.dataset.collapsed, "true", "still waiting on the supervisor: it stays folded");
      assert.equal(reload.dataset.ready, "false");
      // The supervisor restarted the gateway on the new build.
      gateway.stale = false;
      gateway.generation = "d".repeat(40);
      t.mock.timers.tick(3_000);
      await settle();
      assert.equal(reload.dataset.ready, "true");
      assert.equal(banner.dataset.collapsed, "false", "unfolded the moment a reload loads the new patches");
    } finally {
      globalThis.fetch = previousFetch;
    }
  })();
});

/* --- 10.15 (C): the forced restart after an update, counted down --------------------------------- */

test("10.15 (C): the status sentence counts a forced restart down, then says it is under way", () => {
  const boot = "1".repeat(40);
  const latched = (overrides) => ({ kind: "ok", status: { generation: boot, stale: true, supervised: true, ...overrides } });
  assert.equal(formatRestartCountdown(300_000), "5:00");
  assert.equal(formatRestartCountdown(299_001), "5:00", "rounded up: a second that has begun is still left");
  assert.equal(formatRestartCountdown(61_000), "1:01");
  assert.equal(formatRestartCountdown(9_000), "0:09");
  assert.equal(formatRestartCountdown(1), "0:01");
  assert.equal(formatRestartCountdown(0), "0:00");
  assert.equal(formatRestartCountdown(-5_000), "0:00");

  assert.deepEqual(describePatchState(boot, latched({ restartAt: 1, restartInMs: 272_000 })), {
    tone: "error", text: "Сервер перезапустится через 4:32 — данные обновлены.", reload: false,
  });
  assert.equal(describePatchState(boot, latched({ restartAt: 0, restartInMs: 60_000 }), { now: 10_000_000 }).text,
    "Сервер перезапустится через 1:00 — данные обновлены.", "the time left wins over a clock the page does not share");
  assert.equal(describePatchState(boot, latched({ restartAt: 100_000 }), { now: 40_000 }).text,
    "Сервер перезапустится через 1:00 — данные обновлены.", "a time alone is read against the page's clock");
  assert.equal(describePatchState(boot, latched({ restartInMs: 272_000 }), { restartInMs: 5_000 }).text,
    "Сервер перезапустится через 0:05 — данные обновлены.", "between reads the banner's own count wins");
  assert.deepEqual(describePatchState(boot, latched({ restartInMs: 0 })), {
    tone: "error", text: `${GATEWAY_RESTARTING_MESSAGE}.`, reload: false,
  });
  assert.equal(GATEWAY_RESTARTING_MESSAGE, "Сервер перезапускается после обновления");
  assert.match(describePatchState(boot, latched({ restartAt: null, restartInMs: null })).text, /перезапустится сам/,
    "nothing scheduled: the supervisor waits, as before");
  assert.equal(describePatchState(boot, { kind: "unreachable", error: "refused" }, { restarting: true }).text,
    `${GATEWAY_RESTARTING_MESSAGE}.`, "after a countdown, a gateway that stopped answering is the restart");
  assert.match(describePatchState(boot, { kind: "unreachable", error: "refused" }).text, /не отвечает/);
  assert.equal(restartRemainingMs({ generation: boot, stale: true }, 0), undefined, "an older gateway sends neither");
  assert.equal(restartRemainingMs({ generation: boot, stale: true, restartAt: 5_000 }, 9_000), 0);
});

test("10.15 (C): the banner counts the forced restart down every second, then follows the restart", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  await withDocument(async (document) => {
    const previousFetch = globalThis.fetch;
    const gateway = statusGateway({ stale: true, supervised: true, restartAt: 9, restartInMs: 299_400 });
    globalThis.fetch = gateway.fetch;
    let now = 1_000_000;
    try {
      installPatchChainWatch(() => GATEWAY, { now: () => now });
      await settle();
      const [banner] = banners(document);
      assert.ok(banner, "a latched gateway at page load");
      await settle();
      const [, reload, detail, collapse, pill] = banner.children;
      assert.equal(detail.textContent, "Сервер перезапустится через 5:00 — данные обновлены.");
      assert.equal(detail.dataset.tone, "error");
      collapse.listeners.click[0]();
      assert.equal(banner.dataset.collapsed, "true", "a player can still fold it away");

      now += 1_000;
      t.mock.timers.tick(1_000);
      assert.equal(detail.textContent, "Сервер перезапустится через 4:59 — данные обновлены.", "one second later, without a read");
      assert.equal(pill.textContent, "Перезапуск через 4:59", "the folded tab counts down too");
      assert.equal(banner.dataset.collapsed, "true", "folded again by the player, it stays folded");
      const reads = gateway.statusCalls;

      // The next read says the same deadline through another round trip: the seconds do not step back.
      gateway.restartInMs = 296_900;
      now += 2_000;
      t.mock.timers.tick(2_000);
      await settle();
      assert.equal(gateway.statusCalls, reads + 1);
      assert.equal(detail.textContent, "Сервер перезапустится через 4:57 — данные обновлены.");

      // The deadline: the gateway closes its sessions and is gone for a moment.
      gateway.down = true;
      now += 3_000;
      t.mock.timers.tick(3_000);
      await settle();
      assert.equal(detail.textContent, `${GATEWAY_RESTARTING_MESSAGE}.`);
      assert.equal(pill.textContent, "Сервер перезапускается");
      assert.equal(reload.dataset.ready, "false");

      // Back on the new build: the countdown ends, a reload loads it, the banner opens again.
      gateway.down = false;
      gateway.stale = false;
      gateway.generation = "e".repeat(40);
      gateway.restartAt = undefined;
      gateway.restartInMs = undefined;
      now += 3_000;
      t.mock.timers.tick(3_000);
      await settle();
      assert.match(detail.textContent, /поколение патчей eeeeeeee, а страница загружена с aaaaaaaa — обновите страницу/);
      assert.equal(reload.dataset.ready, "true");
      assert.equal(banner.dataset.collapsed, "false");
      assert.equal(pill.textContent, "Патчи обновились");
      const text = detail.textContent;
      now += 5_000;
      t.mock.timers.tick(1_000);
      assert.equal(detail.textContent, text, "no countdown left running");
    } finally {
      globalThis.fetch = previousFetch;
    }
  })();
});

test("10.15 (C): a visible page that loads nothing still asks every thirty seconds", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  await withDocument(async (document) => {
    const previousFetch = globalThis.fetch;
    const gateway = statusGateway();
    globalThis.fetch = gateway.fetch;
    let now = 1_000;
    try {
      installPatchChainWatch(() => GATEWAY, { now: () => now });
      await settle();
      assert.equal(gateway.statusCalls, 1, "the boot read");
      now += 30_000;
      t.mock.timers.tick(30_000);
      await settle();
      assert.equal(gateway.statusCalls, 2, "thirty idle seconds: one read");

      now += 20_000;
      await fetch(`${GATEWAY}/texture?path=A.blp`);
      await settle();
      assert.equal(gateway.statusCalls, 3, "activity asks by itself");
      now += 10_000;
      t.mock.timers.tick(30_000);
      await settle();
      assert.equal(gateway.statusCalls, 3, "ten seconds after another read the idle tick asks nothing");

      document.visibilityState = "hidden";
      now += 60_000;
      t.mock.timers.tick(30_000);
      await settle();
      assert.equal(gateway.statusCalls, 3, "a hidden tab asks when it comes back, not on the clock");

      // A player standing still hears of a forced restart from the idle read alone.
      document.visibilityState = "visible";
      gateway.stale = true;
      gateway.supervised = true;
      gateway.restartInMs = 240_000;
      now += 30_000;
      t.mock.timers.tick(30_000);
      await settle();
      assert.equal(banners(document).length, 1);
      await settle();
      assert.equal(banners(document)[0].children[2].textContent, "Сервер перезапустится через 4:00 — данные обновлены.");
    } finally {
      globalThis.fetch = previousFetch;
    }
  })();
});
