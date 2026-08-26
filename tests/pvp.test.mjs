import assert from "node:assert/strict";
import test from "node:test";
import {
  BATTLEFIELD_PORT_CONSTANT, PVP_TEAM_ALLIANCE, PVP_TEAM_HORDE, PVP_TEAM_NEUTRAL,
  STATUS_IN_PROGRESS, STATUS_WAIT_JOIN, STATUS_WAIT_QUEUE, battlegroundJoinResultText,
  buildBattlefieldList, buildBattlefieldPort, buildBattlemasterJoin, buildBattlemasterJoinArena,
  buildLeaveBattlefield, buildTogglePvp, isBattlegroundJoinFailure, parseArenaUnitDestroyed,
  parseBattlefieldList, parseBattlefieldStatus, parseBattlegroundPlayer,
  parseBattlegroundPlayerPositions, parseGroupJoinedBattleground, parsePvpCredit, parsePvpLogData,
} from "../dist/code/world/PvpProtocol.js";
import {
  ARENA_TEAM_3V3, arenaErrorText, arenaSlotByType, arenaTeamCommandResultText, arenaTeamEventText,
  arenaTypeBySlot, buildArenaTeamInvite, buildInspectHonorStats, parseArenaError,
  parseArenaTeamCommandResult, parseArenaTeamEvent, parseArenaTeamInvite,
  parseArenaTeamQueryResponse, parseArenaTeamRoster, parseArenaTeamStats, parseInspectArenaTeams,
  parseInspectHonorStats,
} from "../dist/code/world/ArenaProtocol.js";
import {
  BATTLEFIELD_BATTLEID_WINTERGRASP, BF_LEAVE_REASON_CLOSE, battlefieldLeaveReasonText,
  buildBattlefieldEntryInviteResponse, buildBattlefieldExitRequest, parseBattlefieldEjected,
  parseBattlefieldEntered, parseBattlefieldEntryInvite, parseBattlefieldQueueInvite,
  parseBattlefieldQueueResponse,
} from "../dist/code/world/BattlefieldProtocol.js";
import {
  parseInitWorldStates, parseUpdateWorldState, parseWorldStateUiTimer,
} from "../dist/code/world/WorldStateProtocol.js";

const encoder = new TextEncoder();
function bytes(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
const u8 = (value) => Uint8Array.from([value & 0xff]);
const u16 = (value) => {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value & 0xffff, true);
  return out;
};
const u32 = (value) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, true);
  return out;
};
const i32 = (value) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setInt32(0, value, true);
  return out;
};
const f32 = (value) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setFloat32(0, value, true);
  return out;
};
const u64 = (value) => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
};
const cstr = (value) => bytes(encoder.encode(value), u8(0));

const PLAYER = 0x0000_0000_0000_2a01n;
const OTHER = 0x0000_0000_0000_2a02n;
const BATTLEMASTER = 0xf130_0dcb_0000_0007n;

/** The fixed header every status packet that carries a status begins with. */
function statusHeader({ arenaType = 0, arena = false, bgTypeId = 2, instance = 5, rated = false } = {}) {
  return bytes(
    u8(arenaType), u8(arena ? 0x0e : 0x00), u32(bgTypeId), u16(0x1f90),
    u8(10), u8(19), u32(instance), u8(rated ? 1 : 0),
  );
}

test("a queue slot going free is told from a real status by its length alone", () => {
  // BuildBattlegroundStatusPacket writes the slot and a bare zero uint64 when there is no status,
  // and there is no status code for it: twelve bytes IS the message.
  const cleared = parseBattlefieldStatus(bytes(u32(1), u64(0n)));
  assert.equal(cleared.queueSlot, 1);
  assert.equal(cleared.cleared, true);
  assert.equal(cleared.bgTypeId, 0, "nothing survives a cleared slot, so nothing is invented");

  const waiting = parseBattlefieldStatus(bytes(
    u32(0), statusHeader(), u32(STATUS_WAIT_QUEUE), u32(120_000), u32(45_000),
  ));
  assert.equal(waiting.cleared, false);
  assert.equal(waiting.queueSlot, 0);
  assert.equal(waiting.bgTypeId, 2);
  assert.equal(waiting.minLevel, 10);
  assert.equal(waiting.maxLevel, 19);
  assert.equal(waiting.clientInstanceId, 5, "this is the id the join packet wants back");
  assert.equal(waiting.averageWaitTime, 120_000);
  assert.equal(waiting.timeInQueue, 45_000);
});

