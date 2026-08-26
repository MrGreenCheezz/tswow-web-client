import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

/**
 * М7: the named places a module may reach inside a window this client wrote itself.
 *
 * The document below is the widget tests' own, with three things added that the slot machinery
 * actually uses — `classList.remove`, a `querySelector` that resolves `[data-widget="…"]`, and
 * `serialise`, which turns a subtree into one comparable string.
 *
 * That last one is the whole acceptance test of this slice. «Unloading leaves the interface byte
 * for byte as it was» is not checkable by looking at the screen and it is not checkable by
 * asserting that the button is gone: a `hidden` left `false` where it had been `true`, a class
 * removed but the `data-module` mark left behind, a host emptied but replaced — every one of those
 * passes an assertion about the button and fails the promise. So the target frame is serialised
 * before the patch and after it is taken away, and the two strings are compared.
 */
function fakeDocument() {
  const make = (tag) => {
    const node = {
      tagName: tag.toUpperCase(),
      children: [],
      parent: undefined,
      dataset: {},
      style: {
        setProperty(name, value) { this[name] = value; },
        removeProperty(name) { delete this[name]; },
      },
      className: "",
      textContent: "",
      hidden: false,
      listeners: new Map(),
      classList: {
        add(...names) { node.className = [...new Set([...node.className.split(" ").filter(Boolean), ...names])].join(" "); },
        remove(...names) { node.className = node.className.split(" ").filter((one) => one && !names.includes(one)).join(" "); },
        toggle(name, on) { on ? this.add(name) : this.remove(name); },
        contains(name) { return node.className.split(" ").includes(name); },
      },
      append(...nodes) {
        for (const child of nodes) child.parent = node;
        node.children.push(...nodes);
      },
      replaceChildren(...nodes) {
        for (const child of nodes) child.parent = node;
        node.children = [...nodes];
      },
      remove() {
        if (!node.parent) return;
        node.parent.children = node.parent.children.filter((child) => child !== node);
        node.parent = undefined;
      },
      querySelector(selector) {
        const wanted = /^\[data-widget="(.*)"\]$/.exec(selector)?.[1];
        if (wanted === undefined) return null;
        const walk = (from) => {
          for (const child of from.children) {
            if (child.dataset.widget === wanted) return child;
            const found = walk(child);
            if (found) return found;
          }
          return null;
        };
        return walk(node);
      },
      addEventListener(name, handler) { node.listeners.set(name, handler); },
      getBoundingClientRect() { return { left: 0, top: 0, bottom: 0, right: 0, width: 0, height: 0 }; },
      closest() { return undefined; },
      dispatchEvent() { return true; },
      isConnected: true,
    };
    return node;
  };
  return { createElement: make, body: make("body"), head: make("head") };
}

globalThis.document = fakeDocument();
const { usePanelHost } = await import("../dist/code/browser/ui/Widgets.js");
usePanelHost({ viewport: document.createElement("div"), attach: () => {}, detach: () => {} });

const {
  FILLABLE_SLOTS, HIDE_ONLY_SLOTS, SKINNABLE_WINDOWS, SLOT_NAMES, clearSlot, fillSlot,
  fillableSlots, forgetSlots, hideSlot, resetSlots, skinWindow, skinnable, slot, slotElement,
  slotHoldings, slotInstances, slotNames, slotSiblings, windowNames,
} = await import("../dist/code/browser/ui/Slots.js");
const { parseWindowPatch, moduleUiKind, patchWidgets } = await import("../dist/code/browser/ui/WindowSchema.js");
const { applyWindowPatch } = await import("../dist/code/browser/ui/WindowPatch.js");
const { renderWindow } = await import("../dist/code/browser/ui/WindowRender.js");
const { PatchRegistry, WindowRegistry } = await import("../dist/code/browser/ui/WindowRegistry.js");
const { checkWindowPatch, patchTargetProblems, runWindowActions } = await import("../dist/code/browser/ui/WindowActions.js");
const { ModuleLoader } = await import("../dist/code/browser/ui/ModuleLoader.js");
const { CustomPacketRegistry } = await import("../dist/code/world/CustomPacketRegistry.js");
const { loadModulePatch, windowsView, windowsSignature } = await import("../dist/code/browser/ui/WindowsTab.js");

/* ---------------------------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------------------------- */

/** One node's whole state as a string: tag, classes, attributes, `hidden`, style, text, children. */
function serialise(node) {
  const data = Object.keys(node.dataset).sort().map((key) => `${key}=${node.dataset[key]}`).join(",");
  const style = Object.keys(node.style)
    .filter((key) => typeof node.style[key] !== "function")
    .sort().map((key) => `${key}:${node.style[key]}`).join(";");
  const head = `<${node.tagName} class="${node.className}" data(${data}) hidden=${node.hidden}`
    + ` style(${style}) text="${node.textContent}">`;
  return `${head}${node.children.map(serialise).join("")}</${node.tagName}>`;
}

function element(tag, options = {}) {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text) node.textContent = options.text;
  if (options.hidden !== undefined) node.hidden = options.hidden;
  return node;
}

/** The target frame as `index.html` builds it, small enough to serialise. */
function targetFrame() {
  const panel = element("section", { className: "unit-frame target-frame" });
  const details = element("span", { className: "muted", text: "Кабан · зверь · ур. 5" });
  const actions = element("div", { className: "frame-actions" });
  actions.append(element("button", { className: "frame-action", text: "⚔" }));
  actions.append(element("button", { className: "frame-action", text: "🛒", hidden: true }));
  panel.append(details, actions);
  slot("target-frame/details", details);
  slot("target-frame/actions", actions);
  skinnable("target-frame", panel);
  return { panel, details, actions };
}

const BUY_BUTTON = {
  id: "buy",
  type: "Button",
  width: 60,
  height: 20,
  anchor: { point: "LEFT", relativeTo: "parent", relativePoint: "LEFT", x: 0, y: 0 },
  text: { ru: "Купить", en: "Buy" },
  // Greyed out when there is nothing to buy from — and it is what puts `target` among the roots the
  // patch declares, since an action list is not read on the frame pass and never counts as one.
  enabled: "{target.exists}",
  action: [{ do: "sendCustom", message: "shop.Buy", value: { guid: "{target.guid}" } }],
};

