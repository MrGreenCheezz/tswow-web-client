// Keys 1–= and the native main bar under a stance, a form or stealth (WORK_PLAN 1.04).
//
// Stock ActionButton_CalculateAction (FrameXML/ActionButton.lua:131-153) gives a bonus button the
// page NUM_ACTIONBAR_PAGES + GetBonusBarOffset() — but only while GetActionBarPage() is 1 — and the
// action is id + (page - 1) * 12. So with the main page at 1 and a bonus offset n > 0 key k presses
// the 0-based slot (5 + n) * 12 + k - 1; on pages 2–6 the bonus bar is ignored. Stock
// GetActionBarPage() itself never answers a bonus page.
import assert from "node:assert/strict";
import test from "node:test";
import { installFakeUiDocument } from "./fixtures/fake-ui-document.mjs";
import { isolatedModule, isolatedUi } from "./fixtures/isolated-ui.mjs";

installFakeUiDocument();

const protocol = await import("../dist/code/world/ActionBarProtocol.js");
const bindings = await import("../dist/code/browser/input/Bindings.js");
const spellMetadata = await import("../dist/code/browser/SpellMetadata.js");
const context = await import("../dist/code/browser/game/Context.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { ACTION_BUTTON_SPELL } = protocol;
const { game } = context;
// Imported where it is used, so that each group below reports on its own.
const bonusBarModule = () => import("../dist/code/browser/game/BonusBar.js");

/** `SPELL_AURA_MOD_SHAPESHIFT`: its misc value is the form the spell puts the caster in. */
const MOD_SHAPESHIFT = 36;
const BYTES_2 = UPDATE_FIELDS.UNIT_FIELD_BYTES_2.offset;

/**
 * Forms, the spells that give them, and each form's BonusActionBar column of the client's
 * SpellShapeshiftForm.dbc (docs/implementation/probes/A5/probe-stances.out.txt). Stealth carries its
 * form aura in the second effect slot here: the lookup goes by aura, not by position.
 */
const FORMS = {
  battleStance: { form: 17, spell: 2457, offset: 1 },
  defensiveStance: { form: 18, spell: 71, offset: 2 },
  berserkerStance: { form: 19, spell: 2458, offset: 3 },
  cat: { form: 1, spell: 768, offset: 1 },
  bear: { form: 5, spell: 5487, offset: 3 },
  moonkin: { form: 31, spell: 24858, offset: 4 },
  stealth: { form: 30, spell: 1784, offset: 1, effect: 1 },
  travel: { form: 3, spell: 783, offset: 0 },
};
const EVERY_FORM_SPELL = Object.values(FORMS).map(({ spell }) => spell);

/** A spell row as `/dbc/spells` delivers it: the form aura and the joined BonusActionBar. */
function formSpell(form, bonusActionBarOffset, effect = 0) {
  const effectAura = [0, 0, 0];
  const effectMiscValue = [0, 0, 0];
  effectAura[effect] = MOD_SHAPESHIFT;
  effectMiscValue[effect] = form;
  return { effectAura, effectMiscValue, bonusActionBarOffset };
}
const FORM_ROWS = new Map(Object.values(FORMS).map(({ form, spell, offset, effect }) =>
  [spell, formSpell(form, offset, effect)]));

/** The player's object: the form is byte 3 of UNIT_FIELD_BYTES_2 (Unit::SetShapeshiftForm). */
function selfObject(form) {
  return { guid: 1n, typeId: 4, fields: new Map(form === undefined ? [] : [[BYTES_2, form * 2 ** 24]]) };
}
function worldIn(form, knownSpellIds) {
  return {
    state: { selfGuid: 1n, objects: new Map([[1n, selfObject(form)]]) },
    knownSpells: knownSpellIds.map((id) => ({ id })),
  };
}

test("bonusActionPage: the bonus page replaces main page 1 only, capped at the server's last page", () => {
  const { bonusActionPage, ACTIONBAR_MAIN_PAGES } = protocol;
  assert.equal(ACTIONBAR_MAIN_PAGES, 6);
  // [main page (0-based), bonus offset, page the main row and its keys use]
  const cases = [[0, 0, 0], [0, 1, 6], [0, 3, 8], [0, 4, 9], [1, 3, 1], [5, 2, 5], [0, 99, 11]];
  assert.deepEqual(cases.map(([page, offset]) => bonusActionPage(page, offset)),
    cases.map(([, , expected]) => expected));
});

test("bonusBarOffset: the form byte and the learned spell that gives that form", async () => {
  const { bonusBarOffset } = await bonusBarModule();
  const row = (id) => FORM_ROWS.get(id);
  for (const [name, { form, offset }] of Object.entries(FORMS)) {
    assert.equal(bonusBarOffset(worldIn(form, EVERY_FORM_SPELL), row), offset, name);
  }
  assert.equal(bonusBarOffset(worldIn(0, EVERY_FORM_SPELL), row), 0, "no form");
  assert.equal(bonusBarOffset(worldIn(undefined, EVERY_FORM_SPELL), row), 0, "UNIT_FIELD_BYTES_2 not sent yet");
  // A form without a learned spell giving it (an item's or an aura's) stays at 0, as the stock seam
  // answered before this move.
  assert.equal(bonusBarOffset(worldIn(FORMS.battleStance.form, [FORMS.cat.spell]), row), 0,
    "form without its spell");
  assert.equal(bonusBarOffset(worldIn(FORMS.battleStance.form, EVERY_FORM_SPELL), () => undefined), 0,
    "metadata not loaded");
  assert.equal(bonusBarOffset(undefined, row), 0, "no world");
  assert.equal(bonusBarOffset({ state: { selfGuid: 2n, objects: new Map() }, knownSpells: [] }, row), 0,
    "no player object");
});

// Asked once a frame, the answer is kept between frames; each of these steps changes one thing it
// is read from and must be seen on the very next call.
test("currentBonusBarOffset follows the form byte, the learned spells and rows that land late", async () => {
  const { currentBonusBarOffset } = await bonusBarModule();
  const world = worldIn(FORMS.battleStance.form, [FORMS.battleStance.spell]);
  const self = world.state.objects.get(1n);
  game.world = world;
  game.spells.clear();
  try {
    assert.equal(currentBonusBarOffset(), 0, "the stance's row has not arrived");
    game.spells.set(FORMS.battleStance.spell, FORM_ROWS.get(FORMS.battleStance.spell));
    assert.equal(currentBonusBarOffset(), 1, "the row arrived");
    game.spells.set(FORMS.defensiveStance.spell, FORM_ROWS.get(FORMS.defensiveStance.spell));
    self.fields.set(BYTES_2, FORMS.defensiveStance.form * 2 ** 24);
    assert.equal(currentBonusBarOffset(), 0, "Defensive Stance is not learned");
    world.knownSpells = [...world.knownSpells, { id: FORMS.defensiveStance.spell }];
    assert.equal(currentBonusBarOffset(), 2, "learned: the list is replaced");
    self.fields.set(BYTES_2, FORMS.battleStance.form * 2 ** 24);
    assert.equal(currentBonusBarOffset(), 1, "back to Battle Stance");
    self.fields.set(BYTES_2, 0);
    assert.equal(currentBonusBarOffset(), 0, "left the stance");
    game.world = undefined;
    assert.equal(currentBonusBarOffset(), 0, "no world");
  } finally {
    game.world = undefined;
    game.spells.clear();
  }
});

const MAIN = 100;
const PAGE_TWO = 120;
const BATTLE = 200;
const BATTLE_SEVENTH = 207;
const DEFENSIVE = 300;
const MOONKIN = 500;
const VEHICLE = 600;

/**
 * The native bar and the key verbs, each transpiled on its own over the real protocol, bindings,
 * world context and bonus-bar modules. The world holds slot 0 (main page), slot 12 (page 2), the
 * bonus pages of offsets 1, 2 and 4 (slots 72 and 78, 84, 108) and slot 120 for a key-bar override.
 * The fakes count what the bar does: `draws` (a button's content set), `layouts` (the HUD asked to
 * refit its windows) and `requested` (spells whose rows were asked for).
 */
async function nativeActionBar() {
  const casts = [];
  const writes = [];
  const requested = [];
  const counts = { draws: 0, layouts: 0 };
  const cooling = new Set();
  const tooltips = new Map();
  const byRoot = new Map();
  const actionBar = document.createElement("div");
  class IconButton {
    constructor(options) {
      this.options = options;
      this.listeners = {};
      this.root = document.createElement("button");
      this.root.addEventListener = (name, listener) => { this.listeners[name] = listener; };
      byRoot.set(this.root, this);
    }
    setContent(content) { this.content = content; counts.draws += 1; }
    setCooldown(fraction) { this.cooldown = fraction; }
    setUsable(usable) { this.usable = usable; }
  }
  const self = selfObject(0);
  const world = {
    state: { selfGuid: 1n, objects: new Map([[1n, self]]) },
    knownSpells: EVERY_FORM_SPELL.map((id) => ({ id })),
    actionButtons: [
      { slot: 0, action: MAIN, type: ACTION_BUTTON_SPELL },
      { slot: 12, action: PAGE_TWO, type: ACTION_BUTTON_SPELL },
      { slot: 72, action: BATTLE, type: ACTION_BUTTON_SPELL },
      { slot: 78, action: BATTLE_SEVENTH, type: ACTION_BUTTON_SPELL },
      { slot: 84, action: DEFENSIVE, type: ACTION_BUTTON_SPELL },
      { slot: 108, action: MOONKIN, type: ACTION_BUTTON_SPELL },
      { slot: 120, action: VEHICLE, type: ACTION_BUTTON_SPELL },
    ],
    cooldownRemaining: (id) => (cooling.has(id) ? 5_000 : 0),
    cooldownState: () => undefined,
    isActiveMountSpell: () => false,
    setActionButton: (slot, action, type) => writes.push([slot, action, type]),
  };
  game.world = world;
  game.spells.clear();
  for (const id of [MAIN, PAGE_TWO, BATTLE, BATTLE_SEVENTH, DEFENSIVE, MOONKIN, VEHICLE]) {
    game.spells.set(id, {
      id, iconId: id, passive: false, startRecoveryTime: 0, effectAura: [0, 0, 0], effectMiscValue: [0, 0, 0],
    });
  }
  for (const [id, row] of FORM_ROWS) game.spells.set(id, { id, passive: false, ...row });

  const bar = await isolatedUi("ActionBar", {
    "../../world/ActionBarProtocol.js": protocol,
    // 4.05: the drag payloads and the strict drop reader live there now.
    "./ActionDrag.js": await import("../dist/code/browser/ui/ActionDrag.js"),
    "../input/Bindings.js": bindings,
    "../game/Context.js": context,
    "../game/BonusBar.js": await bonusBarModule(),
    "../SpellMetadata.js": spellMetadata,
    "../SpellCastGuard.js": { spellPowerAvailable: () => true },
    "../../world/WorldClient.js": { MELEE_AUTO_ATTACK_SPELL_ID: 6603 },
    "./Spellbook.js": {
      castSpell: (id) => { casts.push(id); return true; },
      highestKnownRank: (id) => id,
      spellTooltip: (id) => ({ title: `spell ${id}` }),
    },
    "./Dom.js": { actionBar },
    "./Widgets.js": {
      IconButton,
      attachTooltip: (root, provider) => tooltips.set(root, provider),
      cooldownDuration: () => 0,
      cooldownLabel: () => "",
      cooldownView: (_now, own) => ({ fraction: own > 0 ? 0.5 : 0, remaining: own }),
    },
    "./IconImage.js": { spellIconUrl: (iconId) => `icon ${iconId}` },
    "./SpellNames.js": { ensureSpellNames: (ids) => requested.push(...ids) },
    "../GameWindows.js": { notifyHudLayout: () => { counts.layouts += 1; } },
  });
  const actions = await isolatedModule("browser/input/Actions", {
    "../ui/ActionBar.js": bar,
    "./Bindings.js": bindings,
    "../../world/ActionBarProtocol.js": protocol,
    "../game/Context.js": context,
  });
  return {
    bar, casts, writes, tooltips, requested, counts, cooling,
    setForm: (form) => self.fields.set(BYTES_2, form * 2 ** 24),
    /** What one key press cast. */
    press(action) {
      casts.length = 0;
      assert.equal(actions.runAction(action), true, `${action} is handled`);
      return casts.slice();
    },
    mainRow: () => actionBar.children.map((root) => byRoot.get(root)),
    dispose() {
      game.world = undefined;
      game.spells.clear();
    },
  };
}

test("keys 1–= press the bonus page of a stance, a form or stealth, and only on main page 1", async () => {
  const native = await nativeActionBar();
  try {
    assert.deepEqual(native.press("action1"), [MAIN], "no form: the main page");
    native.setForm(FORMS.battleStance.form);
    assert.deepEqual(native.press("action1"), [BATTLE], "Battle Stance: slot 72");
    native.setForm(FORMS.defensiveStance.form);
    assert.deepEqual(native.press("action1"), [DEFENSIVE], "Defensive Stance: slot 84");
    native.setForm(FORMS.moonkin.form);
    assert.deepEqual(native.press("action1"), [MOONKIN], "Moonkin Form: slot 108");
    native.setForm(FORMS.stealth.form);
    assert.deepEqual(native.press("action1"), [BATTLE], "Stealth: slot 72");
    native.setForm(FORMS.battleStance.form);
    native.bar.turnActionPage(1);
    assert.deepEqual(native.press("action1"), [PAGE_TWO], "page 2 wins over the stance: slot 12");
    native.bar.turnActionPage(0);
    assert.deepEqual(native.press("action1"), [BATTLE], "back on page 1 the stance applies again");
    native.setForm(0);
    assert.deepEqual(native.press("action1"), [MAIN], "leaving the stance returns to the main page");
  } finally {
    native.dispose();
  }
});

test("the native main row shows the bonus page, redraws on a form change, and its buttons act on it", async () => {
  const native = await nativeActionBar();
  try {
    native.bar.showActionBar();
    const first = () => native.mainRow()[0];
    assert.equal(native.mainRow().length, 12);
    assert.equal(first().content?.icon, `icon ${MAIN}`);
    assert.ok([BATTLE, DEFENSIVE, MOONKIN].every((id) => native.requested.includes(id)),
      "the bonus pages' rows are asked for with the rest of the 144 slots");
    const { counts } = native;
    const layouts = counts.layouts;
    counts.draws = 0;
    native.setForm(FORMS.battleStance.form);
    native.bar.updateActionBar(1_000);
    assert.equal(first().content?.icon, `icon ${BATTLE}`, "entering the stance redraws the row");
    assert.equal(counts.draws, 12, "the main row's twelve buttons, drawn once");
    assert.equal(counts.layouts, layouts, "a form change redraws the main row, not the whole HUD layout");
    native.bar.updateActionBar(1_016);
    assert.equal(counts.draws, 12, "a frame in the same form draws nothing");
    // A whole redraw (rows landing, buttons changing) and the paging keys draw the same pages at once.
    native.bar.showActionBar();
    assert.equal(first().content?.icon, `icon ${BATTLE}`, "a full redraw in the stance keeps the bonus page");
    native.bar.turnActionPage(1);
    assert.equal(first().content?.icon, `icon ${PAGE_TWO}`, "page 2 is drawn as soon as it is turned to");
    native.bar.turnActionPage(0);
    assert.equal(first().content?.icon, `icon ${BATTLE}`);

    native.casts.length = 0;
    first().options.onClick();
    assert.deepEqual(native.casts, [BATTLE], "a click presses what the row shows");
    assert.equal(native.tooltips.get(first().root)()?.title, `spell ${BATTLE}`);
    let dragged;
    first().listeners.dragstart({
      preventDefault() {},
      dataTransfer: { setData: (_format, value) => { dragged = JSON.parse(value); } },
    });
    assert.equal(dragged?.from, 72, "a drag starts from the bonus slot");
    first().listeners.drop({
      preventDefault() {},
      dataTransfer: { getData: () => JSON.stringify({ action: 555, type: ACTION_BUTTON_SPELL }) },
    });
    first().listeners.contextmenu({ preventDefault() {} });
    assert.deepEqual(native.writes, [[72, 555, ACTION_BUTTON_SPELL], [72, 0, 0]],
      "a drop and a right-click write the bonus slot on screen, not slot 0");

    // The sweep and the grey follow the slot on screen: slot 72 recovering greys the first button
    // in the stance, and leaving the stance frees it again (slot 0 is not recovering).
    native.cooling.add(BATTLE);
    native.bar.updateActionBar(1_032);
    assert.equal(first().usable, false, "slot 72 is recovering");
    assert.equal(first().cooldown, 0.5);
    native.setForm(0);
    native.bar.updateActionBar(1_048);
    assert.equal(first().content?.icon, `icon ${MAIN}`, "leaving the stance redraws the main page");
    assert.equal(first().usable, true, "slot 0 is not recovering");
    assert.equal(first().cooldown, 0);
  } finally {
    native.dispose();
  }
});

test("GetActionBarPage stays the main page 1..6 while the bonus page is in use", async () => {
  const native = await nativeActionBar();
  try {
    native.setForm(FORMS.battleStance.form);
    assert.equal(native.bar.getActionBarPage(), 1);
    native.bar.turnActionPage(1);
    assert.equal(native.bar.getActionBarPage(), 2);
  } finally {
    native.dispose();
  }
});

// Stock ActionButtonDown/Up (ActionButton.lua:17,31) send only keys 1–6 to the vehicle bar
// (VEHICLE_MAX_ACTIONBUTTONS = 6, VehicleMenuBar.lua:6), so the hook line A9 fills answers per column.
test("a per-column key-bar override (the empty hook line A9 fills for vehicles) wins where it answers", async () => {
  const native = await nativeActionBar();
  const { bonusBarHooks } = await bonusBarModule();
  try {
    native.bar.showActionBar();
    const row = () => native.mainRow().map((button) => button.content?.icon);
    native.setForm(FORMS.battleStance.form);
    bonusBarHooks.keyBarOverride = (column) => (column < 6 ? 10 : undefined);
    assert.deepEqual(native.press("action1"), [VEHICLE], "key 1: the override's page, slot 120");
    assert.deepEqual(native.press("action7"), [BATTLE_SEVENTH], "key 7: no answer, the stance's slot 78");
    native.bar.updateActionBar(2_000);
    assert.equal(row()[0], `icon ${VEHICLE}`, "the row follows the override where it answers");
    assert.equal(row()[6], `icon ${BATTLE_SEVENTH}`, "and the bonus page where it does not");
    bonusBarHooks.keyBarOverride = (column) => (column < 6 ? 0 : undefined);
    assert.deepEqual(native.press("action1"), [MAIN], "page 0 is an answer, not a missing one");
    bonusBarHooks.keyBarOverride = undefined;
    assert.deepEqual(native.press("action1"), [BATTLE], "no hook: the bonus rule again");
    native.bar.updateActionBar(2_016);
    assert.equal(row()[0], `icon ${BATTLE}`, "and the row with it");
  } finally {
    bonusBarHooks.keyBarOverride = undefined;
    native.dispose();
  }
});
