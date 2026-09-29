import assert from "node:assert/strict";
import test, { after } from "node:test";

// MPQ-backed: the stock LFGFrame/LFDFrame/LFRFrame closure in the production vertical, driven over
// the canned world. Everything here runs the real 3.3.5 Lua — the list, the popups, the minimap
// eye — against FrameXmlLfd.ts's C API.
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
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC, FRAMEXML_TOC_PATH } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { FRAMEXML_CANNED_LFD_PLAYER_GUID } = await import("../dist/code/browser/framexml/FrameXmlLfdCanned.js");
const {
  createFrameXmlLfdOwner, frameXmlLfdGate, installFrameXmlLfdToggle,
} = await import("../dist/code/browser/framexml/FrameXmlLfdOwner.js");
const { parseGlueToc } = await import("../dist/code/browser/glue/GlueLoader.js");
const decoder = new TextDecoder("utf-8");
const normalize = (path) => path.replaceAll("\\", "/").toLowerCase();
const LFG_FILES = ["lfgframe.xml", "lfdframe.xml", "lfrframe.xml"];
const DUNGEON = 1 << 24;

async function load(subset, seam = new CannedWorldSeam(), exercise = true) {
  const requests = new Set();
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        requests.add(normalize(path));
        const data = await chain.read(path);
        return data ? decoder.decode(data) : undefined;
      },
    },
    locale: "ruRU", subset, seam, exercise, screen: () => ({ width: 1365, height: 768 }),
  });
  const started = performance.now();
  const inventory = await boot.load();
  return { boot, seam, inventory, requests, loadMs: performance.now() - started };
}

/** Run a Lua function body and return its values; a Lua failure raises. */
function lua(boot, code, results = 1) {
  const fn = boot.vm.compileFunction(code, "lfd-test", []);
  assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
  try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
}

/** A renderer stand-in: one element per frame carrying the renderer's identity attributes. */
function renderer() {
  const elements = new Map();
  return {
    elementFor(frame) {
      if (!elements.has(frame)) {
        const attributes = new Map([["data-framexml-name", frame.name], ["data-framexml-type", frame.type]]);
        elements.set(frame, { dataset: {}, parentElement: null, getAttribute: (name) => attributes.get(name) ?? null });
      }
      return elements.get(frame);
    },
  };
}

test("LFG/LFD/LFR follow ArenaFrame at their retail slots; the closure adds six files and no Lua error", withClient, async () => {
  const toc = parseGlueToc(decoder.decode(await chain.read(FRAMEXML_TOC_PATH)), "interface/framexml/")
    .map((entry) => normalize(entry.path).replace("interface/framexml/", ""));
  const arena = toc.indexOf("arenaframe.xml");
  assert.deepEqual(toc.slice(arena + 2, arena + 5), LFG_FILES, "retail TOC 130-132, after ArenaRegistrarFrame");
  const vertical = FRAMEXML_VERTICAL_TOC.map(normalize);
  const at = vertical.indexOf("arenaframe.xml");
  assert.deepEqual(vertical.slice(at + 1, at + 5), ["arenaregistrarframe.xml", ...LFG_FILES],
    "the vertical keeps the retail order: ArenaFrame, ArenaRegistrarFrame, then these three");
  let baseline;
  let candidate;
  try {
    baseline = await load(FRAMEXML_VERTICAL_TOC.filter((entry) => !LFG_FILES.includes(normalize(entry))));
    candidate = await load(FRAMEXML_VERTICAL_TOC);
    assert.equal(baseline.boot.bridge.getFrame("LFDParentFrame")?.name, undefined);
    for (const file of ["lfgframe.lua", "lfdframe.lua", "lfrframe.lua"]) {
      assert.ok(candidate.requests.has(`interface/framexml/${file}`), `${file} is reached through its XML`);
    }
    const metric = (inventory) => ({ files: inventory.files.total, bytes: inventory.files.bytes,
      widgets: inventory.widgets.total, errors: inventory.lua.errorsRaised, distinct: inventory.errors.length,
      luaFailed: inventory.lua.failed });
    const before = metric(baseline.inventory);
    const afterLoad = metric(candidate.inventory);
    const delta = Object.fromEntries(Object.keys(before).map((key) => [key, afterLoad[key] - before[key]]));
    // 1,024 -> 1,070 widgets once UnitPopup.xml grew UIDROPDOWNMENU_MAXBUTTONS in both arms: the
    // LFD role/type dropdowns create their stock button rows against the larger count.
    assert.deepEqual(delta, { files: 6, bytes: 188270, widgets: 1070, errors: 0, distinct: 0, luaFailed: 0 },
      `LFG closure delta ${JSON.stringify(delta)}`);
    assert.deepEqual(candidate.inventory.errors, []);
    // LFDFrame.lua:1 captures the expansion once, at file scope, before any seam is attached.
    assert.deepEqual(lua(candidate.boot, "return EXPANSION_LEVEL"), [2]);
    assert.equal(candidate.boot.bridge.getFrame("LFDParentFrame").visible, false);
    assert.equal(candidate.boot.bridge.getFrame("LFRParentFrame").visible, false, "the raid browser stays hidden");
    console.log(`[lfd] load ms baseline ${Math.round(baseline.loadMs)} candidate ${Math.round(candidate.loadMs)}`);
  } finally {
    candidate?.boot.close();
    baseline?.boot.close();
  }
});

