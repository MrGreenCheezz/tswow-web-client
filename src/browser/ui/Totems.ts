import { game } from "../game/Context.js";
import { setTip } from "./Widgets.js";

/**
 * The four totem slots, with what is left on each.
 *
 * `SMSG_TOTEM_CREATED` says which slot was filled, with what spell and for how long, and never
 * says when one ends: a totem dies with its duration, and a recast reuses the slot. So each
 * entry is pruned here when its clock runs out rather than waited for on the wire. Display
 * only: this native strip has no button to take a totem down early. The opcode for that does
 * exist (`CMSG_TOTEM_DESTROYED`, `WorldClient.destroyTotem`); the stock TotemFrame sends it through
 * `DestroyTotem` (FrameXmlHudMechanicsLive.ts).
 */

let container: HTMLElement | undefined;

function root(): HTMLElement | undefined {
  if (container?.isConnected) return container;
  if (typeof document === "undefined") return undefined;
  const viewport = document.getElementById("world-viewport");
  if (!viewport) return undefined;
  container = document.createElement("div");
  container.id = "totem-bar";
  container.className = "totem-bar";
  container.hidden = true;
  viewport.append(container);
  return container;
}

/** One drawn row: what it was drawn for, and its countdown as written. */
interface DrawnTotem {
  readonly slot: number;
  readonly spellId: number;
  readonly name: string;
  readonly clock: HTMLElement;
  text: string;
}

/** The rows on the strip, in slot order. */
let drawn: DrawnTotem[] = [];

export function resetTotems(): void {
  container?.replaceChildren();
  container = undefined;
  drawn = [];
}

function totemName(spellId: number): string {
  return game.spells.get(spellId)?.name ?? `Тотем ${spellId}`;
}

function totemClock(totem: { readonly duration: number; readonly startedAt: number }, now: number): string {
  return totem.duration > 0 ? `${Math.max(0, Math.ceil((totem.duration - (now - totem.startedAt)) / 1000))} с` : "";
}

/** Whether the rows on the strip are the slots the world holds, with the same spells and names. */
function drawnMatches(totems: ReadonlyMap<number, { readonly spellId: number }>): boolean {
  if (drawn.length !== totems.size) return false;
  for (const row of drawn) {
    const totem = totems.get(row.slot);
    if (!totem || totem.spellId !== row.spellId || totemName(totem.spellId) !== row.name) return false;
  }
  return true;
}

function clearStrip(box: HTMLElement): void {
  if (!box.hidden) box.hidden = true;
  if (drawn.length > 0 || box.childElementCount > 0) box.replaceChildren();
  drawn = [];
}

/**
 * Keeps the strip current once a frame; entries whose duration ran out are dropped silently.
 *
 * Built when the slots change — a totem dropped, recast with another spell, or its name landing —
 * and otherwise only a countdown written when its whole second moves. It used to build three
 * elements per totem and query the strip twice on every frame a totem stood, to write the same
 * seconds back.
 */
export function updateTotems(now: number): void {
  const box = root();
  const world = game.world;
  if (!box) return;
  if (!world || world.totems.size === 0) {
    clearStrip(box);
    return;
  }
  for (const [slot, totem] of world.totems) {
    if (totem.duration > 0 && now - totem.startedAt >= totem.duration) world.totems.delete(slot);
  }
  if (world.totems.size === 0) {
    clearStrip(box);
    return;
  }
  if (box.hidden) box.hidden = false;
  if (!drawnMatches(world.totems) || box.childElementCount !== drawn.length) {
    // Rebuilt while the set is tiny (at most four); keying by slot keeps focus nowhere, because
    // there is nothing focusable in a display-only strip.
    const rows: HTMLElement[] = [];
    drawn = [];
    for (const [slot, totem] of [...world.totems].sort((left, right) => left[0] - right[0])) {
      const row = document.createElement("div");
      row.className = "totem-slot";
      const name = document.createElement("span");
      const label = totemName(totem.spellId);
      name.textContent = label;
      const clock = document.createElement("span");
      clock.className = "muted";
      const text = totemClock(totem, now);
      clock.textContent = text;
      row.append(name, clock);
      setTip(row, `Слот ${slot + 1}`);
      rows.push(row);
      drawn.push({ slot, spellId: totem.spellId, name: label, clock, text });
    }
    box.replaceChildren(...rows);
    return;
  }
  for (const row of drawn) {
    const totem = world.totems.get(row.slot);
    if (!totem) continue;
    const text = totemClock(totem, now);
    if (text === row.text) continue;
    row.text = text;
    row.clock.textContent = text;
  }
}
