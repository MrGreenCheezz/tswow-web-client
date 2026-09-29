import assert from "node:assert/strict";
import test from "node:test";

let dbcDirectory;
try {
  dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
} catch {
  dbcDirectory = undefined;
}
const withDataset = { skip: dbcDirectory ? false : "no 3.3.5a DBC dataset on this machine" };

const {
  FRAMEXML_CHAT_OUTBOUND_TYPES, FRAMEXML_SEAM_BINDINGS, FRAMEXML_SEAM_EVENTS,
  frameXmlChatEventArgs, frameXmlEscapeLocalChatText, frameXmlLfgMode,
} = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { FRAMEXML_NEUTRAL_API, FRAMEXML_NEUTRAL_PRELUDE } =
  await import("../dist/code/browser/framexml/FrameXmlNeutralApi.js");
const { frameXmlStubPlan } = await import("../dist/code/browser/framexml/FrameXmlStubPlan.js");
const { FRAMEXML_MAP_REANNOUNCE_TICKS, FrameXmlMap } = await import("../dist/code/browser/framexml/FrameXmlMap.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { GlueLuaVm } = await import("../dist/code/browser/glue/GlueLua.js");
const { parseFrameXmlText } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlText.js");
const { forgetCreationNames, learnCreationNames } = await import("../dist/code/browser/ui/UnitSnapshot.js");
const { CHAT_MSG_SAY, CHAT_MSG_SYSTEM } = await import("../dist/code/world/ChatProtocol.js");
const { EventBus } = await import("../dist/code/world/EventBus.js");
const { WorldClient } = await import("../dist/code/world/WorldClient.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

const call = (seam, name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);

function events() {
  const listeners = new Map();
  return {
    on(name, listener) {
      const set = listeners.get(name) ?? new Set();
      set.add(listener);
      listeners.set(name, set);
      return () => set.delete(listener);
    },
    emit(name, payload) { for (const listener of [...(listeners.get(name) ?? [])]) listener(payload); },
  };
}

/** `Poiск трав` and `Поиск минералов`, as `/dbc/spells` serves them on this dataset. */
const SPELLS = new Map([
  [2383, { id: 2383, name: "Поиск трав", iconPath: "Interface\\Icons\\INV_Misc_Flower_02", effectAura: [45, 0, 0], effectMiscValue: [2, 0, 0], iconId: 1216 }],
  [2580, { id: 2580, name: "Поиск минералов", iconPath: "Interface\\Icons\\Spell_Nature_Earthquake", effectAura: [45, 0, 0], effectMiscValue: [3, 0, 0], iconId: 66 }],
  [133, { id: 133, name: "Огненный шар", iconPath: "Interface\\Icons\\Spell_Fire_FlameBolt", effectAura: [0, 0, 0], effectMiscValue: [0, 0, 0], iconId: 185 }],
]);

function liveFixture({ race = 1, skills = [], mapSource } = {}) {
  const selfGuid = 0x10n;
  const fields = new Map([
    [UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, race | (2 << 8)],
    [UPDATE_FIELDS.UNIT_FIELD_LEVEL.offset, 80],
  ]);
  skills.forEach((skill, index) => fields.set(UPDATE_FIELDS.PLAYER_SKILL_INFO_1_1.offset + index * 3, skill));
  const player = { guid: selfGuid, typeId: 4, fields };
  const cancelled = [];
  const casts = [];
  const world = {
    state: { selfGuid, objects: new Map([[selfGuid, player]]) },
    targetGuid: undefined, chatLog: [], channels: new Map(), events: events(), casts: new Map(),
    actionButtons: [], knownSpells: [{ id: 133, slot: 0 }, { id: 2383, slot: 1 }, { id: 2580, slot: 2 }],
    aurasFor: () => [], cooldownRemaining: () => 0, cooldownState: () => ({ start: 0, duration: 0, enable: 0 }),
    names: new Map(), creatureTemplates: new Map(), partyStats: new Map(), group: undefined,
    worldStateContext: undefined, mapId: undefined, selfName: "Тестовый", displayName: () => "",
    dungeonDifficulty: 0, raidDifficulty: 0,
    cancelAura: (spellId) => cancelled.push(spellId),
  };
  const fired = [];
  const pump = { fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => 1 };
  const sent = [];
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: (id) => SPELLS.get(id),
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: (id) => casts.push(id),
    sendChatMessage: (text, type, language, target) => sent.push([text, type, language, target]),
    ...(mapSource ? { mapSource } : {}),
  });
  return { seam, world, player, fired, pump, cancelled, casts, sent };
}

