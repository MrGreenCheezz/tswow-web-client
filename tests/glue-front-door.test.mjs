import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  FRONT_DOOR_STORAGE_KEY, frontDoorGatewayOrigin, frontDoorHost, frontDoorMode, frontDoorReturn,
  gatewaySocketUrl, storedFrontDoorMode, useFrontDoor,
} from "../dist/code/browser/glue/FrontDoor.js";
import { adoptWorldConnection } from "../dist/code/browser/app/WorldAdoption.js";
import { GlueRuntime } from "../dist/code/browser/glue/GlueRuntime.js";
import { createFixtureProvider } from "../dist/code/browser/glue/GlueLoader.js";
import { fakeGlueSession } from "../dist/code/browser/glue/GlueFakeSession.js";

/**
 * G6: the GlueXML screens as the client's front door.
 *
 * Three things are checkable without a browser and are checked here — which interface the page
 * opens with, where a world sends the player back to, and what "adopting a connection" actually
 * does to the context — plus the wiring that only a source pin can hold, because it lives behind
 * `ui/Dom.ts`, which resolves 170 elements at import time and cannot exist in node.
 */

const loginSource = new URL("../src/browser/app/Login.ts", import.meta.url);
const enterWorldSource = new URL("../src/browser/app/EnterWorld.ts", import.meta.url);
const mainSource = new URL("../src/browser/main.ts", import.meta.url);
const indexSource = new URL("../index.html", import.meta.url);
const glueSource = new URL("../glue.html", import.meta.url);
const cssSource = new URL("../src/browser/glue/glue.css", import.meta.url);
const globalStyleSource = new URL("../src/browser/style.css", import.meta.url);

/* --- Which front door opens ------------------------------------------------------------------ */

test("the glue screens are the default and the query flag wins in both directions", () => {
  // Default: the client's own interface, which is the whole point of the T1 track.
  assert.equal(frontDoorMode(""), "glue");
  assert.equal(frontDoorMode("?screen=charselect"), "glue");

  // The parity switch. A bare flag counts as "yes" because that is how a person types one.
  assert.equal(frontDoorMode("?legacy-login=1"), "legacy");
  assert.equal(frontDoorMode("?legacy-login"), "legacy");
  assert.equal(frontDoorMode("?legacy-login=true"), "legacy");
  assert.equal(frontDoorMode("?legacy-login=YES"), "legacy");
  assert.equal(frontDoorMode("?fake=charselect&legacy-login=on"), "legacy");

  // Remembered choice, when there is no flag.
  assert.equal(frontDoorMode("", "legacy"), "legacy");
  assert.equal(frontDoorMode("", "  LEGACY "), "legacy");
  assert.equal(frontDoorMode("", "glue"), "glue");
  assert.equal(frontDoorMode("", "nonsense"), "glue");
  assert.equal(frontDoorMode("", null), "glue");

  // …and the flag must be able to undo it, or the console escape hatch becomes a trap.
  assert.equal(frontDoorMode("?legacy-login=0", "legacy"), "glue");
  assert.equal(frontDoorMode("?legacy-login=false", "legacy"), "glue");
  assert.equal(frontDoorMode("?legacy-login=1", "glue"), "legacy");
  // A value that is neither yes nor no falls through to the stored choice rather than guessing.
  assert.equal(frontDoorMode("?legacy-login=maybe", "legacy"), "legacy");
  assert.equal(frontDoorMode("?legacy-login=maybe"), "glue");
});

test("a browser that refuses site data still gets a front door", () => {
  assert.equal(storedFrontDoorMode(null), null);
  assert.equal(storedFrontDoorMode(undefined), null);
  assert.equal(storedFrontDoorMode({ getItem: () => "legacy" }), "legacy");
  assert.equal(storedFrontDoorMode({
    getItem() { throw new Error("The operation is insecure."); },
  }), null, "a throwing storage is 'no preference', not a broken page");
  assert.equal(FRONT_DOOR_STORAGE_KEY, "webclient.frontDoor");
});

