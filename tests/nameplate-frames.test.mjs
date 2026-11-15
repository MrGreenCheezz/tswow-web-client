import assert from "node:assert/strict";
import test from "node:test";

// plates12 (15.11, plan items 6.37 and 3.21): the name plates as WorldFrame's own frames, as Wow.exe 3.3.5a builds them
// (read-only Ghidra, .runtime/re-2026-11-15/plates12: 0x0098f790 the constructor, 0x0098f390 the attach, 0x007254e0 /
// 0x00725840 the free list at 0x00adaa8c), checked against the stand's recording F:\WowOracle\runs\plates-probe3.txt
// (every region of every plate read through Lua on the real client). The add-on below does what plate add-ons do: it
// walks WorldFrame:GetChildren() for unnamed frames, reads their regions and bars, hooks OnShow/OnHide/OnUpdate and the
// bars' OnValueChanged, and restyles them.

const { FrameXmlUiBridge } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlRuntime.js");
const { GlueLuaVm } = await import("../dist/code/browser/glue/GlueLua.js");
const { GlueWidgetBinder } = await import("../dist/code/browser/glue/GlueWidgets.js");
const { FrameXmlNamePlatePool, frameXmlNamePlateState } =
  await import("../dist/code/browser/ui/framexml_compat/FrameXmlNamePlatePool.js");
const { fillNamePlateEntry, worldFrameUnitsPerPixel } = await import("../dist/code/browser/ui/NamePlateFrames.js");
const { REACTION_FRIENDLY, REACTION_HOSTILE } = await import("../dist/code/world/FactionRules.js");

const WORLD_XML = String.raw`<Ui><WorldFrame name="WorldFrame" setAllPoints="true"/></Ui>`;

function world() {
  const vm = new GlueLuaVm();
  const bridge = new FrameXmlUiBridge();
  const binder = new GlueWidgetBinder(vm, bridge);
  bridge.setRuntime(binder);
  // The C API the add-on below calls, as GlueApi.installFrameApi registers it.
  vm.registerGlobal("CreateFrame", (args) => [bridge.CreateFrame(String(args[0] ?? "Frame"),
    args[1] === undefined ? undefined : String(args[1]), args[2], args[3] === undefined ? undefined : String(args[3]))]);
  const loaded = bridge.loadAddon(WORLD_XML);
  assert.equal(loaded.ok, true, JSON.stringify(loaded.diagnostics));
  const worldFrame = bridge.getFrame("WorldFrame");
  assert.ok(worldFrame);
  return { vm, bridge, worldFrame };
}

/** Run Lua; a failure raises. */
function lua(vm, code) {
  const outcome = vm.execute(code, "@nameplate-frames-test");
  assert.equal(outcome.ok, true, outcome.error ?? "lua failed");
}

/** A plate entry, as the host fills one from the scene's plate data. */
function entry(guid, data = {}, x = 500, y = 400) {
  const e = { guid, x, y, state: frameXmlNamePlateState() };
  fillNamePlateEntry(e, {
    guid, name: `Unit ${guid}`, level: 80, playerLevel: 80, reaction: REACTION_HOSTILE, classColour: undefined,
    health: 0.7, healthValue: 700, healthMax: 1000, raidMark: undefined, rank: 0, cast: undefined, target: false,
    ...data,
  });
  e.x = x;
  e.y = y;
  return e;
}

