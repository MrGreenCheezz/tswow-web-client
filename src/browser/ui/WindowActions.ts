/**
 * What a module window's button, box or event actually does.
 *
 * `WindowRender` draws the widget and carries its action list as inert data; this is the half that
 * runs one. Three rules decide the whole shape, and each of them is about what a definition file
 * from a modder's directory may reach:
 *
 * * **A command is a name in a table, never a method looked up by string.** `WorldClient` has 275
 *   public methods and `close()`, `deleteCharacter` and `sendChat` are three of them, so
 *   `world[name](...)` would hand a JSON file the whole protocol. {@link WINDOW_COMMAND_TABLE} is
 *   thirty-two closures written out by hand, each converting its own arguments; a name that is not
 *   in it is refused by `WindowSchema` when the file loads, before a button is ever drawn.
 *
 *   Measured while writing this table: **five of the thirty-two names М4 wrote down did not exist
 *   on `WorldClient.prototype` at all** — `sellItem` is called `sellToVendor`, `castSpellByName`
 *   and `useItemByName` resolve a name to an id and then call `castSpell`/`useItem`, and `setFocus`
 *   and `interact` are client verbs with no single method behind them. The table says which method
 *   each one ends at, `WorldClientMethod` makes a rename a compile error, and the test asserts the
 *   same thing at run time so that a mutation is caught rather than a type.
 * * **Chat goes through `submitChat`.** Not through `world.sendChat`, and that is the security
 *   half: `submitChat` is what parses a leading `/`, and everything a module can say through it is
 *   what a player could have typed. Reaching `sendChat` directly would let a definition send on a
 *   channel the chat box refuses, and would skip the byte-length check that keeps a Russian line
 *   from being silently dropped by the server.
 * * **An action list is checked when the file loads, not when the button is pressed.** A window
 *   that opens a screen nobody defines, or sends a message with a field missing, says so in the
 *   diagnostics window at load — {@link checkWindowActions} — rather than throwing under the
 *   player's finger. `encodeCustom` would throw; `registry.send` would throw; both would happen at
 *   the one moment the author is not looking at the console.
 *
 * The host is a bag of callbacks rather than a set of imports, and deliberately: `submitChat`
 * reaches `Dom.ts` and its 193 resolved elements, `playUiSound` reaches an `AudioContext`, and
 * `interactWithTarget` reaches the gossip window. Passing them in is what lets this file — the one
 * with the argument conversions and the refusals in it — be tested without a page.
 */

import { encodeCustom, type CustomMessage } from "../../world/CustomCodec.js";
import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import type { WorldClient } from "../../world/WorldClient.js";
import { playerInventory } from "../Inventory.js";
import { game } from "../game/Context.js";
import { spellCastAllowed } from "../SpellCastGuard.js";
import { macroLines } from "./MacroModel.js";
import {
  evaluate, formatExpressionValue, type ExprNode, type ExpressionHelpers, type ExpressionScope,
} from "./WindowExpression.js";
import type { LiveWindow, WindowActionContext } from "./WindowRender.js";
import type { WindowRegistry } from "./WindowRegistry.js";
import {
  patchWidgets, walkWindowWidgets, widgetActions,
  type ParsedPatch, type ParsedWidget, type ParsedWindow, type WindowAction, type WindowCommand,
} from "./WindowSchema.js";

/** The name of a method on {@link WorldClient}: a rename is then a compile error, not a silence. */
export type WorldClientMethod = {
  [Key in keyof WorldClient]: WorldClient[Key] extends (...args: never[]) => unknown ? Key : never;
}[keyof WorldClient];

