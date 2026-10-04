import {
  ACT_COMMAND, ACT_REACTION, petActionOf, petActionTypeOf, petCommandText, petReactText,
} from "../../world/PetProtocol.js";
import { POSSESS_ACTION_PAGE, POSSESS_FIRST_SLOT, POSSESS_PAGE_SLOTS } from "../../world/PossessBar.js";
import { FrameXmlPossessModel, frameXmlPossessLive, type FrameXmlPossessWorld } from "../framexml/FrameXmlPossess.js";
import { game } from "../game/Context.js";
import { vehicleCatalog } from "../VehicleClient.js"; // 11.02-F2
import type { WorldObjectState } from "../../world/WorldState.js"; // 11.02-F2
import { unknownLabel } from "./Format.js";
import { spellIconUrl } from "./IconImage.js";
import { ensureSpellNames } from "./SpellNames.js";
import type { IconButton, TooltipContent } from "./Widgets.js";

/**
 * 11.02-IF-review: keys 1–= and the native main row under possession — Mind Control, Eyes of the
 * Beast, Eye of Kilrogg — as Wow.exe 3.3.5a 12340 has them.
 *
 * While the main-bar bit is set (0x005d4ad0, the rules in world/PossessBar.ts) Wow.exe writes the
 * possessed unit's pet bar into action slots 121–130 (0x005ab800 with 0x005d3240: word
 * `0x10000000 | i`, 131–132 empty), `GetBonusBarOffset` answers 5 and `GetActionBarPage` 1, so stock
 * ActionButtonDown/Up (ActionButton.lua:15-42) send key n to BonusActionButton n, whose action
 * (`ActionButton_CalculateAction`, :131-153) is page 6 + 5 = 11, slot 120 + n. `UseAction` there
 * (0x005abbc0) is the pet bar press 0x005d4210 with an empty guid — the current target — then
 * `ACTIONBAR_UPDATE_STATE`; a slot whose pet word is zero, and 131–132, press nothing. PickupAction
 * (0x005abe70) never lifts 0x78–0x83 and a held action is never dropped there (0x005abbc0's first
 * branch), so the page cannot be dragged from, cleared or written.
 *
 * The keys run through the native bar in both interface modes (input/Actions.ts → `useSlot`), so the
 * page is answered here: `ActionBar.ts` asks `possessKeyPage` before its bonus rule and hands page 11
 * to `pressPossessSlot`, the native row draws the mirrored words, and the character's own slots
 * 121–132 are left alone (Wow.exe overwrites them locally, without CMSG_SET_ACTION_BUTTON). The
 * state is the stock seam's model while one is attached (`frameXmlPossessLive`: its 60 ms poll and
 * store edge keep it, and a press raises ACTIONBAR_UPDATE_STATE in that UI); with the native
 * interface alone the same model runs here, quietly, ticked when the world's revision moves, a
 * pet bar packet lands or, while a scan waits for a missing spell row, a row lands.
 */

/** A pump for the native model: no stock UI listens. */
const QUIET_PUMP = { fire: (): number => 0 };

let native: FrameXmlPossessModel | undefined;
/**
 * 11.02-F2 (the 11.02-IF-keys review's open point): the world the native model was last attached to, held
 * weakly — after a logout nothing calls in here until the next world (the character list asks the bar
 * nothing), and a strong reference kept the last WorldClient alive all that time. The model reads the
 * world through `nativeView`, whose PET_BAR_CHANGED subscription reaches the world's bus only weakly.
 */
let nativeWorld: WeakRef<object> | undefined;
let nativeRevision: number | undefined;
/**
 * 11.02-IF-keys-review: how many spell rows had landed at the native model's last tick. A scan left
 * `pending` (a row missing) can only come out differently once a row lands, so that — not every call —
 * is when it is looked at again: `pending` stays set while no far sight asks for a rescan (FrameXmlPossess
 * `tick`), and the main row asks twelve times a frame.
 */
let nativeRows = -1;