test("a plate is an unnamed Frame under WorldFrame with the recording's 11 regions and 2 bars", () => {
  const { vm, bridge, worldFrame } = world();
  const pool = new FrameXmlNamePlatePool(bridge, worldFrame);
  pool.present([entry(1n, { name: "Hostile Normal" }, 997.97, 582.21)]);
  lua(vm, String.raw`
    local kids = { WorldFrame:GetChildren() }
    Count = #kids
    local f = kids[1]
    Type, Name, Strata, Level, Shown = f:GetObjectType(), f:GetName(), f:GetFrameStrata(), f:GetFrameLevel(), f:IsShown()
    W, H, Scale = f:GetWidth(), f:GetHeight(), f:GetScale()
    local p, rel, relp, x, y = f:GetPoint(1)
    Point = p .. " " .. (rel == WorldFrame and "WorldFrame" or "?") .. " " .. relp .. string.format(" %.2f %.2f", x, y)
    NumRegions, NumBars = f:GetNumRegions(), f:GetNumChildren()
    local regions = { f:GetRegions() }
    Shape = {}
    for i, r in ipairs(regions) do
      local t = r:GetObjectType()
      local line = t .. " " .. tostring(r:IsShown() and 1 or nil) .. " " .. tostring(r:GetDrawLayer())
      if t == "Texture" then line = line .. " " .. tostring(r:GetTexture()) .. " " .. tostring(r:GetBlendMode()) end
      Shape[i] = line
    end
    Name7, Level8 = regions[7]:GetText(), regions[8]:GetText()
    local font, size = regions[7]:GetFont()
    Font7, Size7 = font, size
    local sx, sy = regions[7]:GetShadowOffset()
    Shadow = string.format("%.3f %.3f", sx, sy)
    local bars = { f:GetChildren() }
    local health, cast = bars[1], bars[2]
    BarType, BarLevel, BarShown = health:GetObjectType(), health:GetFrameLevel(), health:IsShown()
    HealthValue = health:GetValue()
    HealthMin, HealthMax = health:GetMinMaxValues()
    local r, g, b, a = health:GetStatusBarColor()
    HealthColour = string.format("%.3f,%.3f,%.3f,%.3f", r, g, b, a)
    local tex = health:GetStatusBarTexture()
    BarTexType, BarTex = tex:GetObjectType(), tex:GetTexture()
    BarRegions = select("#", health:GetRegions())
    BarRegionIsTexture = (health:GetRegions()) == tex
    CastShown = cast:IsShown()
    local cr, cg, cb, ca = cast:GetStatusBarColor()
    CastColour = string.format("%.3f,%.3f,%.3f,%.3f", cr, cg, cb, ca)
    CastMin, CastMax = cast:GetMinMaxValues()
    local p2, rel2, relp2, x2, y2 = cast:GetPoint(1)
    CastPoint = p2 .. " " .. rel2:GetObjectType() .. " " .. relp2 .. string.format(" %.2f %.2f", x2, y2)
    CastAnchoredOnCastBorder = rel2 == regions[3]
    local _, shieldRel = regions[4]:GetPoint(1)
    ShieldOnCastBorder = shieldRel == regions[3]
    local _, iconRel, iconRelP, ix, iy = regions[5]:GetPoint(1)
    IconPoint = (iconRel == regions[3] and "castBorder" or "?") .. " " .. iconRelP .. string.format(" %.2f %.2f", ix, iy)
    local _, skullRel = regions[9]:GetPoint(1)
    SkullOnLevel = skullRel == regions[8]
    local _, raidRel, raidRelP = regions[10]:GetPoint(1)
    RaidOnBorder = raidRel == regions[2] and raidRelP == "LEFT"
    local function uv(r)
      local t = { r:GetTexCoord() }
      for i = 1, 8 do t[i] = string.format("%.3f", t[i]) end
      return table.concat(t, ",")
    end
    EliteCut, FlashCut, CastBorderCut, BorderCut = uv(regions[11]), uv(regions[1]), uv(regions[3]), uv(regions[2])
  `);
  const get = (name) => vm.getGlobal(name);
  assert.equal(get("Count"), 1);
  assert.equal(get("Type"), "Frame");
  assert.equal(get("Name"), undefined, "unnamed, as GetName answers nil in the recording");
  assert.equal(get("Strata"), "UNKNOWN");
  assert.equal(get("Level"), 10);
  assert.equal(get("Shown"), true);
  assert.ok(Math.abs(get("W") - 156.651) < 1e-3 && Math.abs(get("H") - 39.163) < 1e-3);
  assert.equal(get("Scale"), 1);
  assert.equal(get("Point"), "TOP WorldFrame BOTTOMLEFT 997.97 582.21");
  assert.equal(get("NumRegions"), 11);
  assert.equal(get("NumBars"), 2);
  assert.deepEqual(shapeLines(vm), [
    "Texture nil BACKGROUND Interface\\TargetingFrame\\UI-TargetingFrame-Flash BLEND",
    "Texture 1 ARTWORK Interface\\Tooltips\\Nameplate-Border BLEND",
    "Texture nil ARTWORK Interface\\Tooltips\\Nameplate-Border BLEND",
    "Texture nil ARTWORK Interface\\Tooltips\\Nameplate-CastBar-Shield BLEND",
    "Texture nil OVERLAY nil BLEND",
    "Texture nil HIGHLIGHT Interface\\Tooltips\\Nameplate-Glow ADD",
    "FontString 1 ARTWORK",
    "FontString 1 ARTWORK",
    "Texture nil OVERLAY Interface\\TargetingFrame\\UI-TargetingFrame-Skull BLEND",
    "Texture nil ARTWORK Interface\\TargetingFrame\\UI-RaidTargetingIcons BLEND",
    "Texture nil BORDER Interface\\Tooltips\\EliteNameplateIcon BLEND",
  ]);
  assert.equal(get("Name7"), "Hostile Normal");
  assert.equal(get("Level8"), "80");
  assert.equal(get("Font7"), "Fonts\\FRIZQT__.TTF");
  assert.ok(Math.abs(get("Size7") - 15.665) < 1e-6);
  assert.equal(get("Shadow"), "1.567 -1.567");
  assert.equal(get("BarType"), "StatusBar");
  assert.equal(get("BarLevel"), 9);
  assert.equal(get("BarShown"), true);
  assert.equal(get("HealthValue"), 700);
  assert.equal(get("HealthMin"), 0);
  assert.equal(get("HealthMax"), 1000);
  assert.equal(get("HealthColour"), "1.000,0.000,0.000,1.000", "hostile: red, as the recording's col=");
  assert.equal(get("BarTexType"), "Texture");
  assert.equal(get("BarTex"), "Interface\\TargetingFrame\\UI-TargetingFrame-BarFill");
  assert.equal(get("BarRegions"), 1);
  assert.equal(get("BarRegionIsTexture"), true);
  assert.equal(get("CastShown"), false);
  assert.equal(get("CastColour"), "0.698,0.000,1.000,1.000", "the recording's idle cast bar colour");
  assert.equal(get("CastMin"), 0);
  assert.equal(get("CastMax"), 0);
  assert.equal(get("CastPoint"), "BOTTOMRIGHT Texture BOTTOMRIGHT -4.86 4.90");
  assert.equal(get("CastAnchoredOnCastBorder"), true);
  assert.equal(get("ShieldOnCastBorder"), true);
  assert.equal(get("IconPoint"), "castBorder BOTTOMLEFT 14.41 11.12");
  assert.equal(get("SkullOnLevel"), true);
  assert.equal(get("RaidOnBorder"), true);
  // The recording's `uv=` lines, GetTexCoord's eight numbers.
  assert.equal(get("EliteCut"), "0.000,0.000,0.000,0.844,0.578,0.000,0.578,0.844");
  assert.equal(get("FlashCut"), "0.000,0.530,0.000,0.600,0.555,0.530,0.555,0.600");
  assert.equal(get("CastBorderCut"), "1.000,0.000,1.000,1.000,0.000,0.000,0.000,1.000");
  assert.equal(get("BorderCut"), "0.000,0.000,0.000,1.000,1.000,0.000,1.000,1.000");
});

