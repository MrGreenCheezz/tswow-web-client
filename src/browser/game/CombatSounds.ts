import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import {
  HITINFO_BLOCK, HITINFO_CRITICAL, HITINFO_MISS, HITINFO_OFFHAND,
  VICTIMSTATE_BLOCKS, VICTIMSTATE_DEFLECTS, VICTIMSTATE_DODGE, VICTIMSTATE_EVADES,
  VICTIMSTATE_IMMUNE, VICTIMSTATE_PARRY, type AttackerState,
} from "../../world/CombatProtocol.js";
import { isWorldObjectDead, type WorldObjectState } from "../../world/WorldState.js";
import type { WorldPacketEvents } from "../../world/EventBus.js";
import { game } from "./Context.js";
import {
  LOOKUP_WAIT, deferSound, playCreatureSound, playKit, type CreatureSound,
} from "./GameSounds.js";
import { weaponSoundFor, type Combatant, type SwingOutcome } from "./WeaponSounds.js";

/**
 * What one melee swing sounds like, and the one death nothing on the wire announces.
 *
 * `WeaponSounds` decides *which* rows a swing names and can be checked without a server;
 * this is the half that has to look at the world — who is holding what, where the two of them are
 * standing, and whether the thing that just reached zero health is the player.
 *
 * Kept out of `EnterWorld` on purpose. Everything below is reachable from a test with no DOM in it,
 * which is the whole acceptance of this slice: ten combat outcomes, each of which has to arrive in
 * the play queue as the row the tables name.
 */

/**
 * `EQUIPMENT_SLOT_*`, which is the order the nineteen `PLAYER_VISIBLE_ITEM_N_ENTRYID` words run in.
 *
 * Not the same numbering as `InventoryType`: a one-handed sword is `INVTYPE_WEAPON` in either hand
 * and it is the *word it came from* that says which hand that was.
 */
const EQUIPMENT_SLOT_CHEST = 4;
const EQUIPMENT_SLOT_MAIN_HAND = 15;
const EQUIPMENT_SLOT_OFF_HAND = 16;

/**
 * `UNIT_VIRTUAL_ITEM_SLOT_ID`: main hand, off hand, ranged, as item entries.
 *
 * The creature half of the same question, three words at offset 56 that nothing in this client has
 * ever read. In 3.3.5 they hold `Item.dbc` entries rather than display ids — `Creature::LoadEquipment`
 * writes `SetVirtualItem(slot, einfo->ItemEntry[slot])` and tswow's `Creature::SetOutfit` writes the
 * same thing — so they answer to exactly the route a player's own equipment answers to.
 */
const VIRTUAL_SLOT_MAIN_HAND = 0;
const VIRTUAL_SLOT_OFF_HAND = 1;

/** A player is type 4 and wears items; anything else in a fight carries virtual ones. */
const TYPE_PLAYER = 4;

/** Whether the player's own body was dead the last time it was looked at. */
let selfWasDead: boolean | undefined;

/**
 * Creature voices belonging to a spell log entry.
 *
 * The spell visual kit owns authored cast/impact audio and FLOATING_TEXT owns the victim's actual
 * wound. Only real spell damage may add the caster's exertion; healing, dispels and other utility
 * events must never manufacture the sound of a weapon hit.
 */
export function spellCombatVoices(
  line: Pick<WorldPacketEvents["COMBAT_LOG"], "kind" | "casterGuid" | "critical">,
): Array<{ guid: bigint; voice: CreatureSound }> {
  if (line.kind !== "damage" || line.casterGuid === 0n) return [];
  return [{ guid: line.casterGuid, voice: line.critical ? "exertionCritical" : "exertion" }];
}

function visibleItemEntry(object: WorldObjectState, slot: number): number {
  const first = UPDATE_FIELDS.PLAYER_VISIBLE_ITEM_1_ENTRYID.offset;
  const stride = UPDATE_FIELDS.PLAYER_VISIBLE_ITEM_2_ENTRYID.offset - first;
  return object.fields.get(first + slot * stride) ?? 0;
}

function virtualItemEntry(object: WorldObjectState, slot: number): number {
  return object.fields.get(UPDATE_FIELDS.UNIT_VIRTUAL_ITEM_SLOT_ID.offset + slot) ?? 0;
}

/** The three item entries one fighter's sound is decided from: two hands and a breastplate. */
function equipmentOf(object: WorldObjectState | undefined): { main: number; off: number; chest: number } {
  if (!object) return { main: 0, off: 0, chest: 0 };
  if (object.typeId === TYPE_PLAYER) {
    return {
      main: visibleItemEntry(object, EQUIPMENT_SLOT_MAIN_HAND),
      off: visibleItemEntry(object, EQUIPMENT_SLOT_OFF_HAND),
      chest: visibleItemEntry(object, EQUIPMENT_SLOT_CHEST),
    };
  }
  // A creature has no chest slot at all: what it is made of is `CreatureImpactType`, below.
  return {
    main: virtualItemEntry(object, VIRTUAL_SLOT_MAIN_HAND),
    off: virtualItemEntry(object, VIRTUAL_SLOT_OFF_HAND),
    chest: 0,
  };
}

