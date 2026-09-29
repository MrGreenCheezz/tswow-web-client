/**
 * The Chat tab of the stock FriendsFrame (ChannelFrame.xml, parent="FriendsFrame"): the joined
 * channels and a channel's roster, over `WorldClient.channels`.
 *
 * ChannelFrame.lua reads a *display list* (`GetNumDisplayChannels`/`GetChannelDisplayInfo`) whose
 * rows are headers or channels, and a roster per selected row (`GetChannelRosterInfo`). This client
 * knows only the channels the player is in (`SMSG_CHANNEL_NOTIFY` YOU_JOINED/LEFT, the member count,
 * the roster from `SMSG_CHANNEL_LIST`); ChatChannels.dbc, which names the ones not joined, is not
 * loaded. So the list is the joined channels in `WorldClient.channels` order — the order the chat
 * seam and FrameXmlChatApi number them by — with no header rows, and a row's roster is known once
 * the server listed it: selecting a row asks for it (CMSG_CHANNEL_LIST), as the native `/roster`
 * does. A server channel's number and name are the seam's (`N. Name` and the zone suffix dropped).
 * Voice chat is off: every voice value is nil.
 */
import {
  CHANNEL_MEMBER_MODERATOR, CHANNEL_MEMBER_MUTED, CHANNEL_MEMBER_OWNER, type ChannelMember,
} from "../../world/ChannelProtocol.js";

/** `CHANNEL_FLAG_CUSTOM` from `SMSG_CHANNEL_LIST`/`SMSG_CHANNEL_NOTIFY`: a player-made channel. */
const CHANNEL_FLAG_CUSTOM = 0x01;

export interface FrameXmlChannelsWorld {
  readonly channels?: ReadonlyMap<string, { readonly flags: number; readonly count: number; readonly members: readonly ChannelMember[] }> | undefined;
  readonly state: { readonly selfGuid?: bigint | undefined };
  displayName(guid: bigint): string;
  requestName?(guid: bigint): void;
  requestChannelList?(channel: string): void;
}

interface ChannelsPump {
  fire(event: string, ...args: readonly unknown[]): number;
}

/** The server may prefix a channel with its number and suffix a zone; the chat seam's rule. */
function shortChannelName(raw: string): string {
  return raw.trim().replace(/^\d+\.\s*/, "").replace(/\s+-\s+[^-]+$/, "").trim();
}

/**
 * The Chat tab row a typed channel names (`/roster Общий`, `/roster Общий - Элвиннский лес`,
 * `/roster 2`), given the rows' display names in order: a number is the row's number, a name
 * matches a row's short name case-insensitively. Undefined when no row matches.
 */
export function frameXmlChannelRow(displayNames: readonly string[], typed: string): number | undefined {
  const wanted = typed.trim();
  if (/^\d+$/.test(wanted)) {
    const number = Number(wanted);
    return number >= 1 && number <= displayNames.length ? number : undefined;
  }
  const key = shortChannelName(wanted).toLocaleLowerCase("ru");
  if (!key) return undefined;
  const index = displayNames.findIndex((name) => shortChannelName(name).toLocaleLowerCase("ru") === key);
  return index < 0 ? undefined : index + 1;
}

/** A channel's roster sorted by name, kept while its `members` array holds (see `#members`). */
interface SortedRoster {
  readonly members: readonly ChannelMember[];
  readonly rows: readonly { readonly name: string; readonly flags: number }[];
  /** Members whose names had not resolved when the rows were sorted. */
  readonly unresolved: readonly bigint[];
}

export class FrameXmlChannelsModel {
  readonly #world: () => FrameXmlChannelsWorld | undefined;
  #pump: ChannelsPump | undefined;
  #muted = false;
  #selected: string | undefined;
  #listSeen = "";
  /** Each channel's roster array as last announced; WorldClient replaces it on every roster change. */
  readonly #rosterSeen = new Map<string, readonly ChannelMember[]>();
  readonly #sorted = new Map<string, SortedRoster>();

  constructor(world: () => FrameXmlChannelsWorld | undefined) {
    this.#world = world;
  }

  attach(pump: ChannelsPump): void {
    this.#pump = pump;
    this.#listSeen = this.#names().join("\u0001");
    this.#rosterSeen.clear();
    for (const name of this.#names()) {
      const members = this.#world()?.channels?.get(name)?.members;
      if (members) this.#rosterSeen.set(name, members);
    }
  }

