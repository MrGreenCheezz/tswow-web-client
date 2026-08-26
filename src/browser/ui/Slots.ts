/**
 * The named places a module may reach inside a window this client wrote itself.
 *
 * The decision behind the file is М7's: **built-in windows stay TypeScript and open named slots.**
 * Porting them would mean rewriting 13,321 lines across 70 modules whose content is behaviour and
 * not layout — `attachDragAndDrop` in `ItemSlots.ts`, the talent tree's server-derived click rules,
 * the raid grid reconciling object updates against `SMSG_PARTY_MEMBER_STATS`, the spellbook's skill
 * lines — so a declarative schema would either lose them or grow escape hatches until it was a
 * programming language. A slot exists only where a built-in declared one; a modder cannot reach an
 * arbitrary node, and that is the point rather than a shortcut.
 *
 * Three things in here are not obvious from the high-level design, and each of them was
 * forced by a real panel:
 *
 * * **A slot name has more than one place.** `quest-log/entry-actions` is declared once per quest
 *   card and `bag-window/footer` once per bag window, each with its own host and its own
 *   parameters, so a patch has to be able to put a *copy* of its widget into each of them and tell
 *   them apart. That is why {@link fillSlot} takes a factory and not a node: one node cannot be in
 *   two places, and appending it to the second host would silently take it out of the first.
 * * **Panels redraw by replacing their whole content.** `showQuestLog` calls
 *   `panel.body.replaceChildren()` and rebuilds every card; `showCharacterSheet` and `drawTabs` do
 *   the same. The two that have one host apiece keep it *out of the redraw altogether* — see
 *   {@link slotSiblings}: a host built per draw would rebuild the module's widget with it, and a
 *   host merely passed back into `replaceChildren` would keep the widget but drop the caret out of
 *   an input in it, both of them sixty times a second. The one that has a host per row drops the
 *   whole family with {@link clearSlot} before it rebuilds, or every redraw would leave one dead
 *   host per card behind, each holding a copy of a module's button. Re-declaring a name with the
 *   same parameters *replaces* the instance and moves the fills onto the new host, which is what
 *   makes {@link slot} safe to call from a draw path at all.
 * * **Unloading has to leave the interface byte for byte as it was.** A fill remembers the node it
 *   built and takes it away; a hide remembers what `hidden` held *before* the first hide and puts
 *   that value back when the last hide goes; a skin remembers the `data-module` the element carried
 *   before it. That is the property М7's acceptance test serialises the target frame around.
 *
 * The file is free of `Dom.ts`: it is a registry that is handed elements, so it can be exercised
 * with the same small fake document the widget tests build.
 */

import type { Unsubscribe } from "../../world/EventBus.js";

/**
 * The seven places a module may put a widget: containers the client fills by appending to them.
 *
 * A table rather than "whatever has called {@link slot} so far", for two reasons. A patch is loaded
 * on entering the world, and the quest log has drawn no cards yet at that moment — checking against
 * what is declared *now* would refuse a good file for a panel the player has not opened. And the
 * type below turns a typo in a built-in's own `slot(…)` call into a compile error, which is the
 * cheapest check there is.
 */
export const FILLABLE_SLOTS = [
  "character-window/stats",
  "character-window/footer",
  "target-frame/actions",
  "bag-window/footer",
  "quest-log/entry-actions",
  "minimap/buttons",
  "spellbook/tabs",
] as const;
export type FillableSlot = (typeof FILLABLE_SLOTS)[number];

/**
 * The three that exist only to be hidden, and why filling one is refused rather than allowed.
 *
 * `target-frame/details` is the subname·type·level line, `player-frame/experience` the XP bar under
 * the player frame, `minimap/clock` the game clock over it. Two of the three are written with
 * `textContent =` on the frame the target or the hour changes (`Frames.ts:275`, `Frames.ts:324`,
 * `Minimap.ts:435`), and that setter *replaces every child* — so a widget appended into one would
 * be swept off the page without {@link SlotFill.drop} ever being called, leaving a live subtree on
 * the binding pass with nothing to hold it and nothing to take it back. That is the whole reason
 * this is a second table and not a column in the documentation: «only a container is worth filling»
 * needs a check behind it, and the check is {@link fillableSlots}.
 */
