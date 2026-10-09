import assert from "node:assert/strict";
import test from "node:test";
import { installFakeUiDocument } from "./fixtures/fake-ui-document.mjs";

// The native bar imports `ui/Dom.ts`, which resolves its handles at import.
installFakeUiDocument();

// L13 (04.10), plan item 5.30: the native action bar's own press gate (ui/ActionBar.ts) and the shared cast guard
// (SpellCastGuard.ts) hold a spell by its StartRecoveryCategory (`/dbc/spells?v=17`), as the realm keys its global
// cooldowns (SpellHistory.cpp:585-594, none for category 0 — Spell.cpp:8698): with a global cooldown running,
// Удар смерти 45469 (0/1500) still goes out, Ледяная стрела 116 (133/1500) and Воля Отрекшихся 7744 (133/0) do
// not. A row from an older gateway (no category) keeps the rule from before: StartRecoveryTime > 0 waits.

const SELF = 0x10n;

test("L13 5.30: the native bar and the guard hold by category; an older gateway's rows as before", async () => {
  const { game } = await import("../dist/code/browser/game/Context.js");
  const { useSlot } = await import("../dist/code/browser/ui/ActionBar.js");
  const { ACTION_BUTTON_SPELL } = await import("../dist/code/world/ActionBarProtocol.js");
  const row = (id, columns) => ({
    id, name: `spell ${id}`, rank: "", description: "", iconId: 0, iconPath: "", passive: false, hidden: false,
    powerType: 0, powerCost: 0, powerCostPercent: 0, recoveryTime: 0, categoryRecoveryTime: 0,
    cooldownStartedOnEvent: false, effectAura: [], effectMiscValue: [], schoolMask: 1, spellClassMask: [0, 0, 0],
    ...columns,
  });
  // The dataset's StartRecoveryCategory/StartRecoveryTime (Spell.dbc, 2026-10-04); 90001/90002 are old-shape rows.
  const rows = [
    row(45469, { startRecoveryCategory: 0, startRecoveryTime: 1500 }), // Удар смерти
    row(116, { startRecoveryCategory: 133, startRecoveryTime: 1500 }), // Ледяная стрела
    row(7744, { startRecoveryCategory: 133, startRecoveryTime: 0 }), // Воля Отрекшихся
    row(48941, { startRecoveryCategory: 38, startRecoveryTime: 1500 }), // Аура благочестия
    row(2139, { startRecoveryCategory: 0, startRecoveryTime: 0 }), // Антимагия
    row(90001, { startRecoveryTime: 1500 }),
    row(90002, { startRecoveryTime: 0 }),
  ];
  const sent = [];
  const saved = { world: game.world, spells: game.spells, gcd: game.globalCooldownUntil };
  try {
    game.spells = new Map(rows.map((entry) => [entry.id, entry]));
    game.talentData = undefined;
    game.world = {
      knownSpells: rows.map((entry, slot) => ({ id: entry.id, slot })),
      initialSpellsReceived: true,
      actionButtons: rows.map((entry, slot) => ({ slot, action: entry.id, type: ACTION_BUTTON_SPELL })),
      state: { selfGuid: SELF, objects: new Map() },
      spellModifiers: new Map(),
      cooldownRemaining: () => 0,
      cooldownState: () => undefined,
      isSpellOnHold: () => false,
      isActiveMountSpell: () => false,
      castSpell: (...args) => sent.push(args[0]),
    };
    // A global cooldown nobody predicted here (no model writes this sink): every category but 0 waits for it.
    game.globalCooldownUntil = performance.now() + 60_000;
    rows.forEach((_, slot) => useSlot(slot, 0));
    assert.deepEqual(sent, [45469, 2139, 90002],
      "category 0 goes out (the realm keeps no global cooldown for it); 133 with or without a time, 38 and an old row with a time wait");
    sent.length = 0;
    game.globalCooldownUntil = 0;
    rows.forEach((_, slot) => useSlot(slot, 0));
    assert.deepEqual(sent, rows.map((entry) => entry.id), "nothing running: every press goes out");
  } finally {
    game.world = saved.world;
    game.spells = saved.spells;
    game.globalCooldownUntil = saved.gcd;
  }
});

