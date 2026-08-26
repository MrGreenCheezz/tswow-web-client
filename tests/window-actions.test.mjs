import assert from "node:assert/strict";
import test from "node:test";

/**
 * What a module window's button actually does — and, just as much, what it may not do.
 *
 * The first test here is the one the slice exists for: `WINDOW_COMMANDS` was written down in М4 and
 * never checked against the client it names, and five of its thirty-two names did not exist on
 * `WorldClient` at all. Everything below it is the argument conversion and the refusals.
 */

const { WorldClient } = await import("../dist/code/world/WorldClient.js");
const { WINDOW_COMMANDS, parseWindowDefinition } = await import("../dist/code/browser/ui/WindowSchema.js");
const {
  WINDOW_COMMAND_TABLE, checkWindowActions, runWindowActions,
} = await import("../dist/code/browser/ui/WindowActions.js");
const { WindowRegistry } = await import("../dist/code/browser/ui/WindowRegistry.js");
const { decodeCustom } = await import("../dist/code/world/CustomCodec.js");

/* ---------------------------------------------------------------------------------------------
 * Fixtures
 * ------------------------------------------------------------------------------------------- */

const anchor = (point = "TOPLEFT") => ({ point, relativeTo: "parent", relativePoint: point, x: 0, y: 0 });

/** One window definition holding one button with the given action list. */
function definition(actions, extra = {}, screenExtra = {}) {
  return {
    kind: "addon",
    id: "screen",
    name: { ru: "Экран", en: "" },
    enabled: true,
    params: {
      screen: {
        id: "root",
        type: "Frame",
        name: "Root",
        width: 200,
        height: 100,
        anchor: anchor("CENTER"),
        children: [
          // `actions` is this client's key and `action` is the studio's; `collectActions` reads
          // both, and an entry with no `do` in it is read as one of the studio's nine.
          { id: "press", type: "Button", width: 80, height: 20, text: { ru: "Жать", en: "" }, actions, anchor: anchor() },
          { id: "label", type: "Text", width: 80, height: 20, text: { ru: "х", en: "" }, anchor: anchor("BOTTOMLEFT") },
        ],
        events: [],
        ...screenExtra,
      },
      ...extra,
    },
  };
}

function parse(raw, module = "shop") {
  const result = parseWindowDefinition(raw, { module });
  return result;
}

/** The action list the parser made out of the button's `do`. */
function actionsOf(raw) {
  const parsed = parse(raw);
  assert.ok(parsed.window, `refused: ${parsed.problems.join(" / ")}`);
  return parsed.window.screen.children.find((child) => child.id === "press").actions;
}

/** A fake element tree with just enough `querySelector` for `show`/`hide` to find a widget. */
function fakeElement(widget) {
  const node = {
    dataset: widget === undefined ? {} : { widget },
    hidden: false,
    children: [],
    append(...nodes) { node.children.push(...nodes); },
    querySelector(selector) {
      const wanted = /\[data-widget="(.*)"\]/.exec(selector)?.[1];
      const walk = (current) => {
        for (const child of current.children) {
          if (child.dataset.widget === wanted) return child;
          const found = walk(child);
          if (found) return found;
        }
        return undefined;
      };
      return walk(node) ?? null;
    },
  };
  return node;
}

/** A registered window that is a handle and nothing else: the registry never looks inside one. */
function fakeWindow(id, element, module = "shop") {
  let shown = true;
  return {
    id, module, element, definition: undefined, escClose: true, roots: new Set(),
    visible: () => shown,
    show() { shown = true; },
    hide() { shown = false; },
    update() {},
    destroy() { shown = false; },
  };
}

function host(extra = {}) {
  const registry = extra.registry ?? new WindowRegistry();
  const said = [];
  const problems = [];
  return {
    registry,
    said,
    problems,
    chat: (line) => said.push(line),
    onProblem: (text) => problems.push(text),
    ...extra,
  };
}

const context = (state = {}) => ({ window: "screen", module: "shop", widget: "press", state });

/* ---------------------------------------------------------------------------------------------
 * The command table
 * ------------------------------------------------------------------------------------------- */

