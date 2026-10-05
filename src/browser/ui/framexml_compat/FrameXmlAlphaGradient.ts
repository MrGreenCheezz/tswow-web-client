/**
 * Plan item 3.21 (05.10): `FontString:SetAlphaGradient(start, length)` — the quest text that writes
 * itself in (QuestInfo.lua:3-16, :482-491: QUEST_DESCRIPTION_GRADIENT_LENGTH 30, CPS 70).
 *
 * Read from Wow.exe.clean 3.3.5a 12340 (read-only Ghidra, .runtime/re-2026-10-05/3.21; behaviour
 * described, no code copied):
 *
 * * The method (0x0048d0f0) wants two numbers (`lua_isnumber`), else it raises
 *   «Usage: <name>:SetAlphaGradient(start, length)». Both are truncated to integers (0x0088b9c0).
 *   It answers the number 1 or nil.
 * * The font string keeps the pair (0x00482230) and hands it to its text layout (0x004bd900 →
 *   0x006bd140 → 0x006c78f0); with no layout yet the answer is 1.
 * * The layout (0x006c78f0): a negative start or length answers "done" (nil) and changes nothing; the
 *   pair the layout already holds answers 1 and changes nothing (a new text resets it, 0x006c6b90).
 *   Otherwise every glyph quad (four vertices) before `start` takes the text's alpha `a`; from
 *   `start` the alpha drops by `c = round(a / length)` (round half to even) after every second vertex
 *   — so twice per glyph — never below 0; past `start + length` glyphs keep whatever the ramp reached
 *   (0 in practice, all of `a` for `length` 0). The answer is 1 while `start` is short of the glyph
 *   count, nil once it is not.
 *
 * Here a glyph is drawn at the mean of its two vertex pairs. Unsettled (named, not guessed into a
 * test): whether a space or a line break is a glyph quad of its own — this model counts neither, so
 * the typing speed per character is the client's only for text without spaces; the layout's empty
 * case (no vertex buffer → 1) is taken for empty text; the gradient is kept across `SetText` (the
 * font string's copy at +0x11c) — the stock caller always sets it again right after; the client's
 * early stop at an already-transparent vertex (0x006c6150), which can leave a stale tail on the same
 * text after `(0, 0)`, is not reproduced.
 */
import type { FrameXmlFrame } from "./FrameXmlTypes.js";
import { parseFrameXmlText, type FrameXmlTextRun } from "./FrameXmlText.js";

/** What one font string asked for: the last pair its layout accepted, and the text it was for. */
interface GradientState {
  start: number;
  length: number;
  /** The text the pair was last applied to; a new text resets the layout's copy (0x006c6b90). */
  text: string;
  /** Glyph count of `text`, measured once per text. */
  glyphs: number;
}

const gradients = new WeakMap<FrameXmlFrame, GradientState>();

/** The text's own alpha byte; the frame's alpha and colour are applied around the glyphs. */
const BASE_ALPHA = 255;

const WHITESPACE = /\s/u;

