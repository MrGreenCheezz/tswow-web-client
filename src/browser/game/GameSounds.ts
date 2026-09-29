import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import { game } from "./Context.js";
import type { SoundChannel } from "../Sound.js";

/**
 * The noises the game makes about itself, as opposed to the ones the server asks for by number.
 *
 * Three opcodes carry a `SoundEntries` id and a listener now plays them, but they are rare: a
 * scripted event, a jukebox, a boss. What a player actually hears in an ordinary minute is the
 * interface answering them and the creature in front of them reacting — and neither of those is on
 * the wire at all. The client is expected to know that a bag makes a noise when it opens and that
 * a boar squeals when it is hit, and to look both up in the same tables everything else comes from.
 */

/**
 * The interface's own sounds, by the name the client's own Lua calls them.
 *
 * Names and not ids on purpose: `LEVELUP` says what it is and `888` does not, and the mapping is
 * `SoundEntries.Name`, which is a column rather than a convention. Four of the names one would
 * reach for first — `InterfaceError`, `igMapOpen`, `PickUpGold`, `PutDownGold` — are not in this
 * client's table at all, so what is here is what was actually found in it.
 *
 * Н1а vendored `UISoundLookups` and `SoundIndex.named` falls back to it, which brings two of those
 * four within reach under the client's own spelling: `CURSORGRABOBJECT` (902,
 * `uSpellIconPickup.wav`) and `CURSORDROPOBJECT` (903, `uSpellIconDrop.wav`), the noises of taking
 * something onto the cursor and putting it down. They are deliberately not listed here yet. A name
 * in this table is a name a window definition may ask for by string — `ModuleLoader` and
 * `WindowActions` check every `sound` action against it — so adding one is a promise to the module
 * API, and the drag handlers in `ItemSlots`, `Spellbook` and `ActionBar` that would actually play
 * them belong to a UI slice rather than to the slice that vendored the table.
 */
export const UI_SOUNDS = {
  windowOpen: "igMainMenuOpen",
  windowClose: "igMainMenuClose",
  bagOpen: "igBackPackOpen",
  characterOpen: "igCharacterInfoOpen",
  spellbookOpen: "igSpellBookOpen",
  questLogOpen: "igQuestLogOpen",
  questAdded: "QUESTADDED",
  questCompleted: "QUESTCOMPLETED",
  questFailed: "igQuestFailed",
  levelUp: "LEVELUP",
  loot: "LOOTWINDOWOPENEMPTY",
  money: "LOOTWINDOWCOINSOUND",
  readyCheck: "ReadyCheck",
  ping: "MapPing",
} as const;

export type UiSound = keyof typeof UI_SOUNDS;

/** Which of a creature's own noises to play. */
export type CreatureSound =
  "aggro" | "injury" | "injuryCritical" | "death" | "exertion" | "exertionCritical";

/**
 * What a critical variant falls back to when the creature's row does not carry one.
 *
 * Measured over the 24,220 displays that reach a `CreatureSoundData` row on this dataset: 23,088
 * carry an ordinary wound sound and 22,838 a critical one, so without this 262 of them would go
 * silent on the one blow in twenty worth hearing. Twelve carry the critical and not the ordinary
 * one, which is why this is a fallback and not a substitution.
 */
const CREATURE_FALLBACK: Partial<Record<CreatureSound, CreatureSound>> = {
  injuryCritical: "injury",
  exertionCritical: "exertion",
};

/**
 * How long one unit is left alone after it has made a noise, in milliseconds.
 *
 * A damage-over-time effect ticking on eight mobs is eight squeals a second without this, and the
 * result is not atmosphere but a stuck record. Per unit and per kind, so a creature can die while
 * its own hurt sound is still on cooldown.
 */
const CREATURE_THROTTLE = 700;
/** The same idea for the interface, where a repaint can fire an event several times in a frame. */
const UI_THROTTLE = 120;

/**
 * How long a sound waits for the table row that names its file.
 *
 * Every lookup here is «ask, and be told nothing the first time»: `SoundClient` batches ids and
 * answers on the turn after, so the first cast of a spell, the first hit on a kind of creature and
 * the first press of a button all found `undefined` and were dropped on the floor. The same shape
 * of defect as the emote that was thrown away while its clip was still in flight, and the same
 * answer — hold the request until the answer arrives, and give up if it does not.
 *
 * Exported because a melee swing has to measure the same window itself: it is woken by every batch
 * that lands, most of which are not the one it is waiting for, and none of those wakings may
 * restart its clock.
 */
export const LOOKUP_WAIT = 800;

/** What is waiting for a table, and until when. */
const pending: Array<{ at: number; run: () => void }> = [];

const lastCreature = new Map<string, number>();
const lastUi = new Map<string, number>();

/**
 * Holds a sound until the table row behind it lands, and drops it if it does not.
 *
 * Exported because a melee swing needs the same wait for a different reason: the whoosh and the
 * impact are chosen from `Item.dbc` rows for the two things in the fighters' hands, and those are
 * batched exactly as kits are — so the first swing of a session knows nothing about either weapon.
 */
export function deferSound(run: () => void): void {
  // Capped rather than unbounded: a client with no gateway would otherwise queue one of these per
  // swing for as long as it kept swinging.
  if (pending.length > 64) pending.shift();
  pending.push({ at: performance.now() + LOOKUP_WAIT, run });
}

/**
 * Retries whatever was waiting on a table that has just landed.
 *
 * Wired to `SoundClient.onLoaded`, which fires once per batch — so a spell cast on the frame its
 * own row was asked for is heard a few milliseconds late rather than not at all.
 */
