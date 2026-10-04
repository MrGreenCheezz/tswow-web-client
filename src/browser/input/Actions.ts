import { unit } from "../../world/Fields.js";
import { EXTRA_ACTION_BARS, actionPage } from "../../world/ActionBarProtocol.js";
import { COMMAND_ATTACK, isVehicleActionBar } from "../../world/PetProtocol.js";
import { game } from "../game/Context.js";
import { cycleEnemyTarget, setFocusToTarget } from "../game/Targeting.js";
import { targetLastUnit, targetNearestUnit } from "../game/Targeting.js"; // L2 3.11
import { // L2 3.11
  NEAREST_ENEMY_PLAYER, NEAREST_FRIEND, NEAREST_FRIEND_PLAYER, type NearestMode,
} from "../game/TargetNearestModes.js";
import type { TargetLastKind } from "../game/TargetLast.js"; // L2 3.11
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
import { followTarget } from "./FollowCommand.js";
import { globalString } from "../../generated/globalStrings.js";
import { notice } from "../ui/Notices.js";
import { UNIT_STAND_STATE_SIT, UNIT_STAND_STATE_STAND } from "../../world/CharacterProgressProtocol.js";
import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import { playerInventory } from "../Inventory.js";
import { toggleBackpack, toggleBag } from "../ui/Bags.js";
import { toggleFrameXmlBackpack, toggleFrameXmlBag } from "../framexml/FrameXmlBagController.js";
import { toggleFrameXmlCharacterTab } from "../framexml/FrameXmlCharacterController.js";
import { toggleFrameXmlFriends } from "../framexml/FrameXmlFriendsController.js";
import { frameXmlClassHasRelicSlot } from "../framexml/FrameXmlRelicSlot.js";
import { frameXmlShapeshiftForms } from "../framexml/FrameXmlShapeshiftForms.js";
import { toggleReputation } from "../ui/Reputation.js";
import { toggleSocialPanel } from "../ui/SocialPanel.js";
import { toggleScoreboard } from "../ui/Scoreboard.js";
import { minimapSettings, setMinimapRotation, zoomMinimap } from "../ui/Minimap.js";
import { pressPetButton } from "../ui/PetBar.js";
import { castSpell } from "../ui/Spellbook.js";
import { macroUnitGuid } from "../ui/CombatCommands.js";
import { setSetting, settingOn } from "../ui/Settings.js";
import { actionPageViewable, getActionBarPage } from "../ui/ActionBar.js"; // L7 4.16b: actionPageViewable
import { stockPageStep } from "../ui/ActionBarStockLayout.js"; // L7 4.16b
import {
  EQUIPMENT_SLOT_MAINHAND, EQUIPMENT_SLOT_OFFHAND, EQUIPMENT_SLOT_RANGED, nextSheathState, partyMemberTarget,
  sheathBlocked, // L7 4.16b: stepActionPage gave way to stockPageStep
} from "./StockVerbs.js";
import { // 11.02-input
  VEHICLE_CAMERA_KEY_YARDS, vehicleAimStepKey, vehicleExitKey, vehicleSeatKey,
} from "./VehicleVerbs.js";
import { vehicleCamera } from "../game/VehicleCamera.js"; // 11.02-input
import { cameraMaxDistance } from "../ui/Settings.js"; // 11.02-input
import { liveCameraViews, useCameraViewMotion } from "../game/CameraViewsLive.js"; // DEC-B 3.11
import { VEHICLE_ZOOM_DISTANCE } from "../game/VehicleCamera.js"; // DEC-B 3.11
import { settings } from "../ui/Settings.js"; // DEC-B 3.11
import { settingNumber } from "../ui/SettingsModel.js"; // DEC-B 3.11