function shapeLines(vm) {
  lua(vm, "ShapeJoined = table.concat(Shape, '\\n')");
  return String(vm.getGlobal("ShapeJoined")).split("\n");
}

/** The add-on every test below runs: a scanner as plate add-ons write them. */
const SCANNER = String.raw`
  Log = {}
  Seen = {}
  Styled = 0
  local known = 0
  local function nameOf(plate) return (select(7, plate:GetRegions())):GetText() end
  function StylePlate(plate)
    Styled = Styled + 1
    local flash, border = plate:GetRegions()
    local health = plate:GetChildren()
    border:Hide()
    plate.mine = CreateFrame("Frame", nil, plate)
    plate.mine:SetSize(20, 20)
    plate.mine:SetPoint("LEFT", plate, "RIGHT", 2, 0)
    plate.mineText = plate:CreateFontString(nil, "OVERLAY")
    plate.mineText:SetPoint("TOP", plate, "BOTTOM", 0, 0)
    plate:HookScript("OnShow", function(self)
      table.insert(Log, "show " .. nameOf(self))
      local bar = self:GetChildren()
      bar:ClearAllPoints()
      bar:SetPoint("TOP", self, "TOP", 0, -3)
    end)
    plate:HookScript("OnHide", function(self) table.insert(Log, "hide " .. nameOf(self)) end)
    plate:HookScript("OnUpdate", function(self) Seen[self] = (Seen[self] or 0) + 1 end)
    health:HookScript("OnValueChanged", function(self, value) table.insert(Log, "value " .. value) end)
    health:ClearAllPoints()
    health:SetPoint("TOP", plate, "TOP", 0, -3)
  end
  local scanner = CreateFrame("Frame")
  scanner:SetScript("OnUpdate", function()
    local count = WorldFrame:GetNumChildren()
    if count == known then return end
    known = count
    for _, plate in ipairs({ WorldFrame:GetChildren() }) do
      if not Seen[plate] and not plate:GetName() and plate:GetObjectType() == "Frame" and plate:GetNumRegions() >= 8 then
        Seen[plate] = 0
        StylePlate(plate)
      end
    end
  end)
`;

