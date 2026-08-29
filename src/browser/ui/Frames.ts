import { UPDATE_FIELDS } from "../../generated/updateFields.js";
// Aliased: the parameter every paint takes is also called `player`.
import { POWER, isLootable, player as playerFields, unit } from "../../world/Fields.js";
import { WorldObjectState, isWorldObjectDead } from "../../world/WorldState.js";
import { SELF, WorldStore } from "../../world/WorldStore.js";
import { creatureIconSource, creatureTypeName } from "../CreatureMetadata.js";
import type { CreatureModelClient, EquippedItem, UnitModel } from "../CreatureModelClient.js";
import type { ItemMetadataClient } from "../ItemMetadata.js";
import { game } from "../game/Context.js";
import { Bar } from "./Widgets.js";
import { showAuras } from "./Auras.js";
import {
  attackButton, clearTargetButton, form, interactButton, lootButton, playerHealthBar, playerHealthText, playerIcon,
  playerHudDetails, playerPowerBar, targetActions, targetAuras, targetDetails, targetHealthBar, targetHealthText,
  targetIcon, targetName, targetPanel, bankerButton, trainerButton, vendorButton,
} from "./Dom.js";
import { skinnable, slot } from "./Slots.js";
import { gameObjectAction } from "../game/Interaction.js";
import { targetPower, playerExperience, playerHud } from "./Dom.js";
import {
  CLASS_ATLAS_PATH, classPortraitPosition, hasClassIcon, raidMarkGlyph, raidMarksByUnit, threatFraction,
} from "./UnitSnapshot.js";
import { setIconSource, spellIconUrl } from "./IconImage.js";
import { reactionTo } from "../game/Targeting.js";
import { REACTION_FRIENDLY, REACTION_HOSTILE } from "../../world/FactionRules.js";
import { setPlayerPortrait, setTargetPortrait } from "./Portraits.js";

export const typeNames = ["object", "item", "container", "unit", "player", "gameobject", "dynamicobject", "corpse"];

/** What each power is called, in the order `UNIT_FIELD_POWER1` runs. */
export const POWER_NAMES = ["Мана", "Ярость", "Фокус", "Энергия", "Счастье", "Руны", "Сила рун"];

/**
 * A power's word, or its number when this build has none for it.
 *
 * Seven names is what 3.3.5 has, and `ChrClasses.DisplayPower` is a number a module may set to
 * anything. The bare `?? "Сила"` this replaces was honest but anonymous: two different unknown
 * powers read identically, and the one thing worth knowing about an unnamed bar is which one it is.
 */
export function powerName(powerType: number): string {
  return POWER_NAMES[powerType] ?? `Сила ${powerType}`;
}

export const barWidth = (value: number | undefined, maximum: number | undefined): string =>
  value === undefined || !maximum ? "0%" : `${Math.max(0, Math.min(100, (value / maximum) * 100))}%`;

/** The player and target frames, and the model a unit wears. */

/**
 * The model a unit wears. Creatures carry their textures in the display record; a player's body
 * and hair have to be looked up from its appearance bytes, and until that answer arrives the unit
 * keeps its stand-in rather than appearing untextured for good.
 */
export function unitModelFor(
  object: WorldObjectState,
  creatureModels: CreatureModelClient | undefined,
  itemMetadata: ItemMetadataClient | undefined,
): UnitModel | undefined {
  const displayId = object.fields.get(UPDATE_FIELDS.UNIT_FIELD_DISPLAYID.offset) ?? 0;
  const metadata = creatureModels?.get(displayId);
  if (!metadata || object.typeId !== 4) return metadata;
  // A player who is not currently in their own body: a cat, a bear, a sheep, a ghost wolf. The
  // server writes NATIVEDISPLAYID once, in `Player::InitDisplayIds`, and moves DISPLAYID for every
  // shapeshift — the field is PUBLIC (`generated/updateFields.ts:799-806`), so the difference is
  // readable here and it is the whole test. Pasting the character's own skin, hair and worn armour
  // onto a bear's record made a bear textured as a night elf; worse, the display records the
  // gateway serves for a `Character\` model already carry a baked appearance
  // (`gateway/CreatureModelMetadata.ts:103-105` → `CharacterAppearance.forModel:941-950`), so the
  // paste also threw away the correct look for any polymorph into another race.
  if (displayId !== (unit.nativeDisplayId(object) ?? displayId)) return metadata;
  // UNIT_FIELD_BYTES_0 packs race, class, gender, power type; PLAYER_BYTES packs skin, face,
  // hair style and hair colour; PLAYER_BYTES_2 starts with the facial-hair choice. Face and
  // facial hair were simply never read, which is most of why a player had no face.
  const bytes = object.fields.get(UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset) ?? 0;
  const look = object.fields.get(UPDATE_FIELDS.PLAYER_BYTES.offset) ?? 0;
  const look2 = object.fields.get(UPDATE_FIELDS.PLAYER_BYTES_2.offset) ?? 0;
  const equipment = visibleEquipmentFor(object, itemMetadata);
  const appearance = creatureModels?.playerAppearance(
    bytes & 0xff, (bytes >>> 16) & 0xff,
    look & 0xff, (look >>> 8) & 0xff, (look >>> 16) & 0xff, (look >>> 24) & 0xff,
    look2 & 0xff, equipment);
  return appearance === undefined ? undefined : {
    ...metadata,
    appearance,
    appearancePending: visibleEquipmentMetadataPendingFor(object, itemMetadata),
  };
}