/** The model whose main-bar bit the keys follow: the stock seam's, else the native one over `game.world`. */
function possessModel(): FrameXmlPossessModel | undefined {
  const live = frameXmlPossessLive();
  const world = game.world;
  if (live) {
    if (nativeWorld !== undefined) {
      native?.detach();
      nativeWorld = undefined;
    }
    return live;
  }
  if (!world) {
    if (nativeWorld !== undefined) {
      native?.detach();
      nativeWorld = undefined;
    }
    return undefined;
  }
  native ??= new FrameXmlPossessModel({
    world: () => (game.world ? nativeView(game.world) : undefined), // 11.02-F2: the weak view
    spell: (id) => game.spells.get(id),
    unitGuid: () => undefined,
    native: true,
    vehicles: () => vehicleCatalog(), // 11.02-F2: a driven vehicle's bar on the main row (VehicleAbilityDisplay)
  });
  // A world without the counter (a test's fake) is looked at on every call.
  const revision: number | undefined = world.state.revision;
  const rows = game.spells.size;
  if (nativeWorld?.deref() !== world) { // 11.02-F2: weakly held
    nativeWorld = new WeakRef(world); // 11.02-F2
    nativeRevision = revision;
    nativeRows = rows;
    native.attach(QUIET_PUMP);
  } else if (revision === undefined || revision !== nativeRevision || (native.pending && rows !== nativeRows)) {
    nativeRevision = revision;
    nativeRows = rows;
    native.tick();
  }
  return native;
}

/**
 * 11.02-F2: one view per world for the native model, reaching it only through WeakRefs — its fields by
 * getters, its methods by forwarding, and its bus through an `events.on` whose unsubscribe holds the
 * subscription weakly. The view lives in a WeakMap keyed by the world (an ephemeron: alive while the world
 * is), so what the model keeps — that unsubscribe — never keeps the last WorldClient alive.
 */
const nativeViews = new WeakMap<object, FrameXmlPossessWorld>();
const NO_OBJECTS: ReadonlyMap<bigint, WorldObjectState> = new Map<bigint, WorldObjectState>();

function nativeView(world: NonNullable<typeof game.world>): FrameXmlPossessWorld {
  let view = nativeViews.get(world);
  if (view) return view;
  const ref = new WeakRef(world);
  /** This world's live unsubscribes: reachable from the view (so only while the world is), not from the model. */
  const offs = new Set<() => void>();
  const offsRef = new WeakRef(offs);
  view = {
    get state() { return ref.deref()?.state ?? { selfGuid: undefined, objects: NO_OBJECTS }; },
    get petSpells() { return ref.deref()?.petSpells; },
    get petAttackVictim() { return ref.deref()?.petAttackVictim; },
    get creatureTemplates() { return ref.deref()?.creatureTemplates; },
    events: {
      on: (name, listener) => {
        const off = ref.deref()?.events?.on?.(name, listener);
        if (!off) return () => {};
        offs.add(off);
        return weakUnsubscribe(new WeakRef(off), offsRef);
      },
    },
    aurasFor: (guid) => ref.deref()?.aurasFor?.(guid) ?? [],
    usePetSlot: (slot, targetGuid) => ref.deref()?.usePetSlot?.(slot, targetGuid),
    cancelAura: (spellId) => ref.deref()?.cancelAura?.(spellId),
  };
  nativeViews.set(world, view);
  return view;
}

/**
 * 11.02-F2: the unsubscribe the native model keeps, reaching the subscription only weakly. Built out here
 * on purpose: a closure made inside `nativeView` would chain to that call's context, which holds `offs`
 * (and so the bus — world/EventBus.ts' unsubscribe closes over the whole bus — and the world).
 */
function weakUnsubscribe(offRef: WeakRef<() => void>, offsRef: WeakRef<Set<() => void>>): () => void {
  return () => {
    const held = offRef.deref();
    if (!held) return;
    held();
    offsRef.deref()?.delete(held);
  };
}

/** The 0-based page keys 1–= and the main row use while the possessed unit's bar is on the main bar. */
export function possessKeyPage(): number | undefined {
  return possessModel()?.onMainBar() ? POSSESS_ACTION_PAGE : undefined;
}

/** The model when `barPage` is the possess page and the bit is set; the character's page otherwise. */
function mirroring(barPage: number): FrameXmlPossessModel | undefined {
  if (barPage !== POSSESS_ACTION_PAGE) return undefined;
  const model = possessModel();
  return model?.onMainBar() ? model : undefined;
}

/** Whether `barPage` shows the possessed unit's bar now: nothing of the character's is read or written there. */
export function possessMirrors(barPage: number): boolean {
  return mirroring(barPage) !== undefined;
}

/** The pet bar index (0-based, -1 for slots 131–132) of a main-row column. */
function mirroredIndex(model: FrameXmlPossessModel, column: number): number {
  return model.mirrorIndex(POSSESS_FIRST_SLOT + column) ?? -1;
}

/**
 * A key or a click on the possess page: the unit's bar slot (0x005abbc0 → 0x005d4210 and
 * ACTIONBAR_UPDATE_STATE through the model). True when the page was the possessed unit's — the press
 * is then done, even when the slot was empty.
 */