test("the gate proves the stock finder silently: list rows after two updates, no packet, ends hidden", withClient, async () => {
  const { boot, seam } = await load(FRAMEXML_VERTICAL_TOC);
  try {
    const sounds = [];
    const playSound = seam.playSound.bind(seam);
    seam.playSound = (name) => { sounds.push(name); playSound(name); };
    const errors = boot.errorCount;
    const result = frameXmlLfdGate(seam, boot, renderer());
    assert.ok(result, "the canned catalog and the stock tree pass");
    assert.equal(result.frame.name, "LFDParentFrame");
    // Level 60, Alliance: two headers and eight rows survive LFDList_DefaultFilterFunction.
    assert.deepEqual([result.listed, result.rows], [10, 10]);
    assert.equal(result.frame.visible, false, "the probe ends hidden");
    assert.deepEqual(seam.lfdWorld.calls, [], "OnShow's lock request is muted during the probe");
    assert.deepEqual(sounds, [], "the probe plays no open/close sound");
    assert.equal(boot.errorCount, errors);
    assert.deepEqual(lua(boot, "return type(PlaySound) == 'function' and 1 or 0"), [1], "PlaySound is restored");
    // A world without the version-2 catalog fields: no stock finder (the native window stays).
    assert.equal(frameXmlLfdGate({ lfd: { ready: () => false } }, boot, renderer()), undefined);
  } finally {
    boot.close();
  }
});

