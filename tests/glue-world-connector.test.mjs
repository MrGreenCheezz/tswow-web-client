import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { glueWorldConnector, GlueConnectCancelledError } from "../dist/code/browser/glue/GlueWorldConnector.js";
import { GlueSession } from "../dist/code/browser/glue/GlueSession.js";
import { GlueRuntime } from "../dist/code/browser/glue/GlueRuntime.js";
import { createFixtureProvider } from "../dist/code/browser/glue/GlueLoader.js";
import { fakeGlueSession } from "../dist/code/browser/glue/GlueFakeSession.js";

/**
 * 10.05/10.06 review, item 6: one world connector for both pages that run the glue screens, and
 * StatusDialogClick — which every OKAY dialog ends in — leaving a silent reconnect alone.
 */

// type 8 is RP-PvP: the world mount answers GetZonePVPInfo from it (Cfg_Configs RealmType).
const REALM = { id: 7, name: "Круг Теней", type: 8 };
const AUTH = { username: "PLAYER", sessionKey: new Uint8Array(40), realms: [] };

function parts({ connectWorld } = {}) {
  const log = [];
  const stream = { closed: 0, close() { this.closed += 1; log.push("stream closed"); } };
  return {
    log,
    stream,
    parts: {
      url: "ws://gateway.test/world",
      openStream: async (url) => { log.push(`open ${url}`); return stream; },
      connectWorld: connectWorld ?? (async (_stream, credentials, hooks) => {
        log.push(`connect ${credentials.username} ${credentials.realmId} ${credentials.realmName} ${credentials.realmType}`);
        hooks.onQueue(3);
        return { closed: false, close() { this.closed = true; log.push("client closed"); } };
      }),
      onConnected: (client, auth, realm) => log.push(`connected ${auth.username} ${realm.id}`),
    },
  };
}

test("the connector opens /world, reports the stages and hands the client over", async () => {
  const { log, parts: seam } = parts();
  const progress = [];
  const client = await glueWorldConnector(seam)(REALM, AUTH, (step) => progress.push(`${step.stage}:${step.position ?? ""}`));
  assert.equal(typeof client.close, "function");
  assert.deepEqual(log, ["open ws://gateway.test/world", "connect PLAYER 7 Круг Теней 8", "connected PLAYER 7"]);
  assert.deepEqual(progress, ["authenticating:", "queued:3"]);
});

test("Cancel closes the socket, which is what ends a wait in the realm's queue", async () => {
  let release;
  const { log, stream, parts: seam } = parts({
    connectWorld: () => new Promise((_resolve, reject) => { release = reject; }),
  });
  const abort = new AbortController();
  const connecting = glueWorldConnector(seam)(REALM, AUTH, undefined, abort.signal);
  await new Promise((resolve) => setImmediate(resolve));
  abort.abort();
  assert.equal(stream.closed, 1, "the abort closed the stream");
  release(new Error("closed"));
  await assert.rejects(connecting);
  assert.ok(!log.some((line) => line.startsWith("connected")), "a cancelled connection is never handed over");
});

test("a connection that completes after its Cancel is closed, not handed to the host", async () => {
  let finish;
  const client = { closed: false, close() { this.closed = true; } };
  const { log, parts: seam } = parts({ connectWorld: () => new Promise((resolve) => { finish = resolve; }) });
  const abort = new AbortController();
  const connecting = glueWorldConnector(seam)(REALM, AUTH, undefined, abort.signal);
  await new Promise((resolve) => setImmediate(resolve));
  abort.abort();
  finish(client);
  await assert.rejects(connecting, (error) => error instanceof GlueConnectCancelledError);
  assert.equal(client.closed, true);
  assert.ok(!log.some((line) => line.startsWith("connected")));
});

test("a failed handshake closes the socket it opened", async () => {
  const { stream, parts: seam } = parts({ connectWorld: async () => { throw new Error("refused"); } });
  await assert.rejects(glueWorldConnector(seam)(REALM, AUTH), /refused/);
  assert.equal(stream.closed, 1);
});