export interface WindowActionHost {
  /** Where `open`, `close` and `toggle` find a window, and `show`/`hide` find a widget. */
  readonly registry: WindowRegistry<LiveWindow>;
  readonly world?: WorldClient | undefined;
  /** `submitChat`. See the file header: this is how a `chat` action inherits the command whitelist. */
  readonly chat?: ((line: string) => void) | undefined;
  /** `playUiSound`, which takes one of the fourteen names `UI_SOUNDS` declares. */
  readonly sound?: ((kit: string) => void) | undefined;
  /**
   * The published view an action's expressions read, built at most once per run.
   *
   * A press is not a frame: the binding pass never saw these expressions, so the snapshot it built
   * may be missing the very roots this action reads. The client hands in a builder that assembles
   * every root, and pays for it once per press rather than sixty times a second.
   */
  readonly snapshot?: (() => ExpressionScope) | undefined;
  readonly helpers?: ExpressionHelpers | undefined;
  /** The focus verb, which is entirely a client idea: nothing on the wire knows about a focus. */
  readonly focusTarget?: (() => void) | undefined;
  /** The interact verb, which picks between a door, a corpse and a conversation by what is targeted. */
  readonly interactWithTarget?: (() => void) | undefined;
  /** Told about anything a press could not do. The loader collects these into the «Окна» pane. */
  readonly onProblem?: ((text: string) => void) | undefined;
}

/**
 * How deep an `if` may nest before the run gives up.
 *
 * Not a stack limit — the parser bounds the file long before this — but a loop bound: an action
 * list is data from a directory a modder edits, and a run that recurses on data has to carry a
 * number that says how far.
 */
const MAX_ACTION_DEPTH = 16;

/* ---------------------------------------------------------------------------------------------
 * The command table
 * ------------------------------------------------------------------------------------------- */

interface CommandArgs {
  /** How many arguments the file wrote, which is how «no argument» is told from «it came out blank». */
  readonly count: number;
  /** The evaluated argument at that position, or `undefined` when the file wrote fewer. */
  at(index: number): unknown;
  number(index: number, fallback?: number): number;
  text(index: number): string;
  /** A guid, which the view publishes as decimal text so that expressions can compare it. */
  guid(index: number): bigint | undefined;
}

interface WindowCommandSpec {
  /**
   * The `WorldClient` method this command ends at, when it ends at exactly one.
   *
   * `undefined` for the two that do not: `setFocus` writes a client-side guid and sends nothing at
   * all, and `interact` picks between `openLock`, `useGameObject`, `openLoot` and `openGossip` by
   * what is under the cursor. Both are named in the test, so a third one cannot appear quietly.
   */
  readonly world: WorldClientMethod | undefined;
  /** What to write in the file, quoted back when an argument is missing. */
  readonly usage: string;
  run(args: CommandArgs, host: WindowActionHost, world: WorldClient): void;
}

/** The player's own spell whose name matches, or nothing. Case-insensitive, as a macro is. */
function spellIdNamed(name: string, host: WindowActionHost, world: WorldClient): number | undefined {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return undefined;
  for (const known of world.knownSpells) {
    if ((host.helpers?.spellName?.(known.id) ?? "").toLowerCase() === wanted) return known.id;
  }
  return undefined;
}

/** The first square of the player's own bags holding an item of that name. */
function itemSlotNamed(name: string, host: WindowActionHost, world: WorldClient): { bag: number; slot: number; guid: bigint } | undefined {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return undefined;
  const inventory = playerInventory(world.state);
  if (!inventory) return undefined;
  for (const square of [...inventory.backpack, ...inventory.bags.flatMap((bag) => bag.slots)]) {
    const entry = square.item?.fields.get(ITEM_ENTRY_OFFSET) ?? 0;
    if (!entry) continue;
    if ((host.helpers?.itemName?.(entry) ?? "").toLowerCase() !== wanted) continue;
    return { bag: square.bag, slot: square.slot, guid: square.guid };
  }
  return undefined;
}

/**
 * `OBJECT_FIELD_ENTRY`'s offset, read out of the generated table once.
 *
 * Once rather than at every square because {@link itemSlotNamed} walks up to 160 of them for one
 * press, and out of the table rather than written down because the number is generated.
 */
const ITEM_ENTRY_OFFSET = UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset;

/**
 * The thirty-two commands, each a closure that names its own arguments.
 *
 * Order is `WINDOW_COMMANDS`'s, so the two lists can be read side by side; the test asserts they
 * hold exactly the same names, because a command in one and not the other is either a name a file
 * may write and nothing implements or an implementation no file may reach.
 */
