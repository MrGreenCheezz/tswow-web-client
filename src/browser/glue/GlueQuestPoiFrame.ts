/**
 * Plan item 3.13c: the `QuestPOIFrame` widget's methods (WorldMapFrame.xml's WorldMapBlobFrame), as Wow.exe
 * 3.3.5a 12340 answers them (the method table at 0xacf180; read 2026-10-02; descriptions only).
 *
 * - `SetFillTexture`, `SetBorderTexture`, `SetFillAlpha` (0..255), `SetBorderAlpha`, `SetBorderScalar`,
 *   `EnableSmoothing`, `EnableMerging`, `SetMergeThreshold`, `SetNumSplinePoints`: the drawing style;
 *   the constructor's defaults (0x58ff50) are both alphas 255, border scalar 1, merge threshold 0.25,
 *   smoothing and merging on, 20 spline points. `UpdateQuestPOI` changes nothing visible.
 * - `DrawQuestBlob(questId, draw)` (0x5905f0): `draw` false takes the quest's blobs off (0x58fb40);
 *   true adds them to one of four slots unless already drawn or all four are taken (0x590560).
 * - `UpdateMouseOverTooltip(x, y)` (0x58e9c0 → 0x58e0d0): x, y across the frame (0..1, y down); the first
 *   drawn quest whose objectives are not all met with a blob under the point answers its quest-log row
 *   and how many objectives the blob stands for; nothing otherwise. `GetNumTooltips()` (0x58eac0) is that
 *   count, `GetTooltipIndex(i)` (0x58ea50) the i-th objective's POI index (1..4, else 0).
 *
 * 3.13e (L6): `DrawQuestBlob(questId, true)` builds the quest's blobs once, as the client does (0x590560 →
 * 0x5900f0): the smoothed outline in the frame's style and the merging of overlapping blobs (0x58e310,
 * FrameXmlQuestPoiOutline.ts); the hit test and the painter use that build, so the tooltip answers a
 * merged blob's objectives and tests the outline that is painted. The hit test (0x58e0d0) takes, in the
 * first slot with a hit, the last blob under the point; it allocates nothing per call.
 * The blobs themselves are painted by the host (FrameXmlQuestBlobPainter.ts) through `paint`.
 */

import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";
import type { WidgetMethod } from "./GlueWidgets.js";
import { questPoiHitTest, QUEST_POI_MAX_OBJECTIVES } from "../framexml/FrameXmlQuestPoiOutline.js"; // 3.13e (L6)

export interface QuestPoiFramePoint {
  readonly u: number;
  readonly v: number;
}

export interface QuestPoiFrameShape {
  readonly objectiveIndex: number;
  readonly points: readonly QuestPoiFramePoint[];
  /** 3.13e (L6): its objective and those merged into it; absent: just `objectiveIndex`. */
  readonly objectives?: readonly number[];
}

/** 3.13e (L6): one drawn quest as `DrawQuestBlob` built it. */
export interface QuestPoiFrameDrawn {
  readonly mask: number;
  readonly shapes: readonly QuestPoiFrameShape[];
}

/** How the frame draws its blobs: the style its setters keep. */
export interface QuestPoiFrameStyle {
  fillTexture: string | undefined;
  borderTexture: string | undefined;
  fillAlpha: number;
  borderAlpha: number;
  borderScalar: number;
  smoothing: boolean;
  merging: boolean;
  mergeThreshold: number;
  splinePoints: number;
}

