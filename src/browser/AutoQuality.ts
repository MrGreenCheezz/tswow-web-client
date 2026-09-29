import { game } from "./game/Context.js";
import { settingNumber, settingBoolean } from "./ui/SettingsModel.js";
import { settings } from "./ui/Settings.js";

/**
 * Automatic render-scale governor, driven by the immutable full-frame telemetry.
 *
 * The stored `renderScale` stays the ceiling and is never rewritten: this only ever lowers
 * the *effective* scale the renderer is told, and only under sustained pressure. Two
 * consecutive bad 5-second windows (p95 above 26 ms) step down the ladder; twelve good ones
 * (a minute under 14 ms) step back up, never above the ceiling. Toggling the setting or
 * changing the manual scale re-asserts the ceiling immediately.
 *
 * DOM-free: the ladder decisions are pure given a snapshot, so the policy is testable without
 * a page. Only the renderer call touches the live client.
 */

export interface FrameP95 {
  readonly average: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly count: number;
}

/** Where the governor may sit. The floor matches the manual slider's own minimum. */
export const AUTO_QUALITY_LADDER = [100, 85, 70, 55, 40] as const;
const CHECK_INTERVAL_MS = 5_000;
const DOWN_P95_MS = 26;
const DOWN_WINDOWS = 2;
const UP_P95_MS = 14;
const UP_WINDOWS = 12;
const MIN_FRAMES = 60;

let ceiling = 100;
let level = 100;
let downStreak = 0;
let upStreak = 0;
let lastCheck = 0;
let applied = -1;

function readSettings(): { enabled: boolean; user: number } {
  const values = settings();
  return { enabled: settingBoolean(values, "autoQuality"), user: settingNumber(values, "renderScale") };
}

function ladderBelow(value: number): number {
  let best = AUTO_QUALITY_LADDER[AUTO_QUALITY_LADDER.length - 1]!;
  for (const rung of AUTO_QUALITY_LADDER) {
    if (rung < value && rung > best) best = rung;
  }
  return best;
}

function ladderAbove(value: number, top: number): number {
  let best = value;
  for (const rung of AUTO_QUALITY_LADDER) {
    if (rung > value && rung <= top && (best === value || rung < best)) best = rung;
  }
  return best;
}

/** The manual scale changed (or settings were applied): it is the ceiling again. */
export function setAutoQualityCeiling(userScale: number): void {
  ceiling = Math.max(40, Math.min(100, Math.floor(userScale)));
  downStreak = 0;
  upStreak = 0;
  applyLevel(Math.min(level, ceiling), true);
}

function applyLevel(next: number, force = false): void {
  level = next;
  const effective = Math.min(level, ceiling);
  if (!force && effective === applied) return;
  applied = effective;
  game.renderer?.setRenderScale(effective / 100);
}

/** What the governor is doing now, for the settings window and diagnostics. */
export function autoQualityStatus(): { enabled: boolean; ceiling: number; effective: number } {
  let enabled = true;
  try {
    enabled = readSettings().enabled;
  } catch {
    // Settings store unavailable (tests): report the governor state as-is.
  }
  return { enabled, ceiling, effective: Math.min(level, ceiling) };
}

/**
 * Whether a sample is due. The snapshot copies and sorts the frame ring, so the loop asks
 * this first and only builds one when the governor would actually read it.
 */
export function autoQualityDue(now: number): boolean {
  return now - lastCheck >= CHECK_INTERVAL_MS;
}

/**
 * One tick; the snapshot is read at most every five seconds (see {@link autoQualityDue}).
 *
 * `sample` must return the full-frame clock snapshot. Windows with too few frames (loading,
 * benchmark lease) are skipped without resetting the streaks: absence of data is not health.
 */
export function updateAutoQuality(now: number, sample: () => FrameP95): void {
  if (!autoQualityDue(now)) return;
  lastCheck = now;
  // A hidden tab's rAF is throttled into meaninglessness, and formal benchmark frames run
  // under the exclusive lease that freezes this whole loop — either way there is nothing
  // to govern, and the streaks are left alone rather than fed lies.
  if (typeof document !== "undefined" && document.hidden) return;
  let enabled = true;
  let user = Number.NaN;
  try {
    const read = readSettings();
    enabled = read.enabled;
    user = read.user;
  } catch {
    // Settings store unavailable (tests): keep the last ceiling.
  }
  if (!enabled) {
    downStreak = 0;
    upStreak = 0;
    applyLevel(ceiling, true);
    return;
  }
  // The ceiling follows the manual slider live: raising it must take effect at once, and a
  // stored value that arrived late must not pin an older, lower one.
  if (Number.isFinite(user)) {
    const clamped = Math.max(40, Math.min(100, Math.floor(user)));
    if (clamped !== ceiling) {
      ceiling = clamped;
      downStreak = 0;
      upStreak = 0;
    }
  }
  const snapshot = sample();
  if (snapshot.count < MIN_FRAMES || !(snapshot.p95 > 0)) return;
  if (snapshot.p95 > DOWN_P95_MS) {
    downStreak++;
    upStreak = 0;
    if (downStreak >= DOWN_WINDOWS) {
      downStreak = 0;
      upStreak = 0;
      applyLevel(ladderBelow(Math.min(level, ceiling)));
    }
    return;
  }
  if (snapshot.p95 < UP_P95_MS) {
    upStreak++;
    downStreak = 0;
    if (upStreak >= UP_WINDOWS) {
      downStreak = 0;
      upStreak = 0;
      applyLevel(ladderAbove(Math.min(level, ceiling), ceiling));
    }
    return;
  }
  downStreak = 0;
  upStreak = 0;
}

/** Forgets everything a session taught the governor; worlds do not share performance. */
export function resetAutoQuality(): void {
  ceiling = 100;
  level = 100;
  downStreak = 0;
  upStreak = 0;
  lastCheck = 0;
  applied = -1;
}
