import { unit } from "../../world/Fields.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import { game } from "../game/Context.js";
import { arenaOpponentGuids, engagedBossGuids, forgetEncounters } from "../game/Encounters.js";
import {
  GROUPTYPE_RAID, MEMBER_FLAG_ASSISTANT, MEMBER_FLAG_MAINASSIST, MEMBER_FLAG_MAINTANK,
  type GroupMember, type GroupState,
} from "../../world/GroupProtocol.js";
import { openGroupMenu } from "./GroupMenu.js";
import { reactionTo } from "../game/Targeting.js";
import { arenaFrames, bossFrames, focusFrame, partyFrames, petFrame, raidFrames, targetOfTargetFrame } from "./Dom.js";
import { showTarget, unitDisplayName } from "./Frames.js";
import { UnitFrame, UnitFrameList } from "./UnitFrame.js";
import { raidMarksByUnit, threatFraction, unitSnapshot, type UnitSnapshot } from "./UnitSnapshot.js";
import { setUnitFramePortrait } from "./Portraits.js";

/**
 * Every unit frame past the player's own and its target: slice I2.
 *
 * Four of these the server never names, and each is worked out here rather than read:
 *
 * * **Target of target** is `UNIT_FIELD_TARGET` of whoever is targeted. It is the field the client
 *   already receives for every unit and has never drawn.
 * * **The focus** is entirely a client idea. Nothing on the wire knows about it.
 * * **Boss frames** come from `SMSG_UPDATE_INSTANCE_ENCOUNTER_UNIT`, which does not carry a list —
 *   it carries one engage or disengage at a time, so the list has to be accumulated.
 * * **Arena frames** are the hardest case: in 3.3.5 the server never names the enemy team while the
 *   match is running, so they are built from the hostile players the client can actually see.
 *
 * The last two moved to `game/Encounters.ts` in М6 — not because the frames stopped wanting them,
 * but because a module window's `boss[i]` and `arena[i]` read the same two lists and a second copy
 * of either would drift the first time one of them was corrected. They are re-exported here so
 * that nothing outside had to be told.
 */

const RAID_SUBGROUPS = 8;
const RAID_PER_SUBGROUP = 5;

const selectTarget = (guid: bigint): void => {
  game.world?.selectTarget(guid);
  showTarget();
};

const targetOfTarget = new UnitFrame({ kind: "tot", size: "compact", onClick: selectTarget, portrait: true });
const focus = new UnitFrame({ kind: "focus", size: "compact", onClick: selectTarget, portrait: true });
const pet = new UnitFrame({ kind: "pet", size: "compact", onClick: selectTarget, portrait: true });
const party = new UnitFrameList({ kind: "party", size: "full", onClick: selectTarget, onContext: openGroupMenu });
const raid = new UnitFrameList({
  kind: "raid", size: "grid", onClick: selectTarget, onContext: openGroupMenu, className: "ui-raid-grid",
});
const bosses = new UnitFrameList({ kind: "boss", size: "compact", onClick: selectTarget });
const arena = new UnitFrameList({ kind: "arena", size: "compact", onClick: selectTarget });

targetOfTargetFrame.append(targetOfTarget.root);
focusFrame.append(focus.root);
petFrame.append(pet.root);
partyFrames.append(party.root);
raidFrames.append(raid.root);
bossFrames.append(bosses.root);
arenaFrames.append(arena.root);

export { arenaOpponentGuids, bossDisengaged, bossEngaged, engagedBossGuids, inArena } from "../game/Encounters.js";

export function forgetUnitFrames(): void {
  forgetEncounters();
  showUnitFrames();
}

/** The reaction to a unit, or undefined for the player's own side, where it says nothing. */
function reactionOf(object: WorldObjectState | undefined): number | undefined {
  if (!object) return undefined;
  return reactionTo(object);
}

function snapshotOf(guid: bigint, marks: Map<bigint, number>): UnitSnapshot | undefined {
  const world = game.world;
  if (!world) return undefined;
  const object = world.state.objects.get(guid);
  const stats = world.partyStats.get(guid);
  if (!object && !stats) return undefined;
  return unitSnapshot(guid, object ? unitDisplayName(object) : world.displayName(guid), {
    object,
    stats,
    raidMark: marks.get(guid),
    reaction: reactionOf(object),
  });
}

/** How much of the highest threat this unit holds on the creature it is fighting. */
function threatOn(creatureGuid: bigint | undefined, guid: bigint): number | undefined {
  if (creatureGuid === undefined) return undefined;
  const table = game.world?.threat.get(creatureGuid);
  return table ? threatFraction(table.entries, guid) : undefined;
}

/**
 * Repaints every frame in the slice. Called once per world update, alongside the target frame.
 *
 * Everything here is recomputed rather than diffed: the whole set is at most fifty-six frames of
 * two bars each, and the alternative — tracking which of forty raid slots changed — is the kind of
 * bookkeeping that goes wrong quietly the first time somebody joins mid-fight.
 */