test("the gateway override takes every spelling a player is likely to paste", () => {
  // The DOM form was pre-filled with a ws URL, so that is the string most likely to be copied.
  assert.equal(frontDoorGatewayOrigin("?gateway=ws://10.0.0.5:8090/auth"), "http://10.0.0.5:8090");
  assert.equal(frontDoorGatewayOrigin("?gateway=wss://gw.example.net/auth"), "https://gw.example.net");
  assert.equal(frontDoorGatewayOrigin("?gateway=http://127.0.0.1:8091"), "http://127.0.0.1:8091");
  assert.equal(frontDoorGatewayOrigin("?gateway=https://gw.example.net"), "https://gw.example.net");
  // A bare host:port, which is what the address actually is.
  assert.equal(frontDoorGatewayOrigin("?gateway=127.0.0.1:8091"), "http://127.0.0.1:8091");
  // Nothing to say, or nothing understandable: the compiled default stands.
  assert.equal(frontDoorGatewayOrigin(""), undefined);
  assert.equal(frontDoorGatewayOrigin("?gateway="), undefined);
  assert.equal(frontDoorGatewayOrigin("?gateway=%%%"), undefined);
  assert.equal(frontDoorGatewayOrigin("?gateway=javascript:alert(1)"), undefined,
    "only http(s)/ws(s) is an address; anything else is refused rather than half-understood");
  assert.equal(frontDoorGatewayOrigin("?gateway=file:///etc/passwd"), undefined);

  assert.equal(gatewaySocketUrl("http://127.0.0.1:8091", "/auth"), "ws://127.0.0.1:8091/auth");
  assert.equal(gatewaySocketUrl("https://gw.example.net", "/world"), "wss://gw.example.net/world");
});

/* --- Where a world sends the player back to --------------------------------------------------- */

test("every exit from the world maps to one glue screen", () => {
  // Logout is the server letting go of the character: the character list comes back, over a fresh
  // connection because the used one has a world read loop on it.
  assert.deepEqual(frontDoorReturn("logout", true),
    { screen: "charselect", reconnect: true, closeWorld: false });
  // A failed enter is the same shape: the session is intact, the character is not.
  assert.deepEqual(frontDoorReturn("enter-failed", true),
    { screen: "charselect", reconnect: true, closeWorld: false });
  // A dead socket has no list behind it, so there is nothing for charselect to draw.
  assert.deepEqual(frontDoorReturn("connection-lost", true),
    { screen: "login", reconnect: false, closeWorld: true });
  assert.deepEqual(frontDoorReturn("relogin", true),
    { screen: "login", reconnect: false, closeWorld: true });

  // No realm chosen — a session that died under the world — is the login screen for every exit.
  for (const exit of ["logout", "enter-failed", "connection-lost", "relogin"]) {
    assert.deepEqual(frontDoorReturn(exit, false),
      { screen: "login", reconnect: false, closeWorld: true }, exit);
  }

  // `reconnect` and `closeWorld` are never both asked for: `GlueSession.connect` closes the
  // previous connection itself, and asking for both would close it twice.
  for (const exit of ["logout", "enter-failed", "connection-lost", "relogin"]) {
    for (const realm of [true, false]) {
      const plan = frontDoorReturn(exit, realm);
      assert.equal(plan.reconnect && plan.closeWorld, false, `${exit}/${realm}`);
    }
  }
});

test("the front-door registry is empty until a glue runtime actually stands", () => {
  assert.equal(frontDoorHost(), undefined, "legacy mode registers nothing, so every exit stays DOM");
  const exits = [];
  const host = {
    enteringWorld() { exits.push("entering"); },
    returnFromWorld(exit, message) { exits.push([exit, message]); },
  };
  useFrontDoor(host);
  assert.equal(frontDoorHost(), host);
  frontDoorHost().returnFromWorld("logout");
  assert.deepEqual(exits, [["logout", undefined]]);
  useFrontDoor(undefined);
  assert.equal(frontDoorHost(), undefined);
});

/* --- Adopting a live connection --------------------------------------------------------------- */

/** Only what a store is built over: `WorldStore`'s constructor writes `state.observer`. */
function fakeWorld() {
  return { state: { observer: undefined } };
}

test("adopting a connection points the context at it and binds both watchers once", () => {
  const target = { world: undefined, store: undefined };
  const world = fakeWorld();
  const hud = [];
  const death = [];
  const store = adoptWorldConnection(target, world, {
    bindHud: (value) => hud.push(value),
    bindDeathScreen: (value) => death.push(value),
    onListenerError: () => {},
  });

  assert.equal(target.world, world, "the context now points at this connection");
  assert.equal(target.store, store);
  assert.equal(store.state, world.state, "the store is built over this connection's own state");
  assert.equal(world.state.observer, store, "…and is what the state reports changes to");
  // Exactly once each, and both handed the same store: the HUD and the death layer read the same
  // character and must never disagree about whether it is alive.
  assert.deepEqual(hud, [store]);
  assert.deepEqual(death, [store]);
  assert.equal(hud[0], death[0]);
});

