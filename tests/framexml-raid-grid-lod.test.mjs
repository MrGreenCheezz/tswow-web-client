import assert from "node:assert/strict";
import test, { after } from "node:test";

// The real Blizzard_RaidUI from the client's MPQs, loaded on demand by the lazy owner the world mount
// publishes (FrameXmlRaidLod.ts), over the vertical corpus and the canned social world: nothing at
// boot or outside a raid, the first RAID_ROSTER_UPDATE loads it through the host (never stock's
// UIParentLoadAddOn, which would show «Ошибка загрузки» while the files are on their way), the gate
// fills the grid with stock RaidFrame_Update, and stock keeps it current from there.

function fakeDocument() {
  const ids = new Map();
  const doc = {
    activeElement: undefined,
    head: undefined,
    createElement(tag) { return makeNode(tag); },
    createElementNS(_namespace, tag) { return makeNode(tag); },
    getElementById(id) {
      if (!ids.has(id)) ids.set(id, makeNode("div"));
      return ids.get(id);
    },
    querySelectorAll() { return []; },
  };
  function style() {
    return {
      setProperty(name, value) { this[name] = String(value); },
      removeProperty(name) { delete this[name]; },
    };
  }
  function makeNode(tag) {
    const attributes = new Map();
    const listeners = new Map();
    const classes = new Set();
    const node = {
      ownerDocument: doc, tagName: String(tag).toUpperCase(), children: [], parentElement: undefined,
      parentNode: undefined, style: style(), hidden: false, className: "", dataset: {}, textContent: "",
      value: "", disabled: false, width: 0, height: 0, offsetLeft: 0, offsetTop: 0, offsetWidth: 0,
      offsetHeight: 0, scrollTop: 0, scrollHeight: 0, clientHeight: 0,
      classList: {
        add(...names) { for (const name of names) classes.add(name); node.className = [...classes].join(" "); },
        remove(...names) { for (const name of names) classes.delete(name); node.className = [...classes].join(" "); },
        toggle(name, force) {
          const enabled = force === undefined ? !classes.has(name) : force;
          if (enabled) classes.add(name); else classes.delete(name);
          node.className = [...classes].join(" ");
          return enabled;
        },
        contains(name) { return classes.has(name); },
      },
      get nextSibling() {
        const siblings = node.parentElement?.children ?? [];
        const index = siblings.indexOf(node);
        return index < 0 ? null : siblings[index + 1] ?? null;
      },
      append(...children) {
        for (const child of children) {
          if (!child) continue;
          child.parentElement?.removeChild(child);
          child.parentElement = node;
          child.parentNode = node;
          node.children.push(child);
        }
      },
      insertBefore(child, before) {
        child.parentElement?.removeChild(child);
        child.parentElement = node;
        child.parentNode = node;
        const index = node.children.indexOf(before);
        if (index < 0) node.children.push(child);
        else node.children.splice(index, 0, child);
      },
      removeChild(child) {
        const index = node.children.indexOf(child);
        if (index >= 0) node.children.splice(index, 1);
        if (child.parentElement === node) child.parentElement = undefined;
        if (child.parentNode === node) child.parentNode = undefined;
      },
      replaceChildren(...children) {
        for (const child of node.children) {
          child.parentElement = undefined;
          child.parentNode = undefined;
        }
        node.children = [];
        node.append(...children);
      },
      remove() { node.parentElement?.removeChild(node); },
      setAttribute(name, value) { attributes.set(String(name), String(value)); },
      getAttribute(name) { return attributes.get(String(name)) ?? null; },
      removeAttribute(name) { attributes.delete(String(name)); },
      addEventListener(name, listener) { listeners.set(name, [...(listeners.get(name) ?? []), listener]); },
      removeEventListener(name, listener) {
        listeners.set(name, (listeners.get(name) ?? []).filter((value) => value !== listener));
      },
      dispatchEvent(event) { for (const listener of listeners.get(event.type) ?? []) listener(event); },
      querySelector(selector) { return selector === 'button[type="submit"]' ? makeNode("button") : undefined; },
      querySelectorAll() { return []; },
      closest() { return null; },
      focus() { doc.activeElement = node; },
      blur() { if (doc.activeElement === node) doc.activeElement = undefined; },
      setSelectionRange() {},
      getContext() { return undefined; },
      // The whole stage: a wheel "inside" any rendered box (the owner's wheel hand-off reads it).
      getBoundingClientRect() { return { left: 0, top: 0, right: 1024, bottom: 768, width: 1024, height: 768 }; },
    };
    return node;
  }
  doc.head = makeNode("head");
  return doc;
}

