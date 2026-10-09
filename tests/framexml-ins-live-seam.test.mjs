import assert from "node:assert/strict";
import test from "node:test";

// LiveWorldSeam's three LoD-window models over a real item and unit projection: socketing reads the
// equipped item's template sockets and enchantments, stages a carried gem from the bag cursor, splits
// a stack into a free ordinary-bag slot and sends CMSG_SOCKET_GEMS (FrameXmlSocketLive.ts); inspection
// reads the target's visible items, then SMSG_INSPECT_TALENT's, its talents over the talent metadata,
// honor and arena teams (FrameXmlInspectLive.ts); the barber reads the appearance bytes, the stand
// state and the three gateway tables (FrameXmlBarberLive.ts).

const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { EventBus } = await import("../dist/code/world/EventBus.js");
const { game } = await import("../dist/code/browser/game/Context.js");
const { itemEnchantments } = await import("../dist/code/browser/ItemEnchantments.js");

const call = (name, seam, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);
const field = (name) => UPDATE_FIELDS[name].offset;

function place(fields, offset, guid) {
  fields.set(offset, Number(guid & 0xffffffffn));
  fields.set(offset + 1, Number(guid >> 32n));
}

function item(guid, entry, extra = []) {
  return { guid, typeId: 1, fields: new Map([[field("OBJECT_FIELD_ENTRY"), entry], ...extra]) };
}

const template = (name, fields = {}) => ({
  found: true, name, quality: 4, itemClass: 3, subClass: 0, bagFamily: 0, gemProperties: 0, sockets: [], ...fields,
});

const ORIGIN = "http://ins-live.test";