test("a second adoption detaches the first store instead of leaving it observing", () => {
  const target = { world: undefined, store: undefined };
  const first = fakeWorld();
  const second = fakeWorld();
  const bindings = { bindHud: () => {}, bindDeathScreen: () => {}, onListenerError: () => {} };

  const firstStore = adoptWorldConnection(target, first, bindings);
  assert.equal(first.state.observer, firstStore);
  const secondStore = adoptWorldConnection(target, second, bindings);

  assert.equal(first.state.observer, undefined, "the previous world reports to nobody");
  assert.equal(second.state.observer, secondStore);
  assert.equal(target.store, secondStore);
  assert.equal(target.world, second);
});

test("a panel that throws inside an update is reported through the adoption's own hook", () => {
  const target = { world: undefined, store: undefined };
  const seen = [];
  const store = adoptWorldConnection(target, fakeWorld(), {
    bindHud: () => {},
    bindDeathScreen: () => {},
    onListenerError: (error) => seen.push(error),
  });
  const boom = new Error("панель упала");
  store.onListenerError(boom);
  assert.deepEqual(seen, [boom]);
});

/* --- The glue side of the handover ------------------------------------------------------------ */

const FIXTURE = {
  "Interface/GlueXML/GlueXML.toc": ["## Interface: 30300", "GlueStrings.lua", "GlueParent.xml"].join("\n"),
  "Interface/GlueXML/GlueStrings.lua": `
    GlueScreenInfo = {};
    SEEN = {};
    AUTH_UNKNOWN_ACCOUNT = "Неизвестная учетная запись";
    function SetGlueScreen(name) SEEN[#SEEN + 1] = "screen:" .. name; end
  `,
  "Interface/GlueXML/GlueParent.xml": `<Ui>
    <Frame name="GlueParent" setAllPoints="true">
      <Scripts>
        <OnLoad>self:RegisterEvent("OPEN_STATUS_DIALOG");</OnLoad>
        <OnEvent>SEEN[#SEEN + 1] = event .. "/" .. tostring(arg2);</OnEvent>
      </Scripts>
    </Frame>
  </Ui>`,
};

async function runtimeWith(api) {
  const runtime = new GlueRuntime({ provider: createFixtureProvider(FIXTURE), api: { locale: "ruRU", ...api } });
  await runtime.load();
  return runtime;
}

const evaluate = (runtime, expression) => {
  runtime.vm.setGlobal("__result", undefined);
  const outcome = runtime.vm.execute(`__result = (function() ${expression} end)()`, "@front-door-probe");
  assert.equal(outcome.ok, true, `${expression}: ${outcome.error ?? ""}`);
  return runtime.vm.getGlobal("__result");
};

test("auth challenge code 4 uses the selected locale's stock Glue string and records the code", async () => {
  const diagnostics = [];
  let closed = false;
  const runtime = await runtimeWith({
    authUrl: "ws://fixture.invalid/auth",
    connect: async () => ({
      send() {},
      async readExactly(length) {
        assert.equal(length, 3);
        return Uint8Array.of(0, 0, 4);
      },
      close() { closed = true; },
    }),
    onAuthDiagnostic: (code) => diagnostics.push(code),
  });
  try {
    await runtime.api.login("NONEXISTENT", "irrelevant");
    assert.equal(evaluate(runtime, "return SEEN[#SEEN]"),
      "OPEN_STATUS_DIALOG/Неизвестная учетная запись");
    assert.deepEqual(diagnostics, [4]);
    assert.equal(closed, true);
  } finally {
    runtime.close();
  }
});

test("EnterWorld hands the selected character to the host and nothing else", async () => {
  const canned = fakeGlueSession("charselect");
  const handed = [];
  const runtime = await runtimeWith({
    session: { connect: () => canned.connect() },
    enterWorld: (request) => handed.push(request),
  });
  runtime.session.beginSession(canned.auth);
  await runtime.session.connect(canned.realm);

  // Nothing selected: the corpus disables the button, but a list that changed under a click has to
  // be answered rather than crashed on.
  evaluate(runtime, "EnterWorld(); return 1");
  assert.deepEqual(handed, []);
  assert.equal(evaluate(runtime, "return #SEEN"), 1);
  assert.equal(evaluate(runtime, "return SEEN[1]"), "OPEN_STATUS_DIALOG/Персонаж не выбран.");

  evaluate(runtime, "SelectCharacter(2); return 1");
  evaluate(runtime, "EnterWorld(); return 1");
  assert.equal(handed.length, 1);
  assert.equal(handed[0].character.name, "Лиэрель", "the character the screen is showing");
  assert.equal(handed[0].index, 2, "1-based, as CharacterSelect counts");
  // The connection is deliberately *not* in the request: the session still owns it, and the host
  // was handed it when it supplied the connector.
  assert.deepEqual(Object.keys(handed[0]).sort(), ["character", "index"]);
  // No second dialog: the handover is silent, because the host is about to cover the screen.
  assert.equal(evaluate(runtime, "return #SEEN"), 1);
  runtime.close();
});

