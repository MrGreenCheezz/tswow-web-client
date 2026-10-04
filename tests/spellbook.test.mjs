// Regression: the rank in the spellbook button's caption used to cost the spell its name.
//
// Every row of the book printed the rank twice — once in the gold badge in the corner of the icon
// (`Spellbook.ts:172` → the `<small>`), and once again in the caption beside it. The caption is the
// `1fr` half of a two-column 48-pixel row with `white-space: nowrap` and `text-overflow: ellipsis`
// (`style.css:446,447,450`), so «Огненный шар · Уровень 16» was clipped mid-name to make room for
// a string already legible three centimetres to the right. The badge keeps the rank; the caption
// gets the name back. One line, no new concepts, and the names read at a glance.
//
// К1: and then the ranks themselves. The client had no notion of one — `Spellbook.ts` printed
// `metadata.rank` and never compared two spells — so a mage's book was 351 rows over thirty pages
// of twelve. The chain key is `SkillLine + SpellClassSet + SpellClassMask + Name_lang` with the
// digits of the rank string masked out; the corpus tests below run the shipped predicate over all
// 7,369 spells that reach the book and pin every number in the comments that describe it.

import assert from "node:assert/strict";
import test from "node:test";

/** The document `self-name.test.mjs` uses: `ui/Dom.ts` resolves its handles once, at import. */
function fakeDocument() {
  const byId = new Map();
  const make = (tag) => {
    const node = {
      tagName: String(tag).toUpperCase(), children: [], dataset: {}, className: "", textContent: "",
      title: "", hidden: false, disabled: false, id: "", value: "", type: "", draggable: false,
      checked: false,
      style: { setProperty(name, value) { this[name] = value; }, removeProperty(name) { delete this[name]; } },
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      append(...nodes) { node.children.push(...nodes); },
      prepend(...nodes) { node.children.unshift(...nodes); },
      appendChild(child) { node.children.push(child); return child; },
      replaceChildren(...nodes) { node.children = [...nodes]; },
      remove() {}, focus() {}, blur() {},
      addEventListener() {}, removeEventListener() {},
      setAttribute(name, value) { node[name] = value; },
      getAttribute(name) { return node[name] ?? null; },
      removeAttribute(name) { delete node[name]; },
      querySelector() { return make("div"); }, querySelectorAll() { return []; }, closest() { return undefined; },
      getBoundingClientRect() { return { x: 0, y: 0, width: 100, height: 100, top: 0, left: 0, right: 100, bottom: 100 }; },
      getContext() { return null; },
    };
    return node;
  };
  return {
    createElement: make, createElementNS: (_namespace, tag) => make(tag),
    createTextNode: (text) => ({ textContent: text }), createDocumentFragment: () => make("fragment"),
    body: make("body"), documentElement: make("html"), head: make("head"),
    getElementById(id) {
      let node = byId.get(id);
      if (!node) {
        node = make("div");
        node.id = id;
        byId.set(id, node);
      }
      return node;
    },
    querySelector() { return make("div"); }, querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {},
  };
}

globalThis.document = fakeDocument();
globalThis.location = { protocol: "http:", hostname: "127.0.0.1", origin: "http://127.0.0.1:5173" };
globalThis.window = {
  addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1,
  innerWidth: 1280, innerHeight: 800,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
};
globalThis.localStorage = globalThis.window.localStorage;
globalThis.matchMedia = globalThis.window.matchMedia;
globalThis.requestAnimationFrame = () => 0;
globalThis.HTMLElement = class {};

const { game } = await import("../dist/code/browser/game/Context.js");
const {
  castSpell, loadSpellMetadata, selectSpellbookTab, setSpellbookRankFilter, setSpellbookSearch, showSpells, spellTooltip,
  spellAbilityMatchesActor, spellAbilityVisible, SKILL_INTERNAL, updateSpellCooldowns,
  spellbookSearchKeyDown,
} = await import("../dist/code/browser/ui/Spellbook.js");
const { useSlot } = await import("../dist/code/browser/ui/ActionBar.js");
const { getTip } = await import("../dist/code/browser/ui/Widgets.js");
const { loadAuraMetadata } = await import("../dist/code/browser/ui/Auras.js");
const { clearSpellNames, ensureSpellNames } = await import("../dist/code/browser/ui/SpellNames.js");
const { lowerRankSpells, rankChainKey } = await import("../dist/code/browser/ui/SpellRanks.js");
const {
  spellbookHideRanks, spellbookList, spellbookSearch, spellbookTabs, spellStatus,
} = await import("../dist/code/browser/ui/Dom.js");

let dbcDirectory;
try {
  dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
} catch {
  dbcDirectory = undefined;
}
const withDataset = { skip: dbcDirectory ? false : "no tswow dataset on this machine" };

/** A `Spell.dbc` row as the gateway serves it, with only the fields a button reads filled in. */
function spell(id, name, rank, passive = false, extra = {}) {
  return {
    id, name, rank, description: "", iconId: 0, iconPath: "", passive, hidden: false,
    powerType: 0, powerCost: 0, powerCostPercent: 0, recoveryTime: 0, categoryRecoveryTime: 0,
    startRecoveryTime: 0, cooldownStartedOnEvent: false, effectAura: [], effectMiscValue: [],
    spellLevel: 0, spellClassSet: 3, spellClassMask: [1, 0, 0], schoolMask: 0,
    rangeMin: 0, rangeMax: 0, rangeFlags: 0, castTime: 0,
    ...extra,
  };
}

/** A character who knows these spells; `showSpells` also asks the world about every cooldown. */
const book = (ids) => ({
  knownSpells: ids.map((id, slot) => ({ id, slot })),
  initialSpellsReceived: true,
  cooldownRemaining: () => 0,
  cooldownState: () => undefined,
  state: { selfGuid: undefined, objects: new Map() },
});

/** Stands in for `TalentClient`: one skill line per spell, which is what a book tab is. */
const talents = (lines, categoryId = 0) => ({
  ready: true,
  skillOfSpell: (id) => lines[id],
  skillLine: (id) => ({ id, name: `Линия ${id}`, categoryId, iconId: 0 }),
});

/** What `lowerRankSpells` takes: metadata plus the skill line, which comes from `/dbc/talents`. */
const ranked = (id, name, rank, spellLevel, extra = {}) => ({
  id, name, rank, spellLevel, skillLine: 6, spellClassSet: 3, spellClassMask: [1, 0, 0], ...extra,
});

const captions = () => spellbookList.children.map((button) => button.children[1].textContent);