  detach(): void { this.#pump = undefined; }

  muted<T>(operation: () => T): T {
    const previous = this.#muted;
    this.#muted = true;
    try { return operation(); } finally { this.#muted = previous; }
  }

  #names(): string[] {
    const channels = this.#world()?.channels;
    return channels instanceof Map ? [...channels.keys()].filter((name): name is string => typeof name === "string") : [];
  }

  #channel(index: number): { name: string; flags: number; count: number; members: readonly ChannelMember[] } | undefined {
    const name = Number.isInteger(index) && index >= 1 ? this.#names()[index - 1] : undefined;
    const held = name === undefined ? undefined : this.#world()?.channels?.get(name);
    return name !== undefined && held ? { name, ...held } : undefined;
  }

  numDisplayChannels(): number { return this.#names().length; }

  /**
   * `GetChannelDisplayInfo(i)`: name, header, collapsed, channelNumber, count, active, category,
   * voiceEnabled, voiceActive. `count` is the listed roster's size and nil before the server listed
   * it — ChannelRoster_Update draws `count` rows from GetChannelRosterInfo, which knows no more.
   */
  displayInfo(index: number): readonly unknown[] | undefined {
    const channel = this.#channel(index);
    if (!channel) return undefined;
    const category = (channel.flags & CHANNEL_FLAG_CUSTOM) !== 0 ? "CHANNEL_CATEGORY_CUSTOM" : "CHANNEL_CATEGORY_WORLD";
    return [shortChannelName(channel.name), undefined, undefined, index,
      channel.members.length > 0 ? channel.members.length : undefined, true, category, undefined, undefined];
  }

  selected(): number | undefined {
    const index = this.#selected === undefined ? -1 : this.#names().indexOf(this.#selected);
    return index < 0 ? undefined : index + 1;
  }

  /** `SetSelectedDisplayChannel(i)`: select the row and ask the server for its roster. */
  select(index: number): void {
    const channel = this.#channel(index);
    this.#selected = channel?.name;
    if (channel) this.requestRoster(index);
  }

  /** `GetNumChannelMembers(i)` (the row's right-click path): CMSG_CHANNEL_LIST, and the size known now. */
  requestRoster(index: number): number {
    const channel = this.#channel(index);
    if (!channel) return 0;
    if (!this.#muted) this.#world()?.requestChannelList?.(channel.name);
    return channel.members.length;
  }

  /**
   * A channel's roster by name. ChannelRoster_Update reads it one row at a time
   * (`GetChannelRosterInfo(id, i)` for 22 rows per repaint, ChannelFrame.lua:573), and sorting the
   * whole roster per row cost 9.4 ms a repaint for 200 members and 64.5 ms for 1,000 (measured in
   * node on P-cores). So the sorted rows are kept per channel until WorldClient replaces its
   * `members` array — every roster packet does — or a name missing at the sort arrives (`tick`).
   */
  #members(index: number): readonly { readonly name: string; readonly flags: number }[] {
    const world = this.#world();
    const channel = this.#channel(index);
    if (!world || !channel) return [];
    const held = this.#sorted.get(channel.name);
    if (held?.members === channel.members) return held.rows;
    const unresolved: bigint[] = [];
    const rows = channel.members.map((member) => {
      const name = world.displayName(member.guid);
      if (name.startsWith("0x")) {
        unresolved.push(member.guid);
        world.requestName?.(member.guid);
      }
      return { name, flags: member.flags };
    }).sort((left, right) => left.name.localeCompare(right.name, "ru"));
    this.#sorted.set(channel.name, { members: channel.members, rows, unresolved });
    return rows;
  }

  /** `GetChannelRosterInfo(i, j)`: name, owner, moderator, muted, active, enabled (voice: nil). */
  rosterInfo(index: number, memberIndex: number): readonly unknown[] | undefined {
    const member = Number.isInteger(memberIndex) && memberIndex >= 1 ? this.#members(index)[memberIndex - 1] : undefined;
    return member ? [member.name, (member.flags & CHANNEL_MEMBER_OWNER) !== 0,
      (member.flags & CHANNEL_MEMBER_MODERATOR) !== 0, (member.flags & CHANNEL_MEMBER_MUTED) !== 0, undefined, undefined]
      : undefined;
  }

  #ownFlags(): number {
    const index = this.selected();
    const self = this.#world()?.state.selfGuid;
    const channel = index === undefined ? undefined : this.#channel(index);
    return channel?.members.find((member) => member.guid === self)?.flags ?? 0;
  }

