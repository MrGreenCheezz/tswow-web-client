import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { dbcDirectory } from "../tools/paths.mjs";
import { startGateway } from "../dist/code/gateway/Gateway.js";
import {
  loadWorldStateUiMetadata, parseWorldStateUiMetadata,
} from "../dist/code/gateway/WorldStateUiMetadata.js";
import {
  formatWorldStateText, isWorldStateUiCatalog,
} from "../dist/code/world/WorldStateUiData.js";
import {
  FrameXmlWorldStates, FRAMEXML_WORLD_STATE_BINDINGS,
} from "../dist/code/browser/framexml/FrameXmlWorldStates.js";

let DBC_PATH;
try {
  DBC_PATH = join(dbcDirectory(), "WorldStateUI.dbc");
  await access(DBC_PATH);
} catch {
  DBC_PATH = undefined;
}
const withDbc = { skip: DBC_PATH ? false : "no local 3.3.5a WorldStateUI.dbc dataset" };

test("world-state UI gateway serves localized DBC rows only to an allowed origin", withDbc, async () => {
  const gateway = await startGateway({
    host: "127.0.0.1", port: 0,
    auth: { host: "127.0.0.1", port: 1 },
    world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: ["http://localhost:5173"],
    dbcDirectory: dbcDirectory(),
  });
  try {
    const url = `http://127.0.0.1:${gateway.port}/dbc/world-state-ui`;
    for (const origin of [undefined, "http://untrusted.example"]) {
      const refused = await fetch(url, origin ? { headers: { origin } } : undefined);
      assert.equal(refused.status, 403);
      await refused.arrayBuffer();
    }
    const response = await fetch(url, { headers: { origin: "http://localhost:5173" } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:5173");
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    const rows = await response.json();
    assert.equal(isWorldStateUiCatalog(rows), true);
    assert.equal(rows.length, (await loadWorldStateUiMetadata(dbcDirectory())).length);
    const capture = rows.find((row) => row.id === 139);
    assert.deepEqual({ map: capture?.mapId, area: capture?.areaId, state: capture?.stateVariable,
      ui: capture?.extendedUi, vars: capture?.extendedVariables },
    { map: 530, area: 3483, state: 2473, ui: "CAPTUREPOINT", vars: [2474, 2475, 0] });
    assert.equal(capture.text, "Состояние: %2427w",
      "the selected ruRU display string survives the live metadata route");
  } finally {
    await gateway.close();
  }
});

test("actual 3.3.5a WorldStateUI.dbc follows TSWoW's 63-column layout", withDbc, async () => {
  const payload = await readFile(DBC_PATH);
  assert.equal(payload.toString("ascii", 0, 4), "WDBC");
  assert.equal(payload.readUInt32LE(8), 63);
  assert.equal(payload.readUInt32LE(12), 252);
  const rows = parseWorldStateUiMetadata(payload);
  assert.equal(rows.length, payload.readUInt32LE(4));
  assert.ok(rows.length >= 100);
  assert.equal(isWorldStateUiCatalog(rows), true);

  const capture = rows.find((row) => row.id === 139);
  assert.ok(capture);
  assert.deepEqual({ map: capture.mapId, area: capture.areaId, phase: capture.phaseMask,
    state: capture.stateVariable, type: capture.type, ui: capture.extendedUi,
    variables: capture.extendedVariables },
  { map: 530, area: 3483, phase: 0, state: 2473, type: 1,
    ui: "CAPTUREPOINT", variables: [2474, 2475, 0] });
  assert.match(capture.text, /%2427w/,
    "this authored display token is unrelated to the capture bar's required variables");
  const reinforcement = rows.find((row) => row.id === 180);
  assert.ok(reinforcement);
  assert.equal(reinforcement.mapId, 30);
  assert.equal(reinforcement.stateVariable, 3134);
  assert.match(reinforcement.text, /%3127w/);
  assert.ok(reinforcement.icon.includes("UI-PVP-Alliance"));
  assert.equal((await loadWorldStateUiMetadata(dbcDirectory())).length, rows.length);
});

test("WorldStateUI parser rejects corrupt shapes, string pointers, and duplicate IDs", withDbc, async () => {
  const payload = await readFile(DBC_PATH);
  const damaged = (change) => { const bytes = Buffer.from(payload); change(bytes); return bytes; };
  assert.throws(() => parseWorldStateUiMetadata(payload.subarray(0, 19)), /not WDBC/);
  assert.throws(() => parseWorldStateUiMetadata(damaged((bytes) => bytes.writeUInt32LE(62, 8))),
    /invalid 3\.3\.5a shape/);
  assert.throws(() => parseWorldStateUiMetadata(damaged((bytes) => bytes.writeUInt32LE(10001, 4))),
    /invalid 3\.3\.5a shape/);
  assert.throws(() => parseWorldStateUiMetadata(Buffer.concat([payload, Buffer.from([0])])),
    /invalid 3\.3\.5a shape/);
  assert.throws(() => parseWorldStateUiMetadata(damaged((bytes) => {
    bytes.writeUInt32LE(bytes.readUInt32LE(16), 20 + 16);
  })), /invalid string offset/);
  assert.throws(() => parseWorldStateUiMetadata(damaged((bytes) => {
    bytes.writeInt32LE(bytes.readInt32LE(20), 20 + 252);
  })), /duplicate/);
  assert.equal(isWorldStateUiCatalog([{...parseWorldStateUiMetadata(payload)[0], extendedVariables: [1, 2]}]), false);
});

test("WorldStateUI rows respect map, zone/area, phase, known values and capture dependencies", withDbc, async () => {
  const catalog = await loadWorldStateUiMetadata(dbcDirectory());
  const capture = catalog.find((row) => row.id === 139);
  const tower = catalog.find((row) => row.id === 140);
  const phase = catalog.find((row) => row.id === 220);
  assert.ok(capture && tower && phase);
  const states = new Map([
    [2473, 1], [2474, 63], [2475, 20], // stock capture bar; no unrelated 2427
    [2490, 1], [2476, 2], // stock tower objective and its displayed count
    [3878, 1],
  ]);
  const snapshot = { mapId: 530, zoneId: 3483, areaId: 9999, phaseMask: 1, states };
  const resolver = new FrameXmlWorldStates(() => [capture, tower, phase], () => snapshot);
  assert.deepEqual(resolver.rows(), [
    [1, 1, "", "", "", "", "", "CAPTUREPOINT", 63, 20, 0],
    [1, 1, tower.text.replace("%2476w", "2"), tower.icon, tower.dynamicIcon,
      tower.tooltip, tower.dynamicTooltip, "", 0, 0, 0],
  ], "zone match displays authored objectives; a missing unused capture label does not remove its bar");
  assert.deepEqual(FRAMEXML_WORLD_STATE_BINDINGS.GetNumWorldStateUI({ worldStates: resolver }), [2]);
  assert.deepEqual(FRAMEXML_WORLD_STATE_BINDINGS.GetWorldStateUIInfo({ worldStates: resolver }, [1]), resolver.rows()[0]);
  assert.deepEqual(FRAMEXML_WORLD_STATE_BINDINGS.GetWorldStateUIInfo({ worldStates: resolver }, [3]), []);
  assert.deepEqual(FRAMEXML_WORLD_STATE_BINDINGS.GetWorldStateUIInfo({ worldStates: resolver }, [0]), []);

  states.delete(2475);
  assert.equal(resolver.rows().length, 1, "a missing capture width cannot become invented zero");
  states.set(2475, 20);
  states.delete(2476);
  assert.equal(resolver.rows().length, 1, "a visible label with an absent variable is withheld");
  states.delete(2473);
  assert.deepEqual(resolver.rows(), [], "an absent state variable is not an active objective");
  states.set(2473, 0);
  assert.deepEqual(resolver.rows(), [], "zero disables the objective in stock Lua");
  states.set(2473, 1);
  snapshot.mapId = 0;
  snapshot.zoneId = 0;
  snapshot.phaseMask = 1;
  assert.deepEqual(resolver.rows(), [], "wrong map, area and phase hide the authored objectives");
  snapshot.phaseMask = 64;
  assert.equal(resolver.rows().length, 1, "a matching phase bit admits the phase-specific row");
  snapshot.phaseMask = 128;
  assert.deepEqual(resolver.rows(), [], "a different phase does not leak a phase-specific row");
  snapshot.mapId = 530;
  snapshot.zoneId = 9999;
  snapshot.areaId = 3483;
  assert.equal(resolver.rows().length, 1, "sub-area ID can match when zone ID does not");
});

test("world-state text and signatures advance on a real timer without emitting duplicate frames", () => {
  const row = { id: 1, mapId: -1, areaId: 0, phaseMask: 0,
    icon: "", text: "Score %10w, remaining %20k", tooltip: "", stateVariable: 1,
    type: 0, dynamicIcon: "", dynamicTooltip: "", extendedUi: "", extendedVariables: [0, 0, 0] };
  const states = new Map([[1, 1], [10, 7], [20, 1_060]]);
  const snapshot = { mapId: 571, zoneId: 4197, areaId: 4197,
    phaseMask: 1, states, serverTime: 1_000 };
  const resolver = new FrameXmlWorldStates(() => [row], () => snapshot);
  const events = [];
  resolver.attach({ fire(event) { events.push(event); return 1; }, now: () => 0 });
  assert.deepEqual(resolver.rows()[0].slice(0, 3), [0, 1, "Score 7, remaining 1:00"]);
  assert.deepEqual(events, ["UPDATE_WORLD_STATES"]);
  resolver.tick();
  assert.equal(events.length, 1);
  snapshot.serverTime = 1_001;
  resolver.tick();
  assert.equal(events.length, 2, "timer text changed by one server second");
  assert.equal(resolver.rows()[0][2], "Score 7, remaining 0:59");
  states.set(10, 8);
  resolver.tick();
  assert.equal(events.length, 3, "state text changes trigger an original UI refresh");
  states.delete(20);
  resolver.tick();
  assert.deepEqual(resolver.rows(), [], "an unknown deadline is not a fabricated countdown");
  assert.equal(events.length, 4);
  resolver.detach();
  resolver.tick();
  assert.equal(events.length, 4);
  assert.equal(formatWorldStateText("%10w", new Map(), undefined), undefined);
  assert.equal(formatWorldStateText("%20k", states, undefined), undefined);
});

test("stock MPQ WorldStateFrame.lua paints and updates a capture bar from DBC state", withDbc, async (t) => {
  let client;
  try {
    const { clientDirectory } = await import("../tools/paths.mjs");
    client = clientDirectory();
  } catch {
    t.skip("no local 3.3.5a client");
    return;
  }
  const { openClientArchives } = await import("../tools/mpq.mjs");
  const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
  const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
  const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
  const catalog = await loadWorldStateUiMetadata(dbcDirectory());
  const capture = catalog.find((row) => row.id === 139);
  const tower = catalog.find((row) => row.id === 140);
  assert.ok(capture && tower);
  const states = new Map();
  const snapshot = { mapId: 530, zoneId: 3483, areaId: 3483, phaseMask: 1, states };
  const worldStates = new FrameXmlWorldStates(() => [capture, tower], () => snapshot);
  const chain = await openClientArchives(client);
  const seam = new CannedWorldSeam();
  seam.worldStates = worldStates;
  const end = FRAMEXML_VERTICAL_TOC.indexOf("WorldStateFrame.xml");
  assert.ok(end > 0);
  const boot = new FrameXmlBoot({
    provider: { async read(path) {
      const bytes = await chain.read(path.replaceAll("/", "\\"));
      return bytes ? new TextDecoder().decode(bytes) : undefined;
    } },
    locale: "ruRU", seam, subset: FRAMEXML_VERTICAL_TOC.slice(0, end + 1),
    screen: () => ({ width: 1024, height: 768 }),
  });
  try {
    const inventory = await boot.load();
    assert.equal(inventory.files.missing.length, 0);
    assert.ok(inventory.files.total > end + 1, "XML includes its stock relative Lua and templates");
    assert.equal(inventory.lua.failed, 0);
    assert.deepEqual(inventory.errors.filter((error) =>
      error.file.toLowerCase().includes("worldstateframe")), [],
    "the stock owner initializes without a WorldStateFrame Lua error");
    const before = boot.errorCount;
    boot.vm.setGlobal("WORLD_PVP_OBJECTIVES_DISPLAY", "1");
    const frame = (name) => boot.bridge.getFrame(name);
    assert.ok(frame("WorldStateAlwaysUpFrame"));
    states.set(2473, 1);
    states.set(2474, 63);
    states.set(2475, 20);
    states.set(2490, 1);
    states.set(2476, 2);
    worldStates.tick();
    assert.equal(frame("WorldStateCaptureBar1")?.visible, true,
      "the original Lua creates its CAPTUREPOINT template from three authoritative variables");
    assert.equal(frame("AlwaysUpFrame1")?.visible, true);
    assert.equal(frame("AlwaysUpFrame1Text")?.text, tower.text.replace("%2476w", "2"));
    assert.equal(boot.errorCount, before, "stock event handling does not raise");
    states.set(2474, 70);
    worldStates.tick();
    assert.equal(frame("WorldStateCaptureBar1IndicatorLeft")?.visible, true,
      "the original CaptureBar_Update sees the server's changing capture percentage");
    states.set(2473, 0);
    states.set(2490, 0);
    worldStates.tick();
    assert.equal(frame("WorldStateCaptureBar1")?.visible, false);
    assert.equal(frame("AlwaysUpFrame1")?.visible, false);
    assert.equal(boot.errorCount, before);
  } finally {
    boot.close();
    await chain.close();
  }
});