test("profession openers join General while recipes stay in the craft window", async () => {
  const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
  const fields = new Map([
    [UPDATE_FIELDS.PLAYER_SKILL_INFO_1_1.offset, 171],
    [UPDATE_FIELDS.PLAYER_SKILL_INFO_1_1.offset + 1, 75 << 16 | 15],
  ]);
  try {
    game.spellMetadataClient = undefined;
    game.world = book([133, 20598, 2259, 2018, 2330, 5504]);
    game.world.state.selfGuid = 1n;
    game.world.state.objects.set(1n, { guid: 1n, fields });
    game.spells = new Map([
      [133, spell(133, "Огненный шар", "")],
      [20598, spell(20598, "Человеческий дух", "", true)],
      [2259, spell(2259, "Алхимия", "", false, { effects: [47, 118, 0], effectMiscValue: [0, 171, 0] })],
      [2018, spell(2018, "Кузнечное дело", "", false, { effects: [47, 118, 0], effectMiscValue: [0, 164, 0] })],
      [2330, spell(2330, "Слабое лечебное зелье", "", false, { tradeSkill: true, effects: [24, 0, 0] })],
      // An item-creating class spell without TRADESPELL: the original keeps it in its class tab.
      [5504, spell(5504, "Наколдовать воду", "", false, { tradeSkill: false, effects: [24, 0, 0] })],
    ]);
    game.talentData = {
      ...talents({ 133: 8, 20598: 754, 2259: 171, 2018: 164, 2330: 171, 5504: 8 }),
      skillLine(id) { return { id, name: `Навык ${id}`, categoryId: [171, 164].includes(id) ? 11 : 7, iconId: 0 }; },
    };
    selectSpellbookTab(undefined);
    setSpellbookSearch("");
    showSpells();
    // Openers sit in General and a click opens their craft window; recipes stay out, because they
    // only cast from that window and their reagents live there. Neither gets a profession tab.
    assert.deepEqual(captions().sort(), ["Алхимия", "Кузнечное дело"].sort());
    const tabLabels = spellbookTabs.children[0].children.map((button) =>
      button.children.map((child) => child.textContent).join(""));
    assert.deepEqual(tabLabels, ["Общие (2)", "Навык 754 (1)", "Навык 8 (2)"],
      "the profession category 11 line is not a tab of its own");
    selectSpellbookTab(754);
    assert.deepEqual(captions(), ["Человеческий дух · пассивное"], "the racial line keeps its own tab");
    selectSpellbookTab(8);
    assert.deepEqual(captions().sort(), ["Наколдовать воду", "Огненный шар"].sort(),
      "Conjure Water creates an item and is not a recipe: the TRADESPELL attribute is the client's rule");
  } finally {
    game.world = undefined;
    game.talentData = undefined;
    game.spells = new Map();
  }
});

test("SkillLineAbility filtering rejects Trinity internals without hiding passive or profession rows", () => {
  const base = { raceMask: 0, classMask: 0, acquireMethod: 0, supercededBySpell: 0 };
  assert.equal(SKILL_INTERNAL, 769);
  assert.equal(spellAbilityVisible({ ...base, skillLine: SKILL_INTERNAL }), false,
    "the internal/debug skill line is never a spellbook category");
  assert.equal(spellAbilityMatchesActor({ ...base, skillLine: SKILL_INTERNAL }, { classId: 1, raceId: 1 }), false);

  // Class/race masks of zero are deliberately permissive: these are how general, passive and
  // profession abilities are represented in SkillLineAbility, not a signal that a row is internal.
  for (const skillLine of [6, 164]) {
    assert.equal(spellAbilityMatchesActor({ ...base, skillLine }, { classId: 8, raceId: 4 }), true,
      `skill line ${skillLine} remains available with zero masks`);
  }
  assert.equal(spellAbilityMatchesActor({ ...base, skillLine: 6, classMask: 1 }, { classId: 2 }), false,
    "a non-matching class mask still excludes the row");
  assert.equal(spellAbilityMatchesActor({ ...base, skillLine: 6, classMask: 1 }, { classId: 1 }), true);
});

test("the active mount toggle bypasses its local cooldown", () => {
  const mountSpell = 23214;
  const calls = [];
  try {
    game.spells = new Map([[mountSpell, spell(mountSpell, "Стремительный скакун", "", false, {
      effectAura: [78, 0, 0], recoveryTime: 10_000, startRecoveryTime: 1_500,
    })]]);
    game.world = {
      knownSpells: [{ id: mountSpell, slot: 0 }],
      state: { selfGuid: 1n, objects: new Map() },
      cooldownRemaining: () => 10_000,
      isActiveMountSpell: (spellId) => spellId === mountSpell,
      castSpell: (...args) => calls.push(args),
    };

    assert.equal(castSpell(mountSpell), true);
    assert.deepEqual(calls, [[mountSpell, 10_000, false]],
      "the press reaches WorldClient, which turns it into cancel-only");
  } finally {
    game.world = undefined;
    game.spells = new Map();
  }
});

test("the action-bar Attack client action bypasses learned-spell and metadata gates", () => {
  const calls = [];
  try {
    game.spells = new Map();
    game.world = {
      knownSpells: [],
      actionButtons: [{ slot: 0, action: 6603, type: 0 }],
      state: { selfGuid: 1n, objects: new Map() },
      castSpell: (...args) => calls.push(args),
    };

    useSlot(0, 0);

    assert.deepEqual(calls, [[6603]], "the visible action slot reaches ATTACK_SWING routing");
  } finally {
    game.world = undefined;
    game.spells = new Map();
  }
});

test("loaded DBC aura 78 classifies mount spells for every WorldClient cast path", async () => {
  const mountSpell = 23214;
  const ordinarySpell = 133;
  let classified = [];
  try {
    game.world = undefined;
    game.spells = new Map();
    game.spellMetadataClient = {
      async load(ids) {
        return new Map(ids.map((id) => [id, id === mountSpell
          ? spell(id, "Стремительный скакун", "", false, { effectAura: [78, 0, 0] })
          : spell(id, "Огненный шар", "Уровень 1")]));
      },
    };
    const world = {
      knownSpells: [{ id: mountSpell, slot: 0 }, { id: ordinarySpell, slot: 1 }],
      initialSpellsReceived: true,
      cooldownRemaining: () => 0,
      cooldownState: () => undefined,
      isActiveMountSpell: () => false,
      state: { selfGuid: undefined, objects: new Map() },
      setMountSpellIds(ids) { classified = [...ids]; },
    };
    game.world = world;

    await loadSpellMetadata(world);

    assert.deepEqual(classified, [mountSpell]);
  } finally {
    game.spellMetadataClient = undefined;
    game.world = undefined;
    game.spells = new Map();
  }
});

