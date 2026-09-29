import assert from "node:assert/strict";
import test from "node:test";

// PetStableFrame's C API without a corpus: the model over the canned stable master, the slot
// mapping of MSG_LIST_STABLED_PETS, the moves' packets (NPCHandler.cpp) and the binding table.
const {
  FRAMEXML_STABLE_BINDINGS, FRAMEXML_STABLE_UNKNOWN_ICON, frameXmlHunterPet, frameXmlStableSlotPet,
} = await import("../dist/code/browser/framexml/FrameXmlStable.js");
const canned = await import("../dist/code/browser/framexml/FrameXmlStableCanned.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

function published() {
  const { world, model } = canned.createCannedFrameXmlStable();
  const fired = [];
  model.attach({ fire: (event, ...args) => { fired.push(args.length ? `${event}:${args.join(",")}` : event); return 1; } });
  model.useGlobalStrings((name) => ({ ERR_NOT_ENOUGH_MONEY: "У вас недостаточно денег.",
    PETTAME_CANTCONTROLEXOTIC: "Вы не можете управлять экзотическими существами." })[name]);
  model.owned = true;
  return { world, model, fired };
}

const call = (host, name, ...args) => FRAMEXML_STABLE_BINDINGS[name](host, args);

test("the list's slots: the pet that is out is 0, the stabled ones 1.. in list order", () => {
  const list = canned.FRAMEXML_CANNED_STABLE_LIST;
  assert.equal(frameXmlStableSlotPet(list, 0).petNumber, 7);
  assert.equal(frameXmlStableSlotPet(list, 1).petNumber, 3);
  assert.equal(frameXmlStableSlotPet(list, 2).petNumber, 5);
  assert.equal(frameXmlStableSlotPet(list, 3), undefined);
  assert.equal(frameXmlStableSlotPet(list, 5), undefined);
  assert.equal(frameXmlStableSlotPet({ ...list, pets: list.pets.slice(1) }, 0), undefined, "no pet out");
});

test("a master's list raises PET_STABLE_SHOW once; the C API answers only while it is open", () => {
  const { world, model, fired } = published();
  const host = { stable: model };
  assert.deepEqual(call(host, "GetStablePetInfo", 1), [], "nothing open");
  assert.deepEqual(call(host, "GetNumStableSlots"), [0]);
  assert.deepEqual(call(host, "GetSelectedStablePet"), [-1]);
  world.open();
  assert.deepEqual(fired, ["PET_STABLE_SHOW"]);
  assert.deepEqual(call(host, "GetNumStableSlots"), [3]);
  assert.deepEqual(call(host, "GetNumStablePets"), [2]);
  assert.deepEqual(call(host, "GetNextStableSlotCost"), [100000], "StableSlotPrices row 4 for the fourth slot");
  assert.deepEqual(call(host, "GetStablePetInfo", 0),
    ["Interface\\Icons\\Ability_Hunter_Pet_Wolf", "Боевой питомец", 60, "Волк", "Свирепость"]);
  assert.deepEqual(call(host, "GetStablePetInfo", 2),
    ["Interface\\Icons\\Ability_Hunter_Pet_Spider", "Паучок", 18, "Паук", "Хитрость"]);
  assert.deepEqual(call(host, "GetStablePetInfo", 3), [], "a bought, empty slot");
  assert.deepEqual(call(host, "IsAtStableMaster"), [true]);
  assert.deepEqual(call(host, "GetPetIcon"), ["Interface\\Icons\\Ability_Hunter_Pet_Wolf"]);
  assert.deepEqual(call(host, "GetPetTalentTree"), ["Свирепость"]);
  world.open();
  assert.deepEqual(fired, ["PET_STABLE_SHOW"], "the same roster again raises nothing");
});

test("a pet whose template has not answered shows the unknown icon, then updates", () => {
  const { world, model, fired } = published();
  world.uncached.add(681);
  world.open();
  assert.deepEqual(model.petInfo(1), [FRAMEXML_STABLE_UNKNOWN_ICON, "Полосатик", 42, undefined, undefined],
    "listed, so not empty; the family stays unknown");
  world.cacheCreature(681);
  assert.deepEqual(fired, ["PET_STABLE_SHOW", "PET_STABLE_UPDATE"]);
  assert.equal(model.petInfo(1)[3], "Кошка");
});

test("clicks select; a lifted pet dropped elsewhere is the move's packet", () => {
  const { world, model } = published();
  const host = { stable: model };
  world.open();
  assert.deepEqual(call(host, "ClickStablePet", 2), [true]);
  assert.deepEqual(call(host, "GetSelectedStablePet"), [2]);
  assert.deepEqual(call(host, "ClickStablePet", 4), [], "beyond the three bought slots");
  assert.deepEqual(call(host, "WebClientStablePaperdoll"), [30], "the selected pet's creature");

  // A stabled pet onto the current slot: CMSG_UNSTABLE_PET with its number, a pet out or not.
  call(host, "PickupStablePet", 1);
  assert.deepEqual(call(host, "ClickStablePet", 0), [true]);
  // The current pet onto an occupied slot: CMSG_STABLE_SWAP_PET with that slot's pet.
  call(host, "PickupStablePet", 0);
  call(host, "ClickStablePet", 2);
  // …onto the empty third slot: CMSG_STABLE_PET, which names no slot.
  call(host, "PickupStablePet", 0);
  call(host, "ClickStablePet", 3);
  // Between two stable slots nothing moves; dropped where it was lifted, nothing either.
  call(host, "PickupStablePet", 1);
  call(host, "ClickStablePet", 2);
  call(host, "PickupStablePet", 2);
  call(host, "ClickStablePet", 2);
  // An empty slot cannot be lifted.
  call(host, "PickupStablePet", 3);
  assert.equal(model.lifted, undefined);
  assert.deepEqual(world.calls, [
    { kind: "unstable", petNumber: 3 }, { kind: "swap", petNumber: 5 }, { kind: "stable" },
  ]);
});

test("a purchase needs a known price; a refusal is said in the client's words, success is silent", () => {
  const { world, model, fired } = published();
  const host = { stable: model };
  world.open();
  call(host, "BuyStableSlot");
  assert.deepEqual(world.calls, [{ kind: "buy" }]);
  world.answer(0x01);
  assert.equal(fired.at(-1), "UI_ERROR_MESSAGE:У вас недостаточно денег.", "STABLE_ERR_MONEY");
  world.answer(0x0c);
  assert.equal(fired.at(-1), "UI_ERROR_MESSAGE:Вы не можете управлять экзотическими существами.");
  world.answer(0x06);
  assert.equal(fired.at(-1), "UI_ERROR_MESSAGE:Не удалось", "no client string: the native wording");
  const bought = { ...canned.FRAMEXML_CANNED_STABLE_LIST, stableSlots: 4 };
  const before = fired.length;
  world.answer(0x0a, bought);
  assert.deepEqual(fired.slice(before), ["PET_STABLE_UPDATE"], "the new roster is the answer");
  assert.deepEqual(call(host, "GetNextStableSlotCost"), [0], "full: no price (the 0 sentinel)");
  call(host, "BuyStableSlot");
  assert.equal(world.calls.length, 1, "nothing to buy past four");
});

test("ClosePetStables forgets the master; another master's list is a new PET_STABLE_SHOW", () => {
  const { world, model, fired } = published();
  world.open();
  model.click(1);
  FRAMEXML_STABLE_BINDINGS.ClosePetStables({ stable: model }, []);
  assert.equal(world.stableMasterGuid, 0n);
  assert.deepEqual(fired, ["PET_STABLE_SHOW", "PET_STABLE_CLOSED"]);
  assert.equal(model.selected(), -1);
  world.open();
  world.open({ ...canned.FRAMEXML_CANNED_STABLE_LIST, npcGuid: 0xF1300000E3000999n });
  assert.deepEqual(fired.slice(2), ["PET_STABLE_SHOW", "PET_STABLE_SHOW"]);
  // The world forgets it without an event (closeNpcServices): sync closes.
  world.stableMasterGuid = 0n;
  model.sync();
  assert.equal(fired.at(-1), "PET_STABLE_CLOSED");
});

test("the player's own stable (SPELL_AURA_OPEN_STABLE) is not a stable master", () => {
  const { world, model } = published();
  world.open({ ...canned.FRAMEXML_CANNED_STABLE_LIST, npcGuid: canned.FRAMEXML_CANNED_STABLE_SELF });
  assert.equal(model.isAtStableMaster(), false);
});

test("muted and probed, nothing reaches the world; unowned, nothing is raised", () => {
  const { world, model, fired } = published();
  world.open();
  model.muted(() => { model.pickup(1); model.click(0); model.buySlot(); model.close(); });
  assert.deepEqual(world.calls, []);
  assert.notEqual(world.stableMasterGuid, 0n);
  const probe = { list: { ...canned.FRAMEXML_CANNED_STABLE_LIST, stableSlots: 1 }, pets: new Map(), slotPrice: 9 };
  model.probe(probe, () => {
    assert.equal(model.numSlots(), 1);
    assert.equal(model.nextSlotCost(), 9);
    model.pickup(0);
    model.click(1);
  });
  assert.deepEqual(world.calls, []);
  assert.equal(model.numSlots(), 3, "the probe leaves the world's stable as it was");
  model.owned = false;
  world.open({ ...canned.FRAMEXML_CANNED_STABLE_LIST, npcGuid: 0x99n });
  assert.deepEqual(fired, ["PET_STABLE_SHOW"]);
});

test("without a model the slot count and price stay FrameXmlServices'", () => {
  const services = { stableSlots: () => 2, nextStableSlotCost: () => undefined };
  assert.deepEqual(FRAMEXML_STABLE_BINDINGS.GetNumStableSlots({ services }, []), [2]);
  assert.deepEqual(FRAMEXML_STABLE_BINDINGS.GetNextStableSlotCost({ services }, []), [0]);
  assert.deepEqual(FRAMEXML_STABLE_BINDINGS.GetNumStableSlots({}, []), [0]);
  assert.deepEqual(FRAMEXML_STABLE_BINDINGS.GetSelectedStablePet({}, []), [-1]);
  assert.deepEqual(FRAMEXML_STABLE_BINDINGS.GetStablePetInfo({}, [1]), []);
});

test("HasPetUI's isHunterPet is the pet's UNIT_PET_FLAG_CAN_BE_ABANDONED (UNIT_FIELD_BYTES_2 byte 2)", () => {
  const offset = UPDATE_FIELDS.UNIT_FIELD_BYTES_2.offset;
  const pet = (bytes) => ({ fields: new Map([[offset, bytes]]) });
  assert.equal(frameXmlHunterPet(pet(0x02 << 16)), true, "abandonable: a hunter pet");
  assert.equal(frameXmlHunterPet(pet(0x03 << 16)), true, "renamable too");
  assert.equal(frameXmlHunterPet(pet(0x01 << 8)), false, "another byte");
  assert.equal(frameXmlHunterPet(pet(0)), false, "a warlock's demon");
  assert.equal(frameXmlHunterPet(undefined), false);
});