// ---------------------------------------------------------------- neutral answers and CVars

test("the neutral floor answers the world-PvP queue, hearth-out and expansion like the client", () => {
  const answer = (name) => FRAMEXML_NEUTRAL_API.find((entry) => entry.name === name)?.values;
  assert.deepEqual(answer("GetWorldPVPQueueStatus"), ["none"],
    "BattlefieldFrame.lua:323-357 counts every status that is not \"none\"");
  assert.deepEqual(answer("CanHearthAndResurrectFromArea"), [false]);
  assert.deepEqual(answer("GetExpansionLevel"), [2], "LFDFrame.lua:1 reads it at file scope");
  assert.deepEqual(answer("GetNumBattlefields"), [0], "BattlefieldFrame.lua:403 adds 1 to it");
});

test("stock world-map and TimeManager CVars are seeded, 24-hour time for ruRU only", () => {
  for (const [locale, military] of [["ruRU", "1"], ["enUS", "0"]]) {
    const vm = new GlueLuaVm();
    try {
      vm.setGlobal("__fxNeutralImpl", {});
      vm.setGlobal("__fxAddonModules", []);
      vm.setGlobal("__fxLocale", locale);
      assert.equal(vm.execute(FRAMEXML_NEUTRAL_PRELUDE, "@minimap-chat:neutral").ok, true);
      const run = vm.execute(`
        local get = __fxNeutralImpl.GetCVar
        __values = table.concat({ get("worldMapOpacity"), get("miniWorldMap"), get("questPOI"),
          get("advancedWorldMap"), get("showBattlefieldMinimap"), get("showClock"),
          get("timeMgrAlarmTime"), "[" .. get("timeMgrAlarmMessage") .. "]", get("timeMgrAlarmEnabled"),
          get("timeMgrUseLocalTime"), get("timeMgrUseMilitaryTime") }, ",")
      `, "@minimap-chat:cvars");
      assert.equal(run.ok, true, run.error);
      assert.equal(vm.getGlobal("__values"), `0,0,1,0,1,1,0,[],0,0,${military}`, locale);
    } finally {
      vm.close();
    }
  }
});

// ---------------------------------------------------------------- the world map

test("SetMapToCurrentZone raises WORLD_MAP_UPDATE even when the zone is already selected", withDataset, async () => {
  const { loadAreaData } = await import("../dist/code/gateway/AreaMetadata.js");
  const data = await loadAreaData(dbcDirectory);
  const elwynn = data.mapAreas.find((area) => area.name === "Elwynn");
  const events = [];
  const map = new FrameXmlMap({
    metadata: () => data,
    location: () => ({ mapId: 0, areaId: elwynn.areaId, x: -9_000, y: -400 }),
    corpseLocation: () => null, deathReleaseLocation: () => null,
  });
  map.attach({ fire: (event) => { events.push(event); return 1; } });
  map.tick();
  assert.deepEqual(events, ["WORLD_MAP_UPDATE"]);
  map.tick();
  assert.equal(events.length, 1, "nothing changed, nothing is announced");
  // WorldMapFrame_OnShow (WorldMapFrame.lua:142) calls this and then waits for the event to size
  // its dropdowns; the selection is already Elwynn.
  map.setMapToCurrentZone();
  map.tick();
  assert.deepEqual(events, ["WORLD_MAP_UPDATE", "WORLD_MAP_UPDATE"]);
  assert.deepEqual(map.getMapInfo(), ["Elwynn"]);
  map.setMapToCurrentZone();
  map.setMapToCurrentZone();
  map.tick();
  assert.equal(events.length, 2, "an unchanged re-announcement one frame later is owed, not sent yet");
  for (let tick = 2; tick < FRAMEXML_MAP_REANNOUNCE_TICKS; tick += 1) map.tick();
  assert.equal(events.length, 2);
  map.tick();
  assert.equal(events.length, 3, "the calls within the window coalesce to one edge, never dropped");

  // BattlefieldMinimap_OnUpdate calls it on every frame while the player is off the map.
  const before = events.length;
  for (let frame = 0; frame < 60; frame += 1) {
    map.setMapToCurrentZone();
    map.tick();
  }
  assert.equal(events.length - before, 60 / FRAMEXML_MAP_REANNOUNCE_TICKS,
    "one unchanged re-announcement per window, not one per frame");

  // A moved selection is not rate-limited: browsing away and back is two immediate edges.
  const moved = events.length;
  map.setMapZoom(1);
  map.tick();
  map.setMapToCurrentZone();
  map.tick();
  assert.equal(events.length - moved, 2);
  assert.deepEqual(map.getMapInfo(), ["Elwynn"]);
});