test("every command a window may name resolves to a method this client actually has", () => {
  // The whole reason the table is written out by hand. Measured when it was: `sellItem` is called
  // `sellToVendor`, and four more of М4's thirty-two names were not methods at all.
  assert.deepEqual(Object.keys(WINDOW_COMMAND_TABLE).sort(), [...WINDOW_COMMANDS].sort(),
    "the table and the list a file may write from have to hold the same names");

  const clientVerbs = [];
  for (const [name, spec] of Object.entries(WINDOW_COMMAND_TABLE)) {
    assert.equal(typeof spec.run, "function", `${name} has no implementation`);
    assert.ok(spec.usage.includes(name), `${name} does not quote itself in its usage line`);
    if (spec.world === undefined) {
      clientVerbs.push(name);
      continue;
    }
    assert.equal(typeof WorldClient.prototype[spec.world], "function",
      `${name} names WorldClient.${spec.world}, which does not exist`);
  }
  // The two that end nowhere on `WorldClient`, named so that a third cannot appear quietly: the
  // focus is entirely a client idea, and interacting picks between four different opcodes by what
  // is under the cursor.
  assert.deepEqual(clientVerbs.sort(), ["interact", "setFocus"]);

  // And nothing dangerous is reachable: these are on the prototype and must never be nameable.
  for (const forbidden of ["close", "deleteCharacter", "sendChat", "sendCustomPacket"]) {
    assert.equal(WINDOW_COMMAND_TABLE[forbidden], undefined, `${forbidden} must not be a window command`);
  }
});

test("a command this client has not got is refused when the file loads, not when the button is pressed", () => {
  const parsed = parse(definition({ do: "command", name: "deleteCharacter" }));
  assert.ok(parsed.window, "one bad action does not take the window with it");
  assert.deepEqual(parsed.window.screen.children[0].actions, [], "the action is dropped, not carried");
  assert.ok(parsed.problems.some((problem) => problem.includes('"deleteCharacter" is not one of the commands')),
    parsed.problems.join(" / "));
});

test("a command is run with its arguments converted, and a guid arrives as the text the view publishes", () => {
  const calls = [];
  const world = {
    targetGuid: 77n,
    castSpell: (id) => calls.push(["castSpell", id]),
    selectTarget: (guid) => calls.push(["selectTarget", guid]),
    useItem: (bag, slot, guid) => calls.push(["useItem", bag, slot, guid]),
    setRaidTarget: (icon, guid) => calls.push(["setRaidTarget", icon, guid]),
    openVendor: (guid) => calls.push(["openVendor", guid]),
  };
  const one = (action) => runWindowActions(actionsOf(definition(action)), context(), host({ world }));

  one({ do: "command", name: "castSpell", args: [133] });
  // The view publishes a guid as decimal *text*, so that is the ordinary shape an argument arrives
  // in — a `bigint` in the view would print as an empty string and compare against nothing.
  one({ do: "command", name: "selectTarget", args: ["12345678901234"] });
  one({ do: "command", name: "useItem", args: [255, 23, "4242"] });
  // A guid left out falls back to the target, the way every emote and every mark in this client
  // already does.
  one({ do: "command", name: "setRaidTarget", args: [3] });
  assert.deepEqual(calls, [
    ["castSpell", 133],
    ["selectTarget", 12345678901234n],
    ["useItem", 255, 23, 4242n],
    ["setRaidTarget", 3, 77n],
  ]);

  // A guid that did not evaluate is refused out loud rather than sent as zero: every one of these
  // opcodes is checked against the object grid and answered with silence.
  const withProblem = host({ world });
  runWindowActions(actionsOf(definition({ do: "command", name: "openVendor", args: ["{target.guid}"] })),
    context(), withProblem);
  assert.deepEqual(calls.filter((call) => call[0] === "openVendor"), []);
  assert.equal(withProblem.problems.length, 1);
  assert.ok(withProblem.problems[0].includes("guid не вычислился"), withProblem.problems[0]);
});