test("an active mount remains clickable while its local recovery is visible", () => {
  const mountSpell = 23214;
  try {
    game.spells = new Map([[mountSpell, spell(mountSpell, "Стремительный скакун", "", false, {
      effectAura: [78, 0, 0], recoveryTime: 10_000,
    })]]);
    game.talentData = undefined;
    game.world = {
      knownSpells: [{ id: mountSpell, slot: 0 }],
      initialSpellsReceived: true,
      cooldownRemaining: () => 10_000,
      cooldownState: () => undefined,
      isActiveMountSpell: (spellId) => spellId === mountSpell,
      state: { selfGuid: 1n, objects: new Map() },
    };

    showSpells();
    updateSpellCooldowns(performance.now());
    const button = spellbookList.children[0];
    assert.equal(button.disabled, false);
    assert.equal(button.getAttribute("aria-disabled"), "false");
    assert.equal(getTip(button), "Стремительный скакун · Снять маунта");
    assert.equal(button.getAttribute("aria-label"), "Стремительный скакун · Снять маунта");
  } finally {
    game.world = undefined;
    game.spells = new Map();
    game.talentData = undefined;
  }
});

test("a metadata batch from another window also refreshes mount classification", async () => {
  const mountSpell = 23214;
  let classified = [];
  const world = {
    knownSpells: [{ id: mountSpell, slot: 0 }],
    auras: new Map([[1n, new Map([[0, { spellId: mountSpell }]])]]),
    targetGuid: undefined,
    aurasFor: () => [],
    state: { selfGuid: 1n, objects: new Map() },
    setMountSpellIds(ids) { classified = [...ids]; },
  };
  const previousClient = game.spellMetadataClient;
  try {
    game.world = world;
    game.spells = new Map();
    game.spellMetadataClient = {
      async load() { return new Map([[mountSpell, spell(mountSpell, "Стремительный скакун", "", false, { effectAura: [78, 0, 0] })]]); },
    };
    await loadAuraMetadata(world);
    assert.deepEqual(classified, [mountSpell]);
  } finally {
    game.spellMetadataClient = previousClient;
    game.world = undefined;
    game.spells = new Map();
  }
});

test("a failed known-spell batch preserves classification already supplied by another loader", async () => {
  const mountSpell = 23214;
  let classified = [];
  const world = {
    knownSpells: [{ id: mountSpell, slot: 0 }],
    state: { selfGuid: undefined, objects: new Map() },
    setMountSpellIds(ids) { classified = [...ids]; },
  };
  const previousClient = game.spellMetadataClient;
  try {
    game.world = world;
    game.spells = new Map([[mountSpell, spell(mountSpell, "Стремительный скакун", "", false, { effectAura: [78, 0, 0] })]]);
    game.spellMetadataClient = { async load() { throw new Error("offline"); } };
    await loadSpellMetadata(world);
    assert.deepEqual(classified, [mountSpell]);
  } finally {
    game.spellMetadataClient = previousClient;
    game.world = undefined;
    game.spells = new Map();
  }
});

test("a settled metadata response may omit a custom row without leaving the book loading forever", async () => {
  const spellId = 991001;
  const world = {
    knownSpells: [{ id: spellId, slot: 0 }], initialSpellsReceived: true,
    cooldownRemaining: () => 0, cooldownState: () => undefined,
    state: { selfGuid: undefined, objects: new Map() },
  };
  const previousClient = game.spellMetadataClient;
  const previousTalentData = game.talentData;
  try {
    game.world = world;
    game.spells = new Map();
    game.talentData = {
      ready: true,
      spellAbilitiesOf: () => [{ skillLine: 6, raceMask: 0, classMask: 0, acquireMethod: 0, supercededBySpell: 0 }],
      skillLine: () => undefined,
      skillOfSpell: () => 6,
    };
    game.spellMetadataClient = { async load() { return new Map(); } };
    await loadSpellMetadata(world);
    showSpells();
    assert.equal(spellStatus.textContent, "1 заклинаний");
    assert.equal(spellbookList.children.length, 1, "the legitimate row remains visible as an unknown spell");
  } finally {
    game.spellMetadataClient = previousClient;
    game.talentData = previousTalentData;
    game.world = undefined;
    game.spells = new Map();
  }
});

test("a learned spell with no SkillLineAbility row lands in General instead of vanishing", () => {
  const spellId = 991001;
  const previousTalent = game.talentData;
  try {
    game.gatewayOrigin = undefined;
    game.spells = new Map();
    game.talentData = {
      ready: true,
      skillOfSpell: () => undefined,
      spellAbilitiesOf: () => [],
      skillLine: () => undefined,
    };
    game.world = {
      knownSpells: [{ id: spellId, slot: 0 }], initialSpellsReceived: true,
      cooldownRemaining: () => 0, cooldownState: () => undefined,
      state: { selfGuid: undefined, objects: new Map() },
    };
    selectSpellbookTab(8);
    showSpells();
    assert.equal(spellbookList.children.length, 1, "the learned row is shown, not dropped for having no tab");
    assert.equal(spellStatus.textContent, "1 заклинаний");
    const tabLabels = spellbookTabs.children[0].children.map((button) =>
      button.children.map((child) => child.textContent).join(""));
    assert.deepEqual(tabLabels, ["Общие (1)"], "an empty class tab is not drawn and General takes the row");
    assert.equal(spellbookTabs.children[0].children[0].className.split(" ").includes("is-active"), true);
  } finally {
    game.talentData = previousTalent;
    game.world = undefined;
    game.spells = new Map();
    selectSpellbookTab(undefined);
  }
});

test("a stale spell-name response cannot cross a relog epoch", async () => {
  const spellId = 23214;
  let resolveOld;
  const oldCalls = [];
  const oldClient = {
    load(ids) {
      oldCalls.push([...ids]);
      return new Promise((resolve) => { resolveOld = resolve; });
    },
  };
  const oldWorld = {
    knownSpells: [{ id: spellId, slot: 0 }],
    setMountSpellIds() { throw new Error("stale world must never be classified"); },
  };
  let oldListenerCalls = 0;
  const newCalls = [];
  const newWorld = {
    knownSpells: [{ id: spellId, slot: 0 }],
    setMountSpellIds(ids) { this.mounts = [...ids]; },
    mounts: [],
  };
  const newMetadata = spell(spellId, "Новый маунт", "", false, { effectAura: [78, 0, 0] });
  const newClient = {
    load(ids) {
      newCalls.push([...ids]);
      return Promise.resolve(new Map([[spellId, newMetadata]]));
    },
  };
  const previousClient = game.spellMetadataClient;
  try {
    clearSpellNames();
    game.spells = new Map();
    game.world = oldWorld;
    game.spellMetadataClient = oldClient;
    ensureSpellNames([spellId], () => { oldListenerCalls += 1; });
    await Promise.resolve();
    assert.deepEqual(oldCalls, [[spellId]]);

    // Entering another character invalidates the first request before its deferred response lands.
    clearSpellNames();
    game.world = newWorld;
    game.spellMetadataClient = newClient;
    resolveOld(new Map([[spellId, spell(spellId, "Старый маунт", "", false, { effectAura: [78, 0, 0] })]]));
    for (let index = 0; index < 3; index++) await Promise.resolve();
    assert.equal(game.spells.has(spellId), false, "stale data is not written into the new epoch");
    assert.equal(oldListenerCalls, 0, "stale listeners are not called");
    assert.deepEqual(newWorld.mounts, [], "stale response does not classify the old world");

    // The id was made retryable by clearSpellNames: the new epoch asks for it normally.
    ensureSpellNames([spellId], () => {});
    for (let index = 0; index < 3; index++) await Promise.resolve();
    assert.deepEqual(newCalls, [[spellId]]);
    assert.equal(game.spells.get(spellId)?.name, "Новый маунт");
    assert.deepEqual(newWorld.mounts, [spellId]);
  } finally {
    clearSpellNames();
    game.spellMetadataClient = previousClient;
    game.world = undefined;
    game.spells = new Map();
  }
});

