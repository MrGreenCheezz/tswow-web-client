/**
 * Plan item 3.01, slice E: the combat log over a live WorldClient.
 *
 * Facts come from the packet bus — UNIT_COMBAT (melee, spell damage, heal, energize, periodic, miss,
 * damage shield, immune, resist), COMBAT_FACT (environmental, execute, enchant, instakill, dispel,
 * failed dispel), SPELL_START, SPELL_GO, SPELL_CAST_RESULT (3.01-castlog: the cast entries' rules are
 * FrameXmlCombatLogCasts.ts; 05.10-3.01: SPELL_CAST_REFUSED_LOCAL, the words FrameXmlCombatLogFailed.ts),
 * AURA_CHANGED, PARTY_KILL and the
 * health falling to 0 (UNIT_DIED) — and become entries (world/CombatEventModel.ts) in the buffer
 * (FrameXmlCombatLog.ts), then COMBAT_LOG_EVENT and COMBAT_LOG_EVENT_UNFILTERED.
 *
 * The flags follow Wow.exe 0x0074dcb0: no GUID → COMBATLOG_OBJECT_NONE; the unit's controller is its
 * CHARMEDBY, else CREATEDBY (a game object's CREATED_BY), one more step up when that is not a player;
 * type PLAYER/NPC/PET (0xF140 guid) for a unit that controls itself, PET (summoned or charmed) or
 * GUARDIAN (only created) for one with an owner, OBJECT for anything else; control PLAYER when the
 * controller is a player; MINE|FRIENDLY for the player's own; else the unit's reaction (hostile,
 * neutral, friendly), PARTY or RAID by the controller's group place, OUTSIDER/NEUTRAL when nothing
 * says otherwise; TARGET and FOCUS; MAINTANK/MAINASSIST for a grouped player; the raid icon only while
 * grouped.
 *
 * Deliberate differences: the original holds an entry back until a player's name query answers
 * (0x0074fd40 marks it pending); here the entry goes out at once with a nil name and the query is
 * sent. A spell row not yet fetched gives nil name and school 0, as the original does for a spell it
 * does not know, and the row is fetched for the next time. Events go to the first unit token a GUID
 * answers to only through the seam's other events; the log itself names GUIDs, not tokens.
 *
 * Cost: one pooled entry per fact, two flag computations (object and group lookups), and the argument
 * list only while someone listens. The pump says who is registered at the moment of the entry
 * (`listening`, the frame registry); a pump without it falls back to `fire`'s count — an event nobody
 * took is not built again for a second (FRAMEXML_COMBAT_LOG_PROBE_MS), which can hide up to that second
 * from an add-on that registers meanwhile (02.10 review), so the boot's pump answers `listening`.
 */

import type { WorldClient } from "../../world/WorldClient.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import type { SpellMetadata } from "../SpellMetadata.js";
import type { UnitCombatEvent } from "../../world/UnitCombat.js";
import type { CombatFact } from "../../world/CombatFacts.js";
import type { ActiveAura } from "../../world/AuraProtocol.js";
import { AURA_FLAGS } from "../../world/AuraProtocol.js";
import { readField } from "../../world/Fields.js";
import { REACTION_FRIENDLY, REACTION_HOSTILE } from "../../world/FactionRules.js";
import {
  CL, auraEntry, castFailedEntry, damageShieldEntries, enchantEntry, energizeEntries, environmentalEntries,
  executeEntries, extraSpellEntry, healEntries, meleeEntries, periodicEntries, spellDamageEntries, spellMissEntries,
  spellOnlyEntry, type CombatEntrySink, type CombatLogEntry, type CombatSpellFacts,
} from "../../world/CombatEventModel.js";
import { FrameXmlCombatLogBuffer, type FrameXmlCombatLogModel } from "./FrameXmlCombatLog.js";
import type { SpellGo, SpellStart } from "../../world/SpellProtocol.js"; // 3.01-castlog
import { FrameXmlCombatLogCastRules } from "./FrameXmlCombatLogCasts.js"; // 3.01-castlog
import { combatLogLimitCategoryText, type CombatLogLimitCategory } from "./FrameXmlCombatLogFailed.js"; // 05.10-3.01
import { formatGlobalStringByName } from "../../world/GlobalStringFormat.js"; // 05.10-3.01
import { itemLimitCategoryClient } from "../ItemLimitCategoryClient.js"; // 05.10-3.01
import { game } from "../game/Context.js"; // 05.10-3.01