function fixture() {
  // A level-80 tauren (race 6) warrior (class 1), male; horns 1, colour 0, skin 3, facial 2; on a low chair.
  const player = {
    guid: 1n, typeId: 4, position: { x: 0, y: 0, z: 0 },
    fields: new Map([
      [field("UNIT_FIELD_BYTES_0"), 0x0106], [field("UNIT_FIELD_LEVEL"), 80],
      [field("PLAYER_BYTES"), 0x0001_0003], [field("PLAYER_BYTES_2"), 2], [field("UNIT_FIELD_BYTES_1"), 4],
    ]),
  };
  // Head: sockets meta/red/yellow, the meta one holding enchantment 3621.
  const helm = item(10n, 900001, [[field("ITEM_FIELD_ENCHANTMENT_1_1") + 2 * 3, 3621]]);
  place(player.fields, field("PLAYER_FIELD_INV_SLOT_HEAD"), helm.guid);
  const ruby = item(2n, 40111, [[field("ITEM_FIELD_STACK_COUNT"), 1]]);
  const amber = item(3n, 40128, [[field("ITEM_FIELD_STACK_COUNT"), 3]]);
  place(player.fields, field("PLAYER_FIELD_PACK_SLOT_1"), ruby.guid);
  place(player.fields, field("PLAYER_FIELD_PACK_SLOT_1") + 2, amber.guid);
  // A friendly level-80 human mage 10 yards away, wearing the crown with permanent enchantment 3820.
  const target = {
    guid: 0x20n, typeId: 4, position: { x: 6, y: 8, z: 0 },
    fields: new Map([[field("UNIT_FIELD_BYTES_0"), 0x0801], [field("UNIT_FIELD_LEVEL"), 80],
      [field("PLAYER_VISIBLE_ITEM_1_ENTRYID"), 40416], [field("PLAYER_VISIBLE_ITEM_1_ENTRYID") + 1, 3820]]),
  };
  const sent = [];
  const events = new EventBus();
  const world = {
    events,
    state: { selfGuid: player.guid, objects: new Map([player, helm, ruby, amber, target].map((object) => [object.guid, object])) },
    names: new Map(), selfName: "Игрок", targetGuid: target.guid,
    itemTemplates: new Map([
      [900001, template("Шлем гранильщика", { sockets: [{ color: 1 }, { color: 2 }, { color: 4 }] })],
      [40111, template("Рельефный багровый рубин", { gemProperties: 1287 })],
      [40128, template("Мягкий царский янтарь", { gemProperties: 1304 })],
      [41285, template("Хаотический алмаз небесного сияния", { quality: 3, gemProperties: 1381 })],
      [40416, template("Доблестный венец ледяного огня")],
    ]),
    itemTemplate: (entry) => world.itemTemplates.get(entry),
    casts: new Map(), channels: new Map(), actionButtons: [], creatureTemplates: new Map(), questTemplates: new Map(),
    cooldownRemaining: () => 0,
    socketGems: (...args) => sent.push(["socket", ...args]),
    splitItem: (...args) => sent.push(["split", ...args]),
    inspections: new Map(), inspectedHonor: new Map(), inspectedArenaTeams: new Map(), arenaTeams: new Map(),
    inspect: (guid) => sent.push(["inspect", guid]),
    inspectHonor: (guid) => sent.push(["honor", guid]),
    inspectArenaTeams: (guid) => sent.push(["arena", guid]),
    requestArenaTeam: (id) => sent.push(["team", id]),
    barberShopOpen: false,
    alterAppearance: (...args) => sent.push(["alter", ...args]),
    setStandState: (state) => sent.push(["stand", state]),
  };
  // As the mount's metadata: a talent is named by its spell once the spell cache has it (FrameXmlWorldMount.ts).
  const spellNames = new Map();
  const metadata = {
    ready: true,
    get revision() { return 1 + spellNames.size; },
    tabsForClass: (classId) => classId === 8
      ? [{ id: 41, name: "Огонь", orderIndex: 0, iconPath: "Interface\\Icons\\Spell_Fire_FlameBolt", background: "MageFire" }] : [],
    talentsIn: (tab) => tab === 41 ? [{
      id: 100, tabId: 41, tier: 0, column: 0, ranks: [11, 12, 13], prerequisites: [], name: spellNames.get(11) ?? "Талант 100",
    }] : [],
  };
  const prefetched = [];
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: () => undefined,
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {},
    itemInfo: (entry) => world.itemTemplates.has(entry) ? { name: world.itemTemplates.get(entry).name, quality: 4 } : undefined,
    itemTexture: (entry) => `Interface\\Icons\\Item_${entry}`,
    talentMetadata: () => metadata,
    prefetchQuestMetadata: (itemIds, spellIds, onChanged) => prefetched.push([itemIds, spellIds, onChanged]),
  });
  const fired = [];
  const pump = { fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => 0 };
  for (const model of [seam.socket, seam.inspect, seam.barber]) model.attach(pump);
  return { world, seam, sent, fired, events, player, target, spellNames, prefetched };
}

function withGems(run) {
  const previous = game.gatewayOrigin;
  game.gatewayOrigin = ORIGIN;
  const index = itemEnchantments(ORIGIN);
  // GemProperties 1287/1304/1381 and their SpellItemEnchantment rows, as /dbc/item-enchantments has them.
  index.gems.set(1287, { id: 1287, enchantmentId: 3518, color: 2 });
  index.gems.set(1304, { id: 1304, enchantmentId: 3531, color: 4 });
  index.gems.set(1381, { id: 1381, enchantmentId: 3621, color: 1 });
  index.enchantments.set(3518, { id: 3518, name: "+20 к силе", gemItemId: 40111, conditionId: 0 });
  index.enchantments.set(3531, { id: 3531, name: "+20 к рейтингу скорости", gemItemId: 40128, conditionId: 0 });
  index.enchantments.set(3621, { id: 3621, name: "+21 к рейтингу критического удара", gemItemId: 41285, conditionId: 142 });
  index.ready = true;
  try { return run(); } finally { game.gatewayOrigin = previous; }
}