test("a page with no world behind it says so instead of doing nothing", async () => {
  const canned = fakeGlueSession("charselect");
  const stubs = [];
  const runtime = new GlueRuntime({
    provider: createFixtureProvider(FIXTURE),
    api: { locale: "ruRU", session: { connect: () => canned.connect() } },
    onStub: (kind, name) => stubs.push(`${kind}:${name}`),
  });
  await runtime.load();
  runtime.session.beginSession(canned.auth);
  await runtime.session.connect(canned.realm);
  evaluate(runtime, "SelectCharacter(1); return 1");
  evaluate(runtime, "EnterWorld(); return 1");

  assert.equal(evaluate(runtime, "return #SEEN"), 1);
  assert.equal(evaluate(runtime, "return SEEN[1]"),
    "OPEN_STATUS_DIALOG/Вход в мир доступен на главной странице клиента (index.html).");
  assert.ok(stubs.includes("global:EnterWorld"), `recorded stubs: ${stubs.join(", ")}`);
  runtime.close();
});

/* --- Wiring that only a source pin can hold --------------------------------------------------- */

test("index.html hosts both interfaces and names the panel that has to be hidden", async () => {
  const html = await readFile(indexSource, "utf8");
  assert.match(html, /<div id="glue-host" hidden>/,
    "the glue stage lives in index.html and starts hidden, so legacy mode costs nothing");
  assert.match(html, /<div id="glue-stage"><\/div>/);
  assert.match(html, /<div id="glue-status"><\/div>/);
  assert.match(html, /<section id="login-panel" class="panel">/,
    "the DOM login card needs an id now that something has to hide it");
  assert.match(html, /id="character-panel"/);
  assert.match(html, /id="world-panel"/, "the world panel is shared by both front doors");
});

test("FrameXML controls neutralize the global native control chrome", async () => {
  const [globalCss, glueCss] = await Promise.all([
    readFile(globalStyleSource, "utf8"),
    readFile(cssSource, "utf8"),
  ]);

  // The global native skin intentionally targets the login/character forms, but these values are
  // unsafe for the client's authored 16px realm rows unless the scoped glue skin resets them.
  assert.match(globalCss, /input,\s*select,\s*button\s*\{[^}]*min-height:\s*44px/s,
    "the global native skin carries the 44px control minimum");
  assert.match(globalCss, /input,\s*select,\s*button\s*\{[^}]*border-radius:\s*8px/s,
    "the global native skin rounds buttons");
  assert.match(globalCss, /button:not\(:disabled\):hover\s*\{[^}]*filter:\s*brightness\(1\.18\)/s,
    "the global native skin applies generic hover brightness");

  const controls = glueCss.match(
    /#glue-stage\s+\[data-framexml-type="Button"\],\s*#glue-stage\s+\[data-framexml-type="CheckButton"\]\s*\{([^}]*)\}/s,
  )?.[1] ?? "";
  assert.match(controls, /min-height:\s*0/, "FrameXML controls clear the global minimum height");
  assert.match(controls, /border-radius:\s*0/, "FrameXML controls keep client-authored corners");
  assert.match(controls, /filter:\s*none/, "FrameXML controls keep client-authored hover state");
});

