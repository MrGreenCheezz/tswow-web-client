// Plan item 1.07: SetActiveTalentGroup casts the activation spell and ACTIVE_TALENT_GROUP_CHANGED
// follows the talent packet (FrameXmlTalentGroup.ts), as the original client does (Wow.exe 0x5c5e70,
// table 0xad05e8; SMSG_TALENTS_INFO handler 0x5c9e50).
import assert from "node:assert/strict";
import test from "node:test";

const { FrameXmlTalentGroupModel, FRAMEXML_TALENT_GROUP_BINDINGS } =
  await import("../dist/code/browser/framexml/FrameXmlTalentGroup.js");
const { TALENT_SPEC_ACTIVATION_SPELLS } = await import("../dist/code/world/TalentSpecSpells.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS, FRAMEXML_SEAM_EVENTS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");

function modelFixture(state) {
  const casts = [];
  const fired = [];
  const talents = { current: state };
  const model = new FrameXmlTalentGroupModel({ talents: () => talents.current, castSpell: (id) => casts.push(id) });
  model.attach({ fire(event, ...args) { fired.push([event, ...args]); return 1; } });
  const call = (...args) => [...FRAMEXML_TALENT_GROUP_BINDINGS.SetActiveTalentGroup({ talentGroup: model }, args)];
  return { model, casts, fired, talents, call };
}

test("the activation spells are the client's table, in group order", () => {
  assert.deepEqual([...TALENT_SPEC_ACTIVATION_SPELLS], [63645, 63644]);
});

test("SetActiveTalentGroup casts the group's spell only for another existing group below 3", () => {
  const { casts, call } = modelFixture({ activeSpec: 0, specCount: 2 });
  assert.deepEqual(call(2), []);
  assert.deepEqual(casts, [63644], "group 2 casts 63644");
  call(1);
  assert.deepEqual(casts, [63644], "the active group casts nothing");
  call("2");
  call(1.6);
  assert.deepEqual(casts, [63644, 63644, 63644], "a numeric string and 1.6 round to group 2");
  for (const refused of [0, -1, 3, 1.4, "x", undefined, Number.NaN]) call(refused);
  assert.equal(casts.length, 3, "outside 1..count, or not a number: nothing");
});

test("with one group or before the first packet nothing is cast", () => {
  const one = modelFixture({ activeSpec: 0, specCount: 1 });
  one.call(2);
  assert.deepEqual(one.casts, []);
  const none = modelFixture(undefined);
  none.call(1);
  none.call(2);
  assert.deepEqual(none.casts, []);
  const second = modelFixture({ activeSpec: 1, specCount: 2 });
  second.call(1);
  second.call(2);
  assert.deepEqual(second.casts, [63645], "from the second group, group 1 casts 63645");
});

test("ACTIVE_TALENT_GROUP_CHANGED carries the new and previous 1-based group once per move", () => {
  const { model, fired, talents } = modelFixture(undefined);
  talents.current = { activeSpec: 0, specCount: 2 };
  model.talentsChanged();
  assert.deepEqual(fired, [], "a first packet with the first group active does not move it");
  talents.current = { activeSpec: 1, specCount: 2 };
  model.talentsChanged();
  model.talentsChanged();
  assert.deepEqual(fired, [["ACTIVE_TALENT_GROUP_CHANGED", 2, 1]]);
  talents.current = { activeSpec: 0, specCount: 2 };
  model.talentsChanged();
  assert.deepEqual(fired.at(-1), ["ACTIVE_TALENT_GROUP_CHANGED", 1, 2]);

  const login = modelFixture(undefined);
  login.talents.current = { activeSpec: 1, specCount: 2 };
  login.model.talentsChanged();
  assert.deepEqual(login.fired, [["ACTIVE_TALENT_GROUP_CHANGED", 2, 0]],
    "the session's first packet reports 0 as the previous group");
});

test("a mount after the packet starts from the known groups", () => {
  const { model, fired, talents } = modelFixture({ activeSpec: 1, specCount: 2 });
  model.talentsChanged();
  assert.deepEqual(fired, []);
  talents.current = { activeSpec: 0, specCount: 2 };
  model.talentsChanged();
  assert.deepEqual(fired, [["ACTIVE_TALENT_GROUP_CHANGED", 1, 2]]);
});

class FakeEvents {
  #listeners = new Map();
  on(name, listener) {
    const listeners = this.#listeners.get(name) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(name, listeners);
    return () => listeners.delete(listener);
  }
  emit(name, payload) {
    for (const listener of [...(this.#listeners.get(name) ?? [])]) listener(payload);
  }
}

test("the live seam casts through its host and fires the edge after PLAYER_TALENT_UPDATE", () => {
  const events = new FakeEvents();
  const talents = (activeSpec) => ({ pet: false, unspentPoints: 0, activeSpec,
    specs: [{ talents: [], glyphs: [] }, { talents: [], glyphs: [] }] });
  const world = {
    state: { selfGuid: undefined, objects: new Map() },
    events,
    casts: new Map(),
    actionButtons: [],
    cooldownRemaining: () => 0,
    talents: talents(0),
  };
  const casts = [];
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: () => undefined,
    monotonic: () => 1000, globalCooldownUntil: () => 0, castSpell: (id) => casts.push(id),
  });
  const fired = [];
  seam.attach({ fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => 100 });
  fired.length = 0;

  assert.deepEqual([...FRAMEXML_SEAM_BINDINGS.SetActiveTalentGroup(seam, [2])], []);
  assert.deepEqual(casts, [63644]);
  FRAMEXML_SEAM_BINDINGS.SetActiveTalentGroup(seam, [1]);
  assert.deepEqual(casts, [63644], "the active group is not cast again");

  world.talents = talents(1);
  events.emit("TALENTS_CHANGED", { pet: false });
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.talentsChanged], ["ACTIVE_TALENT_GROUP_CHANGED", 2, 1]]);
  events.emit("TALENTS_CHANGED", { pet: true });
  events.emit("TALENTS_CHANGED", { pet: false });
  assert.equal(fired.filter(([event]) => event === "ACTIVE_TALENT_GROUP_CHANGED").length, 1,
    "a pet packet or an unchanged group adds no edge");
  seam.detach();
});

test("the canned seam records the cast of its two-group player", () => {
  const seam = new CannedWorldSeam();
  seam.setTalentGroups(2, 1);
  FRAMEXML_SEAM_BINDINGS.SetActiveTalentGroup(seam, [2]);
  assert.deepEqual(seam.talentGroupCasts, [63644]);
});
