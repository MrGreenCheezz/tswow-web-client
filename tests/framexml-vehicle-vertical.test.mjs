import assert from "node:assert/strict";
import test, { after } from "node:test";

// 11.02-F2, MPQ-backed: the retail 3.3.5a VehicleMenuBar.xml/.lua (stock TOC line 142) and
// AnimationSystem.lua (144) in the production vertical, over LiveWorldSeam and a real WorldClient while
// the character drives a siege engine — MainMenuBar's UNIT_ENTERING/ENTERED_VEHICLE path (the slide, then
// MainMenuBar_ToVehicleArt with the "Mechanical" skin), VehicleSeatIndicator_SetUpVehicle(223) with the
// player's icon on seat 1, VehicleMenuBarActionButton1 on slot 121 casting from the vehicle, a seat-
// indicator click and the leave button sending the driver's packets, and the way home. Only primitives
// read back from Lua are compared.
let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine", concurrency: false };
const { clientArchives } = await import("../tools/mpq.mjs");
const chain = clientDirectory ? await clientArchives(clientDirectory) : undefined;
after(() => chain?.close());

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC, FRAMEXML_TOC_PATH } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { parseGlueToc } = await import("../dist/code/browser/glue/GlueLoader.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { OPCODES } = await import("../dist/code/generated/opcodes.js");
const { PacketReader } = await import("../dist/code/protocol/index.js");
const { WorldClient } = await import("../dist/code/world/WorldClient.js");
const { WorldStore } = await import("../dist/code/world/WorldStore.js");
const { WorldState } = await import("../dist/code/world/WorldState.js");
const { REACT_DEFENSIVE, COMMAND_FOLLOW, packPetAction } = await import("../dist/code/world/PetProtocol.js");
const {
  VEHICLE_CATALOG_VERSION, VEHICLE_COLUMN, VEHICLE_FORMAT, VEHICLE_SEAT_COLUMN, VEHICLE_SEAT_FORMAT, vehicleCatalogFrom,
} = await import("../dist/code/world/VehicleDbc.js");
const { game } = await import("../dist/code/browser/game/Context.js");
// 11.02-F2-review: the gated-out micro-button row (FrameXmlMicroButtonHold.ts, used by FrameXmlWorldMount.ts).
const { holdFrameXmlMicroButtonsHidden } = await import("../dist/code/browser/framexml/FrameXmlMicroButtonHold.js");
const MICRO_BUTTONS = Object.freeze([
  "CharacterMicroButton", "SpellbookMicroButton", "TalentMicroButton", "AchievementMicroButton", "QuestLogMicroButton",
  "SocialsMicroButton", "PVPMicroButton", "LFDMicroButton", "MainMenuMicroButton", "HelpMicroButton",
]);

const decoder = new TextDecoder("utf-8");
const normalize = (path) => path.replaceAll("\\", "/").toLowerCase();
const provider = {
  async read(path) {
    const data = await chain.read(path);
    return data ? decoder.decode(data) : undefined;
  },
};

function lua(boot, code, results = 1) {
  const fn = boot.vm.compileFunction(code, "vehicle-test", []);
  assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
  try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
}

function vehicleRow({ id, flags = 0, seats = [], indicator = 0 }) {
  const row = [...VEHICLE_FORMAT].map((kind) => (kind === "s" ? "" : 0));
  row[VEHICLE_COLUMN.ID] = id;
  row[VEHICLE_COLUMN.Flags] = flags;
  seats.forEach((seat, slot) => { row[VEHICLE_COLUMN.SeatID + slot] = seat; });
  row[VEHICLE_COLUMN.VehicleUIIndicatorID] = indicator;
  return row;
}

function seatRow({ id, flags = 0, flagsB = 0, uiSkin = 0 }) {
  const row = [...VEHICLE_SEAT_FORMAT].map(() => 0);
  row[VEHICLE_SEAT_COLUMN.ID] = id;
  row[VEHICLE_SEAT_COLUMN.Flags] = flags;
  row[VEHICLE_SEAT_COLUMN.FlagsB] = flagsB;
  row[VEHICLE_SEAT_COLUMN.UiSkin] = uiSkin;
  row[VEHICLE_SEAT_COLUMN.VehicleAbilityDisplay] = 1;
  return row;
}

// The dataset's siege engine 117 (seats 1648 driver, 1649/1650 passengers, slot 7 turret 116 with gunner
// 1643) and its indicator 223, as probed from Vehicle.dbc/VehicleSeat.dbc/VehicleUI*.dbc.
const catalog = vehicleCatalogFrom({
  version: VEHICLE_CATALOG_VERSION,
  vehicles: [
    vehicleRow({ id: 117, flags: 0x5018f027, seats: [1648, 1649, 1650, 0, 0, 0, 0, 1652], indicator: 223 }),
    vehicleRow({ id: 116, flags: 0x471cf677, seats: [1643], indicator: 223 }),
  ],
  seats: [
    seatRow({ id: 1648, flags: 0x67108a0b, flagsB: 0x10, uiSkin: 1 }),
    seatRow({ id: 1649, flags: 0x4710820b, flagsB: 0x10 }),
    seatRow({ id: 1650, flags: 0x4710820b, flagsB: 0x10 }),
    seatRow({ id: 1652, flags: 0x3006408, flagsB: 0x280014 }),
    seatRow({ id: 1643, flags: 0x67100a0f, flagsB: 0x80011, uiSkin: 1 }),
  ],
  indicators: [[223, "Interface\\Vehicles\\SeatIndicator\\Vehicle-SiegeEngine.blp"]],
  indicatorSeats: [[226, 223, 1, 0.501, 0.14], [227, 223, 2, 0.698, 0.799], [228, 223, 3, 0.303, 0.799], [229, 223, 4, 0.5, 0.578]],
});

const SELF = 0x10n;
const ENGINE = 0xf150_0074_9800_0101n;
const GUN = 0xf150_0074_9800_0102n;
const RAM = 62345;
const offset = (name) => UPDATE_FIELDS[name].offset;

function setGuid(object, at, guid) {
  object.fields.set(at, Number(guid & 0xffff_ffffn));
  object.fields.set(at + 1, Number(guid >> 32n));
}

function worldFixture() {
  const sent = [];
  const world = new WorldClient({ send(opcode, payload = new Uint8Array()) { sent.push({ opcode, payload }); }, close() {} });
  const state = new WorldState();
  world.state = state;
  const object = (guid, typeId, entries, extra = {}) => ({
    guid, typeId, position: { x: 0, y: 0, z: 0, orientation: 0 }, movementFlags: 0, updateFlags: 0, targetGuid: undefined,
    runSpeed: undefined, turnRate: undefined, motion: undefined, glide: undefined, transport: undefined,
    speeds: undefined, transportTime: undefined, fields: new Map(entries), ...extra,
  });
  state.objects.set(SELF, object(SELF, 4, [
    [offset("UNIT_FIELD_BYTES_0"), 1 | (1 << 8)], [offset("UNIT_FIELD_LEVEL"), 80],
    [offset("UNIT_FIELD_HEALTH"), 4000], [offset("UNIT_FIELD_MAXHEALTH"), 4000], [offset("UNIT_FIELD_FLAGS"), 0x08],
  ]));
  state.objects.set(ENGINE, object(ENGINE, 3, [
    [offset("OBJECT_FIELD_ENTRY"), 28312], [offset("UNIT_FIELD_LEVEL"), 80], [offset("UNIT_FIELD_BYTES_0"), 3 << 24],
    [offset("UNIT_FIELD_HEALTH"), 50000], [offset("UNIT_FIELD_MAXHEALTH"), 60000],
  ], { vehicleId: 117 }));
  state.objects.set(GUN, object(GUN, 3, [
    [offset("OBJECT_FIELD_ENTRY"), 28319], [offset("UNIT_FIELD_HEALTH"), 20000], [offset("UNIT_FIELD_MAXHEALTH"), 20000],
  ], { vehicleId: 116, transport: { guid: ENGINE, x: 0, y: 0, z: 0, orientation: 0, seat: 7 } }));
  state.selfGuid = SELF;
  const store = new WorldStore(state);
  world.creatureTemplates.set(28312, { entry: 28312, name: "Осадная машина", subName: "", flags: 0, creatureType: 9 });
  world.creatureTemplates.set(28319, { entry: 28319, name: "Турель", subName: "", flags: 0, creatureType: 9 });
  world.mapId = 571;
  world.selfName = "Воин";
  const realmTime = { minuteOfDay: 9 * 60 + 30, minutesPerSecond: 1 / 60, weekday: 4, date: { year: 2024, month: 2, day: 29 } };
  world.currentGameTime = () => realmTime;
  world.calendarPending = 0;
  return { world, store, sent, player: state.objects.get(SELF), engine: state.objects.get(ENGINE) };
}

/** `VehicleSpellInitialize`: the vehicle's spells in slots 0…7 with the slot + 8 as the state byte. */
function vehicleBar(guid, spells) {
  return {
    guid, closed: false, creatureFamily: 0, duration: 0, reactState: REACT_DEFENSIVE, commandState: COMMAND_FOLLOW, flags: 0,
    spells: [], cooldowns: [],
    bar: Array.from({ length: 10 }, (_, slot) => {
      const packed = packPetAction(spells[slot] ?? 0, slot + 8);
      return { slot, packed, action: packed & 0xffffff, type: packed >>> 24 };
    }),
  };
}

test("11.02-F2: VehicleMenuBar.xml (142) and AnimationSystem.lua (144) sit at their stock slots", withClient, async () => {
  const toc = parseGlueToc(decoder.decode(await chain.read(FRAMEXML_TOC_PATH)), "interface/framexml/")
    .map((entry) => normalize(entry.path).replace("interface/framexml/", ""));
  const vertical = FRAMEXML_VERTICAL_TOC.map(normalize);
  for (const file of ["vehiclemenubar.xml", "animationsystem.lua"]) assert.ok(vertical.includes(file), `${file} is in the vertical`);
  assert.ok(toc.indexOf("vehiclemenubar.xml") < toc.indexOf("alternatepowerbar.xml"));
  assert.ok(toc.indexOf("alternatepowerbar.xml") < toc.indexOf("animationsystem.lua"));
  // suite-fix: L17 3.09 (WORK_PLAN 3.09) appended LocalizationPost.xml, the stock TOC's last line, after these.
  assert.ok(toc.indexOf("animationsystem.lua") < toc.indexOf("localizationpost.xml"));
  assert.deepEqual(vertical.slice(vertical.indexOf("easymenu.lua")),
    ["easymenu.lua", "vehiclemenubar.xml", "alternatepowerbar.xml", "animationsystem.lua", "localizationpost.xml"],
    "the stock order");
});

test("11.02-F2: driving a siege engine in the stock UI — panel, skin, seat indicator, a press, a seat, the leave button, home", withClient, async () => {
  const { world, store, sent, player, engine } = worldFixture();
  const previousWorld = game.world;
  game.world = world;
  let now = 1;
  const seam = new LiveWorldSeam({
    world: () => world, store: () => store,
    spell: (id) => ({ id, name: `Заклинание ${id}`, rank: "", description: "", iconPath: "Interface\\Icons\\Spell_Test",
      effectAura: [0, 0, 0], effectMiscValue: [0, 0, 0], passive: false }),
    monotonic: () => now * 1000, globalCooldownUntil: () => 0, castSpell: () => {},
    vehicles: () => catalog,
  });
  const boot = new FrameXmlBoot({ provider, locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, screen: () => ({ width: 1365, height: 768 }) });
  const failures = () => boot.errors.map((failure) => `${failure.file}:${failure.line}: ${failure.message}`)
    .concat(boot.vm.errors.map(String));
  const poll = () => { now += 0.1; seam.tick(now); };
  const frames = (count = 30) => { for (let index = 0; index < count; index += 1) boot.bridge.tick(0.02); };
  const view = () => {
    const values = lua(boot, `
      local function shown(frame) return frame:IsShown() and 1 or 0 end
      local function texture(region) return string.lower(region:GetTexture() or "") end
      local seats = 0
      for index = 1, 8 do
        local button = _G["VehicleSeatIndicatorButton" .. index]
        if button and button:IsShown() then seats = seats + 1 end
      end
      local player = VehicleSeatIndicatorButton1PlayerIcon
      return shown(VehicleMenuBar), shown(MainMenuBar), VehicleMenuBar.currSkin or "", MainMenuBar.state or "",
        shown(VehicleSeatIndicator), VehicleSeatIndicator.currSkin or 0, texture(VehicleSeatIndicatorBackgroundTexture),
        seats, player and shown(player) or -1, VehicleMenuBarActionButton1.action or 0,
        texture(VehicleMenuBarActionButton1Icon), shown(VehicleMenuBarLeaveButton), PlayerFrame.state or ""`, 13);
    return {
      vehicleBar: values[0], mainBar: values[1], skin: values[2], state: values[3], indicator: values[4], indicatorId: values[5],
      background: values[6], seats: values[7], playerIcon: values[8], action1: values[9], icon1: values[10],
      leave: values[11], playerFrame: values[12],
    };
  };
  try {
    await boot.load();
    const errorsAtBoot = failures();
    assert.equal(lua(boot, "return VehicleMenuBarActionButton1 ~= nil and VehicleSeatIndicatorDropDown ~= nil and 1 or 0")[0], 1,
      "the real frames, not FrameXmlDurabilityFrame.ts' stand-ins");
    poll();
    frames();
    assert.deepEqual([view().vehicleBar, view().mainBar, view().indicator], [0, 1, 0], "on foot: the main bar");

    // The core's order (Vehicle.cpp VehicleJoinEvent, Unit::SetCharmedBy VEHICLE): control, the bar, the
    // far sight and charm fields, the seat.
    world.controlledGuid = ENGINE;
    world.petSpells = vehicleBar(ENGINE, [RAM, RAM + 1]);
    world.events.emit("PET_BAR_CHANGED", { guid: ENGINE });
    setGuid(player, offset("UNIT_FIELD_CHARM"), ENGINE);
    setGuid(player, offset("PLAYER_FARSIGHT"), ENGINE);
    engine.fields.set(offset("UNIT_FIELD_FLAGS"), 0x0100_0000);
    setGuid(engine, offset("UNIT_FIELD_CHARMEDBY"), SELF);
    player.transport = { guid: ENGINE, x: 0, y: 0, z: 0, orientation: 0, seat: 0 };
    poll();
    frames();
    const seated = view();
    assert.deepEqual(seated, {
      vehicleBar: 1, mainBar: 0, skin: "Mechanical", state: "vehicle", indicator: 1, indicatorId: 223,
      background: "interface\\vehicles\\seatindicator\\vehicle-siegeengine.blp", seats: 4, playerIcon: 1, action1: 121,
      icon1: "interface\\icons\\spell_test", leave: 1, playerFrame: "vehicle",
    });
    assert.deepEqual(failures(), errorsAtBoot, "no Lua error on the way in");
    // A passenger whose name the client does not know yet: the seat reads as taken, by UNKNOWNOBJECT.
    const stranger = { ...player, guid: 0x77n, fields: new Map(), transport: { guid: ENGINE, x: 0, y: 0, z: 0, orientation: 0, seat: 1 } };
    world.state.objects.set(0x77n, stranger);
    assert.deepEqual(lua(boot, "local c, name = UnitVehicleSeatInfo('player', 2) return c, name == UNKNOWNOBJECT and 1 or 0, name ~= nil and 1 or 0", 3),
      ["None", 1, 1]);
    world.state.objects.delete(0x77n);
    // The bottles read the "vehicle" unit — the vehicle the character rides (0x0060abf0).
    assert.deepEqual(lua(boot, "local _, max = VehicleMenuBarHealthBar:GetMinMaxValues() return VehicleMenuBarHealthBar:GetValue(), max, UnitExists('vehicle') and 1 or 0", 3),
      [50000, 60000, 1], "the vehicle's health in its bottle");

    // VehicleMenuBarActionButton1: UseAction(121) -> the vehicle bar's slot 1 -> CMSG_PET_CAST_SPELL from the vehicle.
    sent.length = 0;
    lua(boot, "VehicleMenuBarActionButton1:Click('LeftButton')", 0);
    const casts = sent.filter((packet) => packet.opcode === OPCODES.CMSG_PET_CAST_SPELL);
    assert.equal(casts.length, 1, `sent: ${sent.map((packet) => packet.opcode.toString(16)).join(",")}`);
    const cast = new PacketReader(casts[0].payload);
    assert.equal(cast.u64(), ENGINE);
    cast.u8();
    assert.equal(cast.u32(), RAM);
    // Key 2 the stock way (ActionButtonDown/Up: VehicleMenuBar is shown and 2 <= VEHICLE_MAX_ACTIONBUTTONS).
    sent.length = 0;
    lua(boot, "ActionButtonDown(2) ActionButtonUp(2)", 0);
    const keyed = sent.filter((packet) => packet.opcode === OPCODES.CMSG_PET_CAST_SPELL);
    assert.equal(keyed.length, 1);
    const keyCast = new PacketReader(keyed[0].payload);
    keyCast.u64();
    keyCast.u8();
    assert.equal(keyCast.u32(), RAM + 1, "key 2 is VehicleMenuBarActionButton2");

    // A seat in the indicator: UnitSwitchToVehicleSeat("player", 3) -> the driver's CHANGE_SEATS (slot 2).
    sent.length = 0;
    lua(boot, "VehicleSeatIndicatorButton3:Click('LeftButton')", 0);
    assert.deepEqual(sent.map((packet) => packet.opcode), [OPCODES.CMSG_CHANGE_SEATS_ON_CONTROLLED_VEHICLE]);
    // Hovering a free seat: the driver's cursor for a "Root" seat is not offered (taken), a None seat is.
    lua(boot, "VehicleSeatIndicatorButton3:GetScript('OnEnter')(VehicleSeatIndicatorButton3) VehicleSeatIndicatorButton3:GetScript('OnLeave')(VehicleSeatIndicatorButton3)", 0);

    // The leave button: VehicleExit -> the driver dismisses the vehicle (CMSG_DISMISS_CONTROLLED_VEHICLE).
    sent.length = 0;
    lua(boot, "VehicleMenuBarLeaveButton:Click('LeftButton')", 0);
    assert.deepEqual(sent.map((packet) => packet.opcode), [OPCODES.CMSG_DISMISS_CONTROLLED_VEHICLE]);
    assert.deepEqual(failures(), errorsAtBoot, "no Lua error from the buttons");

    // Unit::RemoveCharmedBy and the exit: control back, the bar closed, the fields cleared, off the seat.
    world.controlledGuid = SELF;
    world.petSpells = undefined;
    world.events.emit("PET_BAR_CHANGED", { guid: 0n });
    setGuid(player, offset("UNIT_FIELD_CHARM"), 0n);
    setGuid(player, offset("PLAYER_FARSIGHT"), 0n);
    engine.fields.set(offset("UNIT_FIELD_FLAGS"), 0);
    setGuid(engine, offset("UNIT_FIELD_CHARMEDBY"), 0n);
    player.transport = undefined;
    poll();
    frames();
    const home = view();
    assert.deepEqual([home.vehicleBar, home.mainBar, home.state, home.indicator, home.playerFrame], [0, 1, "player", 0, "player"],
      "the main bar slid back, the indicator unloaded");
    assert.deepEqual(failures(), errorsAtBoot, "no Lua error on the way home");

    // Ordinary play: a later PLAYER_ENTERING_WORLD slides MainMenuBar in again (MainMenuBar_ToPlayerArt over
    // AnimationSystem.lua) and it comes to rest where it stood.
    const resting = () => lua(boot, "local point, _, relative, x, y = MainMenuBar:GetPoint() return point, relative, x, y", 4);
    const before = resting();
    boot.bridge.dispatchEvent("PLAYER_ENTERING_WORLD");
    frames(5);
    assert.ok(lua(boot, "return MainMenuBar.animating and 1 or 0")[0] === 1, "sliding");
    frames(30);
    assert.deepEqual(resting(), before, "back at rest");
    assert.deepEqual(failures(), errorsAtBoot, "no Lua error on a second PLAYER_ENTERING_WORLD");

    // 11.02-F2-review: the world mount keeps the stock micro-button row hidden when its owner gate fails
    // (the native row stays). MainMenuBar_ToPlayerArt now runs the real VehicleMenuBar_MoveMicroButtons
    // (VehicleMenuBar.lua:713-726), which Shows all ten on every loading screen: a plain Hide does not hold.
    const microShown = () => lua(boot, `local shown = 0
      for _, name in ipairs({ ${MICRO_BUTTONS.map((name) => JSON.stringify(name)).join(", ")} }) do
        if _G[name]:IsShown() then shown = shown + 1 end
      end
      return shown`)[0];
    for (const name of MICRO_BUTTONS) boot.bridge.Hide(boot.bridge.getFrame(name));
    boot.bridge.dispatchEvent("PLAYER_ENTERING_WORLD");
    assert.equal(microShown(), MICRO_BUTTONS.length, "control: stock Lua shows a merely hidden row again");
    holdFrameXmlMicroButtonsHidden(boot, MICRO_BUTTONS);
    assert.equal(microShown(), 0, "held hidden");
    boot.bridge.dispatchEvent("PLAYER_ENTERING_WORLD");
    frames(30);
    assert.equal(microShown(), 0, "a loading screen does not bring a gated-out row back");
    lua(boot, "VehicleMenuBar_MoveMicroButtons('Mechanical') VehicleMenuBar_MoveMicroButtons()", 0);
    assert.equal(microShown(), 0, "nor the vehicle skins' move");
    assert.deepEqual(failures(), errorsAtBoot, "no Lua error from the hold");
  } finally {
    boot.close();
    game.world = previousWorld;
  }
});
