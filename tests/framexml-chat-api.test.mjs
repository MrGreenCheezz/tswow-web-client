import assert from "node:assert/strict";
import test from "node:test";

// The stock chat C-API against a recording world. No MPQ and no Lua: the bindings are plain
// functions taking Lua's decoded arguments, so each one is called here the way stock
// `ChatFrame.lua` calls it and the WorldClient method it reaches is asserted.
const {
  installFrameXmlChatApi, frameXmlSecureCmdOptionParse, frameXmlWhoRequest, installFrameXmlStockChat,
} = await import("../dist/code/browser/framexml/FrameXmlChatApi.js");
const { chatInputReplaced, insertChatLink } = await import("../dist/code/browser/ui/ChatInputOwner.js");
const { FRAMEXML_SEAM_NAMES } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { SOCIAL_FLAG_FRIEND, SOCIAL_FLAG_IGNORED } = await import("../dist/code/world/ContactProtocol.js");

function fakeWorld() {
  const calls = [];
  const listeners = new Map();
  const methods = [
    "selectTarget", "sendTextEmote", "setStandState", "joinChannel", "leaveChannel",
    "requestChannelList", "kickChannelMember", "banChannelMember", "unbanChannelMember",
    "inviteChannelMember", "setChannelOwner", "setChannelPassword", "setChannelModerator",
    "unsetChannelModerator", "muteChannelMember", "unmuteChannelMember", "toggleChannelAnnounce",
    "rollDice", "inviteToGroup", "removeFromGroup", "leaveGroup", "setGroupLeader", "resetInstances",
    "inviteToGuild", "removeGuildMember",
    "promoteGuildMember", "demoteGuildMember", "setGuildMotd", "leaveGuild", "requestGuildInfo",
    "setGuildLeader", "addFriend", "removeFriend", "addIgnore", "removeIgnore", "requestWho",
    "startTrade", "requestPlayedTime", "leaveVehicle", "setRaidTarget", "startReadyCheck",
    "requestLogout", "startAttack", "stopAttack",
  ];
  const world = {
    calls,
    emotes: { emotes: [
      { id: 34, command: "dance", emoteId: 10, text: {} },
      { id: 86, command: "sit", emoteId: 13, text: {} },
    ] },
    targetGuid: 0x42n,
    state: { selfGuid: 1n, objects: new Map([
      [1n, { typeId: 4 }], [0x42n, { typeId: 4 }], [0x50n, { typeId: 3 }],
    ]) },
    channels: new Map([
      ["Общий - Элвиннский лес", { flags: 0x18, count: 3, members: [] }],
      ["Торговля - Город", { flags: 0x3c, count: 3, members: [] }],
      ["myroom", { flags: 0x01, count: 1, members: [] }],
    ]),
    group: { members: [{ name: "Self", guid: 1n }, { name: "Bob", guid: 0x77n }] },
    contacts: { flags: 7, contacts: [
      { guid: 0x90n, flags: SOCIAL_FLAG_FRIEND, note: "", status: 0, areaId: 0, level: 0, classId: 0 },
      { guid: 0x91n, flags: SOCIAL_FLAG_IGNORED, note: "", status: 0, areaId: 0, level: 0, classId: 0 },
    ] },
    raidTargets: new Map([[3, 0x42n]]),
    playedTime: undefined,
    events: {
      on(name, listener) {
        listeners.set(name, listener);
        return () => listeners.delete(name);
      },
      fire(name) { listeners.get(name)?.({}); },
      listening(name) { return listeners.has(name); },
    },
    displayName: (guid) => ({ 1n: "Self", 0x42n: "Target", 0x50n: "Wolf", 0x77n: "Bob", 0x90n: "Pal", 0x91n: "Pest" })[guid] ?? "",
    challengeDuelToSelection() { calls.push(["challengeDuelToSelection"]); return true; },
  };
  for (const name of methods) world[name] = (...args) => { calls.push([name, ...args]); };
  return world;
}