function patchFile(extra = {}) {
  return {
    kind: "patch",
    id: "target-extras",
    target: "target-frame",
    hide: ["target-frame/details"],
    add: [{ slot: "target-frame/actions", widget: BUY_BUTTON }],
    class: { "target-frame": "shop-skin" },
    ...extra,
  };
}

function parsePatch(raw, module = "shop") {
  const result = parseWindowPatch(raw, { module });
  assert.ok(result.patch, `the fixture has to parse: ${result.problems.join("; ")}`);
  return result.patch;
}

/** The three tables a patch is checked against, exactly as `ModuleClient` hands them over. */
const slotTables = () => ({
  slotNames: new Set(SLOT_NAMES),
  fillableSlots: new Set(FILLABLE_SLOTS),
  skinnableWindows: new Set(SKINNABLE_WINDOWS),
});

const SNAPSHOT = { target: { exists: true, guid: "42", name: "Кабан" }, player: { exists: true } };

/** The real action runner, wired to a world that only records what it was asked to send. */
function actionHost(sent, problems = []) {
  return {
    registry: new WindowRegistry(),
    world: { customPackets: { send: (name, value) => sent.push({ name, value }) } },
    snapshot: () => SNAPSHOT,
    onProblem: (text) => problems.push(text),
  };
}

const runsThroughSeam = (sent, problems) => ({
  runActions: (actions, context) => runWindowActions(actions, context, actionHost(sent, problems)),
});

test.beforeEach(() => { resetSlots(); });

/* ---------------------------------------------------------------------------------------------
 * The registry
 * ------------------------------------------------------------------------------------------- */

test("a slot declared after a module asked for it still gets filled", () => {
  const built = [];
  const off = fillSlot("minimap/buttons", {
    build: (instance) => {
      built.push(instance.name);
      return element("button", { text: "M" });
    },
  }, "shop");
  // Nothing to fill yet: the minimap is built at runtime and a patch is applied on entering the
  // world. This is the ordinary order, not the exceptional one.
  assert.deepEqual(built, []);

  const controls = element("div", { className: "minimap-controls" });
  slot("minimap/buttons", controls);
  assert.deepEqual(built, ["minimap/buttons"]);
  assert.equal(controls.children.length, 1);
  assert.equal(controls.children[0].textContent, "M");

  off();
  assert.equal(controls.children.length, 0, "and taking the fill back empties the host again");
});

test("two modules fill one slot, and dropping one leaves the other standing", () => {
  const controls = element("div");
  slot("minimap/buttons", controls);
  const offShop = fillSlot("minimap/buttons", { build: () => element("button", { text: "S" }) }, "shop");
  fillSlot("minimap/buttons", { build: () => element("button", { text: "B" }) }, "bank");
  assert.deepEqual(controls.children.map((child) => child.textContent), ["S", "B"]);

  offShop();
  assert.deepEqual(controls.children.map((child) => child.textContent), ["B"]);
});

test("a fill may decline a place, and it is asked about each one separately", () => {
  const first = element("footer");
  const second = element("footer");
  slot("bag-window/footer", first, { bag: 1 });
  slot("bag-window/footer", second, { bag: 2 });
  fillSlot("bag-window/footer", {
    build: (instance) => (instance.params.bag === 2 ? element("em", { text: "вторая" }) : undefined),
  }, "shop");

  assert.equal(first.children.length, 0, "a widget that only makes sense for one bag says so");
  assert.deepEqual(second.children.map((child) => child.textContent), ["вторая"]);
});

test("hiding a slot remembers what `hidden` was, not what it wishes it had been", () => {
  const shown = element("span");
  const already = element("span", { hidden: true });
  slot("target-frame/details", shown);
  slot("player-frame/experience", already);

  const offShown = hideSlot("target-frame/details", "shop");
  const offAlready = hideSlot("player-frame/experience", "shop");
  assert.equal(shown.hidden, true);
  assert.equal(already.hidden, true);

  offShown();
  offAlready();
  assert.equal(shown.hidden, false);
  // The one that matters: a widget the client had already hidden must not be *shown* by a module
  // letting go of it. `hidden = false` on the way out is a module turning something on that nobody
  // asked for, and it would look exactly like a bug in the client.
  assert.equal(already.hidden, true);
});

test("a slot asked to be hidden before it was declared is hidden the moment it appears", () => {
  // The same lateness a fill has, on the other verb: a patch is applied on entering the world and
  // the minimap's clock is built when the frame is. Without this the hide would land on nothing and
  // never be asked again, and the file would look like it did nothing at all.
  const off = hideSlot("minimap/clock", "shop");
  const clock = element("div", { className: "minimap-clock" });
  slot("minimap/clock", clock);
  assert.equal(clock.hidden, true);

  off();
  assert.equal(clock.hidden, false);
});

test("two modules hiding one slot: it comes back when the last of them lets go", () => {
  const details = element("span");
  slot("target-frame/details", details);
  const offShop = hideSlot("target-frame/details", "shop");
  hideSlot("target-frame/details", "bank");

  offShop();
  assert.equal(details.hidden, true, "the other module still wants it hidden");
  forgetSlots("bank");
  assert.equal(details.hidden, false);
});

test("forget takes back everything one module put in, and puts back what it took away", () => {
  const { panel, details, actions } = targetFrame();
  const before = serialise(panel);

  fillSlot("target-frame/actions", { build: () => element("button", { text: "К" }) }, "shop");
  hideSlot("target-frame/details", "shop");
  skinWindow("target-frame", "shop-skin", "shop");
  assert.equal(actions.children.length, 3);
  assert.equal(details.hidden, true);
  assert.equal(panel.dataset.module, "shop");

  forgetSlots("shop");
  assert.equal(serialise(panel), before);
});