test("the stock list, roles and Find Group send the join a player builds with the mouse", withClient, async () => {
  const { boot, seam } = await load(FRAMEXML_VERTICAL_TOC);
  try {
    seam.lfd.popupsOwned = true;
    const errors = boot.errorCount;
    lua(boot, `ShowUIPanel(LFDParentFrame) LFDQueueFrame_SetType("specific") LFDQueueFrame_Update() LFDQueueFrame_Update()`, 0);
    const rows = lua(boot, `local r = {}
      for i = 1, NUM_LFD_CHOICE_BUTTONS do
        local b = _G["LFDQueueFrameSpecificListButton" .. i]
        if b:IsVisible() then r[#r + 1] = b.id .. "=" .. b.instanceName:GetText() .. "|" .. (b.level:IsShown() and b.level:GetText() or "")
          .. (b.lockedIndicator:IsShown() and "|locked" or "") end
      end
      return table.concat(r, ";")`)[0].split(";");
    assert.deepEqual(rows, [
      "-2=Burning Crusade (обычный режим)|", "136=Бастионы Адского Пламени|(57 - 67)", "137=Кузня Крови|(59 - 68)",
      "-1=Классические подземелья|", "276=Глубины Черной горы - Верхний город|(51 - 61)",
      "34=Забытый Город - Восток|(53 - 63)", "32=Нижняя часть Черной горы|(55 - 65)", "2=Некроситет|(55 - 65)",
      "40=Стратхольм - Главные врата|(55 - 65)", "274=Стратхольм - Черный ход|(55 - 65)|locked",
    ], "headers first, children by level, the quest lock shown; the level-24 Stockade filtered out");
    // The canned player is in a party: only its leader may queue it (LFD_IsEmpowered).
    assert.deepEqual(lua(boot, "return LFDQueueFrameFindGroupButton:IsEnabled()"), [0]);
    seam.setPartyLeader(true);
    lua(boot, "LFG_UpdateRolesChangeable() LFDQueueFrame_Update() LFDQueueFrameFindGroupButton_Update()", 0);
    assert.deepEqual(lua(boot, "return LFDQueueFrameFindGroupButton:IsEnabled(), LFDQueueFrameFindGroupButton:GetText()", 2),
      [1, "Вступить группой"]);
    boot.bridge.Click(boot.bridge.getFrame("LFDQueueFrameRoleButtonTank"));
    boot.bridge.Click(boot.bridge.getFrame("LFDQueueFrameSpecificListButton9EnableButton"));
    boot.bridge.Click(boot.bridge.getFrame("LFDQueueFrameFindGroupButton"));
    const join = seam.lfdWorld.calls.filter((call) => call.kind === "join");
    // Tank only (0x02; the leader box stays unchecked); Stratholme's front gate as a type-1 entry.
    assert.deepEqual(join, [{ kind: "join", roles: 0x02, dungeons: [40 | DUNGEON], comment: "" }]);
    assert.equal(boot.errorCount, errors, "no Lua error on the way");
  } finally {
    boot.close();
  }
});

test("the server's random list picks the random pane, and queue state lights the minimap eye", withClient, async () => {
  const { boot, seam } = await load(FRAMEXML_VERTICAL_TOC);
  try {
    seam.lfd.popupsOwned = true;
    const errors = boot.errorCount;
    lua(boot, "ShowUIPanel(LFDParentFrame)", 0);
    await new Promise(setImmediate); // the canned server answers the OnShow lock request
    assert.deepEqual(seam.lfdWorld.calls.map((call) => call.kind), ["requestLocks"]);
    assert.deepEqual(lua(boot, "return LFDQueueFrame.type, LFDQueueFrameRandom:IsShown() and 1 or 0, LFDQueueFrameRandomScrollFrameChildFrame.title:GetText() == LFG_TYPE_RANDOM_DUNGEON and 1 or 0, LFDQueueFrameRandomScrollFrameChildFrameMoneyFrame:IsShown() and 1 or 0", 4),
      [259, 1, 1, 1], "LFG_UPDATE_RANDOM_INFO chose Burning Crusade's random for level 60, with its 1234-copper reward");
    assert.deepEqual(lua(boot, "return MiniMapLFGFrame:IsShown() and 1 or 0"), [0]);
    seam.lfdWorld.queue([259 | (6 << 24)], 95);
    assert.deepEqual(lua(boot, "return GetLFGMode()", 2), ["queued", "unempowered"],
      "stock GetLFGMode (UIParent.lua:3570) reads the seam's GetLFGInfoServer");
    assert.deepEqual(lua(boot, "return MiniMapLFGFrame:IsShown() and 1 or 0, LFDQueueFrameFindGroupButton:GetText()", 2),
      [1, "Выйти из очереди"]);
    lua(boot, "MiniMapLFGFrame_OnEnter(MiniMapLFGFrame)", 0);
    assert.deepEqual(lua(boot, "return LFDSearchStatus:IsShown() and 1 or 0, LFDSearchStatus.statistic:GetText()", 2),
      [1, "Среднее время ожидания: 4 мин."]);
    seam.setPartyLeader(true);
    lua(boot, "LFDQueueFrameFindGroupButton_Update()", 0);
    boot.bridge.Click(boot.bridge.getFrame("LFDQueueFrameFindGroupButton"));
    assert.deepEqual(seam.lfdWorld.calls.at(-1), { kind: "leave" }, "the queued button leaves the queue");
    seam.lfdWorld.unqueue();
    assert.deepEqual(lua(boot, "return MiniMapLFGFrame:IsShown() and 1 or 0"), [0]);
    assert.equal(boot.errorCount, errors);
  } finally {
    boot.close();
  }
});