/** What the world gives the frame: the blobs of a quest on the displayed map, and the painter. */
export interface QuestPoiFrameAdapter {
  /**
   * The quest's objective mask (-1 once met) and its blobs on the displayed map; undefined without the
   * quest. 3.13e (L6): built in the frame's `style` (smoothing, merging).
   */
  shapes(questId: number, style?: Readonly<QuestPoiFrameStyle>): QuestPoiFrameDrawn | undefined;
  /** The quest's displayed quest-log row; 0 when it is not in the log. */
  logIndex(questId: number): number;
  /** Paint the drawn quests' blobs into the frame; 3.13e (L6): `drawn` is each quest's build, in order. */
  paint?(frame: FrameXmlFrame, quests: readonly number[], style: Readonly<QuestPoiFrameStyle>,
    drawn?: readonly (QuestPoiFrameDrawn | undefined)[]): void;
}

let adapter: QuestPoiFrameAdapter | undefined;

/** The world mount's adapter (FrameXmlQuestBlobPainter.ts); undefined on the glue screens. */
export function setQuestPoiFrameAdapter(next: QuestPoiFrameAdapter | undefined): () => void {
  adapter = next;
  return () => { if (adapter === next) adapter = undefined; };
}

interface QuestPoiFrameState {
  readonly style: QuestPoiFrameStyle;
  /** The four slots' quest ids, 0 for a free slot. */
  readonly slots: number[];
  tooltipQuest: number;
  /** 3.13e (L6): the tooltip's four objective slots (0x2c0) and how many the hit answered (0x2bc). */
  readonly tooltips: number[];
  tooltipCount: number;
  /** 3.13e (L6): each slot's build, its shapes' objective lists filled in; undefined for a free slot. */
  readonly drawn: (QuestPoiFrameBuilt | undefined)[];
  /** 3.13e (L6): UpdateMouseOverTooltip's two values, reused so the per-frame call allocates nothing. */
  readonly answer: [number, number];
  /**
   * 3.13e (L6): each slot's quest-log row, taken with the build: the map redraws its blobs on every
   * QUEST_LOG_UPDATE (WorldMapFrame.lua:199), so the row cannot go stale under the hit test.
   */
  readonly logIndices: number[];
}

/** 3.13e (L6): a slot's build with every shape's objective list present. */
interface QuestPoiFrameBuilt extends QuestPoiFrameDrawn {
  readonly shapes: readonly (QuestPoiFrameShape & { readonly objectives: readonly number[] })[];
}

const MAX_SLOTS = 4;
const MAX_TOOLTIPS = QUEST_POI_MAX_OBJECTIVES;
const NO_ANSWER: readonly unknown[] = Object.freeze([]);

/** 3.13e (L6): take a quest's build for a slot (0x590560 builds it at once). */
function built(drawn: QuestPoiFrameDrawn | undefined): QuestPoiFrameBuilt | undefined {
  return drawn && {
    mask: drawn.mask,
    shapes: drawn.shapes.map((shape) => ({ ...shape, objectives: shape.objectives ?? [shape.objectiveIndex] })),
  };
}

