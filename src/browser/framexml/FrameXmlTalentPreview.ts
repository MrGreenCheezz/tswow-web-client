/**
 * Plan item 3.33: the talent preview of the stock PlayerTalentFrame — points placed on the tree
 * before they are spent, then learned together with `CMSG_LEARN_PREVIEW_TALENTS`.
 *
 * What Wow.exe does, and what this model does the same way:
 *
 * - `AddPreviewTalentPoints(tab, index, points[, isPet[, group]])` (0x5c9590 → 0x5c94f0 →
 *   0x5c9450, rules 0x5c73d0). A change is refused when: points are added and the group has no
 *   unspent point left over the preview already placed; the talent's tier is locked (tier × 5 for
 *   the character, × 3 for a pet, against the tab's learned and previewed points); a prerequisite's
 *   previewed rank is below the required one. The new preview rank is clamped between the learned
 *   rank and the talent's highest rank. Taking points back is refused when another previewed
 *   talent needs this one at the higher rank, or when a higher tier of the tab that holds points
 *   would lose its unlock. When the group's previewed total moved, event 0x274
 *   `PREVIEW_TALENT_POINTS_CHANGED` (0x275 for a pet) is signalled with
 *   `talentIndex, tabIndex, groupIndex, points`.
 * - `GetGroupPreviewTalentPointsSpent([isPet[, group]])` (0x5c6420): the group's previewed total.
 *   `GetPreviewTalentPointsSpent` (0x5c63b0) answers 0 whatever it is asked — the client's own.
 * - `ResetGroupPreviewTalentPoints` (0x5c7200) and `ResetPreviewTalentPoints(tab…)` (0x5c7130):
 *   every preview rank back to the learned one, the event with `0, 0|tab, group, -points`.
 * - `LearnPreviewTalents([isPet])` (0x5c6a10): only the active group (or the pet), only when a
 *   preview point is placed; one `(talentId, rank)` pair per talent previewed above its rank. The
 *   preview stays until the server's `SMSG_TALENTS_INFO` rebuilds the tree (here: a new talents
 *   packet object clears it).
 * - `GetTalentInfo` answers the preview rank (learned + previewed) and whether the preview meets the
 *   prerequisites (0x5c7800, 9th and 10th values); `GetTalentTabInfo` the tab's previewed points
 *   (0x5c6150, 5th); `GetTalentPrereqs` each prerequisite's preview check (0x5c7ed0). They read the
 *   snapshot this model decorates (`apply`).
 *
 * Deviations: the pairs go out ordered by tab, tier and column, a previewed prerequisite before its
 * dependant (the client walks its own hash order; the core learns each pair in turn and refuses a
 * talent whose tier or prerequisite is not yet met, so this is the order it accepts); the
 * `previewTalents` CVar callback that resets both previews (0x5127d0) is not wired.
 */

import type {
  FrameXmlTalentCellSnapshot, FrameXmlTalentGroupSnapshot, FrameXmlTalentSnapshot, FrameXmlTalentTabSnapshot,
} from "./FrameXmlTalentResolver.js";

export const PREVIEW_TALENT_POINTS_CHANGED = "PREVIEW_TALENT_POINTS_CHANGED";
export const PREVIEW_PET_TALENT_POINTS_CHANGED = "PREVIEW_PET_TALENT_POINTS_CHANGED";

/** Points per tier: `(isPet == 0) * 2 + 3` in 0x5c73d0. */
const PLAYER_POINTS_PER_TIER = 5;
const PET_POINTS_PER_TIER = 3;

export interface FrameXmlTalentPreviewPump {
  fire(event: string, ...args: readonly unknown[]): number;
}

export interface FrameXmlTalentPreviewContext {
  /** The resolver's snapshot, before this model decorates it. */
  readonly snapshot: (pet: boolean) => FrameXmlTalentSnapshot | undefined;
  /** The talents packet the snapshot came from; a new object is the server's rebuild. */
  readonly packet: (pet: boolean) => object | undefined;
  /** Sends the pairs (ranks one-based); the pet's go with its guid. */
  readonly learn: (pet: boolean, talents: ReadonlyArray<{ talentId: number; rank: number }>) => void;
}

interface PreviewState {
  packet: object | undefined;
  /** group (1-based) → talent id → previewed rank (one-based, above the learned rank). */
  readonly groups: Map<number, Map<number, number>>;
  revision: number;
  decorated?: { base: FrameXmlTalentSnapshot; revision: number; result: FrameXmlTalentSnapshot };
}

function integer(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(number) ? Math.trunc(number) : undefined;
}