test("an invitation and a running match differ by the block after the status word", () => {
  const invited = parseBattlefieldStatus(bytes(
    u32(0), statusHeader(), u32(STATUS_WAIT_JOIN), u32(489), u64(0n), u32(80_000),
  ));
  assert.equal(invited.status, STATUS_WAIT_JOIN);
  assert.equal(invited.mapId, 489);
  assert.equal(invited.removeTime, 80_000, "milliseconds before the invitation expires");

  const playing = parseBattlefieldStatus(bytes(
    u32(1), statusHeader(), u32(STATUS_IN_PROGRESS), u32(489), u64(0n), u32(0), u32(310_000), u8(1),
  ));
  assert.equal(playing.status, STATUS_IN_PROGRESS);
  assert.equal(playing.elapsedTime, 310_000);
  assert.equal(playing.team, PVP_TEAM_ALLIANCE, "the byte is 1 for alliance and 0 for horde");

  const horde = parseBattlefieldStatus(bytes(
    u32(1), statusHeader(), u32(STATUS_IN_PROGRESS), u32(489), u64(0n), u32(0), u32(1), u8(0),
  ));
  assert.equal(horde.team, PVP_TEAM_HORDE, "horde is zero, which is the reverse of the usual reading");
});

test("an arena is marked by one byte and carries its size in the one before it", () => {
  const arena = parseBattlefieldStatus(bytes(
    u32(0), statusHeader({ arenaType: 3, arena: true, bgTypeId: 6, rated: true }),
    u32(STATUS_WAIT_QUEUE), u32(60_000), u32(1_000),
  ));
  assert.equal(arena.isArena, true);
  assert.equal(arena.arenaType, 3, "2, 3 or 5 — the team size, not the slot");
  assert.equal(arena.rated, true);

  const battleground = parseBattlefieldStatus(bytes(
    u32(0), statusHeader(), u32(STATUS_WAIT_QUEUE), u32(0), u32(0),
  ));
  assert.equal(battleground.isArena, false);
  assert.equal(battleground.arenaType, 0);
});

test("only the random battleground repeats its reward block", () => {
  const ordinary = parseBattlefieldList(bytes(
    u64(BATTLEMASTER), u8(0), u32(2), u8(0), u8(0),
    u8(1), u32(124), u32(25), u32(41),
    u8(0),
    u32(2), u32(7), u32(9),
  ));
  assert.equal(ordinary.battlemasterGuid, BATTLEMASTER);
  assert.equal(ordinary.hasWin, true);
  assert.equal(ordinary.winHonor, 124);
  assert.equal(ordinary.random, false);
  assert.deepEqual(ordinary.instances, [7, 9], "the ids a specific match is queued by");

  const random = parseBattlefieldList(bytes(
    u64(0n), u8(1), u32(32), u8(0), u8(0),
    u8(0), u32(124), u32(25), u32(41),
    u8(1), u8(0), u32(248), u32(50), u32(82),
    u32(0),
  ));
  assert.equal(random.random, true);
  assert.equal(random.randomWinHonor, 248, "the second block exists only because the flag says so");
  assert.deepEqual(random.instances, []);
  assert.equal(random.battlemasterGuid, 0n, "zero when the list came from the queue window");
});

test("a group's queue result is signed, and only two failures carry a guid", () => {
  const queued = parseGroupJoinedBattleground(i32(2));
  assert.equal(queued.result, 2);
  assert.equal(isBattlegroundJoinFailure(2), false, "a positive result is the battleground that was joined");

  const deserters = parseGroupJoinedBattleground(i32(-2));
  assert.equal(deserters.result, -2, "read unsigned this would be four billion and something");
  assert.equal(isBattlegroundJoinFailure(-2), true);
  assert.match(battlegroundJoinResultText(-2), /дезертир/);

  const timedOut = parseGroupJoinedBattleground(bytes(i32(-11), u64(0n)));
  assert.equal(timedOut.result, -11);
  assert.equal(timedOut.guid, 0n, "the core writes a zero guid even here");

  // Zero is a failure too: "queued, but you are not eligible".
  assert.equal(isBattlegroundJoinFailure(0), true);
});

test("joins, leaves and arena destroys are a bare guid each", () => {
  assert.equal(parseBattlegroundPlayer(u64(PLAYER)), PLAYER);
  assert.equal(parseArenaUnitDestroyed(u64(OTHER)), OTHER);
});