// L13-review (04.10), 5.30: the sweeps follow the same rule as the press (Wow.exe 0x00807980 answers the global part
// of the entry whose category is the spell's: that entry's start and its own length). Before, the native bar and the
// book drew the shared (133) end on every row with a StartRecoveryTime: Удар смерти (0/1500) was drawn cooling — and
// its book button disabled — while it could be cast, Воля Отрекшихся (133/0) showed nothing while it was held, and
// Аура благочестия (38) showed the 133 sweep and not its own; a 1500-ms row under a 1000-ms global cooldown started
// its sweep at two thirds.
const STAT = (id, columns) => ({
  id, name: `spell ${id}`, rank: "", description: "", iconId: 0, iconPath: "", passive: false, hidden: false,
  powerType: 0, powerCost: 0, powerCostPercent: 0, recoveryTime: 0, categoryRecoveryTime: 0,
  cooldownStartedOnEvent: false, effectAura: [], effectMiscValue: [], schoolMask: 1, spellClassMask: [0, 0, 0],
  spellLevel: 1, ...columns,
});

test("L13-review 5.30: the native sweeps and the book's buttons follow the category", async () => {
  globalThis.window.dispatchEvent ??= () => true; // the bottom HUD's layout notice (showActionBar)
  const { game } = await import("../dist/code/browser/game/Context.js");
  const { showActionBar, updateActionBar } = await import("../dist/code/browser/ui/ActionBar.js");
  const { showSpells, updateSpellCooldowns } = await import("../dist/code/browser/ui/Spellbook.js");
  const { actionBar, spellbookList, spellbookWindow } = await import("../dist/code/browser/ui/Dom.js");
  const { attachPredictedGlobalCooldown } = await import("../dist/code/browser/game/PredictedGlobalCooldown.js");
  const { ACTION_BUTTON_SPELL } = await import("../dist/code/world/ActionBarProtocol.js");
  // Dataset StartRecoveryCategory/StartRecoveryTime (Spell.dbc, 2026-10-04); 90001/90002 are old-shape rows.
  const rows = [
    STAT(1752, { startRecoveryCategory: 133, startRecoveryTime: 1000 }), // Коварный удар
    STAT(116, { startRecoveryCategory: 133, startRecoveryTime: 1500 }), // Ледяная стрела
    STAT(7744, { startRecoveryCategory: 133, startRecoveryTime: 0 }), // Воля Отрекшихся
    STAT(45469, { startRecoveryCategory: 0, startRecoveryTime: 1500 }), // Удар смерти
    STAT(48941, { startRecoveryCategory: 38, startRecoveryTime: 1500 }), // Аура благочестия
    STAT(90001, { startRecoveryTime: 1500 }),
    STAT(90002, { startRecoveryTime: 0 }),
  ];
  const saved = { world: game.world, spells: game.spells, gcd: game.globalCooldownUntil, talents: game.talentData };
  const slotOf = (id) => rows.findIndex((entry) => entry.id === id);
  const degrees = (id) => {
    const root = actionBar.children[slotOf(id)];
    return root.children.find((child) => child.className === "ui-icon-sweep")?.style["--sweep"];
  };
  const bookButton = (id) => spellbookList.children.find((button) => button.children?.[1]?.textContent === `spell ${id}`);
  // The model EnterWorld.ts attaches, fed its SPELL_CAST_SENT by hand at the test's clock; detached afterwards.
  const handlers = new Map();
  const now = 100_000;
  let clock = now;
  let offs = [];
  const sent = (spellId, castCount, at) => { clock = at; handlers.get("SPELL_CAST_SENT")({ spellId, castCount }); };
  try {
    game.spells = new Map(rows.map((entry) => [entry.id, entry]));
    game.talentData = undefined;
    game.globalCooldownUntil = 0;
    game.world = {
      knownSpells: rows.map((entry, slot) => ({ id: entry.id, slot })),
      initialSpellsReceived: true, equipmentSets: [],
      actionButtons: rows.map((entry, slot) => ({ slot, action: entry.id, type: ACTION_BUTTON_SPELL })),
      state: { selfGuid: SELF, objects: new Map() },
      spellModifiers: new Map(), casts: new Map(),
      cooldownRemaining: () => 0, cooldownState: () => undefined, isSpellOnHold: () => false,
      isActiveMountSpell: () => false, itemCooldownRemaining: () => 0, itemTemplate: () => undefined,
      events: { on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name); } },
    };
    offs = attachPredictedGlobalCooldown(game.world, game, () => game.spells, () => true, () => clock);
    showActionBar();
    spellbookWindow.hidden = false;
    showSpells();
    sent(1752, 1, now); // a 1000-ms 133 global cooldown
    updateActionBar(now + 500);
    updateSpellCooldowns(now + 500);
    assert.deepEqual([1752, 116, 7744, 45469, 48941, 90001, 90002].map(degrees),
      ["180deg", "180deg", "180deg", "0deg", "0deg", "180deg", "0deg"],
      "half of the running 1000-ms entry on every row it holds; category 0, 38 and a timeless old row: nothing");
    assert.deepEqual([116, 7744, 45469, 48941].map((id) => bookButton(id)?.disabled), [true, true, false, false],
      "the book's Удар смерти stays pressable, Воля Отрекшихся does not");
    sent(48941, 2, now + 500); // Аура благочестия: its own 38 entry
    updateActionBar(now + 875);
    updateSpellCooldowns(now + 875);
    assert.deepEqual([116, 7744, 45469, 48941].map(degrees), ["45deg", "45deg", "0deg", "270deg"],
      "38 sweeps its own 1500 ms; the 133 rows keep theirs");
    assert.deepEqual([116, 48941].map((id) => bookButton(id)?.disabled), [true, true]);
    updateActionBar(now + 1000);
    updateSpellCooldowns(now + 1000);
    assert.deepEqual([116, 7744, 48941].map(degrees), ["0deg", "0deg", "240deg"], "the 133 entry ran out");
    assert.deepEqual([116, 48941].map((id) => bookButton(id)?.disabled), [false, true]);
  } finally {
    for (const off of offs) off();
    spellbookWindow.hidden = true;
    game.world = saved.world;
    game.spells = saved.spells;
    game.globalCooldownUntil = saved.gcd;
    game.talentData = saved.talents;
  }
});

