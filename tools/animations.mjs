// Which animations exist, and which of them travel with the model.
//
// Every id in this project used to be a literal, and seven of the eighteen were wrong: the
// constants read 13 for sitting (13 is Walkbackwards), 15 for the precast (HandsClosed), 26 for
// the unarmed stance (Ready1H), 39 for looting (JumpEnd), 46 for talking (AttackBow), 60 for
// falling (EmoteTalk) and 69 for the swim idle (EmoteDance). Nothing complained, because a model
// that lacks the sequence and a model that has the wrong one look the same from the outside — the
// character just stands there. So animations are named here and the numbers come from
// AnimationData.dbc, which is the table that assigns them.

import { openDbcFile } from "./dbc.mjs";
import { dbcDirectory } from "./paths.mjs";

/**
 * What a unit needs the moment it appears: standing, going somewhere, and dying.
 *
 * These ship inside the model artifact. Everything else the model carries is published alongside
 * it and fetched the first time something asks to play it — a character model holds around 1.5 MiB
 * of keyframes in total and only a tenth of that is locomotion, so a wolf standing in a field
 * should not be paying for the cast poses of a spell it will never know.
 */
export const BASE_ANIMATION_NAMES = [
  "Stand",
  "Walk",
  "Run",
  "Walkbackwards",
  "ShuffleLeft",
  "ShuffleRight",
  "RunLeft",
  "RunRight",
  "JumpStart",
  "Jump",
  "JumpEnd",
  "Fall",
  "Swim",
  "SwimIdle",
  "SwimLeft",
  "SwimRight",
  "SwimBackwards",
  "Fly",
  "Hover",
  "Death",
  "Dead",
];

/**
 * Reads AnimationData.dbc.
 *
 * `Fallback` is the table's own "visual equivalent": Attack1H falls back to AttackUnarmed, Fall to
 * SwimIdle, Dead to Death. A model that lacks a sequence is meant to be walked down that chain
 * rather than left standing, which is what the original client does and what makes one animation
 * set cover a wolf, a murloc and a night elf.
 *
 * `bodyFlags` is `Bodyflags`, kept for the rows that set any bit: the renderer reads bit 0x8 to
 * decide whether a pose may play on the upper body over a moving, mounted or swimming base.
 */
export async function loadAnimationCatalog(directory = dbcDirectory()) {
  const dbc = await openDbcFile(directory, "AnimationData");
  const idByName = new Map();
  const nameById = new Map();
  const fallback = new Map();
  const bodyFlags = new Map();
  for (const row of dbc.rows()) {
    const id = dbc.id(row);
    const name = dbc.string(row, "Name");
    if (name && !idByName.has(name)) idByName.set(name, id);
    nameById.set(id, name);
    const next = dbc.int(row, "Fallback");
    // Zero is Stand and is also how the table spells "no fallback"; a self-reference would loop.
    if (next !== 0 && next !== id) fallback.set(id, next);
    const flags = dbc.int(row, "Bodyflags") >>> 0;
    if (flags !== 0) bodyFlags.set(id, flags);
  }
  return { idByName, nameById, fallback, bodyFlags };
}

/** The ids of {@link BASE_ANIMATION_NAMES}, dropping any name this build's table does not carry. */
export function baseAnimationIds(catalog) {
  const ids = new Set();
  for (const name of BASE_ANIMATION_NAMES) {
    const id = catalog.idByName.get(name);
    if (id !== undefined) ids.add(id);
  }
  return ids;
}

/**
 * Emotes.dbc: which pose `SMSG_EMOTE` is asking for.
 *
 * `AnimID` is an AnimationData id and `EmoteSpecProc` says whether it is over when it finishes
 * (0) or is a stance the unit holds (1 and 2).
 *
 * Zero is both "Stand" and "no animation", and every row that carries it is one whose pose lives
 * somewhere else: STATE_SIT and STATE_SLEEP are the unit's stand state, and ONESHOT_NONE is
 * nothing at all. Dropping them is right for the same reason either way — playing Stand for
 * STATE_SIT would stand a sitting character up.
 */
export async function loadEmoteAnimations(directory = dbcDirectory()) {
  const dbc = await openDbcFile(directory, "Emotes");
  const result = [];
  for (const row of dbc.rows()) {
    const animation = dbc.int(row, "AnimID");
    if (animation <= 0) continue;
    result.push({ id: dbc.id(row), animation, state: dbc.int(row, "EmoteSpecProc") !== 0 });
  }
  return result.sort((left, right) => left.id - right.id);
}