export class FrameXmlTalentPreviewModel {
  readonly #context: FrameXmlTalentPreviewContext;
  readonly #states = new Map<boolean, PreviewState>();
  #pump: FrameXmlTalentPreviewPump | undefined;

  constructor(context: FrameXmlTalentPreviewContext) {
    this.#context = context;
  }

  attach(pump: FrameXmlTalentPreviewPump): void { this.#pump = pump; }
  detach(): void { this.#pump = undefined; }

  #state(pet: boolean): PreviewState {
    const packet = this.#context.packet(pet);
    let state = this.#states.get(pet);
    if (!state) {
      state = { packet, groups: new Map(), revision: 0 };
      this.#states.set(pet, state);
    } else if (state.packet !== packet) {
      // SMSG_TALENTS_INFO rebuilt the tree: every preview rank is the learned one again.
      state.packet = packet;
      if (state.groups.size > 0) { state.groups.clear(); state.revision += 1; }
    }
    return state;
  }

  #groupIndex(snapshot: FrameXmlTalentSnapshot, value: unknown): number {
    const group = integer(value);
    return group === undefined ? snapshot.activeTalentGroup : group;
  }

  /** The resolver's snapshot with the preview ranks, the tabs' previewed points and the preview checks. */
  apply(pet: boolean, base: FrameXmlTalentSnapshot | undefined): FrameXmlTalentSnapshot | undefined {
    if (!base) return undefined;
    const state = this.#state(pet);
    const cached = state.decorated;
    if (cached && cached.base === base && cached.revision === state.revision) return cached.result;
    const perTier = pet ? PET_POINTS_PER_TIER : PLAYER_POINTS_PER_TIER;
    const groups = base.groups.map((group) => decorateGroup(group, state.groups.get(group.group), perTier));
    const result: FrameXmlTalentSnapshot = Object.freeze({ ...base, groups: Object.freeze(groups) });
    state.decorated = { base, revision: state.revision, result };
    return result;
  }