/** How long an event nobody took is not built again. */
export const FRAMEXML_COMBAT_LOG_PROBE_MS = 1000;

export interface FrameXmlCombatLogLiveDeps {
  readonly world: () => WorldClient | undefined;
  readonly spell: (id: number) => SpellMetadata | undefined;
  /** Fetch rows not yet known (the seam's ensureSpellNames). */
  readonly prefetchSpells?: (ids: readonly number[]) => void;
  /** A unit's or object's name as UnitName would give it; undefined when not known yet. */
  readonly name: (guid: bigint) => string | undefined;
  /** The reaction of the unit towards the player (FactionRules REACTION_*), undefined when unknown. */
  readonly reaction: (object: WorldObjectState) => number | undefined;
  readonly targetGuid: () => bigint | undefined;
  readonly focusGuid: () => bigint | undefined;
  /** SPELL_CAST_FAILED's text for a SpellCastResult (the stock SPELL_FAILED_* string). */
  readonly failureText?: (spellId: number, result: number) => string | undefined;
  readonly enchantName?: (enchantId: number) => string | undefined;
  readonly itemName?: (itemId: number) => string | undefined;
  /** Milliseconds, monotonic (probing); the timestamp itself is Date.now(). */
  readonly monotonic?: () => number;
  readonly now?: () => number;
  /** The world-state bus (WorldStore.events) for UNIT_HEALTH. */
  readonly stateEvents?: () => { on(name: "UNIT_HEALTH", listener: (event: { guid: bigint }) => void): () => void } | undefined;
  /**
   * 05.10-3.01: an ItemLimitCategory row (TOO_MANY_OF_ITEM's words) and the fetch of the rows, asked at attach;
   * the page's `/dbc/item-limit-categories` catalog (ItemLimitCategoryClient.ts) when absent.
   */
  readonly limitCategory?: (id: number) => CombatLogLimitCategory | undefined;
  readonly prepareLimitCategories?: () => void;
}

export interface FrameXmlCombatLogPump {
  fire(event: string, ...args: readonly unknown[]): number;
  /**
   * Whether any frame is registered for the event now. With it, the argument list is built exactly
   * when someone listens; without it (an older pump) the one-second probe below stands in.
   */
  listening?(event: string): boolean;
}

const TYPEID_UNIT = 3;
const TYPEID_PLAYER = 4;
const GROUPTYPE_RAID = 0x02;
const SPELL_CAST_RESULT_SUCCESS = 187;

function isPlayerGuid(guid: bigint): boolean {
  return guid !== 0n && (guid >> 60n) === 0n;
}

function highKind(guid: bigint): number {
  return Number((guid >> 32n) & 0xf0f00000n);
}

const CREATURE_TYPE_FLAG_MASK_UID = 0x4000;

/** 0x0074d210: the low 24 bits cleared for a creature/vehicle GUID whose cached template has MASK_UID. */
function maskedGuid(guid: bigint, world: WorldClient | undefined): bigint {
  const kind = highKind(guid);
  if (kind !== 0xf0300000 && kind !== 0xf0500000) return guid;
  const templates = world?.creatureTemplates;
  if (!templates) return guid;
  const entry = Number((guid >> 24n) & 0xfffffffn);
  const template = templates.get(entry);
  return template !== undefined && (template.flags & CREATURE_TYPE_FLAG_MASK_UID) !== 0 ? guid & ~0xffffffn : guid;
}

export class FrameXmlCombatLogLive implements FrameXmlCombatLogModel, CombatEntrySink, CombatSpellFacts {
  readonly buffer: FrameXmlCombatLogBuffer;
  readonly #deps: FrameXmlCombatLogLiveDeps;
  #pump: FrameXmlCombatLogPump | undefined;
  readonly #unsubscribe: (() => void)[] = [];
  /** Until when (monotonic ms) an event is known to have no listener. */
  #quietFiltered = 0;
  #quietUnfiltered = 0;
  readonly #asked = new Set<number>();
  readonly #dead = new Set<bigint>();
  /** The aura flags of a unit's last removed auras, for SPELL_DISPEL's BUFF/DEBUFF. */
  readonly #removed = new Map<bigint, Map<number, number>>();
  /** 3.01-castlog: which START/SUCCESS/FAILED entries Wow.exe writes (FrameXmlCombatLogCasts.ts). */
  readonly #castRules = new FrameXmlCombatLogCastRules();

