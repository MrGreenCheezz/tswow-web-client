/**
 * Dungeon and raid difficulty and the instance question: `GetDungeonDifficulty`,
 * `GetRaidDifficulty`, `SetDungeonDifficulty`, `SetRaidDifficulty` and `IsInInstance`.
 *
 * Stock callers: UnitPopup.lua:309/:331 tick the difficulty rows by `GetDungeonDifficulty() == index`
 * and `GetRaidDifficulty() == index` (1-based), :700/:704 hide a row by `GetDungeonDifficulty() == 1`,
 * :1310-1315 send `SetDungeonDifficulty(n)`/`SetRaidDifficulty(n)` from the row's digit, and
 * :321/:344/:457/:1033 grey the rows by `IsInInstance()` and leadership. UIParent.lua:666 loads the
 * arena frames for "arena", WorldStateFrame.lua:359-386 decides the battlefield minimap by "pvp" and
 * "none" (see FrameXmlBattlefieldMinimap.ts), and WorldMapFrame, PartyMemberFrame and
 * Blizzard_ArenaUI read the type too.
 *
 * The original client (Wow.exe 3.3.5a build 12340, read-only Ghidra; Lua C functions found through
 * their registration entries in .data), described in this file's words:
 * * `IsInInstance` (0x5156a0) looks the current map up in Map.dbc: an unknown map answers nil and
 *   "none"; a known one answers 1 (not `true`) when its InstanceType is non-zero, nil when it is 0,
 *   and the type's word from {"none", "party", "raid", "pvp", "arena"}, "none" past the table.
 * * `GetDungeonDifficulty` (0x515790) answers two values, both 1-based: the group's difficulty while
 *   the player is in a group (the SMSG_GROUP_LIST word), the player's own otherwise; then the
 *   player's own. `GetRaidDifficulty` (0x515810) answers the player's own twice. (Both read one more
 *   client flag, at 0xbeb608, whose meaning was not settled here; it is taken as clear.)
 * * `SetDungeonDifficulty(n)` (0x526050) rounds n - 1 and accepts 0 and 1 only — normal and heroic;
 *   `SetRaidDifficulty(n)` (0x5261a0) accepts 0..3. In a group, a player who is not its leader gets
 *   ERR_NOT_LEADER as a chat line (error table entry 0x54, shown through the chat add at 0x509dd0) and
 *   nothing is sent. Otherwise MSG_SET_DUNGEON_DIFFICULTY / MSG_SET_RAID_DIFFICULTY goes out with the
 *   0-based word (`WorldClient.setDifficulty`). The client also sets its own value at once and prints
 *   ERR_DUNGEON_DIFFICULTY_CHANGED_S when it changed; here the value is the server's answer
 *   (`MsgSetDifficulty`, which TrinityCore sends back, MiscHandler.cpp:1307-1366).
 */
import { globalString } from "../../generated/globalStrings.js";
import { frameXmlLuaNumber, frameXmlRoundToInt } from "./FrameXmlPvpFlag.js";

/** Map.InstanceType's words, as IsInInstance answers them (0x5156a0's table). */
export const FRAMEXML_INSTANCE_TYPES: readonly string[] = Object.freeze(["none", "party", "raid", "pvp", "arena"]);
/** SetDungeonDifficulty accepts normal and heroic; SetRaidDifficulty the four raid modes. */
const DUNGEON_DIFFICULTIES = 2;
const RAID_DIFFICULTIES = 4;

export interface FrameXmlDifficultyWorld {
  readonly dungeonDifficulty?: number | undefined;
  readonly raidDifficulty?: number | undefined;
  readonly group?: {
    readonly leaderGuid: bigint;
    readonly dungeonDifficulty: number;
  } | undefined;
  readonly state: { readonly selfGuid?: bigint | undefined };
  setDifficulty?(difficulty: number, raid: boolean): void;
}

export interface FrameXmlDifficultyContext {
  world(): FrameXmlDifficultyWorld | undefined;
  /** Map.InstanceType of the current map; undefined when the map is not in the metadata. */
  instanceType?(): number | undefined;
  /** SMSG_BATTLEFIELD_STATUS says a running arena match (FrameXmlArena.ts). */
  inArena?(): boolean;
}