/** The live wrapper retains the UI's current clients; replay callers pass the captured ones. */
export function unitModel(object: WorldObjectState): UnitModel | undefined {
  return unitModelFor(object, game.creatureModels, game.itemMetadata);
}

/**
 * The model a unit is riding, when the server says it is riding one.
 *
 * `UNIT_FIELD_MOUNTDISPLAYID` is a `CreatureDisplayInfo` id like the one beside it: `Unit::Mount`
 * (`Unit.cpp:8668-8673`) writes it and `UNIT_FLAG_MOUNT` and leaves DISPLAYID alone, and
 * `WorldSession::SendDoFlight` (`TaxiHandler.cpp:121-131`) reaches the same method — so a taxi
 * gryphon and a paladin's charger arrive by one road. Until this slice the field had one reader in
 * the whole repository, `WindowBindings.ts:331`, and that one only asked whether it was zero.
 *
 * No appearance is composed and none is wanted: a mount is a creature and wears its own skin
 * variations. That is also why this is not `unitModel` reading a second field — `unitModel` exists
 * to decide whether the *player's* face belongs on the record, and a horse has no such question.
 */
export function mountModelFor(
  object: WorldObjectState,
  creatureModels: CreatureModelClient | undefined,
): UnitModel | undefined {
  const displayId = unit.mountDisplayId(object) ?? 0;
  if (displayId <= 0 || !creatureModels) return undefined;
  // Requests are owned by the once-per-world-update pass in `ui/WorldView.ts`; this lookup stays
  // read-only so portrait/replay callers do not start network work merely by asking for a mount.
  return creatureModels.get(displayId);
}

/** The live wrapper retains the UI's current creature-model client. */
export function mountModel(object: WorldObjectState): UnitModel | undefined {
  return mountModelFor(object, game.creatureModels);
}

/**
 * What a player is visibly wearing: nineteen PLAYER_VISIBLE_ITEM_N_ENTRYID fields, two words
 * apart. The item's inventory slot and display id come from the metadata the gateway already
 * serves for bags and tooltips, so the appearance request needs no new lookup — but an item that
 * has not been fetched yet is skipped rather than waited for, and appears a frame later.
 */
export function visibleEquipmentFor(
  object: WorldObjectState,
  itemMetadata: ItemMetadataClient | undefined,
): EquippedItem[] {
  const first = UPDATE_FIELDS.PLAYER_VISIBLE_ITEM_1_ENTRYID.offset;
  const stride = UPDATE_FIELDS.PLAYER_VISIBLE_ITEM_2_ENTRYID.offset - first;
  // Which word an item came from is its EQUIPMENT_SLOT, and that is not the same thing as its
  // inventory type: a one-handed weapon is INVTYPE_WEAPON whichever hand it is in.
  const worn: { slot: number; entry: number }[] = [];
  for (let slot = 0; slot < 19; slot++) {
    const entry = object.fields.get(first + slot * stride) ?? 0;
    if (entry > 0) worn.push({ slot, entry });
  }
  if (worn.length === 0) return [];
  void itemMetadata?.load(worn.map(({ entry }) => entry)).catch(() => undefined);

  const equipment: EquippedItem[] = [];
  for (const { slot, entry } of worn) {
    const item = itemMetadata?.get(entry);
    if (item && item.displayId > 0) {
      equipment.push({
        slot, inventoryType: item.inventoryType, displayId: item.displayId,
        ...(item.subClass === undefined ? {} : { subClass: item.subClass }),
      });
    }
  }
  return equipment;
}

