import { unit } from "../../world/Fields.js";
import { EXTRA_ACTION_BARS, actionPage } from "../../world/ActionBarProtocol.js";
import { COMMAND_ATTACK, isVehicleActionBar } from "../../world/PetProtocol.js";
import { game } from "../game/Context.js";
import { cycleEnemyTarget, setFocusToTarget } from "../game/Targeting.js";
import { turnActionPage, useSlot } from "../ui/ActionBar.js";
import { chatInput, diagnosticsWindow, spellbookWindow } from "../ui/Dom.js";
import { showUnhandledOpcodes } from "../ui/Diagnostics.js";
import { systemLine } from "../ui/Chat.js";
import { openChatInput, replyToLastWhisper } from "../ui/ChatInputOwner.js";
import { showTarget, unitDisplayName } from "../ui/Frames.js";
import { interactWithTarget } from "../ui/Npc.js";
import { toggleQuestLog } from "../ui/QuestLog.js";
import { openCharacterWindow, toggleGameWindow } from "../ui/Windows.js";
import { toggleAllBags, toggleKeyring } from "../ui/Bags.js";
import { toggleWorldMap } from "../ui/WorldMap.js";
import { toggleKeyBindingsWindow } from "../ui/KeyBindings.js";
import { toggleTalentsWindow } from "../ui/Talents.js";
import { toggleSetting } from "../ui/Settings.js";
import { toggleFrameXmlPvp } from "../framexml/FrameXmlPvpController.js";
import { toggleArenaWindow } from "../ui/ArenaWindow.js";
import { toggleLfgWindow } from "../ui/Social.js";
import {
  toggleFrameXmlBags,
  toggleFrameXmlKeyring,
} from "../framexml/FrameXmlBagController.js";
import { toggleFrameXmlQuest } from "../framexml/FrameXmlQuestController.js";
import { toggleFrameXmlTalent } from "../framexml/FrameXmlTalentController.js";
import { ACTION_BAR_PAGES, ACTION_BAR_SLOTS, type InputAction, EXTRA_ACTION_BAR_SLOTS } from "./Bindings.js";
import { isGrounded, toggleAutoRun, toggleWalkRun } from "./Movement.js";
import { UNIT_STAND_STATE_SIT, UNIT_STAND_STATE_STAND } from "../../world/CharacterProgressProtocol.js";

/**
 * What each action does.
 *
 * Kept apart from the listeners that fire them and from the table that names them, because those
 * two have no business knowing about panels: `Controls` turns an event into an action name and
 * this turns an action name into a verb. A new binding is then one row in the table and one case
 * here, and never a new listener.
 */

/**
 * Runs one action. Returns whether it did anything, which is what tells the browser to keep the
 * key: an unhandled Tab still has to move focus between the login fields.
 */
