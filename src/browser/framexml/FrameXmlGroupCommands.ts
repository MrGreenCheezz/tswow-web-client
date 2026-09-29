/**
 * The group commands the stock unit menus, SecureTemplates and the raid slash commands call, over
 * the packets `WorldClient` already sends.
 *
 * Callers in the 3.3.5 corpus, and what each passes:
 *
 * * UnitPopup.lua:1331-1350 (UnitPopup_OnClick): `PromoteToAssistant(fullname, 1)`,
 *   `DemoteAssistant(fullname, 1)` for an officer, `GetPartyAssignment("MAINTANK"|"MAINASSIST",
 *   fullname, 1)` then `ClearPartyAssignment(…)` (RAID_DEMOTE), `SetPartyAssignment("MAINTANK"|
 *   "MAINASSIST", fullname, 1)` and `ReportPlayerIsPVPAFK(fullname)`; :740-758 read
 *   `GetPartyAssignment(role, dropdownMenu.name, 1)` to decide the rows. `fullname` is
 *   `name-server` for a player of another realm (:1172-1174); the trailing `1` is «exact match».
 * * SecureTemplates.lua:430-452 (`maintank`/`mainassist` actions): the same three by *unit token*,
 *   the assignment in lower case.
 * * ChatFrame.lua:1265-1326 (`/maintank`, `/clearmaintank`, …): a token or a name, and
 *   `ClearPartyAssignment("MAINTANK")` with nobody named — the holder loses it.
 * * WorldStateFrame.lua:941-951: the scoreboard row's name, offered only for `UnitInRaid(name)`.
 *
 * The server (TrinityCore GroupHandler.cpp): CMSG_GROUP_ASSISTANT_LEADER (`guid`, `bool apply`) is
 * the leader's (:633); MSG_PARTY_ASSIGNMENT (`u8 assignment`, `bool apply`, `guid`, :652) the leader's
 * or an assistant's, clears the flag from everybody first (`RemoveUniqueGroupMemberFlag`) and answers
 * with a group list, not an echo. CMSG_REPORT_PVP_AFK (BattleGroundHandler.cpp:813) takes a guid.
 * `GROUP_ASSIGN_MAINTANK = 0`, `GROUP_ASSIGN_MAINASSIST = 1`, member flags ASSISTANT 0x01,
 * MAINTANK 0x02, MAINASSIST 0x04 (Group.h:74-82). SMSG_GROUP_LIST never lists its receiver: the
 * player's own flags are the header's `ownFlags`.
 *
 * Who is meant: a unit token through the seam's own resolution (party, raid, target…), else a name
 * among the group's members and the player, case aside, retried without a `-Realm` suffix. Only a
 * member of the player's group (the player included) is ever sent: the server drops anybody else
 * without a word, so an unknown name sends nothing.
 */
import { GROUP_ASSIGN_MAINASSIST, GROUP_ASSIGN_MAINTANK } from "../../world/PartyProtocol.js";
import { MEMBER_FLAG_MAINASSIST, MEMBER_FLAG_MAINTANK, type GroupState } from "../../world/GroupProtocol.js";

/** The part of `WorldClient` the commands read and send through. */
export interface FrameXmlGroupCommandWorld {
  readonly group?: Pick<GroupState, "members" | "ownFlags"> | undefined;
  readonly state: { readonly selfGuid?: bigint | undefined };
  readonly selfName?: string | undefined;
  setPartyAssistant?(guid: bigint, apply: boolean): void;
  assignPartyRole?(assignment: number, apply: boolean, guid: bigint): void;
  reportPvpAfk?(guid: bigint): void;
}

export interface FrameXmlGroupCommandsContext {
  world(): FrameXmlGroupCommandWorld | undefined;
  /** A unit token (lower case) to its guid, as the seam resolves every other unit question. */
  unitGuid(unit: string): bigint | undefined;
}

/** The two stock assignment names, case aside, to the core's numbers; undefined for any other. */
export function frameXmlGroupAssignment(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const upper = value.toUpperCase();
  return upper === "MAINTANK" ? GROUP_ASSIGN_MAINTANK : upper === "MAINASSIST" ? GROUP_ASSIGN_MAINASSIST : undefined;
}

function assignmentFlag(assignment: number): number {
  return assignment === GROUP_ASSIGN_MAINTANK ? MEMBER_FLAG_MAINTANK : MEMBER_FLAG_MAINASSIST;
}

export class FrameXmlGroupCommandsModel {
  readonly #context: FrameXmlGroupCommandsContext;

  constructor(context: FrameXmlGroupCommandsContext) {
    this.#context = context;
  }