test("the flag positions are two counted blocks and the first is always empty", () => {
  // The Alterac Valley loop that would fill the first block is commented out in this core, so a
  // reader that starts at the carriers reads the carrier count as half a guid.
  const positions = parseBattlegroundPlayerPositions(bytes(
    u32(0),
    u32(2),
    u64(PLAYER), f32(1519.5), f32(1481.25),
    u64(OTHER), f32(915.0), f32(1434.0),
  ));
  assert.deepEqual(positions.players, []);
  assert.equal(positions.carriers.length, 2);
  assert.equal(positions.carriers[0].guid, PLAYER);
  assert.equal(positions.carriers[0].x, 1519.5);
  assert.equal(positions.carriers[1].y, 1434.0);

  const nobody = parseBattlegroundPlayerPositions(bytes(u32(0), u32(0)));
  assert.deepEqual(nobody.carriers, []);
});

test("a battleground scoreboard row carries three fields an arena row replaces with one byte", () => {
  const scores = parsePvpLogData(bytes(
    u8(0),
    u8(1), u8(PVP_TEAM_ALLIANCE),
    u32(2),
    u64(PLAYER), u32(3), u32(12), u32(2), u32(219), u32(41_233), u32(0), u32(2), u32(1), u32(0),
    u64(OTHER), u32(0), u32(4), u32(7), u32(31), u32(1_002), u32(88_120), u32(2), u32(0), u32(3),
  ));
  assert.equal(scores.arena, false);
  assert.deepEqual(scores.teams, [], "a battleground carries no team blocks at all");
  assert.equal(scores.ended, true);
  assert.equal(scores.winner, PVP_TEAM_ALLIANCE);
  assert.equal(scores.scores.length, 2);
  assert.equal(scores.scores[0].killingBlows, 3);
  assert.equal(scores.scores[0].honorableKills, 12);
  assert.equal(scores.scores[0].deaths, 2);
  assert.equal(scores.scores[0].bonusHonor, 219);
  assert.equal(scores.scores[0].damageDone, 41_233);
  assert.deepEqual(scores.scores[0].objectives, [1, 0], "Warsong Gulch counts captures and returns");
  assert.equal(scores.scores[1].healingDone, 88_120);
  assert.deepEqual(scores.scores[1].objectives, [0, 3]);
});

test("an arena writes both rating blocks before either team name", () => {
  // BuildPvPLogDataPacket loops the ratings for both teams and only then loops the names, which is
  // what a reader written from the field list rather than from the builder gets wrong.
  const scores = parsePvpLogData(bytes(
    u8(1),
    u32(14), u32(0), u32(1_512),
    u32(0), u32(14), u32(1_498),
    cstr("Ночные клинки"), cstr("Рассвет"),
    u8(1), u8(PVP_TEAM_ALLIANCE),
    u32(1),
    u64(PLAYER), u32(2), u8(PVP_TEAM_ALLIANCE), u32(52_100), u32(3_400), u32(0),
  ));
  assert.equal(scores.arena, true);
  assert.equal(scores.teams.length, 2);
  assert.deepEqual(scores.teams[0], { ratingLost: 14, ratingWon: 0, matchmakerRating: 1_512, name: "Ночные клинки" });
  assert.deepEqual(scores.teams[1], { ratingLost: 0, ratingWon: 14, matchmakerRating: 1_498, name: "Рассвет" });
  assert.equal(scores.scores[0].teamId, PVP_TEAM_ALLIANCE);
  assert.equal(scores.scores[0].damageDone, 52_100);
  assert.equal(scores.scores[0].honorableKills, 0, "an arena row has none of the three");
  assert.deepEqual(scores.scores[0].objectives, []);
});

test("an unfinished scoreboard has no winner byte at all", () => {
  const running = parsePvpLogData(bytes(u8(0), u8(0), u32(0)));
  assert.equal(running.ended, false);
  assert.equal(running.winner, PVP_TEAM_NEUTRAL, "reading a winner here would consume the count");
  assert.deepEqual(running.scores, []);
});

test("honor for a kill names the victim and their rank", () => {
  const credit = parsePvpCredit(bytes(u32(41), u64(OTHER), u32(7)));
  assert.deepEqual(credit, { honor: 41, victimGuid: OTHER, victimRank: 7 });
});

test("the world state count is a uint16 behind three signed words", () => {
  const init = parseInitWorldStates(bytes(
    i32(489), i32(3277), i32(0), u16(3),
    i32(1581), i32(2), i32(1582), i32(1), i32(2338), i32(-1),
  ));
  assert.equal(init.mapId, 489);
  assert.equal(init.zoneId, 3277);
  assert.equal(init.states.length, 3, "read as a fourth int32 the first pair becomes the count");
  assert.deepEqual(init.states[0], { variableId: 1581, value: 2 });
  assert.equal(init.states[2].value, -1, "a capture bar runs through zero, so the value is signed");

  const update = parseUpdateWorldState(bytes(i32(2338), i32(-40)));
  assert.deepEqual(update, { variableId: 2338, value: -40 });

  assert.equal(parseWorldStateUiTimer(u32(1_755_000_000)), 1_755_000_000);
});