// ---------------------------------------------------------------- tracking

test("the stock tracking C API reads the known tracking spells and the player's tracking words", () => {
  const { seam, player, fired, pump, cancelled, casts } = liveFixture();
  assert.deepEqual(call(seam, "GetNumTrackingTypes"), [2], "Огненный шар is not a tracker");
  assert.deepEqual(call(seam, "GetTrackingInfo", 1),
    ["Поиск трав", "Interface\\Icons\\INV_Misc_Flower_02", false, "spell"]);
  assert.deepEqual(call(seam, "GetTrackingInfo", 3), []);
  assert.deepEqual(call(seam, "GetTrackingTexture"), ["Interface\\Minimap\\Tracking\\None"]);

  seam.attach(pump);
  try {
    fired.length = 0;
    seam.tick(1);
    assert.equal(fired.filter(([event]) => event === "MINIMAP_UPDATE_TRACKING").length, 0,
      "nothing tracked, nothing announced");
    // SPELL_AURA_TRACK_RESOURCES sets bit (LockType - 1): herbalism is LockType 2, bit 1.
    player.fields.set(UPDATE_FIELDS.PLAYER_TRACK_RESOURCES.offset, 1 << 1);
    seam.tick(2);
    assert.deepEqual(fired.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.tracking), [["MINIMAP_UPDATE_TRACKING"]]);
    assert.deepEqual(call(seam, "GetTrackingInfo", 1)[2], true);
    assert.deepEqual(call(seam, "GetTrackingTexture"), ["Interface\\Icons\\INV_Misc_Flower_02"]);

    call(seam, "SetTracking", 2);
    assert.deepEqual(casts, [2580], "turning a tracker on is its ordinary guarded spell cast");
    call(seam, "SetTracking", 1);
    assert.deepEqual(cancelled, [2383], "the active tracker is switched off by CMSG_CANCEL_AURA");
    call(seam, "SetTracking", undefined);
    assert.deepEqual(cancelled, [2383, 2383], "SetTracking(nil) cancels every active tracker");
    assert.deepEqual(casts, [2580]);
  } finally {
    seam.detach();
  }
});

// ---------------------------------------------------------------- mail, LFG, instance

test("HasNewMail and the three senders come from MSG_QUERY_NEXT_MAIL_TIME, with UPDATE_PENDING_MAIL", () => {
  const { seam, world, fired, pump } = liveFixture();
  assert.deepEqual(call(seam, "HasNewMail"), [false]);
  seam.attach(pump);
  try {
    fired.length = 0;
    world.names.set(0x30n, "Боб");
    world.creatureTemplates.set(123, { found: true, name: "Почтальон" });
    world.nextMailTime = {
      nextMailTime: 0,
      senders: [
        { senderGuid: 0x30n, altSenderId: 0, altSenderType: 0, stationeryId: 41, timeLeft: -1 },
        { senderGuid: 0n, altSenderId: 123, altSenderType: 3, stationeryId: 41, timeLeft: -1 },
        { senderGuid: 0n, altSenderId: 2, altSenderType: 2, stationeryId: 62, timeLeft: -1 },
      ],
    };
    seam.tick(1);
    assert.deepEqual(fired.filter(([event]) => event === "UPDATE_PENDING_MAIL"), [["UPDATE_PENDING_MAIL"]]);
    assert.deepEqual(call(seam, "HasNewMail"), [true]);
    assert.deepEqual(call(seam, "GetLatestThreeSenders"), ["Боб", "Почтальон"],
      "an auction-house sender has no name this client can resolve");
    world.nextMailTime = { nextMailTime: -86_400, senders: [] };
    seam.tick(2);
    assert.equal(fired.filter(([event]) => event === "UPDATE_PENDING_MAIL").length, 2);
    assert.deepEqual(call(seam, "HasNewMail"), [false]);
  } finally {
    seam.detach();
  }
});