test("the stock ready and role-check popups answer the server only once stock owns them", withClient, async () => {
  const { boot, seam } = await load(FRAMEXML_VERTICAL_TOC);
  try {
    const errors = boot.errorCount;
    seam.lfdWorld.propose(40 | DUNGEON, 3);
    assert.deepEqual(lua(boot, "return LFDDungeonReadyPopup:IsShown() and 1 or 0"), [0],
      "unpublished: the native prompt answers, no second popup");
    seam.lfd.popupsOwned = true;
    seam.lfdWorld.propose(40 | DUNGEON, 4);
    assert.deepEqual(lua(boot, "return LFDDungeonReadyPopup:IsShown() and 1 or 0, LFDDungeonReadyDialog.instanceInfo.name:GetText()", 2),
      [1, "Стратхольм - Главные врата"]);
    boot.bridge.Click(boot.bridge.getFrame("LFDDungeonReadyDialogEnterDungeonButton"));
    assert.deepEqual(seam.lfdWorld.calls.at(-1), { kind: "proposal", accept: true });
    assert.equal(boot.errorCount, errors, JSON.stringify(boot.errors.slice(errors).map((e) => e.message)));
    // The dialog is still up (the answer's echo has not arrived): LFDDungeonReadyPopup_OnFail hides it at once.
    seam.lfdWorld.propose(40 | DUNGEON, 4, 1);
    assert.deepEqual(lua(boot, "return LFDDungeonReadyPopup:IsShown() and 1 or 0"), [0], "a failed proposal closes");

    seam.lfdWorld.startRoleCheck(FRAMEXML_CANNED_LFD_PLAYER_GUID, [40 | DUNGEON]);
    assert.deepEqual(lua(boot, "return LFDRoleCheckPopup:IsShown() and 1 or 0"), [1]);
    boot.bridge.Click(boot.bridge.getFrame("LFDRoleCheckPopupRoleButtonDPS"));
    boot.bridge.Click(boot.bridge.getFrame("LFDRoleCheckPopupAcceptButton"));
    assert.deepEqual(seam.lfdWorld.calls.at(-1), { kind: "roles", roles: 0x08 });
    assert.deepEqual(lua(boot, "return LFDRoleCheckPopup:IsShown() and 1 or 0"), [0]);
    seam.lfdWorld.endRoleCheck(1);
    assert.equal(boot.errorCount, errors, JSON.stringify(boot.errors.slice(errors).map((e) => `${e.file}:${e.line} ${e.message}`)));
  } finally {
    boot.close();
  }
});

test("a proposal or role check open before publication is handed to the stock popups", withClient, async () => {
  const { boot, seam } = await load(FRAMEXML_VERTICAL_TOC);
  try {
    const errors = boot.errorCount;
    // It landed during the corpus load (or before a ReloadUI remount): the native prompt had it.
    seam.lfdWorld.propose(259 | (6 << 24), 21);
    assert.deepEqual(lua(boot, "return LFDDungeonReadyPopup:IsShown() and 1 or 0"), [0]);
    // The mount's publication — the moment InteractionPrompts steps aside (frameXmlLfdPublished).
    seam.lfd.popupsOwned = true;
    assert.deepEqual(lua(boot, "return LFDDungeonReadyPopup:IsShown() and 1 or 0, LFDDungeonReadyDialog:IsShown() and 1 or 0, (GetLFGMode())", 3),
      [1, 1, "proposal"], "the stock ready dialog asks the question the native prompt no longer shows");
    seam.lfdWorld.propose(259 | (6 << 24), 21);
    assert.deepEqual(lua(boot, "return LFDDungeonReadyPopup:IsShown() and 1 or 0"), [1], "the server's same-id re-send keeps it up");
    seam.lfdWorld.propose(259 | (6 << 24), 21, 1);
    assert.deepEqual(lua(boot, "return LFDDungeonReadyPopup:IsShown() and 1 or 0"), [0]);
    // A role check running across a remount: handed back, started, taken over again.
    seam.lfd.popupsOwned = false;
    seam.lfdWorld.startRoleCheck(FRAMEXML_CANNED_LFD_PLAYER_GUID, [40 | DUNGEON]);
    assert.deepEqual(lua(boot, "return LFDRoleCheckPopup:IsShown() and 1 or 0"), [0]);
    seam.lfd.popupsOwned = true;
    assert.deepEqual(lua(boot, "return LFDRoleCheckPopup:IsShown() and 1 or 0"), [1]);
    seam.lfdWorld.endRoleCheck(1);
    assert.deepEqual(lua(boot, "return LFDRoleCheckPopup:IsShown() and 1 or 0"), [0]);
    assert.equal(boot.errorCount, errors, JSON.stringify(boot.errors.slice(errors).map((e) => `${e.file}:${e.line} ${e.message}`)));
  } finally {
    boot.close();
  }
});