/**
 * The attacker, whose whole sound is in the one hand the blow came from.
 *
 * Nothing else about them is asked for. `weaponSoundFor` reads the attacker's weapon and no other
 * field of theirs — what a fighter is *wearing* decides how they sound when they are hit, which is
 * the defender's question below — so a breastplate fetched here would be an `Item.dbc` row asked
 * for on every swing of the session and thrown away every time.
 */
function attackerCombatant(object: WorldObjectState | undefined, fromOffHand: boolean): Combatant {
  const kits = game.soundKits;
  if (!object || !kits) return {};
  const worn = equipmentOf(object);
  return { weapon: kits.itemSound(fromOffHand ? worn.off : worn.main) };
}

/**
 * The defender, who is asked three different questions by three different outcomes.
 *
 * The main hand is what a parry is made with, the other hand is the shield a block is made with,
 * and the chest is what an ordinary blow lands on.
 */
function defenderCombatant(object: WorldObjectState | undefined): Combatant {
  const kits = game.soundKits;
  if (!object || !kits) return {};
  const worn = equipmentOf(object);
  const displayId = object.fields.get(UPDATE_FIELDS.UNIT_FIELD_DISPLAYID.offset) ?? 0;
  return {
    weapon: kits.itemSound(worn.main),
    offHand: kits.itemSound(worn.off),
    chest: kits.itemSound(worn.chest),
    // The creature's own material, which decides a body hit for anything not wearing a breastplate.
    // 1,304 of the 1,306 `CreatureSoundData` rows are 0, flesh, so this is here to be right about
    // the two rather than to be interesting — and a player's row says flesh too, which is what a
    // player with nothing on their chest should sound like. Deliberately not waited for, unlike the
    // items: a row still in flight reads as flesh, which is what all but two of them are.
    impactType: kits.creatureSounds(displayId)?.impactType,
  };
}

/**
 * Every entry a swing will ask `Item.dbc` about, and exactly those.
 *
 * The two builders above between them call `itemSound` on these four numbers and on nothing else,
 * which is what lets the wait below be decided once, before either of them runs: the batch a swing
 * needs is the batch a swing asks for.
 */
function swingEntries(
  attacker: WorldObjectState | undefined,
  defender: WorldObjectState | undefined,
  fromOffHand: boolean,
): number[] {
  const arm = equipmentOf(attacker);
  const body = equipmentOf(defender);
  return [fromOffHand ? arm.off : arm.main, body.main, body.off, body.chest];
}

/**
 * The attacker's effort and the victim's cry, which are neither of them in `Item.dbc`.
 *
 * Deliberately not held back with the steel. These come from the fighters' own `CreatureSoundData`
 * rows — which have a wait of their own inside `playCreatureSound` — so a gateway slow with items
 * costs a fight its swords and not its voices. They are also the throttled half, 700 ms per throat,
 * where the weapon sounds are not: a dual-wielder landing both hands in the same tenth of a second
 * is two blows against one cry.
 */
function playSwingVoices(swing: AttackerState, critical: boolean): void {
  playCreatureSound(swing.attacker, "exertion");
  // Only where the blow actually wounded. A parry, a block that ate all of it and a miss are all
  // swings that made a noise without hurting anybody — and this path can tell, where the
  // `COMBAT_LOG` listener beside it cannot: that one sees a line and knows nothing about what
  // happened, so it plays the wound on every one of them.
  if (swing.damage > 0) playCreatureSound(swing.victim, critical ? "injuryCritical" : "injury");
}

/**
 * What became of the swing, in the seven words the impact tables are written in.
 *
 * The order matters. A blocked blow still lands and still carries damage, so `HITINFO_BLOCK` has to
 * be read before the body slot is; a parry sets no hit flag at all and is only in the victim state.
 *
 * Six of the nine victim states are named here. `INTACT`, `HIT` and `INTERRUPT` are all a blow that
 * arrived, which is the fall-through; `IMMUNE` is the only one of the nine besides the avoidances
 * that carries no damage at all, so it goes past rather than landing — a wound sound for a blow
 * that did nothing is worse than the sound of a blow going wide.
 */
function outcomeOf(swing: AttackerState): SwingOutcome {
  if (swing.victimState === VICTIMSTATE_PARRY) return "parry";
  if (swing.victimState === VICTIMSTATE_BLOCKS || (swing.hitInfo & HITINFO_BLOCK) !== 0) return "block";
  if (swing.victimState === VICTIMSTATE_DODGE) return "dodge";
  if (swing.victimState === VICTIMSTATE_EVADES) return "evade";
  if (swing.victimState === VICTIMSTATE_DEFLECTS) return "deflect";
  if (swing.victimState === VICTIMSTATE_IMMUNE || (swing.hitInfo & HITINFO_MISS) !== 0) return "miss";
  return "hit";
}