export function showUnitFrames(): void {
  const world = game.world;
  if (!world) {
    for (const frame of [targetOfTarget, focus, pet]) frame.hide();
    setUnitFramePortrait("tot", targetOfTarget);
    setUnitFramePortrait("focus", focus);
    setUnitFramePortrait("pet", pet);
    for (const list of [party, raid, bosses, arena]) list.render([]);
    return;
  }

  const marks = raidMarksByUnit(world.raidTargets);
  const selfGuid = world.state.selfGuid;
  const target = world.targetGuid === undefined ? undefined : world.state.objects.get(world.targetGuid);

  // Target of target: one field of the target, which the client has always received.
  const totGuid = target ? unit.target(target) : undefined;
  const tot = totGuid === undefined || totGuid === 0n ? undefined : snapshotOf(totGuid, marks);
  if (tot) targetOfTarget.show(tot, { active: tot.guid === selfGuid });
  else targetOfTarget.hide();
  setUnitFramePortrait("tot", targetOfTarget);

  const focusSnapshot = game.focusGuid === undefined ? undefined : snapshotOf(game.focusGuid, marks);
  if (focusSnapshot) focus.show(focusSnapshot);
  else focus.hide();
  setUnitFramePortrait("focus", focus);

  // The pet's guid comes from the bar the server sent for it, which is the only packet that names
  // it: `UNIT_FIELD_SUMMON` on the player carries the same guid but arrives later.
  const petGuid = world.petSpells?.guid;
  const petSnapshot = petGuid === undefined || petGuid === 0n ? undefined : snapshotOf(petGuid, marks);
  if (petSnapshot) pet.show(petSnapshot);
  else pet.hide();
  setUnitFramePortrait("pet", pet);

  const group = world.group;
  const isRaid = group !== undefined && (group.groupType & GROUPTYPE_RAID) !== 0;
  const members = (group?.members ?? []).filter((member) => member.guid !== selfGuid);

  if (!group || members.length === 0) {
    party.render([]);
    raid.render([]);
  } else if (isRaid) {
    party.render([]);
    // Eight subgroups of five, in the server's own numbering, with the empty slots left in place:
    // a raid frame that closes its gaps renumbers everybody the moment one person leaves.
    const grid: Array<{
      snapshot: UnitSnapshot;
      threat?: number | undefined;
      role?: "leader" | "assistant" | "maintank" | "mainassist" | undefined;
      ready?: boolean | undefined;
    } | undefined> = [];
    for (let index = 0; index < RAID_SUBGROUPS * RAID_PER_SUBGROUP; index++) grid.push(undefined);
    const filled = new Map<number, number>();
    for (const member of members) {
      const subgroup = Math.min(RAID_SUBGROUPS - 1, Math.max(0, member.subGroup));
      const used = filled.get(subgroup) ?? 0;
      if (used >= RAID_PER_SUBGROUP) continue;
      filled.set(subgroup, used + 1);
      const snapshot = snapshotOf(member.guid, marks)
        ?? unitSnapshot(member.guid, member.name, { online: member.online, raidMark: marks.get(member.guid) });
      snapshot.name = member.name;
      snapshot.online = member.online;
      grid[subgroup * RAID_PER_SUBGROUP + used] = {
        snapshot, role: roleOf(member, group), ready: readyAnswer(member.guid),
      };
    }
    raid.render(grid.map((entry) => entry ?? { snapshot: emptyGridSlot() }));
  } else {
    raid.render([]);
    party.render(members.map((member) => {
      const snapshot = snapshotOf(member.guid, marks)
        ?? unitSnapshot(member.guid, member.name, { online: member.online, raidMark: marks.get(member.guid) });
      // The group list is the authority on the name and on being connected at all; the stats
      // packet does not carry a name and an offline member has no object to read one from.
      snapshot.name = member.name;
      snapshot.online = member.online;
      return {
        snapshot,
        threat: threatOn(world.targetGuid, member.guid),
        role: roleOf(member, group),
        ready: readyAnswer(member.guid),
      };
    }));
  }

  bosses.render(engagedBossGuids()
    .map((guid) => snapshotOf(guid, marks))
    .filter((snapshot): snapshot is UnitSnapshot => snapshot !== undefined)
    .map((snapshot) => ({ snapshot, threat: threatOn(snapshot.guid, selfGuid ?? 0n) })));

  arena.render(arenaOpponents(marks).map((snapshot) => ({ snapshot })));
}

/**
 * What a member is in the group, as one glyph.
 *
 * The leader outranks everything else; below that, main tank and main assist are worth more to a
 * healer at a glance than the assistant bit, which is about permissions rather than about the
 * fight.
 */
function roleOf(member: GroupMember, group: GroupState): "leader" | "assistant" | "maintank" | "mainassist" | undefined {
  if (group.leaderGuid === member.guid) return "leader";
  if ((member.flags & MEMBER_FLAG_MAINTANK) !== 0) return "maintank";
  if ((member.flags & MEMBER_FLAG_MAINASSIST) !== 0) return "mainassist";
  if ((member.flags & MEMBER_FLAG_ASSISTANT) !== 0) return "assistant";
  return undefined;
}

/** The tick or cross a running ready check puts on a frame. */
function readyAnswer(guid: bigint): boolean | undefined {
  return game.world?.readyCheck?.answers.get(guid);
}

/** A slot in the raid grid that nobody is standing in. Drawn empty rather than removed. */
function emptyGridSlot(): UnitSnapshot {
  return unitSnapshot(0n, "", {});
}

/**
 * The enemy arena team, as far as the client can tell.
 *
 * Nothing on the wire names them while the match runs — see the note at the top of this file — so
 * these are the hostile players in the grid, capped at five and ordered by guid so the frames do
 * not reshuffle every time somebody walks out of range and back.
 */
function arenaOpponents(marks: Map<bigint, number>): UnitSnapshot[] {
  return arenaOpponentGuids()
    .map((guid) => snapshotOf(guid, marks))
    .filter((snapshot): snapshot is UnitSnapshot => snapshot !== undefined);
}