globalThis.document = fakeDocument();
globalThis.window = {
  devicePixelRatio: 1, innerWidth: 1024, innerHeight: 768,
  addEventListener() {}, removeEventListener() {}, requestAnimationFrame: () => 1, cancelAnimationFrame() {},
};

globalThis.location = { protocol: "http:", hostname: "localhost" };
globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };

let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const skip = clientDirectory ? false : "no 3.3.5a client on this machine";

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FrameXmlDomRenderer } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlDomRenderer.js");
const { installFrameXmlFriendsRoutes } = await import("../dist/code/browser/framexml/FrameXmlFriendsOwner.js");
const { FRAMEXML_RAID_ADDON, frameXmlRaidGridGate, mountFrameXmlRaidGrid } = await import(
  "../dist/code/browser/framexml/FrameXmlRaidLod.js",
);
const { FRAMEXML_CANNED_RAID_SIZE, frameXmlCannedRaid } = await import(
  "../dist/code/browser/framexml/FrameXmlRaidLodCanned.js",
);

const decoder = new TextDecoder("utf-8");
const normalize = (path) => path.replaceAll("\\", "/").toLowerCase();
const ADDON_PREFIX = "interface/addons/blizzard_raidui/";

function lua(boot, code, count = 1) {
  const fn = boot.vm.compileFunction(code, "raid-grid-test", []);
  assert.ok(fn, "the probe compiles");
  try { return boot.vm.call(fn, [], count); } finally { boot.vm.release(fn); }
}

async function settle(condition, rounds = 400) {
  for (let round = 0; round < rounds && !condition(); round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

// tools/mpq.mjs shares one chain per client directory across the process: close it once, at the end.
let sharedChain;
after(() => sharedChain?.close());

/** The vertical over the canned seam, rendered, with the friends routes the mount installs first. */
async function stage({ barrier = false, missing = false, broken = false, raid = false } = {}) {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const chain = sharedChain ??= await clientArchives(clientDirectory);
  const requests = [];
  const bytes = new Map();
  let release;
  const gate = barrier ? new Promise((resolve) => { release = resolve; }) : undefined;
  const seam = new CannedWorldSeam();
  if (raid) frameXmlCannedRaid(seam.socialWorld);
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        const key = normalize(path);
        requests.push(key);
        if (!key.startsWith(ADDON_PREFIX)) {
          const data = await chain.read(path);
          return data ? decoder.decode(data) : undefined;
        }
        if (gate) await gate;
        if (missing) return undefined;
        const data = await chain.read(path);
        if (data) bytes.set(key, data.byteLength);
        const text = data ? decoder.decode(data) : undefined;
        // A grid that loads and then raises in its first update: what the gate must catch.
        return broken && text && key.endsWith("/blizzard_raidui.lua")
          ? `${text}\nfunction RaidGroupFrame_Update() error("broken grid") end\n` : text;
      },
    },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, exercise: false, screen: () => ({ width: 1024, height: 768 }),
  });
  const host = document.createElement("section");
  const renderer = new FrameXmlDomRenderer(host, { bridge: boot.bridge });
  let addonResult;
  const loadAddon = boot.loadAddon.bind(boot);
  boot.loadAddon = async (name) => (addonResult = await loadAddon(name));
  await boot.load();
  renderer.mount(boot.roots);
  assert.equal(installFrameXmlFriendsRoutes(boot, { toggle() {}, open() {} }), true);
  // Every stock message() — UIParentLoadAddOn's «Ошибка загрузки» goes through it.
  lua(boot, `__raidMessages = {}
    local say = message
    message = function(text, ...) __raidMessages[#__raidMessages + 1] = tostring(text) return say(text, ...) end`, 0);
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  const mounted = mountFrameXmlRaidGrid(seam, boot, renderer);
  const addonReads = () => requests.filter((path) => path.startsWith(ADDON_PREFIX));
  return {
    seam, boot, renderer, mounted, requests, bytes, addonReads, warnings,
    release: () => release?.(), addon: () => addonResult,
    messages: () => lua(boot, "return table.concat(__raidMessages, '|')")[0],
    /** One 60 ms poll of the raid model: RAID_ROSTER_UPDATE when the roster changed. */
    roster: (group) => {
      seam.socialWorld.group = group;
      seam.friends.tick();
    },
    close: () => { console.warn = warn; mounted?.cleanup(); seam.detach(); boot.close(); },
  };
}