test("the list keeps stock's own anchors; the queue box stays under the eye; the raid browser stays shut", withClient, async () => {
  const { boot, seam } = await load(FRAMEXML_VERTICAL_TOC);
  try {
    const errors = boot.errorCount;
    const gate = frameXmlLfdGate(seam, boot, renderer());
    assert.ok(gate, "the gate proves the finder through the stock setter");
    lua(boot, `ShowUIPanel(LFDParentFrame) LFDQueueFrame_SetType("specific") LFDQueueFrame_Update() LFDQueueFrame_Update()`, 0);
    const anchors = lua(boot, `local r = {}
      for i = 1, NUM_LFD_CHOICE_BUTTONS do
        local b = _G["LFDQueueFrameSpecificListButton" .. i]
        if b:IsVisible() then
          local function describe(region)
            local out = {}
            for p = 1, region:GetNumPoints() do
              local point, to, relative, x, y = region:GetPoint(p)
              out[#out + 1] = ("%s>%s:%s:%g,%g"):format(point, (to == nil or to == b) and "row" or (to:GetName() or "?"), relative, x, y)
            end
            table.sort(out)
            return table.concat(out, " ")
          end
          r[#r + 1] = b.id .. " " .. describe(b.instanceName) .. " | " .. describe(b.enableButton)
        end
      end
      return table.concat(r, ";")`)[0].split(";");
    // Stock anchors, untouched: the name between its row's LEFT (40) and the level text's LEFT (-10),
    // the check box on the (hidden) lock icon's centre. The renderer spans and measures both now.
    assert.equal(anchors.length, 10);
    for (const row of anchors) {
      const header = row.startsWith("-");
      assert.match(row, header
        ? /^-?\d+ LEFT>row:LEFT:40,0 RIGHT>row:RIGHT:0,0 \| /
        : /^\d+ LEFT>row:LEFT:40,0 RIGHT>LFDQueueFrameSpecificListButton\d+InstanceLevel:LEFT:-10,0 \| /, row);
      assert.match(row, /\| CENTER>LFDQueueFrameSpecificListButton\d+LockedIndicator:CENTER:0,0$/, row);
    }
    // The name's second anchor counts in the bridge's own geometry: its right edge is the level's
    // left minus 10, not its left edge plus the text's width.
    const spans = lua(boot, `local r = {}
      for i = 1, NUM_LFD_CHOICE_BUTTONS do
        local b = _G["LFDQueueFrameSpecificListButton" .. i]
        if b:IsVisible() and b.level:IsShown() then
          r[#r + 1] = ("%.2f %.2f %.2f"):format(math.abs(b.level:GetLeft() - 10 - b.instanceName:GetRight()),
            math.abs(b.instanceName:GetLeft() - b:GetLeft() - 40),
            math.abs(b.instanceName:GetWidth() - (b.instanceName:GetRight() - b.instanceName:GetLeft())))
        end
      end
      return table.concat(r, ";")`)[0].split(";");
    assert.ok(spans.length >= 8, spans.join(";"));
    for (const span of spans) assert.equal(span, "0.00 0.00 0.00", spans.join(";"));

    assert.deepEqual(lua(boot, "local p, to, rp = LFDSearchStatus:GetPoint(1) return LFDSearchStatus:GetParent():GetName(), LFDSearchStatus:GetFrameStrata(), p, to:GetName(), rp", 5),
      ["MiniMapLFGFrame", "TOOLTIP", "TOPRIGHT", "MiniMapLFGFrame", "TOPLEFT"], "stock parentage; the renderer's strata layer draws it");
    seam.lfd.popupsOwned = true;
    seam.lfdWorld.queue([259 | (6 << 24)], 95);
    lua(boot, "MiniMapLFGFrame_OnEnter(MiniMapLFGFrame)", 0);
    assert.deepEqual(lua(boot, "return LFDSearchStatus:IsVisible() and 1 or 0"), [1]);
    // Leaving the queue hides the eye under the pointer (no OnLeave): the box goes with its parent.
    seam.lfdWorld.unqueue();
    assert.deepEqual(lua(boot, "return MiniMapLFGFrame:IsShown() and 1 or 0, LFDSearchStatus:IsVisible() and 1 or 0", 2), [0, 0]);

    installFrameXmlLfdToggle(boot, () => {});
    lua(boot, "SlashCmdList.RAIDBROWSER('')", 0);
    assert.deepEqual(lua(boot, "return LFRParentFrame:IsShown() and 1 or 0"), [0], "/raidbrowser opens no empty raid browser");
    const owner = createFrameXmlLfdOwner(boot, gate.frame);
    lua(boot, "HideUIPanel(LFDParentFrame) ShowUIPanel(LFRParentFrame)", 0);
    assert.equal(owner.isOpen(), true, "an add-on's direct ShowUIPanel(LFRParentFrame) is the finder owner's to close");
    owner.hide();
    assert.deepEqual(lua(boot, "return LFRParentFrame:IsShown() and 1 or 0, LFDParentFrame:IsShown() and 1 or 0", 2), [0, 0]);
    assert.equal(boot.errorCount, errors, JSON.stringify(boot.errors.slice(errors).map((e) => `${e.file}:${e.line} ${e.message}`)));
  } finally {
    boot.close();
  }
});