function joinedLog(vm) {
  lua(vm, "LogJoined = table.concat(Log, '|'); Log = {}");
  return String(vm.getGlobal("LogJoined"));
}

test("plates are taken from the head of the free list and given back to its tail; WorldFrame's children only grow", () => {
  const { vm, bridge, worldFrame } = world();
  lua(vm, SCANNER);
  const pool = new FrameXmlNamePlatePool(bridge, worldFrame);
  const a = entry(1n, { name: "A" });
  const b = entry(2n, { name: "B" });
  const c = entry(3n, { name: "C" });
  pool.present([a, b, c]);
  bridge.tick(0.016);
  assert.equal(vm.getGlobal("Styled"), 3, "the scanner found three unnamed plates");
  const [plateA, plateB, plateC] = pool.frames;
  assert.equal(pool.frameFor(2n), plateB);
  joinedLog(vm);

  pool.present([a, c]); // B leaves: its plate is hidden, OnHide, and waits with B's name
  pool.present([a]); // then C
  assert.equal(joinedLog(vm), "hide B|hide C");
  assert.equal(plateB.visible, false);
  assert.equal(plateB.children.find((child) => child.type === "FontString").text, "B", "a waiting plate keeps its last unit");

  // D takes the plate given back first (B's): 0x007254e0 unlinks the head, 0x00725840 linked at the tail.
  pool.present([a, entry(4n, { name: "D" })]);
  assert.equal(pool.frameFor(4n), plateB);
  assert.equal(joinedLog(vm), "show D", "OnShow runs after the attach, with the new unit's name");
  pool.present([a, entry(4n, { name: "D" }), entry(5n, { name: "E" })]);
  assert.equal(pool.frameFor(5n), plateC);
  pool.present([a, entry(4n, { name: "D" }), entry(5n, { name: "E" }), entry(6n, { name: "F" })]);
  assert.equal(pool.frames.length, 4, "a fourth unit at once makes a fourth plate");
  lua(vm, "Children = WorldFrame:GetNumChildren()");
  assert.equal(vm.getGlobal("Children"), 4);
  pool.clear();
  lua(vm, "Children = WorldFrame:GetNumChildren()");
  assert.equal(vm.getGlobal("Children"), 4, "plates are never destroyed");
  assert.ok(pool.frames.every((frame) => !frame.visible));
  void plateA;
});