// DEC-B 3.11: a view switch's speeds and ceiling (game/CameraViews.ts) — cameraYawSmoothSpeed, the pitch at a
// quarter of it (the stock slider's cameraPitchSmoothSpeed), the wheel's ceiling of the moment (the vehicle's
// 50 yards in vehicle mode). Set here for the Lua path too: LiveWorldSeam's graph stays DOM-free.
useCameraViewMotion(() => {
  const yaw = settingNumber(settings(), "cameraYawSmoothSpeed");
  return { yawSpeed: yaw, pitchSpeed: yaw / 4, ceiling: vehicleCamera.vehicleMode ? VEHICLE_ZOOM_DISTANCE : cameraMaxDistance() };
});

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
    // No page given: the main row as shown, which under a stance, a form or stealth is its bonus page.
    useSlot(slot);
    return true;
  }
  // The four extra bars address as fixed pages of the same 144 slots, so their keys press the same
  // function the main bar's do — with the row's own page instead of the one the paging keys move.
  // That is the page the stock multi-bar answering to the same key shows (`stockBase`, WORK_PLAN
  // 4.16a) — under either HUD since L7 4.16b put the native rows on the stock pages.
  for (const bar of EXTRA_ACTION_BARS) {
    const column = EXTRA_ACTION_BAR_SLOTS[bar.id]?.indexOf(action) ?? -1;
    if (column >= 0) {
      useSlot(column, actionPage(bar.stockBase)); // L7 4.16b
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
      // The focus frame now shows the new focus (`#focus-frame` in UnitFrames.ts, or the stock
      // FocusFrame). This system line predates that frame and is kept as an extra confirmation.
      const focused = game.focusGuid === undefined ? undefined : world.state.objects.get(game.focusGuid);
      systemLine(focused ? `Фокус: ${unitDisplayName(focused)}` : "Фокус снят");
      return true;
    }

    case "interact":
      interactWithTarget();
      return true;

    case "attackTarget":
      if (world.targetGuid === undefined) return false;
      world.attacking || world.attackRequested ? world.stopAttack() : world.startAttack();
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

    // ---- stock commands added by 3.11 (input/StockActions.ts) ----

    case "toggleSheath":
      return toggleSheath();

    case "followTarget": {
      // 5.18: a refusal is the client's own UIErrorsFrame line (Wow.exe 0x005216F0).
      const refusal = followTarget();
      if (refusal) {
        const text = globalString(refusal) ?? refusal;
        if (world.onSpellStatus) world.onSpellStatus(text, true);
        else notice(text);
      }
      return true;
    }

    case "assistTarget": {
      // AssistUnit("target") (0x525eb0): the target's own target, read from UNIT_FIELD_TARGET.
      // L2 3.11: no target is the UI error ERR_GENERIC_NO_TARGET (0x5216f0(199)); a target with none
      // of its own (or one out of sight) is nothing; with the assistAttack CVar (0xbd0918,
      // registered at 0x51dba6, default "0") the unit selected is attacked (0x6e4950 = startAttack).
      const assisted = world.targetGuid === undefined ? undefined : world.state.objects.get(world.targetGuid); // L2-review
      // L2-review: 0x525eb0 looks the token up as a unit (0x4d4db0, TYPEMASK_UNIT 8): a selected corpse
      // is no target, and its CORPSE_FIELD_ITEM words must not be read as UNIT_FIELD_TARGET.
      if (assisted?.typeId !== 3 && assisted?.typeId !== 4) { // L2 3.11; L2-review: was `targetGuid === undefined || !objects.has(targetGuid)`
        uiError("ERR_GENERIC_NO_TARGET");
        return true;
      }
      const assistedGuid = macroUnitGuid("targettarget"); // DEC-review 3.11: named (was inline below)
      if (!selectUnit(assistedGuid)) return false; // L2 3.11
      // DEC-review 3.11: the swing only at the unit just selected and only if CanAttack takes it — Wow.exe 0x6e4950 →
      // 0x6e2610 asks 0x729a70 (→ 0x729740) and sends no CMSG_ATTACKSWING for the player himself or a friend.
      const chosen = assistedGuid !== undefined && world.targetGuid === assistedGuid ? world.state.objects.get(assistedGuid) : undefined; // DEC-review 3.11
      if (settingOn("assistAttack") && chosen !== undefined && world.canAttackUnit(chosen)) world.startAttack(); // L2 3.11; DEC-review 3.11: `&& chosen … canAttackUnit`
      return true;
    }

    // ---- L2 3.11: the other TargetNearest* modes and the history keys (game/Targeting.ts) ----

    case "targetNearestFriend": return nearestKey(NEAREST_FRIEND, false);
    case "targetPreviousFriend": return nearestKey(NEAREST_FRIEND, true);
    case "targetNearestEnemyPlayer": return nearestKey(NEAREST_ENEMY_PLAYER, false);
    case "targetPreviousEnemyPlayer": return nearestKey(NEAREST_ENEMY_PLAYER, true);
    case "targetNearestFriendPlayer": return nearestKey(NEAREST_FRIEND_PLAYER, false);
    case "targetPreviousFriendPlayer": return nearestKey(NEAREST_FRIEND_PLAYER, true);
    case "targetLastHostile": return lastKey("enemy");
    case "targetLastTarget": return lastKey("target");

    case "targetFocus":
      return selectUnit(game.focusGuid);

    case "targetMouseover":
      return selectUnit(macroUnitGuid("mouseover"));

    case "targetPet":
      return selectUnit(macroUnitGuid("pet"));

    case "targetPartyMember1":
    case "targetPartyMember2":
    case "targetPartyMember3":
    case "targetPartyMember4": {
      const n = action.slice(-1);
      return selectUnit(partyMemberTarget(world.targetGuid, macroUnitGuid(`party${n}`), macroUnitGuid(`partypet${n}`)));
    }

    case "targetPartyPet1":
    case "targetPartyPet2":
    case "targetPartyPet3":
    case "targetPartyPet4":
      return selectUnit(macroUnitGuid(`partypet${action.slice(-1)}`));

    case "friendNamePlates": {
      // Bindings.xml FRIENDNAMEPLATES: friends only, or off when friends only was already on.
      const enemies = settingOn("plateEnemies");
      const friends = settingOn("plateFriends");
      if (friends && !enemies) setSetting("plateFriends", false);
      else {
        setSetting("plateFriends", true);
        setSetting("plateEnemies", false);
      }
      return true;
    }

    case "allNamePlates": {
      // Bindings.xml ALLNAMEPLATES: both on when both were off, else both off.
      const on = !settingOn("plateEnemies") && !settingOn("plateFriends");
      setSetting("plateEnemies", on);
      setSetting("plateFriends", on);
      return true;
    }

    case "startAttack":
      if (world.targetGuid === undefined) return false;
      world.startAttack();
      showTarget();
      return true;

    case "stopAttack":
      world.stopAttack();
      showTarget();
      return true;

    case "stopCasting":
      world.cancelSpellCast();
      return true;

    case "toggleBackpack":
      if (!toggleFrameXmlBackpack()) toggleBackpack();
      return true;

    case "toggleBag1":
    case "toggleBag2":
    case "toggleBag3":
    case "toggleBag4": {
      // TOGGLEBAGn is ToggleBag(5 - n) (Bindings.xml): F8 is the fourth container.
      const container = 5 - Number(action.slice(-1));
      return toggleFrameXmlBag(container) || toggleBag(container);
    }

    case "toggleReputation":
      if (!toggleFrameXmlCharacterTab("ReputationFrame")) toggleReputation();
      return true;

    case "toggleSocial":
      if (!toggleFrameXmlFriends()) toggleSocialPanel();
      return true;

    case "toggleWorldStateScores":
      toggleScoreboard();
      return true;

    case "minimapZoomIn":
      zoomMinimap("in");
      return true;

    case "minimapZoomOut":
      zoomMinimap("out");
      return true;

    case "toggleMinimapRotation":
      setMinimapRotation(!minimapSettings().rotate);
      return true;

    case "previousActionPage":
      // L7 4.16b: ActionBar_PageDown/PageUp skip a page a shown extra row already shows.
      turnActionPage(stockPageStep(getActionBarPage() - 1, -1, actionPageViewable));
      return true;

    case "nextActionPage":
      turnActionPage(stockPageStep(getActionBarPage() - 1, 1, actionPageViewable)); // L7 4.16b
      return true;

    // ---- 11.02-input: Bindings.xml's VEHICLE section (VehicleVerbs.ts); the aim keys are held ones ----

    case "vehicleExit": {
      // VehicleExit 0x005fb660: a refusal is the client's own UIErrorsFrame line, as followTarget's.
      const refusal = vehicleExitKey(world);
      if (refusal) {
        const text = globalString(refusal) ?? refusal;
        if (world.onSpellStatus) world.onSpellStatus(text, true);
        else notice(text);
      }
      return true;
    }

    case "vehiclePrevSeat":
    case "vehicleNextSeat":
      vehicleSeatKey(world, action === "vehicleNextSeat");
      return true;

    case "vehicleAimIncrement":
    case "vehicleAimDecrement":
      vehicleAimStepKey(action === "vehicleAimIncrement" ? 1 : -1);
      return true;

    case "vehicleCameraZoomIn":
    case "vehicleCameraZoomOut":
      // VehicleCameraZoomIn/Out(1.0) = CameraZoomIn/Out (0x006017e0/0x00601840): a yard, the wheel's bounds.
      game.camera.distance = vehicleCamera.zoomBy(game.camera.distance,
        action === "vehicleCameraZoomIn" ? -VEHICLE_CAMERA_KEY_YARDS : VEHICLE_CAMERA_KEY_YARDS, cameraMaxDistance());
      return true;

    // ---- DEC-B 3.11: Bindings.xml's CAMERA section (game/CameraViews.ts); false when the view did not change ----

    case "nextView": return liveCameraViews.nextView(); // DEC-B 3.11: NextView() (End)
    case "prevView": return liveCameraViews.prevView(); // DEC-B 3.11: PrevView() (Home)
    case "setView1": case "setView2": case "setView3": case "setView4": case "setView5": // DEC-B 3.11
      return liveCameraViews.setView(Number(action.slice(-1)));
    case "saveView1": case "saveView2": case "saveView3": case "saveView4": case "saveView5": // DEC-B 3.11
      return liveCameraViews.saveView(Number(action.slice(-1)));
    case "resetView1": case "resetView2": case "resetView3": case "resetView4": case "resetView5": // DEC-B 3.11
      return liveCameraViews.resetView(Number(action.slice(-1)));
    case "flipCameraYaw": // DEC-B 3.11: FlipCameraYaw(180)
      liveCameraViews.flipCameraYaw(180);
      return true;

    default: {
      const pet = /^bonusAction(\d+)$/.exec(action);
      if (pet) return pressPetButton(Number(pet[1]));
      const form = /^shapeshift(\d+)$/.exec(action);
      if (form) return castShapeshiftForm(Number(form[1]));
      // The held movement actions land here and are deliberately no verbs: they are started and
      // stopped by `Controls`, not run once.
      return false;
    }
  }
}

