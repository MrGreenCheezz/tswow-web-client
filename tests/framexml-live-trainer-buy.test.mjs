import assert from "node:assert/strict";
import test from "node:test";

const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import(
  "../dist/code/browser/framexml/FrameXmlWorldSeam.js",
);
const { WorldClient } = await import("../dist/code/world/WorldClient.js");
const { OPCODES } = await import("../dist/code/generated/opcodes.js");
const { PacketReader } = await import("../dist/code/protocol/PacketReader.js");

function spell(spellId, usable) {
  return {
    spellId, usable, moneyCost: 0, pointCost: [0, 0], requiredLevel: 0,
    requiredSkillLine: 0, requiredSkillRank: 0, requiredAbilities: [0, 0, 0],
  };
}

test("live Trainer C-API binding sends the selected visible spell ID through WorldClient", () => {
  const sent = [];
  const world = new WorldClient({
    send(opcode, payload = new Uint8Array()) { sent.push({ opcode, payload }); },
    close() {},
  });
  const guid = 0x123456789n;
  world.trainer = {
    guid, trainerType: 0, greeting: "Welcome",
    spells: [spell(100, 2), spell(200, 0), spell(300, 1), spell(400, 0)],
  };
  const seam = new LiveWorldSeam({
    world: () => world,
    store: () => undefined,
    spell: (id) => ({ id, name: `Spell ${id}`, rank: "", description: "", iconPath: "" }),
    monotonic: () => 0,
    globalCooldownUntil: () => 0,
    castSpell: () => {},
  });
  const call = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);

  try {
    assert.deepEqual(call("GetTrainerServiceTypeFilter", "used"), [false],
      "the original Blizzard_TrainerUI hides learned services by default");
    assert.deepEqual(call("GetNumTrainerServices"), [3]);
    call("SetTrainerServiceTypeFilter", "used", true);
    assert.deepEqual(call("GetNumTrainerServices"), [4]);
    call("BuyTrainerService", 1);
    call("BuyTrainerService", 3);
    assert.equal(sent.length, 0, "known and unavailable rows cannot send training requests");

    call("SetTrainerServiceTypeFilter", "used", false);
    call("SetTrainerServiceTypeFilter", "unavailable", false);
    assert.deepEqual(call("GetNumTrainerServices"), [2]);
    assert.deepEqual(call("GetTrainerServiceInfo", 2), ["Spell 400", "", "available", true]);
    call("BuyTrainerService", 2);
    call("BuyTrainerService", 3);

    const buys = sent.filter(({ opcode }) => opcode === OPCODES.CMSG_TRAINER_BUY_SPELL);
    assert.equal(buys.length, 1, "only the selected available visible row is sent");
    const payload = new PacketReader(buys[0].payload);
    assert.equal(payload.u64(), guid);
    assert.equal(payload.i32(), 400, "the packet carries the spell ID, not the 1-based UI row");
    payload.assertFinished();
  } finally {
    world.close();
  }
});

test("12.10: a trainer service's description is written through the description writer (Wow.exe 0x005959d0)", () => {
  const world = new WorldClient({ send() {}, close() {} });
  world.trainer = { guid: 1n, trainerType: 0, greeting: "", spells: [spell(133, 0)] }; // 0: available, shown
  const fireball = {
    id: 133, name: "Огненный шар", rank: "", iconPath: "",
    description: "Наносит $s1 ед. урона от огня.",
    effectBasePoints: [13, 0, 0], effectDieSides: [9, 1, 0], effectPeriod: [0, 0, 0],
    effectChainTargets: [0, 0, 0], effectRadius: [0, 0, 0], duration: 0, maxDuration: 0, procChance: 100,
  };
  const seam = new LiveWorldSeam({
    world: () => world,
    store: () => undefined,
    spell: (id) => (id === 133 ? fireball : undefined),
    monotonic: () => 0,
    globalCooldownUntil: () => 0,
    castSpell: () => {},
  });
  try {
    const [text] = FRAMEXML_SEAM_BINDINGS.GetTrainerServiceDescription(seam, [1]);
    assert.ok(!text.includes("$"), text);
    assert.match(text, /^Наносит 14\D+22 ед\. урона от огня\.$/);
  } finally {
    world.close();
  }
});
