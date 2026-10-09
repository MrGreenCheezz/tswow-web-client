import assert from "node:assert/strict";
import test, { after } from "node:test";

// 11.02-E, MPQ-backed: the retail 3.3.5a VehicleMenuBar.xml/.lua over LiveWorldSeam and a real WorldClient while the
// character mans the siege engine's turret 116 (Vehicle Flags 0x471cf677: ADJUST_AIM_ANGLE, so VehicleMenuBar_SetSkin
// lays out the pitch buttons and slider): the pitch buttons' OnMouseDown/OnMouseUp call VehicleAimUpStart/Stop and
// VehicleAimDownStart/Stop (= PitchUp/Down Start/Stop, 0x005fc8e0…0x005fc5c0), VehicleAimRequestNormAngle moves the
// mover's pitch, and VEHICLE_ANGLE_UPDATE moves VehicleMenuBarPitchSliderMarker (VehicleMenuBar.lua:820-845). Only
// primitives read back from Lua are compared.
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
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { registerVehicleAimInput } = await import("../dist/code/browser/game/VehicleAim.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { WorldClient } = await import("../dist/code/world/WorldClient.js");
const { WorldStore } = await import("../dist/code/world/WorldStore.js");
const { WorldState } = await import("../dist/code/world/WorldState.js");
const { REACT_DEFENSIVE, COMMAND_FOLLOW, packPetAction } = await import("../dist/code/world/PetProtocol.js");
const {
  VEHICLE_CATALOG_VERSION, VEHICLE_COLUMN, VEHICLE_FORMAT, VEHICLE_SEAT_COLUMN, VEHICLE_SEAT_FORMAT, vehicleCatalogFrom,
} = await import("../dist/code/world/VehicleDbc.js");
const { game } = await import("../dist/code/browser/game/Context.js");

const decoder = new TextDecoder("utf-8");
const provider = {
  async read(path) {
    const data = await chain.read(path);
    return data ? decoder.decode(data) : undefined;
  },
};

function lua(boot, code, results = 1) {
  const fn = boot.vm.compileFunction(code, "vehicle-aim-test", []);
  assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
  try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
}

const PITCH_MIN = -0.5235988;
const PITCH_MAX = 0.7853982;
const catalog = vehicleCatalogFrom({
  version: VEHICLE_CATALOG_VERSION,
  vehicles: [(() => {
    const row = [...VEHICLE_FORMAT].map((kind) => (kind === "s" ? "" : 0));
    row[VEHICLE_COLUMN.ID] = 116;
    row[VEHICLE_COLUMN.Flags] = 0x471cf677;
    row[VEHICLE_COLUMN.PitchMin] = PITCH_MIN;
    row[VEHICLE_COLUMN.PitchMax] = PITCH_MAX;
    row[VEHICLE_COLUMN.SeatID] = 1643;
    return row;
  })()],
  seats: [(() => {
    const row = [...VEHICLE_SEAT_FORMAT].map(() => 0);
    row[VEHICLE_SEAT_COLUMN.ID] = 1643;
    row[VEHICLE_SEAT_COLUMN.Flags] = 0x67100a0f;
    row[VEHICLE_SEAT_COLUMN.FlagsB] = 0x80011;
    row[VEHICLE_SEAT_COLUMN.UiSkin] = 1;
    row[VEHICLE_SEAT_COLUMN.VehicleAbilityDisplay] = 1;
    return row;
  })()],
  indicators: [],
  indicatorSeats: [],
});

const SELF = 0x10n;
const GUN = 0xf150_0074_9800_0102n;
const CANNON = 57609;
const offset = (name) => UPDATE_FIELDS[name].offset;

function setGuid(object, at, guid) {
  object.fields.set(at, Number(guid & 0xffff_ffffn));
  object.fields.set(at + 1, Number(guid >> 32n));
}

test("11.02-E: the turret's gunner in the stock UI — pitch buttons, the aim request, the slider's marker", withClient, async () => {
  const world = new WorldClient({ send() {}, close() {} });
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
  state.objects.set(GUN, object(GUN, 3, [
    [offset("OBJECT_FIELD_ENTRY"), 28319], [offset("UNIT_FIELD_LEVEL"), 80], [offset("UNIT_FIELD_BYTES_0"), 3 << 24],
    [offset("UNIT_FIELD_HEALTH"), 20000], [offset("UNIT_FIELD_MAXHEALTH"), 20000],
  ], { vehicleId: 116 }));
  state.selfGuid = SELF;
  const store = new WorldStore(state);
  world.creatureTemplates.set(28319, { entry: 28319, name: "Турель", subName: "", flags: 0, creatureType: 9 });
  world.mapId = 571;
  world.selfName = "Воин";
  world.currentGameTime = () => ({ minuteOfDay: 570, minutesPerSecond: 1 / 60, weekday: 4, date: { year: 2024, month: 2, day: 29 } });
  world.calendarPending = 0;
  const player = state.objects.get(SELF);
  const gun = state.objects.get(GUN);

  // The movement code's side: the gunner's pitch inside the turret's band; the pitch keys pressed.
  const aim = {
    pitch: 0, keys: [],
    moverPitch() { return this.pitch; },
    setMoverPitch(pitch) { this.pitch = Math.min(PITCH_MAX, Math.max(PITCH_MIN, pitch)); return true; },
    pitchKey(direction, down) { this.keys.push(`${direction}:${down ? "down" : "up"}`); },
  };
  registerVehicleAimInput(aim);
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
  const marker = () => lua(boot, "local _, _, _, _, y = VehicleMenuBarPitchSliderMarker:GetPoint() return y, VehicleMenuBarPitchSlider:GetHeight()", 2);
  try {
    await boot.load();
    const errorsAtBoot = failures();
    poll();
    frames();
    world.controlledGuid = GUN;
    world.petSpells = {
      guid: GUN, closed: false, creatureFamily: 0, duration: 0, reactState: REACT_DEFENSIVE, commandState: COMMAND_FOLLOW, flags: 0,
      spells: [], cooldowns: [],
      bar: Array.from({ length: 10 }, (_, slot) => {
        const packed = packPetAction(slot === 0 ? CANNON : 0, slot + 8);
        return { slot, packed, action: packed & 0xffffff, type: packed >>> 24 };
      }),
    };
    world.events.emit("PET_BAR_CHANGED", { guid: GUN });
    setGuid(player, offset("UNIT_FIELD_CHARM"), GUN);
    setGuid(player, offset("PLAYER_FARSIGHT"), GUN);
    gun.fields.set(offset("UNIT_FIELD_FLAGS"), 0x0100_0000);
    setGuid(gun, offset("UNIT_FIELD_CHARMEDBY"), SELF);
    player.transport = { guid: GUN, x: 0, y: 0, z: 0, orientation: 0, seat: 0 };
    poll();
    frames();
    assert.deepEqual(lua(boot, `return VehicleMenuBar:IsShown() and 1 or 0, VehicleMenuBarPitchUpButton:IsShown() and 1 or 0,
      VehicleMenuBarPitchSlider:IsShown() and 1 or 0, IsVehicleAimAngleAdjustable() and 1 or 0`, 4), [1, 1, 1, 1],
    "VehicleMenuBar_SetSkin with the pitch: the buttons and the slider are up");

    lua(boot, `VehicleMenuBarPitchUpButton:GetScript("OnMouseDown")(VehicleMenuBarPitchUpButton, "LeftButton")
      VehicleMenuBarPitchUpButton:GetScript("OnMouseUp")(VehicleMenuBarPitchUpButton, "LeftButton")
      VehicleMenuBarPitchDownButton:GetScript("OnMouseDown")(VehicleMenuBarPitchDownButton, "LeftButton")
      VehicleMenuBarPitchDownButton:GetScript("OnMouseUp")(VehicleMenuBarPitchDownButton, "LeftButton")`, 0);
    assert.deepEqual(aim.keys, ["up:down", "up:up", "down:down", "down:up"], "the pitch keys, as PitchUp/Down Start/Stop");

    lua(boot, "VehicleAimRequestNormAngle(0.75)", 0);
    assert.ok(Math.abs(aim.pitch - (PITCH_MIN + 0.75 * (PITCH_MAX - PITCH_MIN))) < 1e-6, "the gunner's pitch moved");
    poll();
    frames(2);
    const [y, height] = marker();
    assert.ok(Math.abs(y - (0.75 * (height - 20) + 8)) < 1e-3, `the marker at 0.75 of the slider: ${y} of ${height}`);
    assert.ok(Math.abs(lua(boot, "return VehicleAimGetNormAngle()")[0] - 0.75) < 1e-6);

    aim.pitch = PITCH_MIN;
    poll();
    frames(2);
    assert.ok(Math.abs(marker()[0] - 8) < 1e-3, "the keys took it to PitchMin: the marker at the bottom");
    assert.deepEqual(failures(), errorsAtBoot, "no Lua error");
  } finally {
    registerVehicleAimInput(undefined);
    game.world = previousWorld;
    seam.detach();
  }
});