interface FrameXmlDifficultyPump {
  fire(event: string, ...args: readonly unknown[]): number;
}

/** A Lua difficulty number (1-based) as the client converts it: `round(n - 1)`, undefined when refused. */
export function frameXmlDifficultyWire(value: unknown, count: number): number | undefined {
  const number = frameXmlLuaNumber(value);
  if (number === undefined || !Number.isFinite(number)) return undefined;
  const wire = frameXmlRoundToInt(number - 1);
  return wire >= 0 && wire < count ? wire : undefined;
}

export class FrameXmlDifficultyModel {
  readonly #context: FrameXmlDifficultyContext;
  #pump: FrameXmlDifficultyPump | undefined;

  constructor(context: FrameXmlDifficultyContext) {
    this.#context = context;
  }

  attach(pump: FrameXmlDifficultyPump): void {
    this.#pump = pump;
  }

  detach(): void {
    this.#pump = undefined;
  }

  /** `GetDungeonDifficulty()`: the difficulty in force, then the player's own; both 1-based. */
  dungeon(): readonly [number, number] {
    const world = this.#context.world();
    const own = world?.dungeonDifficulty ?? 0;
    const inForce = world?.group !== undefined ? world.group.dungeonDifficulty : own;
    return [inForce + 1, own + 1];
  }

  /** `GetRaidDifficulty()`. */
  raid(): readonly [number, number] {
    const own = this.#context.world()?.raidDifficulty ?? 0;
    return [own + 1, own + 1];
  }

  /** `SetDungeonDifficulty(n)` / `SetRaidDifficulty(n)`. */
  set(value: unknown, raid: boolean): void {
    const wire = frameXmlDifficultyWire(value, raid ? RAID_DIFFICULTIES : DUNGEON_DIFFICULTIES);
    const world = this.#context.world();
    if (wire === undefined || !world) return;
    const group = world.group;
    if (group !== undefined && group.leaderGuid !== world.state.selfGuid) {
      const text = globalString("ERR_NOT_LEADER");
      if (text) this.#pump?.fire("CHAT_MSG_SYSTEM", text, "", "", "", "", "", 0, 0, "", 0, 0, "");
      return;
    }
    world.setDifficulty?.(wire, raid);
  }

  /** `IsInInstance()`: 1 or nil, and the type's word. */
  instance(): readonly [1 | undefined, string] {
    if (this.#context.inArena?.()) return [1, "arena"];
    const type = this.#context.instanceType?.();
    if (type === undefined) return [undefined, "none"];
    return [type !== 0 ? 1 : undefined, FRAMEXML_INSTANCE_TYPES[type] ?? "none"];
  }
}

/** The part of the world seam the bindings read. */
export interface FrameXmlDifficultyHost {
  readonly difficulty?: FrameXmlDifficultyModel | undefined;
  /** A seam without the model still answers «arena» from the arena model, as before this module. */
  readonly arena?: { inArena(): boolean } | undefined;
}

const NOTHING: readonly unknown[] = Object.freeze([]);
const NOT_IN_INSTANCE: readonly unknown[] = Object.freeze([undefined, "none"]);

export const FRAMEXML_DIFFICULTY_BINDINGS: Readonly<Record<string,
  (host: FrameXmlDifficultyHost, args: readonly unknown[]) => readonly unknown[]>> = Object.freeze({
  GetDungeonDifficulty: (host) => [...(host.difficulty?.dungeon() ?? [1, 1])],
  GetRaidDifficulty: (host) => [...(host.difficulty?.raid() ?? [1, 1])],
  SetDungeonDifficulty: (host, args) => {
    host.difficulty?.set(args[0], false);
    return NOTHING;
  },
  SetRaidDifficulty: (host, args) => {
    host.difficulty?.set(args[0], true);
    return NOTHING;
  },
  IsInInstance: (host) => {
    if (host.difficulty) return [...host.difficulty.instance()];
    return host.arena?.inArena() ? [1, "arena"] : NOT_IN_INSTANCE;
  },
});