const shownButtons = (boot) => lua(boot, `
  local shown = {}
  for index = 1, MAX_RAID_MEMBERS do
    local button = _G["RaidGroupButton" .. index]
    if button:IsShown() then shown[#shown + 1] = index .. "=" .. tostring(button.name) end
  end
  return table.concat(shown, ",")`)[0];

test("Blizzard_RaidUI: nothing outside a raid, then the first raid roster loads it through the host with no dialog", { skip }, async () => {
  const run = await stage({ barrier: true });
  const { seam, boot, mounted } = run;
  try {
    assert.equal(FRAMEXML_VERTICAL_TOC.some((entry) => /raidui/i.test(entry)), false, "the add-on is not in the boot corpus");
    assert.ok(mounted, "RaidFrame.xml is loaded, so the owner takes RaidFrame_LoadUI");
    assert.equal(mounted.owner.state, "idle");
    await settle(() => false, 5);
    assert.deepEqual(run.addonReads(), [], "not in a raid: nothing is read");
    assert.equal(boot.bridge.getFrame("RaidGroup1")?.name, undefined);
    const widgets = boot.bridge.frames.length;
    const errors = boot.errorCount;
    const diagnostics = boot.bridge.diagnostics.length;

    // The canned party becomes a raid: RAID_ROSTER_UPDATE, RaidFrame_OnEvent, RaidFrame_LoadUI.
    run.roster((seam.socialWorld.groupList(true), seam.socialWorld.group));
    await settle(() => run.addonReads().length > 0);
    assert.equal(mounted.owner.state, "loading");
    // What stock's UIParentLoadAddOn would have turned into «Ошибка загрузки (Blizzard_RaidUI)».
    assert.deepEqual(lua(boot, "return LoadAddOn('Blizzard_RaidUI')", 2), [false, "NOT_READY"]);
    // A second roster edge while the files are on their way: no dialog and no second load.
    const group = seam.socialWorld.group;
    run.roster({ ...group, counter: group.counter + 1, members: group.members.map((member, index) =>
      index === 2 ? { ...member, flags: 0x01 } : member) });
    assert.equal(lua(boot, "return table.concat(__raidMessages, '|')")[0], "", "no load-error dialog while loading");
    run.release();
    await mounted.owner.settled();

    assert.equal(mounted.owner.state, "ready");
    assert.equal(run.messages(), "", "no stock message() at all");
    assert.equal(boot.errorCount, errors, `no Lua error: ${boot.vm.errors.slice(-3).join(" | ")}`);
    assert.equal(boot.bridge.diagnostics.length, diagnostics, "no bridge diagnostic");
    const result = run.addon();
    assert.equal(result.ok, true, result.message);
    assert.equal(result.addon, FRAMEXML_RAID_ADDON);
    assert.deepEqual(result.loaded, [
      `${ADDON_PREFIX}blizzard_raidui.toc`, `${ADDON_PREFIX}blizzard_raidui.xml`,
      `${ADDON_PREFIX}blizzard_raidui.lua`, `${ADDON_PREFIX}localization.lua`,
    ]);
    assert.equal(new Set(run.addonReads()).size, 4, "one load: each file read once");
    // The closure, measured on this client's MPQs.
    assert.deepEqual([...run.bytes.entries()].sort(), [
      [`${ADDON_PREFIX}blizzard_raidui.lua`, 47215],
      [`${ADDON_PREFIX}blizzard_raidui.toc`, 200],
      [`${ADDON_PREFIX}blizzard_raidui.xml`, 38227],
      [`${ADDON_PREFIX}localization.lua`, 51],
    ]);
    assert.equal(boot.bridge.frames.length - widgets, 794, "the add-on's widget tree, measured");
    assert.deepEqual(lua(boot, "return LoadAddOn('Blizzard_RaidUI')", 2), [true, undefined]);
    assert.deepEqual(lua(boot, "return RaidFrame:GetScript('OnEvent') == RaidGroupFrame_OnEvent", 1), [true]);
    // The gate's RaidFrame_Update filled group 1 with the canned five, the player last.
    assert.equal(shownButtons(boot), "1=Альфа,2=Бета,3=Гамма,4=Дельта,5=Игрок");
    assert.deepEqual(lua(boot, `return RaidGroup1:IsShown(), RaidGroup8:IsShown(), RaidGroup1Slot1.button,
      RaidGroupButton5Name:GetText(), RaidGroupButton1Class:GetText(), RaidGroupButton5Level:GetText()`, 6),
    [true, true, "RaidGroupButton1", "Игрок", "Воин", "60"]);
    // The templates' parent="RaidFrame" holds (nothing of the grid is a top-level root), and the bar is
    // drawn under the name, level and class.
    assert.deepEqual(lua(boot, `return RaidGroup8:GetParent() == RaidFrame, RaidGroupButton40:GetParent() == RaidFrame,
      RaidGroupButton1:GetNormalTexture():GetDrawLayer(), RaidGroupButton1Name:GetDrawLayer()`, 4),
    [true, true, "BACKGROUND", "ARTWORK"]);
  } finally {
    run.close();
  }
});

