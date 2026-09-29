import assert from "node:assert/strict";
import test from "node:test";
import { installFakeUiDocument } from "./fixtures/fake-ui-document.mjs";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { INFINITE_COOLDOWN_CATEGORY, isCooldownOnHold } from "../dist/code/world/SpellProtocol.js";
import { cooldownEventPacket, initialSpellsPacket, settle, travelClient } from "./fixtures/world-packets.mjs";

// 1.26. A spell whose cooldown starts only when its aura ends (Stealth, Prowl, Presence of Mind) is
// held server-side with `CooldownEnd = now + MONTH` (SpellHistory.cpp:298-303). SMSG_INITIAL_SPELLS
// writes anything past half a month as the pair `cooldown 1, categoryCooldown 0x80000000`
// (:254-258). Read as a duration that is 2 147 483 648 ms — a grey button for 24.8 days, and every
// SMSG_COOLDOWN_EVENT that should start the real timer dropped as a duplicate.
// The native book and bar below import `ui/Dom.ts`, which resolves its handles at import.
installFakeUiDocument();
const SELF = 0x1234n;
const STEALTH = 1784;
const EVASION = 5277;

test("the hold is exactly the core's pair, not a duration", () => {
  assert.equal(INFINITE_COOLDOWN_CATEGORY, 2_147_483_648, "read unsigned from the u32");
  assert.equal(isCooldownOnHold({ cooldown: 1, categoryCooldown: 0x8000_0000 }), true);
  assert.equal(isCooldownOnHold({ cooldown: 30_000, categoryCooldown: 0 }), false);
  assert.equal(isCooldownOnHold({ cooldown: 0, categoryCooldown: 30_000 }), false);
  // Neither half alone: the core writes 0x80000000 only beside a 1 (and 1 ms beside a zero is a
  // real, nearly spent cooldown).
  assert.equal(isCooldownOnHold({ cooldown: 0, categoryCooldown: 0x8000_0000 }), false);
  assert.equal(isCooldownOnHold({ cooldown: 1, categoryCooldown: 0 }), false);
});

test("a held cooldown sets no timer, and its cooldown event starts the real one", async () => {
  const { client, connection } = await travelClient([], SELF);
  const events = [];
  client.onCooldownEvent = (spellId) => events.push(spellId);
  try {
    connection.push(OPCODES.SMSG_INITIAL_SPELLS, initialSpellsPacket({
      spells: [STEALTH, EVASION],
      cooldowns: [
        { spellId: STEALTH, categoryId: 5, cooldown: 1, categoryCooldown: 0x8000_0000 },
        // Control: an ordinary cooldown still arms its timer.
        { spellId: EVASION, cooldown: 30_000, categoryCooldown: 0 },
      ],
    }));
    await settle();
    assert.equal(client.cooldowns.has(STEALTH), false, "no 24.8-day timer");
    assert.equal(client.cooldownSnapshots.has(STEALTH), false);
    assert.equal(client.cooldownRemaining(STEALTH), 0);
    assert.equal(client.categoryCooldowns.has(5), false, "nor a category lockout");
    assert.equal(client.spellCategories.get(STEALTH), 5, "the category is still the spell's");
    assert.equal(client.isSpellOnHold(STEALTH), true);
    assert.equal(client.cooldowns.has(EVASION), true);
    assert.ok(client.cooldownRemaining(EVASION) > 29_000 && client.cooldownRemaining(EVASION) <= 30_000);
    assert.equal(client.isSpellOnHold(EVASION), false);

    // The aura ended: SpellHistory::SendCooldownEvent (:384-387), then the server's StartCooldown.
    connection.push(OPCODES.SMSG_COOLDOWN_EVENT, cooldownEventPacket(STEALTH, SELF));
    await settle();
    assert.deepEqual(events, [STEALTH], "announced once, for the browser to time from the spell's row");
    assert.equal(client.isSpellOnHold(STEALTH), false);
  } finally {
    client.close();
  }
});