test("the seam asks MSG_QUERY_NEXT_MAIL_TIME at login, on a mail notice and when the mailbox closes", () => {
  // Nothing fills world.nextMailTime but the reply to this query (MailHandler.cpp:622), and
  // SMSG_RECEIVED_MAIL only replaces world.mailMessage (WorldClient.ts, SMSG_RECEIVED_MAIL).
  const { seam, world, player, pump } = liveFixture();
  const queries = [];
  world.requestNextMailTime = () => queries.push(world.mailboxGuid);
  world.mailboxGuid = 0n;
  world.mailMessage = undefined;
  world.state.objects.delete(player.guid);
  seam.attach(pump);
  try {
    seam.tick(1);
    assert.equal(queries.length, 0, "the handler is STATUS_LOGGEDIN: no player object, no query");
    world.state.objects.set(player.guid, player);
    seam.tick(2);
    assert.equal(queries.length, 1, "asked once the player is in the world");
    seam.tick(3);
    seam.tick(4);
    assert.equal(queries.length, 1, "not once per poll");
    world.nextMailTime = { nextMailTime: 0, senders: [] };
    seam.tick(5);
    assert.deepEqual(call(seam, "HasNewMail"), [true], "the reply is what HasNewMail reads");
    world.mailMessage = { text: "Вам пришло письмо", error: false };
    seam.tick(6);
    assert.equal(queries.length, 2, "SMSG_RECEIVED_MAIL's notice asks again");
    world.mailboxGuid = 0x40n;
    world.mailMessage = undefined;
    seam.tick(7);
    assert.equal(queries.length, 2, "opening the mailbox asks nothing");
    world.mailboxGuid = 0n;
    seam.tick(8);
    assert.deepEqual(queries, [0n, 0n, 0n], "closing it asks again: the server recounted unread mail");
  } finally {
    seam.detach();
  }
  seam.attach(pump);
  try {
    seam.tick(20);
    assert.equal(queries.length, 4, "a reattached seam asks for its world once more");
  } finally {
    seam.detach();
  }
});

test("GetLFGMode is derived from the finder packets and changes raise LFG_UPDATE", () => {
  assert.equal(frameXmlLfgMode({}), undefined);
  assert.deepEqual(frameXmlLfgMode({ lfgStatus: { joined: true, queued: true } }), ["queued", "empowered"]);
  assert.deepEqual(frameXmlLfgMode({ lfgStatus: { joined: true, queued: true }, inGroup: true, isGroupLeader: false }),
    ["queued", "unempowered"]);
  assert.deepEqual(frameXmlLfgMode({ lfgRoleCheck: { state: 2 }, lfgStatus: { joined: true, queued: true } }), ["rolecheck"]);
  assert.deepEqual(frameXmlLfgMode({
    lfgProposal: { state: 0, players: [{ self: true, answered: true, accepted: true }] },
  }), ["proposal", "accepted"]);
  assert.deepEqual(frameXmlLfgMode({ lfgProposal: { state: 0, players: [{ self: true, answered: false, accepted: false }] } }),
    ["proposal", "unaccepted"]);
  assert.equal(frameXmlLfgMode({ lfgProposal: { state: 1, players: [] } }), undefined, "a failed proposal is over");
  assert.deepEqual(frameXmlLfgMode({ groupType: 0x08 }), ["lfgparty"]);

  const { seam, world, fired, pump } = liveFixture();
  seam.attach(pump);
  try {
    fired.length = 0;
    seam.tick(1);
    assert.equal(fired.filter(([event]) => event === "LFG_UPDATE").length, 0);
    world.lfgStatus = { updateType: 5, joined: true, queued: true, dungeons: [261], comment: "" };
    seam.tick(2);
    seam.tick(3);
    assert.equal(fired.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.lfgUpdate).length, 1);
    assert.deepEqual(call(seam, "GetLFGMode"), ["queued", "empowered"]);
    world.lfgStatus = { updateType: 7, joined: false, queued: false, dungeons: [], comment: "" };
    seam.tick(4);
    assert.equal(fired.filter(([event]) => event === "LFG_UPDATE").length, 2);
    assert.deepEqual(call(seam, "GetLFGMode"), []);
  } finally {
    seam.detach();
  }
});