test("both pages use the shared connector and neither carries its own copy", async () => {
  for (const file of ["Bootstrap.ts", "FrontDoorHost.ts"]) {
    const source = await readFile(new URL(`../src/browser/glue/${file}`, import.meta.url), "utf8");
    assert.match(source, /liveGlueWorldConnector\(origin/, `${file} uses the shared connector`);
    assert.doesNotMatch(source, /WorldClient\.connect\(/, `${file} has no hand-copied handshake`);
    assert.doesNotMatch(source, /gatewaySocketUrl\(origin, "\/world"\)/, `${file} builds no /world URL of its own`);
  }
});

/* --- StatusDialogClick and a reconnect nobody announced ---------------------------------------- */

const FIXTURE = {
  "Interface/GlueXML/GlueXML.toc": ["## Interface: 30300", "GlueStrings.lua", "GlueParent.xml"].join("\n"),
  "Interface/GlueXML/GlueStrings.lua": "GlueScreenInfo = {}; SEEN = {}; function SetGlueScreen(name) end",
  "Interface/GlueXML/GlueParent.xml": `<Ui>
    <Frame name="GlueParent" setAllPoints="true">
      <Scripts>
        <OnLoad>self:RegisterEvent("OPEN_REALM_LIST"); self:RegisterEvent("CHARACTER_LIST_UPDATE");</OnLoad>
        <OnEvent>SEEN[#SEEN + 1] = event;</OnEvent>
      </Scripts>
    </Frame>
  </Ui>`,
};

async function silentStage() {
  const canned = fakeGlueSession("charselect");
  let aborted = 0;
  let finish;
  const runtime = new GlueRuntime({
    provider: createFixtureProvider(FIXTURE),
    api: {
      locale: "ruRU",
      session: {
        connect: (_realm, _auth, _progress, signal) => new Promise((resolve) => {
          signal?.addEventListener("abort", () => { aborted += 1; });
          finish = async () => resolve(await canned.connect());
        }),
      },
    },
  });
  await runtime.load();
  runtime.session.beginSession(canned.auth);
  const lua = (source) => {
    runtime.vm.setGlobal("__result", undefined);
    const outcome = runtime.vm.execute(`__result = (function() ${source} end)()`, "@connector-probe");
    assert.equal(outcome.ok, true, `${source}: ${outcome.error ?? ""}`);
    return runtime.vm.getGlobal("__result");
  };
  const settle = async () => {
    for (let round = 0; round < 6; round++) await new Promise((resolve) => setImmediate(resolve));
  };
  return { runtime, canned, lua, settle, aborted: () => aborted, finish: () => finish() };
}

test("StatusDialogClick on the message after a world exit leaves the silent reconnect running", async () => {
  const stage = await silentStage();
  try {
    // `returnFromWorld` reconnects behind the screen without a connecting dialog…
    const reconnect = stage.runtime.session.connect(stage.canned.realm);
    // …and the player dismisses the OKAY dialog that explains why they are back.
    stage.lua("StatusDialogClick(); return 1");
    assert.equal(stage.aborted(), 0, "the silent connection is not cancelled");
    assert.equal(stage.lua("return #SEEN"), 0, "and the realm list is not opened over the screen");
    await stage.finish();
    await reconnect;
    await stage.settle();
    assert.equal(stage.runtime.session.connected, true);
    assert.equal(stage.runtime.session.characters.length, 3);
    assert.equal(stage.lua("return SEEN[#SEEN]"), "CHARACTER_LIST_UPDATE");
  } finally {
    stage.runtime.close();
  }
});

test("CancelLogin during a silent reconnect leaves it alone too; an announced one is cancelled", async () => {
  const stage = await silentStage();
  try {
    const reconnect = stage.runtime.session.connect(stage.canned.realm);
    stage.lua("CancelLogin(); return 1");
    assert.equal(stage.aborted(), 0);
    await stage.finish();
    await reconnect;
    assert.equal(stage.runtime.session.connected, true);

    // ChangeRealm puts the CANCEL dialog up; its button is the same StatusDialogClick and ends it.
    stage.runtime.session.changeRealm(1, 1);
    stage.lua("StatusDialogClick(); return 1");
    assert.equal(stage.aborted(), 1);
    assert.equal(stage.lua("return SEEN[#SEEN]"), "OPEN_REALM_LIST");
  } finally {
    stage.runtime.close();
  }
});

test("a session with no connection in flight ignores StatusDialogClick", () => {
  const events = [];
  const session = new GlueSession({ fireEvent: (event) => events.push(event) });
  session.cancelPending();
  assert.deepEqual(events, []);
});