test("a window is handed back the mark it was already carrying, not stripped of it", () => {
  const { panel } = targetFrame();
  // The client does not put `data-module` on a built-in window today, and this is the promise that
  // it may: what a skin restores is what it *found*, not the absence of an attribute. A `delete` on
  // the way out would be a module quietly taking something off a node it does not own.
  panel.dataset.module = "client";
  const before = serialise(panel);

  const offShop = skinWindow("target-frame", "shop-skin", "shop");
  assert.equal(panel.dataset.module, "shop");
  const offBank = skinWindow("target-frame", "bank-skin", "bank");
  // Both classes are on it and the mark carries the latest owner, so the second module's rules are
  // the ones that can reach the window's own element.
  assert.ok(panel.classList.contains("shop-skin"));
  assert.ok(panel.classList.contains("bank-skin"));
  assert.equal(panel.dataset.module, "bank");

  offBank();
  assert.equal(panel.dataset.module, "shop", "the module still skinning it gets the mark back");
  assert.ok(!panel.classList.contains("bank-skin"));
  offShop();
  assert.equal(serialise(panel), before);
});

test("declaring one name twice is one place, and the second host is the one that is filled", () => {
  // `slot()` is called from panels that draw themselves, so it has to be idempotent: a name
  // declared again is the *same* place with a new host, never a second place. The two panels that
  // redraw keep one host and move it back in — see `CharacterSheet.ts` — so nothing in the client
  // leans on this today; it is what stops the day one of them stops doing that from being a leak
  // of one dead host, holding one copy of a module's widget, per redraw.
  const stats = element("div", { className: "character-stats" });
  let built = 0;
  fillSlot("character-window/stats", {
    build: () => {
      built++;
      return element("p", { text: "мой блок" });
    },
  }, "shop");

  const first = slotElement("character-window/stats");
  stats.replaceChildren(element("section"), first);
  assert.equal(built, 1);
  assert.equal(first.children.length, 1);

  const second = slotElement("character-window/stats");
  stats.replaceChildren(element("section"), second);
  assert.equal(built, 2);
  assert.equal(second.children.length, 1);
  assert.equal(first.children.length, 0, "and the host that was replaced is handed back empty");
  assert.equal(slotInstances("character-window/stats").length, 1, "one name, one place");
});

test("a panel redrawn beside its slot host never rewrites the row the host is in", () => {
  // The character sheet's shape, and the point of `slotSiblings`. Keeping one host and handing it
  // back to `replaceChildren` saves the node — nothing is rebuilt, nothing in it is lost — but the
  // DOM's «replace all» removes every child first, the host with it, and removing a focused element
  // unfocuses it. `showCharacterSheet` runs once a frame, so an `EditBox` in this slot would have
  // kept its text and lost the caret sixty times a second. So the container is written once and
  // never again, which is what this counts.
  const stats = element("div", { className: "character-stats" });
  const host = slotElement("character-window/stats");
  fillSlot("character-window/stats", { build: () => element("input") }, "shop");

  const draw = slotSiblings(stats, host);
  let rewrites = 0;
  const real = stats.replaceChildren.bind(stats);
  stats.replaceChildren = (...nodes) => { rewrites++; real(...nodes); };

  draw([element("section", { text: "Общее" }), element("section", { text: "Бой" })]);
  draw([element("section", { text: "Общее" })]);
  draw([]);
  assert.equal(rewrites, 0, "the host's own row is written when the window is built and never again");
  assert.equal(stats.children.length, 2, "one box for the panel's blocks, and the host beside it");
  assert.equal(stats.children[1], host);
  assert.equal(host.parent, stats, "and the module's widget is still where the module put it");
  assert.equal(host.children.length, 1);
  // The blocks really are redrawn — otherwise the assertion above would pass on a draw that does
  // nothing at all.
  assert.equal(stats.children[0].className, "ui-slot-siblings");
  assert.equal(stats.children[0].children.length, 0);
  draw([element("section", { text: "Общее" })]);
  assert.equal(stats.children[0].children.length, 1);
});