test("the attach puts the client's parts back, what OnShow does stays, and every value an add-on reads answers", () => {
  const { vm, bridge, worldFrame } = world();
  lua(vm, SCANNER);
  const pool = new FrameXmlNamePlatePool(bridge, worldFrame);
  pool.present([entry(1n, { name: "Hostile Normal" })]);
  bridge.tick(0.016);
  const plate = pool.frameFor(1n);
  const health = plate.children.find((child) => child.type === "StatusBar");
  const border = plate.children.filter((child) => child.type === "Texture")[1];
  assert.deepEqual(health.points.map((point) => point.point), ["TOP"], "the add-on's own anchor");
  assert.equal(border.visible, false);
  bridge.tick(0.016);
  lua(vm, "Updates = Seen[(WorldFrame:GetChildren())]");
  assert.ok(vm.getGlobal("Updates") >= 1, "the plate's OnUpdate hook runs with the interface's tick");

  // An add-on that moves a part outside OnShow: the next attach puts the client's parts back (the level's CENTER on the
  // plate's BOTTOMRIGHT), and leaves the ones the attach does not lay (the name's BOTTOM).
  lua(vm, String.raw`
    local plate = WorldFrame:GetChildren()
    local _, _, _, _, _, _, name, level = plate:GetRegions()
    level:ClearAllPoints(); level:SetPoint("LEFT", plate, "LEFT", 1, 1)
    name:ClearAllPoints(); name:SetPoint("LEFT", plate, "LEFT", 2, 2)
  `);
  const [nameString, levelString] = plate.children.filter((child) => child.type === "FontString");

  // Given back and taken again: 0x0098f390 sets the bar's BOTTOMLEFT again, then OnShow runs and the add-on re-anchors.
  pool.present([]);
  pool.present([entry(2n, { name: "Again" })]);
  assert.equal(pool.frameFor(2n), plate);
  assert.deepEqual(health.points.map((point) => point.point), ["TOP"], "OnShow's ClearAllPoints + SetPoint stay");
  assert.equal(border.visible, false, "a region the add-on hid stays hidden: the client never shows the border again");
  assert.deepEqual(levelString.points.map((point) => `${point.point}:${point.relativePoint}:${point.x}:${point.y}`),
    ["LEFT:LEFT:1:1", "CENTER:BOTTOMRIGHT:-14.41:11.12"], "the attach sets the level's CENTER again (SetPoint adds it)");
  assert.deepEqual(nameString.points.map((point) => point.point), ["LEFT"], "the name's point is the constructor's only");
  joinedLog(vm);

  // Health: the bar's range is the unit's (0..max), its value the health; OnValueChanged on a change only.
  pool.present([entry(2n, { name: "Again", healthValue: 350, healthMax: 1000 })]);
  pool.present([entry(2n, { name: "Again", healthValue: 350, healthMax: 1000 })]);
  assert.equal(joinedLog(vm), "value 350");

  const read = (code) => { lua(vm, code); };
  // The friendly colour, the flash, the mark, the skull, the dragon, the target, the cast.
  pool.present([entry(2n, {
    name: "Real Boss", reaction: REACTION_FRIENDLY, boss: true, rank: 3, level: 83, threat: 3, raidMark: 5, target: true,
    cast: { iconPath: "Interface\\Icons\\Spell_Fire_FlameBolt.blp", progress: 0.0485, seconds: 90 },
  }), entry(3n, { name: "Other", dimmed: true, level: 95 })]);
  read(String.raw`
    local plate = select(1, WorldFrame:GetChildren())
    local flash, border, castBorder, shield, icon, glow, name, level, skull, raid, elite = plate:GetRegions()
    local health, cast = plate:GetChildren()
    local r, g, b = health:GetStatusBarColor()
    Bar = string.format("%.3f,%.3f,%.3f", r, g, b)
    local fr, fg, fb, fa = flash:GetVertexColor()
    Flash = tostring(flash:IsShown()) .. string.format(" %.3f,%.3f,%.3f,%.3f", fr, fg, fb, fa)
    Raid = tostring(raid:IsShown()) .. string.format(" %.2f %.2f %.2f %.2f %.2f %.2f %.2f %.2f", raid:GetTexCoord())
    Skull, LevelShown, Elite = skull:IsShown(), level:IsShown(), elite:IsShown()
    Levels = plate:GetFrameLevel() .. " " .. health:GetFrameLevel() .. " " .. cast:GetFrameLevel()
    Alpha = string.format("%.3f", plate:GetAlpha())
    CastShown, CastBorderShown, IconShown = cast:IsShown(), castBorder:IsShown(), icon:IsShown()
    IconTexture = icon:GetTexture()
    local lo, hi = cast:GetMinMaxValues()
    Cast = string.format("%.3f of %.3f..%.3f", cast:GetValue(), lo, hi)
    local cr, cg, cb, ca = cast:GetStatusBarColor()
    CastColour = string.format("%.3f,%.3f,%.3f,%.3f", cr, cg, cb, ca)
    local other = select(2, WorldFrame:GetChildren())
    local _, _, _, _, _, _, _, otherLevel, otherSkull = other:GetRegions()
    OtherAlpha = string.format("%.3f", other:GetAlpha())
    OtherSkull, OtherLevel = otherSkull:IsShown(), otherLevel:IsShown()
  `);
  const get = (name) => vm.getGlobal(name);
  assert.equal(get("Bar"), "0.000,1.000,0.000", "a friend's bar is green: add-ons tell sides apart by it");
  assert.equal(get("Flash"), "true 1.000,0.000,0.000,1.000");
  assert.equal(get("Raid"), "true 0.25 0.25 0.25 0.50 0.50 0.25 0.50 0.50", "mark 5: the second cell of the second row");
  assert.equal(get("Skull"), true);
  assert.equal(get("LevelShown"), false, "the recording's level string with the skull: shown=nil");
  assert.equal(get("Elite"), true);
  assert.equal(get("Levels"), "20 19 19");
  assert.equal(get("Alpha"), "1.000");
  assert.equal(get("CastShown"), true);
  assert.equal(get("CastBorderShown"), true);
  assert.equal(get("IconShown"), true);
  assert.equal(get("IconTexture"), "Interface\\Icons\\Spell_Fire_FlameBolt");
  assert.equal(get("Cast"), "4.365 of 0.000..90.000", "the recording's caster line");
  assert.equal(get("CastColour"), "1.000,0.698,0.000,1.000");
  assert.equal(get("OtherAlpha"), "0.498");
  assert.equal(get("OtherSkull"), true, "hostile ten levels above the player: the skull");
  assert.equal(get("OtherLevel"), false);
});