  /** A member of the player's group (the player included) named by token or name; else undefined. */
  memberGuid(who: string): bigint | undefined {
    const world = this.#context.world();
    const group = world?.group;
    const typed = who.trim();
    if (!world || !group || typed.length === 0) return undefined;
    const self = world.state.selfGuid;
    const inGroup = (guid: bigint | undefined): guid is bigint => guid !== undefined && guid !== 0n
      && (guid === self || group.members.some((member) => member.guid === guid));
    const byToken = this.#context.unitGuid(typed.toLowerCase());
    if (byToken !== undefined) return inGroup(byToken) ? byToken : undefined;
    const byName = (name: string): bigint | undefined => {
      const wanted = name.toLowerCase();
      const member = group.members.find((candidate) => candidate.name.toLowerCase() === wanted);
      if (member) return member.guid;
      return world.selfName !== undefined && world.selfName.toLowerCase() === wanted ? self : undefined;
    };
    const dash = typed.indexOf("-");
    const guid = byName(typed) ?? (dash > 0 ? byName(typed.slice(0, dash)) : undefined);
    return inGroup(guid) ? guid : undefined;
  }

  /** `PromoteToAssistant`/`DemoteAssistant`: CMSG_GROUP_ASSISTANT_LEADER. */
  setAssistant(who: string, apply: boolean): void {
    const guid = this.memberGuid(who);
    if (guid !== undefined) this.#context.world()?.setPartyAssistant?.(guid, apply);
  }

  /**
   * `SetPartyAssignment`/`ClearPartyAssignment`: MSG_PARTY_ASSIGNMENT. A clear with nobody named
   * takes the flag from whoever holds it; a clear goes out only for the member who holds the role,
   * because the core takes the flag from everybody before it applies the packet's guid
   * (GroupHandler.cpp:670-679) and /maintankoff, /mainassistoff and SecureTemplates' `clear` call
   * this unchecked.
   */
  assign(assignment: number, who: string | undefined, apply: boolean): void {
    const guid = who === undefined ? (apply ? undefined : this.#holder(assignment)) : this.memberGuid(who);
    if (guid === undefined || (!apply && !this.#holds(guid, assignment))) return;
    this.#context.world()?.assignPartyRole?.(assignment, apply, guid);
  }

  /** `GetPartyAssignment`: the member's flag from the list, the player's from the header. */
  assigned(assignment: number, who: string): boolean {
    const guid = this.memberGuid(who);
    return guid !== undefined && this.#holds(guid, assignment);
  }

  #holds(guid: bigint, assignment: number): boolean {
    const world = this.#context.world();
    const group = world?.group;
    if (!group) return false;
    const flags = guid === world.state.selfGuid
      ? group.ownFlags
      : group.members.find((member) => member.guid === guid)?.flags ?? 0;
    return (flags & assignmentFlag(assignment)) !== 0;
  }

  /** `ReportPlayerIsPVPAFK`: CMSG_REPORT_PVP_AFK for a member of the player's raid. */
  reportAfk(who: string): void {
    const guid = this.memberGuid(who);
    if (guid !== undefined) this.#context.world()?.reportPvpAfk?.(guid);
  }

  #holder(assignment: number): bigint | undefined {
    const world = this.#context.world();
    const group = world?.group;
    if (!group) return undefined;
    const flag = assignmentFlag(assignment);
    const member = group.members.find((candidate) => (candidate.flags & flag) !== 0);
    if (member) return member.guid;
    const self = world.state.selfGuid;
    return (group.ownFlags & flag) !== 0 && self !== undefined && self !== 0n ? self : undefined;
  }
}

/** The part of the world seam the bindings read. */
export interface FrameXmlGroupCommandsHost {
  readonly groupCommands?: FrameXmlGroupCommandsModel | undefined;
}

const NOTHING: readonly unknown[] = Object.freeze([]);

function who(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export const FRAMEXML_GROUP_COMMAND_BINDINGS: Readonly<Record<string,
  (host: FrameXmlGroupCommandsHost, args: readonly unknown[]) => readonly unknown[]>> = Object.freeze({
  PromoteToAssistant: (host, args) => {
    const name = who(args[0]);
    if (name !== undefined) host.groupCommands?.setAssistant(name, true);
    return NOTHING;
  },
  DemoteAssistant: (host, args) => {
    const name = who(args[0]);
    if (name !== undefined) host.groupCommands?.setAssistant(name, false);
    return NOTHING;
  },
  SetPartyAssignment: (host, args) => {
    const assignment = frameXmlGroupAssignment(args[0]);
    const name = who(args[1]);
    if (assignment !== undefined && name !== undefined) host.groupCommands?.assign(assignment, name, true);
    return NOTHING;
  },
  ClearPartyAssignment: (host, args) => {
    const assignment = frameXmlGroupAssignment(args[0]);
    if (assignment !== undefined) host.groupCommands?.assign(assignment, who(args[1]), false);
    return NOTHING;
  },
  // The client's 1/nil: UnitPopup tests it with `not`, SecureTemplates with `if`.
  GetPartyAssignment: (host, args) => {
    const assignment = frameXmlGroupAssignment(args[0]);
    const name = who(args[1]);
    return assignment !== undefined && name !== undefined && host.groupCommands?.assigned(assignment, name)
      ? [1] : NOTHING;
  },
  ReportPlayerIsPVPAFK: (host, args) => {
    const name = who(args[0]);
    if (name !== undefined) host.groupCommands?.reportAfk(name);
    return NOTHING;
  },
});