function install(world, extra = {}) {
  const globals = new Map();
  const chunks = [];
  const notices = [];
  const cast = [];
  const used = [];
  const events = [];
  const vm = {
    registerGlobal(name, binding) {
      assert.equal(globals.has(name), false, `${name} is registered once`);
      globals.set(name, binding);
    },
    execute(source, chunk) { chunks.push({ source, chunk }); return { ok: true }; },
  };
  const result = installFrameXmlChatApi(vm, {
    world: () => world,
    notice: (text) => notices.push(text),
    cast: (argument) => cast.push(argument),
    use: (argument) => used.push(argument),
    unitGuid: (unit) => ({ target: world.targetGuid, player: 1n, self: 1n })[unit],
    dispatchEvent: (event, ...args) => events.push([event, ...args]),
    ...extra,
  });
  const call = (name, ...args) => {
    const binding = globals.get(name);
    assert.ok(binding, `${name} is bound`);
    return binding(args);
  };
  return { result, globals, chunks, notices, cast, used, events, call };
}

test("the chat API binds every name its slash bodies need and never a seam-owned one", () => {
  const { result, globals, chunks } = install(fakeWorld());
  for (const name of [
    "DoEmote", "JoinChannelByName", "JoinPermanentChannel", "LeaveChannelByName", "ListChannelByName",
    "ListChannels", "GetChannelList", "GetChannelName", "EnumerateServerChannels", "RandomRoll",
    "InviteUnit", "UninviteUnit", "LeaveParty", "PromoteToLeader", "ResetInstances",
    "GuildInvite", "GuildUninvite", "GuildPromote", "GuildDemote",
    "GuildSetMOTD", "GuildLeave", "GuildInfo", "GuildSetLeader", "AddFriend", "RemoveFriend",
    "AddIgnore", "DelIgnore", "AddOrDelIgnore", "SendWho", "StartDuel", "InitiateTrade",
    "RequestTimePlayed", "VehicleExit", "SetRaidTarget", "DoReadyCheck", "ChannelInvite",
    "ChannelKick", "ChannelBan", "ChannelUnban", "ChannelModerator", "ChannelUnmoderator",
    "ChannelMute", "ChannelUnmute", "SetChannelOwner", "SetChannelPassword",
    "ChannelToggleAnnouncements", "CastSpellByName", "UseItemByName", "TargetByName",
    "SecureCmdOptionParse", "StartAttack", "StopAttack",
  ]) assert.ok(globals.has(name), `${name} is bound`);
  const seamNames = new Set(FRAMEXML_SEAM_NAMES);
  for (const name of result.installed) assert.equal(seamNames.has(name), false, `${name} is also a seam binding`);
  assert.ok(result.installed.includes("RunScript"));
  assert.match(chunks[0].source, /RunScript = function\(source\)/);
  assert.match(chunks[0].source, /geterrorhandler\(\)\(failure\)/, "a syntax error reaches the corpus handler");
  // ConsoleExec is Lua too, so stock /reload (`ConsoleExec("reloadui")`) reaches ReloadUI at call time.
  assert.ok(result.installed.includes("ConsoleExec"));
  assert.match(chunks[1].source, /ConsoleExec = function\(command\)/);
  assert.match(chunks[1].source, /wanted == "reloadui" and type\(ReloadUI\) == "function"/);

  const reserved = install(fakeWorld(), { reserved: ["DoEmote", "RunScript", "ConsoleExec"] });
  assert.equal(reserved.globals.has("DoEmote"), false, "a reserved name is left to its owner");
  assert.deepEqual([...reserved.result.skipped].sort(), ["ConsoleExec", "DoEmote", "RunScript"]);
  assert.equal(reserved.chunks.length, 0);
  assert.equal(reserved.globals.has("__webclientConsoleUnavailable"), false);
});