test("the bar's texture region follows the bar, and what the add-on sets on it stays", () => {
  const { vm, bridge, worldFrame } = world();
  const pool = new FrameXmlNamePlatePool(bridge, worldFrame);
  pool.present([entry(1n, { healthValue: 250, healthMax: 1000 })]);
  lua(vm, String.raw`
    local plate = WorldFrame:GetChildren()
    local health = plate:GetChildren()
    local tex = health:GetStatusBarTexture()
    local function cut() local _, _, _, _, r = tex:GetTexCoord() return string.format("%.3f", r) end
    Before = cut()
    health:SetValue(500)
    After = cut()
    tex:SetTexture("Interface\\AddOns\\Mine\\Bar")
    health:SetValue(600)
    Kept = tex:GetTexture()
    health:SetStatusBarTexture("Interface\\AddOns\\Mine\\Other")
    Replaced = tex:GetTexture()
    health:SetStatusBarColor(0.2, 0.4, 0.6)
    local r, g, b = tex:GetVertexColor()
    TexColour = string.format("%.1f,%.1f,%.1f", r, g, b)
  `);
  const get = (name) => vm.getGlobal(name);
  assert.equal(get("Before"), "0.250", "cut at the value, not squeezed");
  assert.equal(get("After"), "0.500");
  assert.equal(get("Kept"), "Interface\\AddOns\\Mine\\Bar", "a value change leaves the add-on's picture");
  assert.equal(get("Replaced"), "Interface\\AddOns\\Mine\\Other");
  assert.equal(get("TexColour"), "0.2,0.4,0.6");
  const health = pool.frameFor(1n).children.find((child) => child.type === "StatusBar");
  const fill = health.children[0];
  assert.equal(Number(fill.attributes.width), 125.948 * 0.6, "as wide as the value makes it");

  // Any other StatusBar keeps answering its texture path, as before.
  assert.equal(bridge.loadAddon(String.raw`<Ui><StatusBar name="PlainBar"><BarTexture file="Interface\Plain"/></StatusBar></Ui>`).ok, true);
  lua(vm, "PlainTexture = PlainBar:GetStatusBarTexture(); local r, g, b, a = PlainBar:GetStatusBarColor(); PlainColour = r + g + b + a");
  assert.equal(get("PlainTexture"), "Interface\\Plain");
  assert.equal(get("PlainColour"), 4);
});