/** Whether the appearance request is currently based on a partial visible-item snapshot. */
export function visibleEquipmentMetadataPendingFor(
  object: WorldObjectState,
  itemMetadata: ItemMetadataClient | undefined,
): boolean {
  const first = UPDATE_FIELDS.PLAYER_VISIBLE_ITEM_1_ENTRYID.offset;
  const stride = UPDATE_FIELDS.PLAYER_VISIBLE_ITEM_2_ENTRYID.offset - first;
  for (let slot = 0; slot < 19; slot++) {
    const entry = object.fields.get(first + slot * stride) ?? 0;
    if (entry <= 0) continue;
    const item = itemMetadata?.get(entry);
    if (!item) return true;
    // A dump row has display/inventory data but no ItemSubClass until the live item query lands.
    // Slot 17 is the only one where that missing field changes a visible action (wand vs gun).
    if (slot === 17 && item.subClass === undefined) return true;
  }
  return false;
}

/** The live wrapper retains the UI's current item-metadata client. */
export function visibleEquipment(object: WorldObjectState): EquippedItem[] {
  return visibleEquipmentFor(object, game.itemMetadata);
}

/**
 * The player frame, driven by the fields it shows rather than by every packet that lands.
 *
 * Power comes from the slot the unit's own power type names. Reading slot 1 for everyone, which is
 * what this frame did before, is mana — so a warrior, a rogue, a druid in form and a death knight
 * all watched an empty blue bar while their real resource moved in a slot nobody read.
 */
/** Built with the widget kit rather than from markup, because nothing in the page describes it. */
const experienceBar = new Bar({ kind: "experience", text: true });
playerExperience.append(experienceBar.root);

/** The target's own resource, in its own colour: rage is not mana and does not start full. */
const targetPowerBar = new Bar({ kind: "target-power" });
targetPower.append(targetPowerBar.root);

// What a module's patch file may reach in these two frames (М7). All four are markup, built once
// with the page, so they are declared once here: `showTarget` writes `hidden` on the six *buttons*
// and never on the row that holds them, which is what makes the row safe to hand over.
slot("target-frame/actions", targetActions);
slot("target-frame/details", targetDetails);
slot("player-frame/experience", playerExperience);
skinnable("target-frame", targetPanel);
skinnable("player-frame", playerHud);

/**
 * Puts the sheet where the class the element is currently carrying shows through the ring.
 *
 * The class is read off the element rather than closed over, because this also runs as the `load`
 * handler and the sheet takes a moment to decode: a player who enters the world on a second
 * character inside that moment would otherwise have the first character's cell written over
 * theirs, and nothing would move it back until the class changed again.
 */
function positionClassPortrait(): void {
  const carried = Number(playerIcon.dataset["class"]);
  if (!Number.isInteger(carried)) return;
  const offset = classPortraitPosition(playerIcon, carried);
  if (offset) playerIcon.style.objectPosition = offset;
}

/**
 * The player's own class, in the client's own art.
 *
 * The element was in the page from the beginning with `src="/icons/2273.png"` written into the
 * markup — the generic humanoid glyph — and no line of code ever wrote to it, so 66 of the frame's
 * 279 usable pixels showed the same picture to every character in the game while the body beside
 * it was truncating a five-field line into 213px. One cell of `UI-Classes-Circles.blp` is what
 * those pixels can say instead, and the atlas is already in the archives the gateway serves.
 *
 * Hidden until it has both a class and a gateway to ask, and hidden again if the texture route
 * refuses: an empty bordered square says less than no square at all.
 *
 * The cell is measured against the picture that actually arrived rather than against the 256x256
 * sheet this build was written for. A module that gives a class an icon makes tswow redraw all
 * three class sheets at 512x512 with eight columns, and the fractions in the FrameXML are rewritten
 * to match — so the sheet's own size is the only thing that turns those fractions back into pixels.
 * `naturalWidth` is zero until the image has decoded, which is why the offset is written twice:
 * once now, so the frame is never blank, and again on `load`. The window it is centred in is
 * measured off the element for the same reason and one more: the stylesheet narrows that box to
 * 46px below 760px, and a hidden element measures nothing at all — hence the show first, measure
 * second order here.
 */