/**
 * Every noise one melee swing makes.
 *
 * `SMSG_ATTACKERSTATEUPDATE` is the only packet that says a melee attack happened at all — a
 * weapon-damage spell goes out as `SMSG_SPELLNONMELEEDAMAGELOG` and auto-attack produces no
 * `SMSG_SPELL_GO` — and until this slice the client used it for a log line and an animation. So
 * melee was the one thing in the game with no sound of any kind, in a client that had every table
 * it needed to know what a sword hitting a breastplate sounds like.
 *
 * Four sounds at most, and they belong in different places: the whoosh where the arm is, the impact
 * where the blow arrived, the attacker's grunt and the victim's cry from their own throats.
 *
 * Only the first two wait for anything. Both weapon tables and both fighters' items are fetched
 * rather than known, and steel chosen before they land is a barefisted punch in the face of a
 * paladin in plate — so the two weapon sounds are held until the rows arrive, and the two voices,
 * which are in nobody's `Item.dbc` row, are heard when the blow happens.
 *
 * `held` is what a swing that has already been waiting carries: the moment its window closes, and
 * the fact that its voices have been heard. Only the retry below passes it.
 */
export function playSwingSounds(swing: AttackerState, held?: { until: number }): void {
  const world = game.world;
  const kits = game.soundKits;
  if (!world || !kits || !game.sound) return;
  const attackerObject = world.state.objects.get(swing.attacker);
  const defenderObject = world.state.objects.get(swing.victim);
  const fromOffHand = (swing.hitInfo & HITINFO_OFFHAND) !== 0;
  const critical = (swing.hitInfo & HITINFO_CRITICAL) !== 0;

  // Ask, and only then look at the answer. `itemSound` is the one thing in the client that puts an
  // entry into the next `Item.dbc` batch and `itemAnswered` is a pure read, so a swing that checked
  // without asking waited for the answer to a question nobody had put: measured against the real
  // `SoundClient` over a fake gateway, four swings in a row issued no request and played nothing at
  // all — not the steel, and not the two voices behind it either.
  //
  // Asked on the first pass only. The batch empties `#wantedItems` the moment it goes out, so
  // asking again while it is in flight is a second request for the same two rows.
  const entries = swingEntries(attackerObject, defenderObject, fromOffHand);
  if (!held) for (const entry of entries) kits.itemSound(entry);
  const tables = kits.weaponSounds();

  if (tables && entries.every((entry) => kits.itemAnswered(entry))) {
    const attacker = attackerCombatant(attackerObject, fromOffHand);
    const defender = defenderCombatant(defenderObject);
    const sounds = weaponSoundFor(outcomeOf(swing), critical, attacker, defender, tables);
    // Positional, and each at its own end of the blow: the arm swings where the attacker is
    // standing and the impact happens where the defender is. A fighter the client cannot see has no
    // position and therefore no sound, rather than one at the listener's own ear.
    if (attackerObject?.position) playKit(sounds.swing, { channel: "effects", at: attackerObject.position });
    if (defenderObject?.position) playKit(sounds.impact, { channel: "effects", at: defenderObject.position });
  } else {
    // Held against the blow's own clock rather than the queue's. `retryPendingSounds` runs
    // everything that is waiting whenever *any* batch lands, and the batch that lands first is
    // usually somebody else's kit — so a swing woken by one of those and settled there and then
    // would be decided on the items it is still waiting for, which is the bare fist this wait
    // exists to prevent. It goes back to waiting instead, against the deadline it started with.
    const until = held?.until ?? performance.now() + LOOKUP_WAIT;
    // And past that deadline it is dropped rather than played late: a punch on a man in plate is a
    // wrong sound, where a missing whoosh is only a missing one — and the fight still has both its
    // voices, which never waited for any of this.
    if (performance.now() < until) deferSound(() => playSwingSounds(swing, { until }));
  }

  // Deliberately not silenced along with a wand, and deliberately not repeated by a retry: the
  // weapon makes no noise of its own, but whoever is holding it still grunts and whoever is hit
  // still cries out, once, when the blow happens.
  if (!held) playSwingVoices(swing, critical);
}

/**
 * The player's own death, which no packet announces.
 *
 * `death` had exactly one caller — `SMSG_PARTYKILLLOG`, which `Unit::Kill` (`Unit.cpp:11121-11131`)
 * broadcasts to the *killer's* group and to nobody else — so the one death a player is certain to
 * care about is the one death this client never played. Their own end is a state and not an event:
 * `UNIT_FIELD_HEALTH` reaching zero, which is what the death panel already reads.
 *
 * An edge and not a level, so a corpse does not scream once a frame. The first look only takes the
 * baseline, which is what keeps a character who logs in dead from dying again on arrival, and an
 * object that leaves the client's sight drops the baseline so that its return is not an edge either.
 */
export function updateCombatSounds(): void {
  const world = game.world;
  const selfGuid = world?.state.selfGuid;
  const self = world && selfGuid !== undefined ? world.state.objects.get(selfGuid) : undefined;
  if (!self || selfGuid === undefined) {
    selfWasDead = undefined;
    return;
  }
  const dead = isWorldObjectDead(self);
  const was = selfWasDead;
  selfWasDead = dead;
  if (dead && was === false) playCreatureSound(selfGuid, "death");
}

/** Leaving a realm: the next character is not dead because the last one was. */
export function forgetCombatSounds(): void {
  selfWasDead = undefined;
}