export function pressPossessSlot(column: number, barPage: number): boolean {
  const model = mirroring(barPage);
  if (!model) return false;
  if (column >= 0 && column < POSSESS_PAGE_SLOTS) model.use(mirroredIndex(model, column));
  return true;
}

/** What each main-row column was last drawn from, so a frame redraws only a column whose word or row moved. */
const drawnWords: number[] = Array.from({ length: POSSESS_PAGE_SLOTS }, () => -1);
const drawnRows: boolean[] = Array.from({ length: POSSESS_PAGE_SLOTS }, () => false);

function rowKnown(spellId: number): boolean {
  return spellId === 0 || game.spells.has(spellId);
}

/** Draw a main-row column from the possessed unit's bar; false when `barPage` is not mirrored now. */
export function drawPossessSlot(button: IconButton, column: number, barPage: number, key: string): boolean {
  const model = mirroring(barPage);
  if (!model || column < 0 || column >= POSSESS_PAGE_SLOTS) return false;
  const index = mirroredIndex(model, column);
  const word = model.wordAt(index);
  const spellId = model.spellAt(index);
  drawnWords[column] = word ?? 0;
  drawnRows[column] = rowKnown(spellId);
  delete button.root.dataset["count"];
  if (!model.hasAction(index) || word === undefined) {
    button.root.dataset["empty"] = "";
    button.setContent({ key, title: `Слот ${column + 1} пуст` });
    button.setCooldown(0);
    button.setUsable(true);
    return true;
  }
  delete button.root.dataset["empty"];
  const type = petActionTypeOf(word) & 0x3f;
  if (type === ACT_COMMAND) button.setContent({ label: petCommandText(petActionOf(word)), key });
  else if (type === ACT_REACTION) button.setContent({ label: petReactText(petActionOf(word)), key });
  else {
    const metadata = game.spells.get(spellId);
    if (!metadata) ensureSpellNames([spellId]);
    button.setContent({
      icon: spellIconUrl(metadata?.iconId ?? 0, game.gatewayOrigin),
      key,
      title: metadata ? undefined : "Данные заклинания загружаются",
    });
  }
  return true;
}

/**
 * The once-a-frame pass for a mirrored column: a redraw when its word or its spell row changed, then
 * the pet cooldown (on or off, as the native pet bar draws it: the client is never told its length)
 * and whether it can be pressed. False when `barPage` is not mirrored now.
 */
export function updatePossessSlot(
  button: IconButton, column: number, barPage: number, now: number, keyOf: (column: number) => string,
): boolean {
  const model = mirroring(barPage);
  if (!model || column < 0 || column >= POSSESS_PAGE_SLOTS) return false;
  const index = mirroredIndex(model, column);
  const spellId = model.spellAt(index);
  if ((model.wordAt(index) ?? 0) !== drawnWords[column] || rowKnown(spellId) !== drawnRows[column]) {
    drawPossessSlot(button, column, barPage, keyOf(column));
  }
  const cooling = spellId !== 0 && (game.world?.petCooldownRemaining?.(spellId, now) ?? 0) > 0;
  button.setCooldown(cooling ? 1 : 0);
  // An empty slot is drawn as the native row draws one: not greyed.
  button.setUsable(model.hasAction(index) ? model.usable(index) : true);
  return true;
}

/** A mirrored column's tooltip: the unit's spell, command or stance; undefined when `barPage` is not mirrored. */
export function possessSlotTooltip(column: number, barPage: number, chord: string): TooltipContent | undefined {
  const model = mirroring(barPage);
  if (!model) return undefined;
  const index = mirroredIndex(model, column);
  const word = model.wordAt(index);
  const lines = chord ? [chord] : [];
  if (word === undefined || !model.hasAction(index)) {
    return { title: `Слот ${column + 1}`, lines, footer: ["Пусто"] };
  }
  const type = petActionTypeOf(word) & 0x3f;
  if (type === ACT_COMMAND) return { title: petCommandText(petActionOf(word)), lines, footer: ["Команда подчинённому"] };
  if (type === ACT_REACTION) return { title: petReactText(petActionOf(word)), lines, footer: ["Поведение подчинённого"] };
  const spellId = model.spellAt(index);
  const spell = game.spells.get(spellId);
  return {
    title: spell?.name ?? unknownLabel("заклинание", spellId),
    lines: spell?.rank ? [spell.rank, ...lines] : lines,
    footer: ["Способность подчинённого"],
  };
}