test("an arena roster counts its members between two header fields", () => {
  const roster = parseArenaTeamRoster(bytes(
    u32(77), u8(0), u32(2), u32(ARENA_TEAM_3V3),
    u64(PLAYER), u8(1), cstr("Аллея"), u32(0), u8(80), u8(4), u32(10), u32(6), u32(120), u32(71), u32(1_842),
    u64(OTHER), u8(0), cstr("Тень"), u32(1), u8(0), u8(9), u32(10), u32(6), u32(98), u32(55), u32(1_790),
  ));
  assert.equal(roster.teamId, 77);
  assert.equal(roster.type, ARENA_TEAM_3V3);
  assert.equal(roster.members.length, 2);
  assert.equal(roster.members[0].captain, true, "the core writes 0 for the captain and 1 for everyone else");
  assert.equal(roster.members[1].captain, false);
  assert.equal(roster.members[0].level, 80);
  assert.equal(roster.members[1].level, 0, "an offline member has no level: it is read off the session");
  assert.equal(roster.members[1].online, false);
  assert.equal(roster.members[0].personalRating, 1_842);
});

test("a team's tabard and its record arrive on two opcodes for one query", () => {
  const info = parseArenaTeamQueryResponse(bytes(
    u32(77), cstr("Ночные клинки"), u32(ARENA_TEAM_3V3), u32(3), u32(41), u32(2), u32(1), u32(9),
  ));
  assert.equal(info.name, "Ночные клинки");
  assert.equal(info.type, ARENA_TEAM_3V3);
  assert.equal(info.emblemStyle, 41);

  const stats = parseArenaTeamStats(bytes(u32(77), u32(1_512), u32(10), u32(6), u32(120), u32(71), u32(38)));
  assert.equal(stats.rating, 1_512);
  assert.equal(stats.rank, 38);

  assert.equal(arenaSlotByType(ARENA_TEAM_3V3), 1, "the slot is not the size");
  assert.equal(arenaTypeBySlot(1), ARENA_TEAM_3V3);
  assert.equal(arenaSlotByType(4), -1);
});

test("an arena team event writes its guid only when there is one, and says nothing about it", () => {
  const joined = parseArenaTeamEvent(bytes(u8(3), u8(2), cstr("Аллея"), cstr("Рассвет"), u64(PLAYER)));
  assert.equal(joined.event, 3);
  assert.deepEqual(joined.strings, ["Аллея", "Рассвет"]);
  assert.equal(joined.guid, PLAYER);
  assert.match(arenaTeamEventText(joined), /Аллея/);

  const disbanded = parseArenaTeamEvent(bytes(u8(8), u8(2), cstr("Аллея"), cstr("Рассвет")));
  assert.equal(disbanded.guid, 0n, "the core simply stops rather than writing a zero");
  assert.match(arenaTeamEventText(disbanded), /распускает/);

  const bare = parseArenaTeamEvent(bytes(u8(6), u8(0)));
  assert.deepEqual(bare.strings, []);
});

test("the arena error writes its team size only when the word in front of it is zero", () => {
  const notInTeam = parseArenaError(bytes(u32(0), u8(3)));
  assert.deepEqual(notInTeam, { code: 0, teamType: 3 });
  assert.match(arenaErrorText(notInTeam), /3×3/);

  const bare = parseArenaError(u32(4));
  assert.deepEqual(bare, { code: 4, teamType: 0 });
});

test("an arena command result names the team and the player its message needs", () => {
  const result = parseArenaTeamCommandResult(bytes(u32(0), cstr("Рассвет"), cstr("Тень"), u32(0x0b)));
  assert.equal(result.error, 0x0b);
  assert.equal(arenaTeamCommandResultText(result), "«Тень» не найден");

  const full = parseArenaTeamCommandResult(bytes(u32(0), cstr("Рассвет"), cstr(""), u32(0x17)));
  assert.equal(arenaTeamCommandResultText(full), "Команда «Рассвет» заполнена");

  const invite = parseArenaTeamInvite(bytes(cstr("Аллея"), cstr("Рассвет")));
  assert.deepEqual(invite, { playerName: "Аллея", teamName: "Рассвет" });
});