test("a cleared or re-sent spell list lets go of the hold", async () => {
  const { client, connection } = await travelClient([], SELF);
  let changed = 0;
  client.onCooldownsChanged = () => { changed++; };
  const held = initialSpellsPacket({
    spells: [STEALTH],
    cooldowns: [{ spellId: STEALTH, cooldown: 1, categoryCooldown: 0x8000_0000 }],
  });
  try {
    connection.push(OPCODES.SMSG_INITIAL_SPELLS, held);
    await settle();
    assert.equal(client.isSpellOnHold(STEALTH), true);
    const before = changed;
    connection.push(OPCODES.SMSG_CLEAR_COOLDOWN, cooldownEventPacket(STEALTH, SELF));
    await settle();
    assert.equal(client.isSpellOnHold(STEALTH), false);
    assert.ok(changed > before, "the buttons hear it");

    connection.push(OPCODES.SMSG_INITIAL_SPELLS, held);
    await settle();
    assert.equal(client.isSpellOnHold(STEALTH), true);
    // A new list replaces the old one: a hold it no longer names is gone.
    connection.push(OPCODES.SMSG_INITIAL_SPELLS, initialSpellsPacket({ spells: [STEALTH] }));
    await settle();
    assert.equal(client.isSpellOnHold(STEALTH), false);
    assert.equal(client.cooldownHolds.size, 0);
  } finally {
    client.close();
  }
});

/** Stealth held in category 5; a sibling in the same category; a spell of another category. */
const PROWL_LIKE = 5215;
const OTHER = 2983;
const heldList = () => initialSpellsPacket({
  spells: [STEALTH, PROWL_LIKE, OTHER],
  cooldowns: [
    { spellId: STEALTH, categoryId: 5, cooldown: 1, categoryCooldown: 0x8000_0000 },
    // Spent records still name their category (SpellHistory.cpp:262-266 writes `0, 0`).
    { spellId: PROWL_LIKE, categoryId: 5, cooldown: 0, categoryCooldown: 0 },
    { spellId: OTHER, categoryId: 44, cooldown: 0, categoryCooldown: 0 },
  ],
});

test("a hold holds its category: every spell the core would refuse as NOT_READY", async () => {
  // SpellHistory::AddCooldown files the held entry under its category too (:405-406), and
  // HasCooldown refuses any spell of a category with an entry (:473-487), whatever its end time.
  const { client, connection } = await travelClient([], SELF);
  try {
    connection.push(OPCODES.SMSG_INITIAL_SPELLS, heldList());
    await settle();
    assert.equal(client.isSpellOnHold(STEALTH), true);
    assert.equal(client.isSpellOnHold(PROWL_LIKE), true, "the sibling in category 5");
    assert.equal(client.isSpellOnHold(OTHER), false);
    assert.equal(client.isSpellOnHold(EVASION), false, "a spell whose category nobody named");
    assert.equal(client.cooldownRemaining(PROWL_LIKE), 0, "held, not counting down");
    connection.push(OPCODES.SMSG_COOLDOWN_EVENT, cooldownEventPacket(STEALTH, SELF));
    await settle();
    assert.equal(client.isSpellOnHold(PROWL_LIKE), false, "released with the spell that held it");
  } finally {
    client.close();
  }
});

test("the browser's cooldown handler starts the real timer, and the buttons hear it once", async () => {
  const { client, connection } = await travelClient([], SELF);
  const started = [];
  let changed = 0;
  // EnterWorld.ts wires exactly this: the duration is the spell's DBC recovery.
  client.onCooldownEvent = (spellId) => client.startLocalCooldown(spellId, 10_000);
  client.onCooldownsChanged = () => { changed++; };
  client.events.on("SPELL_COOLDOWN_STARTED", (event) => started.push(event));
  try {
    connection.push(OPCODES.SMSG_INITIAL_SPELLS, heldList());
    await settle();
    changed = 0;
    connection.push(OPCODES.SMSG_COOLDOWN_EVENT, cooldownEventPacket(STEALTH, SELF));
    await settle();
    assert.equal(client.isSpellOnHold(STEALTH), false);
    assert.ok(client.cooldownRemaining(STEALTH) > 9_000 && client.cooldownRemaining(STEALTH) <= 10_000,
      `the real ten seconds: ${client.cooldownRemaining(STEALTH)}`);
    assert.deepEqual(started.map((event) => [event.spellId, event.duration, event.source]), [[STEALTH, 10_000, "server"]]);
    assert.equal(changed, 1, "the release and the new timer are one change");

    // With no handler (no DBC row yet) the release is still news, once.
    connection.push(OPCODES.SMSG_INITIAL_SPELLS, heldList());
    await settle();
    client.onCooldownEvent = undefined;
    changed = 0;
    connection.push(OPCODES.SMSG_COOLDOWN_EVENT, cooldownEventPacket(STEALTH, SELF));
    await settle();
    assert.equal(client.isSpellOnHold(STEALTH), false);
    assert.equal(changed, 1);
  } finally {
    client.close();
  }
});

