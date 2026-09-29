/**
 * The stock calendar model over the live WorldClient: its opcodes (CalendarProtocol.ts builders), its
 * CALENDAR_PACKET stream (EventBus.ts), and the player, guild and name state the C API reads.
 *
 * One model per LiveFrameXmlCalendar (the world seam's calendar). A world or session replacement is
 * caught by the seam's existing bounded poll (`tick`): the old world's subscription is dropped, the
 * model forgets that world's rows, and the new world's held snapshot — if the native window or the
 * GameTime badge already asked for one — is folded in at once.
 */

import { readField, unit as unitField } from "../../world/Fields.js";
import type { WorldClient } from "../../world/WorldClient.js";
import { classFileName, className } from "../ui/UnitSnapshot.js";
import { frameXmlCalendarPackedWall, frameXmlCalendarWall } from "./FrameXmlCalendarHolidays.js";
import {
  FrameXmlCalendarModel, type FrameXmlCalendarHost, type FrameXmlCalendarPlayer, type FrameXmlCalendarPump,
  type FrameXmlCalendarServer,
} from "./FrameXmlCalendarModel.js";

/** The WorldClient surface this file reads; a structural type so tests can hand in a double. */
export type FrameXmlCalendarLiveWorld = Pick<WorldClient,
  | "events" | "calendar" | "state" | "selfName" | "names" | "guildRoster" | "guildQuery" | "arenaTeams"
  | "requestName" | "requestCalendar" | "requestCalendarEvent" | "addCalendarEvent" | "updateCalendarEvent"
  | "removeCalendarEvent" | "copyCalendarEvent" | "answerCalendarInvite" | "inviteToCalendarEvent"
  | "signUpForCalendarEvent" | "removeCalendarInvite" | "setCalendarInviteStatus" | "setCalendarModerator"
  | "requestCalendarGuildFilter" | "requestCalendarArenaTeam" | "complainAboutCalendarInvite"
> & Partial<Pick<WorldClient, "currentGameTime">>;

const TYPEID_PLAYER = 4;
/** LiveWorldSeam.unitFactionGroup's rule: the stock races by id. */
const ALLIANCE_RACE_IDS = new Set([1, 3, 4, 7, 11]);
const HORDE_RACE_IDS = new Set([2, 5, 6, 8, 10]);
/** Guild.h GR_RIGHT_CREATE_GUILDEVENT; rank 0 (guild master) holds every right. */
const GR_RIGHT_CREATE_GUILDEVENT = 0x00100000;
/** A 3.3.5a (Wrath) account's level cap: CalendarDefaultGuildFilter's table value for expansion 2. */
const MAX_LEVEL = 80;
const ARENA_TYPES = [2, 3, 5];

function server(world: FrameXmlCalendarLiveWorld): FrameXmlCalendarServer {
  return {
    requestCalendar: () => world.requestCalendar(),
    requestEvent: (eventId) => world.requestCalendarEvent(eventId),
    addEvent: (fields, invites) => world.addCalendarEvent(fields, invites),
    updateEvent: (eventId, moderatorId, fields) => world.updateCalendarEvent(eventId, moderatorId, fields),
    removeEvent: (eventId, moderatorId) => world.removeCalendarEvent(eventId, moderatorId, false),
    copyEvent: (eventId, moderatorId, date) => world.copyCalendarEvent(eventId, moderatorId, date),
    rsvp: (eventId, inviteId, status) => world.answerCalendarInvite(eventId, inviteId, status),
    invite: (eventId, name, moderatorId, creating, isSignUp) =>
      world.inviteToCalendarEvent(eventId, name, moderatorId, creating, isSignUp),
    signUp: (eventId, tentative) => world.signUpForCalendarEvent(eventId, tentative),
    removeInvite: (guid, inviteId, eventId, moderatorId) => world.removeCalendarInvite(guid, inviteId, eventId, moderatorId),
    setStatus: (guid, eventId, inviteId, status, moderatorId) =>
      world.setCalendarInviteStatus(guid, eventId, inviteId, status, moderatorId),
    setModerator: (guid, eventId, inviteId, rank, moderatorId) =>
      world.setCalendarModerator(guid, eventId, inviteId, rank, moderatorId),
    guildFilter: (minLevel, maxLevel, rank) => world.requestCalendarGuildFilter(minLevel, maxLevel, rank),
    arenaTeam: (teamId) => world.requestCalendarArenaTeam(teamId),
    complain: (invitedBy, eventId, inviteId) => world.complainAboutCalendarInvite(invitedBy, eventId, inviteId),
  };
}

/**
 * The live model and its subscription. `now` is the realm wall clock in minutes (LiveFrameXmlCalendar's
 * login clock, else the snapshot), shared with CalendarGetDate so the grid's «today» and GameTime's
 * day never disagree.
 */
export class FrameXmlCalendarLive {
  readonly model: FrameXmlCalendarModel;
  readonly #getWorld: () => FrameXmlCalendarLiveWorld | undefined;
  #world: FrameXmlCalendarLiveWorld | undefined;
  /** The world whose packets the model's rows came from; kept across a detach, unlike `#world`. */
  #fed: FrameXmlCalendarLiveWorld | undefined;
  #unsubscribe: (() => void) | undefined;
  #pump: FrameXmlCalendarPump | undefined;