test("live socketing: the equipped item's sockets, the bag cursor's gem, the split and CMSG_SOCKET_GEMS", () => withGems(() => {
  const { world, seam, sent, fired, events } = fixture();
  const socket = seam.socket;
  socket.onOpenRequest = () => true;
  socket.owned = true;
  assert.equal(socket.request({ location: 0, bag: 0, slot: 1 }), true);
  assert.deepEqual([socket.numSockets(), socket.socketTypes(1), socket.socketTypes(2), socket.socketTypes(3)], [3, "Meta", "Red", "Yellow"]);
  assert.deepEqual(socket.existingSocketInfo(1), ["Хаотический алмаз небесного сияния", "Interface\\Icons\\Item_41285", true]);
  // The stock bag click puts the ruby on LiveWorldSeam's own GUID-checked cursor.
  seam.pickupContainerItem(0, 1);
  socket.clickSocket(2);
  assert.equal(seam.cursorHasItem(), false, "the gem left the cursor");
  assert.equal(socket.staged(2n), true);
  // The staged ruby is locked in the bag, as in the client: greyed, not picked up, not used.
  assert.equal(seam.containerItemInfo(0, 1)[2], true);
  seam.pickupContainerItem(0, 1);
  assert.equal(seam.cursorHasItem(), false, "a staged gem stays in its socket");
  assert.equal(seam.containerItemInfo(0, 2)[2], undefined, "the amber is not staged");
  assert.match(socket.socketedItemLink(), /\|Hitem:900001:0:3621:3518:0:0:0:0:80\|h\[Шлем гранильщика\]/);
  seam.pickupContainerItem(0, 2);
  socket.clickSocket(3);
  assert.deepEqual(sent, [["split", 255, 24, 255, 25, 1]], "one amber into the first free backpack slot");
  // The server's split lands a single amber in slot 25.
  const single = item(4n, 40128, [[field("ITEM_FIELD_STACK_COUNT"), 1]]);
  world.state.objects.set(single.guid, single);
  place(world.state.objects.get(1n).fields, field("PLAYER_FIELD_PACK_SLOT_1") + 4, single.guid);
  socket.tick();
  assert.equal(socket.staged(4n), true);
  socket.accept();
  assert.deepEqual(sent.at(-1), ["socket", 10n, [0n, 2n, 4n]]);
  // An equip error on the item: the send failed, the gems stay staged, the reason is shown.
  events.emit("INVENTORY_CHANGE_FAILURE", { result: 26, itemGuid: 10n, otherItemGuid: 0n, bagTypeSubclass: 0 });
  assert.equal(fired.filter(([event]) => event === "UI_ERROR_MESSAGE").length, 1);
  assert.equal(socket.staged(2n), true);
  socket.accept();
  events.emit("SOCKET_GEMS_RESULT", { itemGuid: 10n, enchantments: [] });
  assert.equal(socket.staged(2n), false, "the result spends the staged gems");
  assert.equal(seam.containerItemInfo(0, 1)[2], undefined, "and unlocks them");
  // The item leaving its slot ends the session.
  world.state.objects.get(1n).fields.set(field("PLAYER_FIELD_INV_SLOT_HEAD"), 0);
  world.state.objects.get(1n).fields.set(field("PLAYER_FIELD_INV_SLOT_HEAD") + 1, 0);
  socket.tick();
  assert.equal(socket.active, false);
  assert.equal(fired.at(-1)[0], "SOCKET_INFO_CLOSE");
}));

