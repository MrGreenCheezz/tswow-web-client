// 13.10 (6.13): which beams a kit draws, between which points and when — Wow.exe 3.3.5a 12340's beam builder
// (Ghidra read-only, .runtime/re-2026-10-11/glue-1110/1013-m4…m8.txt):
//
// - The kit procedure switch 0x007265c0 sends CharProc 0 and 12 to 0x007fc950 → 0x007fc5f0 with the unit the
//   kit plays on as the first end, its spell targets (or, in a channel, UNIT_FIELD_CHANNEL_OBJECT) as the
//   rest, «persistent» (CharParamTwo ≠ 0) and «fan» (CharParamThree ≠ 0). 0x007fc5f0 makes one record for the
//   row and one for each of its Combo rows (gateway SpellKitExtras.ts).
// - 0x007fa4d0 lays a record's segments out: the ends are [the unit, the targets in reverse packet order];
//   segment i runs from end i (end 0 with «fan») to end i + 1 and shows from now + SegDelay +
//   i · round(DelayBetweenEffects) for SegDuration milliseconds (all of the row's, per record). A persistent
//   record shows every segment for as long as the kit (0x007fae90 ignores the windows when +0x50 & 1).
// - 0x007fae90 places the ends every frame: the first unit at its MissileAttachment (through 0x00adaa20
//   unless SpellVisual.Flags 0x200) moved by MissileCastOffset (0x007faa40); every other unit at its
//   MissileDestinationAttachment moved by MissileImpactOffset (0x007fabf0); without the spell's visual (a kit
//   named by packet) the chest, and the first unit 0.75 of its height up. A point target is the point.
//
// Kept from before: an impact kit's beams run from the caster to its target (whose unit the kit plays on, and
// which targets it then names, was not read).

import type { SpellVisualBeamEnds, SpellVisualKit } from "../gateway/SpellVisual.js";
import type { VisualBeam, VisualBeamEnd } from "./ChainBeam.js";
import { ATTACH_CHEST, missileDestinationAttachment, visualOffset } from "./SpellVisualAttach.js";

export interface BeamPoint {
  x: number;
  y: number;
  z: number;
}

/** No attachment: the end stands 0.75 of the unit's height above its feet (0x007faa40, 0x007fabf0). */
export const BEAM_NO_ATTACHMENT = -1;

/** Where a visual's beams start and end on a unit (attachment ids already through 0x00adaa20). */
export interface BeamAnchors {
  readonly from: { readonly attachment: number; readonly offset?: readonly [number, number, number] };
  readonly to: { readonly attachment: number; readonly offset?: readonly [number, number, number] };
}

/** The anchors of a visual's beams; without the visual, Wow.exe's defaults. */
export function beamAnchors(ends: SpellVisualBeamEnds | undefined): BeamAnchors {
  if (!ends) return { from: { attachment: BEAM_NO_ATTACHMENT }, to: { attachment: ATTACH_CHEST } };
  const raw = ends.destRaw === true;
  const castOffset = visualOffset(ends.castOffset);
  const impactOffset = visualOffset(ends.impactOffset);
  return {
    from: {
      attachment: ends.attachment === -1 ? BEAM_NO_ATTACHMENT : missileDestinationAttachment(ends.attachment, raw),
      ...(castOffset ? { offset: castOffset } : {}),
    },
    to: { attachment: missileDestinationAttachment(ends.dest, raw), ...(impactOffset ? { offset: impactOffset } : {}) },
  };
}

/** One end of the hop list: a unit, a channel's object (read every frame) or a fixed point. */
export interface BeamTarget {
  readonly guid: bigint;
  readonly point?: BeamPoint;
  readonly channelOf?: bigint;
}

/**
 * The beams of `kit`, played on `unit` (at `unitPoint`) with `targets` in packet order, from `now`; a
 * persistent one lasts until `kitEndsAt`.
 */
export function planChainBeams(
  kit: SpellVisualKit | undefined,
  anchors: BeamAnchors,
  unit: bigint,
  unitPoint: BeamPoint,
  targets: readonly BeamTarget[],
  now: number,
  kitEndsAt: number,
): VisualBeam[] {
  const beams: VisualBeam[] = [];
  if (!kit?.chains || kit.chains.length === 0 || unit === 0n || targets.length === 0) return beams;
  const first: VisualBeam["from"] = {
    guid: unit, attachment: anchors.from.attachment, point: { ...unitPoint },
    ...(anchors.from.offset ? { offset: anchors.from.offset } : {}),
  };
  // 0x007fa4d0: the targets in reverse packet order.
  const ends = targets.slice().reverse().map((target): VisualBeamEnd => ({
    ...(target.channelOf !== undefined ? { channelOf: target.channelOf } : target.guid !== 0n ? { guid: target.guid } : {}),
    attachment: anchors.to.attachment,
    ...(target.point ? { point: { ...target.point } } : {}),
    ...(anchors.to.offset ? { offset: anchors.to.offset } : {}),
  }));
  for (const chain of kit.chains) {
    for (const row of [chain.effect, ...(chain.combos ?? [])]) {
      const finite = (value: number): number => (Number.isFinite(value) ? value : 0);
      let start = now + finite(row.segDelay);
      const between = Math.round(finite(row.delayBetweenEffects));
      const duration = finite(row.segDuration);
      for (let index = 0; index < ends.length; index++) {
        const to = ends[index]!;
        // A hop starts at the previous target (its MissileDestinationAttachment, 0x007fabf0); a channel's
        // object is the only end and a point ends the list.
        const previous: VisualBeamEnd | undefined = index === 0 || chain.fan ? undefined : ends[index - 1];
        const from: VisualBeam["from"] = previous === undefined ? first
          : { guid: previous.guid ?? 0n, attachment: previous.attachment, point: previous.point ?? { ...unitPoint },
            ...(previous.offset ? { offset: previous.offset } : {}) };
        const startedAt = chain.persistent ? now : start;
        const endsAt = chain.persistent ? kitEndsAt : start + duration;
        beams.push({ effect: row, from, to, startedAt, endsAt, ...(chain.persistent ? { persistent: true } : {}) });
        start += between;
      }
    }
  }
  return beams;
}