test("a ten-player raid at publish loads at once, fills two groups, and the grid follows the roster", { skip }, async () => {
  const run = await stage({ raid: true });
  const { seam, boot, mounted } = run;
  try {
    assert.equal(mounted.owner.state, "loading", "RaidFrame's PLAYER_LOGIN branch: already in a raid");
    await mounted.owner.settled();
    assert.equal(mounted.owner.state, "ready");
    const errors = boot.errorCount;
    assert.deepEqual(lua(boot, "return GetNumRaidMembers()"), [FRAMEXML_CANNED_RAID_SIZE]);
    assert.equal(shownButtons(boot),
      "1=Альфа,2=Бета,3=Гамма,4=Дельта,5=Аэлинда,6=Хельга,7=Ивор,8=Прайм,9=Сая,10=Игрок");
    // Group 1: the canned four and the player; group 2: five guildmates.
    assert.deepEqual(lua(boot, `return RaidGroup1Slot5.button, RaidGroup2Slot1.button, RaidGroup2Slot5.button,
      RaidGroup3Slot1.button`, 4), ["RaidGroupButton10", "RaidGroupButton5", "RaidGroupButton9", undefined]);
    // Rank, role and loot icons from the wire flags; Дельта offline in grey.
    assert.deepEqual(lua(boot, `return RaidGroupButton10RankTexture:GetTexture(), RaidGroupButton1RankTexture:GetTexture(),
      RaidGroupButton2RoleTexture:GetTexture(), RaidGroupButton6RoleTexture:GetTexture(),
      RaidGroupButton5LootTexture:GetTexture(), RaidGroupButton3Rank:IsShown()`, 6).map((value) =>
      typeof value === "string" ? value.toLowerCase() : value), [
      "interface\\groupframe\\ui-group-leadericon", "interface\\groupframe\\ui-group-assistanticon",
      "interface\\groupframe\\ui-group-maintankicon", "interface\\groupframe\\ui-group-mainassisticon",
      "interface\\groupframe\\ui-group-masterlooter", false,
    ]);
    assert.deepEqual(lua(boot, "local r, g, b = RaidGroupButton4Name:GetTextColor() return r, g, b", 3), [0.5, 0.5, 0.5]);
    // The class counts: seven warriors; UnitClassBase names the button after its first raider.
    const warrior = lua(boot, `local button = _G["RaidClassButton" .. RAID_CLASS_BUTTONS.WARRIOR.button]
      return button.count, button.class, button.fileName, button:IsEnabled()`, 4);
    assert.deepEqual(warrior, [7, "Воин", "WARRIOR", 1]);
    lua(boot, `RaidClassButton_OnEnter(_G["RaidClassButton" .. RAID_CLASS_BUTTONS.WARRIOR.button])`, 0);
    assert.match(lua(boot, "return GameTooltipTextLeft1:GetText()")[0], /^Воин.*\(7\)/, "the class button's tooltip");
    assert.deepEqual(lua(boot, "return RaidFrameReadyCheckButton:IsShown(), RaidFrameRaidBrowserButton:IsShown()", 2),
      [true, true], "the leader's ready check");
    // The roster follows: Сая leaves, then the raid disbands.
    const group = seam.socialWorld.group;
    run.roster({ ...group, counter: group.counter + 1, members: group.members.slice(0, -1) });
    assert.equal(shownButtons(boot), "1=Альфа,2=Бета,3=Гамма,4=Дельта,5=Аэлинда,6=Хельга,7=Ивор,8=Прайм,9=Игрок");
    run.roster(undefined);
    assert.equal(shownButtons(boot), "");
    assert.deepEqual(lua(boot, "return RaidGroup1:IsShown(), RaidFrameNotInRaid:IsShown()", 2), [false, true]);
    assert.equal(boot.errorCount, errors, `no Lua error: ${boot.vm.errors.slice(-3).join(" | ")}`);
    assert.equal(run.messages(), "");
    assert.deepEqual(run.warnings, []);
  } finally {
    run.close();
  }
});