test("no panel hands its slot host to a redraw, because a redraw is a removal", () => {
  // Written against the source, and it is the only seam there is: the panels that own these hosts
  // import `Dom.ts`, which resolves 193 elements the moment it loads and can only run inside the
  // real page. What it guards is the case the test above describes — `replaceChildren` removes
  // every child first, so a host passed back in as one of the new children is still removed, and a
  // removed element loses focus. The rule is mechanical: a name bound to `slotElement(…)` may not
  // appear inside a `replaceChildren(…)` anywhere in the file that made it.
  const files = readdirSync("src/browser/ui").filter((name) => name.endsWith(".ts"));
  const offenders = [];
  let hostsFound = 0;
  for (const name of files) {
    const text = readFileSync(`src/browser/ui/${name}`, "utf8");
    const hosts = [...text.matchAll(/const\s+(\w+)\s*=\s*slotElement\(/g)].map((match) => match[1]);
    hostsFound += hosts.length;
    for (const line of text.split("\n")) {
      if (!line.includes("replaceChildren(")) continue;
      for (const host of hosts) {
        if (new RegExp(`\\b${host}\\b`).test(line)) offenders.push(`${name}: ${line.trim()}`);
      }
    }
  }
  // The three a built-in binds to a name and keeps: the sheet's two and the spellbook's tab strip.
  // The bags' host is appended where it is made and never named again, so nothing can pass it on.
  assert.equal(hostsFound, 3);
  assert.deepEqual(offenders, []);
});

test("what a module still holds is given back, and the books do not remember that it ever did", () => {
  // `owned` only ever grew: one apply-and-drop is one save of the file an author is editing, and
  // every one of them left its closures behind — each holding the fill, its widget and every copy
  // it drew — for the life of the tab.
  const actions = element("div");
  slot("target-frame/actions", actions);
  const panel = element("section");
  skinnable("target-frame", panel);

  for (let round = 0; round < 3; round++) {
    const off = [
      fillSlot("target-frame/actions", { build: () => element("button") }, "shop"),
      hideSlot("target-frame/details", "shop"),
      skinWindow("target-frame", "shop-skin", "shop"),
    ];
    assert.equal(slotHoldings("shop"), 3, `round ${round}`);
    for (const drop of off) drop();
    assert.equal(slotHoldings("shop"), 0, `round ${round}: and nothing is kept after they are given back`);
    // Twice is a no-op and not a second removal, which is what makes the same unsubscribe safe to
    // run from `forgetSlots` after the list has already been dropped.
    for (const drop of off) drop();
    assert.equal(slotHoldings("shop"), 0);
  }
  assert.equal(actions.children.length, 0);
  forgetSlots("shop");
  assert.equal(slotHoldings("shop"), 0);
});

test("a slot declared once per row gives every row its own copy, and clearSlot drops the lot", () => {
  const seen = [];
  fillSlot("quest-log/entry-actions", {
    build: (instance) => {
      seen.push(instance.params.questId);
      return element("button", { text: `q${instance.params.questId}` });
    },
  }, "shop");

  const hosts = [11, 22, 33].map((questId) => {
    const host = element("div", { className: "actions" });
    slot("quest-log/entry-actions", host, { questId });
    return host;
  });
  assert.deepEqual(seen, [11, 22, 33]);
  assert.deepEqual(hosts.map((host) => host.children[0].textContent), ["q11", "q22", "q33"]);

  clearSlot("quest-log/entry-actions");
  assert.deepEqual(hosts.map((host) => host.children.length), [0, 0, 0]);
  assert.equal(slotInstances("quest-log/entry-actions").length, 0);
});

test("the table of names is the contract, and it is what a patch is checked against", () => {
  // Not «whatever has called `slot()` so far»: a patch is applied on entering the world and most of
  // these panels have not been drawn yet, so a check against the live set would refuse a good file.
  assert.equal(slotNames().length, SLOT_NAMES.length);
  assert.deepEqual([...slotNames()], [...SLOT_NAMES]);
  assert.equal(slotInstances("quest-log/entry-actions").length, 0);
  assert.ok(slotNames().includes("quest-log/entry-actions"));
  assert.ok(!slotNames().includes("quest-log/entry-buttons"));
  assert.deepEqual([...windowNames()], [...SKINNABLE_WINDOWS]);
  // Every slot name is `<окно>/<часть>`, and the window half of a *fill* slot is a window a patch
  // may also skin — otherwise a file could reach into a window it cannot name.
  for (const name of SLOT_NAMES) {
    assert.match(name, /^[a-z-]+\/[a-z-]+$/, name);
  }

  // Ten to hide, seven to fill, and the two tables together are the ten with nothing over and
  // nothing missing: a name in neither is unreachable, a name in both twice is two refusals.
  assert.deepEqual([...SLOT_NAMES], [...FILLABLE_SLOTS, ...HIDE_ONLY_SLOTS]);
  assert.deepEqual([...fillableSlots()], [...FILLABLE_SLOTS]);
  assert.equal(FILLABLE_SLOTS.length + HIDE_ONLY_SLOTS.length, SLOT_NAMES.length);
  for (const name of HIDE_ONLY_SLOTS) {
    assert.ok(slotNames().includes(name), name);
    assert.ok(!fillableSlots().includes(name), `${name} takes a hide and not a widget`);
  }
});

/* ---------------------------------------------------------------------------------------------
 * The file
 * ------------------------------------------------------------------------------------------- */

test("a patch file is told apart from a window by its kind and by nothing else", () => {
  assert.equal(moduleUiKind(patchFile()), "patch");
  assert.equal(moduleUiKind({ kind: "addon", id: "x" }), "addon");
  assert.equal(moduleUiKind({ kind: "screen" }), "");
  assert.equal(moduleUiKind("not an object"), "");
});

test("a patch parses into the three things it may do, and its widget goes through the widget reader", () => {
  const patch = parsePatch(patchFile());
  assert.equal(patch.id, "target-extras");
  assert.equal(patch.module, "shop");
  assert.equal(patch.target, "target-frame");
  assert.deepEqual([...patch.hide], ["target-frame/details"]);
  assert.equal(patch.add.length, 1);
  assert.equal(patch.add[0].slot, "target-frame/actions");
  assert.equal(patch.add[0].widget.type, "Button");
  // The localised pair collapses to the Russian half exactly as it does in a window, and the action
  // list is compiled rather than carried as text.
  assert.deepEqual(patch.add[0].widget.text, { node: "string", value: "Купить" });
  assert.equal(patch.add[0].widget.actions[0].do, "sendCustom");
  assert.deepEqual(patch.classes, { "target-frame": "shop-skin" });
  assert.deepEqual(patchWidgets(patch).map((widget) => widget.id), ["buy"]);
});

test("a file this client cannot read as a patch is refused, and the reason names the field", () => {
  const cases = [
    [{ ...patchFile(), kind: "addon" }, '"kind" is "addon"'],
    [{ ...patchFile(), id: "не имя" }, '"id" is "не имя"'],
    [{ ...patchFile(), format: 2 }, '"format" is 2'],
    [{ ...patchFile(), target: undefined }, '"target" is missing'],
    [{ ...patchFile(), class: ["target-frame"] }, '"class" must be an object'],
    ["not an object", "must be a JSON object"],
  ];
  for (const [raw, needle] of cases) {
    const result = parseWindowPatch(raw, { module: "shop" });
    assert.equal(result.patch, undefined, needle);
    assert.ok(result.problems.some((problem) => problem.includes(needle)),
      `${needle}: ${result.problems.join("; ")}`);
  }
});

test("one bad widget is one bad widget, and a patch that does nothing is said out loud", () => {
  const result = parseWindowPatch(patchFile({
    add: [
      { slot: "target-frame/actions", widget: { ...BUY_BUTTON, id: "broken", text: "{player.} " } },
      { slot: "target-frame/actions", widget: BUY_BUTTON },
      { widget: { ...BUY_BUTTON, id: "orphan" } },
    ],
  }), { module: "shop" });
  assert.ok(result.patch);
  assert.deepEqual(result.patch.add.map((add) => add.widget.id), ["buy"]);
  assert.ok(result.problems.some((problem) => problem.includes("broken")), result.problems.join("; "));
  assert.ok(result.problems.some((problem) => problem.includes('add[2] has no "slot"')), result.problems.join("; "));

  const empty = parseWindowPatch({ kind: "patch", id: "nothing", target: "target-frame" }, { module: "shop" });
  assert.ok(empty.patch);
  assert.ok(empty.problems.some((problem) => problem.includes("the patch changes nothing")), empty.problems.join("; "));
});

test("a patch naming a slot this client has not got is refused, and the refusal lists the ones it has", () => {
  const patch = parsePatch(patchFile({
    hide: ["target-frame/threat"],
    add: [{ slot: "target-frame/buttons", widget: BUY_BUTTON }],
    class: { "target-window": "shop-skin" },
  }));
  const problems = patchTargetProblems(patch, slotTables());
  assert.equal(problems.length, 3);
  assert.ok(problems[0].includes('слота "target-frame/threat" в этом клиенте нет'), problems[0]);
  // The list is in the message, not a pointer to the source: a modder's first patch misspells a
  // slot, and «такого слота нет» on its own sends them looking through the client.
  assert.ok(problems[0].includes("target-frame/actions"), problems[0]);
  assert.ok(problems[1].includes('виджету "buy" некуда встать'), problems[1]);
  assert.ok(problems[2].includes('окна "target-window" в этом клиенте нет'), problems[2]);
  assert.ok(problems[2].includes("target-frame"), problems[2]);

  // The good one is refused for nothing.
  assert.deepEqual(patchTargetProblems(parsePatch(patchFile()), slotTables()), []);
});

test("a widget may not go into a slot the client writes its own text into, and the refusal says so", () => {
  // `minimap/clock` is a real slot — `hide` it and the clock goes — but `Minimap.ts:435` writes
  // `clock.textContent` on the frame the hour changes, and that setter replaces every child. A
  // widget appended here would be swept off the page without `drop` ever being called, so the copy
  // would stay live on the binding pass with nothing holding it and nothing able to take it back.
  const patch = parsePatch(patchFile({
    hide: [],
    add: [{ slot: "minimap/clock", widget: BUY_BUTTON }],
    class: {},
  }));
  const problems = patchTargetProblems(patch, slotTables());
  assert.equal(problems.length, 1);
  assert.ok(problems[0].includes('слот "minimap/clock" можно только скрыть'), problems[0]);
  // The seven that do take one, so the answer is in the sentence rather than in the source.
  assert.ok(problems[0].includes("target-frame/actions"), problems[0]);
  assert.ok(!problems[0].includes("в этом клиенте нет"), "it exists — it is the wrong kind, not a typo");

  // And hiding the very same slot is fine: all ten may be hidden.
  assert.deepEqual(patchTargetProblems(parsePatch(patchFile({
    hide: ["minimap/clock"], add: [], class: {},
  })), slotTables()), []);
});

test("a patch has no window of its own, so an action that means «this window» is named at load", () => {
  const patch = parsePatch(patchFile({
    add: [{
      slot: "target-frame/actions",
      widget: { ...BUY_BUTTON, action: [{ do: "close", window: "" }, { do: "hide", widget: "nowhere" }] },
    }],
  }));
  const problems = checkWindowPatch(patch, {
    windowIds: new Set(),
    message: () => undefined,
    soundKits: new Set(),
    ...slotTables(),
  });
  assert.ok(problems.some((problem) => problem.includes("у правки своего окна нет")), problems.join("; "));
  assert.ok(problems.some((problem) => problem.includes('виджет "nowhere"')), problems.join("; "));
});

/* ---------------------------------------------------------------------------------------------
 * Applying one
 * ------------------------------------------------------------------------------------------- */

test("a patch adds a button that sends a packet, hides a widget, re-skins the window — and unloading undoes all three", () => {
  const { panel, details, actions } = targetFrame();
  const before = serialise(panel);
  const sent = [];
  const problems = [];

  const live = applyWindowPatch(parsePatch(patchFile()), runsThroughSeam(sent, problems));
  live.update(SNAPSHOT);

  // Added: the button is in the client's own row, marked as this module's, and it carries the
  // widget id an action names.
  assert.equal(actions.children.length, 3);
  const button = actions.children[2];
  assert.equal(button.tagName, "BUTTON");
  assert.equal(button.textContent, "Купить");
  assert.equal(button.dataset.module, "shop");
  assert.equal(button.dataset.widget, "buy");
  // In the row's own flow rather than pinned in a corner of it: a slot is a row of buttons, and an
  // absolute box inside a host nothing has measured would sit on top of the client's own.
  assert.equal(button.style.position, "relative");

  // Hidden: the built-in line is off, and the button beside it that the *client* had hidden is
  // untouched — a patch must not be able to turn one of those on.
  assert.equal(details.hidden, true);
  assert.equal(actions.children[1].hidden, true);

  // Re-skinned: the class the file asked for, and the mark that makes the module's own scoped CSS
  // able to reach the window at all.
  assert.ok(panel.classList.contains("shop-skin"));
  assert.equal(panel.dataset.module, "shop");

  // And it sends: through the same `runWindowActions` a module window's button goes through, with
  // the target's guid read off the same published view.
  button.listeners.get("click")();
  assert.deepEqual(sent, [{ name: "shop.Buy", value: { guid: "42" } }]);
  assert.deepEqual(problems, []);
  assert.equal(live.actionPresses.asked, 1);
  assert.equal(live.actionPresses.ran, 1);

  live.destroy();
  assert.equal(serialise(panel), before, "unloading has to leave the frame byte for byte as it was");
  // And the registry's own books are as empty as the frame. Nothing in the client calls
  // `forgetSlots`, so if `destroy` left its unsubscribes filed under the module they would outlive
  // the session — which is the one thing `clearWorldContext` unloads modules to prevent.
  assert.equal(slotHoldings("shop"), 0);
});

test("the roots a patch reads are known before any slot exists, so the frame pass builds them", () => {
  // Nothing has declared `target-frame/actions` in this test: the patch is live and has nowhere to
  // be. Its roots still have to be complete, because the union is taken when it is registered and a
  // root that arrived later would read blank until something else moved.
  const live = applyWindowPatch(parsePatch(patchFile()), {});
  assert.equal(live.filled, 0);
  const registry = new PatchRegistry();
  assert.equal(registry.register(live), undefined);
  assert.deepEqual([...registry.roots()].sort(), ["target"]);

  // …and the copy the collector built is not on the screen: it went into no host and left no
  // listener anybody can reach.
  const actions = element("div");
  slot("target-frame/actions", actions);
  assert.equal(actions.children.length, 1);
  assert.equal(live.filled, 1);

  registry.remove(live.id);
  assert.equal(actions.children.length, 0);
});

test("a widget in a per-row slot is told which row it is on, and a press reads the same row", () => {
  const widget = {
    id: "share",
    type: "Button",
    width: 40,
    height: 18,
    anchor: { point: "LEFT", relativeTo: "parent", relativePoint: "LEFT", x: 0, y: 0 },
    text: "Задание {slot.questId}",
    action: [{ do: "sendCustom", message: "shop.Quest", value: { id: "{slot.questId}", name: "{slot.name}" } }],
  };
  const sent = [];
  const live = applyWindowPatch(
    parsePatch({ kind: "patch", id: "quest-extras", target: "quest-log", add: [{ slot: "quest-log/entry-actions", widget }] }),
    runsThroughSeam(sent, []),
  );

  const hosts = [11, 22].map((questId) => {
    const host = element("div");
    slot("quest-log/entry-actions", host, { questId });
    return host;
  });
  live.update(SNAPSHOT);
  assert.deepEqual(hosts.map((host) => host.children[0].textContent), ["Задание 11", "Задание 22"]);

  hosts[1].children[0].listeners.get("click")();
  assert.deepEqual(sent, [{ name: "shop.Quest", value: { id: 22, name: "quest-log/entry-actions" } }]);
  assert.equal(live.filled, 2);
  live.destroy();
  assert.deepEqual(hosts.map((host) => host.children.length), [0, 0]);
});

test("a patch's widget follows the game on the frame pass, and writes nothing when nothing moved", () => {
  const widget = {
    id: "hp",
    type: "Text",
    width: 60,
    height: 18,
    anchor: { point: "LEFT", relativeTo: "parent", relativePoint: "LEFT", x: 0, y: 0 },
    text: "{target.name}",
  };
  const live = applyWindowPatch(
    parsePatch({ kind: "patch", id: "target-name", target: "target-frame", add: [{ slot: "target-frame/actions", widget }] }),
    {},
  );
  const actions = element("div");
  slot("target-frame/actions", actions);

  live.update(SNAPSHOT);
  assert.equal(actions.children[0].textContent, "Кабан");
  assert.equal(live.stats.changed, 1);

  live.update(SNAPSHOT);
  assert.equal(live.stats.evaluated, 1);
  assert.equal(live.stats.changed, 0, "a value that has not moved writes nothing");

  live.update({ ...SNAPSHOT, target: { ...SNAPSHOT.target, name: "Вепрь" } });
  assert.equal(actions.children[0].textContent, "Вепрь");
  assert.equal(live.stats.changed, 1);
});

test("a copy built between two frames is drawn against the frame the rest of the interface is on", () => {
  const widget = {
    id: "name",
    type: "Text",
    width: 60,
    height: 18,
    anchor: { point: "LEFT", relativeTo: "parent", relativePoint: "LEFT", x: 0, y: 0 },
    text: "{target.name}",
  };
  const live = applyWindowPatch(
    parsePatch({ kind: "patch", id: "target-name", target: "target-frame", add: [{ slot: "target-frame/actions", widget }] }),
    {},
  );
  live.update(SNAPSHOT);

  // The player opens a panel between two frames. Its copy has never been on a binding pass, and
  // without the last snapshot it would show the blank it was built with until something else moved
  // — which on a quiet frame is until the target changes.
  const actions = element("div");
  slot("target-frame/actions", actions);
  assert.equal(actions.children[0].textContent, "Кабан");
});

test("the patch registry answers the union of the roots and refuses two files with one id", () => {
  const registry = new PatchRegistry();
  const first = applyWindowPatch(parsePatch(patchFile()), {});
  assert.equal(registry.register(first), undefined);
  const clash = registry.register(applyWindowPatch(parsePatch(patchFile()), {}));
  assert.ok(clash?.includes("target-extras"), clash);
  assert.ok(clash?.includes("shop"), clash);

  const widget = {
    id: "clock",
    type: "Text",
    width: 40,
    height: 18,
    anchor: { point: "LEFT", relativeTo: "parent", relativePoint: "LEFT", x: 0, y: 0 },
    text: "{world.clock}",
  };
  registry.register(applyWindowPatch(parsePatch({
    kind: "patch", id: "minimap-clock", target: "minimap",
    add: [{ slot: "minimap/buttons", widget }],
  }, "bank"), {}));
  assert.deepEqual([...registry.roots()].sort(), ["target", "world"]);

  assert.equal(registry.forget("bank"), 1);
  assert.deepEqual([...registry.roots()].sort(), ["target"]);
  assert.equal(registry.size, 1);
});

test("the «Окна» pane lists a patch by what it is and by how many places it has", () => {
  const live = applyWindowPatch(parsePatch({
    kind: "patch", id: "quest-extras", target: "quest-log",
    add: [{ slot: "quest-log/entry-actions", widget: BUY_BUTTON }],
  }), {});
  const view = windowsView([], [], [live]);
  assert.equal(view.rows.length, 1);
  assert.equal(view.rows[0].title, "shop/quest-extras → quest-log");
  // Nowhere to be yet, and that is the first thing an author of a per-row patch asks: the file
  // loaded, and the quest log has not been opened. A row saying «мест 0» answers it.
  assert.equal(view.rows[0].open, false);
  assert.ok(view.rows[0].counts.includes("мест 0"), view.rows[0].counts);
  assert.ok(view.status.includes("правок 1"), view.status);

  // The number of places is in the signature, because opening the log gives a live patch somewhere
  // to be and the pane has to redraw when that happens.
  const before = windowsSignature([], 0, [live]);
  slot("quest-log/entry-actions", element("div"), { questId: 7 });
  assert.notEqual(windowsSignature([], 0, [live]), before);
  assert.equal(live.filled, 1);
  assert.ok(windowsView([], [], [live]).rows[0].open);
});

/* ---------------------------------------------------------------------------------------------
 * Through the loader
 * ------------------------------------------------------------------------------------------- */

function fakeGateway(routes) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    const answer = routes[path];
    if (answer === undefined) return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
    return { ok: true, status: 200, json: async () => answer, text: async () => JSON.stringify(answer) };
  };
  return { routes, restore: () => { globalThis.fetch = original; } };
}