export const HIDE_ONLY_SLOTS = [
  "target-frame/details",
  "player-frame/experience",
  "minimap/clock",
] as const;

/** Every slot there is: all ten may be hidden, and the first seven may also be filled. */
export const SLOT_NAMES = [...FILLABLE_SLOTS, ...HIDE_ONLY_SLOTS] as const;
export type SlotName = (typeof SLOT_NAMES)[number];

/**
 * Every built-in window a patch may add a class to.
 *
 * Named separately from the slots because a skin is about the window's own element rather than
 * about a place inside it: `class: {"target-frame": "my-skin"}` puts the class on `#target-panel`,
 * and `bag-window` names all four bag windows at once.
 */
export const SKINNABLE_WINDOWS = [
  "player-frame", "target-frame", "character-window", "inventory-window",
  "spellbook-window", "bag-window", "quest-log", "minimap",
] as const;
export type SkinnableWindow = (typeof SKINNABLE_WINDOWS)[number];

/**
 * The names, for the load-time check and for М8's picker.
 *
 * The same three tables, as functions, because that is what a picker asks for and because the day
 * one of them stops being a constant — a slot a panel only offers on some builds — the callers do
 * not have to change.
 */
export function slotNames(): readonly SlotName[] {
  return SLOT_NAMES;
}

export function fillableSlots(): readonly FillableSlot[] {
  return FILLABLE_SLOTS;
}

export function windowNames(): readonly SkinnableWindow[] {
  return SKINNABLE_WINDOWS;
}

/** What tells two instances of one slot apart: the quest a card is for, the bag a window holds. */
export type SlotParams = Readonly<Record<string, string | number | boolean>>;

/** One declared place, as a fill sees it. */
export interface SlotInstance {
  readonly name: string;
  readonly params: SlotParams;
  readonly host: HTMLElement;
}

/**
 * What a module puts into a slot.
 *
 * `build` is called once per instance and may decline by answering `undefined` — a patch whose
 * widget only makes sense for one bag reads {@link SlotInstance.params} and says so. `drop` is
 * called with the node it built when that node is taken away, which is how the patch runtime lets
 * go of a subtree whose card the quest log has just rebuilt.
 */
export interface SlotFill {
  build(instance: SlotInstance): HTMLElement | undefined;
  drop?(node: HTMLElement, instance: SlotInstance): void;
}

interface Instance {
  readonly name: string;
  readonly key: string;
  readonly params: SlotParams;
  host: HTMLElement;
  /** What `hidden` held before the first {@link hideSlot} touched it, and nothing else. */
  hiddenBefore: boolean | undefined;
}

interface FillEntry {
  readonly owner: string;
  readonly name: string;
  readonly fill: SlotFill;
  readonly nodes: Map<Instance, HTMLElement>;
}

interface HideEntry {
  readonly owner: string;
  readonly name: string;
}

interface SkinEntry {
  readonly owner: string;
  readonly id: string;
  readonly className: string;
}

interface WindowEntry {
  readonly id: string;
  readonly element: HTMLElement;
  /** The `data-module` the element carried before any skin landed on it. */
  moduleBefore: string | undefined;
  skinned: boolean;
}

const instances = new Map<string, Instance[]>();
const fills = new Map<string, FillEntry[]>();
const hides = new Map<string, HideEntry[]>();
const windowEntries = new Map<string, WindowEntry[]>();
const skins = new Map<string, SkinEntry[]>();
/** Every unsubscribe a module owns, so {@link forgetSlots} can take the lot back at once. */
const owned = new Map<string, Unsubscribe[]>();

const listOf = <T>(map: Map<string, T[]>, key: string): T[] => {
  const found = map.get(key);
  if (found) return found;
  const made: T[] = [];
  map.set(key, made);
  return made;
};

/** A stable key for a set of parameters, so two declarations of one card are one instance. */
function paramKey(params: SlotParams): string {
  const keys = Object.keys(params).sort();
  return keys.map((key) => `${key}=${String(params[key])}`).join("&");
}