const anchor = (boot, button) =>
  lua(boot, `local point, slot = ${button}:GetPoint(1) return point .. ":" .. (slot and slot:GetName() or "")`)[0];

/**
 * Stock's leader drag, as the renderer drives it: OnDragStart, the hovered slot, the drop point
 * committed as the button's one TOPLEFT anchor (FrameXmlDomRenderer `finishDrag`), OnDragStop.
 */
const drag = (boot, button, slot) => lua(boot, `RaidGroupButton_OnDragStart(${button})
  TARGET_RAID_SLOT = ${slot}
  ${button}:ClearAllPoints()
  ${button}:SetPoint("TOPLEFT", RaidFrame, "TOPLEFT", 150, -200)
  RaidGroupButton_OnDragStop(${button})`, 0);

test("a leader's drag asks the server with CMSG_GROUP_CHANGE_SUB_GROUP; what it cannot send snaps back", { skip }, async () => {
  const run = await stage({ raid: true });
  const { seam, boot, mounted } = run;
  try {
    await mounted.owner.settled();
    assert.equal(mounted.owner.state, "ready");
    const errors = boot.errorCount;
    const world = seam.socialWorld;
    assert.equal(world.changeSubGroup, undefined, "the canned social world has no server to ask");
    // No world to send through: stock moves Бета into group 3, the grid puts her back from the roster.
    drag(boot, "RaidGroupButton2", "RaidGroup3Slot1");
    assert.equal(anchor(boot, "RaidGroupButton2"), "TOPLEFT:RaidGroup1Slot2");
    assert.deepEqual(lua(boot, "return RaidGroup3Slot1.button, RaidGroup1Slot2.button, select(3, GetRaidRosterInfo(2))", 3),
      [undefined, "RaidGroupButton2", 1]);

    // A server: WorldClient.changeSubGroup(name, 0-based group) is CMSG_GROUP_CHANGE_SUB_GROUP.
    const sent = [];
    world.changeSubGroup = (name, subGroup) => sent.push([name, subGroup]);
    drag(boot, "RaidGroupButton2", "RaidGroup3Slot1");
    assert.deepEqual(sent, [["Бета", 2]]);
    assert.equal(anchor(boot, "RaidGroupButton2"), "TOPLEFT:RaidGroup3Slot1", "stock's own move, until the list comes");
    // The server's SMSG_GROUP_LIST: RAID_ROSTER_UPDATE, and the grid draws Бета in group 3.
    const group = world.group;
    run.roster({ ...group, counter: group.counter + 1, members: group.members.map((member) =>
      member.name === "Бета" ? { ...member, subGroup: 2 } : member) });
    assert.deepEqual(lua(boot, "return RaidGroup3Slot1.button, select(3, GetRaidRosterInfo(2))", 2), ["RaidGroupButton2", 3]);
    assert.equal(anchor(boot, "RaidGroupButton2"), "TOPLEFT:RaidGroup3Slot1");

    // Onto a member: SwapRaidSubgroup, which TrinityCore 3.3.5 does not handle. Nothing is sent and
    // Альфа stays in group 1; so does Хельга, whose slot she was dropped on.
    drag(boot, "RaidGroupButton1", "RaidGroup2Slot2");
    assert.deepEqual(sent, [["Бета", 2]]);
    assert.equal(anchor(boot, "RaidGroupButton1"), "TOPLEFT:RaidGroup1Slot1");
    assert.equal(anchor(boot, "RaidGroupButton6"), "TOPLEFT:RaidGroup2Slot2");
    // What the handler would drop is not sent either: a full group (group 2 holds five), the
    // member's own group, a group past eight, a row past the roster.
    lua(boot, "SetRaidSubgroup(1, 2) SetRaidSubgroup(1, 1) SetRaidSubgroup(1, 9) SetRaidSubgroup(11, 4)", 0);
    assert.deepEqual(sent, [["Бета", 2]]);
    // Nor is anything from a plain member (not the leader, no assistant flag).
    world.group = { ...world.group, leaderGuid: 0x501n };
    lua(boot, "SetRaidSubgroup(3, 4)", 0);
    assert.deepEqual(sent, [["Бета", 2]]);
    world.group = { ...world.group, ownFlags: 0x01 };
    lua(boot, "SetRaidSubgroup(3, 4)", 0);
    assert.deepEqual(sent, [["Бета", 2], ["Гамма", 3]], "an assistant moves members too");
    assert.equal(boot.errorCount, errors, `no Lua error: ${boot.vm.errors.slice(-3).join(" | ")}`);
    assert.equal(run.messages(), "");
  } finally {
    run.close();
  }
});

