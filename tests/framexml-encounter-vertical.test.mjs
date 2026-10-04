import assert from "node:assert/strict";
import test, { after } from "node:test";

// Plan item 3.16, MPQ-backed: the client's own TargetFrame.xml/.lua Boss1TargetFrame…Boss4TargetFrame
// over the live seam. SMSG_UPDATE_INSTANCE_ENCOUNTER_UNIT (the world's ENCOUNTER_FRAME) becomes
// INSTANCE_ENCOUNTER_ENGAGE_UNIT, whose stock handler (TargetFrame.lua:158-163) runs
// TargetFrame_Update for each boss frame over the boss1…boss4 tokens.

let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const skip = clientDirectory ? false : "no 3.3.5a client on this machine";

globalThis.window ??= { devicePixelRatio: 1, innerWidth: 1024, innerHeight: 768, addEventListener() {}, removeEventListener() {} };
globalThis.localStorage ??= { getItem() { return null; }, setItem() {}, removeItem() {} };

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

const decoder = new TextDecoder("utf-8");
let sharedChain;
after(() => sharedChain?.close());

class FakeEvents {
  #listeners = new Map();
  on(name, listener) {
    const listeners = this.#listeners.get(name) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(name, listeners);
    return () => listeners.delete(listener);
  }
  emit(name, payload) { for (const listener of [...(this.#listeners.get(name) ?? [])]) listener(payload); }
}

function lua(boot, code, count = 1) {
  const fn = boot.vm.compileFunction(code, "encounter-test", []);
  assert.ok(fn, "the probe compiles");
  try { return boot.vm.call(fn, [], count); } finally { boot.vm.release(fn); }
}

function unit(guid, typeId, fields) {
  const object = { guid, typeId, fields: new Map() };
  for (const [name, value] of Object.entries(fields)) object.fields.set(UPDATE_FIELDS[name].offset, value);
  return object;
}

test("an engaged boss shows Boss1TargetFrame with its name; a second shows Boss2; disengage hides", { skip }, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const chain = sharedChain ??= await clientArchives(clientDirectory);
  const selfGuid = 0x10n;
  const first = 0xf130000000007285n;
  const second = 0xf130000000007286n;
  const self = unit(selfGuid, 4, { UNIT_FIELD_BYTES_0: 1 | (1 << 8) | (1 << 24), UNIT_FIELD_LEVEL: 80, UNIT_FIELD_HEALTH: 100, UNIT_FIELD_MAXHEALTH: 100 });
  const bossFields = (entry) => ({
    OBJECT_FIELD_ENTRY: entry, UNIT_FIELD_BYTES_0: 1 | (1 << 8), UNIT_FIELD_LEVEL: 83,
    UNIT_FIELD_HEALTH: 400000, UNIT_FIELD_MAXHEALTH: 500000, UNIT_FIELD_FACTIONTEMPLATE: 16,
  });
  const events = new FakeEvents();
  const world = {
    state: { selfGuid, objects: new Map([[selfGuid, self], [first, unit(first, 3, bossFields(29304))], [second, unit(second, 3, bossFields(29305))]]) },
    events, names: new Map(),
    creatureTemplates: new Map([[29304, { found: true, name: "Слад'ран", rank: 3 }], [29305, { found: true, name: "Мураби", rank: 3 }]]),
    partyStats: new Map(), casts: new Map(), actionButtons: [], knownSpells: [], cooldownRemaining: () => 0,
    battlefieldQueues: new Map(),
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, monotonic: () => 10_000, spell: () => undefined,
    globalCooldownUntil: () => 0, castSpell: () => {},
  });
  const boot = new FrameXmlBoot({
    provider: { async read(path) { const data = await chain.read(path); return data ? decoder.decode(data) : undefined; } },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, exercise: false, screen: () => ({ width: 1024, height: 768 }),
  });
  try {
    await boot.load();
    const errors = boot.errorCount;
    const shown = () => lua(boot, `return Boss1TargetFrame:IsShown() and 1 or 0, Boss2TargetFrame:IsShown() and 1 or 0,
      Boss1TargetFrameTextureFrameName:GetText(), Boss2TargetFrameTextureFrameName:GetText()`, 4);
    assert.deepEqual(shown().slice(0, 2), [0, 0], "no boss, no frame");
    events.emit("ENCOUNTER_FRAME", { type: 0, guid: first, param1: 0, param2: 0 });
    const [one, two, name] = shown();
    assert.deepEqual([one, two, name], [1, 0, "Слад'ран"]);
    events.emit("ENCOUNTER_FRAME", { type: 0, guid: second, param1: 0, param2: 0 });
    assert.deepEqual(shown(), [1, 1, "Слад'ран", "Мураби"]);
    events.emit("ENCOUNTER_FRAME", { type: 1, guid: first, param1: 0, param2: 0 });
    assert.deepEqual(shown().slice(0, 3), [1, 0, "Мураби"], "the second moves up into Boss1TargetFrame");
    events.emit("ENCOUNTER_FRAME", { type: 1, guid: second, param1: 0, param2: 0 });
    assert.deepEqual(shown().slice(0, 2), [0, 0]);
    assert.equal(boot.errorCount, errors, "no Lua error on the way");
  } finally {
    boot.close();
  }
});