  constructor(
    getWorld: () => FrameXmlCalendarLiveWorld | undefined,
    monotonic: () => number,
    now: () => number | undefined,
  ) {
    this.#getWorld = getWorld;
    const host: FrameXmlCalendarHost = {
      server: () => {
        const world = this.#getWorld();
        return world ? server(world) : undefined;
      },
      now,
      monotonic,
      player: () => this.#player(),
      nameOf: (guid) => {
        const world = this.#getWorld();
        if (!world || guid === 0n) return undefined;
        const name = world.names.get(guid) ?? (guid === world.state.selfGuid ? world.selfName : undefined);
        if (name === undefined) world.requestName(guid);
        return name;
      },
      classOf: (guid) => this.#classOf(guid),
      inGuild: () => this.#guild() !== undefined,
      canCreateGuildEvent: () => {
        const guild = this.#guild();
        if (!guild) return false;
        if (guild.rankId === 0) return true;
        const flags = this.#getWorld()?.guildRoster?.ranks[guild.rankId]?.flags ?? 0;
        return (flags & GR_RIGHT_CREATE_GUILDEVENT) === GR_RIGHT_CREATE_GUILDEVENT;
      },
      guildRankCount: () => {
        const world = this.#getWorld();
        if (!this.#guild()) return 0;
        return world?.guildRoster?.ranks.length ?? world?.guildQuery?.rankCount ?? 0;
      },
      maxLevel: () => MAX_LEVEL,
      arenaTeamId: (index) => {
        const world = this.#getWorld();
        const type = ARENA_TYPES[index - 1];
        if (!world || type === undefined) return undefined;
        for (const team of world.arenaTeams.values()) if (team.type === type) return team.teamId;
        return undefined;
      },
    };
    this.model = new FrameXmlCalendarModel(host);
  }

  #self(): ReturnType<FrameXmlCalendarLiveWorld["state"]["objects"]["get"]> {
    const world = this.#getWorld();
    const self = world?.state.selfGuid;
    return self === undefined ? undefined : world?.state.objects.get(self);
  }

  #player(): FrameXmlCalendarPlayer | undefined {
    const world = this.#getWorld();
    const guid = world?.state.selfGuid;
    if (!world || guid === undefined || guid === 0n) return undefined;
    const object = this.#self();
    const race = object ? unitField.race(object) : undefined;
    return {
      guid,
      name: world.selfName ?? world.names.get(guid) ?? "",
      level: (object ? unitField.level(object) : undefined) ?? 0,
      faction: race === undefined ? -1 : ALLIANCE_RACE_IDS.has(race) ? 1 : HORDE_RACE_IDS.has(race) ? 0 : -1,
    };
  }

  #guild(): { readonly rankId: number } | undefined {
    const object = this.#self();
    if (object?.typeId === TYPEID_PLAYER) {
      const guildId = readField(object, "PLAYER_GUILDID") ?? 0;
      return guildId > 0 ? { rankId: readField(object, "PLAYER_GUILDRANK") ?? 0 } : undefined;
    }
    const world = this.#getWorld();
    const self = world?.state.selfGuid;
    const member = self === undefined ? undefined : world?.guildRoster?.members.find((row) => row.guid === self);
    return member ? { rankId: member.rankId } : undefined;
  }

  #classOf(guid: bigint): readonly [string, string] | undefined {
    const world = this.#getWorld();
    if (!world) return undefined;
    // The character's own object when it is in view (the player, a group member nearby), else the
    // guild roster's row; the name query's class is not kept by WorldClient's NameCache.
    const object = world.state.objects.get(guid);
    let classId = object?.typeId === TYPEID_PLAYER ? unitField.classId(object) : undefined;
    classId ??= world.guildRoster?.members.find((member) => member.guid === guid)?.classId;
    const token = classFileName(classId);
    return token === undefined ? undefined : [className(classId), token];
  }

  attach(pump: FrameXmlCalendarPump): void {
    this.#pump = pump;
    this.model.attach(pump);
    this.#sync();
  }

  detach(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#world = undefined;
    this.#pump = undefined;
    this.model.detach();
  }

  /** The seam's bounded poll: a world replacement, then the model's own once-a-second work. */
  tick(): void {
    if (!this.#pump) return;
    this.#sync();
    this.model.tick();
  }

  #sync(): void {
    const world = this.#getWorld();
    if (world === this.#world) return;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#world = world;
    if (!world) return;
    // Another world's rows (and its pending count) must not stand in until this one's snapshot.
    if (this.#fed !== undefined && this.#fed !== world) this.model.forget();
    this.#fed = world;
    this.#unsubscribe = world.events.on("CALENDAR_PACKET", (packet) => this.model.receive(packet));
    // The world may already hold an answer (the GameTime badge asks once per world).
    if (world.calendar) this.model.receive({ kind: "snapshot", snapshot: world.calendar });
  }
}

/**
 * The realm wall clock in minutes from what WorldClient holds: the login clock (advanced by the
 * world) when it carries a date, else the calendar snapshot's packed time plus the time since it
 * was seen. Undefined for a realm that reported neither.
 */
export function frameXmlCalendarLiveNow(
  world: Pick<FrameXmlCalendarLiveWorld, "calendar"> & Partial<Pick<WorldClient, "currentGameTime">> | undefined,
  monotonic: number,
  snapshotSeenAt: number | undefined,
): number | undefined {
  if (!world) return undefined;
  const current = world.currentGameTime?.(monotonic);
  if (current?.date) {
    return frameXmlCalendarWall(current.date.year, current.date.month, current.date.day) + Math.floor(current.minuteOfDay);
  }
  const base = world.calendar ? frameXmlCalendarPackedWall(world.calendar.serverTime) : undefined;
  if (base === undefined) return undefined;
  return base + Math.max(0, monotonic - (snapshotSeenAt ?? monotonic)) / 60_000;
}