export function runAction(action: InputAction): boolean {
  const world = game.world;

  // Everything below this line needs a world. The action bar and the panels are meaningless in
  // the character list, and Tab there belongs to the form.
  if (!world) return false;

  const slot = ACTION_BAR_SLOTS.indexOf(action);
  if (slot >= 0) {
    useSlot(slot);
    return true;
  }
  // The four extra bars address as fixed pages of the same 144 slots, so their keys press the same
  // function the main bar's do — with the row's own page instead of the one the paging keys move.
  for (const bar of EXTRA_ACTION_BARS) {
    const column = EXTRA_ACTION_BAR_SLOTS[bar.id]?.indexOf(action) ?? -1;
    if (column >= 0) {
      useSlot(column, actionPage(bar.base));
      return true;
    }
  }
  const page = ACTION_BAR_PAGES.indexOf(action);
  if (page >= 0) {
    turnActionPage(page);
    return true;
  }

  switch (action) {
    case "toggleAutoRun":
      toggleAutoRun();
      return true;

    case "toggleWalkRun":
      toggleWalkRun();
      return true;

    case "sitOrStand": {
      // Only with both feet on something. The same key is the descent while swimming or flying,
      // and there is nothing to sit down on in either.
      if (!isGrounded()) return true;
      const self = world.state.selfGuid === undefined ? undefined : world.state.objects.get(world.state.selfGuid);
      const standing = (self ? unit.standState(self) : UNIT_STAND_STATE_STAND) === UNIT_STAND_STATE_STAND;
      world.setStandState(standing ? UNIT_STAND_STATE_SIT : UNIT_STAND_STATE_STAND);
      return true;
    }

    case "targetNearestEnemy":
      cycleEnemyTarget(1);
      showTarget();
      return true;

    case "targetPreviousEnemy":
      cycleEnemyTarget(-1);
      showTarget();
      return true;

    case "targetSelf":
      if (world.state.selfGuid === undefined) return false;
      world.selectTarget(world.state.selfGuid);
      showTarget();
      return true;

    case "setFocus": {
      setFocusToTarget();
      // The focus frame belongs to slice I2; until it exists the only way the player can tell the
      // key did anything is to be told.
      const focused = game.focusGuid === undefined ? undefined : world.state.objects.get(game.focusGuid);
      systemLine(focused ? `Фокус: ${unitDisplayName(focused)}` : "Фокус снят");
      return true;
    }

    case "interact":
      interactWithTarget();
      return true;

    case "attackTarget":
      if (world.targetGuid === undefined) return false;
      world.attacking ? world.stopAttack() : world.startAttack();
      showTarget();
      return true;

    case "petAttack": {
      // The pet bar is also the vehicle bar: a siege engine has no pet to send, and the server
      // would refuse the order. `commandPet` defaults to the current target, like the bar button.
      const bar = world.petSpells;
      if (!bar || bar.closed || isVehicleActionBar(bar.bar)) return false;
      world.commandPet(COMMAND_ATTACK);
      return true;
    }

    case "toggleCharacter":
      openCharacterWindow("sheet");
      return true;

    case "toggleBags":
      if (!toggleFrameXmlBags()) toggleAllBags();
      return true;

    case "toggleKeyring":
      if (!toggleFrameXmlKeyring()) toggleKeyring();
      return true;

    case "toggleSpellbook":
      toggleGameWindow(spellbookWindow);
      return true;

    case "togglePvp":
      // The stock PVP summary owns the honor and battleground pages; without a successful
      // FrameXML gate the native arena window remains the explicit fallback.
      if (!toggleFrameXmlPvp()) toggleArenaWindow();
      return true;

    case "toggleLfd":
      // TOGGLELFGPARENT: the stock LFDParentFrame when the mount published it, else #lfg-window
      // (toggleLfgWindow asks the stock owner first).
      toggleLfgWindow();
      return true;

    case "toggleTalents":
      if (!toggleFrameXmlTalent()) toggleTalentsWindow();
      return true;

    case "toggleProfessions":
      openCharacterWindow("skills");
      return true;

    case "toggleQuestLog":
      if (!toggleFrameXmlQuest()) toggleQuestLog();
      return true;

    case "toggleWorldMap":
      toggleWorldMap();
      return true;

    case "toggleDiagnostics":
      toggleGameWindow(diagnosticsWindow);
      if (!diagnosticsWindow.hidden) showUnhandledOpcodes();
      return true;

    case "toggleNamePlates":
      toggleSetting("plateEnemies");
      return true;

    case "toggleFps":
      toggleSetting("showFps");
      return true;

    case "toggleKeyBindings":
      toggleKeyBindingsWindow();
      return true;

    // The three chat keys ask `ChatInputOwner`, which answers with the stock `ChatFrame1EditBox`
    // while the world mount has published it and with the native input otherwise.
    case "openChat":
      if (!openChatInput()) chatInput.focus();
      return true;

    case "openChatSlash":
      if (!openChatInput("/")) chatInput.focus();
      return true;

    case "replyWhisper":
      replyToLastWhisper();
      return true;

    default:
      // The held movement actions land here and are deliberately no verbs: they are started and
      // stopped by `Controls`, not run once.
      return false;
  }
}