test("a failed load stays silent: no dialog, RaidFrame as it was, and no second attempt", { skip }, async () => {
  const run = await stage({ missing: true });
  const { seam, boot, mounted } = run;
  try {
    lua(boot, "__raidOnEvent = RaidFrame:GetScript('OnEvent')", 0);
    const errors = boot.errorCount;
    run.roster((seam.socialWorld.groupList(true), seam.socialWorld.group));
    await settle(() => mounted.owner.state !== "idle");
    await mounted.owner.settled();
    assert.equal(mounted.owner.state, "failed");
    const reads = run.addonReads().length;
    assert.ok(reads > 0);
    assert.deepEqual(lua(boot, "return RaidFrame:GetScript('OnEvent') == __raidOnEvent", 1), [true]);
    assert.deepEqual(lua(boot, "return LoadAddOn('Blizzard_RaidUI')", 2), [false, "MISSING"],
      "stock's UIParentLoadAddOn would answer this with the dialog");
    const group = seam.socialWorld.group;
    run.roster({ ...group, counter: group.counter + 1, members: group.members.slice(0, -1) });
    await settle(() => false, 5);
    assert.equal(run.addonReads().length, reads, "demoted for good: nothing is read again");
    assert.equal(run.messages(), "", "no «Ошибка загрузки» dialog");
    assert.equal(boot.errorCount, errors, `no Lua error: ${boot.vm.errors.slice(-3).join(" | ")}`);
    assert.match(run.warnings.join("\n"), /Blizzard_RaidUI/);
    assert.equal(frameXmlRaidGridGate(seam, boot, run.renderer), undefined, "and the gate has nothing to pass");
  } finally {
    run.close();
  }
});

test("a grid that fails its gate is taken back: RaidFrame's own handlers return and later rosters raise nothing", { skip }, async () => {
  const run = await stage({ broken: true });
  const { seam, boot, mounted } = run;
  try {
    lua(boot, "__raidOnEvent, __raidUpdate = RaidFrame:GetScript('OnEvent'), RaidGroupFrame_Update", 0);
    lua(boot, "__raidSet, __raidSwap = SetRaidSubgroup, SwapRaidSubgroup", 0);
    run.roster((seam.socialWorld.groupList(true), seam.socialWorld.group));
    await settle(() => mounted.owner.state !== "idle");
    await mounted.owner.settled();
    assert.equal(mounted.owner.state, "failed");
    assert.match(run.warnings.join("\n"), /did not pass its gate/);
    // The add-on ran (its inline OnLoad took RaidFrame over) and is put back.
    assert.equal(run.addon().ok, true);
    assert.deepEqual(lua(boot, `return RaidFrame:GetScript('OnEvent') == __raidOnEvent, RaidGroupFrame_Update == __raidUpdate,
      RaidFrame:GetScript('OnUpdate') == nil, RaidGroup1:IsShown(), RaidGroupButton1:IsShown(), RaidClassButton1:IsShown(),
      SetRaidSubgroup == __raidSet, SwapRaidSubgroup == __raidSwap`, 8),
    [true, true, true, false, false, false, true, true]);
    const errors = boot.errorCount;
    const group = seam.socialWorld.group;
    run.roster({ ...group, counter: group.counter + 1, members: group.members.slice(0, -1) });
    lua(boot, "RaidFrame_Update()", 0);
    assert.equal(boot.errorCount, errors, `the broken grid is not reached again: ${boot.vm.errors.slice(-2).join(" | ")}`);
    assert.equal(run.messages(), "", "no «Ошибка загрузки» dialog");
    assert.deepEqual(lua(boot, "return RaidGroup1:IsShown(), RaidGroupButton1:IsShown()", 2), [false, false]);
  } finally {
    run.close();
  }
});
