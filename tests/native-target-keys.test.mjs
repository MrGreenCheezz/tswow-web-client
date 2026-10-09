import assert from "node:assert/strict";
import test from "node:test";
import { isolatedModule } from "./fixtures/isolated-ui.mjs";

// WORK_PLAN 3.11 (lane L2): the TARGETING rows of Bindings.xml still missing after 02.10 —
// TARGETNEARESTFRIEND/PREVIOUSFRIEND (Ctrl+Tab, Ctrl+Shift+Tab), TARGETNEARESTENEMYPLAYER/PREVIOUS…,
// TARGETNEARESTFRIENDPLAYER/PREVIOUS…, TARGETLASTHOSTILE (G, held by interact until 0.4g) and
// TARGETLASTTARGET — over game/Targeting.ts, and ASSISTTARGET's AssistUnit("target") as Wow.exe
// 0x525eb0 runs it: ERR_GENERIC_NO_TARGET without a target, the assistAttack CVar's swing.
const UPDATE = await import("../dist/code/generated/updateFields.js");
const fields = await import("../dist/code/world/Fields.js");
const bindings = await import("../dist/code/browser/input/Bindings.js");
const stock = await import("../dist/code/browser/input/StockActions.js");
const protocol = await import("../dist/code/world/ActionBarProtocol.js");
const verbs = await import("../dist/code/browser/input/StockVerbs.js");
const modes = await import("../dist/code/browser/game/TargetNearestModes.js");
const { UPDATE_FIELDS } = UPDATE;

const SELF = 1n;
const ENEMY = 30n;
const HEALER = 31n;

test("the missing TARGETING rows join the table with DefaultBindings.wtf's keys", () => {
  const rows = new Map(stock.STOCK_ACTIONS.map((row) => [row.command, row]));
  const expected = {
    TARGETNEARESTFRIEND: "targetNearestFriend", TARGETPREVIOUSFRIEND: "targetPreviousFriend",
    TARGETNEARESTENEMYPLAYER: "targetNearestEnemyPlayer", TARGETPREVIOUSENEMYPLAYER: "targetPreviousEnemyPlayer",
    TARGETNEARESTFRIENDPLAYER: "targetNearestFriendPlayer", TARGETPREVIOUSFRIENDPLAYER: "targetPreviousFriendPlayer",
    TARGETLASTHOSTILE: "targetLastHostile", TARGETLASTTARGET: "targetLastTarget",
  };
  for (const [command, action] of Object.entries(expected)) {
    assert.equal(rows.get(command)?.action, action, command);
    assert.equal(rows.get(command)?.group, "Цель");
  }
  bindings.resetBindings();
  const keys = (action) => [...bindings.DEFAULT_BINDINGS[action]].filter(Boolean);
  assert.deepEqual(keys("targetNearestFriend"), ["Ctrl+Tab"]);
  assert.deepEqual(keys("targetPreviousFriend"), ["Ctrl+Shift+Tab"]);
  assert.deepEqual(keys("targetLastHostile"), [], "G is the interact key here until decision 0.4g");
  assert.equal(stock.STOCK_DEFAULTS_HELD.get("TARGETLASTHOSTILE"), "KeyG");
  for (const action of ["targetLastTarget", "targetNearestEnemyPlayer", "targetPreviousFriendPlayer"]) {
    assert.deepEqual(keys(action), [], `${action} ships unbound, as in the client`);
  }
  assert.equal(bindings.actionFor("Ctrl+Tab"), "targetNearestFriend");
  assert.equal(stock.isStockAction("targetLastTarget"), true);
});