test("a stale spellbook metadata response has no global or mount side effects", async () => {
  const spellId = 23214;
  let resolveOld;
  const oldClient = {
    load() { return new Promise((resolve) => { resolveOld = resolve; }); },
  };
  const oldWorld = {
    knownSpells: [{ id: spellId, slot: 0 }],
    setMountSpellIds() { throw new Error("stale spellbook world must never be classified"); },
  };
  const newWorld = {
    knownSpells: [{ id: spellId, slot: 0 }],
    mounts: [],
    setMountSpellIds(ids) { this.mounts = [...ids]; },
  };
  const previousClient = game.spellMetadataClient;
  try {
    clearSpellNames();
    game.spells = new Map();
    game.world = oldWorld;
    game.spellMetadataClient = oldClient;
    const pending = loadSpellMetadata(oldWorld);
    await Promise.resolve();

    clearSpellNames();
    game.world = newWorld;
    game.spellMetadataClient = { load: async () => new Map() };
    resolveOld(new Map([[spellId, spell(spellId, "Старый маунт", "", false, { effectAura: [78, 0, 0] })]]));
    await pending;

    assert.equal(game.spells.has(spellId), false);
    assert.deepEqual(newWorld.mounts, [], "stale spellbook data does not classify the current world");
  } finally {
    clearSpellNames();
    game.spellMetadataClient = previousClient;
    game.world = undefined;
    game.spells = new Map();
  }
});

test("a stale aura metadata response has no global or mount side effects", async () => {
  const spellId = 23214;
  let resolveOld;
  const oldClient = {
    load() { return new Promise((resolve) => { resolveOld = resolve; }); },
  };
  const oldWorld = {
    auras: new Map([[1n, new Map([[0, { spellId }]])]]),
    setMountSpellIds() { throw new Error("stale aura world must never be classified"); },
  };
  const newWorld = {
    knownSpells: [],
    mounts: [],
    setMountSpellIds(ids) { this.mounts = [...ids]; },
  };
  const previousClient = game.spellMetadataClient;
  try {
    clearSpellNames();
    game.spells = new Map();
    game.world = oldWorld;
    game.spellMetadataClient = oldClient;
    const pending = loadAuraMetadata(oldWorld);
    await Promise.resolve();

    clearSpellNames();
    game.world = newWorld;
    game.spellMetadataClient = { load: async () => new Map() };
    resolveOld(new Map([[spellId, spell(spellId, "Старый маунт", "", false, { effectAura: [78, 0, 0] })]]));
    await pending;

    assert.equal(game.spells.has(spellId), false);
    assert.deepEqual(newWorld.mounts, [], "stale aura data does not classify the current world");
  } finally {
    clearSpellNames();
    game.spellMetadataClient = previousClient;
    game.world = undefined;
    game.spells = new Map();
  }
});

test("Ж0 the spellbook button's caption is the name; the rank stays in its badge", () => {
  try {
    // Fireball rank 16 and Arcane Intellect rank 3 — two of the longest names a mage carries, and
    // both rows are the dataset's own: 42833 is «Уровень 16» at `SpellLevel` 78 (38692, which stood
    // here, is «Уровень 14» at 70), 27126 is «Уровень 3» at 60.
    game.spells = new Map([
      [42833, spell(42833, "Огненный шар", "Уровень 16", false, { spellLevel: 78 })],
      [27126, spell(27126, "Магический интеллект", "Уровень 3", false, { spellLevel: 60 })],
    ]);
    game.talentData = undefined;
    game.gatewayOrigin = undefined;
    game.world = book([42833, 27126]);

    showSpells();
    const buttons = spellbookList.children;
    assert.equal(buttons.length, 2, "one button per known spell");

    // `createSpellButton` appends icon, label, badge, cooldown in that order.
    const labels = buttons.map((button) => button.children[1]);
    const badges = buttons.map((button) => button.children[2]);
    assert.deepEqual(labels.map((node) => node.className), ["spell-label", "spell-label"]);
    assert.deepEqual(badges.map((node) => node.tagName), ["SMALL", "SMALL"]);

    // К1 sorts the book by `(SpellLevel, name)`, so Arcane Intellect at 60 stands above Fireball
    // at 78. The order the wire gives is no order at all: `Player.cpp:2883` writes a constant
    // where `SMSG_INITIAL_SPELLS` would carry a slot number.
    assert.deepEqual(labels.map((node) => node.textContent), ["Магический интеллект", "Огненный шар"]);
    assert.deepEqual(badges.map((node) => node.textContent), ["Уровень 3", "Уровень 16"]);
    for (const label of labels) {
      assert.equal(label.textContent.includes("Уровень"), false, "the rank is not in the clipped column");
    }

    // The one other thing the caption still carries, because there is nowhere else for it: a
    // passive spell cannot be cast and the button says so instead of looking merely disabled.
    game.spells = new Map([[1126, spell(1126, "Знак дикой природы", "Уровень 5", true)]]);
    game.world = book([1126]);
    showSpells();
    assert.equal(spellbookList.children[0].children[1].textContent, "Знак дикой природы · пассивное");
    assert.equal(spellbookList.children[0].children[2].textContent, "Уровень 5");
  } finally {
    game.world = undefined;
    game.spells = new Map();
  }
});