const listed = (file) => ({ file, source: "module", sha1: `sha-${file}`, mtimeMs: 1, bytes: 10 });
const indexEntry = (module, files, messages = []) => ({
  modules: [{ module, windows: files.map(listed), messages: messages.map(listed) }],
});

/** The schema the example patch's button sends, so the loader's cross-file check has an answer. */
const BUY_MESSAGE = {
  messages: [{ name: "shop.Buy", opcode: 4101, direction: "out", fields: [{ name: "guid", type: "u32" }] }],
};

function patchLoader(extra = {}) {
  const patches = new PatchRegistry();
  const styles = new Map();
  const loader = new ModuleLoader("ws://127.0.0.1:8090/auth", {
    packets: new CustomPacketRegistry(),
    windows: new WindowRegistry(),
    render: () => { throw new Error("no window in this fixture"); },
    patches,
    applyPatch: (patch) => applyWindowPatch(patch, {}),
    ...slotTables(),
    setStyle: (module, css) => { if (css) styles.set(module, css); else styles.delete(module); },
    soundKits: new Set(),
    ...extra,
  });
  return { loader, patches, styles };
}

/** The smallest window file the schema accepts, for the one test that loads both kinds at once. */
function windowFile(id, params = {}) {
  return {
    kind: "addon",
    id,
    name: { ru: id, en: "" },
    enabled: true,
    params: {
      screen: {
        id: "root",
        type: "Frame",
        name: "Root",
        width: 200,
        height: 100,
        anchor: { point: "CENTER", relativeTo: "parent", relativePoint: "CENTER", x: 0, y: 0 },
        children: [],
        events: [],
      },
      ...params,
    },
  };
}