  constructor(deps: FrameXmlCombatLogLiveDeps) {
    this.#deps = deps;
    this.buffer = new FrameXmlCombatLogBuffer({
      spell: (id) => {
        const spell = deps.spell(id);
        if (spell === undefined) this.#prefetch(id);
        return spell;
      },
    });
  }

  // ---- CombatSpellFacts ----

  attributes(spellId: number): readonly number[] | undefined {
    const spell = this.#deps.spell(spellId);
    if (spell === undefined) { this.#prefetch(spellId); return undefined; }
    return spell.attributes ?? [spell.hidden ? 0x80 : 0];
  }

  #prefetch(id: number): void {
    if (id <= 0 || this.#asked.has(id) || !this.#deps.prefetchSpells) return;
    this.#asked.add(id);
    this.#deps.prefetchSpells([id]);
  }

  // ---- CombatEntrySink ----

  begin(event: number, source: bigint, dest: bigint, spellId: number): CombatLogEntry {
    const entry = this.buffer.next();
    entry.event = event;
    entry.source = source;
    entry.dest = dest;
    entry.spellId = spellId;
    return entry;
  }

  commit(entry: CombatLogEntry): void {
    const world = this.#deps.world();
    entry.time = (this.#deps.now?.() ?? Date.now()) / 1000;
    if (entry.source !== 0n) {
      entry.sourceName = this.#name(entry.source, world);
      entry.sourceFlags = this.flags(entry.source, world);
    }
    if (entry.dest !== 0n) {
      entry.destName = this.#name(entry.dest, world);
      entry.destFlags = this.flags(entry.dest, world);
    }
    // 0x0074d210, right before 0x0074f910: a creature or vehicle whose template says
    // CREATURE_TYPE_FLAG_MASK_UID (0x4000) is named without its spawn counter.
    entry.source = maskedGuid(entry.source, world);
    entry.dest = maskedGuid(entry.dest, world);
    this.buffer.push(entry);
    const pump = this.#pump;
    if (!pump) return;
    // 0x0074f910: COMBAT_LOG_EVENT for an entry that passes the filter, then _UNFILTERED, to whoever
    // is registered at this moment.
    if (pump.listening) {
      if (pump.listening("COMBAT_LOG_EVENT") && this.buffer.passes(entry)) {
        pump.fire("COMBAT_LOG_EVENT", ...this.buffer.args(entry));
      }
      if (pump.listening("COMBAT_LOG_EVENT_UNFILTERED")) {
        pump.fire("COMBAT_LOG_EVENT_UNFILTERED", ...this.buffer.args(entry));
      }
      return;
    }
    const now = this.#deps.monotonic?.() ?? performance.now();
    if (now >= this.#quietFiltered && this.buffer.passes(entry)) {
      if (pump.fire("COMBAT_LOG_EVENT", ...this.buffer.args(entry)) === 0) {
        this.#quietFiltered = now + FRAMEXML_COMBAT_LOG_PROBE_MS;
      }
    }
    if (now >= this.#quietUnfiltered) {
      if (pump.fire("COMBAT_LOG_EVENT_UNFILTERED", ...this.buffer.args(entry)) === 0) {
        this.#quietUnfiltered = now + FRAMEXML_COMBAT_LOG_PROBE_MS;
      }
    }
  }

  #name(guid: bigint, world: WorldClient | undefined): string | undefined {
    const name = this.#deps.name(guid);
    if (name === undefined && world && isPlayerGuid(guid)) world.requestName?.(guid);
    return name;
  }

  /** 0x0074dcb0. */
  flags(guid: bigint, world = this.#deps.world()): number {
    if (guid === 0n) return 0x80000000;
    const self = world?.state?.selfGuid;
    const group = world?.group;
    const inGroup = group !== undefined && group.members.length > 0;
    const inRaid = inGroup && (group!.groupType & GROUPTYPE_RAID) !== 0;
    const object = world?.state?.objects?.get(guid);
    let controller = guid;
    let unit: WorldObjectState | undefined;
    const ownerOf = (target: WorldObjectState): bigint => {
      if (target.typeId === TYPEID_UNIT || target.typeId === TYPEID_PLAYER) {
        const charmer = readField(target, "UNIT_FIELD_CHARMEDBY") ?? 0n;
        return charmer !== 0n ? charmer : (readField(target, "UNIT_FIELD_CREATEDBY") ?? 0n);
      }
      if (target.typeId === 5) return readField(target, "OBJECT_FIELD_CREATED_BY") ?? 0n;
      return 0n;
    };
    if (object) {
      if (object.typeId === TYPEID_UNIT || object.typeId === TYPEID_PLAYER) unit = object;
      const owner = ownerOf(object);
      if (owner !== 0n) {
        controller = owner;
        if (!isPlayerGuid(controller)) {
          const next = world?.state?.objects?.get(controller);
          const up = next ? ownerOf(next) : 0n;
          if (up !== 0n) controller = up;
        }
      }
    }
    let flags: number;
    const kind = highKind(guid);
    if (isPlayerGuid(guid) || kind === 0xf0300000 || kind === 0xf0500000 || kind === 0xf0400000) {
      if (controller === guid) flags = isPlayerGuid(guid) ? 0x400 : kind === 0xf0400000 ? 0x1000 : 0x800;
      else {
        const summoner = unit ? (readField(unit, "UNIT_FIELD_CHARMEDBY") ?? 0n) || (readField(unit, "UNIT_FIELD_SUMMONEDBY") ?? 0n) : 0n;
        flags = summoner !== 0n ? 0x1000 : 0x2000;
      }
    } else {
      flags = 0x4000;
    }
    flags |= isPlayerGuid(controller) ? 0x100 : 0x200;
    if (self !== undefined && controller === self) {
      flags |= 0x11;
    } else {
      if (unit) {
        const reaction = this.#deps.reaction(unit);
        if (reaction === REACTION_FRIENDLY) flags |= 0x10;
        else if (reaction === REACTION_HOSTILE) flags |= 0x40;
      }
      if (inGroup) {
        const member = group!.members.find((entry) => entry.guid === controller);
        if (member) {
          if (!inRaid || member.subGroup === group!.ownSubGroup) flags |= 0x12;
          else flags |= 0x14;
        }
      }
      if ((flags & 0xf) === 0) flags |= 0x8;
      if ((flags & 0xf0) === 0) flags |= 0x20;
    }
    if (guid === this.#deps.targetGuid()) flags |= 0x10000;
    if (guid === this.#deps.focusGuid()) flags |= 0x20000;
    if ((flags & 0x400) !== 0 && inGroup) {
      const memberFlags = guid === self ? group!.ownFlags
        : group!.members.find((entry) => entry.guid === guid)?.flags ?? 0;
      if ((memberFlags & 2) !== 0) flags |= 0x40000;
      else if ((memberFlags & 4) !== 0) flags |= 0x80000;
    }
    if (inGroup && world?.raidTargets) {
      for (const [icon, marked] of world.raidTargets) {
        if (marked === guid && icon >= 0 && icon < 8) { flags |= 0x100000 << icon; break; }
      }
    }
    return flags >>> 0;
  }

  // ---- the facts ----

  unitCombat(event: UnitCombatEvent): void {
    switch (event.source) {
      case "melee":
        meleeEntries(event.swing, this);
        return;
      case "spellDamage":
        spellDamageEntries(event.log, this, this);
        return;
      case "heal":
        healEntries(event.log.casterGuid, event.log.targetGuid, event.log.spellId, event.log.amount, event.log.overheal,
          event.log.absorbed, event.log.critical, false, this);
        return;
      case "energize":
        energizeEntries(event.log.casterGuid, event.log.targetGuid, event.log.spellId, event.log.amount,
          event.log.powerType, false, this);
        return;
      case "periodic":
        periodicEntries(event.log, this, this);
        return;
      case "miss":
        spellMissEntries(event.casterGuid, event.targetGuid, event.spellId, event.missInfo, this, this);
        return;
      case "damageShield":
        damageShieldEntries(event.log.casterGuid, event.log.targetGuid, event.log.spellId, event.log.damage,
          event.log.overkill, event.log.schoolMask, this, this);
        return;
      case "immune":
        spellMissEntries(event.log.casterGuid, event.log.targetGuid, event.log.spellId, 7, this, this);
        return;
      case "resist":
        spellMissEntries(event.log.casterGuid, event.log.targetGuid, event.log.spellId, 2, this, this, true);
        return;
      default:
    }
  }

  combatFact(fact: CombatFact): void {
    switch (fact.source) {
      case "environmental":
        environmentalEntries(fact.log.victim, fact.log.type, fact.log.damage, fact.log.resisted, fact.log.absorbed, this);
        return;
      case "execute":
        executeEntries(fact.log.casterGuid, fact.log.spellId, fact.log.effects, this, this);
        return;
      case "enchant": {
        const name = this.#deps.enchantName?.(fact.log.enchantId) ?? "";
        const item = this.#deps.itemName?.(fact.log.itemId) ?? "";
        enchantEntry(fact.log.casterGuid, fact.log.targetGuid, name, fact.log.itemId, item, this);
        return;
      }
      case "instakill":
        spellOnlyEntry(CL.SPELL_INSTAKILL, fact.log.casterGuid, fact.log.targetGuid, fact.log.spellId, this);
        return;
      case "dispel": {
        const removed = this.#removed.get(fact.log.targetGuid);
        for (const entry of fact.log.dispelled) {
          const flags = removed?.get(entry.spellId) ?? this.#deps.world()?.auras?.get(fact.log.targetGuid)?.get(entry.spellId)?.flags;
          const debuff = flags !== undefined && (flags & AURA_FLAGS.negative) !== 0;
          extraSpellEntry(fact.stolen ? CL.SPELL_STOLEN : CL.SPELL_DISPEL, fact.log.casterGuid, fact.log.targetGuid,
            fact.log.spellId, entry.spellId, debuff ? "DEBUFF" : "BUFF", this);
        }
        return;
      }
      case "dispelFailed":
        for (const spellId of fact.log.failed) {
          extraSpellEntry(CL.SPELL_DISPEL_FAILED, fact.log.casterGuid, fact.log.targetGuid, fact.log.spellId, spellId,
            undefined, this);
        }
        return;
      case "died":
        spellOnlyEntry(CL.UNIT_DIED, 0n, fact.guid, 0, this);
        return;
      default:
    }
  }

  // 3.01-castlog (03.10): the cast entries by Wow.exe's rules — FrameXmlCombatLogCasts.ts has them with
  // their addresses. START from SMSG_SPELL_START (the bus's SPELL_START, after the cast bar), SUCCESS
  // from the GO (before its misses, as 0x0080e1b0), FAILED only from the player's SMSG_CAST_FAILED.

  /** A unit or a player in view: what 0x004d4db0 with type mask 8 finds. */
  #isUnit(guid: bigint, world: WorldClient | undefined): boolean {
    const typeId = world?.state?.objects?.get(guid)?.typeId;
    return typeId === TYPEID_UNIT || typeId === TYPEID_PLAYER;
  }

  #spellRow(spellId: number): SpellMetadata | undefined {
    const spell = this.#deps.spell(spellId);
    if (spell === undefined) this.#prefetch(spellId);
    return spell;
  }

  // 3.01-review (03.10): one descriptor each, refilled per packet — no allocation per START or GO.
  readonly #startView = { casterGuid: 0n, spellId: 0, castId: 0, castFlags: 0, castTime: 0, casterIsUnit: false, self: false };
  readonly #goView = { casterGuid: 0n, spellId: 0, castId: 0, castFlags: 0, casterIsUnit: false }; // 3.01-review

  /** SMSG_SPELL_START → SPELL_CAST_START (0x00806700 → 0x00751920). */
  spellStart(start: SpellStart): void {
    const world = this.#deps.world();
    const view = this.#startView; // 3.01-review
    view.casterGuid = start.casterUnit; // 3.01-review
    view.spellId = start.spellId; // 3.01-review
    view.castId = start.castId; // 3.01-review
    view.castFlags = start.castFlags; // 3.01-review
    view.castTime = start.castTime; // 3.01-review
    view.casterIsUnit = this.#isUnit(start.casterUnit, world); // 3.01-review
    view.self = world?.state?.selfGuid !== undefined && start.casterUnit === world.state.selfGuid; // 3.01-review
    const write = this.#castRules.start(view, this.#spellRow(start.spellId)); // 3.01-review
    if (write) spellOnlyEntry(CL.SPELL_CAST_START, start.casterUnit, 0n, start.spellId, this);
  }

  /** SMSG_SPELL_GO → SPELL_CAST_SUCCESS at the target block's object (0x0080e1b0 → 0x007519e0). */
  spellGo(go: SpellGo): void {
    const world = this.#deps.world();
    const view = this.#goView; // 3.01-review
    view.casterGuid = go.casterUnit; // 3.01-review
    view.spellId = go.spellId; // 3.01-review
    view.castId = go.castId; // 3.01-review
    view.castFlags = go.castFlags; // 3.01-review
    view.casterIsUnit = this.#isUnit(go.casterUnit, world); // 3.01-review
    const write = this.#castRules.success(view, this.#spellRow(go.spellId)); // 3.01-review
    const dest = go.targets?.unitTarget ?? go.targets?.gameObjectTarget ?? 0n;
    if (write) spellOnlyEntry(CL.SPELL_CAST_SUCCESS, go.casterUnit, dest, go.spellId, this);
  }

  /** The player's SMSG_CAST_FAILED → SPELL_CAST_FAILED (0x00809af0 → 0x00808200 → 0x00751ad0). */
  castResult(event: {
    casterGuid: bigint; spellId: number; castCount: number; result: number; refusal?: true;
    text?: string; extra?: readonly number[]; // 05.10-3.01
  }): void {
    const world = this.#deps.world();
    if (event.refusal !== true || event.result === SPELL_CAST_RESULT_SUCCESS) return;
    if (event.casterGuid !== world?.state?.selfGuid) return;
    this.#refused(event.spellId, event.result, event.text, event.extra, world); // 05.10-3.01
  }

  /** 05.10-3.01: the client's own refusal (0x00809f80 → 0x00808200): the same rules, the active player's entry. */
  localRefusal(event: { spellId: number; result: number; text?: string }): void {
    const world = this.#deps.world();
    if (world?.state?.selfGuid === undefined || event.result === SPELL_CAST_RESULT_SUCCESS) return;
    this.#refused(event.spellId, event.result, event.text, undefined, world);
  }

  /**
   * 05.10-3.01: 0x00808200's log half for the active player (0x004d3790): the repeat rules against the
   * autoRangedCombat controller's wanted spell (0x00d397cc) with 0x007fe190's resets caught up first; the
   * words — TOO_MANY_OF_ITEM's limit-category sentence (past the repeat rules) or the refusal's own; none,
   * no entry (0x00751ad0).
   */
  #refused(spellId: number, result: number, text: string | undefined, extra: readonly number[] | undefined,
    world: WorldClient | undefined): void {
    const self = world?.state?.selfGuid;
    if (self === undefined) return;
    const resets = world?.autoRanged?.failureResets;
    if (resets !== undefined && resets !== this.#seenResets) {
      this.#seenResets = resets;
      this.#castRules.autoRepeatReset();
    }
    const now = this.#deps.monotonic?.() ?? performance.now();
    const limit = combatLogLimitCategoryText(result, extra, this.#limitCategory, formatGlobalStringByName);
    if (!this.#castRules.failed(spellId, result, now, world?.autoRanged?.wantedSpellId, this.#spellRow(spellId),
      limit !== undefined)) return;
    const words = limit ?? (text || this.#deps.failureText?.(spellId, result));
    if (!words) return;
    castFailedEntry(self, spellId, words, this);
  }

  /** 05.10-3.01: the last `AutoRangedCombat.failureResets` the rules have caught up with. */
  #seenResets: number | undefined;
  readonly #limitCategory = (id: number): CombatLogLimitCategory | undefined => // 05.10-3.01
    this.#deps.limitCategory ? this.#deps.limitCategory(id) : itemLimitCategoryClient(game.gatewayOrigin)?.category(id);

  auraChanged(event: {
    guid: bigint; replaceAll?: boolean; previous?: ReadonlyMap<number, ActiveAura>;
    added?: readonly ActiveAura[]; removed?: readonly ActiveAura[];
    updated?: readonly { before: ActiveAura; after: ActiveAura }[];
  }): void {
    // Older emitters (and test worlds) may send only the guid: nothing to log then.
    const added = event.added ?? [];
    const removed = event.removed ?? [];
    const updated = event.updated ?? [];
    if (removed.length > 0) {
      let flags = this.#removed.get(event.guid);
      if (flags) flags.clear();
      else {
        if (this.#removed.size >= 256) this.#removed.clear();
        flags = new Map<number, number>();
        this.#removed.set(event.guid, flags);
      }
      for (const aura of removed) flags.set(aura.spellId, aura.flags);
    }
    // A unit's first full list is the quiet baseline (it was there before the client looked).
    if (event.replaceAll && (event.previous?.size ?? 0) === 0) return;
    for (const aura of added) {
      if (this.#hidden(aura.spellId)) continue;
      auraEntry(CL.SPELL_AURA_APPLIED, aura.casterGuid ?? 0n, event.guid, aura.spellId,
        (aura.flags & AURA_FLAGS.negative) !== 0, undefined, this);
    }
    for (const { before, after } of updated) {
      if (this.#hidden(after.spellId)) continue;
      const debuff = (after.flags & AURA_FLAGS.negative) !== 0;
      const source = after.casterGuid ?? 0n;
      if (after.applications > before.applications) {
        auraEntry(CL.SPELL_AURA_APPLIED_DOSE, source, event.guid, after.spellId, debuff, after.applications, this);
      } else if (after.applications < before.applications) {
        auraEntry(CL.SPELL_AURA_REMOVED_DOSE, source, event.guid, after.spellId, debuff, after.applications, this);
      } else {
        auraEntry(CL.SPELL_AURA_REFRESH, source, event.guid, after.spellId, debuff, undefined, this);
      }
    }
    for (const aura of removed) {
      if (this.#hidden(aura.spellId)) continue;
      auraEntry(CL.SPELL_AURA_REMOVED, aura.casterGuid ?? 0n, event.guid, aura.spellId,
        (aura.flags & AURA_FLAGS.negative) !== 0, undefined, this);
    }
  }

  partyKill(killer: bigint, victim: bigint): void {
    spellOnlyEntry(CL.PARTY_KILL, killer, victim, 0, this);
  }

  /** UNIT_HEALTH: a unit whose health fell to 0 died once. */
  health(guid: bigint): void {
    const object = this.#deps.world()?.state?.objects?.get(guid);
    if (!object) return;
    const health = readField(object, "UNIT_FIELD_HEALTH");
    if (health === undefined) return;
    if (health === 0) {
      if (this.#dead.has(guid)) return;
      this.#dead.add(guid);
      if (this.#dead.size > 4096) this.#dead.clear();
      spellOnlyEntry(CL.UNIT_DIED, 0n, guid, 0, this);
    } else {
      this.#dead.delete(guid);
    }
  }

  #hidden(spellId: number): boolean {
    const attributes = this.attributes(spellId);
    return attributes !== undefined && ((attributes[0] ?? 0) & 0x180) !== 0;
  }

  attach(pump: FrameXmlCombatLogPump): void {
    this.detach();
    this.#pump = pump;
    this.#castRules.reset(); // 3.01-castlog
    this.#quietFiltered = 0;
    this.#quietUnfiltered = 0;
    const world = this.#deps.world();
    this.#seenResets = world?.autoRanged?.failureResets; // 05.10-3.01
    if (this.#deps.prepareLimitCategories) this.#deps.prepareLimitCategories(); // 05.10-3.01
    else itemLimitCategoryClient(game.gatewayOrigin)?.load(); // 05.10-3.01
    if (!world?.events) return;
    const on = world.events.on.bind(world.events);
    this.#unsubscribe.push(
      on("UNIT_COMBAT", (event) => this.unitCombat(event)),
      on("COMBAT_FACT", (fact) => this.combatFact(fact)),
      on("SPELL_START", (start) => this.spellStart(start)), // 3.01-castlog
      on("SPELL_GO", (go) => this.spellGo(go)), // 3.01-castlog
      on("SPELL_CAST_RESULT", (event) => this.castResult(event)), // 3.01-castlog
      on("SPELL_CAST_REFUSED_LOCAL", (event) => this.localRefusal(event)), // 05.10-3.01
      on("AURA_CHANGED", (event) => this.auraChanged(event)),
      on("PARTY_KILL", (event) => this.partyKill(event.killerGuid, event.victimGuid)),
    );
    // UNIT_HEALTH rides the world-state bus (WorldStore), not the packet bus.
    const stateEvents = this.#deps.stateEvents?.();
    if (stateEvents) this.#unsubscribe.push(stateEvents.on("UNIT_HEALTH", ({ guid }) => this.health(guid)));
  }

  detach(): void {
    for (const stop of this.#unsubscribe.splice(0)) stop();
    this.#pump = undefined;
  }
}
