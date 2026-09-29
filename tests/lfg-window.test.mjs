import assert from "node:assert/strict";
import test from "node:test";

function makeNode(tag, id) {
  const node = {
    tagName: String(tag).toUpperCase(), id: id ?? "", children: [], dataset: {},
    className: "", textContent: "", hidden: false, tabIndex: -1, value: "", checked: false,
    listeners: new Map(), attributes: new Map(), style: {},
    append(...children) { for (const child of children) { child.parentNode = node; node.children.push(child); } },
    replaceChildren(...children) { node.children = [...children]; for (const child of children) child.parentNode = node; },
    remove() {},
    addEventListener(name, handler) { node.listeners.set(name, handler); },
    setAttribute(name, value) { node.attributes.set(name, String(value)); },
    getAttribute(name) { return node.attributes.get(name) ?? null; },
    classList: {
      add(...names) { node.className = [...new Set([...node.className.split(" ").filter(Boolean), ...names])].join(" "); },
      contains(name) { return node.className.split(" ").includes(name); },
    },
    querySelector() { return makeNode("button"); },
  };
  return node;
}

function fakeDocument() {
  const byId = new Map();
  return {
    createElement: (tag) => makeNode(tag),
    body: makeNode("body"),
    documentElement: makeNode("html"),
    getElementById: (id) => {
      if (!byId.has(id)) byId.set(id, makeNode("div", id));
      return byId.get(id);
    },
    querySelectorAll: () => [],
    __byId: byId,
  };
}

globalThis.document = fakeDocument();
globalThis.location = { origin: "http://127.0.0.1:5173", protocol: "http:", hostname: "127.0.0.1" };
globalThis.window = { innerWidth: 1280, innerHeight: 720, addEventListener() {}, removeEventListener() {} };

const { game } = await import("../dist/code/browser/game/Context.js");
const social = await import("../dist/code/browser/ui/Social.js");
const dom = await import("../dist/code/browser/ui/Dom.js");
const windows = await import("../dist/code/browser/ui/Windows.js");

function fakeWorld() {
  const sent = [];
  return {
    sent,
    lfgProposal: undefined,
    lfgStatus: undefined,
    lfgQueue: undefined,
    lfgMessage: undefined,
    lfgPlayerInfo: {
      dungeons: [
        { entry: (6 << 24) | 258, reward: { done: false, money: 4866, experience: 1500, items: [{ itemId: 45624, displayId: 0, count: 2 }] } },
        { entry: (6 << 24) | 259, reward: { done: true, money: 1000, experience: 0, items: [] } },
      ],
      locks: [{ dungeonId: (6 << 24) | 259, reason: 2 }],
    },
    state: { selfGuid: 1n, objects: new Map() },
    itemTemplate: () => undefined,
    requestDungeonLocks: () => sent.push("locks"),
  };
}

function reset() {
  game.world = undefined;
  game.spells = new Map();
  game.gatewayOrigin = undefined;
  game.itemMetadata = undefined;
}

test("the classic window lists random dungeons with rewards, locks and a join entry", () => {
  const world = fakeWorld();
  game.world = world;
  try {
    dom.lfgType.value = "random";
    dom.lfgWindow.hidden = true;
    social.toggleLfgWindow();
    assert.deepEqual(world.sent, ["locks"], "opening the window refreshes locks and rewards");
    assert.equal(dom.lfgWindow.hidden, false);
    assert.equal(dom.lfgRandomPane.hidden, false);
    assert.equal(dom.lfgSpecificPane.hidden, true);
    const radios = dom.lfgRandomList.children.filter((row) => row.tagName === "LABEL");
    assert.equal(radios.length, 2);
    const rowText = (row) => row.children.filter((child) => child.tagName === "SPAN")
      .map((span) => span.textContent).join("");
    assert.match(rowText(radios[0]), /Подземелье 258/);
    assert.match(rowText(radios[1]), /Недоступно|уровень/, "a locked row names its lock reason");
    assert.deepEqual(social.selectedLfgDungeons(), [(6 << 24) | 258],
      "the first unlocked random dungeon is preselected, locks never are");
    assert.match(dom.lfgRewardNote.textContent, /Дополнительная награда/);
    const rewards = dom.lfgRewards.children.map((row) => row.children
      .filter((child) => child.tagName === "SPAN").map((span) => span.textContent).join("")
      || row.textContent).join(" | ");
    assert.match(rewards, /48с 66м/, "money renders through the money formatter");
    assert.match(rewards, /предмет 45624|×2/, "reward items render with their count");
    assert.match(rewards, /\+1500 опыта/, "the parsed experience reward is finally drawn");
    const lockIcon = radios[1].children.find((child) => child.className === "lfg-lock-icon");
    assert.ok(lockIcon, "a locked random row carries the stock lock icon");
    assert.equal(typeof lockIcon.title, "string", "the lock icon explains itself on hover");
    // Switching to the locked row flips the note and keeps a single join entry.
    const lockedRadio = radios[1].children.find((child) => child.tagName === "INPUT");
    lockedRadio.checked = true;
    lockedRadio.listeners.get("change")();
    assert.deepEqual(social.selectedLfgDungeons(), [(6 << 24) | 259]);
    assert.match(dom.lfgRewardNote.textContent, /уже получена/);
    social.closeLfgWindow();
    assert.equal(dom.lfgWindow.hidden, true);
  } finally { reset(); }
});