export const WINDOW_COMMAND_TABLE: Readonly<Record<WindowCommand, WindowCommandSpec>> = {
  castSpell: {
    world: "castSpell", usage: "castSpell(<номер заклинания>)",
    run: (args, _host, world) => {
      const spellId = args.number(0);
      if (game.world !== world || spellCastAllowed(world, spellId)) world.castSpell(spellId);
    },
  },
  castSpellByName: {
    // The studio's «применить заклинание» carries a name a designer typed, so the id is looked up
    // in what this character actually knows — which is also the only list that can answer.
    world: "castSpell", usage: "castSpellByName(\"название\")",
    run: (args, host, world) => {
      const id = spellIdNamed(args.text(0), host, world);
      if (id === undefined) {
        host.onProblem?.(`castSpell: у персонажа нет заклинания «${args.text(0)}»`);
        return;
      }
      if (game.world !== world || spellCastAllowed(world, id)) world.castSpell(id);
    },
  },
  cancelAura: {
    world: "cancelAura", usage: "cancelAura(<номер заклинания>)",
    run: (args, _host, world) => world.cancelAura(args.number(0)),
  },
  selectTarget: {
    world: "selectTarget", usage: "selectTarget([guid])",
    run: (args, host, world) => {
      // No argument at all is «снять цель» — `selectTarget(undefined)` is how the client clears its
      // own selection, and a definition is allowed to ask for that. An argument that was written
      // and did not evaluate to a guid is a different thing entirely, and it used to be the same
      // one: `{row.guid}` on a repeated button arrived as `undefined` and *cleared* the player's
      // target, reporting «Цель сброшена» as though that had been the point.
      if (args.count === 0) {
        world.selectTarget(undefined);
        return;
      }
      const guid = args.guid(0);
      if (guid === undefined) {
        host.onProblem?.(`selectTarget: guid не вычислился («${formatExpressionValue(args.at(0))}»)`);
        return;
      }
      world.selectTarget(guid);
    },
  },
  setFocus: {
    world: undefined, usage: "setFocus()",
    run: (_args, host) => host.focusTarget?.(),
  },
  startAttack: {
    world: "startAttack", usage: "startAttack()",
    run: (_args, _host, world) => world.startAttack(),
  },
  stopAttack: {
    world: "stopAttack", usage: "stopAttack()",
    run: (_args, _host, world) => world.stopAttack(),
  },
  interact: {
    world: undefined, usage: "interact()",
    run: (_args, host) => host.interactWithTarget?.(),
  },
  useItem: {
    world: "useItem", usage: "useItem(<сумка>, <ячейка>, <guid предмета>)",
    run: (args, _host, world) => world.useItem(args.number(0), args.number(1), args.guid(2) ?? 0n),
  },
  useItemByName: {
    world: "useItem", usage: "useItemByName(\"название\")",
    run: (args, host, world) => {
      const found = itemSlotNamed(args.text(0), host, world);
      if (!found) {
        host.onProblem?.(`useItem: в сумках нет предмета «${args.text(0)}»`);
        return;
      }
      world.useItem(found.bag, found.slot, found.guid);
    },
  },
  equipItem: {
    world: "equipItem", usage: "equipItem(<сумка>, <ячейка>)",
    run: (args, _host, world) => world.equipItem(args.number(0), args.number(1)),
  },
  destroyItem: {
    world: "destroyItem", usage: "destroyItem(<сумка>, <ячейка>, [сколько])",
    run: (args, _host, world) => world.destroyItem(args.number(0), args.number(1), args.number(2, 0)),
  },
  // `sellItem` is what a module author writes and `sellToVendor` is what the method is called. This
  // one line is the reason the table is explicit: М4's list named a method that does not exist.
  sellItem: {
    world: "sellToVendor", usage: "sellItem(<guid предмета>, [сколько])",
    run: (args, _host, world) => world.sellToVendor(args.guid(0) ?? 0n, args.number(1, 0)),
  },
  buyFromVendor: {
    world: "buyFromVendor", usage: "buyFromVendor(<полка>, [сколько])",
    run: (args, _host, world) => world.buyFromVendor(args.number(0), args.number(1, 1)),
  },
  acceptQuest: {
    world: "acceptQuest", usage: "acceptQuest()",
    run: (_args, _host, world) => world.acceptQuest(),
  },
  abandonQuest: {
    world: "abandonQuest", usage: "abandonQuest(<ячейка журнала>)",
    run: (args, _host, world) => world.abandonQuest(args.number(0)),
  },
  chooseQuestReward: {
    world: "chooseQuestReward", usage: "chooseQuestReward(<номер награды>)",
    run: (args, _host, world) => world.chooseQuestReward(args.number(0)),
  },
  openVendor: {
    world: "openVendor", usage: "openVendor(<guid>)",
    run: (args, host, world) => withGuid(args, host, "openVendor", (guid) => world.openVendor(guid)),
  },
  openTrainer: {
    world: "openTrainer", usage: "openTrainer(<guid>)",
    run: (args, host, world) => withGuid(args, host, "openTrainer", (guid) => world.openTrainer(guid)),
  },
  openBank: {
    world: "openBank", usage: "openBank(<guid>)",
    run: (args, host, world) => withGuid(args, host, "openBank", (guid) => world.openBank(guid)),
  },
  requestName: {
    world: "requestName", usage: "requestName(<guid>)",
    run: (args, host, world) => withGuid(args, host, "requestName", (guid) => world.requestName(guid)),
  },
  queryQuest: {
    world: "queryQuest", usage: "queryQuest(<номер задания>)",
    run: (args, _host, world) => world.queryQuest(args.number(0)),
  },
  sendTextEmote: {
    world: "sendTextEmote", usage: "sendTextEmote(<номер эмоции>, [guid цели])",
    run: (args, _host, world) => world.sendTextEmote(args.number(0), args.guid(1) ?? world.targetGuid ?? 0n),
  },
  setStandState: {
    world: "setStandState", usage: "setStandState(<состояние>)",
    run: (args, _host, world) => world.setStandState(args.number(0)),
  },
  joinLfg: {
    // One dungeon rather than a list: the grammar has no array literal, so a file writes the one
    // it means and a window that wants several presses the button several times.
    world: "joinLfg", usage: "joinLfg(<роли>, <подземелье>, [\"комментарий\"])",
    run: (args, _host, world) => world.joinLfg(args.number(0), [args.number(1)], args.text(2)),
  },
  leaveLfg: {
    world: "leaveLfg", usage: "leaveLfg()",
    run: (_args, _host, world) => world.leaveLfg(),
  },
  inviteToGroup: {
    world: "inviteToGroup", usage: "inviteToGroup(\"имя\")",
    run: (args, _host, world) => world.inviteToGroup(args.text(0)),
  },
  leaveGroup: {
    world: "leaveGroup", usage: "leaveGroup()",
    run: (_args, _host, world) => world.leaveGroup(),
  },
  setRaidTarget: {
    world: "setRaidTarget", usage: "setRaidTarget(<метка>, <guid>)",
    run: (args, _host, world) => world.setRaidTarget(args.number(0), args.guid(1) ?? world.targetGuid ?? 0n),
  },
  pingMinimap: {
    world: "pingMinimap", usage: "pingMinimap(<x>, <y>)",
    run: (args, _host, world) => world.pingMinimap(args.number(0), args.number(1)),
  },
  commandPet: {
    world: "commandPet", usage: "commandPet(<команда>, [guid цели])",
    run: (args, _host, world) => {
      const target = args.guid(1);
      if (target === undefined) world.commandPet(args.number(0));
      else world.commandPet(args.number(0), target);
    },
  },
  requestLogout: {
    world: "requestLogout", usage: "requestLogout()",
    run: (_args, _host, world) => world.requestLogout(),
  },
};