async function harness({ assistAttack = false, settingOn = undefined } = {}) { // DEC-A 3.11: settingOn
  const calls = [];
  const self = { guid: SELF, typeId: 4, fields: new Map() };
  const enemy = { guid: ENEMY, typeId: 3, fields: new Map() };
  const healer = { guid: HEALER, typeId: 4, fields: new Map() };
  healer.fields.set(UPDATE_FIELDS.UNIT_FIELD_TARGET.offset, Number(ENEMY));
  const objects = new Map([[SELF, self], [ENEMY, enemy], [HEALER, healer]]);
  const world = {
    state: { selfGuid: SELF, objects },
    targetGuid: undefined,
    knownSpells: [],
    selectTarget(guid) { calls.push(["select", guid]); this.targetGuid = guid; },
    startAttack() { calls.push(["startAttack", this.targetGuid]); },
    canAttackUnit: (object) => object.guid === ENEMY, // DEC-review 3.11: WorldClient's CanAttack hook (the browser's faction table)
    onSpellStatus(text, error) { calls.push(["status", text, error]); },
  };
  const game = { world, focusGuid: undefined, spells: new Map(), talentData: undefined };
  const settings = { assistAttack };
  const units = {
    get targettarget() {
      const target = world.targetGuid === undefined ? undefined : objects.get(world.targetGuid);
      const guid = target ? fields.unit.target(target) : undefined;
      return guid === undefined || guid === 0n ? undefined : guid;
    },
  };
  let picks = true;
  const actions = await isolatedModule("browser/input/Actions", {
    "../game/Context.js": { game },
    "./Bindings.js": bindings,
    "../../world/ActionBarProtocol.js": protocol,
    "../../world/Fields.js": fields,
    "../../generated/updateFields.js": UPDATE,
    "./StockVerbs.js": verbs,
    "../game/TargetNearestModes.js": modes,
    "../ui/CombatCommands.js": { macroUnitGuid: (token) => units[token] },
    "../ui/Settings.js": { settingOn: settingOn ?? ((id) => settings[id] === true), setSetting: () => true }, // DEC-A 3.11: settingOn
    "../../generated/globalStrings.js": { globalString: (name) => `«${name}»` },
    "../game/Targeting.js": {
      cycleEnemyTarget: (step) => calls.push(["tab", step]),
      setFocusToTarget: () => {},
      targetNearestUnit: (mode, reverse) => { calls.push(["nearest", mode, reverse]); return picks; },
      targetLastUnit: (kind) => { calls.push(["last", kind]); return picks; },
    },
    "../ui/Frames.js": { showTarget: () => calls.push(["showTarget"]), unitDisplayName: () => "" },
  });
  const run = (action) => {
    calls.length = 0;
    return actions.runAction(action);
  };
  return { run, calls, world, settings, setPicks: (value) => { picks = value; } };
}

test("the friend and player keys step the TargetNearest* list in their mode, the PREVIOUS ones backwards", async () => {
  const { run, calls } = await harness();
  const table = [
    ["targetNearestFriend", 3, false], ["targetPreviousFriend", 3, true],
    ["targetNearestEnemyPlayer", 2, false], ["targetPreviousEnemyPlayer", 2, true],
    ["targetNearestFriendPlayer", 4, false], ["targetPreviousFriendPlayer", 4, true],
  ];
  for (const [action, mode, reverse] of table) {
    assert.equal(run(action), true, action);
    assert.deepEqual(calls, [["nearest", mode, reverse], ["showTarget"]], action);
  }
});

test("G and TARGETLASTTARGET ask the history; a key with nothing to select stays unanswered", async () => {
  const { run, calls, setPicks } = await harness();
  assert.equal(run("targetLastHostile"), true);
  assert.deepEqual(calls, [["last", "enemy"], ["showTarget"]]);
  assert.equal(run("targetLastTarget"), true);
  assert.deepEqual(calls, [["last", "target"], ["showTarget"]]);
  setPicks(false);
  assert.equal(run("targetLastHostile"), false);
  assert.equal(run("targetNearestFriend"), false);
});

test("ASSISTTARGET is AssistUnit(\"target\"): no target is ERR_GENERIC_NO_TARGET, assistAttack swings", async () => {
  let h = await harness();
  assert.equal(run(h, "assistTarget"), true, "the error is the key's answer");
  assert.deepEqual(h.calls, [["status", "«ERR_GENERIC_NO_TARGET»", true]]);
  h.world.targetGuid = ENEMY;
  assert.equal(run(h, "assistTarget"), false, "a target with no target of its own: nothing, and no error");
  assert.deepEqual(h.calls, []);
  h.world.targetGuid = HEALER;
  assert.equal(run(h, "assistTarget"), true);
  assert.deepEqual(h.calls, [["select", ENEMY], ["showTarget"]], "assistAttack 0: no swing");
  h = await harness({ assistAttack: true });
  h.world.targetGuid = HEALER;
  assert.equal(run(h, "assistTarget"), true);
  assert.deepEqual(h.calls, [["select", ENEMY], ["showTarget"], ["startAttack", ENEMY]], "assistAttack 1 attacks it (0x6e4950)");
});

function run(h, action) {
  return h.run(action);
}