function paintClassPortrait(classId: number | undefined): void {
  const origin = game.gatewayOrigin;
  if (classId === undefined || !origin || !hasClassIcon(classId)) {
    playerIcon.hidden = true;
    delete playerIcon.dataset["atlas"];
    return;
  }
  playerIcon.hidden = false;
  playerIcon.dataset["class"] = String(classId);
  positionClassPortrait();
  const wanted = `${origin}/texture?path=${encodeURIComponent(CLASS_ATLAS_PATH)}`;
  if (playerIcon.dataset["atlas"] === wanted) return;
  playerIcon.dataset["atlas"] = wanted;
  playerIcon.onerror = () => {
    playerIcon.onerror = null;
    playerIcon.hidden = true;
  };
  playerIcon.onload = positionClassPortrait;
  setIconSource(playerIcon, wanted);
}

export function bindPlayerHud(store: WorldStore): void {
  const paint = (player: WorldObjectState | undefined): void => {
    if (!player) {
      setPlayerPortrait(undefined);
      playerHudDetails.textContent = "Ожидание параметров…";
      playerHealthBar.style.width = "0%";
      playerHealthText.textContent = "";
      playerPowerBar.style.width = "0%";
      return;
    }
    setPlayerPortrait(player.guid);
    const level = unit.level(player);
    const health = unit.health(player);
    const maxHealth = unit.maxHealth(player);
    const powerType = unit.powerType(player) ?? POWER.mana;
    const scale = unit.powerScale(player);
    const power = unit.power(player);
    const maxPower = unit.maxPower(player);
    const powerText = power === undefined || maxPower === undefined
      ? ""
      : ` · ${powerName(powerType)} ${Math.round(power / scale)}/${Math.round(maxPower / scale)}`;
    // The level and the resource; the health numbers are on the health bar, where the eye is
    // already looking to see how much of it is left.
    playerHudDetails.textContent = `ур. ${level ?? "?"}${powerText}`;
    playerHealthBar.style.width = barWidth(health, maxHealth);
    playerHealthText.textContent = health === undefined ? "" : `${health} / ${maxHealth ?? "?"}`;
    playerPowerBar.style.width = barWidth(power, maxPower);
    // Read by the stylesheet, so rage is not drawn in mana's blue.
    playerPowerBar.dataset["power"] = String(powerType);
    paintClassPortrait(unit.classId(player));

    // Experience towards the next level. The fields have always arrived; nothing showed them.
    const experience = playerFields.experience(player);
    const nextLevel = playerFields.nextLevelExperience(player);
    if (experience === undefined || !nextLevel) {
      experienceBar.root.hidden = true;
    } else {
      experienceBar.root.hidden = false;
      experienceBar.set(experience, nextLevel, `${experience} / ${nextLevel}`);
    }
  };

  store.object(SELF, paint);
}

/**
 * What to call a unit.
 *
 * A player is whatever the name query came back with; a creature carries its name in the metadata
 * the gateway serves, which `displayName` knows nothing about — asked for a boar it answers with a
 * guid. Anything else falls back to its type and entry, which is at least a thing to look up.
 *
 * The creature table is asked only about a creature. `OBJECT_FIELD_ENTRY` on a game object is a
 * `gameobject_template` entry and the two tables number their rows independently, so a mailbox
 * whose entry collided with a creature's used to be called by that creature's name.
 */
export function unitDisplayName(object: WorldObjectState): string {
  const world = game.world;
  if (object.typeId === 4 && world) return world.displayName(object.guid);
  const entry = object.fields.get(UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset) ?? 0;
  const name = object.typeId === 3 ? game.creatureMetadata?.get(entry)?.name : undefined;
  return name ?? `${typeNames[object.typeId ?? -1] ?? "object"} · entry ${entry}`;
}

/**
 * The raid mark, the reaction and the threat, written onto a frame the page already owns.
 *
 * Kept in one function because the player frame and the target frame are markup rather than
 * `UnitFrame` instances — they were built before the widget existed and carry buttons no other
 * frame has. This is the seam between the two, and it writes the same attributes `UnitFrame` does
 * so one stylesheet rule covers both.
 */