test("К1 a chain is a family plus a name plus the shape of the rank string", () => {
  // Sixteen ranks of one spell make one chain and fifteen lower ranks. Nothing here parses the
  // rank string: the digits are masked so that «Уровень 1» and «Уровень 16» land on one key, and
  // the order comes from `SpellLevel`.
  const fireball = Array.from({ length: 16 }, (_, index) =>
    ranked(100 + index, "Огненный шар", `Уровень ${index + 1}`, index * 5));
  const lower = lowerRankSpells(fireball);
  assert.equal(lower.size, 15);
  assert.equal(lower.has(115), false, "the sixteenth rank is the one that stays");

  // One link of a chain is not a chain: the predicate takes what the character knows, so a mage
  // who has learned only rank 1 keeps rank 1.
  assert.equal(lowerRankSpells([fireball[0]]).size, 0);

  // The gate: every member has to carry its own rank string. Two rows with the *same* one mean the
  // key has swept up something that is not a chain — 60192 and 60202 are both «Замораживающая
  // стрела (Уровень 1)», one written for level 80 and one for 60 — and a group whose rows carry no
  // rank string at all is that same case, because the empty string repeats too: the hunter's
  // «Приручение зверя» 1515 and 13481 are one skill line and one name, both at `SpellLevel` 10 and
  // neither with a word in the rank string — the only one of the book's 70 blank groups a hunter
  // owns. (13809 «Ледяная ловушка» and 34600 «Змеиная ловушка» stood here and are two names, not
  // one: 34600 is the snake trap, and 13809 is alone in the book under its own name.)
  assert.equal(lowerRankSpells([
    ranked(60192, "Замораживающая стрела", "Уровень 1", 80, { skillLine: 51, spellClassSet: 9, spellClassMask: [128, 0, 0] }),
    ranked(60202, "Замораживающая стрела", "Уровень 1", 60, { skillLine: 51, spellClassSet: 9, spellClassMask: [128, 0, 0] }),
  ]).size, 0, "two rows with one rank string are not two ranks");
  assert.equal(lowerRankSpells([
    ranked(1515, "Приручение зверя", "", 10, { skillLine: 50, spellClassSet: 0, spellClassMask: [0, 0, 0] }),
    ranked(13481, "Приручение зверя", "", 10, { skillLine: 50, spellClassSet: 0, spellClassMask: [0, 0, 0] }),
  ]).size, 0, "and a blank rank string arrives at the same gate, as a repeat of the empty one");

  // Which is why there is one gate and not two. A blank rank cannot reach a group that would
  // otherwise be reduced: `rankChainKey` carries the rank string with its digits masked, masking
  // turns "" into "" and nothing else into "", so a group holding a blank rank holds only blank
  // ranks. Two rows that differ *only* in a blank versus a filled rank are two keys, not a group —
  // and over the book that is 0 groups mixing the two, against 70 all-blank and 24 repeated.
  // 1515 as the table has it, against the same row with a rank string written into it — which no
  // row of that pair carries, and which is the point: the two would not be one group if it did.
  assert.notEqual(
    rankChainKey(ranked(1515, "Приручение зверя", "", 10, { skillLine: 50, spellClassSet: 0, spellClassMask: [0, 0, 0] })),
    rankChainKey(ranked(13481, "Приручение зверя", "Уровень 2", 10, { skillLine: 50, spellClassSet: 0, spellClassMask: [0, 0, 0] })),
    "a blank rank and a filled one are never one chain");

  // The name has to be in the key. «Морозный доспех» 1-3 and «Ледяной доспех» 1-6 share skill line
  // 6, class set 3 and class mask 34078720,0,0 — everything but the name — so without it the mage
  // loses all three Frost Armours behind the sixth rank of a different spell.
  const armour = [
    ranked(168, "Морозный доспех", "Уровень 1", 1, { spellClassMask: [34078720, 0, 0] }),
    ranked(7300, "Морозный доспех", "Уровень 2", 10, { spellClassMask: [34078720, 0, 0] }),
    ranked(7301, "Морозный доспех", "Уровень 3", 20, { spellClassMask: [34078720, 0, 0] }),
    ranked(7302, "Ледяной доспех", "Уровень 1", 30, { spellClassMask: [34078720, 0, 0] }),
    ranked(43008, "Ледяной доспех", "Уровень 6", 79, { spellClassMask: [34078720, 0, 0] }),
  ];
  const armourLower = lowerRankSpells(armour);
  assert.equal(armourLower.has(7301), false, "the top Frost Armour is not a lower rank of Ice Armour");
  assert.deepEqual([...armourLower].sort((a, b) => a - b), [168, 7300, 7302]);
  assert.notEqual(rankChainKey(armour[2]), rankChainKey(armour[3]), "and the two do not share a key");
});

test("К1 masking the digits is what keeps «Превращение (Уровень 4)» in the book", () => {
  // Ten rows are named «Превращение» in the book: four ranks and six shapes, all on skill line
  // 237, all with class mask 16777216,0,0, all with a non-empty and distinct rank string. Without
  // the rank string in the key they are one group, the gates open, and the sort — six shapes at
  // `SpellLevel` 60 against rank 4 at 60 — keeps «Индейка» and hides the real top rank.
  const shape = (id, name) => ranked(id, "Превращение", name, 60, { skillLine: 237, spellClassMask: [16777216, 0, 0] });
  const polymorph = [
    ranked(118, "Превращение", "Уровень 1", 8, { skillLine: 237, spellClassMask: [16777216, 0, 0] }),
    ranked(12824, "Превращение", "Уровень 2", 20, { skillLine: 237, spellClassMask: [16777216, 0, 0] }),
    ranked(12825, "Превращение", "Уровень 3", 40, { skillLine: 237, spellClassMask: [16777216, 0, 0] }),
    ranked(12826, "Превращение", "Уровень 4", 60, { skillLine: 237, spellClassMask: [16777216, 0, 0] }),
    shape(28271, "Черепаха"), shape(28272, "Свинья"), shape(61025, "Змей"),
    shape(61305, "Черный кот"), shape(61721, "Кролик"), shape(61780, "Индейка"),
  ];
  const lower = lowerRankSpells(polymorph);
  assert.equal(lower.has(12826), false, "rank 4 is the top of the chain and stays");
  assert.equal(lower.has(61780), false, "and «Индейка» is a shape, not a lower rank of anything");
  assert.deepEqual([...lower].sort((a, b) => a - b), [118, 12824, 12825],
    "only the three genuinely lower ranks go");

  // The four numbered ranks and the six shapes are two different keys, which is the whole of it.
  assert.equal(rankChainKey(polymorph[0]), rankChainKey(polymorph[3]));
  assert.notEqual(rankChainKey(polymorph[3]), rankChainKey(polymorph[9]));
  assert.equal(new Set(polymorph.slice(4).map(rankChainKey)).size, 6, "each shape is its own key");
});

