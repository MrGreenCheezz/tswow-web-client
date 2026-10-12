// 3.24 (12.10): the raid pullouts of Blizzard_RaidUI — a group, a class or a member dragged out of the Raid tab
// becomes a RaidPulloutFrameTemplate window of RaidPulloutButtonTemplate rows over the raid roster
// (Blizzard_RaidUI.lua:693-1316, Blizzard_RaidUI.xml:57-63/252-275/353-358/852-937), loaded by the world
// mount's lazy owner (FrameXmlRaidLod.ts) over the canned ten-player raid.
import assert from "node:assert/strict";
import test, { after } from "node:test";

function fakeDocument() {
  const doc = {
    activeElement: undefined,
    createElement(tag) { return makeNode(tag); },
    createElementNS(_namespace, tag) { return makeNode(tag); },
    getElementById() { return makeNode("div"); },
    querySelectorAll() { return []; },
  };
  function makeNode(tag) {
    const attributes = new Map();
    const listeners = new Map();
    const classes = new Set();
    const node = {
      ownerDocument: doc, tagName: String(tag).toUpperCase(), children: [], parentElement: undefined,
      parentNode: undefined, style: { setProperty(name, value) { this[name] = String(value); }, removeProperty(name) { delete this[name]; } },
      hidden: false, className: "", dataset: {}, textContent: "", value: "", disabled: false,
      offsetWidth: 0, offsetHeight: 0, scrollTop: 0, scrollHeight: 0, clientHeight: 0,
      classList: {
        add(...names) { for (const name of names) classes.add(name); node.className = [...classes].join(" "); },
        remove(...names) { for (const name of names) classes.delete(name); node.className = [...classes].join(" "); },
        toggle(name, force) {
          const enabled = force === undefined ? !classes.has(name) : force;
          if (enabled) classes.add(name); else classes.delete(name);
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
        if (index < 0) node.children.push(child); else node.children.splice(index, 0, child);
      },
      removeChild(child) {
        const index = node.children.indexOf(child);
        if (index >= 0) node.children.splice(index, 1);
        if (child.parentElement === node) child.parentElement = undefined;
        if (child.parentNode === node) child.parentNode = undefined;
      },
      replaceChildren(...children) { node.children = []; node.append(...children); },
      remove() { node.parentElement?.removeChild(node); },
      setAttribute(name, value) { attributes.set(String(name), String(value)); },
      getAttribute(name) { return attributes.get(String(name)) ?? null; },
      removeAttribute(name) { attributes.delete(String(name)); },
      addEventListener(name, listener) { listeners.set(name, [...(listeners.get(name) ?? []), listener]); },
      removeEventListener(name, listener) { listeners.set(name, (listeners.get(name) ?? []).filter((value) => value !== listener)); },
      dispatchEvent(event) { for (const listener of listeners.get(event.type) ?? []) listener(event); },
      querySelector() { return undefined; },
      querySelectorAll() { return []; },
      closest() { return null; },
      focus() { doc.activeElement = node; },
      blur() { if (doc.activeElement === node) doc.activeElement = undefined; },
      getContext() { return undefined; },
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
const { mountFrameXmlRaidGrid } = await import("../dist/code/browser/framexml/FrameXmlRaidLod.js");
const { frameXmlCannedRaid } = await import("../dist/code/browser/framexml/FrameXmlRaidLodCanned.js");

const decoder = new TextDecoder("utf-8");

function lua(boot, code, count = 1) {
  const fn = boot.vm.compileFunction(code, "raid-pullout-test", []);
  assert.ok(fn, "the probe compiles");
  try { return boot.vm.call(fn, [], count); } finally { boot.vm.release(fn); }
}

let sharedChain;
after(() => sharedChain?.close());

async function stage() {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const chain = sharedChain ??= await clientArchives(clientDirectory);
  const seam = new CannedWorldSeam();
  frameXmlCannedRaid(seam.socialWorld);
  const boot = new FrameXmlBoot({
    provider: { async read(path) { const data = await chain.read(path); return data ? decoder.decode(data) : undefined; } },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, exercise: false, screen: () => ({ width: 1024, height: 768 }),
  });
  const host = document.createElement("section");
  const renderer = new FrameXmlDomRenderer(host, { bridge: boot.bridge });
  await boot.load();
  renderer.mount(boot.roots);
  const mounted = mountFrameXmlRaidGrid(seam, boot, renderer);
  await mounted.owner.settled();
  return { seam, boot, renderer, mounted, close: () => { mounted?.cleanup(); seam.detach(); boot.close(); } };
}

const shownRows = (boot, frame) => lua(boot, `
  local rows = {}
  for i = 1, ${frame}.numPulloutButtons do
    local button = ${frame}.buttons[i]
    if button:IsShown() then rows[#rows + 1] = tostring(button.nameLabel:GetText()) .. ":" .. tostring(button.healthbar:GetValue()) end
  end
  return table.concat(rows, ",")`)[0];

test("a group dragged out of the Raid tab becomes a pullout of its members, and stays where it is dropped", { skip }, async () => {
  const run = await stage();
  const { boot } = run;
  try {
    assert.equal(run.mounted.owner.state, "ready");
    const errors = boot.errorCount;
    // The group label's drag (Blizzard_RaidUI.xml:353-358): the pullout opens under the cursor and starts moving.
    boot.bridge.setMousePosition(500, 400);
    lua(boot, "RaidPulloutButton_OnDragStart(RaidPullout_GeneratePulloutFrame(1))", 0);
    assert.deepEqual(lua(boot, `local point, _, relative, x, y = RaidPullout1:GetPoint(1)
      return RaidPullout1:IsShown() and 1 or 0, RaidPullout1.label:GetText(), point .. ":" .. relative .. ":" .. x .. ":" .. y`, 3),
    [1, `${lua(boot, "return GROUP")[0]} 1`, "TOP:BOTTOMLEFT:500:400"]);
    assert.equal(boot.bridge.getFrame("RaidPullout1").moving, true, "StartMoving: the window follows the cursor");
    // Group 1: the four canned party members and the player, by UnitName over `raidN` (Blizzard_RaidUI.lua:917).
    // Дельта is offline: stock greys her row (Blizzard_RaidUI.lua:933-943). The player's row is `raid10`, the last.
    assert.equal(shownRows(boot, "RaidPullout1"), "Альфа:3600,Бета:2200,Гамма:2500,Дельта:1,Игрок:4230");
    // RaidPulloutStopMoving (Blizzard_RaidUI.lua:1161-1177): ClearAllPoints, then GetCenter/GetTop re-anchor it there.
    const before = lua(boot, "return RaidPullout1:GetLeft(), RaidPullout1:GetTop()", 2);
    lua(boot, "RaidPulloutStopMoving(RaidPullout1)", 0);
    assert.deepEqual(lua(boot, "return RaidPullout1:GetLeft(), RaidPullout1:GetTop()", 2), before,
      "the cleared frame keeps its place for GetCenter/GetTop, as Wow.exe's does");
    assert.equal(boot.bridge.getFrame("RaidPullout1").moving, false);
    assert.equal(lua(boot, "return RAID_PULLOUT_POSITIONS['1'] and RAID_PULLOUT_POSITIONS['1'].point or 'none'")[0], "TOP",
      "and saves its spot for RaidPullout_RenewFrames");
    // A class button's drag (Blizzard_RaidUI.xml:57-63): a pullout of that class.
    lua(boot, "RaidPulloutButton_OnDragStart(RaidPullout_GeneratePulloutFrame('PRIEST', 'Жрец')) RaidPulloutStopMoving()", 0);
    assert.equal(lua(boot, "return RaidPullout2.label:GetText()")[0], "Жрец");
    assert.match(shownRows(boot, "RaidPullout2"), /^Бета:2200/);
    assert.equal(boot.errorCount, errors, `no Lua error: ${boot.vm.errors.slice(-3).join(" | ")}`);
  } finally {
    run.close();
  }
});

test("in a raid, raidN is a unit: the member's name and stats, the player's own row, and its UNIT_* edges", async () => {
  const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
  const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
  const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
  const call = (seam, name, ...args) => [...FRAMEXML_SEAM_BINDINGS[name](seam, args)];
  const listeners = new Map();
  const events = {
    on(name, listener) { listeners.set(name, [...(listeners.get(name) ?? []), listener]); return () => {}; },
    emit(name, payload) { for (const listener of listeners.get(name) ?? []) listener(payload); },
  };
  const selfGuid = 0x10n;
  const self = { guid: selfGuid, typeId: 4, fields: new Map([
    [UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 700], [UPDATE_FIELDS.UNIT_FIELD_MAXHEALTH.offset, 800],
  ]) };
  const member = (guid, name) => ({ guid, name, online: true, status: 1, subGroup: 0, flags: 0, roles: 0 });
  const world = {
    state: { selfGuid, objects: new Map([[selfGuid, self]]) }, events, casts: new Map(), actionButtons: [],
    cooldownSnapshots: new Map(), channels: new Map(), battlefieldQueues: new Map(), knownSpells: [],
    names: new Map([[selfGuid, "Игрок"]]), partyStats: new Map(), selfName: "Игрок",
    group: { groupType: 0x02, leaderGuid: selfGuid, members: [member(0x21n, "Альфа"), member(0x22n, "Бета")] },
    displayName: (guid) => `0x${guid.toString(16)}`,
  };
  // SMSG_PARTY_MEMBER_STATS for a raid member (TrinityCore sends it to the whole raid): GROUP_UPDATE_CUR_HP | MAX_HP.
  world.partyStats.set(0x22n, { flags: 0x02 | 0x04, health: 900, maxHealth: 1000 });
  const seam = new LiveWorldSeam({ world: () => world, store: () => undefined });
  const fired = [];
  seam.attach({ now: () => 1, fire(event, ...args) { fired.push([event, ...args]); return 1; } });
  try {
    assert.deepEqual(call(seam, "UnitName", "raid1"), ["Альфа"]);
    assert.deepEqual(call(seam, "UnitName", "raid2"), ["Бета"]);
    assert.deepEqual([call(seam, "UnitHealth", "raid2")[0], call(seam, "UnitHealthMax", "raid2")[0]], [900, 1000],
      "out of sight, from the member's stats");
    assert.deepEqual(call(seam, "UnitExists", "raid1"), [true]);
    assert.deepEqual(call(seam, "UnitIsConnected", "raid1"), [true]);
    assert.deepEqual([call(seam, "UnitHealth", "raid3")[0], call(seam, "UnitHealthMax", "raid3")[0]], [700, 800],
      "the row after the listed members is the player");
    assert.deepEqual(call(seam, "UnitExists", "raid4"), [false]);
    fired.length = 0;
    events.emit("PARTY_MEMBER_STATS", { guid: 0x22n });
    assert.deepEqual(fired.filter(([event]) => event === "UNIT_HEALTH" || event === "UNIT_MAXHEALTH"),
      [["UNIT_HEALTH", "raid2"], ["UNIT_MAXHEALTH", "raid2"]], "the raid pullouts' rows hear their member");
    // A party is not a raid: no raid units, and the stats speak for partyN as before.
    world.group = { ...world.group, groupType: 0 };
    assert.deepEqual(call(seam, "UnitName", "raid1"), []);
    fired.length = 0;
    events.emit("PARTY_MEMBER_STATS", { guid: 0x22n });
    assert.deepEqual(fired.filter(([event]) => event === "UNIT_HEALTH"), [["UNIT_HEALTH", "party2"]]);
  } finally {
    seam.detach();
  }
});