export function retryPendingSounds(): void {
  if (pending.length === 0) return;
  const now = performance.now();
  const due = pending.splice(0, pending.length);
  for (const entry of due) {
    if (now <= entry.at) entry.run();
  }
}

function ready(seen: Map<string, number>, key: string, gap: number, now: number): boolean {
  const last = seen.get(key);
  if (last !== undefined && now - last < gap) return false;
  seen.set(key, now);
  // The map is keyed on a guid, so it grows with everything the player has ever fought. Swept
  // rather than capped: an entry older than its own gap can never refuse anything again.
  if (seen.size > 512) {
    for (const [entry, at] of seen) if (now - at >= gap) seen.delete(entry);
  }
  return true;
}

/** One of the interface's own noises, at the listener rather than anywhere in the world. */
export function playUiSound(which: UiSound): void {
  playNamedUiSound(UI_SOUNDS[which]);
}

/** Stock FrameXML's `PlaySound` addresses the same `SoundEntries.Name` rows as native UI. */
export function playNamedUiSound(name: string): void {
  // The sound route accepts only these characters. Reject a malformed Lua argument before the
  // batched request is made; an unknown but valid name is resolved once and remains silent.
  if (!/^[A-Za-z0-9_]{1,64}$/.test(name)) return;
  const sound = game.sound;
  const kits = game.soundKits;
  if (!sound || !kits) return;
  const id = kits.named(name);
  if (id === undefined) {
    if (!kits.namedAnswered(name)) deferSound(() => playNamedUiSound(name));
    return;
  }
  // Charge the UI cooldown only after the name arrives. Otherwise a fast metadata reply consumes
  // the first click while its deferred replay still falls inside the throttle interval.
  if (!ready(lastUi, name, UI_THROTTLE, performance.now())) return;
  playKit(id, { channel: "interface" });
}

/**
 * Plays a `SoundEntries` row by id, waiting for it if the table has not answered yet.
 *
 * The wait is the whole point. `kit` asks and returns nothing the first time it is given an id,
 * and a spell's sound id is first seen at the moment the spell is cast — so without this the first
 * cast of every spell in the game was silent, and so was the first hit on every kind of creature.
 */
export function playKit(id: number, options: {
  channel: SoundChannel;
  at?: { x: number; y: number; z: number };
  guard?: () => boolean;
}): void {
  const sound = game.sound;
  const kits = game.soundKits;
  if (!sound || !kits || id <= 0) return;
  const kit = kits.kit(id);
  if (!kit) {
    // The position is copied: by the time the row lands the unit has its next position object, and
    // a sound belongs where the thing was when it made it.
    const at = options.at ? { ...options.at } : undefined;
    deferSound(() => playKit(id, at
      ? { channel: options.channel, at, ...(options.guard ? { guard: options.guard } : {}) }
      : { channel: options.channel, ...(options.guard ? { guard: options.guard } : {}) }));
    return;
  }
  sound.play(kit, options);
}

/**
 * A creature's own reaction, from where it is standing.
 *
 * Resolved through the display id on the unit's own fields, which is the number
 * `CreatureDisplayInfo` is keyed on — and from there through the model, because the display's own
 * `SoundID` is an override that only 1,205 of 24,262 rows carry, while the model behind it carries
 * the answer for 23,015 more — 24,220 of the 24,262 displays between them.
 */
export function playCreatureSound(guid: bigint, which: CreatureSound, guard?: () => boolean): void {
  if (guard && !guard()) return;
  const sound = game.sound;
  const kits = game.soundKits;
  const world = game.world;
  if (!sound || !kits || !world) return;
  const unit = world.state.objects.get(guid);
  const at = unit?.position;
  if (!at || (unit.typeId !== 3 && unit.typeId !== 4)) return;

  const displayId = unit.fields.get(UPDATE_FIELDS.UNIT_FIELD_DISPLAYID.offset) ?? 0;
  const sounds = kits.creatureSounds(displayId);
  if (!sounds) {
    // Asked for and not here yet, so nothing is spent: the throttle below is only marked once
    // there is a sound to refuse a second copy of.
    deferSound(() => playCreatureSound(guid, which, guard));
    return;
  }
  // The kind whose id is actually used, which is not always the kind asked for.
  const played = sounds[which] > 0 ? which : CREATURE_FALLBACK[which];
  if (!played) return;
  const id = sounds[played];
  if (id <= 0) return;
  // The two wounds share one cooldown and the two efforts share another, which is what the fallback
  // table already says they are: variants of one noise. What is being refused here is a throat and
  // not a file — a dual-wielder whose off hand crits a tenth of a second after the main hand landed
  // otherwise gets both cries out of one man in the same instant. Measured on the human male, four
  // wounds at one guid inside the same 700 ms, alternating ordinary and critical: `[2942, 2943]`,
  // where the whole point of the throttle is that it should be one. A death is still its own
  // cooldown — `[2942, 2944]` for a man wounded and then killed — because those are two events.
  const throat = CREATURE_FALLBACK[played] ?? played;
  if (!ready(lastCreature, `${throat}:${guid}`, CREATURE_THROTTLE, performance.now())) return;
  playKit(id, {
    channel: "effects", at: { ...at },
    ...(guard ? { guard } : {}),
  });
}

/** Leaving a realm: the next one starts with nothing on cooldown. */
export function forgetGameSounds(): void {
  lastCreature.clear();
  lastUi.clear();
  pending.length = 0;
}