test("the native guard calls a held spell not ready, with no cooldown to sweep", async () => {
  const { game } = await import("../dist/code/browser/game/Context.js");
  const { spellCastBlockReason } = await import("../dist/code/browser/SpellCastGuard.js");
  const { client, connection } = await travelClient([], SELF);
  const row = (id) => ({ id, name: "Незаметность", passive: false, powerType: 3, powerCost: 0, powerCostPercent: 0,
    schoolMask: 1, recoveryTime: 10_000, categoryRecoveryTime: 0, startRecoveryTime: 0 });
  try {
    game.world = client;
    game.spells = new Map([STEALTH, PROWL_LIKE, OTHER].map((id) => [id, row(id)]));
    game.globalCooldownUntil = 0;
    connection.push(OPCODES.SMSG_INITIAL_SPELLS, heldList());
    await settle();
    // After logging in stealthed the press used to go out and come back SPELL_FAILED_NOT_READY.
    assert.equal(spellCastBlockReason(client, STEALTH), "hold");
    assert.equal(spellCastBlockReason(client, PROWL_LIKE), "hold");
    assert.equal(spellCastBlockReason(client, OTHER), undefined);
    assert.equal(client.cooldownRemaining(STEALTH), 0, "and nothing for a sweep to draw");
    connection.push(OPCODES.SMSG_COOLDOWN_EVENT, cooldownEventPacket(STEALTH, SELF));
    await settle();
    assert.equal(spellCastBlockReason(client, STEALTH), undefined, "released, and no handler started a timer");
  } finally {
    game.world = undefined;
    game.spells = new Map();
    client.close();
  }
});

test("the stock seam answers a held spell as stock does: no cooldown, not enabled, not usable", async () => {
  const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
  const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
  const { ACTION_BUTTON_SPELL } = await import("../dist/code/world/ActionBarProtocol.js");
  const call = (seam, name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);
  const held = new Set([STEALTH]);
  const world = {
    state: { selfGuid: SELF, objects: new Map() },
    knownSpells: [{ id: STEALTH, slot: 0 }, { id: EVASION, slot: 1 }],
    actionButtons: [
      { slot: 0, action: STEALTH, type: ACTION_BUTTON_SPELL },
      { slot: 1, action: EVASION, type: ACTION_BUTTON_SPELL },
    ],
    cooldownSnapshots: new Map(), casts: new Map(), mirrorTimers: new Map(),
    cooldownRemaining: () => 0,
    cooldownState: () => undefined,
    isSpellOnHold: (id) => held.has(id),
    isActiveMountSpell: () => false,
    events: { on: () => () => {} },
  };
  const spell = (id) => ({ id, name: `spell ${id}`, rank: "", iconPath: "", passive: false, startRecoveryTime: 1_500 });
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell, monotonic: () => 100_000,
    // A global cooldown is running: a held spell still shows no sweep.
    globalCooldownUntil: () => 100_500, castSpell: () => {},
  });
  seam.attach({ now: () => 500, fire: () => 1 });
  try {
    // SpellBookFrame / ActionButton_UpdateCooldown: `enable` 0 hides the sweep for a held spell.
    assert.deepEqual(call(seam, "GetActionCooldown", 1), [0, 0, 0]);
    assert.deepEqual(call(seam, "IsUsableAction", 1), [false, false]);
    assert.deepEqual(call(seam, "GetSpellCooldown", STEALTH), [0, 0, 0]);
    // The spell next to it is an ordinary one: the global cooldown, usable, enabled.
    assert.deepEqual(call(seam, "GetActionCooldown", 2), [499, 1.5, 1]);
    assert.deepEqual(call(seam, "IsUsableAction", 2), [true, false]);
    assert.deepEqual(call(seam, "GetSpellCooldown", EVASION), [0, 0, 1]);
    held.clear();
    assert.deepEqual(call(seam, "IsUsableAction", 1), [true, false]);
    assert.deepEqual(call(seam, "GetSpellCooldown", STEALTH), [0, 0, 1]);
  } finally {
    seam.detach();
  }
});