test("a button inside a repeated row acts on the row the player clicked", () => {
  // The row is `WindowRender`'s to hand over — see the renderer's own test — and this is the half
  // that reads it. Until it did, `selectTarget("{row.guid}")` on a repeated raid row evaluated to
  // `undefined`, and `selectTarget(undefined)` *clears* the player's target and reports «Цель
  // сброшена»: the one failure in this file that looked like a working button.
  const calls = [];
  const world = { targetGuid: 5n, selectTarget: (guid) => calls.push(guid) };
  const action = actionsOf(definition({ do: "command", name: "selectTarget", args: ["{row.guid}"] }));

  const clicked = host({ world, snapshot: () => ({ party: [{ name: "Аня", guid: "77" }] }) });
  runWindowActions(action, { ...context(), row: { row: { name: "Аня", guid: "77" } } }, clicked);
  assert.deepEqual(calls, [77n]);
  assert.deepEqual(clicked.problems, []);

  // The same list, pressed from a widget that is not inside it: the argument was written and did
  // not evaluate, so it is refused out loud instead of clearing the target.
  const orphan = host({ world, snapshot: () => ({}) });
  runWindowActions(action, context(), orphan);
  assert.deepEqual(calls, [77n], "nothing else went out");
  assert.equal(orphan.problems.length, 1);
  assert.ok(orphan.problems[0].includes("guid не вычислился"), orphan.problems[0]);

  // And `selectTarget()` with no argument at all is still «снять цель», which a definition is
  // allowed to ask for: «no argument» and «the argument came out blank» are two different things.
  const cleared = host({ world });
  runWindowActions(actionsOf(definition({ do: "command", name: "selectTarget" })), context(), cleared);
  assert.deepEqual(calls, [77n, undefined]);
  assert.deepEqual(cleared.problems, []);
});

test("the row is folded into a press the way the binding pass folds it: after the view and after the state", () => {
  // The schema only *notes* a `repeat.as` that hides a published root, so the shadowing has to mean
  // the same thing in an action as it does in a binding — `updateRepeat` writes the loop variable
  // over a scope that already holds the snapshot and the window's state.
  const said = host({ snapshot: () => ({ party: { name: "снимок" } }) });
  runWindowActions(
    actionsOf(definition({ do: "chat", text: "{party.name} {state.who}" })),
    { ...context({ who: "я" }), row: { party: { name: "строка" } } },
    said,
  );
  assert.deepEqual(said.said, ["строка я"]);
});

test("castSpellByName finds the id in what the character knows, and says so when it does not", () => {
  const cast = [];
  const world = { knownSpells: [{ id: 133, slot: 0 }, { id: 168, slot: 1 }], castSpell: (id) => cast.push(id) };
  const helpers = { spellName: (id) => (id === 133 ? "Огненная стрела" : "Ледяная броня") };
  const found = host({ world, helpers });
  runWindowActions(actionsOf(definition({ type: "castSpell", spell: { ru: "ледяная броня", en: "" } })), context(), found);
  assert.deepEqual(cast, [168], "the studio's own action carries a name, and it is matched without case");
  assert.deepEqual(found.problems, []);

  const missing = host({ world, helpers });
  runWindowActions(actionsOf(definition({ type: "castSpell", spell: { ru: "Воскрешение", en: "" } })), context(), missing);
  assert.deepEqual(cast, [168], "nothing is cast when the character does not know it");
  assert.equal(missing.problems.length, 1);
  assert.ok(missing.problems[0].includes("Воскрешение"), missing.problems[0]);
});

/* ---------------------------------------------------------------------------------------------
 * Chat, macros and sound
 * ------------------------------------------------------------------------------------------- */

test("chat goes through submitChat, so a module inherits the command whitelist rather than the socket", () => {
  const sent = [];
  const world = { sendChat: () => sent.push("straight to the wire") };
  const said = host({ world });
  runWindowActions(actionsOf(definition({ do: "chat", text: { ru: "/say привет", en: "" } })), context(), said);
  assert.deepEqual(said.said, ["/say привет"]);
  assert.deepEqual(sent, [], "nothing may reach sendChat: the leading slash is submitChat's to read");
});

test("a macro is submitted line by line, blank lines dropped, through the same door", () => {
  const said = host();
  runWindowActions(
    actionsOf(definition({ do: "macro", body: { ru: "/say раз\n\n  /say два  ", en: "" } })),
    context(), said,
  );
  assert.deepEqual(said.said, ["/say раз", "/say два"]);
});

test("a sound action reaches the kit it names and an empty text says nothing at all", () => {
  const played = [];
  const loud = host({ sound: (kit) => played.push(kit) });
  runWindowActions(actionsOf(definition({ do: "sound", kit: "questAdded" })), context(), loud);
  assert.deepEqual(played, ["questAdded"]);

  // An empty line is not a message: `chat` with an expression that evaluated to nothing must not
  // submit an empty string, which `submitChat` would have to ignore anyway.
  const quiet = host();
  runWindowActions(actionsOf(definition({ do: "chat", text: "{target.name}" })), context(), quiet);
  assert.deepEqual(quiet.said, []);
});

/* ---------------------------------------------------------------------------------------------
 * Windows, widgets and state
 * ------------------------------------------------------------------------------------------- */