test("GetInstanceInfo answers Map.InstanceType, the selected difficulty and a measured size", () => {
  const maps = [
    { id: 0, name: "Восточные королевства", instanceType: 0 },
    { id: 36, name: "Мертвые копи", instanceType: 1 },
    { id: 631, name: "Цитадель Ледяной Короны", instanceType: 2 },
  ];
  const mapSource = { metadata: () => ({ maps }), location: () => undefined };
  const { seam, world } = liveFixture({ mapSource });
  world.mapId = 36;
  world.dungeonDifficulty = 1;
  assert.deepEqual(call(seam, "GetInstanceInfo"), ["Мертвые копи", "party", 2, "", 5, 0, false]);
  world.mapId = 631;
  world.raidDifficulty = 1;
  assert.deepEqual(call(seam, "GetInstanceInfo"), ["Цитадель Ледяной Короны", "raid", 2, "", 25, 0, false]);
  world.raidDifficulty = 0;
  assert.deepEqual(call(seam, "GetInstanceInfo"), ["Цитадель Ледяной Короны", "raid", 1, "", 10, 0, false],
    "10-player normal: Minimap.lua:486 prints 10 on the difficulty flag");
  maps.push({ id: 532, name: "Каражан", instanceType: 2 }, { id: 9000, name: "Свой рейд", instanceType: 2 },
    { id: 229, name: "Пик Черной горы", instanceType: 1 });
  world.mapId = 532;
  world.raidDifficulty = 1;
  assert.deepEqual(call(seam, "GetInstanceInfo"), ["Каражан", "raid", 1, "", 10, 0, false],
    "a 25-player selection in a one-row raid is downscaled the way the server builds the instance");
  world.mapId = 9000;
  assert.deepEqual(call(seam, "GetInstanceInfo")[4], 25, "a custom raid keeps the uniform difficulty-1 size");
  world.raidDifficulty = 0;
  assert.deepEqual(call(seam, "GetInstanceInfo"), [], "a custom raid's normal size is unknown, not invented");
  world.mapId = 229;
  world.dungeonDifficulty = 0;
  assert.deepEqual(call(seam, "GetInstanceInfo")[4], 15, "Blackrock Spire is the 15-player dungeon row");
  world.mapId = 0;
  assert.deepEqual(call(seam, "GetInstanceInfo")[1], "none");
  world.mapId = 999;
  assert.deepEqual(call(seam, "GetInstanceInfo"), [], "an unknown map row stays nil");
});

test("GetInstanceInfo's sizes are this dataset's MapDifficulty.dbc, row for row", withDataset, async () => {
  const { readFile } = await import("node:fs/promises");
  const table = async (name) => {
    const bytes = await readFile(`${dbcDirectory}/${name}`);
    const count = bytes.readUInt32LE(4);
    const size = bytes.readUInt32LE(12);
    return Array.from({ length: count }, (_, row) => (field) => bytes.readUInt32LE(20 + row * size + field * 4));
  };
  // Map.dbc: ID, Directory, InstanceType. MapDifficulty.dbc: ID, MapID, Difficulty, 17 message
  // words, RaidDuration, MaxPlayers (field 21).
  const maps = (await table("Map.dbc")).map((row) => ({ id: row(0), name: `map ${row(0)}`, instanceType: row(2) }));
  const typeOf = new Map(maps.map((map) => [map.id, map.instanceType]));
  const { seam, world } = liveFixture({ mapSource: { metadata: () => ({ maps }), location: () => undefined } });
  let checked = 0;
  for (const row of await table("MapDifficulty.dbc")) {
    const [mapId, difficulty, maxPlayers] = [row(1), row(2), row(21)];
    const type = typeOf.get(mapId);
    if (type !== 1 && type !== 2) continue;
    world.mapId = mapId;
    world.dungeonDifficulty = difficulty;
    world.raidDifficulty = difficulty;
    const info = call(seam, "GetInstanceInfo");
    // Three heroic dungeon rows say 0; the seam answers Map.MaxPlayers' 5 for them.
    assert.deepEqual([info[2], info[4]], [difficulty + 1, maxPlayers || 5], `map ${mapId} difficulty ${difficulty}`);
    checked += 1;
  }
  assert.equal(checked, 125, "86 dungeon rows and 39 raid rows");
});