test("К1 the book is one list: sorted, searchable, and shorter by the top rank only", () => {
  try {
    game.gatewayOrigin = undefined;
    game.spells = new Map([
      [133, spell(133, "Огненный шар", "Уровень 1", false, { spellLevel: 1, powerCostPercent: 8 })],
      [143, spell(143, "Огненный шар", "Уровень 2", false, { spellLevel: 6, powerCostPercent: 9 })],
      [42833, spell(42833, "Огненный шар", "Уровень 16", false, { spellLevel: 78, powerCostPercent: 19 })],
      [168, spell(168, "Морозный доспех", "Уровень 1", false, { spellLevel: 1, spellClassMask: [34078720, 0, 0] })],
      [1459, spell(1459, "Магический интеллект", "Уровень 1", false, { spellLevel: 1, spellClassMask: [256, 0, 0] })],
    ]);
    // A non-class category puts every line in General, which is the tab this test reads: the list
    // behaviour under the rank switch, not the tab split.
    game.talentData = talents({ 133: 8, 143: 8, 42833: 8, 168: 6, 1459: 6 }, 11);
    game.world = book([42833, 133, 1459, 143, 168]);
    setSpellbookRankFilter(true);
    showSpells();

    // Five known spells, two of them lower ranks of the third: no page footer, no page number, and
    // every remaining row on the screen at once.
    assert.deepEqual(captions(), ["Магический интеллект", "Морозный доспех", "Огненный шар"]);
    assert.match(spellStatus.textContent, /младших рангов скрыто 2/);

    // The switch is the only thing between the two views, and turning it off restores all five in
    // the same `(SpellLevel, name)` order.
    setSpellbookRankFilter(false);
    assert.deepEqual(captions(), [
      "Магический интеллект", "Морозный доспех", "Огненный шар", "Огненный шар", "Огненный шар",
    ]);
    assert.equal(spellbookHideRanks.checked, false, "and the checkbox in the book's header follows it");
    setSpellbookRankFilter(true);

    // Search matches the name or the rank, and says how much of the tab it is showing.
    setSpellbookSearch("доспех");
    assert.deepEqual(captions(), ["Морозный доспех"]);
    assert.equal(spellStatus.textContent, "Найдено 1 из 3");
    setSpellbookSearch("ОГНЕННЫЙ");
    assert.deepEqual(captions(), ["Огненный шар"], "case folds");
    setSpellbookSearch("нет такого");
    assert.deepEqual(captions(), []);
    assert.equal(spellStatus.textContent, "Ничего не найдено.");
    setSpellbookSearch("");
    assert.equal(captions().length, 3);

    // And nothing is held back for a second page. The book was `SPELLBOOK_PAGE_SIZE = 12` with a
    // two-button footer under a window that is `min(560px, 100vw - 32px)` wide and resizable, so a
    // mage's 351 spells came to thirty turns; twenty rows of one skill line now arrive at once.
    const many = new Map();
    for (let index = 0; index < 20; index++) {
      many.set(700 + index, spell(700 + index, `Заклинание ${index}`, "", false, { spellLevel: index }));
    }
    game.spells = many;
    game.talentData = talents(Object.fromEntries([...many.keys()].map((id) => [id, 6])), 11);
    game.world = book([...many.keys()]);
    showSpells();
    assert.equal(spellbookList.children.length, 20);
    assert.equal(spellStatus.textContent, "20 заклинаний");
  } finally {
    game.world = undefined;
    game.spells = new Map();
    game.talentData = undefined;
    setSpellbookSearch("");
  }
});

test("К1 the tab strip is counted before the filter, and a tab that empties is left", () => {
  try {
    game.gatewayOrigin = undefined;
    // Two skill lines. Line 8 holds three ranks of one spell, line 6 holds one spell — so with the
    // switch on line 8 shows one row and line 6 shows one, and a strip counted after the filter
    // would swap their places on every flip.
    game.spells = new Map([
      [133, spell(133, "Огненный шар", "Уровень 1", false, { spellLevel: 1 })],
      [143, spell(143, "Огненный шар", "Уровень 2", false, { spellLevel: 6 })],
      [42833, spell(42833, "Огненный шар", "Уровень 16", false, { spellLevel: 78 })],
      [168, spell(168, "Морозный доспех", "Уровень 1", false, { spellLevel: 1, spellClassMask: [34078720, 0, 0] })],
    ]);
    game.talentData = talents({ 133: 8, 143: 8, 42833: 8, 168: 6 });
    game.world = book([133, 143, 42833, 168]);
    setSpellbookRankFilter(true);
    showSpells();

    // `slotSiblings` puts the built-in strip in its own child of the container. General is always
    // tab one, even empty; the class lines follow in name order.
    const tabs = () => spellbookTabs.children[0].children.map((button) =>
      button.children.map((child) => child.textContent).join(""));
    assert.deepEqual(tabs(), ["Общие (0)", "Линия 6 (1)", "Линия 8 (3)"],
      "the counts are of the unfiltered list, so the strip does not reshuffle under the switch");

    // A tab the character no longer has any spell in cannot stay selected: the book would show
    // «В этой вкладке нет активных заклинаний» with no way back on the screen.
    selectSpellbookTab(8);
    assert.deepEqual(captions(), ["Огненный шар"]);
    game.world = book([168]);
    showSpells();
    assert.deepEqual(tabs(), ["Общие (0)", "Линия 6 (1)"]);
    assert.deepEqual(captions(), ["Морозный доспех"], "the book fell back to a tab it actually has");
    selectSpellbookTab(undefined);
    const active = spellbookTabs.children[0].children
      .filter((button) => button.className.split(" ").includes("is-active"));
    assert.equal(active.length, 1, "exactly one tab is selected");
    assert.deepEqual(captions(), ["Морозный доспех"], "an unset tab falls back to one that has spells");
  } finally {
    selectSpellbookTab(undefined);
    game.world = undefined;
    game.spells = new Map();
    game.talentData = undefined;
  }
});