test("open, close and toggle reach the registry, and an id nobody has is said out loud", () => {
  const registry = new WindowRegistry();
  const element = fakeElement();
  registry.register(fakeWindow("screen", element));
  const acted = host({ registry });

  runWindowActions(actionsOf(definition({ do: "close", window: "" })), context(), acted);
  assert.equal(registry.window("screen").visible(), false, "an empty window name is this window");
  runWindowActions(actionsOf(definition({ do: "toggle", window: "screen" })), context(), acted);
  assert.equal(registry.window("screen").visible(), true);
  assert.deepEqual(acted.problems, []);

  runWindowActions(actionsOf(definition({ do: "open", window: "nowhere" })), context(), acted);
  assert.equal(acted.problems.length, 1);
  assert.ok(acted.problems[0].includes('окна "nowhere" нет'), acted.problems[0]);
});

test("show and hide find the widget inside the window that asked", () => {
  const registry = new WindowRegistry();
  const root = fakeElement();
  const label = fakeElement("label");
  root.append(label);
  registry.register(fakeWindow("screen", root));
  const acted = host({ registry });

  runWindowActions(actionsOf(definition({ do: "hide", widget: "label" })), context(), acted);
  assert.equal(label.hidden, true);
  runWindowActions(actionsOf(definition({ do: "toggleWidget", widget: "label" })), context(), acted);
  assert.equal(label.hidden, false);
  assert.deepEqual(acted.problems, []);

  runWindowActions(actionsOf(definition({ do: "hide", widget: "ghost" })), context(), acted);
  assert.equal(acted.problems.length, 1);
  assert.ok(acted.problems[0].includes('виджета "ghost"'), acted.problems[0]);
});

test("setState writes into the window's own state, and an if takes exactly one branch", () => {
  const state = { count: 2 };
  const acted = host();
  runWindowActions(actionsOf(definition([
    { do: "setState", key: "count", value: "{state.count + 1}" },
    { do: "if", when: "{state.count > 2}", then: [{ do: "chat", text: { ru: "больше", en: "" } }], else: [{ do: "chat", text: { ru: "меньше", en: "" } }] },
  ])), context(state), acted);
  assert.equal(state.count, 3);
  assert.deepEqual(acted.said, ["больше"], "the branch reads the state the earlier action wrote");
});

test("the published view is built once for a whole press, however many expressions read it", () => {
  let built = 0;
  const acted = host({
    snapshot: () => { built++; return { player: { name: "Тест", health: 40 } }; },
  });
  runWindowActions(actionsOf(definition([
    { do: "chat", text: "{player.name}" },
    { do: "chat", text: "{fmt(player.health)}" },
  ])), context(), acted);
  assert.deepEqual(acted.said, ["Тест", "40"]);
  assert.equal(built, 1, "two expressions, one snapshot: a press cannot show two different worlds");

  // And a press whose actions read nothing does not build one at all.
  const cheap = host({ snapshot: () => { built++; return {}; } });
  runWindowActions(actionsOf(definition({ do: "close", window: "" })), context(), cheap);
  assert.equal(built, 1);
});

/* ---------------------------------------------------------------------------------------------
 * Custom packets
 * ------------------------------------------------------------------------------------------- */

test("sendCustomRaw encodes through the codec and refuses an opcode that is not one", () => {
  const sent = [];
  const world = { customPackets: { sendRaw: (opcode, body) => sent.push([opcode, [...body]]) } };
  const acted = host({ world });
  runWindowActions(actionsOf(definition({
    do: "sendCustomRaw", opcode: 4002, fields: [{ type: "u32", value: 60001 }, { type: "u8", value: 3 }],
  })), context(), acted);
  assert.deepEqual(sent, [[4002, [0x61, 0xea, 0x00, 0x00, 3]]]);
  assert.deepEqual(acted.problems, []);

  // The opcode may be an expression, so the run is the first moment it is a number. М1 would throw
  // a `RangeError` out of the transport; saying it here names the window instead.
  const refused = host({ world });
  runWindowActions(actionsOf(definition({
    do: "sendCustomRaw", opcode: "{player.level}", fields: [{ type: "u8", value: 1 }],
  })), context(), refused);
  assert.equal(sent.length, 1, "nothing went out");
  assert.equal(refused.problems.length, 1);
  assert.ok(refused.problems[0].includes("опкод"), refused.problems[0]);
});