/**
 * Files one unsubscribe under the module that asked for it, and takes it out again when it runs.
 *
 * The taking-out is the half that was missing. `owned` only ever grew: a patch applied and taken
 * off — which is one hot reload, i.e. one save of the file the author is editing — left its
 * closures in the list for the life of the tab, and each one holds the fill, which holds the
 * widget, its host and every copy it drew. Nothing in the client calls {@link forgetSlots}, so
 * nothing ever emptied the list; `ModuleLoader.unload` takes a patch back through
 * `PatchRegistry.remove` → `LivePatch.destroy`, which runs the unsubscribes and left them filed.
 * Measured over 30,000 apply/destroy cycles of one patch, three rounds each: 42,321 / 42,323 /
 * 42,340 KiB of heap before, 613 / 630 / 637 KiB after — 1.41 KiB per cycle down to 0.02.
 *
 * The list is captured rather than looked up again, so an unsubscribe run by {@link forgetSlots},
 * which has already dropped the key, splices a list nobody holds any more and is harmless.
 */
function remember(owner: string, off: Unsubscribe): Unsubscribe {
  const list = listOf(owned, owner);
  const wrapped: Unsubscribe = () => {
    const index = list.indexOf(wrapped);
    if (index >= 0) list.splice(index, 1);
    if (list.length === 0 && owned.get(owner) === list) owned.delete(owner);
    off();
  };
  list.push(wrapped);
  return wrapped;
}

/** How much one module still has out on loan. For the tests, and for М8's «что этот модуль держит». */
export function slotHoldings(owner: string): number {
  return owned.get(owner)?.length ?? 0;
}

/* ---------------------------------------------------------------------------------------------
 * What a built-in declares
 * ------------------------------------------------------------------------------------------- */

/**
 * A built-in says «a module may put something here».
 *
 * Declaring the same name with the same parameters again replaces the previous instance rather than
 * adding a second one: the fills move onto the new host and the old one is left as it was found.
 * That is what makes this safe to call from a panel's own draw path. The answer takes the instance
 * back out again — the quest log holds one per card and drops them all through {@link clearSlot}
 * before it redraws.
 */
export function slot(name: SlotName, host: HTMLElement, params: SlotParams = {}): Unsubscribe {
  const key = `${name}|${paramKey(params)}`;
  const list = listOf(instances, name);
  const at = list.findIndex((entry) => entry.key === key);
  const instance: Instance = { name, key, params, host, hiddenBefore: undefined };
  if (at >= 0) {
    // Taken down before the replacement goes up, so the old host is handed back untouched even
    // though nobody will look at it again — a redraw must not be a way to leave `hidden` set.
    detach(list[at] as Instance);
    list.splice(at, 1, instance);
  } else {
    list.push(instance);
  }
  for (const entry of fills.get(name) ?? []) applyFill(entry, instance);
  if ((hides.get(name) ?? []).length > 0) hideHost(instance);
  return () => {
    const index = list.indexOf(instance);
    if (index < 0) return;
    list.splice(index, 1);
    detach(instance);
  };
}

/**
 * A host element of this client's own making, already declared.
 *
 * Panels that draw with `replaceChildren` need somewhere for a module's widget to live that is not
 * one of their own nodes, and this is that node: an empty `<div>` appended last, named by the slot
 * it carries so that the builder overlay and the browser inspector both say what it is.
 */
export function slotElement(name: SlotName, params: SlotParams = {}): HTMLElement {
  const host = document.createElement("div");
  host.className = "ui-slot-host";
  host.dataset["uiSlot"] = name;
  slot(name, host, params);
  return host;
}