test("an inspection answers one packet per team, and truncates honor to a byte", () => {
  const team = parseInspectArenaTeams(bytes(
    u64(OTHER), u8(1), u32(77), u32(1_512), u32(120), u32(71), u32(98), u32(1_790),
  ));
  assert.equal(team.slot, 1, "the slot, not the team size");
  assert.equal(team.memberSeasonGames, 98, "which is not the team's own season total");

  // MiscHandler writes uint8(player->GetHonorPoints()) against a uint32 field: 4096 arrives as 0.
  const honor = parseInspectHonorStats(bytes(u64(OTHER), u8(4096 & 0xff), u32(11), u32(400), u32(250), u32(3_182)));
  assert.equal(honor.honorPoints, 0, "anybody past 255 points inspects as their total modulo 256");
  assert.equal(honor.lifetimeKills, 3_182);
  assert.equal(buildInspectHonorStats(OTHER).length, 8);
});

test("the outdoor battlefield inverts the byte that says whether there is room", () => {
  const queueInvite = parseBattlefieldQueueInvite(bytes(u32(BATTLEFIELD_BATTLEID_WINTERGRASP), u8(1)));
  assert.equal(queueInvite.battleId, BATTLEFIELD_BATTLEID_WINTERGRASP);

  // SendBfQueueInviteResponse writes `full ? 0 : 1`, so the byte means "there was room".
  const full = parseBattlefieldQueueResponse(bytes(u32(1), u32(4197), u8(1), u8(0), u8(1)));
  assert.equal(full.queued, true);
  assert.equal(full.hasRoom, false, "read as the parameter's name this would be the opposite answer");

  const room = parseBattlefieldQueueResponse(bytes(u32(1), u32(4197), u8(1), u8(1), u8(1)));
  assert.equal(room.hasRoom, true);
});

test("a war invitation expires at an absolute server moment, not after a duration", () => {
  const invite = parseBattlefieldEntryInvite(bytes(u32(1), u32(4197), u32(1_755_000_020)));
  assert.equal(invite.zoneId, 4197);
  assert.equal(invite.expiresAt, 1_755_000_020, "GameTime::GetGameTime() + acceptTime, in server seconds");

  const entered = parseBattlefieldEntered(bytes(u32(1), u8(1), u8(1), u8(1)));
  assert.deepEqual(entered, { battleId: 1, clearedAfk: true });

  const ejected = parseBattlefieldEjected(bytes(u32(1), u8(BF_LEAVE_REASON_CLOSE), u8(2), u8(0)));
  assert.equal(ejected.reason, BF_LEAVE_REASON_CLOSE);
  assert.equal(ejected.relocated, false);
  assert.match(battlefieldLeaveReasonText(BF_LEAVE_REASON_CLOSE), /закончилась/);

  assert.equal(buildBattlefieldEntryInviteResponse(1, false).at(-1), 0);
  assert.equal(buildBattlefieldExitRequest(1).length, 4);
});

test("what the client sends back matches what the server reads", () => {
  assert.equal(buildBattlemasterJoin(BATTLEMASTER, 2, 0, false).length, 8 + 4 + 4 + 1);
  assert.equal(buildBattlemasterJoinArena(BATTLEMASTER, 1, true, true).length, 8 + 3);
  assert.equal(buildBattlefieldList(2, 1).length, 4 + 1 + 1);

  // The port packet has to carry back the 0x1F90 the status packet came with, and the arena type,
  // or the server looks up a queue this player is not in and does nothing at all.
  const port = buildBattlefieldPort(3, 6, true);
  assert.equal(port.length, 1 + 1 + 4 + 2 + 1);
  const view = new DataView(port.buffer, port.byteOffset, port.byteLength);
  assert.equal(view.getUint8(0), 3, "arena type");
  assert.equal(view.getUint32(2, true), 6);
  assert.equal(view.getUint16(6, true), BATTLEFIELD_PORT_CONSTANT);
  assert.equal(view.getUint8(8), 1, "1 enters, 0 leaves the queue");
  assert.equal(buildBattlefieldPort(0, 2, false).at(-1), 0);

  // The leave packet's body is read and thrown away, but all four fields have to be there.
  assert.equal(buildLeaveBattlefield(0, 2).length, 1 + 1 + 4 + 2);

  // TogglePvP::HasPvPStatus is GetSize() == 1, so the length is the mode selector.
  assert.equal(buildTogglePvp().length, 0, "no body toggles whatever is there");
  assert.equal(buildTogglePvp(true).length, 1, "one byte sets it outright");
  assert.equal(buildTogglePvp(false).at(-1), 0);

  assert.equal(buildArenaTeamInvite(77, "Тень").length, 4 + 9);
});