test("DoEmote maps the stock token to EmotesText and keeps the stand-state rule", () => {
  const world = fakeWorld();
  const { call, notices } = install(world);
  call("DoEmote", "DANCE", "");
  call("DoEmote", "SIT");
  call("DoEmote", "DANCE", "Wolf");
  call("DoEmote", "DANCE", "Nobody");
  assert.deepEqual(world.calls, [
    ["sendTextEmote", 34, 0x42n],
    ["sendTextEmote", 86, 0x42n], ["setStandState", 1],
    ["sendTextEmote", 34, 0x50n],
    ["sendTextEmote", 34, 0n],
  ]);
  call("DoEmote", "NOSUCH");
  assert.match(notices.at(-1), /nosuch/);
  world.emotes = undefined;
  call("DoEmote", "DANCE");
  assert.match(notices.at(-1), /ещё не загружен/);
});

test("channel calls resolve numbers and short names in WorldClient.channels order", () => {
  const world = fakeWorld();
  const { call, notices } = install(world);
  assert.deepEqual(call("JoinPermanentChannel", "x", "pw", 1, 1), [0, "x"]);
  assert.deepEqual(call("JoinChannelByName", "", ""), []);
  call("LeaveChannelByName", "2");
  call("LeaveChannelByName", "общий");
  call("ListChannelByName", "myroom");
  call("ChannelKick", "3", "Bob");
  call("ChannelToggleAnnouncements", "myroom");
  call("SetChannelPassword", "myroom", "secret");
  call("ChannelInvite", "9", "Bob");
  assert.deepEqual(world.calls, [
    ["joinChannel", "x", "pw"],
    ["leaveChannel", "Торговля - Город"],
    ["leaveChannel", "Общий - Элвиннский лес"],
    ["requestChannelList", "myroom"],
    ["kickChannelMember", "myroom", "Bob"],
    ["toggleChannelAnnounce", "myroom"],
    ["setChannelPassword", "myroom", "secret"],
  ], "channel 9 does not exist and sends nothing");
  assert.deepEqual(call("GetChannelName", 1), [1, "Общий", 0]);
  assert.deepEqual(call("GetChannelName", "2"), [2, "Торговля", 0]);
  assert.deepEqual(call("GetChannelName", "myroom"), [3, "myroom", 0]);
  assert.deepEqual(call("GetChannelName", "nothere"), [0]);
  assert.deepEqual(call("GetChannelList"), [1, "Общий", 2, "Торговля", 3, "myroom"]);
  assert.deepEqual(call("EnumerateServerChannels"), ["Общий", "Торговля"], "custom channels are not server channels");
  call("ListChannels");
  assert.equal(notices.at(-1), "Каналы: [1. Общий] [2. Торговля] [3. myroom]");
});

test("group, guild, friend and ignore calls take a name, a unit token or the target", () => {
  const world = fakeWorld();
  const { call, notices } = install(world);
  call("RandomRoll", "1", "100");
  call("RandomRoll", "50", "10");
  call("InviteUnit", "Foo");
  call("InviteUnit", "target");
  call("UninviteUnit", "bob");
  call("UninviteUnit", "Stranger");
  call("GuildInvite", "Foo");
  call("GuildUninvite", "Foo");
  call("GuildPromote", "Foo");
  call("GuildDemote", "Foo");
  call("GuildSetLeader", "Foo");
  call("GuildSetMOTD", "motd");
  call("GuildLeave");
  call("GuildInfo");
  call("AddFriend", "Foo", "note");
  call("RemoveFriend", "pal");
  call("AddOrRemoveFriend", "Pal", "");
  call("AddOrRemoveFriend", undefined, undefined);
  call("AddIgnore", "Foo");
  call("DelIgnore", "Pest");
  call("AddOrDelIgnore", "Pest");
  call("AddOrDelIgnore", "Other");
  assert.deepEqual(world.calls, [
    ["rollDice", 1, 100], ["rollDice", 10, 50],
    ["inviteToGroup", "Foo"], ["inviteToGroup", "Target"],
    // 5.25: with the reason argument (none here), as Wow.exe UninviteUnit sends it.
    ["removeFromGroup", 0x77n, ""],
    ["inviteToGuild", "Foo"], ["removeGuildMember", "Foo"], ["promoteGuildMember", "Foo"],
    ["demoteGuildMember", "Foo"], ["setGuildLeader", "Foo"], ["setGuildMotd", "motd"],
    ["leaveGuild"], ["requestGuildInfo"],
    ["addFriend", "Foo", "note"], ["removeFriend", 0x90n], ["removeFriend", 0x90n],
    ["addFriend", "Target", ""],
    ["addIgnore", "Foo"], ["removeIgnore", 0x91n], ["removeIgnore", 0x91n], ["addIgnore", "Other"],
  ]);
  assert.match(notices.join("\n"), /Stranger нет в вашей группе/);
});