  /** `AddPreviewTalentPoints(tab, index, points, isPet, group)`. */
  add(tabArg: unknown, indexArg: unknown, pointsArg: unknown, pet: boolean, groupArg: unknown): void {
    const tabIndex = integer(tabArg);
    const talentIndex = integer(indexArg);
    const points = integer(pointsArg);
    if (tabIndex === undefined || talentIndex === undefined || points === undefined) return;
    const base = this.#context.snapshot(pet);
    const snapshot = this.apply(pet, base);
    if (!snapshot) return;
    const groupIndex = this.#groupIndex(snapshot, groupArg);
    const group = snapshot.groups[groupIndex - 1];
    const tab = group?.tabs[tabIndex - 1];
    const cell = tab?.talents[talentIndex - 1];
    if (!group || !tab || !cell) return;
    const before = groupSpent(group);
    const moved = allowedChange(group, tab, cell, points, pet ? PET_POINTS_PER_TIER : PLAYER_POINTS_PER_TIER);
    if (moved === 0) return;
    const state = this.#state(pet);
    let previews = state.groups.get(groupIndex);
    if (!previews) { previews = new Map(); state.groups.set(groupIndex, previews); }
    const next = (cell.previewRank ?? cell.rank) + moved;
    if (next > cell.rank) previews.set(cell.id, next);
    else previews.delete(cell.id);
    state.revision += 1;
    const after = this.groupSpent(pet, groupIndex);
    if (after !== before) {
      this.#pump?.fire(pet ? PREVIEW_PET_TALENT_POINTS_CHANGED : PREVIEW_TALENT_POINTS_CHANGED,
        talentIndex, tabIndex, groupIndex, after - before);
    }
  }

  /** `GetGroupPreviewTalentPointsSpent(isPet, group)`. */
  groupSpent(pet: boolean, groupArg?: unknown): number {
    const snapshot = this.apply(pet, this.#context.snapshot(pet));
    if (!snapshot) return 0;
    const group = snapshot.groups[this.#groupIndex(snapshot, groupArg) - 1];
    return group ? groupSpent(group) : 0;
  }

  /** `ResetGroupPreviewTalentPoints(isPet, group)`; with `tab`, `ResetPreviewTalentPoints(tab, isPet, group)`. */
  reset(pet: boolean, groupArg: unknown, tabArg?: unknown): void {
    const snapshot = this.apply(pet, this.#context.snapshot(pet));
    if (!snapshot) return;
    const groupIndex = this.#groupIndex(snapshot, groupArg);
    const group = snapshot.groups[groupIndex - 1];
    const state = this.#state(pet);
    const previews = state.groups.get(groupIndex);
    if (!group || !previews || previews.size === 0) return;
    const before = groupSpent(group);
    const tabIndex = tabArg === undefined ? undefined : integer(tabArg);
    if (tabArg !== undefined) {
      const tab = tabIndex === undefined ? undefined : group.tabs[tabIndex - 1];
      if (!tab) return;
      for (const cell of tab.talents) previews.delete(cell.id);
    } else {
      previews.clear();
    }
    state.revision += 1;
    const after = this.groupSpent(pet, groupIndex);
    if (after !== before) {
      this.#pump?.fire(pet ? PREVIEW_PET_TALENT_POINTS_CHANGED : PREVIEW_TALENT_POINTS_CHANGED,
        0, tabIndex ?? 0, groupIndex, after - before);
    }
  }

  /** `LearnPreviewTalents(isPet)`: the active group's (or the pet's) previewed talents, lower tiers first. */
  learn(pet: boolean): void {
    const snapshot = this.apply(pet, this.#context.snapshot(pet));
    if (!snapshot) return;
    const group = snapshot.groups[snapshot.activeTalentGroup - 1];
    if (!group || groupSpent(group) <= 0) return;
    const pairs: { talentId: number; rank: number; tab: number; tier: number; column: number }[] = [];
    for (const tab of group.tabs) {
      for (const cell of tab.talents) {
        const preview = cell.previewRank ?? cell.rank;
        if (preview > cell.rank) pairs.push({ talentId: cell.id, rank: preview, tab: tab.index, tier: cell.tier, column: cell.column });
      }
    }
    pairs.sort((left, right) => left.tab - right.tab || left.tier - right.tier || left.column - right.column);
    if (pairs.length === 0) return;
    // Player::LearnTalent (Player.cpp:25897-25912) refuses a talent whose prerequisite is not known
    // yet, and Talent.dbc has same-tier prerequisites to the right of their dependant (2214 ← 71,
    // 1849 ← 1735…): a previewed prerequisite goes out before the talent that needs it.
    const byId = new Map<number, (typeof pairs)[number]>();
    for (const pair of pairs) byId.set(pair.talentId, pair);
    const prerequisitesOf = new Map<number, readonly number[]>();
    for (const tab of group.tabs) {
      for (const cell of tab.talents) {
        if (byId.has(cell.id)) prerequisitesOf.set(cell.id, cell.prerequisites.map((prerequisite) => prerequisite.talentId));
      }
    }
    const ordered: { talentId: number; rank: number }[] = [];
    const placed = new Set<number>();
    const place = (pair: (typeof pairs)[number], depth: number): void => {
      if (placed.has(pair.talentId) || depth > pairs.length) return;
      for (const id of prerequisitesOf.get(pair.talentId) ?? []) {
        const prerequisite = byId.get(id);
        if (prerequisite) place(prerequisite, depth + 1);
      }
      if (placed.has(pair.talentId)) return;
      placed.add(pair.talentId);
      ordered.push({ talentId: pair.talentId, rank: pair.rank });
    };
    for (const pair of pairs) place(pair, 0);
    this.#context.learn(pet, ordered);
  }
}

function groupSpent(group: FrameXmlTalentGroupSnapshot): number {
  let total = 0;
  for (const tab of group.tabs) total += tab.previewPointsSpent;
  return total;
}

function decorateGroup(
  group: FrameXmlTalentGroupSnapshot, previews: ReadonlyMap<number, number> | undefined, perTier: number,
): FrameXmlTalentGroupSnapshot {
  const rankOf = new Map<number, number>();
  for (const tab of group.tabs) {
    for (const cell of tab.talents) {
      const preview = previews?.get(cell.id);
      rankOf.set(cell.id, preview !== undefined && preview > cell.rank ? Math.min(preview, cell.maxRank) : cell.rank);
    }
  }
  const tabs = group.tabs.map((tab): FrameXmlTalentTabSnapshot => {
    let previewPointsSpent = 0;
    for (const cell of tab.talents) previewPointsSpent += (rankOf.get(cell.id) ?? cell.rank) - cell.rank;
    const total = tab.pointsSpent + previewPointsSpent;
    const talents = tab.talents.map((cell): FrameXmlTalentCellSnapshot => {
      let meetsPreviewPrereq: boolean | undefined = true;
      const prerequisites = cell.prerequisites.map((prerequisite) => {
        const rank = rankOf.get(prerequisite.talentId);
        const meets = rank === undefined ? undefined : rank >= prerequisite.requiredRank;
        if (meets === undefined) meetsPreviewPrereq = undefined;
        else if (!meets && meetsPreviewPrereq !== undefined) meetsPreviewPrereq = false;
        return Object.freeze({ ...prerequisite, meetsPreviewPrereq: meets });
      });
      // meetsPrereq is undefined where the resolver could not tell; the preview check follows it.
      if (cell.meetsPrereq === undefined) meetsPreviewPrereq = undefined;
      else if (total < (cell.tier - 1) * perTier && meetsPreviewPrereq !== undefined) meetsPreviewPrereq = false;
      return Object.freeze({
        ...cell,
        previewRank: rankOf.get(cell.id) ?? cell.rank,
        meetsPreviewPrereq,
        prerequisites: prerequisites.length > 0 ? Object.freeze(prerequisites) : cell.prerequisites,
      });
    });
    return Object.freeze({ ...tab, previewPointsSpent, talents: Object.freeze(talents) });
  });
  return Object.freeze({ ...group, tabs: Object.freeze(tabs) });
}

/** 0x5c73d0 over a decorated group: the points actually moved, 0 when refused. */
function allowedChange(
  group: FrameXmlTalentGroupSnapshot, tab: FrameXmlTalentTabSnapshot, cell: FrameXmlTalentCellSnapshot,
  points: number, perTier: number,
): number {
  if (points === 0) return 0;
  const spent = groupSpent(group);
  const unspent = group.unspentPoints ?? 0;
  if (points > 0 && unspent - spent <= 0) return 0;
  const tier = cell.tier - 1;
  if (perTier * tier > tab.pointsSpent + tab.previewPointsSpent) return 0;
  const previewRankOf = (talentId: number): number => {
    for (const other of group.tabs) for (const talent of other.talents) if (talent.id === talentId) return talent.previewRank ?? talent.rank;
    return 0;
  };
  for (const prerequisite of cell.prerequisites) {
    if (previewRankOf(prerequisite.talentId) < prerequisite.requiredRank) return 0;
  }
  const current = cell.previewRank ?? cell.rank;
  const next = Math.min(Math.max(current + points, cell.rank), cell.maxRank);
  const moved = next - current;
  if (moved >= 0) return moved;
  // Taking points back: no previewed dependant may lose its requirement…
  for (const other of group.tabs) {
    for (const talent of other.talents) {
      if ((talent.previewRank ?? talent.rank) < 1) continue;
      for (const prerequisite of talent.prerequisites) {
        if (prerequisite.talentId === cell.id && next < prerequisite.requiredRank) return 0;
      }
    }
  }
  // …and no higher tier of the tab holding points may lose its unlock.
  const tiers = new Map<number, number>();
  for (const talent of tab.talents) {
    const rank = (talent.previewRank ?? talent.rank) + (talent.id === cell.id ? moved : 0);
    tiers.set(talent.tier - 1, (tiers.get(talent.tier - 1) ?? 0) + rank);
  }
  let below = 0;
  for (const index of [...tiers.keys()].sort((left, right) => left - right)) {
    const inTier = tiers.get(index) ?? 0;
    if (index > tier && inTier > 0 && below < index * perTier) return 0;
    below += inTier;
  }
  return moved;
}

export interface FrameXmlTalentPreviewHost {
  readonly talentPreview?: FrameXmlTalentPreviewModel | undefined;
}

const NOTHING: readonly unknown[] = Object.freeze([]);

function truthy(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false;
}

/** The preview C API; without a model (the canned world) the group total is 0 and the rest do nothing. */
export const FRAMEXML_TALENT_PREVIEW_BINDINGS: Readonly<Record<string,
  (host: FrameXmlTalentPreviewHost, args: readonly unknown[]) => readonly unknown[]>> = Object.freeze({
  AddPreviewTalentPoints: (host, args) => {
    host.talentPreview?.add(args[0], args[1], args[2], truthy(args[3]), args[4]);
    return NOTHING;
  },
  GetGroupPreviewTalentPointsSpent: (host, args) => [host.talentPreview?.groupSpent(truthy(args[0]), args[1]) ?? 0],
  // Wow.exe 0x5c63b0 reads its arguments and pushes 0.
  GetPreviewTalentPointsSpent: () => [0],
  ResetGroupPreviewTalentPoints: (host, args) => {
    host.talentPreview?.reset(truthy(args[0]), args[1]);
    return NOTHING;
  },
  ResetPreviewTalentPoints: (host, args) => {
    host.talentPreview?.reset(truthy(args[1]), args[2], args[0] ?? 0);
    return NOTHING;
  },
  LearnPreviewTalents: (host, args) => {
    host.talentPreview?.learn(truthy(args[0]));
    return NOTHING;
  },
});