test("the loader tells a patch from a window by kind, applies it, and unloading takes it back", async () => {
  const { panel, details, actions } = targetFrame();
  const before = serialise(panel);
  const gateway = fakeGateway({
    "/modules/index": indexEntry("shop", ["target-extras.json"], ["buy.json"]),
    "/modules/messages/shop/buy.json": BUY_MESSAGE,
    "/modules/ui/shop/target-extras.json": patchFile({ css: ".shop-skin { color: red }" }),
  });
  const { loader, patches, styles } = patchLoader();
  try {
    const status = [];
    loader.onStatus = (message, error) => status.push({ message, error });
    await loader.load();

    assert.equal(patches.size, 1);
    assert.equal(loader.patches.length, 1);
    assert.equal(loader.patches[0].edits, 3, "one hide, one widget, one class");
    assert.deepEqual([...loader.problems], []);
    assert.deepEqual(status, [{ message: "модули: правок 1, сообщений 1, стилей 1", error: false }]);
    assert.equal(actions.children.length, 3);
    assert.equal(details.hidden, true);
    // The module's own stylesheet reaches the window it just skinned, and that is what the attached
    // form of the prefix is for: the mark is on the window itself, not on anything above it.
    assert.ok(styles.get("shop").includes('[data-module="shop"].shop-skin {'), styles.get("shop"));

    loader.unload();
    assert.equal(patches.size, 0);
    assert.deepEqual(loader.patches, []);
    assert.deepEqual([...styles.keys()], []);
    assert.equal(serialise(panel), before);
  } finally {
    gateway.restore();
  }
});