test("the native book and bar keep a held spell's press at home", async () => {
  const { game } = await import("../dist/code/browser/game/Context.js");
  const { castSpell, showSpells, updateSpellCooldowns } = await import("../dist/code/browser/ui/Spellbook.js");
  const { useSlot } = await import("../dist/code/browser/ui/ActionBar.js");
  const { spellbookList } = await import("../dist/code/browser/ui/Dom.js");
  const { ACTION_BUTTON_SPELL } = await import("../dist/code/world/ActionBarProtocol.js");
  const sent = [];
  const held = new Set([STEALTH]);
  const row = (id) => ({
    id, name: `spell ${id}`, rank: "", description: "", iconId: 0, iconPath: "", passive: false, hidden: false,
    powerType: 3, powerCost: 0, powerCostPercent: 0, recoveryTime: 10_000, categoryRecoveryTime: 0,
    startRecoveryTime: 0, cooldownStartedOnEvent: true, effectAura: [], effectMiscValue: [], schoolMask: 1,
  });
  try {
    game.globalCooldownUntil = 0;
    game.spells = new Map([[STEALTH, row(STEALTH)], [EVASION, row(EVASION)]]);
    game.talentData = undefined;
    game.world = {
      knownSpells: [{ id: STEALTH, slot: 0 }, { id: EVASION, slot: 1 }],
      initialSpellsReceived: true,
      actionButtons: [
        { slot: 0, action: STEALTH, type: ACTION_BUTTON_SPELL },
        { slot: 1, action: EVASION, type: ACTION_BUTTON_SPELL },
      ],
      state: { selfGuid: SELF, objects: new Map() },
      spellModifiers: new Map(),
      cooldownRemaining: () => 0,
      cooldownState: () => undefined,
      isSpellOnHold: (id) => held.has(id),
      isActiveMountSpell: () => false,
      castSpell: (...args) => sent.push(args[0]),
    };
    // The book's button: disabled and said to be not ready, with no sweep to draw.
    showSpells();
    updateSpellCooldowns(performance.now());
    const button = (id) => spellbookList.children.find((child) => child.title.startsWith(`spell ${id}`));
    assert.equal(button(STEALTH)?.disabled, true);
    assert.equal(button(STEALTH)?.title, `spell ${STEALTH} · Ещё не готово`);
    assert.equal(button(EVASION)?.disabled, false);
    assert.equal(castSpell(STEALTH), false, "the book");
    useSlot(0, 0);
    assert.deepEqual(sent, [], "neither press reached the wire");
    useSlot(1, 0);
    assert.deepEqual(sent, [EVASION], "the spell beside it still casts");
    held.clear();
    updateSpellCooldowns(performance.now());
    assert.equal(button(STEALTH)?.disabled, false);
    assert.equal(castSpell(STEALTH), true);
    assert.deepEqual(sent, [EVASION, STEALTH]);
  } finally {
    game.world = undefined;
    game.spells = new Map();
  }
});