test("live inspection: visible items, then the answer's enchantments, talents, honor and arena teams", async () => {
  const { world, seam, sent, fired, events, target } = fixture();
  const inspect = seam.inspect;
  assert.deepEqual(call("CanInspect", seam, "target"), [true]);
  assert.deepEqual(call("CheckInteractDistance", seam, "target", 1), [true]);
  assert.deepEqual(call("CheckInteractDistance", seam, "target", 3), [false], "10 yards is past the duel range");
  // 5.18: follow is 28 yards in the client's table, and FollowUnit follows.
  assert.deepEqual(call("CheckInteractDistance", seam, "target", 4), [true], "UnitPopup's «Следовать» lights up");
  const { followTargetGuid, cancelFollow } = await import("../dist/code/browser/input/Follow.js");
  call("FollowUnit", seam, "focus");
  assert.deepEqual(fired.at(-1), ["UI_ERROR_MESSAGE", "ERR_UNIT_NOT_FOUND"], "a token or name that finds nobody");
  call("FollowUnit", seam, "target");
  assert.equal(followTargetGuid(), 0x20n, "the friendly mage 10 yards away is followed");
  cancelFollow();
  call("NotifyInspect", seam, "target");
  assert.deepEqual(sent, [["inspect", 0x20n]]);
  // Epic in the realm's own colour (ItemQualityColors): a chat message with any other is dropped.
  assert.deepEqual(call("WebClientInspectItem", seam, "target", 1),
    [true, "Interface\\Icons\\Item_40416", "|cffa335ee|Hitem:40416:3820:0:0:0:0:0:0:80|h[Доблестный венец ледяного огня]|h|r", 1]);
  assert.deepEqual(call("WebClientInspectItem", seam, "player", 1), [false], "the player's own items are not the inspection's");
  world.inspections.set(0x20n, {
    guid: 0x20n,
    talents: { pet: false, unspentPoints: 0, activeSpec: 0, specs: [{ talents: [{ talentId: 100, rank: 2 }], glyphs: [] }] },
    // Slot 5 is the active socket bonus (BONUS_ENCHANTMENT_SLOT), which the answer carries.
    items: [{ slot: 0, entry: 40416, enchantments: [3820, 0, 3621, 3518, 0, 2890, 0, 0, 0, 0, 0, 0], randomPropertyId: 0, creator: 0n, suffixFactor: 0 }],
  });
  events.emit("INSPECT_TALENT_READY", { guid: 0x20n });
  assert.deepEqual(fired.slice(-2), [["INSPECT_TALENT_READY"], ["UNIT_INVENTORY_CHANGED", "target"]]);
  // The fourth gem field stays 0: the realm's link parser refuses the link otherwise (HyperlinkTags.cpp).
  assert.match(call("WebClientInspectItem", seam, "target", 1)[2], /\|Hitem:40416:3820:3621:3518:0:0:0:0:80\|/);
  assert.deepEqual(call("WebClientInspectTalent", seam, "GetTalentTabInfo", 1, true), ["Огонь", "Interface\\Icons\\Spell_Fire_FlameBolt", 2, "MageFire", 0]);
  assert.deepEqual(call("WebClientInspectTalent", seam, "GetTalentInfo", 1, 1, true).slice(4, 6), [2, 3]);
  assert.deepEqual(call("WebClientInspectRelic", seam, "target"), [true, undefined], "a mage has no relic slot: nil, as 0x611330 answers");
  call("RequestInspectHonorData", seam);
  assert.deepEqual(sent.slice(-2), [["honor", 0x20n], ["arena", 0x20n]]);
  world.inspectedHonor.set(0x20n, { guid: 0x20n, honorPoints: 0, kills: (12 << 16) | 3, todayHonor: 125, yesterdayHonor: 480, lifetimeKills: 2104 });
  world.inspectedArenaTeams.set(0x20n, [{ guid: 0x20n, slot: 0, teamId: 7, teamRating: 1650, seasonGames: 40, seasonWins: 25, memberSeasonGames: 38, personalRating: 1702 }]);
  events.emit("PVP_INSPECTION", { guid: 0x20n });
  assert.deepEqual(sent.at(-1), ["team", 7], "the team's name and tabard are asked for");
  assert.deepEqual(call("GetInspectHonorData", seam), [3, 125, 12, 480, 2104, 0]);
  assert.deepEqual(call("GetInspectArenaTeamData", seam, 1), [], "no name before the team query answered");
  world.arenaTeams.set(7, { teamId: 7, name: "Ледяные искры", type: 2, backgroundColor: 0xff336699, emblemStyle: 12, emblemColor: 0xffffffff, borderStyle: 2, borderColor: 0xff000000 });
  events.emit("ARENA_TEAM_CHANGED", { teamId: 7 });
  assert.equal(fired.at(-1)[0], "INSPECT_HONOR_UPDATE");
  assert.deepEqual(call("GetInspectArenaTeamData", seam, 1).slice(0, 8), ["Ледяные искры", 2, 1650, 40, 25, 38, 1702, 0x33 / 255]);
  assert.deepEqual(call("HasInspectHonorData", seam), [true]);
  // Inspected again: NotifyInspect forgets the answer, so InspectPVPFrame_OnShow asks again.
  call("NotifyInspect", seam, "target");
  assert.deepEqual(call("HasInspectHonorData", seam), [false]);
  assert.deepEqual(call("GetInspectHonorData", seam), [0, 0, 0, 0, 0, 0], "not the first answer's numbers");
  assert.deepEqual(call("GetInspectArenaTeamData", seam, 1), []);
  call("RequestInspectHonorData", seam);
  assert.deepEqual(sent.slice(-2), [["honor", 0x20n], ["arena", 0x20n]]);
  assert.equal(world.inspectedArenaTeams.has(0x20n), false, "a team left since would not survive the new answer");
  world.inspectedHonor.set(0x20n, { guid: 0x20n, honorPoints: 0, kills: 5, todayHonor: 40, yesterdayHonor: 480, lifetimeKills: 2109 });
  events.emit("PVP_INSPECTION", { guid: 0x20n });
  assert.deepEqual(call("GetInspectHonorData", seam), [5, 40, 0, 480, 2109, 0]);
  assert.deepEqual(call("GetInspectArenaTeamData", seam, 1), [], "no teams in the new answer");
  // Another target: the inspection answers for nobody else.
  world.targetGuid = 1n;
  assert.deepEqual(call("WebClientInspectItem", seam, "target", 1), [false]);
  assert.equal(inspect.inspectedGuid, target.guid);
});

