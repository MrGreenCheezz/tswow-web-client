/**
 * Plan item 1.10 (12.10): the stock secure targeting commands for this client's own macro runner — the lines a macro
 * runs when no stock chat is there to parse them (ui/Macros.ts `runNativeMacroLine`). With the stock chat the same
 * lines go through ChatEdit_ParseText and SecureCmdList (ChatFrame.lua:1163-1262) onto the bindings of
 * FrameXmlTargetNearest.ts and FrameXmlTargetingApi.ts; here they went to this client's chat, which knew none of
 * them («Неизвестная команда /targetenemy»).
 *
 * Each is its stock body over the same C functions this client gives the stock UI:
 *
 * * TARGET_NEAREST_ENEMY / _ENEMY_PLAYER / _FRIEND / _FRIEND_PLAYER / _PARTY / _RAID (ChatFrame.lua:1163-1203):
 *   `action = SecureCmdOptionParse(msg)`; with one, TargetNearest*(action) — the action read as a Lua boolean,
 *   `reverse` (Wow.exe 0x815500; game/TargetNearestModes.ts `luaFlagArgument`), so a bare `/targetenemy` (action
 *   "") steps forward — over the browser game's one Tab list (game/Targeting.ts `targetNearestUnit`).
 * * CLEARTARGET (:1205-1209): ClearTarget (Wow.exe 0x525fc0) when the options hold — the native Escape step stock
 *   ClearTarget is bound to (input/Controls.ts, FrameXmlGameMenuOwner.ts).
 * * TARGET_LAST_TARGET / _ENEMY / _FRIEND (:1211-1229): TargetLastTarget (0x525d70), TargetLastEnemy (0x525df0),
 *   TargetLastFriend (0x525e50) — game/TargetLast.ts.
 * * ASSIST (:1231-1243): bare, AssistUnit() — the target's target; else AssistUnit(target or action).
 * * FOCUS (:1245-1257): bare, FocusUnit() — the target; else FocusUnit(target, or action when the options named no
 *   unit or "focus"). CLEARFOCUS (:1259-1263): ClearFocus().
 *   Both through the stock model (FrameXmlTargetingModel: a token or a name, Wow.exe 0x00525eb0's errors and the
 *   assistAttack CVar) over this client's units (CombatCommands.ts `macroUnitGuid`).
 *
 * The words are the ruRU client's GlobalStrings (SLASH_TARGET_NEAREST_ENEMY1 "/targetenemy", 2 "/цельвраг", …) as
 * ChatFrame.lua registers them: `strupper`ed, which changes only ASCII letters, so "/TargetEnemy" is one of them and
 * "/ЦельВраг" is not. `msg` is the rest of the line after one separator, trimmed (ChatEdit_ParseText).
 *
 * Not here: /target and /targetexact (TargetUnit by token or by name) — this client's own chat sends them on.
 */
import { globalString } from "../../generated/globalStrings.js";
import { worldObject } from "../../world/Fields.js";
import { game } from "../game/Context.js";
import { setFocusGuid, targetLastUnit, targetNearestUnit } from "../game/Targeting.js";
import type { TargetLastKind } from "../game/TargetLast.js";
import {
  NEAREST_ENEMY, NEAREST_ENEMY_PLAYER, NEAREST_FRIEND, NEAREST_FRIEND_PLAYER, NEAREST_PARTY_MEMBER, NEAREST_RAID_MEMBER,
  luaFlagArgument, type NearestMode,
} from "../game/TargetNearestModes.js";
import { runFrameXmlNativeEscape } from "../framexml/FrameXmlGameMenuController.js";
import { FrameXmlTargetingModel } from "../framexml/FrameXmlTargetingApi.js";
import type { MacroOptionResult } from "../macro/MacroOptions.js";
import { macroUnitGuid, nativeMacroContext } from "./CombatCommands.js";
import { evaluateMacroOptions, macroOptions } from "./MacroModel.js";
import { notice } from "./Notices.js";
import { settingOn } from "./Settings.js";

const TYPEID_UNIT = 3;
const TYPEID_PLAYER = 4;

/**
 * A name to a unit, as the stock seam's FocusUnit/AssistUnit read one (LiveWorldSeam `#relationGuid`, then
 * `#nearestNamed(name, false)`): a group member or the player by the name the group list carries, else the nearest
 * unit in sight whose name is the name — or, failing every whole name, begins with it.
 */
function nativeNamedGuid(name: string): bigint | undefined {
  const world = game.world;
  const wanted = name.trim().toLocaleLowerCase();
  if (!world || !wanted) return undefined;
  const member = world.group?.members.find((candidate) => candidate.name.toLocaleLowerCase() === wanted);
  if (member) return member.guid;
  if (world.selfName?.toLocaleLowerCase() === wanted) return world.state.selfGuid;
  const self = world.state.selfGuid === undefined ? undefined : world.state.objects.get(world.state.selfGuid);
  const origin = self?.position;
  let best: { guid: bigint; whole: boolean; distance: number } | undefined;
  for (const object of world.state.objects.values()) {
    if (object.typeId !== TYPEID_PLAYER && object.typeId !== TYPEID_UNIT) continue;
    const shown = unitName(object.guid)?.toLocaleLowerCase();
    if (!shown || !object.position) continue;
    const whole = shown === wanted;
    if (!whole && !shown.startsWith(wanted)) continue;
    const distance = origin === undefined ? 0 : Math.hypot(object.position.x - origin.x,
      object.position.y - origin.y, object.position.z - origin.z);
    if (!best || (whole && !best.whole) || (whole === best.whole && distance < best.distance)) {
      best = { guid: object.guid, whole, distance };
    }
  }
  return best?.guid;
}