test("L2-review: ASSISTTARGET with a corpse selected is ERR_GENERIC_NO_TARGET (0x4d4db0 asks for TYPEMASK_UNIT)", async () => {
  const h = await harness();
  // A player's corpse (TYPEID_CORPSE 7) keeps the selection; its fields at UNIT_FIELD_TARGET's offset
  // are CORPSE_FIELD_ITEM display ids, which can read as the guid of someone in sight.
  const CORPSE = 40n;
  const corpse = { guid: CORPSE, typeId: 7, fields: new Map([[UPDATE_FIELDS.UNIT_FIELD_TARGET.offset, Number(HEALER)]]) };
  h.world.state.objects.set(CORPSE, corpse);
  h.world.targetGuid = CORPSE;
  assert.equal(run(h, "assistTarget"), true);
  assert.deepEqual(h.calls, [["status", "«ERR_GENERIC_NO_TARGET»", true]], "no unit selected: the error, and nobody else selected");
});

// DEC-A 3.11 (04.10, owner decision 4): before the assistAttack setting existed, settingOn("assistAttack")
// was always false. Now the stock Combat panel's AttackOnAssist writes it (SetCVar → FrameXmlSettingsCVar)
// and Settings.ts's settingOn (settingBoolean over the stored values) is what ASSISTTARGET reads: the real
// model chain, default "0" (Wow.exe 0x009e14a0) — no swing — and "1" — the swing (0x006e4950).
test("DEC-A 3.11: ASSISTTARGET follows the assistAttack setting the stock checkbox writes", async () => {
  const { defaultSettings, settingBoolean } = await import("../dist/code/browser/ui/SettingsModel.js");
  const { createFrameXmlSettingsCVar } = await import("../dist/code/browser/framexml/FrameXmlSettingsCVar.js");
  let values = defaultSettings();
  const cvars = createFrameXmlSettingsCVar({
    getSettings: () => values,
    setSetting: (id, value) => { values = { ...values, [id]: value }; },
  });
  const h = await harness({ settingOn: (id) => settingBoolean(values, id) });
  h.world.targetGuid = HEALER;
  assert.equal(run(h, "assistTarget"), true);
  assert.deepEqual(h.calls, [["select", ENEMY], ["showTarget"]], "the default: no swing");
  assert.equal(cvars.set("assistAttack", "1"), true, "the stock checkbox's SetCVar");
  h.world.targetGuid = HEALER;
  assert.equal(run(h, "assistTarget"), true);
  assert.deepEqual(h.calls, [["select", ENEMY], ["showTarget"], ["startAttack", ENEMY]], "on: the unit assisted is attacked");
  cvars.set("assistAttack", "0");
  h.world.targetGuid = HEALER;
  run(h, "assistTarget");
  assert.deepEqual(h.calls, [["select", ENEMY], ["showTarget"]], "off again");
});

// DEC-review 3.11 (04.10): as the stock AssistUnit (framexml-targeting-api-seam), the key's assistAttack swing goes
// only at a unit CanAttack accepts — Wow.exe 0x006e4950 → 0x006e2610 asks 0x00729a70 and sends no CMSG_ATTACKSWING
// when it refuses. A mob on the healer (or on the player) is assisted to the healer: selected, not attacked.
test("DEC-review 3.11: ASSISTTARGET with assistAttack swings only at a unit the player may attack", async () => {
  const h = await harness({ assistAttack: true });
  const enemy = h.world.state.objects.get(ENEMY);
  enemy.fields.set(UPDATE_FIELDS.UNIT_FIELD_TARGET.offset, Number(HEALER));
  h.world.targetGuid = ENEMY;
  assert.equal(run(h, "assistTarget"), true);
  assert.deepEqual(h.calls, [["select", HEALER], ["showTarget"]], "a friend: selected, no swing");
  enemy.fields.set(UPDATE_FIELDS.UNIT_FIELD_TARGET.offset, Number(SELF));
  h.world.targetGuid = ENEMY;
  assert.equal(run(h, "assistTarget"), true);
  assert.deepEqual(h.calls, [["select", SELF], ["showTarget"]], "the player himself: selected, no swing");
  h.world.targetGuid = HEALER;
  assert.equal(run(h, "assistTarget"), true);
  assert.deepEqual(h.calls, [["select", ENEMY], ["showTarget"], ["startAttack", ENEMY]], "the healer's enemy: attacked");
});