/**
 * A panel's own content, redrawn without the slot host beside it ever leaving the page.
 *
 * `replaceChildren` is the DOM's «replace all»: it removes every existing child first, the host
 * included, and then inserts the new list. Keeping one host and passing it back in — which is what
 * `showCharacterSheet` did — saves the *node*, so a module's widget is not rebuilt and what is in
 * it is not lost; but the node is still detached and re-attached, and removing a focused element
 * runs HTML's unfocusing steps. `showCharacterSheet` runs once a frame (`Bags.ts:202` calls it
 * above `renderInventory`'s own signature guard), so an `EditBox` a module put in
 * `character-window/stats` would have kept its text and lost the caret sixty times a second.
 *
 * So the panel's own blocks go into a box of their own and the container is written once, when the
 * window is built, and never again. The box is `display: contents` — see `.ui-slot-siblings` in
 * `style.css` — so it generates no box of its own and the blocks stay flex children of the panel
 * exactly as they were before there was a wrapper at all.
 */
export function slotSiblings(
  container: HTMLElement,
  host: HTMLElement,
): (children: readonly HTMLElement[]) => void {
  const own = document.createElement("div");
  own.className = "ui-slot-siblings";
  container.replaceChildren(own, host);
  return (children: readonly HTMLElement[]): void => { own.replaceChildren(...children); };
}

/** Drops every instance of one slot: the panel that declared them is rebuilding them. */
export function clearSlot(name: SlotName): void {
  const list = instances.get(name);
  if (!list) return;
  for (const instance of list) detach(instance);
  list.length = 0;
}

/** A built-in offers its window's own element to `class:` in a patch file. */
export function skinnable(id: SkinnableWindow, element: HTMLElement): Unsubscribe {
  const list = listOf(windowEntries, id);
  const existing = list.find((entry) => entry.element === element);
  const entry: WindowEntry = existing ?? { id, element, moduleBefore: undefined, skinned: false };
  if (!existing) list.push(entry);
  for (const skin of skins.get(id) ?? []) applySkin(skin, entry);
  return () => {
    const index = list.indexOf(entry);
    if (index < 0) return;
    list.splice(index, 1);
    unskin(entry);
  };
}

/* ---------------------------------------------------------------------------------------------
 * What a module asks for
 * ------------------------------------------------------------------------------------------- */

/**
 * Puts a module's own node into every place that slot has, now and later.
 *
 * Later is the half that matters: a patch is applied on entering the world and
 * `quest-log/entry-actions` does not exist until the player opens the log, so the request is kept
 * and {@link slot} runs it when the card is drawn.
 */
export function fillSlot(name: string, fill: SlotFill, owner: string): Unsubscribe {
  const entry: FillEntry = { owner, name, fill, nodes: new Map() };
  const list = listOf(fills, name);
  list.push(entry);
  for (const instance of instances.get(name) ?? []) applyFill(entry, instance);
  return remember(owner, () => {
    const index = list.indexOf(entry);
    if (index < 0) return;
    list.splice(index, 1);
    for (const [instance, node] of entry.nodes) {
      fill.drop?.(node, instance);
      node.remove();
    }
    entry.nodes.clear();
  });
}

/** Takes one slot off the screen, and puts back exactly what `hidden` held before. */
export function hideSlot(name: string, owner: string): Unsubscribe {
  const entry: HideEntry = { owner, name };
  const list = listOf(hides, name);
  list.push(entry);
  for (const instance of instances.get(name) ?? []) hideHost(instance);
  return remember(owner, () => {
    const index = list.indexOf(entry);
    if (index < 0) return;
    list.splice(index, 1);
    if (list.length > 0) return;
    for (const instance of instances.get(name) ?? []) showHost(instance);
  });
}

/**
 * Adds a class to a built-in window, and marks it as this module's to style.
 *
 * The mark is what makes the class reachable at all: module CSS is prefixed with
 * `[data-module="…"]` before it is put on the page (`ModuleLoader.prefixModuleCss`), so a rule
 * naming a class on a node that carries no such attribute matches nothing. Two modules skinning one
 * window is allowed; the attribute carries the most recent of them, so the second module's rules
 * are the ones that can reach the window's own element while both modules' classes are on it.
 */
export function skinWindow(id: string, className: string, owner: string): Unsubscribe {
  const entry: SkinEntry = { owner, id, className };
  const list = listOf(skins, id);
  list.push(entry);
  for (const target of windowEntries.get(id) ?? []) applySkin(entry, target);
  return remember(owner, () => {
    const index = list.indexOf(entry);
    if (index < 0) return;
    list.splice(index, 1);
    for (const target of windowEntries.get(id) ?? []) {
      for (const name of classNames(entry.className)) target.element.classList.remove(name);
      rewriteModule(id, target);
    }
  });
}