/** FPU rounding (round half to even), as 0x006c78f0 rounds `a / length`. */
function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const rest = value - floor;
  if (rest > 0.5) return floor + 1;
  if (rest < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** Glyphs a text draws: every visible character but whitespace (see the header). */
export function frameXmlGradientGlyphCount(text: string): number {
  let count = 0;
  for (const run of parseFrameXmlText(text)) {
    for (const character of run.text) if (!WHITESPACE.test(character)) count += 1;
  }
  return count;
}

/** One glyph's opacity (0..1) under the pair; `glyph` counts from 0. */
export function frameXmlGradientOpacity(glyph: number, start: number, length: number): number {
  if (glyph < start) return 1;
  const step = length === 0 ? 0 : roundHalfEven(BASE_ALPHA / length);
  const ramp = (steps: number): number => Math.max(0, BASE_ALPHA - steps * step);
  // Past the ramp a glyph keeps what the ramp reached at its end (0x006c78f0's third branch); with
  // c = round(255 / length) that end is 0, or 255 when c is 0, so the ramp itself already says it.
  const k = glyph - start;
  return (ramp(2 * k) + ramp(2 * k + 1)) / 2 / BASE_ALPHA;
}

/** Whether the pair draws any glyph below full alpha (otherwise the text is drawn as usual). */
function fades(state: GradientState): boolean {
  if (state.start >= state.glyphs || state.length === 0) return false;
  return frameXmlGradientOpacity(state.start, state.start, state.length) < 1;
}

/**
 * `SetAlphaGradient` on the font string `frame` showing `text`, with already-truncated integers.
 * Answers the method's Lua result (true for 1, false for nil) and whether the drawing changed.
 */
export function setFrameXmlAlphaGradient(frame: FrameXmlFrame, text: string, start: number, length: number):
  { readonly answer: boolean; readonly changed: boolean } {
  if (start < 0 || length < 0) return { answer: false, changed: false };
  let state = gradients.get(frame);
  if (state && state.text === text && state.start === start && state.length === length) {
    return { answer: true, changed: false };
  }
  const glyphs = state && state.text === text ? state.glyphs : frameXmlGradientGlyphCount(text);
  const before = state ? fades(state) : false;
  if (!state) {
    state = { start, length, text, glyphs };
    gradients.set(frame, state);
  } else {
    state.start = start;
    state.length = length;
    state.text = text;
    state.glyphs = glyphs;
  }
  const changed = before || fades(state);
  return { answer: glyphs === 0 || start < glyphs, changed };
}

/** The pair a font string draws with, if any; for tests and probes. */
export function frameXmlAlphaGradient(frame: FrameXmlFrame): { readonly start: number; readonly length: number } | undefined {
  const state = gradients.get(frame);
  return state ? { start: state.start, length: state.length } : undefined;
}

/** One drawn piece: consecutive characters of one colour and one opacity. */
export interface FrameXmlGradientSegment {
  readonly text: string;
  readonly color?: string | undefined;
  readonly opacity: number;
}

/** The runs of `text` split where the opacity changes; whitespace rides with the glyph before it. */
export function frameXmlGradientSegments(runs: readonly FrameXmlTextRun[], start: number, length: number):
  FrameXmlGradientSegment[] {
  const segments: FrameXmlGradientSegment[] = [];
  let glyph = 0;
  let opacity = 1;
  for (const run of runs) {
    let pending = "";
    let pendingOpacity = opacity;
    for (const character of run.text) {
      if (!WHITESPACE.test(character)) {
        opacity = frameXmlGradientOpacity(glyph, start, length);
        glyph += 1;
      }
      if (pending !== "" && opacity !== pendingOpacity) {
        segments.push({ text: pending, color: run.color, opacity: pendingOpacity });
        pending = "";
      }
      if (pending === "") pendingOpacity = opacity;
      pending += character;
    }
    if (pending !== "") segments.push({ text: pending, color: run.color, opacity: pendingOpacity });
  }
  return segments;
}

/** What each element was last drawn from, so a repaint with nothing new costs one comparison. */
interface Painted {
  text: string;
  start: number;
  length: number;
  glyphs: number;
}

const painted = new WeakMap<HTMLElement, Painted>();

/**
 * The renderer's hook: draw `frame`'s text through its gradient into `element`.
 *
 * "painted" — the gradient drew the text (the caller skips its own text path); "cleared" — a
 * gradient drawing was just taken off, so the caller must draw the text afresh; "none" — no
 * gradient is involved.
 */
export function paintFrameXmlAlphaGradient(element: HTMLElement, frame: FrameXmlFrame):
  "painted" | "cleared" | "none" {
  const state = gradients.get(frame);
  const last = painted.get(element);
  // The pair stays on the font string across SetText (see the header): a new text is drawn through
  // it too, measured here without touching what the method compares against.
  let active = false;
  if (state !== undefined) {
    if (state.text === frame.text) active = fades(state);
    else {
      const glyphs = last && last.text === frame.text ? last.glyphs : frameXmlGradientGlyphCount(frame.text);
      active = fades({ start: state.start, length: state.length, text: frame.text, glyphs });
    }
  }
  if (!active) {
    if (!last) return "none";
    painted.delete(element);
    element.textContent = "";
    while (element.children.length > 0) element.children[element.children.length - 1]?.remove();
    return "cleared";
  }
  if (!state) return "none";
  if (last && last.text === frame.text && last.start === state.start && last.length === state.length) return "painted";
  const glyphs = state.text === frame.text ? state.glyphs
    : last && last.text === frame.text ? last.glyphs : frameXmlGradientGlyphCount(frame.text);
  if (last) {
    last.text = frame.text;
    last.start = state.start;
    last.length = state.length;
    last.glyphs = glyphs;
  } else painted.set(element, { text: frame.text, start: state.start, length: state.length, glyphs });
  element.textContent = "";
  while (element.children.length > 0) element.children[element.children.length - 1]?.remove();
  const document = element.ownerDocument;
  for (const segment of frameXmlGradientSegments(parseFrameXmlText(frame.text), state.start, state.length)) {
    const span = document?.createElement("span");
    if (!span) {
      element.textContent += segment.text;
      continue;
    }
    span.setAttribute("data-framexml-gradient", "true");
    if (segment.color !== undefined) span.style.color = segment.color;
    if (segment.opacity < 1) span.style.opacity = String(Math.round(segment.opacity * 1000) / 1000);
    span.textContent = segment.text;
    element.append(span);
  }
  return "painted";
}