// ---------------------------------------------------------------- chat text, languages, AFK

test("client-written chat keeps its pipes literal; well-formed links and colours survive", () => {
  const help = "/vehicle enter|leave|next|prev|eject — транспорт";
  const escaped = frameXmlEscapeLocalChatText(help);
  assert.equal(escaped, "/vehicle enter||leave||next||prev||eject — транспорт");
  const runs = parseFrameXmlText(escaped);
  assert.equal(runs.map((run) => run.text).join(""), help, "the stock parser shows exactly what was written");
  assert.equal(parseFrameXmlText(help).map((run) => run.text).join("").includes("\n"), true,
    "unescaped, |n in «next» is a line break — the owner's broken help line");

  const link = "Добыча: |cff1eff00|Hitem:2589:0:0:0:0:0:0:0|h[Льняная ткань]|h|r x2";
  assert.equal(frameXmlEscapeLocalChatText(link), link, "a client-built item link is untouched");
  assert.equal(frameXmlEscapeLocalChatText("a|reset"), "a||reset", "|r with no open colour is prose");
  assert.equal(frameXmlEscapeLocalChatText("x || y"), "x || y", "an escaped pipe stays one pipe");
  assert.equal(frameXmlEscapeLocalChatText("|3-6(Герой)"), "|3-6(Герой)", "a closed declension survives");
  assert.equal(frameXmlEscapeLocalChatText("|Tbroken"), "||Tbroken", "an unclosed icon is prose");
});

test("pushLocalMessage marks client lines and only those are escaped on their way to stock", () => {
  const client = Object.create(WorldClient.prototype);
  client.chatLog = [];
  client.events = new EventBus();
  const local = {
    type: CHAT_MSG_SYSTEM, language: 0, senderGuid: 0n, senderName: "", receiverGuid: 0n,
    receiverName: "", channel: "", text: "a|next", tag: 0, achievementId: 0,
  };
  client.pushLocalMessage(local);
  assert.equal(local.local, true);
  // An add-on's print: the real client hands it to DEFAULT_CHAT_FRAME:AddMessage as written.
  const printed = { ...local, local: undefined, text: "print|nline" };
  client.pushLocalMessage(printed, { markup: true });
  assert.equal(printed.local, undefined, "markup the author meant is not client prose");

  const { seam, world, fired, pump } = liveFixture();
  seam.attach(pump);
  try {
    fired.length = 0;
    world.events.emit("CHAT_MESSAGE", local);
    world.events.emit("CHAT_MESSAGE", { ...local, local: undefined, text: "server|nline" });
    world.events.emit("CHAT_MESSAGE", printed);
    assert.deepEqual(fired.map(([event, text]) => [event, text]), [
      ["CHAT_MSG_SYSTEM", "a||next"],
      ["CHAT_MSG_SYSTEM", "server|nline"],
      ["CHAT_MSG_SYSTEM", "print|nline"],
    ]);
  } finally {
    seam.detach();
  }
});