function number(value: unknown, fallback = 0): number {
  const result = typeof value === "number" ? value : Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function truthy(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false;
}

export function questPoiFrameMethods(): Record<string, WidgetMethod> {
  const states = new WeakMap<FrameXmlFrame, QuestPoiFrameState>();
  const state = (frame: FrameXmlFrame): QuestPoiFrameState => {
    let current = states.get(frame);
    if (!current) {
      current = {
        style: {
          fillTexture: undefined, borderTexture: undefined, fillAlpha: 255, borderAlpha: 255, borderScalar: 1,
          smoothing: true, merging: true, mergeThreshold: 0.25, splinePoints: 20,
        },
        slots: [0, 0, 0, 0], tooltipQuest: 0, tooltips: [0, 0, 0, 0], tooltipCount: 0,
        drawn: [undefined, undefined, undefined, undefined], answer: [0, 0], logIndices: [0, 0, 0, 0],
      };
      states.set(frame, current);
    }
    return current;
  };
  const repaint = (frame: FrameXmlFrame): void => {
    const current = state(frame);
    const quests: number[] = [];
    const drawn: (QuestPoiFrameDrawn | undefined)[] = [];
    current.slots.forEach((questId, slot) => {
      if (questId <= 0) return;
      quests.push(questId);
      drawn.push(current.drawn[slot]);
    });
    adapter?.paint?.(frame, quests, current.style, drawn);
  };
  const styled = (apply: (style: QuestPoiFrameStyle, args: readonly unknown[]) => void): WidgetMethod => ({ frame, args }) => {
    apply(state(frame).style, args);
    repaint(frame);
  };
  const alpha = (value: unknown): number => Math.max(0, Math.min(255, Math.trunc(number(value, 255))));
  return {
    SetFillTexture: styled((style, args) => { style.fillTexture = typeof args[0] === "string" ? args[0] : undefined; }),
    SetBorderTexture: styled((style, args) => { style.borderTexture = typeof args[0] === "string" ? args[0] : undefined; }),
    SetFillAlpha: styled((style, args) => { style.fillAlpha = alpha(args[0]); }),
    SetBorderAlpha: styled((style, args) => { style.borderAlpha = alpha(args[0]); }),
    SetBorderScalar: styled((style, args) => { style.borderScalar = number(args[0], 1); }),
    EnableSmoothing: styled((style, args) => { style.smoothing = truthy(args[0]); }),
    EnableMerging: styled((style, args) => { style.merging = truthy(args[0]); }),
    SetMergeThreshold: styled((style, args) => { style.mergeThreshold = number(args[0], 0.25); }),
    SetNumSplinePoints: styled((style, args) => { style.splinePoints = Math.max(0, Math.trunc(number(args[0], 20))); }),
    UpdateQuestPOI: () => {},
    DrawQuestBlob: ({ frame, args }) => {
      const questId = Math.trunc(number(args[0]));
      const current = state(frame);
      if (questId === 0) return;
      if (!truthy(args[1])) {
        const slot = current.slots.indexOf(questId);
        if (slot < 0) return;
        current.slots[slot] = 0;
        current.drawn[slot] = undefined; // 3.13e (L6)
      } else {
        if (current.slots.includes(questId)) return;
        const free = current.slots.indexOf(0);
        if (free < 0 || free >= MAX_SLOTS) return;
        current.slots[free] = questId;
        // 3.13e (L6): built once here, in the frame's style, as 0x590560 → 0x5900f0 does.
        current.drawn[free] = built(adapter?.shapes(questId, current.style));
        current.logIndices[free] = adapter?.logIndex(questId) ?? 0;
      }
      repaint(frame);
    },
    // 3.13e (L6): 0x58e0d0 over the slots' builds; no allocation per call (WorldMapBlobFrame_OnUpdate).
    UpdateMouseOverTooltip: ({ frame, args }) => {
      const current = state(frame);
      current.tooltipQuest = 0;
      current.tooltipCount = 0;
      current.tooltips.fill(0);
      const u = number(args[0], -1);
      const v = number(args[1], -1);
      if (u < 0 || v < 0 || u > 1 || v > 1 || !adapter) return NO_ANSWER;
      for (let slot = 0; slot < MAX_SLOTS; slot++) {
        const questId = current.slots[slot]!;
        const drawn = current.drawn[slot];
        if (questId <= 0 || !drawn || drawn.mask === -1) continue;
        const count = questPoiHitTest(drawn.shapes, u, v, current.tooltips);
        if (count === 0) continue;
        current.tooltipQuest = questId;
        current.tooltipCount = count;
        current.answer[0] = current.logIndices[slot]!;
        current.answer[1] = count;
        return current.answer;
      }
      return NO_ANSWER;
    },
    GetNumTooltips: ({ frame }) => [state(frame).tooltipCount],
    GetTooltipIndex: ({ frame, args }) => {
      const index = Math.trunc(number(args[0])) - 1;
      const tooltips = state(frame).tooltips;
      return [index >= 0 && index < MAX_TOOLTIPS ? tooltips[index] ?? 0 : 0];
    },
  };
}