test("inspecting another class asks for its talent names and repaints the talent tab when they land", () => {
  const { world, seam, fired, events, spellNames, prefetched } = fixture();
  call("NotifyInspect", seam, "target");
  // The warrior player's own trees are the mount's to name; the mage's are asked for by first rank.
  const asked = prefetched.filter(([, spellIds]) => spellIds.length > 0);
  assert.deepEqual(asked.map(([itemIds, spellIds]) => [itemIds, spellIds]), [[[], [11]]]);
  world.inspections.set(0x20n, {
    guid: 0x20n,
    talents: { pet: false, unspentPoints: 0, activeSpec: 0, specs: [{ talents: [{ talentId: 100, rank: 2 }], glyphs: [] }] },
    items: [],
  });
  events.emit("INSPECT_TALENT_READY", { guid: 0x20n });
  assert.equal(call("WebClientInspectTalent", seam, "GetTalentInfo", 1, 1, true)[0], "Талант 100");
  const before = fired.length;
  spellNames.set(11, "Улучшенный огненный шар");
  asked[0][2]();
  assert.deepEqual(fired.slice(before), [["INSPECT_TALENT_READY"]], "InspectTalentFrame_OnEvent repaints");
  assert.equal(call("WebClientInspectTalent", seam, "GetTalentInfo", 1, 1, true)[0], "Улучшенный огненный шар");
  // Names landing for a player no longer inspected repaint nothing.
  call("ClearInspectPlayer", seam);
  asked[0][2]();
  assert.equal(fired.length, before + 1);
});