test("the queue panel shows one stock role slot per role with waits and needs", () => {
  const world = fakeWorld();
  world.lfgQueue = {
    dungeonId: 258, waitTimeAverage: 120000, waitTime: -1,
    waitTimeTank: 60000, waitTimeHealer: -1, waitTimeDamage: 90000,
    tanksNeeded: 1, healersNeeded: 0, damageNeeded: 2, queuedSeconds: 300,
  };
  game.world = world;
  try {
    dom.lfgType.value = "specific";
    dom.lfgWindow.hidden = true;
    social.toggleLfgWindow();
    const slots = dom.lfgQueue.children.filter((child) => child.classList.contains("lfg-queue-role"));
    assert.deepEqual(slots.map((slot) => slot.dataset.lfgRole), ["tank", "healer", "damage"]);
    const label = (slot) => slot.children.map((child) => child.textContent).join("");
    assert.match(label(slots[0]), /1 мин · нужно 1/);
    assert.match(label(slots[1]), /\? · нужно 0/, "an unknown wait is a question mark, not a zero");
    assert.match(label(slots[2]), /2 мин · нужно 2/);
    assert.equal(dom.lfgQueue.children.some((child) => child.textContent === "В очереди 5 мин"), true);
    assert.equal(dom.lfgQueue.children.some((child) => child.textContent === "Подземелье 258"), true);
    social.closeLfgWindow();
  } finally { reset(); }
});

test("role buttons paint the stock atlas cells instead of emoji", () => {
  const world = fakeWorld();
  game.world = world;
  game.gatewayOrigin = "http://127.0.0.1:8090";
  try {
    dom.lfgType.value = "specific";
    dom.lfgWindow.hidden = true;
    social.toggleLfgWindow();
    // Stock GetTexCoordsForRole cells on the 256px/67px atlas: tank 1,2 / healer 2,1 /
    // damage 2,2 / leader (guide) 1,1, painted as background-position on .lfg-role-fg.
    const cells = [
      [dom.lfgTankIcon, "tank", "0.00% 35.45%"],
      [dom.lfgHealerIcon, "healer", "35.45% 0.00%"],
      [dom.lfgDamageIcon, "damage", "35.45% 35.45%"],
      [dom.lfgLeaderIcon, "leader", "0.00% 0.00%"],
    ];
    for (const [box, role, position] of cells) {
      assert.equal(box.dataset.lfgRole, role);
      assert.match(box.dataset.lfgCrop, /382\.09%/,
        `${role} crops one 67px cell of the 256px atlas`);
      assert.match(box.dataset.lfgCrop, new RegExp(position.replaceAll(".", "\\.").replaceAll("%", "\\%")),
        `${role} sits in its stock cell`);
    }
    social.closeLfgWindow();
  } finally { reset(); }
});

const catalogRows = [
  { id: 10, name: "Deadmines", minLevel: 15, maxLevel: 21, type: 1, difficulty: 0, expansion: 0, description: "" },
  { id: 20, name: "Scarlet Monastery", minLevel: 26, maxLevel: 45, type: 1, difficulty: 0, expansion: 0, description: "" },
  { id: 30, name: "The Nexus", minLevel: 71, maxLevel: 73, type: 1, difficulty: 1, expansion: 2, description: "" },
  { id: 40, name: "Utgarde Pinnacle", minLevel: 75, maxLevel: 80, type: 1, difficulty: 0, expansion: 2, description: "" },
  { id: 58, name: "Elwynn Forest", minLevel: 1, maxLevel: 14, type: 4, difficulty: 0, expansion: 0, description: "" },
  { id: 259, name: "Raid", minLevel: 80, maxLevel: 80, type: 2, difficulty: 0, expansion: 2, description: "" },
  { id: 258, name: "Random Dungeon", minLevel: 15, maxLevel: 58, type: 6, difficulty: 0, expansion: 0, description: "" },
];

