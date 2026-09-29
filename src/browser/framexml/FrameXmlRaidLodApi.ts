/**
 * The C functions Blizzard_RaidUI calls that nothing else in the corpus does and that this host
 * answers: `UnitClassBase` and the drag's `SetRaidSubgroup`/`SwapRaidSubgroup`. Kept apart from the
 * lazy owner (FrameXmlRaidLod.ts) so the world seam's binding table imports nothing but this.
 * (`SetRaidRosterSelection`, the drag's and the pullouts' selection mark, stays the stub plan's
 * no-op: nothing in the add-on reads the selection back.)
 *
 * `RaidClassButton_Update` names each class button after the first raid member of that class
 * (`button.class, button.fileName = UnitClassBase("raid"..i)`, Blizzard_RaidUI.lua:106), and the
 * button's tooltip formats `button.class` with `%s` (:121) — unbound, hovering any populated class
 * button raised «bad argument #2 to 'format'». The grid's rows come from `GetRaidRosterInfo`, whose
 * class pair the raid model answers from the member's facts even out of range, so a `raid<i>` token
 * is answered from the same row; any other unit is `UnitClass`'s answer.
 *
 * A leader's or an assistant's drag ends in `RaidGroupButton_OnDragStop` (Blizzard_RaidUI.lua:626),
 * which moves the button into the target group first and then asks the server: `SetRaidSubgroup(id,
 * group)` onto a free slot, `SwapRaidSubgroup(id, otherId)` onto a member. The first is
 * CMSG_GROUP_CHANGE_SUB_GROUP (FrameXmlRaid.ts `changeSubgroup`), whose SMSG_GROUP_LIST redraws the
 * grid. The second has nothing to send: TrinityCore 3.3.5 leaves CMSG_GROUP_SWAP_SUB_GROUP unhandled
 * (Opcodes.cpp, `Handle_NULL`). Each answers `true` only when a request went out; the owner redraws
 * the grid from the roster when it did not, so a move the server will not make never stays on screen.
 */
import type { FrameXmlFriendsModel } from "./FrameXmlFriends.js";

/** The part of the world seam the binding reads. */
export interface FrameXmlRaidLodHost {
  readonly friends?: FrameXmlFriendsModel | undefined;
  unitClass(unit: string): readonly [string, string] | undefined;
}

const NOTHING: readonly [] = Object.freeze([]);
const SENT: readonly [true] = Object.freeze([true]);

function integerArg(value: unknown): number {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(number) ? number : 0;
}

export const FRAMEXML_RAID_LOD_BINDINGS: Readonly<Record<string,
  (host: FrameXmlRaidLodHost, args: readonly unknown[]) => readonly unknown[]>> = Object.freeze({
  UnitClassBase: (host, args) => {
    const unit = typeof args[0] === "string" ? args[0].toLowerCase() : "";
    const raid = /^raid([1-9]\d?)$/.exec(unit);
    const row = raid ? host.friends?.raid.rosterInfo(Number(raid[1])) : undefined;
    if (typeof row?.[4] === "string" && typeof row[5] === "string") return [row[4], row[5]];
    return host.unitClass(unit) ?? NOTHING;
  },
  SetRaidSubgroup: (host, args) =>
    host.friends?.raid.changeSubgroup(integerArg(args[0]), integerArg(args[1])) === true ? SENT : NOTHING,
  SwapRaidSubgroup: () => NOTHING,
});
