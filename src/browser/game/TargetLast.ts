/*
 * TargetLastTarget, TargetLastEnemy, TargetLastFriend (WORK_PLAN 1.10, 3.11 TARGETLASTTARGET and
 * TARGETLASTHOSTILE; lane L2) over the world client's history (world/TargetHistory.ts), as Wow.exe
 * 3.3.5a (12340) runs them. Notes: .runtime/re-2026-10-04/l2-targeting/g1.c, g2.c.
 *
 * * TargetLastTarget (0xac8318 → 0x525d70): with a last target, select it — through 0x5259e0, which
 *   takes a unit only when the client knows it (in sight, or the player's group); the selection it
 *   replaces becomes the last target, so two presses swap back and forth. With none, the press is
 *   a clear that remembers what it drops (last target = selection, then let go), so the next press
 *   brings it back. Nothing selected and nothing remembered: nothing.
 * * TargetLastEnemy (0xac8320 → 0x525df0) and TargetLastFriend (0xac8328 → 0x525e50): select the
 *   remembered enemy or friend when the client knows it, through SetTarget 0x524bf0 — so it is
 *   judged afresh and the replaced selection becomes the last target. The argument
 *   `TargetLastEnemy(action)` of ChatFrame.lua:1220 is never read.
 *
 * This client selects only what is in sight (`WorldClient.selectTarget`): a party member out of
 * range, whom Wow.exe would select from party data, is not.
 */

/** What the three verbs read and call. */
export interface TargetLastWorld {
  readonly targetGuid: bigint | undefined;
  readonly targetHistory: {
    readonly lastTarget: bigint | undefined;
    readonly lastEnemy: bigint | undefined;
    readonly lastFriend: bigint | undefined;
  };
  readonly state: { readonly objects: ReadonlyMap<bigint, unknown> };
  selectTarget(guid: bigint | undefined): void;
}

export type TargetLastKind = "target" | "enemy" | "friend";

/** Selects `guid` when this client can (0x5259e0's "known" test, narrowed to "in sight"). */
function selectKnown(world: TargetLastWorld, guid: bigint | undefined): boolean {
  if (guid === undefined || !world.state.objects.has(guid)) return false;
  world.selectTarget(guid);
  return true;
}

/** One TargetLast* call. Answers whether the selection was asked to change. */
export function targetLast(world: TargetLastWorld, kind: TargetLastKind): boolean {
  const history = world.targetHistory;
  if (kind === "enemy") return selectKnown(world, history.lastEnemy);
  if (kind === "friend") return selectKnown(world, history.lastFriend);
  if (history.lastTarget !== undefined) return selectKnown(world, history.lastTarget);
  if (world.targetGuid === undefined) return false;
  // 0x525d70 with nothing remembered: the selection becomes the last target and is let go — the
  // world client's clear records it (TargetHistory.selected with no next unit).
  world.selectTarget(undefined);
  return true;
}