test("the unit menus' LEAVE and PROMOTE, /promote and the instance-reset popup reach their packets", () => {
  // UnitPopup.lua:1272 `LeaveParty()`, :1248 `PromoteToLeader(unit, 1)`, ChatFrame.lua:1478
  // `PromoteToLeader(msg)`, StaticPopup.lua:418 `ResetInstances()`: all three answered from the stub
  // floor before, so «Покинуть группу» closed its menu and sent nothing.
  const world = fakeWorld();
  const { call, notices } = install(world);
  call("LeaveParty");
  call("PromoteToLeader", "party1", 1);
  call("PromoteToLeader", "bob");
  call("PromoteToLeader", "Stranger");
  call("PromoteToLeader", "");
  call("ResetInstances");
  world.group = undefined;
  call("LeaveParty");
  assert.deepEqual(world.calls, [
    ["leaveGroup"],
    ["setGroupLeader", 0x77n], ["setGroupLeader", 0x77n],
    ["resetInstances"],
    ["leaveGroup"],
  ], "LeaveParty asks even with no group known: the core also cancels a pending invite with it");
  assert.match(notices.join("\n"), /Stranger нет в вашей группе/);
  assert.match(notices.at(-1), /Укажите имя участника группы/);
});

test("who, duel, trade, vehicle, raid markers, ready check and the secure commands", () => {
  const world = fakeWorld();
  const { call, cast, used, notices } = install(world);
  call("SendWho", 'n-"Bob" 10-20 g-"Guild" Stormwind');
  call("StartDuel", "");
  call("StartDuel", "Wolf");
  call("InitiateTrade", "target");
  call("VehicleExit");
  call("SetRaidTarget", "target", 1);
  call("SetRaidTarget", "target", 0);
  call("DoReadyCheck");
  call("TargetByName", "wol");
  call("TargetByName", "wol", 1);
  call("TargetByName", "Wolf", 1);
  assert.deepEqual(world.calls, [
    ["requestWho", { name: "Bob", guild: "Guild", levelMin: 10, levelMax: 20, words: ["Stormwind"] }],
    ["challengeDuelToSelection"],
    ["startTrade", 0x42n],
    ["leaveVehicle"],
    ["setRaidTarget", 0, 0x42n],
    ["setRaidTarget", 3, 0n],
    ["startReadyCheck"],
    ["selectTarget", 0x50n],
    ["selectTarget", 0x50n],
  ], "an exact TargetByName does not take a prefix; a duel is only ever the current target");
  assert.match(notices[0], /выберите игрока целью/);
  call("CastSpellByName", "Огненный шар", "focus");
  call("CastSpellByName", "133");
  call("UseItemByName", "Камень здоровья");
  assert.deepEqual(cast, ["[@focus] Огненный шар", "133"]);
  assert.deepEqual(used, ["Камень здоровья"]);
  call("__webclientConsoleUnavailable", "foo");
  assert.match(notices.at(-1), /Консоль клиента недоступна.*«foo»/);
});

test("/startattack and /stopattack reach melee, selecting another unit first", () => {
  const world = fakeWorld();
  const { call } = install(world);
  call("StartAttack", "");
  call("StartAttack", "target");
  call("StartAttack", "Wolf");
  call("StartAttack", "Nobody");
  call("StopAttack");
  assert.deepEqual(world.calls, [
    ["startAttack"], ["startAttack"],
    ["selectTarget", 0x50n], ["startAttack"],
    ["stopAttack"],
  ], "a bare /startattack is the current target; an absent name attacks nothing");
});