test("a patch naming a slot this client has not got is refused at load and nothing of it is applied", async () => {
  const { panel, details } = targetFrame();
  const before = serialise(panel);
  const gateway = fakeGateway({
    "/modules/index": indexEntry("shop", ["bad.json"]),
    // The hide is good and the slot is not. Half of it would take the line off the frame and give
    // nothing back, with nothing on the screen to say why.
    "/modules/ui/shop/bad.json": patchFile({ add: [{ slot: "target-frame/buttons", widget: BUY_BUTTON }] }),
  });
  const { loader, patches } = patchLoader();
  try {
    await loader.load();
    assert.equal(patches.size, 0);
    assert.deepEqual(loader.patches, []);
    assert.equal(loader.problems.length, 1);
    assert.ok(loader.problems[0].includes('"target-frame/buttons"'), loader.problems[0]);
    assert.ok(loader.problems[0].includes("target-frame/actions"), loader.problems[0]);
    assert.equal(details.hidden, false, "and not one edit of the refused file was made");
    assert.equal(serialise(panel), before);
  } finally {
    gateway.restore();
  }
});

test("a saved patch file is applied again in place, and the one before it is taken off first", async () => {
  const { panel, actions } = targetFrame();
  const before = serialise(panel);
  const gateway = fakeGateway({
    "/modules/index": indexEntry("shop", ["target-extras.json"]),
    "/modules/ui/shop/target-extras.json": patchFile(),
  });
  const { loader, patches } = patchLoader();
  try {
    await loader.load();
    assert.equal(actions.children.length, 3);

    gateway.routes["/modules/index"] = {
      modules: [{
        module: "shop",
        windows: [{ file: "target-extras.json", source: "module", sha1: "sha-2", mtimeMs: 2, bytes: 10 }],
      }],
    };
    gateway.routes["/modules/ui/shop/target-extras.json"] = patchFile({
      add: [{ slot: "target-frame/actions", widget: { ...BUY_BUTTON, text: { ru: "Продать", en: "" } } }],
    });
    await loader.poll();
    assert.equal(patches.size, 1);
    // One button, not two: the file was taken off before it was put back on.
    assert.equal(actions.children.length, 3);
    assert.equal(actions.children[2].textContent, "Продать");

    gateway.routes["/modules/index"] = { modules: [{ module: "shop", windows: [] }] };
    await loader.poll();
    assert.equal(patches.size, 0);
    assert.equal(serialise(panel), before);
  } finally {
    gateway.restore();
  }
});

