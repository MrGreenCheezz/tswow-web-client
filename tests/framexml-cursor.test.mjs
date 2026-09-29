import assert from "node:assert/strict";
import test from "node:test";

// The one FrameXML cursor (FrameXmlCursor.ts): spells from the book, actions lifted off a bar, bag
// items and items by id placed on a bar through CMSG_SET_ACTION_BUTTON, the stock swap, the grid
// events ActionButton.lua counts, and GetActionInfo. Canned and live seams, no client data.
const { CannedWorldSeam, CANNED_ACTION_BAR } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { createFrameXmlMemoryMacroStore } = await import("../dist/code/browser/framexml/FrameXmlMacro.js");
const { ACTION_BUTTON_ITEM, ACTION_BUTTON_MACRO, ACTION_BUTTON_SPELL } = await import("../dist/code/world/ActionBarProtocol.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

const call = (seam, name, ...args) => [...FRAMEXML_SEAM_BINDINGS[name](seam, args)];
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function pump() {
  const events = [];
  return { events, now: () => 100, fire(event, ...args) { events.push([event, ...args]); return 0; } };
}

function canned() {
  const seam = new CannedWorldSeam(CANNED_ACTION_BAR);
  const events = pump();
  seam.attach(events);
  events.events.length = 0;
  return { seam, events: events.events };
}

const names = (events) => events.map(([event]) => event)
  .filter((event) => event === "CURSOR_UPDATE" || event.startsWith("ACTIONBAR_SHOWGRID")
    || event.startsWith("ACTIONBAR_HIDEGRID") || event === "ACTIONBAR_SLOT_CHANGED");

test("a spell from the book goes on a bar slot; what was there comes up on the cursor", async () => {
  const { seam, events } = canned();
  call(seam, "PickupSpell", 3, "spell");
  assert.deepEqual(call(seam, "GetCursorInfo"), ["spell", 3, "spell"], "stock shape: slot and book type");
  assert.deepEqual(call(seam, "CursorHasSpell"), [true]);
  assert.deepEqual(call(seam, "CursorHasItem"), [false]);
  await settle();
  assert.deepEqual(names(events), ["CURSOR_UPDATE", "ACTIONBAR_SHOWGRID"]);
  events.length = 0;

  call(seam, "PlaceAction", 12);
  assert.deepEqual(call(seam, "GetActionInfo", 12), ["spell", 3, "spell", 7384], "slot 12 holds the book's third spell");
  assert.deepEqual(call(seam, "GetActionTexture", 12), ["Interface\\Icons\\Ability_MeleeDamage"]);
  assert.deepEqual(call(seam, "GetCursorInfo"), ["spell", 11, "spell"], "Глухая оборона came up: the swap");
  await settle();
  assert.deepEqual(events.filter(([event]) => event === "ACTIONBAR_SLOT_CHANGED"), [["ACTIONBAR_SLOT_CHANGED", 12]]);
  assert.equal(events.some(([event]) => event.includes("GRID")), false, "still holding: the grid stays up");
  events.length = 0;

  call(seam, "ClearCursor");
  assert.deepEqual(call(seam, "GetCursorInfo"), []);
  await settle();
  assert.deepEqual(names(events), ["CURSOR_UPDATE", "ACTIONBAR_HIDEGRID"]);
  // The book did not lose the spell that left the bar, and a cast from it still works.
  assert.deepEqual(call(seam, "GetSpellName", 11, "spell"), ["Глухая оборона", ""]);
  call(seam, "CastSpell", 11, "spell");
  assert.deepEqual(seam.castSpellIds, [871]);
});

test("PickupAction lifts and empties the slot; dropping it back, or a press with it held, places it", async () => {
  const { seam } = canned();
  call(seam, "PickupAction", 1);
  assert.deepEqual(call(seam, "HasAction", 1), [false], "the slot was emptied");
  assert.deepEqual(call(seam, "GetCursorInfo"), ["spell", 1, "spell"]);
  // UseAction is what a click on an action button reaches (SECURE_ACTIONS.action): it places.
  call(seam, "UseAction", 2, "", "LeftButton");
  assert.deepEqual(call(seam, "GetActionInfo", 2), ["spell", 1, "spell", 78]);
  assert.deepEqual(call(seam, "GetCursorInfo"), ["spell", 2, "spell"], "Кровопускание came up");
  assert.deepEqual(seam.castSpellIds, [], "nothing was cast by the press");
  call(seam, "PlaceAction", 1);
  assert.deepEqual(call(seam, "GetActionInfo", 1), ["spell", 2, "spell", 772]);
  assert.deepEqual(call(seam, "GetCursorInfo"), [], "an empty slot gives nothing back");
  // Dropping an action onto the slot that already holds it: nothing moves, the hand is empty.
  call(seam, "PickupSpell", 2, "spell");
  call(seam, "PlaceAction", 1);
  assert.deepEqual(call(seam, "GetActionInfo", 1), ["spell", 2, "spell", 772]);
  assert.deepEqual(call(seam, "GetCursorInfo"), []);
  // With nothing held the press is the button's own.
  call(seam, "UseAction", 1);
  assert.deepEqual(seam.castSpellIds, []);
  assert.equal(call(seam, "GetActionCooldown", 1)[2], 1, "the canned press started its cooldown");
});

test("an item by id or link goes on a bar as an item action; a pet action never does", async () => {
  const { seam } = canned();
  call(seam, "PickupItem", "|cffffffff|Hitem:13446:0:0:0:0:0:0:0:0|h[Зелье]|h|r");
  assert.deepEqual(call(seam, "GetCursorInfo").slice(0, 2), ["item", 13446]);
  assert.deepEqual(call(seam, "CursorHasItem"), [true]);
  call(seam, "PlaceAction", 20);
  assert.deepEqual(call(seam, "GetActionInfo", 20), ["item", 13446]);
  assert.deepEqual(call(seam, "GetActionTexture", 20), ["Interface\\Icons\\INV_Potion_54"]);
  assert.deepEqual(call(seam, "GetCursorInfo"), []);
  call(seam, "PickupPetAction", 3);
  assert.deepEqual(call(seam, "GetCursorInfo"), ["petaction", 3]);
  call(seam, "PlaceAction", 21);
  assert.deepEqual(call(seam, "HasAction", 21), [false], "the main bars refuse a pet action");
  assert.deepEqual(call(seam, "GetCursorInfo"), ["petaction", 3], "and it stays held");
  call(seam, "PickupPetAction", 3);
  assert.deepEqual(call(seam, "GetCursorInfo"), [], "the pet bar's second pickup is the drop");
});

test("the cursor picture follows what is held, across holders", () => {
  const { seam } = canned();
  const pictures = [];
  seam.cursor.onPicture((texture) => pictures.push(texture));
  call(seam, "PickupSpell", 1, "spell");
  call(seam, "PickupMacro", 1);
  call(seam, "ClearCursor");
  assert.deepEqual(pictures, ["Interface\\Icons\\Ability_Rogue_Ambush", "Interface\\Icons\\Ability_Warrior_Charge", undefined]);
});

function live({ spells = new Map() } = {}) {
  const sent = [];
  const handlers = new Map();
  const casts = [];
  const world = {
    state: { selfGuid: 1n, objects: new Map([[1n, { guid: 1n, typeId: 4, fields: new Map() }]]) },
    knownSpells: [...spells.keys()].map((id, slot) => ({ id, slot })),
    actionButtons: [{ slot: 0, action: 133, type: ACTION_BUTTON_SPELL }],
    casts: new Map(), cooldownSnapshots: new Map(), itemCooldowns: new Map(), mirrorTimers: new Map(), itemTemplates: new Map(),
    cooldownRemaining: () => 0, cooldownState: () => undefined, isActiveMountSpell: () => false,
    setActionButton(slot, action, type) {
      sent.push([slot, action, type]);
      world.actionButtons = [...world.actionButtons.filter((button) => button.slot !== slot),
        ...(action === 0 ? [] : [{ slot, action, type }])];
    },
    events: { on(name, handler) { handlers.set(name, handler); return () => {}; } },
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: (id) => spells.get(id),
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: (id) => casts.push(id),
    macroStore: createFrameXmlMemoryMacroStore([{ index: 2, name: "Танец", body: "/dance" }]),
    itemTexture: (entry) => entry === 13446 ? "Interface\\Icons\\INV_Potion_54" : undefined,
    spellTabs: () => [["Общий", "", 0, spells.size, 0, spells.size]],
    spellTabFor: (id) => spells.has(id) ? 1 : undefined,
  });
  return { seam, world, sent, handlers, casts };
}