/** `TargetUnit` for a GUID a stock command resolved; false when there is none or it is not in sight. */
function selectUnit(guid: bigint | undefined): boolean {
  const world = game.world;
  if (!world || guid === undefined || guid === 0n || !world.state.objects.has(guid)) return false;
  world.selectTarget(guid);
  showTarget();
  return true;
}

/** L2 3.11: `TargetNearest*(reverse)` in `mode`; false when nothing was picked. */
function nearestKey(mode: NearestMode, reverse: boolean): boolean {
  if (!targetNearestUnit(mode, reverse)) return false;
  showTarget();
  return true;
}

/** L2 3.11: `TargetLastEnemy()` / `TargetLastTarget()`; false when the selection was left alone. */
function lastKey(kind: TargetLastKind): boolean {
  if (!targetLastUnit(kind)) return false;
  showTarget();
  return true;
}

/** L2 3.11: a refusal the client prints with 0x5216f0 — the UIErrorsFrame line, as followTarget's. */
function uiError(name: string): void {
  const text = globalString(name) ?? name;
  const world = game.world;
  if (world?.onSpellStatus) world.onSpellStatus(text, true);
  else notice(text);
}

/** `ToggleSheath()` — see `StockVerbs.nextSheathState` for the Wow.exe rule it follows. */
function toggleSheath(): boolean {
  const world = game.world;
  const selfGuid = world?.state.selfGuid;
  const self = selfGuid === undefined ? undefined : world?.state.objects.get(selfGuid);
  if (!world || !self) return false;
  if (sheathBlocked(unit.health(self), unit.flags(self),
    self.fields.get(UPDATE_FIELDS.UNIT_CHANNEL_SPELL.offset))) return true;
  const equipment = playerInventory(world.state)?.equipment ?? [];
  const melee = equipment[EQUIPMENT_SLOT_MAINHAND]?.item !== undefined
    || equipment[EQUIPMENT_SLOT_OFFHAND]?.item !== undefined;
  const ranged = equipment[EQUIPMENT_SLOT_RANGED]?.item !== undefined && !frameXmlClassHasRelicSlot(unit.classId(self));
  const next = nextSheathState(unit.sheathState(self), melee, ranged);
  if (next !== undefined) world.setSheathed(next);
  return true;
}

/**
 * `ShapeshiftBar_ChangeForm(id)` → `CastShapeshiftForm(id)` (BonusActionBarFrame.lua:194): the id-th
 * form of the list the stock bar shows (FrameXmlShapeshiftForms.ts), cast the way the book casts.
 * False when there is no such form.
 */
function castShapeshiftForm(index: number): boolean {
  const world = game.world;
  if (!world) return false;
  const form = frameXmlShapeshiftForms(world.knownSpells, (id) => game.spells.get(id),
    (id) => game.talentData?.spellAbilitiesOf(id))[index - 1];
  if (!form) return false;
  castSpell(form.spellId);
  return true;
}