test("/played fires TIME_PLAYED_MSG when the answer lands, once", () => {
  const world = fakeWorld();
  const { call, events, result } = install(world);
  call("RequestTimePlayed");
  assert.deepEqual(world.calls, [["requestPlayedTime"]]);
  world.events.fire("CHARACTER_SHEET_CHANGED");
  assert.deepEqual(events, [], "an unrelated sheet change is not the answer");
  world.playedTime = { total: 3600, atLevel: 60 };
  world.events.fire("CHARACTER_SHEET_CHANGED");
  world.events.fire("CHARACTER_SHEET_CHANGED");
  assert.deepEqual(events, [["TIME_PLAYED_MSG", 3600, 60]]);
  call("RequestTimePlayed");
  assert.equal(world.events.listening("CHARACTER_SHEET_CHANGED"), true);
  result.dispose();
  assert.equal(world.events.listening("CHARACTER_SHEET_CHANGED"), false, "dispose drops a pending request");
});

test("SecureCmdOptionParse answers only the clauses it can decide", () => {
  assert.deepEqual(frameXmlSecureCmdOptionParse(""), [""], "an empty /dismount still goes");
  assert.deepEqual(frameXmlSecureCmdOptionParse("Огненный шар"), ["Огненный шар"]);
  assert.deepEqual(frameXmlSecureCmdOptionParse("[@focus] Превращение"), ["Превращение", "focus"]);
  assert.deepEqual(frameXmlSecureCmdOptionParse("[target=party1] Исцеление; Лечение"), ["Исцеление", "party1"]);
  assert.deepEqual(frameXmlSecureCmdOptionParse("Первое; Второе"), ["Первое"]);
  assert.deepEqual(frameXmlSecureCmdOptionParse("[combat] show; hide"), [],
    "an unevaluated condition answers nil, as the stub floor did, rather than guessing a state");
  assert.deepEqual(frameXmlSecureCmdOptionParse("[@mouseover,harm] X"), []);
  assert.deepEqual(frameXmlSecureCmdOptionParse("[bad"), []);
  // Bracket groups are alternatives and the first one that holds wins: a target-only group always
  // holds, so the first group's target is the answer, not the last one's.
  assert.deepEqual(frameXmlSecureCmdOptionParse("[@focus][@target] Исцеление"), ["Исцеление", "focus"]);
  assert.deepEqual(frameXmlSecureCmdOptionParse("[][@focus] Исцеление"), ["Исцеление"]);
  assert.deepEqual(frameXmlSecureCmdOptionParse("[combat][@target] Исцеление"), [],
    "a first group that cannot be decided still answers nil");
  assert.deepEqual(frameXmlSecureCmdOptionParse("[@focus][bad Исцеление"), []);
});

test("the who query language reaches CMSG_WHO's fields", () => {
  assert.deepEqual(frameXmlWhoRequest("Bob"), { name: "Bob" }, "one bare word is a name, as native /who has it");
  assert.deepEqual(frameXmlWhoRequest("80"), { levelMin: 80, levelMax: 80 });
  // A race or class is CMSG_WHO's mask, bit 1 << id as the core tests it (MiscHandler.cpp:403-411):
  // its free words match only name, guild and zone (:443-450). Маг is class 8.
  assert.deepEqual(frameXmlWhoRequest('z-"Элвиннский лес" c-Маг 70 - 80'),
    { levelMin: 70, levelMax: 80, classMask: 1 << 8, words: ["Элвиннский лес"] });
  assert.deepEqual(frameXmlWhoRequest("a b c d e"), { words: ["a", "b", "c", "d"] }, "four words at most");
  // ruRU's WHO_TAG_* (GlobalStrings.lua:8941-8945), as WhoFrame_GetDefaultWhoCommand spells a bare /who:
  // a lone tagged zone is a zone word, never the name.
  assert.deepEqual(frameXmlWhoRequest('з-"Элвиннский лес" 57-63'),
    { levelMin: 57, levelMax: 63, words: ["Элвиннский лес"] });
  assert.deepEqual(frameXmlWhoRequest('И-"Боб" g-"Стражи" р-Человек к-Маг'),
    { name: "Боб", guild: "Стражи", raceMask: 1 << 1, classMask: 1 << 8 });
  assert.deepEqual(frameXmlWhoRequest('р-"ночной эльф" р-Дреней к-"Рыцарь смерти" 80'),
    { levelMin: 80, levelMax: 80, raceMask: (1 << 4) | (1 << 11), classMask: 1 << 6 }, "case-insensitive, and tags add up");
  assert.deepEqual(frameXmlWhoRequest("к-Жрица"), { words: ["Жрица"] },
    "a class this client cannot name stays a free word, never the name");
  assert.deepEqual(frameXmlWhoRequest(""), {});
});