test("sendCustom encodes through the message the module declared", () => {
  const sent = [];
  const message = {
    name: "shop.Buy", opcode: 4002, direction: "both",
    fields: [{ name: "entry", type: { kind: "u32" } }, { name: "count", type: { kind: "u8" } }],
  };
  const world = {
    customPackets: {
      send: (name, value) => sent.push([name, value]),
      message: () => message,
    },
  };
  const acted = host({ world, snapshot: () => ({ state: {} }) });
  runWindowActions(actionsOf(definition({
    do: "sendCustom", message: "shop.Buy", value: { entry: 60001, count: 2 },
  })), context(), acted);
  assert.deepEqual(sent, [["shop.Buy", { entry: 60001, count: 2 }]]);

  // And the value handed to the registry is the shape the codec reads: the same bytes
  // `sendCustomRaw` produced above decode back into it, which is what «one codec, two doors» has
  // to mean.
  const decoded = decodeCustom({ ...message, direction: "in" }, Uint8Array.of(0x61, 0xea, 0x00, 0x00, 2));
  assert.deepEqual(decoded.value, sent[0][1]);
});

test("sendCustom with a field missing is refused when the file loads", () => {
  const message = {
    name: "shop.Buy", opcode: 4002, direction: "both",
    fields: [{ name: "entry", type: { kind: "u32" } }, { name: "count", type: { kind: "u8" } }],
  };
  const parsed = parse(definition({ do: "sendCustom", message: "shop.Buy", value: { entry: 60001 } }));
  assert.ok(parsed.window);
  const problems = checkWindowActions(parsed.window, {
    windowIds: new Set(["screen"]),
    message: (name) => (name === message.name ? message : undefined),
    soundKits: new Set(),
  });
  assert.equal(problems.length, 1);
  assert.ok(problems[0].includes('не задаёт поле "count"'), problems[0]);
  assert.ok(problems[0].includes("кодек отказался бы при нажатии"), problems[0]);
});

test("the load-time check names an unknown window, an unknown widget, an unknown message and an unknown kit", () => {
  const parsed = parse(definition([
    { do: "open", window: "somebody-elses" },
    { do: "hide", widget: "ghost" },
    { do: "sendCustom", message: "shop.Nothing", value: {} },
    { do: "sound", kit: "fanfare" },
    { do: "if", when: "{true}", then: [{ do: "open", window: "also-missing" }], else: [] },
  ]));
  assert.ok(parsed.window);
  const problems = checkWindowActions(parsed.window, {
    windowIds: new Set(["screen"]),
    message: () => undefined,
    soundKits: new Set(["questAdded", "levelUp"]),
  });
  assert.equal(problems.length, 5, problems.join("\n"));
  assert.ok(problems[0].includes('"somebody-elses"'));
  assert.ok(problems[1].includes('"ghost"'));
  assert.ok(problems[2].includes("shop.Nothing"));
  assert.ok(problems[3].includes("fanfare") && problems[3].includes("questAdded"),
    "and the refusal lists what this client does have");
  assert.ok(problems[4].includes('"also-missing"'), "an if is walked into, or half a list is unchecked");

  // A window opening *itself* is the studio's «Закрыть» and needs no other window to exist.
  const own = parse(definition([{ do: "toggle", window: "screen" }, { do: "close", window: "" }]));
  assert.deepEqual(checkWindowActions(own.window, {
    windowIds: new Set(), message: () => undefined, soundKits: new Set(),
  }), []);
});

test("an outbound-only direction is checked too, because the codec refuses to encode an inbound one", () => {
  const parsed = parse(definition({ do: "sendCustom", message: "shop.State", value: { gold: 1 } }));
  const problems = checkWindowActions(parsed.window, {
    windowIds: new Set(["screen"]),
    message: () => ({ name: "shop.State", opcode: 4001, direction: "in", fields: [{ name: "gold", type: { kind: "u32" } }] }),
    soundKits: new Set(),
  });
  assert.equal(problems.length, 1);
  assert.ok(problems[0].includes('direction "in"'), problems[0]);
});

test("a press with no world says so once per action rather than throwing", () => {
  const nowhere = host({ world: undefined });
  runWindowActions(actionsOf(definition([
    { do: "command", name: "startAttack" },
    { do: "sendCustom", message: "shop.Buy", value: {} },
  ])), context(), nowhere);
  assert.equal(nowhere.problems.length, 2);
  assert.ok(nowhere.problems[0].includes("нет соединения с миром"), nowhere.problems[0]);
});