export function writeUnitMarkings(
  frame: HTMLElement,
  raidMark: number | undefined,
  reaction: number | undefined,
  threat: number | undefined,
): void {
  const glyph = raidMarkGlyph(raidMark);
  if (glyph === undefined) delete frame.dataset["mark"];
  else frame.dataset["mark"] = glyph;

  if (reaction === undefined) delete frame.dataset["reaction"];
  else frame.dataset["reaction"] = reaction === REACTION_HOSTILE ? "hostile"
    : reaction === REACTION_FRIENDLY ? "friendly" : "neutral";

  if (threat === undefined) delete frame.dataset["threat"];
  else frame.dataset["threat"] = threat >= 1 ? "tanking" : threat >= 0.8 ? "high" : threat >= 0.5 ? "some" : "low";
}

export function showTarget(): void {
  const world = game.world;
  const previousTarget = targetAuras.dataset.guid;
  const currentTarget = world?.targetGuid?.toString() ?? "";
  if (previousTarget !== currentTarget) {
    targetAuras.dataset.guid = currentTarget;
    showAuras();
  }
  const target = world?.targetGuid === undefined ? undefined : world.state.objects.get(world.targetGuid);
  if (!world || !target) {
    setTargetPortrait(undefined);
    targetPanel.hidden = true;
    targetIcon.hidden = true;
    targetName.textContent = "Цель не выбрана";
    targetDetails.textContent = "";
    targetHealthBar.style.width = "0";
    targetHealthText.textContent = "";
    targetPowerBar.root.hidden = true;
    attackButton.disabled = true;
    // Hidden rather than greyed: five permanently dim buttons say less than none at all, and the
    // row is only as wide as what the target can actually answer.
    for (const button of [interactButton, lootButton, vendorButton, trainerButton, bankerButton]) {
      button.hidden = true;
    }
    clearTargetButton.disabled = true;
    attackButton.textContent = "⚔";
    attackButton.title = "Начать атаку";
    return;
  }

  setTargetPortrait(target.guid);

  targetPanel.hidden = false;

  // Slice I2's three markings, on the two frames that were already in the page. The raid mark and
  // the reaction are attributes rather than text so the stylesheet owns how they look, and the
  // threat is the fraction of the highest on this creature — the raw number says nothing without
  // the tank's beside it.
  const marks = raidMarksByUnit(world.raidTargets);
  writeUnitMarkings(targetPanel, marks.get(target.guid), reactionTo(target),
    threatFraction(world.threat.get(target.guid)?.entries ?? [], world.state.selfGuid ?? 0n));
  const selfGuid = world.state.selfGuid;
  writeUnitMarkings(playerHud, selfGuid === undefined ? undefined : marks.get(selfGuid), undefined, undefined);

  const entry = target.fields.get(UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset) ?? 0;
  // Only a creature's entry is a `creature_template` entry. This lookup was unconditional, so a
  // targeted game object — typeId 5, and its `OBJECT_FIELD_ENTRY` is a `gameobject_template`
  // entry out of an entirely different table — read whatever creature happens to share that
  // number, and the frame said its name, its subname, its family icon and its type. The plates
  // have had this guard since they were written (`NamePlates.ts`, `object.typeId === 3`); the
  // frame never got it. A player is unaffected either way: a player's entry is 0 and every path
  // into the metadata client refuses 0.
  const metadata = target.typeId === 3 ? game.creatureMetadata?.get(entry) : undefined;
  const level = target.fields.get(UPDATE_FIELDS.UNIT_FIELD_LEVEL.offset);
  const health = target.fields.get(UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset);
  const maxHealth = target.fields.get(UPDATE_FIELDS.UNIT_FIELD_MAXHEALTH.offset);
  targetName.textContent = metadata?.name ?? `Цель: ${unitDisplayName(target)}`;
  targetIcon.hidden = false;
  setIconSource(targetIcon, creatureIconSource(metadata, game.gatewayOrigin));
  targetIcon.onerror = () => {
    targetIcon.onerror = null;
    // The question mark, which is a spell icon like any other: a family whose picture is not in
    // this dataset falls back to the same route rather than to a file beside the page.
    setIconSource(targetIcon, spellIconUrl(2273, game.gatewayOrigin) ?? "");
  };
  // Five things were being folded into one line 213px wide, and the line does not hold five.
  //
  // The GUID alone was 22 characters of it — «GUID 0x» and sixteen hex digits — unconditionally,
  // with no `?? ""` guard, so it was the one term data could never drop. It is a debugging fact
  // and not a fact about the creature, so it moves to the title, where hovering still answers it
  // and nothing has to be truncated to make room. The health numbers move onto the bar that was
  // already drawing them as a proportion.
  targetDetails.textContent = [
    metadata?.subname ?? "",
    metadata ? creatureTypeName(metadata.type) : "",
    level === undefined ? "" : `ур. ${level}`,
  ].filter(Boolean).join(" · ");
  targetDetails.title = `GUID 0x${target.guid.toString(16).padStart(16, "0")}`;
  targetHealthBar.style.width = `${health === undefined || !maxHealth ? 0 : Math.max(0, Math.min(100, health / maxHealth * 100))}%`;
  targetHealthText.textContent = health === undefined ? "" : `${health} / ${maxHealth ?? "?"}`;
  // A creature's own resource, read from the slot its power type names rather than from slot one.
  const targetPowerValue = unit.power(target);
  const targetMaxPower = unit.maxPower(target);
  targetPowerBar.root.hidden = targetPowerValue === undefined || !targetMaxPower;
  targetPowerBar.set(targetPowerValue, targetMaxPower);
  targetPowerBar.setVariant(String(unit.powerType(target) ?? POWER.mana));
  attackButton.disabled = target.typeId !== 3 && target.typeId !== 4;
  const npcFlags = target.fields.get(UPDATE_FIELDS.UNIT_NPC_FLAGS.offset) ?? 0;
  const self = world.state.selfGuid === undefined ? undefined : world.state.objects.get(world.state.selfGuid);
  const action = target.typeId === 5 && self?.position ? gameObjectAction(world, target, self.position) : undefined;
  interactButton.hidden = target.typeId === 5
    ? action === undefined
    : target.typeId !== 3 || (npcFlags & 0x03) === 0;
  const interactLabel = target.typeId !== 5 ? "Поговорить"
    : action?.kind === "unlock" ? "Открыть" : "Использовать";
  interactButton.title = interactLabel;
  interactButton.setAttribute("aria-label", interactLabel);
  // A corpse only. A game object's loot is never requested — the server refuses the packet for
  // anything that is not a creature, and a chest's loot arrives once a spell has opened it.
  lootButton.hidden = !(target.typeId === 3 && isWorldObjectDead(target));
  // Marked, never disabled — the same rule the loot slots follow (`Npc.ts:109-117`). The bit is
  // the server's answer to «is there a sparkle on this body for you», and the server's answer to
  // «may I open it» is a stricter predicate the client cannot evaluate: `Player::SendLoot`
  // (`Player.cpp:8898-8902`) reads the raw flag, while the copy the client was sent has already
  // been through `isAllowedToLoot` per viewer and lags a round-robin handover by a packet
  // (`LootHandler.cpp:430` is the only forced resend, and only in one branch). So the mark says
  // what is known and the click still goes out; if the server disagrees it says so in words.
  const lootable = isLootable(target);
  if (lootable) lootButton.removeAttribute("aria-disabled");
  else lootButton.setAttribute("aria-disabled", "true");
  // The accessible name is written here as well as the tooltip, for the reason the attack button
  // below already carries: the static `aria-label` in the markup wins over `title`, so a screen
  // reader would go on saying «Обыскать» over a body that has nothing on it.
  const lootLabel = lootable ? "Обыскать" : "Здесь нечего обыскивать";
  lootButton.title = lootLabel;
  lootButton.setAttribute("aria-label", lootLabel);
  // UNIT_NPC_FLAG_VENDOR is 0x80; the trainer bits are 0x10, 0x20 and 0x40.
  vendorButton.hidden = target.typeId !== 3 || (npcFlags & 0x80) === 0;
  trainerButton.hidden = target.typeId !== 3 || (npcFlags & 0x70) === 0;
  // UNIT_NPC_FLAG_BANKER is 0x20000. The vault itself is already in the player's update fields;
  // this is the only thing that grants permission to move anything in it.
  bankerButton.hidden = target.typeId !== 3 || (npcFlags & 0x20000) === 0;
  clearTargetButton.disabled = false;
  attackButton.textContent = "⚔";
  // The state has to be in the accessible name too: a static `aria-label` in the markup overrides
  // the title, so a screen reader was told "autoattack" whether it was running or not.
  const attackLabel = world.attacking ? "Остановить атаку" : "Начать атаку";
  attackButton.title = attackLabel;
  attackButton.setAttribute("aria-label", attackLabel);
}