test("no world means no calls and no throws", () => {
  const { call } = install(undefined);
  for (const name of ["DoEmote", "RandomRoll", "InviteUnit", "SendWho", "VehicleExit", "RequestTimePlayed",
    "LeaveParty", "PromoteToLeader", "ResetInstances"]) {
    assert.deepEqual(call(name, "x"), []);
  }
  assert.deepEqual(call("GetChannelName", 1), [0]);
  assert.deepEqual(call("GetChannelList"), []);
});

function fakeStockHost({ functions = true, input = true, insertAnswer = [], withUpdate = false } = {}) {
  const frames = new Map([
    ["ChatFrame1EditBox", { name: "ChatFrame1EditBox", type: "EditBox" }],
    ["ChatFrame2", { name: "ChatFrame2", type: "ScrollingMessageFrame" }],
  ]);
  const added = [];
  const scheduled = [];
  const globals = new Map();
  const chunks = [];
  const updates = [];
  const vm = {
    registerGlobal(name, binding) { globals.set(name, binding); },
    execute(source, chunk) { chunks.push(chunk); return { ok: true }; },
    globalFunction(name) { return functions || name.startsWith("__webclient") ? { name } : undefined; },
    call(ref) {
      if (ref.name === "__webclientInsertChatLink") return insertAnswer;
      return ref.name === "__webclientOpenChat" ? [frames.get("ChatFrame1EditBox")] : [];
    },
    release() {},
  };
  const bridge = {
    getFrame: (name) => frames.get(name),
    runInMutationBatch: (operation) => operation(),
    isVisible: () => true,
    dispatchEvent: () => 0,
    AddMessage: (frame, text, r, g, b) => { added.push([frame.name, text, r, g, b]); return true; },
    ...(withUpdate ? {
      update(frame, mutate) {
        const mutable = { textInsets: undefined, justifyH: "CENTER" };
        mutate(mutable);
        updates.push([frame.name, mutable]);
        return true;
      },
    } : {}),
  };
  const field = { value: "", focused: 0, ownerDocument: { activeElement: null }, focus() { this.focused += 1; }, setSelectionRange() {} };
  return {
    host: { vm, bridge, inputFor: () => (input ? field : undefined), schedule: (callback) => scheduled.push(callback) },
    added, scheduled, field, globals, chunks, updates, frames,
  };
}

function stockDeps(extra = {}) {
  return {
    world: () => undefined, notice() {}, cast() {}, use() {}, unitGuid: () => undefined,
    commands: () => [], emotes: () => undefined, run: () => true,
    ...extra,
  };
}

test("the stock chat owner installs only over a real edit box and the Lua that opens it", () => {
  assert.equal(installFrameXmlStockChat(fakeStockHost({ functions: false }).host, stockDeps(), () => {}), undefined,
    "no ChatFrame_OpenChat, no owner");
  assert.equal(installFrameXmlStockChat(fakeStockHost({ input: false }).host, stockDeps(), () => {}), undefined,
    "no rendered input, no owner");
  assert.equal(chatInputReplaced(), false);
  const { host, field } = fakeStockHost();
  const release = installFrameXmlStockChat(host, stockDeps(), () => {});
  assert.equal(typeof release, "function");
  assert.equal(chatInputReplaced(), true);
  release();
  release();
  assert.equal(chatInputReplaced(), false, "the cleanup is idempotent and hands the keys back");
  assert.equal(field.focused, 0);
});