test("К1 the cost line exists again, and it is a percentage of the caster's own pool", async () => {
  try {
    // `/dbc/spells?ids=133` answers `"powerCost":0` on a live gateway. 6,728 of the 7,369 spells
    // in the book are priced like that and 1,543 of them carry `ManaCostPct` instead, so the
    // «Затраты» line was missing from every mage, priest, warlock, druid and shaman spell.
    game.spells = new Map([
      [133, spell(133, "Огненный шар", "Уровень 1", false, {
        spellLevel: 1, powerCostPercent: 8, schoolMask: 4, rangeMax: 35, castTime: 1500,
      })],
      [78, spell(78, "Удар героя", "Уровень 1", false, {
        powerType: 1, powerCost: 150, rangeMax: 5, rangeFlags: 1,
      })],
    ]);
    game.world = undefined;
    // With no character on screen the percentage stays a percentage rather than becoming a made-up
    // number: `Spell::CalcPowerCost` takes it off `GetCreateMana()`, and that is the caster's.
    assert.ok(spellTooltip(133).lines.includes("Затраты: 8%"));
    assert.ok(spellTooltip(133).lines.includes("Радиус действия: 35 м"));
    assert.ok(spellTooltip(133).lines.includes("Сотворение: 1,5 с"));
    assert.ok(spellTooltip(133).lines.includes("Школа: огонь"));

    // A warrior with 5,000 base mana still pays 15 rage for Heroic Strike: rage and runic power
    // are stored ten times what they read (`POWER_DISPLAY_SCALE`), and 150 is the table's 15.
    assert.ok(spellTooltip(78).lines.includes("Затраты: 15"));

    // And with a character, the percentage resolves against `UNIT_FIELD_BASE_MANA`.
    const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
    const self = { guid: 1n, typeId: 4, fields: new Map([[UPDATE_FIELDS.UNIT_FIELD_BASE_MANA.offset, 4000]]) };
    game.world = { ...book([133]), state: { selfGuid: 1n, objects: new Map([[1n, self]]) } };
    assert.ok(spellTooltip(133).lines.includes("Затраты: 320"), "8% of 4,000 base mana");
  } finally {
    game.world = undefined;
    game.spells = new Map();
  }
});

test("К1 the range line: metres where the client writes metres, words where it writes words", () => {
  try {
    game.world = undefined;
    game.gatewayOrigin = undefined;
    game.spells = new Map([
      // A distance, and the head word is the client's own `SPELL_RANGE = "Радиус действия: %s м"`.
      [133, spell(133, "Огненный шар", "Уровень 1", false, { rangeMax: 35 })],
      // «Удар героя» resolves to `SpellRange` 2, «Combat Range»: `RangeMax` 5 and `Flags` 1. The
      // five is not a distance the player can read off — the client prints `MELEE_RANGE` here.
      [78, spell(78, "Удар героя", "Уровень 1", false, { rangeMax: 5, rangeFlags: 1 })],
      // «Око Килрогга» resolves to row 13, «Anywhere», whose `RangeMax` is the sentinel 50,000.
      [126, spell(126, "Око Килрогга", "Призыв", false, { rangeMax: 50000 })],
      // Row 173, «Anywhere (Combat Min Range)», is the sentinel with a minimum beside it — 61556
      // «Охват» is one of the 4 rows of `Spell.dbc` that use it, and none of the 4 reaches the
      // book. The sentinel still has to win the order: 5-50000 is not a pair of metres either.
      [61556, spell(61556, "Охват", "", false, { rangeMin: 5, rangeMax: 50000 })],
      // A real pair: «Рывок» is `SpellRange` 95, «Charge», 8 to 25. 28 book rows carry a minimum.
      [100, spell(100, "Рывок", "Уровень 1", false, { rangeMin: 8, rangeMax: 25 })],
      // And 5,223 of the 7,369 have no range row at all, which is not a range of zero metres.
      [1459, spell(1459, "Магический интеллект", "Уровень 1", false, {})],
    ]);
    assert.ok(spellTooltip(133).lines.includes("Радиус действия: 35 м"));
    assert.ok(spellTooltip(78).lines.includes("Дистанция ближнего боя"));
    assert.ok(spellTooltip(126).lines.includes("Неограниченное расстояние"));
    assert.ok(spellTooltip(61556).lines.includes("Неограниченное расстояние"));
    assert.ok(spellTooltip(100).lines.includes("Радиус действия: 8-25 м"));
    assert.equal(spellTooltip(1459).lines.some((line) => line.startsWith("Радиус")), false,
      "a spell with no range row gets no range line");

    // The sentinel never reaches the screen as a number, and neither does the melee five.
    for (const id of [78, 126, 61556]) {
      assert.equal(spellTooltip(id).lines.some((line) => / м$/.test(line)), false,
        `${id} prints words, not metres`);
    }
  } finally {
    game.spells = new Map();
  }
});

test("the tooltip names duration, ground size, reagents and the reticle contract", () => {
  const textOf = (lines) => lines.map((line) => typeof line === "string" ? { text: line } : line);
  try {
    game.world = undefined;
    game.gatewayOrigin = undefined;
    game.spells = new Map([
      [133, spell(133, "Огненный шар", "Уровень 1", false, {
        duration: 12000, effectRadius: [0, 0, 0], procChance: 0,
      })],
      [589, spell(589, "Слово Тьмы: Боль", "Уровень 1", false, {
        duration: 180000, procChance: 0,
      })],
      [122, spell(122, "Ледяная стрела", "Уровень 1", false, {
        effectRadius: [10, 0, 0], requiredTargetMode: 3,
      })],
      [11444, spell(11444, "Чародейский порошок", "", false, {
        reagents: [{ itemId: 17031, count: 2 }], requiredToolNames: ["Нож"],
      })],
      [28730, spell(28730, "Чародейское сосредоточение", "", false, { procChance: 10 })],
    ]);
    const lines133 = textOf(spellTooltip(133).lines);
    assert.ok(lines133.some((line) => line.text === "Длительность: 12 с" && line.tone === "muted"));
    const lines589 = textOf(spellTooltip(589).lines);
    assert.ok(lines589.some((line) => line.text === "Длительность: 3 мин" && line.tone === "muted"));
    const lines122 = textOf(spellTooltip(122).lines);
    assert.ok(lines122.some((line) => line.text === "Радиус поражения: 10 м" && line.tone === "muted"));
    assert.ok(lines122.some((line) => line.text === "Цель: точка на земле" && line.tone === "spell"));
    const lines11444 = textOf(spellTooltip(11444).lines);
    assert.ok(lines11444.some((line) => line.text.startsWith("Реагенты: ") && line.tone === "gold"));
    assert.ok(lines11444.some((line) => line.text === "Инструмент: Нож" && line.tone === "muted"));
    const lines28730 = textOf(spellTooltip(28730).lines);
    assert.ok(lines28730.some((line) => line.text === "Шанс срабатывания: 10%" && line.tone === "muted"));
  } finally {
    game.spells = new Map();
  }
});