test("a patch's own stylesheet is replaced on a reload and taken away with the file", async () => {
  // The twin of «a window's own stylesheet…» in `module-loader.test.mjs`, and it was missing: a
  // patch's `css` is listed under a name no index can hold, so the ordinary drop never reaches it,
  // and `#dropPatch` had no drop of its own. Measured before the fix, on this fixture: three saves,
  // three copies of the rule in the module's `<style>`; the file taken out of the index, three
  // copies still on the page and three entries still in `loader.styles`.
  targetFrame();
  const gateway = fakeGateway({
    "/modules/index": indexEntry("shop", ["target-extras.json"]),
    "/modules/ui/shop/target-extras.json": patchFile({ css: ".shop-skin { color: red }" }),
  });
  const { loader, styles } = patchLoader();
  // Counted by declarations rather than by prefixes: one rule now carries two selectors, the
  // descendant form and the attached one, so the mark appears twice per copy of the rule.
  const copies = () => (styles.get("shop") ?? "").split("color:").length - 1;
  try {
    await loader.load();
    assert.equal(loader.styles.length, 1);
    assert.equal(copies(), 1);

    for (const [sha, colour] of [["sha-2", "blue"], ["sha-3", "green"]]) {
      gateway.routes["/modules/index"] = {
        modules: [{
          module: "shop",
          windows: [{ file: "target-extras.json", source: "module", sha1: sha, mtimeMs: 2, bytes: 10 }],
        }],
      };
      gateway.routes["/modules/ui/shop/target-extras.json"] = patchFile({ css: `.shop-skin { color: ${colour} }` });
      await loader.poll();
      assert.equal(loader.styles.length, 1, `after saving ${colour}: one file, one stylesheet`);
      assert.equal(copies(), 1, `after saving ${colour}: one copy of its rule in the node`);
      assert.ok(styles.get("shop").includes(colour), styles.get("shop"));
    }
    assert.ok(!styles.get("shop").includes("red"), "and the first save is not still on the page");

    gateway.routes["/modules/index"] = { modules: [{ module: "shop", windows: [] }] };
    await loader.poll();
    assert.deepEqual(loader.styles, [], "the file is gone, and so is its entry");
    assert.deepEqual([...styles.keys()], [], "and so is its styling");
  } finally {
    gateway.restore();
  }
});

test("a window and the patch that edits it may share a name, and neither takes the other's rules", async () => {
  // The likeliest name for the patch that edits the shop window is «shop», and both kinds list
  // their inline stylesheet under a made-up filename. Under one shared `<id>.inline` the two were
  // one entry, and dropping either file took the other's rules off the page with it.
  targetFrame();
  const gateway = fakeGateway({
    "/modules/index": indexEntry("shop", ["screen.json", "patch.json"]),
    "/modules/ui/shop/screen.json": windowFile("shop", { css: ".from-window { color: red }" }),
    "/modules/ui/shop/patch.json": patchFile({ id: "shop", css: ".from-patch { color: blue }" }),
  });
  const { loader, styles } = patchLoader({ render: (definition) => renderWindow(definition, {}) });
  try {
    await loader.load();
    assert.equal(loader.styles.length, 2, "two files, two entries");
    assert.ok(styles.get("shop").includes(".from-window"), styles.get("shop"));
    assert.ok(styles.get("shop").includes(".from-patch"), styles.get("shop"));

    // The patch file goes, and the window's stylesheet stays.
    gateway.routes["/modules/index"] = indexEntry("shop", ["screen.json"]);
    await loader.poll();
    assert.equal(loader.styles.length, 1);
    assert.ok(styles.get("shop").includes(".from-window"), styles.get("shop"));
    assert.ok(!styles.get("shop").includes(".from-patch"), styles.get("shop"));
  } finally {
    gateway.restore();
  }
});

test("the example patch beside the client is a patch this client can read", () => {
  const raw = JSON.parse(readFileSync("examples/module-example/ui/target-extras.json", "utf8"));
  assert.equal(moduleUiKind(raw), "patch");
  const result = parseWindowPatch(raw, { module: "example" });
  assert.ok(result.patch, result.problems.join("; "));
  assert.deepEqual([...result.problems], []);
  assert.deepEqual(patchTargetProblems(result.patch, slotTables()), []);
});

test("«Применить правку» puts the file's own stylesheet on the page, and takes it off again", async () => {
  // The one lever a reviewer has for the acceptance's third edit — «перекрашивает окно» — with no
  // module on disk. Without the stylesheet the button hid the line and added the button, and the
  // re-skin was a class plus a `data-module` mark with no rule anywhere behind it: nothing to see.
  const { panel, details, actions } = targetFrame();
  const before = serialise(panel);
  const raw = JSON.parse(readFileSync("examples/module-example/ui/target-extras.json", "utf8"));
  const gateway = fakeGateway({ "/examples/module-example/ui/target-extras.json": raw });
  const written = [];
  const registry = new PatchRegistry();
  try {
    const result = await loadModulePatch(["http://localhost/examples/module-example/ui/target-extras.json"], {
      module: "example",
      registry,
      windows: new WindowRegistry(),
      host: {},
      setStyle: (module, css) => written.push({ module, css }),
    });
    assert.ok(result.patch, result.problems.join("; "));
    assert.equal(details.hidden, true, "the hide");
    assert.equal(actions.children.length, 3, "the add");
    assert.ok(panel.classList.contains("example-skin"), "the class");
    assert.equal(written.length, 1);
    assert.equal(written[0].module, "example");
    // Both forms: the mark sits on the skinned element itself, so the descendant form alone would
    // reach everything inside the target frame except the frame — which is the thing being skinned.
    assert.ok(written[0].css.includes('[data-module="example"].example-skin'), written[0].css);
    assert.ok(written[0].css.includes('[data-module="example"] .example-identify'), written[0].css);

    // And taken off: the pane clears the node by the module name, which is how a second press
    // leaves the frame byte for byte as it was.
    registry.remove(result.patch.id);
    assert.equal(serialise(panel), before);
  } finally {
    gateway.restore();
  }
});