test("WorldFrame's units per overlay pixel follow the interface scale", () => {
  assert.equal(worldFrameUnitsPerPixel(768, 100), 1);
  assert.equal(worldFrameUnitsPerPixel(1536, 100), 0.5);
  assert.equal(worldFrameUnitsPerPixel(768, 50), 2, "a smaller interface makes WorldFrame more units tall");
  // The plate's TOP point is the scene box's top middle, measured up from the bottom of the screen.
  const e = { guid: 0n, x: 0, y: 0, state: frameXmlNamePlateState() };
  fillNamePlateEntry(e, {
    guid: 9n, name: "N", level: undefined, reaction: REACTION_HOSTILE, classColour: undefined, health: undefined,
    raidMark: undefined, rank: 0, cast: undefined, target: false,
  });
  assert.equal(e.state.level, undefined);
  assert.equal(e.state.health, undefined);
  assert.equal(e.state.barColour, 0xff0000);
});

test("with a frame host registered the scene hands its plates over, paints none, and keeps their click boxes", async () => {
  const { SimpleScene, createCamera, projectPoint } = await import("../dist/code/browser/SimpleScene.js");
  const { setNamePlateFrameHost } = await import("../dist/code/browser/ui/NamePlateFrameSlot.js");
  const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
  const unit = (guid, typeId, x) => ({
    guid, typeId, position: { x, y: 0, z: 0, orientation: 0 },
    fields: new Map([[UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 60], [UPDATE_FIELDS.UNIT_FIELD_MAXHEALTH.offset, 100]]),
  });
  const objects = new Map([[1n, unit(1n, 4, 0)], [2n, unit(2n, 3, 22)]]);
  const drawn = [];
  const context = new Proxy({ measureText: (text) => ({ width: String(text).length * 6 }), setTransform() {},
    createLinearGradient: () => ({ addColorStop() {} }) }, {
    get: (target, property) => (property in target ? target[property] : (...args) => { drawn.push(property); }),
    set: (target, property, value) => { target[property] = value; return true; },
  });
  const canvas = { width: 0, height: 0, getContext: () => context, getBoundingClientRect: () => ({ width: 1280, height: 720 }) };
  const handed = [];
  setNamePlateFrameHost({ present: (plates, width, height) => handed.push({ plates: [...plates], width, height }), clear() {} });
  const previous = globalThis.window;
  globalThis.window = { devicePixelRatio: 1 };
  try {
    const scene = new SimpleScene(canvas, false);
    const data = (object) => object.guid === 2n ? {
      guid: 2n, name: "Mob", level: 10, reaction: REACTION_HOSTILE, classColour: undefined, health: 0.6, raidMark: undefined,
      rank: 0, cast: undefined, target: false,
    } : undefined;
    scene.draw({ selfGuid: 1n, objects }, () => 0, undefined, [], undefined, 0, undefined, undefined, () => 2, data);
    assert.equal(handed.length, 1);
    assert.equal(handed[0].plates.length, 1);
    assert.equal(handed[0].plates[0].data.guid, 2n);
    assert.equal(handed[0].height, 720);
    assert.ok(!drawn.includes("fillText"), "no plate is painted on the canvas");
    const camera = createCamera(objects.get(1n).position, 0, undefined, undefined);
    const head = projectPoint({ x: 22, y: 0, z: 2 }, camera, 1280, 720);
    assert.equal(scene.pick(head.x, head.y - 20), 2n, "the plate's box still takes the click");
  } finally {
    globalThis.window = previous;
    setNamePlateFrameHost(undefined);
  }
});