/**
 * A command whose one argument is a guid, refused out loud when the expression produced none.
 *
 * `openVendor(0)` is not «the vendor the player is looking at» — every one of these opcodes is
 * checked against the object grid on the server and answered with silence — so a window binding to
 * a guid that has not arrived yet must say so rather than send a packet that goes nowhere.
 */
function withGuid(args: CommandArgs, host: WindowActionHost, name: string, run: (guid: bigint) => void): void {
  const guid = args.guid(0);
  if (guid === undefined || guid === 0n) {
    host.onProblem?.(`${name}: guid не вычислился («${formatExpressionValue(args.at(0))}»)`);
    return;
  }
  run(guid);
}

/* ---------------------------------------------------------------------------------------------
 * Running a list
 * ------------------------------------------------------------------------------------------- */

/**
 * Runs one action list against one snapshot.
 *
 * Total, like `evaluate`: a press must not be able to take down the frame that draws the rest of
 * the interface, so every action is run inside its own try and a failure is reported and stepped
 * over. The snapshot is built at most once, on the first expression that needs it, and shared by
 * every action in the list — the same «one value per press» promise the binding pass makes per
 * frame.
 */
export function runWindowActions(
  actions: readonly WindowAction[],
  context: WindowActionContext,
  host: WindowActionHost,
): void {
  let scope: ExpressionScope | undefined;
  // Snapshot, then the window's state, then the `repeat` row the widget sits in — the same order
  // `WindowRender.updateRepeat` folds them for the binding pass, so an expression means one thing
  // whether it is drawn or pressed. The row is last because a loop variable is allowed to shadow a
  // published name, and the schema only *notes* that it does.
  // The slot sits between the two: a patch's widget reads `slot.questId` the same way it reads
  // `state.<key>`, and a `repeat` inside a patch still shadows both — the loop variable is the
  // innermost thing there is.
  const view = (): ExpressionScope =>
    (scope ??= {
      ...(host.snapshot?.() ?? {}),
      state: context.state,
      ...(context.slot ? { slot: context.slot } : {}),
      ...(context.row ?? {}),
    });
  const value = (expr: ExprNode): unknown => evaluate(expr, view(), host.helpers ?? {});
  runList(actions, context, host, value, 0);
}