test("languages are the client's Languages.dbc names and the player's own hides the bracket", () => {
  const say = {
    type: CHAT_MSG_SAY, language: 7, senderGuid: 1n, senderName: "Кто-то", receiverGuid: 0n,
    receiverName: "", channel: "", text: "привет", tag: 0, achievementId: 0,
  };
  assert.equal(frameXmlChatEventArgs(say)[2], "всеобщий");
  assert.equal(frameXmlChatEventArgs({ ...say, language: 1 })[2], "орочий");
  assert.equal(frameXmlChatEventArgs({ ...say, language: 0 })[2], "", "Universal has no Languages.dbc row");
  assert.equal(frameXmlChatEventArgs(say, "Кто-то", 0, 0, "", undefined, "enUS")[2], "Common");

  // SkillLine 98 Common and 109 Orcish, in PLAYER_SKILL_INFO's identity words.
  const { seam, sent } = liveFixture({ race: 1, skills: [98, 109] });
  assert.deepEqual(call(seam, "GetDefaultLanguage"), ["всеобщий"]);
  assert.deepEqual(call(seam, "GetNumLanguages"), [2]);
  assert.deepEqual([call(seam, "GetLanguageByIndex", 1), call(seam, "GetLanguageByIndex", 2)],
    [["орочий"], ["всеобщий"]], "Languages.dbc order");
  call(seam, "SendChatMessage", "за Орду", "SAY", "орочий");
  assert.deepEqual(sent, [["за Орду", CHAT_MSG_SAY, 1, ""]], "stock's language name resolves to its id");

  forgetCreationNames();
  try {
    const custom = liveFixture({ race: 12 });
    learnCreationNames([{ id: 12, name: "Орк Скверны", clientFileString: "FelOrc", baseLanguage: 7 }], []);
    assert.deepEqual(call(custom.seam, "GetDefaultLanguage"), ["всеобщий"],
      "a TSWoW race speaks its ChrRaces.BaseLanguage, not the compiled Alliance-set guess");
    assert.deepEqual(call(custom.seam, "GetNumLanguages"), [1], "no skill words yet: the racial one");
  } finally {
    forgetCreationNames();
  }
});

// This pins the seam half only. The mount forwards to WorldClient.sendChat, whose `!text` guard
// still drops an empty AFK/DND before CMSG_MESSAGECHAT; that guard is outside this seam.
test("AFK and DND reach the host sender with the empty message stock /afk and /dnd send", () => {
  assert.equal(FRAMEXML_CHAT_OUTBOUND_TYPES.AFK, 0x17);
  assert.equal(FRAMEXML_CHAT_OUTBOUND_TYPES.DND, 0x18);
  const { seam, sent } = liveFixture();
  call(seam, "SendChatMessage", "", "AFK");
  call(seam, "SendChatMessage", "обед", "DND");
  call(seam, "SendChatMessage", "", "SAY");
  assert.deepEqual(sent, [["", 0x17, undefined, ""], ["обед", 0x18, undefined, ""]],
    "an empty SAY is still refused");
  const cannedSent = [];
  const canned = new CannedWorldSeam(undefined, (...args) => cannedSent.push(args));
  call(canned, "SendChatMessage", "", "AFK");
  assert.deepEqual(cannedSent, [["", 0x17, undefined, ""]]);
});

// ---------------------------------------------------------------- the add-on stub plan

test("a global captured into a same-named local and then called is planned as host API", () => {
  // AnyIDTooltip core.lua:1-4, verbatim in shape: a three-line multi-assignment.
  const source = [
    "local hooksecurefunc, select, UnitBuff, UnitDebuff, UnitAura, UnitGUID,",
    "      GetGlyphSocketInfo, tonumber, strfind",
    "    = hooksecurefunc, select, UnitBuff, UnitDebuff, UnitAura, UnitGUID,",
    "      GetGlyphSocketInfo, tonumber, strfind",
    "local ChatFrame1 = ChatFrame1",
    "local Frob, Other = Frob, Lib.Other",
    "GameTooltip:HookScript('OnTooltipSetUnit', function(self)",
    "  local guid = UnitGUID('mouseover') or ''",
    "  Frob(guid); Other(guid); ChatFrame1:AddMessage(guid)",
    "end)",
  ].join("\n");
  const plan = frameXmlStubPlan([{ file: "interface/addons/anyidtooltip/core.lua", source }]);
  assert.ok(plan.apiNames.has("UnitGUID"), "the captured, called UnitGUID is host API");
  assert.ok(plan.apiNames.has("Frob"), "position one of `local Frob, Other = Frob, Lib.Other`");
  assert.ok(!plan.apiNames.has("Other"), "Other aliases Lib.Other, not a global");
  assert.ok(!plan.apiNames.has("ChatFrame1"), "a captured widget that is never called stays nil");
  assert.ok(!plan.apiNames.has("tonumber"), "Lua's own names are never planned");
  const local = frameXmlStubPlan([{ file: "x.lua", source: "local function Helper() end\nHelper()" }]);
  assert.ok(!local.apiNames.has("Helper"), "a real local function is still the chunk's own");
});