/** Everything one module put into the built-in windows, taken back. */
export function forgetSlots(owner: string): void {
  const list = owned.get(owner);
  if (!list) return;
  owned.delete(owner);
  // Backwards, so the last thing applied is the first thing undone: a skin that landed on top of
  // another module's is removed before the one it covered is asked to rewrite the attribute.
  for (const off of [...list].reverse()) off();
}

/* ---------------------------------------------------------------------------------------------
 * Looking
 * ------------------------------------------------------------------------------------------- */

/** Every place one slot currently has. For the patch runtime's counters and for the tests. */
export function slotInstances(name: string): readonly SlotInstance[] {
  return (instances.get(name) ?? []).map((entry) => ({
    name: entry.name, params: entry.params, host: entry.host,
  }));
}

/**
 * Everything, dropped.
 *
 * The start of every test in this family, and nothing in the client calls it: the places belong to
 * the client's own panels and outlive a session, while everything a module put in them is taken
 * back by the patch that put it there.
 */
export function resetSlots(): void {
  for (const list of instances.values()) for (const instance of list) detach(instance);
  for (const list of windowEntries.values()) for (const entry of list) unskin(entry);
  instances.clear();
  fills.clear();
  hides.clear();
  windowEntries.clear();
  skins.clear();
  owned.clear();
}

/* ---------------------------------------------------------------------------------------------
 * The mechanics
 * ------------------------------------------------------------------------------------------- */

function applyFill(entry: FillEntry, instance: Instance): void {
  if (entry.nodes.has(instance)) return;
  const node = entry.fill.build({ name: instance.name, params: instance.params, host: instance.host });
  if (!node) return;
  entry.nodes.set(instance, node);
  instance.host.append(node);
}

function hideHost(instance: Instance): void {
  if (instance.hiddenBefore !== undefined) return;
  instance.hiddenBefore = instance.host.hidden;
  instance.host.hidden = true;
}

function showHost(instance: Instance): void {
  if (instance.hiddenBefore === undefined) return;
  instance.host.hidden = instance.hiddenBefore;
  instance.hiddenBefore = undefined;
}

/** One instance handed back as it was found: the module's nodes off it, its own `hidden` restored. */
function detach(instance: Instance): void {
  for (const entry of fills.get(instance.name) ?? []) {
    const node = entry.nodes.get(instance);
    if (!node) continue;
    entry.fill.drop?.(node, { name: instance.name, params: instance.params, host: instance.host });
    node.remove();
    entry.nodes.delete(instance);
  }
  showHost(instance);
}

/** `"shop-row important"` is two classes; `classList.add` throws on a name with a space in it. */
function classNames(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

function applySkin(skin: SkinEntry, target: WindowEntry): void {
  if (!target.skinned) {
    target.skinned = true;
    target.moduleBefore = target.element.dataset["module"];
  }
  for (const name of classNames(skin.className)) target.element.classList.add(name);
  target.element.dataset["module"] = skin.owner;
}

/** After a skin leaves: the next owner's mark, or the attribute the element had before any of them. */
function rewriteModule(id: string, target: WindowEntry): void {
  const remaining = skins.get(id) ?? [];
  if (remaining.length > 0) {
    target.element.dataset["module"] = (remaining[remaining.length - 1] as SkinEntry).owner;
    return;
  }
  if (target.moduleBefore === undefined) delete target.element.dataset["module"];
  else target.element.dataset["module"] = target.moduleBefore;
  target.skinned = false;
}

function unskin(target: WindowEntry): void {
  if (!target.skinned) return;
  for (const skin of skins.get(target.id) ?? []) {
    for (const name of classNames(skin.className)) target.element.classList.remove(name);
  }
  if (target.moduleBefore === undefined) delete target.element.dataset["module"];
  else target.element.dataset["module"] = target.moduleBefore;
  target.skinned = false;
}