function runList(
  actions: readonly WindowAction[],
  context: WindowActionContext,
  host: WindowActionHost,
  value: (expr: ExprNode) => unknown,
  depth: number,
): void {
  if (depth > MAX_ACTION_DEPTH) {
    host.onProblem?.(`${context.module}/${context.window}: «if» вложены глубже ${MAX_ACTION_DEPTH} — остаток списка не выполнен`);
    return;
  }
  for (const action of actions) {
    try {
      runOne(action, context, host, value, depth);
    } catch (error) {
      host.onProblem?.(`${context.module}/${context.window}.${context.widget}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function runOne(
  action: WindowAction,
  context: WindowActionContext,
  host: WindowActionHost,
  value: (expr: ExprNode) => unknown,
  depth: number,
): void {
  switch (action.do) {
    case "open":
    case "close":
    case "toggle": {
      // An empty `window` is this window, which is what the studio's «Закрыть» writes.
      const id = action.window || context.window;
      const done = action.do === "open" ? host.registry.open(id)
        : action.do === "close" ? host.registry.close(id)
          : host.registry.toggle(id);
      if (!done) host.onProblem?.(`${context.module}: окна "${id}" нет — его модуль не загружен?`);
      return;
    }
    case "show":
    case "hide":
    case "toggleWidget": {
      // A patch hands over the subtree it drew; a window is found in the registry by its id. Both
      // end at the same `[data-widget]` lookup — see {@link widgetIn}.
      const node = context.root
        ? widgetIn(context.root, action.widget)
        : widgetElement(host, context.window, action.widget);
      if (!node) {
        host.onProblem?.(`${context.module}/${context.window}: виджета "${action.widget}" в окне нет`);
        return;
      }
      // The widget's own `hidden`, which its conditions own on the next frame if it has any: a
      // definition that both hides a widget by hand and conditions its visibility is asking two
      // things at once, and the condition is the one that runs sixty times a second.
      node.hidden = action.do === "hide" ? true : action.do === "show" ? false : !node.hidden;
      return;
    }
    case "setState":
      context.state[action.key] = value(action.value);
      return;
    case "chat": {
      const line = formatExpressionValue(value(action.text));
      if (line) host.chat?.(line);
      return;
    }
    case "macro": {
      // Line by line through the same door, so `/w Имя привет` in a macro is the same thing it is
      // in the chat box — including the refusal of anything the whitelist does not carry.
      for (const line of macroLines(formatExpressionValue(value(action.body)))) host.chat?.(line);
      return;
    }
    case "command": {
      const world = host.world;
      if (!world) {
        host.onProblem?.(`${context.module}: «${action.name}» нечего выполнить — нет соединения с миром`);
        return;
      }
      const spec = WINDOW_COMMAND_TABLE[action.name];
      const evaluated = action.args.map(value);
      spec.run(commandArgs(evaluated), host, world);
      return;
    }
    case "sendCustom": {
      const registry = host.world?.customPackets;
      if (!registry) {
        host.onProblem?.(`${context.module}: «${action.message}» некуда отправить — нет соединения с миром`);
        return;
      }
      const payload: Record<string, unknown> = {};
      for (const [field, expr] of Object.entries(action.value)) payload[field] = value(expr);
      registry.send(action.message, payload);
      return;
    }
    case "sendCustomRaw": {
      const world = host.world;
      if (!world) {
        host.onProblem?.(`${context.module}: пакет некуда отправить — нет соединения с миром`);
        return;
      }
      const opcode = value(action.opcode);
      if (typeof opcode !== "number" || !Number.isInteger(opcode) || opcode < 1 || opcode > 0xffff) {
        // The opcode may be an expression, so this is the first moment it is a number. М1 throws a
        // `RangeError` on a bad one; saying it here names the window instead of the transport.
        host.onProblem?.(`${context.module}/${context.window}: опкод «${formatExpressionValue(opcode)}» — не целое от 1 до ${0xffff}`);
        return;
      }
      // Encoded through the codec rather than by hand, so the field types, the 10 229-byte ceiling
      // and the refusal of an unsafe integer are the ones М2 already wrote.
      const message: CustomMessage = {
        name: `${context.module}/${context.window}`,
        opcode,
        direction: "out",
        fields: action.fields.map((field, index) => ({ name: `f${index}`, type: field.type })),
      };
      const payload: Record<string, unknown> = {};
      for (const [index, field] of action.fields.entries()) payload[`f${index}`] = value(field.value);
      world.customPackets.sendRaw(opcode, encodeCustom(message, payload));
      return;
    }
    case "sound":
      host.sound?.(action.kit);
      return;
    case "if": {
      const taken = truthyValue(value(action.when)) ? action.then : action.otherwise;
      runList(taken, context, host, value, depth + 1);
      return;
    }
  }
}

/**
 * The same truthiness `WindowExpression` uses for a condition.
 *
 * Written here rather than imported because the evaluator keeps its own `truthy` private, and the
 * one rule that matters is the one both need: an empty string is false, so
 * `{do: "if", when: "{target.name}"}` means «there is a name» and not «there is a target field».
 */
function truthyValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.length > 0;
  if (typeof value === "number") return value !== 0;
  return value !== false;
}

function commandArgs(values: readonly unknown[]): CommandArgs {
  return {
    count: values.length,
    at: (index) => values[index],
    number: (index, fallback = 0) => {
      const raw = values[index];
      if (typeof raw === "number" && Number.isFinite(raw)) return raw;
      const parsed = typeof raw === "string" ? Number(raw) : Number.NaN;
      return Number.isFinite(parsed) ? parsed : fallback;
    },
    text: (index) => formatExpressionValue(values[index]),
    guid: (index) => {
      const raw = values[index];
      // The view publishes a guid as decimal text — see `WindowUnitView.guid` — so text is the
      // ordinary case and a number is what a file writes by hand.
      if (typeof raw === "string" && /^\d+$/.test(raw)) return BigInt(raw);
      if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) return BigInt(raw);
      return undefined;
    },
  };
}

/** One widget's element inside one live window, or nothing when the id names no widget. */
function widgetElement(host: WindowActionHost, windowId: string, widget: string): HTMLElement | undefined {
  const live = host.registry.window(windowId);
  return live ? widgetIn(live.element, widget) : undefined;
}

/** The same lookup under any root: a window's `<section>`, or the subtree a patch drew into a slot. */
function widgetIn(root: HTMLElement, widget: string): HTMLElement | undefined {
  if (root.dataset["widget"] === widget) return root;
  if (typeof root.querySelector !== "function") return undefined;
  // Escaped through `CSS.escape` where the page has it: a widget id is `[A-Za-z0-9_-]` by the
  // schema's own rule, so nothing can currently need it — but a selector built from a file's own
  // text is exactly the place where that stops being true quietly.
  const selector = `[data-widget="${widget.replace(/["\\]/g, "\\$&")}"]`;
  return (root.querySelector(selector) as HTMLElement | null) ?? undefined;
}

/* ---------------------------------------------------------------------------------------------
 * Checking a definition at load
 * ------------------------------------------------------------------------------------------- */

export interface WindowActionCheck {
  /** Every window id the client knows right now, so `open` can be checked against it. */
  readonly windowIds: ReadonlySet<string>;
  /** The message schemas that are live, by name. */
  readonly message: (name: string) => CustomMessage | undefined;
  /** The sound kits `playUiSound` will answer. */
  readonly soundKits: ReadonlySet<string>;
}

export interface WindowPatchCheck extends WindowActionCheck {
  /** `SLOT_NAMES` — every slot the built-in windows offer, declared yet or not. */
  readonly slotNames: ReadonlySet<string>;
  /** `FILLABLE_SLOTS` — the seven of those a widget may be appended to. */
  readonly fillableSlots: ReadonlySet<string>;
  /** `SKINNABLE_WINDOWS` — every built-in window a `class` entry may name. */
  readonly skinnableWindows: ReadonlySet<string>;
}

/**
 * What is wrong with a window's action lists, said at load rather than at the press.
 *
 * Everything here is a check the run-time code would also make, and the difference is only *when*:
 * an author reads these in the diagnostics window while the module loads, instead of finding out
 * that the button does nothing — or throws — on the one press they were not watching.
 *
 * A problem is a note and not a refusal. Half the list still works, and a window that vanished
 * because one of its six buttons named a missing screen would be harder to fix, not easier.
 */
export function checkWindowActions(definition: ParsedWindow, context: WindowActionCheck): string[] {
  const widgets = walkWindowWidgets(definition.screen);
  const problems = checkActionLists(widgets, definition.screen.events.flatMap((event) => event.actions), {
    ...context, where: `${definition.module}/${definition.id}`, ownWindow: definition.id,
  });
  return problems;
}

/**
 * The same checks over a patch's own widgets, plus the two questions only a patch raises.
 *
 * A patch has no window of its own, so `{do: "open", window: ""}` — the studio's «Закрыть», which
 * means "this window" — has nothing to name; and its `hide`/`class` entries have to be slots and
 * windows this client actually offers, or the file silently does nothing. That second check is the
 * reason the known names are in the message: a modder's first patch will misspell a slot, and
 * «такого слота нет» without the list of the ten that exist sends them to the source.
 */
export function checkWindowPatch(patch: ParsedPatch, context: WindowPatchCheck): string[] {
  return [
    ...patchTargetProblems(patch, context),
    ...checkActionLists(patchWidgets(patch), [], {
      ...context, where: `${patch.module}/${patch.id}`, ownWindow: undefined,
    }),
  ];
}

/**
 * The half of the patch check that refuses the file rather than noting it.
 *
 * Split from the rest because the two are answered at different moments and mean different things.
 * A slot or a window this client has not got is a fact about this client and will not become true
 * later, and a patch that hid a line and then failed to add the button meant to replace it has
 * taken something away and given nothing back — so the whole file is left out. Whereas «sendCustom
 * names a schema nobody has declared» may well be a module whose message file loads on the next
 * poll, and a patch refused for that would come and go with the order of a directory walk.
 */
export function patchTargetProblems(
  patch: ParsedPatch,
  context: {
    readonly slotNames: ReadonlySet<string>;
    readonly fillableSlots: ReadonlySet<string>;
    readonly skinnableWindows: ReadonlySet<string>;
  },
): string[] {
  const problems: string[] = [];
  const where = `${patch.module}/${patch.id}`;
  const slots = (): string => [...context.slotNames].join(", ");
  for (const name of patch.hide) {
    if (context.slotNames.has(name)) continue;
    problems.push(`${where}: скрыть нечего — слота "${name}" в этом клиенте нет (есть: ${slots()})`);
  }
  for (const add of patch.add) {
    if (context.fillableSlots.has(add.slot)) continue;
    // Two different refusals and not one, because they send an author to two different places. A
    // name that is in neither table is a typo; a name that is in `SLOT_NAMES` and not among the
    // fillable ones is a real slot the client writes `textContent` into on the frame the target or
    // the hour changes, which would sweep the widget off the page with nothing to say so — so the
    // sentence says which slot it is and offers the seven that hold a widget instead.
    problems.push(context.slotNames.has(add.slot)
      ? `${where}: виджету "${add.widget.id}" некуда встать — слот "${add.slot}" можно только скрыть:`
        + ` клиент пишет туда свой текст и стёр бы виджет (принимают виджет:`
        + ` ${[...context.fillableSlots].join(", ")})`
      : `${where}: виджету "${add.widget.id}" некуда встать — слота "${add.slot}" в этом клиенте нет`
        + ` (есть: ${slots()})`);
  }
  for (const id of Object.keys(patch.classes)) {
    if (context.skinnableWindows.has(id)) continue;
    problems.push(`${where}: класс некуда повесить — окна "${id}" в этом клиенте нет`
      + ` (есть: ${[...context.skinnableWindows].join(", ")})`);
  }
  return problems;
}

interface ActionCheckScope extends WindowActionCheck {
  readonly where: string;
  /** The window `{do: "open", window: ""}` means. A patch has none, and that is a problem to name. */
  readonly ownWindow: string | undefined;
}

function checkActionLists(
  widgets: readonly ParsedWidget[],
  extra: readonly WindowAction[],
  context: ActionCheckScope,
): string[] {
  const problems: string[] = [];
  const widgetIds = new Set(widgets.map((widget) => widget.id));
  const where = context.where;

  const look = (actions: readonly WindowAction[], depth: number): void => {
    if (depth > MAX_ACTION_DEPTH) return;
    for (const action of actions) {
      switch (action.do) {
        case "open":
        case "close":
        case "toggle": {
          const id = action.window || context.ownWindow;
          if (id === undefined) {
            problems.push(`${where}: действие «${action.do}» не называет окно, а у правки своего окна нет`);
            break;
          }
          if (id !== context.ownWindow && !context.windowIds.has(id)) {
            problems.push(`${where}: действие «${action.do}» открывает окно "${id}", которого ни один загруженный модуль не объявил`);
          }
          break;
        }
        case "show":
        case "hide":
        case "toggleWidget":
          if (!widgetIds.has(action.widget)) {
            problems.push(`${where}: действие «${action.do}» называет виджет "${action.widget}", которого в этом окне нет`);
          }
          break;
        case "sendCustom": {
          const message = context.message(action.message);
          if (!message) {
            problems.push(`${where}: sendCustom шлёт «${action.message}» — такой схемы сообщения нет`);
            break;
          }
          if (message.direction === "in") {
            problems.push(`${where}: sendCustom шлёт «${action.message}», а она объявлена direction "in" — этот клиент её только принимает`);
            break;
          }
          for (const field of message.fields) {
            if (action.value[field.name] === undefined) {
              problems.push(`${where}: sendCustom «${action.message}» не задаёт поле "${field.name}" — кодек отказался бы при нажатии`);
            }
          }
          break;
        }
        case "sound":
          if (!context.soundKits.has(action.kit)) {
            problems.push(`${where}: звук «${action.kit}» этот клиент не знает (есть: ${[...context.soundKits].join(", ")})`);
          }
          break;
        case "if":
          look(action.then, depth + 1);
          look(action.otherwise, depth + 1);
          break;
        default:
          break;
      }
    }
  };

  for (const widget of widgets) look(widgetActions(widget), 0);
  look(extra, 0);
  return problems;
}
