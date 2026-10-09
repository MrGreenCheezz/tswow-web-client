/**
 * PLAYER_LOGIN and `IsLoggedIn` — the session's login edge (FrameXmlBoot.ts raises it).
 *
 * Wow.exe 3.3.5a 12340 (read-only Ghidra): the game-UI start (0x0052a980) sets a «not logged in»
 * flag; the world entry (0x00528010) clears it and raises PLAYER_LOGIN right before the first
 * PLAYER_ENTERING_WORLD, once per UI (a later world entry finds it clear). `IsLoggedIn`
 * (0x0060a450) answers 1 while the flag is clear and nil otherwise.
 *
 * One stock handler cannot take the edge yet: UIParent's PLAYER_LOGIN branch runs
 * `CombatLog_LoadUI()` (UIParent.lua:480-483), which `UIParentLoadAddOn`s Blizzard_CombatLog
 * through the synchronous `LoadAddOn` (:234-243). That add-on has no owner in this client until plan
 * item 3.01; loaded bare it would draw the combat log over ChatFrame2 next to the native mirror, and
 * refused it opens a `message()` dialog every session. So, until that owner exists, the stock
 * `CombatLog_LoadUI` — and only UIParent.lua's own, captured right after that file ran — is replaced
 * with a function that does nothing, as FrameXmlBattlefieldMinimap.ts does for its add-on. A
 * replacement installed by a TSWoW module or an add-on ("You can override this if you want a Combat
 * Log replacement", UIParent.lua:481) is theirs and is left alone.
 */

import type { GlueLuaVm } from "../glue/GlueLua.js";
import { frameXmlWorldExitEvents } from "./FrameXmlWorldExit.js"; // L5c 3.18

/** The hidden global holding UIParent.lua's own `CombatLog_LoadUI` between capture and refusal. */
const STOCK_COMBAT_LOG_LOAD_UI = "__fxStockCombatLogLoadUI";

/** Whether a corpus file is the one that defines the stock `CombatLog_LoadUI`. */
export function frameXmlDefinesCombatLogLoadUi(path: string): boolean {
  return /(?:^|[\\/])uiparent\.lua$/i.test(path);
}

/** Right after UIParent.lua ran: remember its `CombatLog_LoadUI`. */
export function captureFrameXmlStockCombatLogLoadUi(vm: GlueLuaVm): void {
  vm.execute(`${STOCK_COMBAT_LOG_LOAD_UI} = rawget(_G, "CombatLog_LoadUI")`, "@webclient/combat-log-capture");
}

/**
 * Before the session events: refuse Blizzard_CombatLog silently while `CombatLog_LoadUI` is still
 * UIParent.lua's own. Returns whether it replaced it.
 */
export function refuseFrameXmlCombatLogLoadUi(vm: GlueLuaVm): boolean {
  const result = vm.execute(`
    local stock = rawget(_G, "${STOCK_COMBAT_LOG_LOAD_UI}")
    ${STOCK_COMBAT_LOG_LOAD_UI} = nil
    __fxCombatLogRefused = false
    if stock ~= nil and rawget(_G, "CombatLog_LoadUI") == stock then
      CombatLog_LoadUI = function() end
      __fxCombatLogRefused = true
    end
  `, "@webclient/combat-log-refusal");
  const refused = result.ok && vm.getGlobal("__fxCombatLogRefused") === true;
  vm.setGlobal("__fxCombatLogRefused", undefined);
  return refused;
}

/** The login flag behind `IsLoggedIn`: cleared at the game-UI start, set as PLAYER_LOGIN is raised. */
export class FrameXmlLoginState {
  #loggedIn = false;

  get loggedIn(): boolean {
    return this.#loggedIn;
  }

  /** Called right before PLAYER_LOGIN is dispatched, so its handlers already read 1. */
  logIn(): void {
    this.#loggedIn = true;
  }

  /** `IsLoggedIn()`: 1 or nil. */
  isLoggedIn(): readonly unknown[] {
    // L5c 3.18: 0x0060a450 pushes nil — one value — so `tostring(IsLoggedIn())` stays valid Lua 5.1.
    return this.#loggedIn ? [1] : [undefined];
  }

  #inWorld = false;

  /** Between a PLAYER_ENTERING_WORLD and the PLAYER_LEAVING_WORLD that follows it. */
  get inWorld(): boolean {
    return this.#inWorld;
  }

  /** Follow the world edges the boot dispatches, by name. */
  observe(event: string): void {
    if (event === "PLAYER_ENTERING_WORLD") this.#inWorld = true;
    else if (event === "PLAYER_LEAVING_WORLD") this.#inWorld = false;
  }

  /**
   * The UI teardown's events (0x00528f00): with the character there and flagged in combat (unit flag
   * bit 19), PLAYER_REGEN_ENABLED; then the world exit's PLAYER_LEAVING_WORLD while in the world
   * (0x00528c30); then PLAYER_LOGOUT. `inCombat` is asked only while in the world.
   */
  teardownEvents(inCombat: () => boolean = () => false): readonly string[] {
    const events = this.#inWorld
      // L5c 3.18: the world exit is the whole 0x00528c30 — INSTANCE_LOCK_STOP before the leave.
      ? [...(inCombat() ? ["PLAYER_REGEN_ENABLED"] : []), ...frameXmlWorldExitEvents(false), "PLAYER_LOGOUT"]
      : ["PLAYER_LOGOUT"];
    this.#inWorld = false;
    return events;
  }
}