const spell = (id, name, extra = {}) => [id, {
  id, name, rank: "", iconPath: `Interface\\Icons\\S${id}`, passive: false, hidden: false, ...extra,
}];

test("live: a bag item placed on a bar sends its entry as an item action and stays in its bag", async () => {
  const { seam, world, sent } = live();
  const events = pump();
  seam.attach(events);
  const player = world.state.objects.get(1n);
  player.fields.set(UPDATE_FIELDS.PLAYER_FIELD_PACK_SLOT_1.offset, 2);
  player.fields.set(UPDATE_FIELDS.PLAYER_FIELD_PACK_SLOT_1.offset + 1, 0);
  world.state.objects.set(2n, { guid: 2n, typeId: 1, fields: new Map([[UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 13446]]) });
  events.events.length = 0;
  call(seam, "PickupContainerItem", 0, 1);
  assert.deepEqual(call(seam, "GetCursorInfo").slice(0, 2), ["item", 13446]);
  assert.equal(seam.cursor.picture(), "Interface\\Icons\\INV_Potion_54");
  await settle();
  assert.ok(events.events.some(([event]) => event === "ACTIONBAR_SHOWGRID"), "a held item shows the empty slots");
  events.events.length = 0;
  call(seam, "PlaceAction", 5);
  assert.deepEqual(sent, [[4, 13446, ACTION_BUTTON_ITEM]], "CMSG_SET_ACTION_BUTTON: wire slot 4, item 0x80");
  assert.deepEqual(call(seam, "CursorHasItem"), [false], "the item left the cursor, not the bag");
  assert.equal(world.state.objects.has(2n), true);
  await settle();
  assert.ok(events.events.some(([event]) => event === "ACTIONBAR_HIDEGRID"));
  assert.deepEqual(call(seam, "GetActionInfo", 5), ["item", 13446]);
  seam.detach();
});