test("К1 Escape lets go of the search box, so the next one closes the book", () => {
  const originalBlur = spellbookSearch.blur;
  try {
    game.gatewayOrigin = undefined;
    game.talentData = undefined;
    game.spells = new Map([[133, spell(133, "Огненный шар", "Уровень 1")]]);
    game.world = book([133]);
    let blurred = 0;
    let prevented = 0;
    spellbookSearch.blur = () => { blurred++; };
    const escape = () => spellbookSearchKeyDown({ key: "Escape", preventDefault() { prevented++; } });

    // A full box: the text goes, the filter is told, and the focus is released in the same press —
    // the pair `Controls.ts:95-96` has done for `chatInput` since it was written.
    spellbookSearch.value = "огонь";
    setSpellbookSearch("огонь");
    assert.equal(spellbookList.children.length, 0, "«огонь» matches nothing in this one-spell book");
    escape();
    assert.equal(spellbookSearch.value, "");
    assert.equal(spellbookList.children.length, 1, "and the book is unfiltered again");
    assert.equal(blurred, 1, "the box is released on the first press, not left holding the keyboard");

    // An empty box still releases. Without this the handler returned on its first line, and
    // `Controls.onKeyDown` (`input/Controls.ts:91-99`) returns on *its* first line for any focused
    // input that is not the chat box — so Escape reached neither, W/A/S/D went on being typed into
    // the search box, and the only way out of the book was the mouse.
    escape();
    assert.equal(blurred, 2);
    assert.equal(prevented, 2);

    // Every other key is somebody else's.
    spellbookSearchKeyDown({ key: "a", preventDefault() { prevented++; } });
    assert.equal(blurred, 2);
    assert.equal(prevented, 2);
  } finally {
    spellbookSearch.blur = originalBlur;
    spellbookSearch.value = "";
    setSpellbookSearch("");
    game.world = undefined;
    game.spells = new Map();
  }
});

test("К1 rank filtering preserves the highest learned member across the active DBC", withDataset, async () => {
  const { openDbcFile } = await import("../tools/dbc.mjs");
  const { loadSpellMetadata } = await import("../dist/code/gateway/SpellMetadata.js");
  const [metadata, abilities] = await Promise.all([
    loadSpellMetadata(dbcDirectory), openDbcFile(dbcDirectory, "SkillLineAbility"),
  ]);
  const membership = new Map();
  const masks = new Map();
  for (const row of abilities.rows()) {
    const id = abilities.int(row, "Spell");
    const line = abilities.int(row, "SkillLine");
    if (id <= 0 || line <= 0) continue;
    if (!membership.has(id)) membership.set(id, line);
    masks.set(id, (masks.get(id) ?? 0) | abilities.int(row, "ClassMask"));
  }
  const corpus = [...metadata.values()].filter((spell) => membership.has(spell.id) && !spell.hidden && !spell.tradeSkill)
    .map((spell) => ({ ...spell, skillLine: membership.get(spell.id) }));
  assert.ok(corpus.length > 1000, "a populated active dataset is exercised, including custom rows");
  const verify = (known) => {
    const hidden = lowerRankSpells(known);
    const groups = new Map();
    for (const spell of known) {
      const key = rankChainKey(spell);
      const group = groups.get(key) ?? [];
      group.push(spell);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      const kept = group.filter((spell) => !hidden.has(spell.id));
      assert.ok(kept.length > 0, `rank chain ${group[0].id} never disappears entirely`);
      if (new Set(group.map((spell) => spell.rank)).size !== group.length) {
        assert.equal(kept.length, group.length, "identical rank labels cannot prove supersession");
      }
      for (const old of group.filter((spell) => hidden.has(spell.id))) {
        assert.ok(kept.some((next) => next.spellLevel > old.spellLevel
          || (next.spellLevel === old.spellLevel && next.id > old.id)), `hidden ${old.id} has a learned newer rank`);
      }
      const printed = group.map((spell) => ({ spell, rank: Number(/(\d+)/.exec(spell.rank)?.[1]) }));
      if (printed.every((entry) => Number.isFinite(entry.rank))
        && new Set(printed.map((entry) => entry.rank)).size === printed.length) {
        const highest = printed.reduce((left, right) => left.rank > right.rank ? left : right).spell;
        // Custom datasets may intentionally disagree with their rank labels. When level and rank
        // agree, the independently printed highest rank must remain available.
        if (group.every((spell) => highest.spellLevel > spell.spellLevel || highest.id >= spell.id)) {
          assert.ok(!hidden.has(highest.id), `printed highest ${highest.id} remains available`);
        }
      }
    }
  };
  verify(corpus);
  for (const bit of [0, 1, 2, 3, 4, 5, 6, 7, 8, 10]) {
    const known = corpus.filter((spell) => ((masks.get(spell.id) ?? 0) & (1 << bit)) !== 0);
    assert.ok(known.length > 0, `class ${bit + 1} has real DBC abilities`);
    verify(known);
  }
  const fireball = corpus.filter((spell) => [133, 143].includes(spell.id));
  assert.equal(fireball.length, 2);
  assert.deepEqual([...lowerRankSpells(fireball)], [133], "a learned higher Fireball supersedes the first rank");
  assert.equal(lowerRankSpells(fireball.filter((spell) => spell.id === 133)).size, 0,
    "an unlearned higher rank never hides the only learned spell");
});

test("К1 every active DBC spell range follows its actual range row", withDataset, async () => {
  const { openDbcFile } = await import("../tools/dbc.mjs");
  const { loadSpellMetadata } = await import("../dist/code/gateway/SpellMetadata.js");
  const [metadata, spells, ranges] = await Promise.all([
    loadSpellMetadata(dbcDirectory), openDbcFile(dbcDirectory, "Spell"), openDbcFile(dbcDirectory, "SpellRange"),
  ]);
  const rows = new Map([...ranges.rows()].map((row) => [ranges.id(row), row]));
  const expected = new Map();
  for (const row of spells.rows()) {
    const rangeRow = rows.get(spells.int(row, "RangeIndex"));
    if (rangeRow === undefined) continue;
    const max = ranges.float(rangeRow, "RangeMax", 0);
    const min = ranges.float(rangeRow, "RangeMin", 0);
    const melee = (ranges.int(rangeRow, "Flags") & 1) !== 0;
    expected.set(spells.id(row), melee ? "Дистанция ближнего боя" : max >= 50000 ? "Неограниченное расстояние"
      : max <= 0 ? undefined : `Радиус действия: ${min > 0 ? `${min}-` : ""}${max} м`);
  }
  assert.ok(expected.size > 1000);
  try {
    game.world = undefined;
    game.spells = metadata;
    for (const [id, range] of expected) {
      const lines = spellTooltip(id).lines.filter((line) => typeof line === "string");
      const actual = lines.find((line) => /^(Дистанция ближнего боя|Неограниченное расстояние|Радиус действия:)/.test(line));
      assert.equal(actual, range, `Spell ${id} uses the range row referenced by this dataset`);
      assert.ok(!lines.some((line) => line.startsWith("Дальность")), `Spell ${id} keeps the standard range wording`);
    }
    for (const id of [78, 72, 53]) assert.equal(expected.get(id), "Дистанция ближнего боя");
    for (const id of [126, 1002, 6196, 6197]) assert.equal(expected.get(id), "Неограниченное расстояние");
    assert.equal(expected.get(133), "Радиус действия: 35 м");
  } finally {
    game.spells = new Map();
  }
});