test("over a version-1 catalog the loaded stock finder stays quiet: the eye works, no popup, no gate", withClient, async () => {
  // The running gateway serves version 1 until the owner restarts it: the model has no catalog.
  const { FrameXmlLfdModel } = await import("../dist/code/browser/framexml/FrameXmlLfd.js");
  const { FrameXmlCannedLfdWorld } = await import("../dist/code/browser/framexml/FrameXmlLfdCanned.js");
  const world = new FrameXmlCannedLfdWorld();
  const model = new FrameXmlLfdModel({
    world: () => world, catalog: () => undefined, playerLevel: () => 80, playerClassId: () => 1, playerName: () => "x",
    playerGuid: () => FRAMEXML_CANNED_LFD_PLAYER_GUID, playerFaction: () => "Alliance", partyMemberCount: () => 0,
    raidMemberCount: () => 0, isPartyLeader: () => false, inDungeonInstance: () => false,
  });
  const seam = new CannedWorldSeam();
  Object.defineProperty(seam, "lfd", { value: model });
  const { boot } = await load(FRAMEXML_VERTICAL_TOC, seam);
  try {
    const errors = boot.errorCount;
    world.emit({ kind: "playerInfo" });
    world.queue([261 | (6 << 24)], 10);
    assert.deepEqual(lua(boot, "return MiniMapLFGFrame:IsShown() and 1 or 0"), [1], "the eye follows the queue without a catalog");
    lua(boot, "MiniMapLFGFrame_OnEnter(MiniMapLFGFrame)", 0);
    assert.deepEqual(lua(boot, "return LFDSearchStatus:IsShown() and 1 or 0"), [1]);
    world.propose(261 | (6 << 24));
    assert.deepEqual(lua(boot, "return LFDDungeonReadyPopup:IsShown() and 1 or 0"), [0], "the native prompt keeps the proposal");
    assert.equal(frameXmlLfdGate(seam, boot, renderer()), undefined, "no stock finder is published");
    assert.equal(boot.errorCount, errors);
  } finally {
    boot.close();
  }
});