test("live: a macro placed over a spell swaps, a passive spell is never picked up, a press with a spell places it", () => {
  const spells = new Map([spell(133, "Огненный шар"), spell(6117, "Доспех", { passive: true })]);
  const { seam, sent, casts } = live({ spells });
  call(seam, "PickupMacro", 1);
  call(seam, "UseAction", 1);
  assert.deepEqual(sent, [[0, 2, ACTION_BUTTON_MACRO]]);
  assert.deepEqual(call(seam, "GetCursorInfo"), ["spell", 1, "spell"], "the fireball the macro displaced");
  assert.deepEqual(casts, []);
  call(seam, "UseAction", 3);
  assert.deepEqual(sent.at(-1), [2, 133, ACTION_BUTTON_SPELL]);
  call(seam, "PickupSpell", 2, "spell");
  assert.deepEqual(call(seam, "GetCursorInfo"), [], "the passive stays in the book");
  call(seam, "PickupAction", 3);
  assert.deepEqual(sent.at(-1), [2, 0, 0], "the lifted slot is emptied on the server");
  call(seam, "ClearCursor");
  assert.deepEqual(call(seam, "HasAction", 3), [false], "an action let go of is gone, as in the client");
});

test("live: LEARNED_SPELL_IN_TAB names the tab stock concatenates", () => {
  const spells = new Map([spell(133, "Огненный шар")]);
  const { seam, handlers } = live({ spells });
  const events = pump();
  seam.attach(events);
  events.events.length = 0;
  handlers.get("SPELL_LEARNED")({ spellId: 133 });
  assert.deepEqual(events.events.filter(([event]) => event === "LEARNED_SPELL_IN_TAB"), [["LEARNED_SPELL_IN_TAB", 1]]);
  seam.detach();
});