/** A unit's name as the world client knows it: a player's from the name cache, a creature's from its template. */
function unitName(guid: bigint): string | undefined {
  const world = game.world;
  if (!world) return undefined;
  const player = world.names.get(guid) ?? (guid === world.state.selfGuid ? world.selfName : undefined);
  if (player) return player;
  const object = world.state.objects.get(guid);
  if (object?.typeId !== TYPEID_UNIT) return undefined;
  const pet = world.petNameOf?.(object);
  if (pet) return pet;
  const template = world.creatureTemplates.get(worldObject.entry(object) ?? 0);
  return template?.found && template.name ? template.name : undefined;
}

let model: FrameXmlTargetingModel | undefined;

/** FocusUnit, ClearFocus and AssistUnit over this client's world, focus and settings. */
function targeting(): FrameXmlTargetingModel {
  model ??= new FrameXmlTargetingModel({
    world: () => game.world,
    unitGuid: macroUnitGuid,
    namedGuid: nativeNamedGuid,
    setFocus: setFocusGuid,
    uiError: (name) => notice(globalString(name) ?? name),
    assistAttack: () => settingOn("assistAttack"),
  });
  return model;
}

/** SecureCmdOptionParse(msg): the clause chosen now and its target, or undefined (nothing this press). */
function optionParse(word: string, msg: string): MacroOptionResult | undefined {
  const options = macroOptions(msg);
  if (options.error !== undefined) {
    notice(`${word}: ${options.error}.`);
    return undefined;
  }
  return evaluateMacroOptions(options, nativeMacroContext());
}

type Run = (msg: string, word: string) => void;

function nearest(mode: NearestMode): Run {
  return (msg, word) => {
    const action = optionParse(word, msg);
    if (action !== undefined) targetNearestUnit(mode, luaFlagArgument(action.text));
  };
}

function last(kind: TargetLastKind): Run {
  return (msg, word) => {
    if (optionParse(word, msg) !== undefined) targetLastUnit(kind);
  };
}

const clearTarget: Run = (msg, word) => {
  if (optionParse(word, msg) !== undefined) runFrameXmlNativeEscape("clearTarget");
};

const assist: Run = (msg, word) => {
  if (msg === "") {
    targeting().assistUnit(undefined);
    return;
  }
  const action = optionParse(word, msg);
  if (action !== undefined) targeting().assistUnit(action.target ?? action.text);
};

const focus: Run = (msg, word) => {
  if (msg === "") {
    targeting().focusUnit(undefined);
    return;
  }
  const action = optionParse(word, msg);
  if (action === undefined) return;
  const target = action.target === undefined || action.target === "focus" ? action.text : action.target;
  targeting().focusUnit(target);
};

const clearFocus: Run = (msg, word) => {
  if (optionParse(word, msg) !== undefined) targeting().clearFocus();
};

/** The ruRU GlobalStrings' SLASH_* words, `strupper`ed as ChatFrame.lua keys them. */
const COMMANDS: ReadonlyMap<string, Run> = new Map<string, Run>([
  ...words(["/targetenemy", "/цельвраг"], nearest(NEAREST_ENEMY)),
  ...words(["/targetenemyplayer"], nearest(NEAREST_ENEMY_PLAYER)),
  ...words(["/targetfriend", "/цельдруг"], nearest(NEAREST_FRIEND)),
  ...words(["/targetfriendplayer"], nearest(NEAREST_FRIEND_PLAYER)),
  ...words(["/targetparty", "/цельгруппа"], nearest(NEAREST_PARTY_MEMBER)),
  ...words(["/targetraid", "/цельрейд"], nearest(NEAREST_RAID_MEMBER)),
  ...words(["/сбросцели", "/cleartarget"], clearTarget),
  ...words(["/targetlasttarget", "/цельпослцель"], last("target")),
  ...words(["/targetlastenemy", "/цельпослвраг"], last("enemy")),
  ...words(["/targetlastfriend", "/цельпослдруг"], last("friend")),
  ...words(["/п", "/помочь", "/a", "/assist"], assist),
  ...words(["/focus", "/фокус"], focus),
  ...words(["/clearfocus", "/сбросфокуса"], clearFocus),
]);

function words(list: readonly string[], run: Run): [string, Run][] {
  return list.map((word) => [strupper(word), run]);
}

/** Lua's `strupper` in the client: the C locale's toupper, ASCII letters only. */
function strupper(text: string): string {
  return text.replace(/[a-z]+/g, (letters) => letters.toUpperCase());
}

/**
 * Runs `line` when it is one of the targeting commands and answers true; any other line is left alone (false).
 * ChatEdit_ParseText's split: the command is everything up to the first whitespace.
 */
export function runNativeTargetCommand(line: string): boolean {
  const command = /^\/\S+/.exec(line)?.[0];
  if (command === undefined) return false;
  const run = COMMANDS.get(strupper(command));
  if (run === undefined) return false;
  const msg = command === line ? "" : line.slice(command.length + 1).trim();
  run(msg, command);
  return true;
}
