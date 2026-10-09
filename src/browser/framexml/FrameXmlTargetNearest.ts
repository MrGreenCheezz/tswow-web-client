/**
 * `TargetNearest*` and `TargetLast*` for the stock UI (WORK_PLAN 1.10, lane L2).
 *
 * Callers in the 3.3.5 corpus: the secure slash commands /targetenemy, /targetenemyplayer,
 * /targetfriend, /targetfriendplayer, /targetparty, /targetraid, /targetlasttarget,
 * /targetlastenemy, /targetlastfriend (ChatFrame.lua:1163-1229 — each passes `action`, the text left
 * after the macro options, as the one argument), and the TARGETING bodies of Bindings.xml
 * (`TargetNearestEnemy(1)` for the PREVIOUS keys), which this client runs as native actions
 * (FrameXmlBinding.ts) rather than through these functions.
 *
 * Wow.exe 3.3.5a (12340), registration table 0xac82c8–0xac8328: the seven TargetNearest* read their
 * one argument as a Lua boolean (0x815500, `luaFlagArgument`) — `reverse` — and step the Tab list
 * in their mode (game/TargetNearestModes.ts); the three TargetLast* take no argument
 * (game/TargetLast.ts). All of them return nothing. `TargetDirectionEnemy/Friend(facing[, cone])`
 * and `TargetDirectionFinished` (0x525c30, 0x525cd0, 0x515560) are registered too; no stock Lua
 * calls them and they are not here.
 */
import {
  NEAREST_ANY, NEAREST_ENEMY, NEAREST_ENEMY_PLAYER, NEAREST_FRIEND, NEAREST_FRIEND_PLAYER, NEAREST_PARTY_MEMBER,
  NEAREST_RAID_MEMBER, luaFlagArgument, type NearestMode,
} from "../game/TargetNearestModes.js";
import type { TargetLastKind } from "../game/TargetLast.js";

/** What the bindings call: the browser game's Tab list and the world client's history. */
export interface FrameXmlTargetNearest {
  nearest(mode: NearestMode, reverse: boolean): void;
  last(kind: TargetLastKind): void;
}

/** The part of the world seam the bindings read. */
export interface FrameXmlTargetNearestHost {
  readonly targetNearest?: FrameXmlTargetNearest | undefined;
}

const NOTHING: readonly unknown[] = Object.freeze([]);

function nearest(mode: NearestMode) {
  return (host: FrameXmlTargetNearestHost, args: readonly unknown[]): readonly unknown[] => {
    host.targetNearest?.nearest(mode, luaFlagArgument(args[0]));
    return NOTHING;
  };
}

function last(kind: TargetLastKind) {
  return (host: FrameXmlTargetNearestHost): readonly unknown[] => {
    host.targetNearest?.last(kind);
    return NOTHING;
  };
}

export const FRAMEXML_TARGET_NEAREST_BINDINGS: Readonly<Record<string,
  (host: FrameXmlTargetNearestHost, args: readonly unknown[]) => readonly unknown[]>> = Object.freeze({
  TargetNearest: nearest(NEAREST_ANY),
  TargetNearestEnemy: nearest(NEAREST_ENEMY),
  TargetNearestEnemyPlayer: nearest(NEAREST_ENEMY_PLAYER),
  TargetNearestFriend: nearest(NEAREST_FRIEND),
  TargetNearestFriendPlayer: nearest(NEAREST_FRIEND_PLAYER),
  TargetNearestPartyMember: nearest(NEAREST_PARTY_MEMBER),
  TargetNearestRaidMember: nearest(NEAREST_RAID_MEMBER),
  TargetLastTarget: last("target"),
  TargetLastEnemy: last("enemy"),
  TargetLastFriend: last("friend"),
});