test("the native bar greys a held slot with no sweep, and its own press stops there", async () => {
  // ActionBar.ts alone, its imports replaced (the pattern of action-bar-bonus-page.test.mjs): the
  // spellbook's own refusal is out of the picture, so the grey and the refusal are the bar's.
  const { isolatedUi } = await import("./fixtures/isolated-ui.mjs");
  const protocol = await import("../dist/code/world/ActionBarProtocol.js");
  const context = await import("../dist/code/browser/game/Context.js");
  const { game } = context;
  const casts = [];
  // An item's use spell can be held the same way (`ItemId` in the record): a healthstone here.
  const STONE = 5512;
  const STONE_SPELL = 6262;
  const held = new Set([STEALTH, STONE_SPELL]);
  const actionBar = document.createElement("div");
  const byRoot = new Map();
  class IconButton {
    constructor(options) { this.options = options; this.root = document.createElement("button"); byRoot.set(this.root, this); }
    setContent(content) { this.content = content; }
    setCooldown(fraction) { this.cooldown = fraction; }
    setUsable(usable) { this.usable = usable; }
  }
  try {
    game.world = {
      state: { selfGuid: SELF, objects: new Map([[SELF, { guid: SELF, typeId: 4, fields: new Map() }]]) },
      knownSpells: [{ id: STEALTH }, { id: EVASION }],
      actionButtons: [
        { slot: 0, action: STEALTH, type: protocol.ACTION_BUTTON_SPELL },
        { slot: 1, action: EVASION, type: protocol.ACTION_BUTTON_SPELL },
        { slot: 2, action: STONE, type: protocol.ACTION_BUTTON_ITEM },
      ],
      itemTemplate: (entry) => (entry === STONE ? { entry, found: true, name: "Камень здоровья", useSpell: STONE_SPELL } : undefined),
      cooldownRemaining: () => 0,
      itemCooldownRemaining: () => 0,
      cooldownState: () => undefined,
      isSpellOnHold: (id) => held.has(id),
      isActiveMountSpell: () => false,
      setActionButton: () => {},
    };
    game.spells = new Map([STEALTH, EVASION].map((id) => [id,
      { id, iconId: id, passive: false, startRecoveryTime: 0, effectAura: [0, 0, 0], effectMiscValue: [0, 0, 0] }]));
    const bar = await isolatedUi("ActionBar", {
      "../../world/ActionBarProtocol.js": protocol,
      "../input/Bindings.js": await import("../dist/code/browser/input/Bindings.js"),
      "../game/Context.js": context,
      "../game/BonusBar.js": await import("../dist/code/browser/game/BonusBar.js"),
      "../SpellMetadata.js": await import("../dist/code/browser/SpellMetadata.js"),
      "../SpellCastGuard.js": { spellPowerAvailable: () => true },
      "../../world/WorldClient.js": { MELEE_AUTO_ATTACK_SPELL_ID: 6603 },
      "./Spellbook.js": { castSpell: (id) => { casts.push(id); return true; }, highestKnownRank: (id) => id },
      "./Dom.js": { actionBar },
      "./Widgets.js": {
        IconButton, attachTooltip: () => {}, cooldownDuration: () => 0, cooldownLabel: () => "",
        cooldownView: (_now, own) => ({ fraction: own > 0 ? 0.5 : 0, remaining: own }),
      },
      "./IconImage.js": { spellIconUrl: (iconId) => `icon ${iconId}` },
      "../game/GroundTarget.js": { itemUseSpellId: (template) => template?.useSpell, requestInventoryItemUse: () => {} },
    });
    bar.showActionBar();
    bar.updateActionBar(1_000);
    const [stealth, evasion, stone] = actionBar.children.map((root) => byRoot.get(root));
    assert.equal(stealth.usable, false, "grey: the realm would answer NOT_READY");
    assert.equal(stealth.cooldown, 0, "and no sweep: nothing is counting down");
    assert.equal(evasion.usable, true);
    assert.equal(stone.usable, false, "an item whose use spell is held");
    bar.useSlot(0);
    bar.useSlot(1);
    assert.deepEqual(casts, [EVASION], "the held slot's press never left the bar");
    held.clear();
    bar.updateActionBar(1_016);
    assert.equal(stealth.usable, true);
    assert.equal(stone.usable, true);
  } finally {
    game.world = undefined;
    game.spells = new Map();
  }
});
