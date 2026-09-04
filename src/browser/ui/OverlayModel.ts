/**
 * Speech bubbles and floating combat numbers, as arithmetic.
 *
 * The part that has to run on every frame — where a bubble sits, how long it stays, which lane a
 * number rises in so two hits in one millisecond are both readable — is decided here, with no DOM
 * anywhere near it. `HeadOverlay.ts` does nothing but project a point and write a transform.
 */

export interface Bubble {
  readonly guid: bigint;
  readonly text: string;
  readonly bornAt: number;
  readonly expiresAt: number;
}

/**
 * `damage` and `taken` are the same arithmetic and different colours: a number the player dealt
 * and a number the player took read identically otherwise, which is the one distinction that has
 * to survive a glance mid-fight.
 */
export type FloaterKind = "damage" | "taken" | "heal" | "power" | "miss";

export interface Floater {
  readonly guid: bigint;
  readonly text: string;
  readonly kind: FloaterKind;
  readonly critical: boolean;
  readonly bornAt: number;
  readonly expiresAt: number;
  /** Which of the sideways slots this number takes, so simultaneous hits do not stack. */
  readonly lane: number;
}

/** A bubble stays roughly as long as it takes to read, within a floor and a ceiling. */
export const BUBBLE_MS_PER_CHAR = 90;
export const BUBBLE_MIN_MS = 2_500;
export const BUBBLE_MAX_MS = 9_000;
/** Longer than this and a bubble is a wall of text over someone's head; the chat log has it all. */
export const BUBBLE_MAX_CHARS = 180;

export const FLOATER_LIFE_MS = 1_400;
export const FLOATER_RISE_PX = 54;
export const FLOATER_LANES = 5;
export const FLOATER_LANE_PX = 26;
/** How much of a number's life passes before it starts to fade. */
export const FLOATER_FADE_FROM = 0.66;

/** Only combat state the player is actively responsible for belongs over the 3D world. */
export function floatingCombatTextRelevant(
  guid: bigint, selfGuid: bigint | undefined, targetGuid: bigint | undefined,
): boolean {
  return guid !== 0n && selfGuid !== undefined && (guid === selfGuid || guid === targetGuid);
}

/** Drops numbers whose unit stopped being the player or current target while they were rising. */
export function removeIrrelevantFloaters(
  list: Floater[], selfGuid: bigint | undefined, targetGuid: bigint | undefined,
): void {
  for (let index = list.length - 1; index >= 0; index--) {
    if (!floatingCombatTextRelevant(list[index]!.guid, selfGuid, targetGuid)) list.splice(index, 1);
  }
}

export function bubbleLifetime(text: string): number {
  return Math.min(BUBBLE_MAX_MS, Math.max(BUBBLE_MIN_MS, text.length * BUBBLE_MS_PER_CHAR));
}

/**
 * One bubble per unit, replaced rather than queued.
 *
 * A unit that says three things in a second has one bubble showing the last of them, which is what
 * the original client does. Stacking them would put a column of speech over a head and hide the
 * unit under its own words.
 */
export function putBubble(list: Bubble[], guid: bigint, text: string, now: number): void {
  const trimmed = text.length > BUBBLE_MAX_CHARS ? `${text.slice(0, BUBBLE_MAX_CHARS - 1)}…` : text;
  const bubble: Bubble = { guid, text: trimmed, bornAt: now, expiresAt: now + bubbleLifetime(trimmed) };
  const at = list.findIndex((entry) => entry.guid === guid);
  if (at >= 0) list[at] = bubble;
  else list.push(bubble);
}

/**
 * A free lane for a new number over this unit, or the least crowded one.
 *
 * Lanes are per unit: two units hit at the same moment both start in lane zero, because they are
 * nowhere near each other on screen.
 */
function freeLane(list: readonly Floater[], guid: bigint, now: number): number {
  const taken = new Set<number>();
  for (const floater of list) {
    if (floater.guid !== guid) continue;
    // A lane is only busy while its number is still near the head; after that it can be reused.
    if (now - floater.bornAt < FLOATER_LIFE_MS / 2) taken.add(floater.lane);
  }
  for (let lane = 0; lane < FLOATER_LANES; lane++) if (!taken.has(lane)) return lane;
  return taken.size % FLOATER_LANES;
}

export function addFloater(
  list: Floater[],
  floater: { guid: bigint; text: string; kind: FloaterKind; critical: boolean },
  now: number,
): void {
  list.push({
    ...floater,
    bornAt: now,
    expiresAt: now + FLOATER_LIFE_MS,
    lane: freeLane(list, floater.guid, now),
  });
}

/** Drops what has run out. Both lists are short, so this is a filter and not an index dance. */
export function expire<T extends { expiresAt: number }>(list: T[], now: number): void {
  for (let index = list.length - 1; index >= 0; index--) {
    if ((list[index] as T).expiresAt <= now) list.splice(index, 1);
  }
}

/**
 * Where a number is relative to the head it started over, and how visible it still is.
 *
 * It rises the whole way and fades over the last third: fading from the start makes a small hit
 * unreadable, and not fading at all makes the number vanish mid-air.
 */
export function floaterOffset(floater: Floater, now: number): { dx: number; dy: number; opacity: number } {
  const progress = Math.min(1, Math.max(0, (now - floater.bornAt) / FLOATER_LIFE_MS));
  const lane = floater.lane - (FLOATER_LANES - 1) / 2;
  // The divisor is written as `1 - FLOATER_FADE_FROM` rather than as its value, so the fade
  // reaches exactly zero at the end of the life instead of a last invisible sliver of a percent.
  const fade = (progress - FLOATER_FADE_FROM) / (1 - FLOATER_FADE_FROM);
  return {
    dx: lane * FLOATER_LANE_PX,
    dy: -FLOATER_RISE_PX * progress,
    opacity: progress <= FLOATER_FADE_FROM ? 1 : Math.max(0, 1 - fade),
  };
}

/** What a number reads as: damage comes off, a heal goes on, a miss is a word. */
export function floatingAmountText(
  kind: FloaterKind, amount: number, text?: string | undefined,
): string {
  if (kind === "miss") return text && text.length > 0 ? text : "промах";
  if (amount === 0) return text && text.length > 0 ? text : "0";
  return kind === "damage" || kind === "taken" ? `-${amount}` : `+${amount}`;
}