  isOwner(): boolean { return (this.#ownFlags() & CHANNEL_MEMBER_OWNER) !== 0; }
  isModerator(): boolean { return (this.#ownFlags() & CHANNEL_MEMBER_MODERATOR) !== 0; }

  /**
   * The 60 ms poll's channel half. WorldClient reports channel packets on CHANNEL_CHANGED, which the
   * chat seam already listens to for its own window update; the Chat tab reads the same map on the
   * poll instead of adding a second listener. SMSG_CHANNEL_LIST and SMSG_USERLIST_* replace a
   * channel's `members` array, so a new array is exactly «its roster changed»; the member-count
   * packet leaves the array alone. A changed set of channels is CHANNEL_UI_UPDATE
   * (ChannelFrame_Update); a changed roster of the *selected* row is CHANNEL_ROSTER_UPDATE with its
   * index. ChannelRoster_Update(id) draws whichever row the event names into the one roster pane
   * (ChannelFrame.lua:44, :573), so another channel's join or leave must not repaint it. The same
   * edge fires once names that were unknown when the selected roster was sorted have arrived.
   */
  tick(): void {
    const pump = this.#pump;
    if (!pump) return;
    const world = this.#world();
    const channels = world?.channels;
    const names = this.#names();
    const list = names.join("\u0001");
    if (list !== this.#listSeen) {
      this.#listSeen = list;
      pump.fire("CHANNEL_UI_UPDATE");
    }
    const selected = this.#selected;
    names.forEach((name, index) => {
      const members = channels?.get(name)?.members;
      if (!members || members === this.#rosterSeen.get(name)) return;
      const first = !this.#rosterSeen.has(name);
      this.#rosterSeen.set(name, members);
      // A channel that just appeared with no roster listed has nothing to repaint.
      if (name === selected && (!first || members.length > 0)) pump.fire("CHANNEL_ROSTER_UPDATE", index + 1);
    });
    for (const name of [...this.#rosterSeen.keys()]) if (!names.includes(name)) this.#rosterSeen.delete(name);
    for (const [name, sorted] of [...this.#sorted]) {
      const index = names.indexOf(name);
      if (index < 0 || channels?.get(name)?.members !== sorted.members) {
        // Left, or a new roster array: the edge above already repainted it, and the next read re-sorts.
        this.#sorted.delete(name);
      } else if (world && sorted.unresolved.some((guid) => !world.displayName(guid).startsWith("0x"))) {
        this.#sorted.delete(name);
        if (name === selected) pump.fire("CHANNEL_ROSTER_UPDATE", index + 1);
      }
    }
  }
}

export type FrameXmlChannelsCall = (channels: FrameXmlChannelsModel, args: readonly unknown[]) => readonly unknown[] | undefined;

function integerArg(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(number) ? number : undefined;
}

const NOTHING: readonly [] = Object.freeze([]);

/** The Chat tab's C API; the join/leave/moderation commands stay FrameXmlChatApi's. */
export const FRAMEXML_CHANNELS_CALLS: Readonly<Record<string, FrameXmlChannelsCall>> = Object.freeze({
  GetNumDisplayChannels: (channels) => [channels.numDisplayChannels()],
  GetChannelDisplayInfo: (channels, args) => channels.displayInfo(integerArg(args[0]) ?? 0),
  GetSelectedDisplayChannel: (channels) => {
    const index = channels.selected();
    return index === undefined ? NOTHING : [index];
  },
  SetSelectedDisplayChannel: (channels, args) => { channels.select(integerArg(args[0]) ?? 0); return NOTHING; },
  GetNumChannelMembers: (channels, args) => [channels.requestRoster(integerArg(args[0]) ?? 0)],
  GetChannelRosterInfo: (channels, args) => channels.rosterInfo(integerArg(args[0]) ?? 0, integerArg(args[1]) ?? 0),
  IsDisplayChannelOwner: (channels) => [channels.isOwner()],
  IsDisplayChannelModerator: (channels) => [channels.isModerator()],
  // The list has no header rows to collapse (see the module doc).
  CollapseChannelHeader: () => NOTHING,
  ExpandChannelHeader: () => NOTHING,
});