test("live barber: appearance bytes, the chair seat, the tables and the formula's price", async () => {
  const { world, seam, sent, fired, events, player } = fixture();
  const previousStyles = game.barberStyles;
  const previousOrigin = game.gatewayOrigin;
  const previousFetch = globalThis.fetch;
  const asked = [];
  game.barberStyles = {
    ready: true, load() {},
    stylesFor: (type, race, sex) => race === 6 && sex === 0 ? {
      0: [{ id: 743, data: 0, name: "Чемпионские" }, { id: 744, data: 1, name: "Бык" }, { id: 745, data: 2, name: "Пробивные" }],
      2: [{ id: 755, data: 1, name: "Три косички" }, { id: 756, data: 2, name: "Кольцо в носу" }, { id: 757, data: 3, name: "Коса" }],
      3: [{ id: 1122, data: 2, name: "Стиль 1122" }, { id: 1123, data: 3, name: "Стиль 1123" }],
    }[type] ?? [] : [],
  };
  game.gatewayOrigin = ORIGIN;
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname + new URL(url).search;
    asked.push(path);
    // As CharacterAppearance.options: without `class`, the death-knight-only colour (flag 0x4) is kept.
    const body = path.startsWith("/dbc/barber-cost") ? { costs: Array.from({ length: 100 }, (_, index) => index === 79 ? 111173 : 1) }
      : path.startsWith("/dbc/character-creation") ? { races: [{ id: 6, hairCustomization: "HORNS", facialHairCustomization: ["NORMAL", "HAIR"] }] }
        : { hairColors: new URL(url).searchParams.get("class") === "1" ? [0, 1, 2] : [0, 1, 2, 3] };
    return { ok: true, json: async () => body };
  };
  try {
    const barber = seam.barber;
    assert.equal(barber.ready(), false, "nothing fetched yet: the gate would refuse");
    await seam.barberPrepare();
    // The warrior's class: ValidateAppearance refuses a DK-only colour for it, in silence.
    assert.deepEqual(asked, ["/dbc/barber-cost?v=1", "/dbc/character-creation?v=4", "/dbc/character-options?v=6&race=6&sex=0&class=1"]);
    assert.equal(barber.ready(), true);
    assert.deepEqual([barber.hairCustomization(), barber.facialHairCustomization(), barber.canAlterSkin()], ["HORNS", "NORMAL", true]);
    barber.owned = true;
    world.barberShopOpen = true;
    events.emit("BARBER_SHOP", { open: true });
    assert.equal(fired.at(-1)[0], "BARBER_SHOP_OPEN");
    assert.deepEqual(barber.styleInfo(4), ["", undefined, undefined, true], "an unnamed fur row has no name");
    for (let step = 0; step < 3; step += 1) barber.next(2, false);
    assert.deepEqual(barber.styleInfo(2), [undefined, undefined, undefined, true], "three colours: back to the current one");
    barber.next(1, false);
    barber.next(3, false);
    assert.equal(barber.totalCost(), Math.trunc(111173 + 111173 * 0.75));
    barber.apply();
    assert.deepEqual(sent.at(-1), ["alter", 745, 0, 757, 1123]);
    barber.cancel();
    assert.deepEqual(sent.at(-1), ["stand", 0]);
    player.fields.set(field("UNIT_FIELD_BYTES_1"), 0);
    barber.tick();
    assert.equal(fired.at(-1)[0], "BARBER_SHOP_CLOSE");
    assert.equal(barber.open, false);
  } finally {
    game.barberStyles = previousStyles;
    game.gatewayOrigin = previousOrigin;
    globalThis.fetch = previousFetch;
  }
});

test("an open socketing session re-reads its item at most every 0.25 s between actions", async () => {
  const { FrameXmlSocketModel } = await import("../dist/code/browser/framexml/FrameXmlSocketModel.js");
  let reads = 0;
  let now = 10;
  const item = { guid: 10n, entry: 900001, sockets: [2, 0, 0], enchantments: [0, 0, 0, 0, 0, 0, 0], flags: 0 };
  const model = new FrameXmlSocketModel({
    item: () => { reads += 1; return item; }, carried: () => undefined, carriedAt: () => undefined, cursor: () => undefined,
    clearCursor() {}, pickup() {}, gem: () => undefined, enchantmentGem: () => undefined, itemLink: () => undefined,
    splitOne: () => undefined, socketGems: () => true, now: () => now,
  });
  model.attach({ fire: () => 1, now: () => now });
  model.onOpenRequest = () => true;
  model.owned = true;
  model.request({ location: 0, bag: 0, slot: 1 });
  const opened = reads;
  for (let frame = 0; frame < 10; frame += 1) model.tick();
  assert.equal(reads - opened, 1, "ten frames at one instant: one re-read");
  now += 0.1;
  model.tick();
  assert.equal(reads - opened, 1, "0.1 s later: still none");
  now += 0.2;
  model.tick();
  assert.equal(reads - opened, 2, "past the interval: the next one");
});