test("the stage styles are shared rather than copied into the two pages", async () => {
  const [css, glue, html] = await Promise.all([
    readFile(cssSource, "utf8"), readFile(glueSource, "utf8"), readFile(indexSource, "utf8"),
  ]);
  for (const rule of [
    "#glue-stage [data-framexml-type]",
    "#glue-stage input[data-framexml-input]",
    "#glue-stage [data-framexml-model-placeholder]",
    "object-view-box",
  ]) assert.ok(css.includes(rule), `glue.css must carry ${rule}`);
  // Below the world panel's own z-index of 100, so entering the world covers the glue screens
  // rather than fighting them.
  assert.match(css, /#glue-host\s*\{[^}]*z-index:\s*90/s);
  assert.ok(!glue.includes("data-framexml-type"),
    "glue.html must not keep a second copy of the widget rules");
  assert.ok(!html.includes("data-framexml-type"),
    "index.html must not carry a third copy either");
});

test("main.ts chooses the front door once and loads the Lua VM only when it wins", async () => {
  const source = await readFile(mainSource, "utf8");
  assert.match(source, /frontDoorMode\(frontDoorSearch, storedFrontDoorMode\(globalThis\.localStorage\)\)/);
  assert.match(source, /import\("\.\/glue\/FrontDoorHost\.js"\)/,
    "the glue runtime is a dynamic import, so legacy mode never fetches fengari");
  assert.doesNotMatch(source, /^import .*glue\/(Bootstrap|FrontDoorHost)\.js/m,
    "…which a static import would defeat");
  assert.match(source, /loginPanel\.hidden = true/);
  assert.match(source, /characterPanel\.hidden = true/);
  // The gateway override has to reach the DOM field: `EnterWorld` builds every asset client from it.
  assert.match(source, /gatewayInput\.value = gatewaySocketUrl\(frontDoorGateway, "\/auth"\)/);
  // A glue runtime that will not start falls back to the forms rather than to a blank page.
  assert.match(source, /loginPanel\.hidden = false/);
});

test("both roads into a world end in the same adoption, and the resets are written once", async () => {
  const source = await readFile(loginSource, "utf8");
  // One list of resets, in one function, called by every route out of a world.
  assert.equal((source.match(/^export function resetWorldUi\(\): void \{$/gm) ?? []).length, 1);
  for (const reset of [
    "clearWorldContext();", "resetGuildBank();", "resetMacroWindow();", "resetLoadingScreen();",
    "resetDeathScreenEffect();", "settingsStore.detach();", "forgetMovementState();",
  ]) {
    assert.equal((source.match(new RegExp(reset.replace(/[.()]/g, "\\$&"), "g")) ?? []).length, 1,
      `${reset} must appear exactly once, inside resetWorldUi`);
  }
  // The adoption tail is the shared function and not a second copy of the five lines.
  assert.equal((source.match(/adoptWorldConnection\(game, world, \{/g) ?? []).length, 1);
  assert.match(source, /export function adoptWorld\(world: WorldClient\): void/);
  assert.equal((source.match(/adoptWorld\(world\);/g) ?? []).length, 1,
    "connectRealm reaches the adoption through the shared function");
  assert.doesNotMatch(source, /new WorldStore\(/, "building the store is the shared function's job");
  assert.doesNotMatch(source, /bindPlayerHud\(game\.store\)/, "…and so is binding the HUD");
  // The way out asks the front door where to land; legacy keeps the character panel.
  assert.match(source, /export function leaveWorld\(exit: WorldExit, message\?: string\): void/);
  assert.match(source, /const front = frontDoorHost\(\);\s*\n\s*if \(front\) \{/);
  assert.match(source, /front\.returnFromWorld\(exit, message\);/);
  assert.match(source, /characterPanel\.hidden = false;/);
});

test("every path that used to leave the world half-way now routes through leaveWorld", async () => {
  const source = await readFile(enterWorldSource, "utf8");
  // Logout. Before G6 `SMSG_LOGOUT_COMPLETE` was a notice and nothing else.
  assert.match(source, /if \(!state\.complete\) return;[\s\S]{0,600}?leaveWorld\("logout"\);/);
  // Connection loss: `onWorldError` fires when the socket read threw, not on a bad packet.
  assert.match(source, /world\.onWorldError = \(error\) => \{[\s\S]{0,800}?leaveWorld\("connection-lost"/);
  // The failed enter, guarded so a newer attempt is not torn down by an older one's unwinding.
  assert.match(source,
    /if \(!entryLifecycle\.isCurrent\(generation\) \|\| game\.world !== world\) return;\s*hideLoadingScreen\(\);[\s\S]*?clearQuestLog\(\);\s*leaveWorld\("enter-failed", message\);/,
    "enter failure must clear quest state and leave only for the current generation");
  assert.match(source, /const generation = entryLifecycle\.begin\(\);/);
  assert.equal((source.match(/leaveWorld\(/g) ?? []).length, 3,
    "exactly three ways out of a world, and no fourth hand-rolled one");
  // The old hand-rolled tail must be gone from the failure branch.
  assert.doesNotMatch(source, /worldPanel\.hidden = true;\s*\n\s*document\.body\.classList\.remove/);
});