// L13-review (04.10), 5.30: a card of the character sheet's collections seeded the spell's own cooldown with
// StartRecoveryTime too — a global part held as the spell's own timer, which for the category-0 mounts with a time
// (Волшебная метла 47977, ракеты 71342/75973) is 1.5 s the realm does not keep. The book and the reticle seed only
// the recovery (Spellbook.ts, Controls.ts); the global part is the model's (PredictedGlobalCooldown.ts).
test("L13-review 5.30: a collection card seeds only the spell's own recovery", async () => {
  const { game } = await import("../dist/code/browser/game/Context.js");
  const { showCharacterCollections } = await import("../dist/code/browser/ui/CharacterSheet.js");
  const { characterMounts } = await import("../dist/code/browser/ui/Dom.js");
  const make = document.createElement;
  document.createElement = (tag) => {
    const node = make(tag);
    node.addEventListener = (type, listener) => { (node.listeners ??= {})[type] = listener; };
    return node;
  };
  const saved = { world: game.world, spells: game.spells, talents: game.talentData };
  try {
    const casts = [];
    game.spells = new Map([
      [47977, STAT(47977, { startRecoveryCategory: 0, startRecoveryTime: 1500, effectAura: [78, 0, 0] })],
      [60002, STAT(60002, { startRecoveryCategory: 133, startRecoveryTime: 1500, effectAura: [78, 0, 0], recoveryTime: 3000 })],
    ]);
    game.talentData = undefined;
    game.world = {
      knownSpells: [{ id: 47977, slot: 0 }, { id: 60002, slot: 1 }], state: { selfGuid: SELF, objects: new Map() },
      petSpells: undefined, stable: undefined, displayName: () => "",
      castSpell: (...args) => casts.push(args),
    };
    showCharacterCollections();
    for (const card of characterMounts.children) card.listeners.click();
    assert.deepEqual(casts, [[47977, 0, false], [60002, 3000, false]]);
  } finally {
    document.createElement = make;
    game.world = saved.world;
    game.spells = saved.spells;
    game.talentData = saved.talents;
  }
});