test("the chat box's header insets are stock's own: no ChatEdit_UpdateHeader post-hook, no model writes", () => {
  // Stock SetTextInsets writes the frame model, an EditBox is LEFT-justified and the header's
  // GetWidth is current, so the post-hook that once wrote the same numbers is gone (measured
  // identical on the index.html route and the MPQ corpus): a host that can mutate the model gets none.
  const { host, globals, chunks, updates } = fakeStockHost({ withUpdate: true });
  const release = installFrameXmlStockChat(host, stockDeps(), () => {});
  try {
    assert.equal(typeof release, "function", "the owner installs");
    assert.ok(!chunks.includes("@webclient/chat-api:insets"), "no post-hook chunk");
    assert.equal(globals.has("__webclientChatEditInsets"), false, "no insets host function");
    assert.deepEqual(updates, [], "nothing written to the frame model");
  } finally {
    release();
  }
});

test("a link stock gave to the Auction House search or a macro is handled, not a failed owner", () => {
  // `__webclientInsertChatLink` answers `true` when stock ChatEdit_InsertLink took the link with no
  // chat box open (BrowseName / MacroFrameText, ChatFrame.lua:3496-3526).
  const handled = fakeStockHost({ insertAnswer: [true] });
  let failures = 0;
  const release = installFrameXmlStockChat(handled.host, stockDeps(), () => { failures += 1; });
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(insertChatLink("|Hitem:2589|h[Льняная ткань]|h"), true);
    assert.equal(failures, 0, "the native form is not brought back");
    assert.equal(chatInputReplaced(), true, "the stock owner keeps the chat keys");
    assert.equal(handled.field.focused, 0, "there is no chat box to focus");
  } finally {
    release();
  }
  // No box and nothing took the link: that one is a failed owner, and it is handed back.
  const unhandled = fakeStockHost({ insertAnswer: [] });
  const releaseUnhandled = installFrameXmlStockChat(unhandled.host, stockDeps(), () => { failures += 1; });
  try {
    insertChatLink("|Hitem:2589|h[Льняная ткань]|h");
    assert.equal(failures, 1);
    assert.equal(chatInputReplaced(), false);
  } finally {
    console.warn = warn;
    releaseUnhandled();
  }
});

test("native combat lines reach ChatFrame2 only while the seam gives window 2 a tab, one batch per frame", () => {
  const { host, added, scheduled } = fakeStockHost();
  let listener;
  let enabled = false;
  const release = installFrameXmlStockChat(host, stockDeps({
    onCombatEntry: (next) => { listener = next; return () => { listener = undefined; }; },
    combatWindowEnabled: () => enabled,
  }), () => {});
  try {
    listener({ text: "ignored while hidden", kind: "dealt" });
    assert.equal(scheduled.length, 0);
    enabled = true;
    listener({ text: "Волк наносит вам 12 ед. урона", kind: "taken" });
    listener({ text: "a|b", kind: "unknown-kind" });
    assert.equal(scheduled.length, 1, "two lines, one scheduled flush");
    scheduled.shift()();
    assert.deepEqual(added.map(([frame, text]) => [frame, text]), [
      ["ChatFrame2", "Волк наносит вам 12 ед. урона"], ["ChatFrame2", "a||b"],
    ]);
    assert.deepEqual(added[0].slice(2).map((value) => Math.round(value * 255)), [0xe0, 0x8a, 0x7a],
      "the native .combat-line.taken colour");
    release();
    assert.equal(listener, undefined, "the cleanup unsubscribes");
  } finally {
    release();
  }

  // A window that already has its tab at install gets the native tab's newest history first.
  const later = fakeStockHost();
  const releaseLater = installFrameXmlStockChat(later.host, stockDeps({
    onCombatEntry: () => () => {},
    combatHistory: () => [{ text: "раньше", kind: "dealt" }, { text: "ещё раньше", kind: "crit" }],
    combatWindowEnabled: () => true,
  }), () => {});
  try {
    assert.equal(later.scheduled.length, 1);
    later.scheduled.shift()();
    assert.deepEqual(later.added.map(([, text]) => text), ["раньше", "ещё раньше"]);
  } finally {
    releaseLater();
  }
});