test("filters group the catalog, count the visible rows and act on exactly those", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => String(url).includes("/dbc/lfg-dungeons")
    ? { ok: true, json: async () => ({ dungeons: catalogRows }) }
    : { ok: false, status: 404 };
  const world = fakeWorld();
  game.world = world;
  game.gatewayOrigin = "http://127.0.0.1:8123";
  try {
    dom.lfgType.value = "specific";
    dom.lfgWindow.hidden = true;
    social.toggleLfgWindow();
    for (let tick = 0; tick < 8; tick++) await new Promise(setImmediate);
    const rows = () => dom.lfgDungeonList.children.filter((child) => child.classList.contains("lfg-dungeon-row"));
    assert.equal(rows().length, 4);
    const headers = dom.lfgDungeonList.children.filter((child) => child.className === "lfg-group");
    assert.deepEqual(headers.map((header) => header.textContent.split(" · ")[0]),
      ["Классика", "Wrath of the Lich King"], "two eras earn their headings, in era order");
    assert.match(dom.lfgCatalogStatus.textContent, /4 из 4/,
      "zone, raid and random catalog metadata do not inflate the specific dungeon count");

    dom.lfgHeroicOnly.checked = true;
    dom.lfgHeroicOnly.listeners.get("change")();
    assert.equal(rows().length, 1);
    assert.match(rows()[0].children.map((child) => child.textContent).join(""), /The Nexus/);

    dom.lfgHeroicOnly.checked = false;
    dom.lfgExpansion.value = "0";
    dom.lfgExpansion.listeners.get("change")();
    assert.equal(rows().length, 2);
    assert.equal(dom.lfgDungeonList.children.some((child) => child.className === "lfg-group"), false,
      "one era is a plain list");

    dom.lfgSelectVisible.listeners.get("click")();
    for (let tick = 0; tick < 4; tick++) await new Promise(setImmediate);
    assert.match(dom.lfgCatalogStatus.textContent, /2 из 4 · выбрано 2/);
    dom.lfgClearSelection.listeners.get("click")();
    for (let tick = 0; tick < 4; tick++) await new Promise(setImmediate);
    assert.doesNotMatch(dom.lfgCatalogStatus.textContent, /выбрано/);
  } finally {
    globalThis.fetch = originalFetch;
    social.closeLfgWindow();
    reset();
  }
});

test("leave and teleport are disabled until the queue or a proposal exists", () => {
  const world = fakeWorld();
  game.world = world;
  try {
    dom.lfgType.value = "specific";
    dom.lfgWindow.hidden = true;
    social.toggleLfgWindow();
    assert.equal(dom.lfgLeave.disabled, true);
    assert.equal(dom.lfgTeleport.disabled, true);
    world.lfgStatus = { updateType: 0, joined: true, queued: true, dungeons: [], comment: "" };
    social.showLfg();
    assert.equal(dom.lfgLeave.disabled, false);
    assert.equal(dom.lfgTeleport.disabled, false);
    social.closeLfgWindow();
  } finally { reset(); }
});

test("LFG rejects leader-only selection before sending and updates Join on role changes", () => {
  const world = fakeWorld();
  const localMessages = [];
  world.pushLocalMessage = (message) => localMessages.push(message);
  world.joinLfg = (roles, dungeons) => world.sent.push({ roles, dungeons });
  game.world = world;
  try {
    dom.lfgType.value = "random";
    dom.lfgTank.checked = false;
    dom.lfgHealer.checked = false;
    dom.lfgDamage.checked = true;
    dom.lfgLeader.checked = false;
    dom.lfgWindow.hidden = true;
    social.toggleLfgWindow();
    windows.wirePanelButtons();
    assert.equal(dom.lfgJoin.disabled, false);

    dom.lfgDamage.checked = false;
    dom.lfgLeader.checked = true;
    dom.lfgLeader.listeners.get("change")?.();
    assert.equal(dom.lfgJoin.disabled, true, "leader alone cannot satisfy a combat role");
    assert.match(dom.lfgJoin.title, /танк|лекар|урон/i);
    dom.lfgJoin.listeners.get("click")();
    assert.deepEqual(world.sent, ["locks"], "even a programmatic click cannot send an invalid queue request");
    assert.match(localMessages.at(-1)?.text, /танк|лекар|урон/i);

    dom.lfgHealer.checked = true;
    dom.lfgHealer.listeners.get("change")?.();
    assert.equal(dom.lfgJoin.disabled, false);
    dom.lfgJoin.listeners.get("click")();
    assert.equal(world.sent[1].roles, 5, "a leader can queue when a combat role is also selected");
    assert.equal(world.sent[1].dungeons.length, 1);
  } finally {
    dom.lfgTank.checked = false;
    dom.lfgHealer.checked = false;
    dom.lfgDamage.checked = true;
    dom.lfgLeader.checked = false;
    social.closeLfgWindow();
    reset();
  }
});

test("specific mode keeps the catalog, manual ids and role checkboxes", () => {
  const world = fakeWorld();
  game.world = world;
  try {
    dom.lfgType.value = "specific";
    dom.lfgDungeons.value = "261, 261";
    dom.lfgTank.checked = false;
    dom.lfgHealer.checked = false;
    dom.lfgDamage.checked = true;
    dom.lfgWindow.hidden = true;
    social.toggleLfgWindow();
    assert.equal(dom.lfgRandomPane.hidden, true);
    assert.equal(dom.lfgSpecificPane.hidden, false);
    assert.deepEqual(social.selectedLfgDungeons(), [261],
      "manual ids still work and deduplicate when the catalog is unreachable");
    assert.equal(social.selectedLfgRoles(), 8, "the damage checkbox stays the default role");
    social.closeLfgWindow();
  } finally { reset(); }
});
