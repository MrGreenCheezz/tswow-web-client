import { UPDATE_FIELDS } from "../../generated/updateFields.js";
// Aliased: the parameter every paint takes is also called `player`.
import { POWER, isLootable, player as playerFields, unit } from "../../world/Fields.js";
import { NPC_FLAGS_INTERACTION_MASK, NPC_FLAGS_VENDOR_MASK } from "../../world/NpcProtocol.js";
import { PLAYER_FLAGS_HIDE_CLOAK, PLAYER_FLAGS_HIDE_HELM } from "../../world/CharacterStatFields.js"; // 05.10-A7a-A 6.09
import { WorldObjectState, isWorldObjectDead } from "../../world/WorldState.js";
import { SELF, WorldStore } from "../../world/WorldStore.js";
import { creatureIconSource, creatureTypeName } from "../CreatureMetadata.js";
import type { CreatureModelClient, EquippedItem, UnitModel } from "../CreatureModelClient.js";
import type { ItemMetadataClient } from "../ItemMetadata.js";
import { withVirtualWeapons } from "../NpcWeapons.js"; // 05.10-A7a-B 6.02
import { wornSheathes } from "../SheathPoints.js"; // 05.10-A7a-G2 6.08
import { corpseModelFor } from "../CorpseModel.js"; // 05.10-A7a-G2 6.05
import { mirrorImageModelFor } from "../MirrorImageModel.js"; // 05.10-A7a-H 6.11б
import { UNIT_FLAG2_MIRROR_IMAGE, type MirrorImages } from "../../world/MirrorImages.js"; // 05.10-A7a-H 6.11б
import { game } from "../game/Context.js";
import { setTip, Bar } from "./Widgets.js";
import { showAuras } from "./Auras.js";
import {
  attackButton, characterMicroIcon, clearTargetButton, form, interactButton, lootButton, playerHealthBar,
  playerHealthText, playerIcon, playerHudDetails, playerPowerBar, targetActions, targetAuras, targetDetails, targetHealthBar, targetHealthText,
  targetIcon, targetName, targetPanel, bankerButton, trainerButton, vendorButton,
} from "./Dom.js";
import { skinnable, slot } from "./Slots.js";
import { gameObjectAction, gameObjectLockHint } from "../game/Interaction.js";
import { targetPower, playerExperience, playerHud } from "./Dom.js";
import {
  CLASS_ATLAS_PATH, CLASS_MICRO_PORTRAIT_HEIGHT, CLASS_MICRO_PORTRAIT_WIDTH,
  className, classPortraitPosition, hasClassIcon, raidMarkGlyph, raidMarksByUnit, threatFraction,
} from "./UnitSnapshot.js";
import { setIconSource, spellIconUrl } from "./IconImage.js";
import { reactionTo } from "../game/Targeting.js";
import { REACTION_FRIENDLY, REACTION_HOSTILE } from "../../world/FactionRules.js";
import { setPlayerPortrait, setTargetPortrait } from "./Portraits.js";
import { NATIVE_LANES_REPLACED, nativeHudReplaced } from "./NativeHudReplacement.js";

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

/**
 * Challenges the selected player to a duel.
 *
 * Created lazily in code rather than in markup: the target row is built from static buttons
 * and this one belongs to the same row without needing new element ids. Hidden for anything
 * that is not another player. Lazy because this module is also loaded in DOM-less tests.
 */
let duelChallengeButton: HTMLButtonElement | undefined;
function duelButton(): HTMLButtonElement | undefined {
  if (duelChallengeButton || typeof document === "undefined") return duelChallengeButton;
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "⚔ Дуэль";
  setTip(button, "Вызвать выбранного игрока на дуэль");
  button.setAttribute("aria-label", "Вызвать на дуэль");
  button.hidden = true;
  button.addEventListener("click", () => {
    const world = game.world;
    if (!world || world.targetGuid === undefined) return;
    if (!world.challengeDuelToSelection()) {
      world.onSpellStatus?.("Нельзя вызвать эту цель на дуэль", true);
    }
  });
  // `targetActions` is the static row the sibling buttons live in; in a DOM without markup
  // the button simply stays detached and hidden.
  try {
    targetActions.append(button);
  } catch {
    // A test DOM without the row: paint calls below only flip `hidden`, which is safe.
  }
  duelChallengeButton = button;
  return button;
}

/** The player and target frames, and the model a unit wears. */

const VISIBLE_ITEM_FIRST = UPDATE_FIELDS.PLAYER_VISIBLE_ITEM_1_ENTRYID.offset;
const VISIBLE_ITEM_STRIDE = UPDATE_FIELDS.PLAYER_VISIBLE_ITEM_2_ENTRYID.offset - VISIBLE_ITEM_FIRST;
const VISIBLE_ITEM_COUNT = 19;
// 05.10-A7a-A 6.09: PLAYER_FLAGS_HIDE_HELM/CLOAK (Player.h:364-365; PLAYER_FLAGS is PUBLIC, so other
// players' bits arrive too) and the two visible-item words they hide: EQUIPMENT_SLOT_HEAD 0, BACK 14.
const VISIBLE_SLOT_HEAD = 0;
const VISIBLE_SLOT_BACK = 14;

/** 05.10-A7a-A 6.09: the hide-helm and hide-cloak bits of a player's PLAYER_FLAGS (0 for others). */
function hiddenWornFlags(object: WorldObjectState): number {
  if (object.typeId !== 4) return 0;
  return (object.fields.get(UPDATE_FIELDS.PLAYER_FLAGS.offset) ?? 0) & (PLAYER_FLAGS_HIDE_HELM | PLAYER_FLAGS_HIDE_CLOAK);
}

interface ResolvedPlayerModel {
  readonly creatureModels: CreatureModelClient;
  readonly itemMetadata: ItemMetadataClient | undefined;
  readonly creatureGeneration: number;
  readonly itemGeneration: number | undefined;
  readonly displayId: number;
  readonly nativeDisplayId: number;
  readonly bytes: number;
  readonly look: number;
  readonly look2: number;
  readonly visibleItems: Uint32Array;
  /** 05.10-A7a-A 6.09: PLAYER_FLAGS & (HIDE_HELM | HIDE_CLOAK) the look was built with. */
  readonly hiddenWorn: number;
  readonly model: UnitModel;
}

// WorldObjectState keeps its fields Map while packet updates mutate individual words. A WeakMap
// ties this memo to that exact world object without retaining units after they leave visibility.
const resolvedPlayerModels = new WeakMap<WorldObjectState, ResolvedPlayerModel>();

function visibleItemsMatch(fields: WorldObjectState["fields"], items: Uint32Array): boolean {
  for (let slot = 0; slot < VISIBLE_ITEM_COUNT; slot++) {
    if ((fields.get(VISIBLE_ITEM_FIRST + slot * VISIBLE_ITEM_STRIDE) ?? 0) !== items[slot]) return false;
  }
  return true;
}

function visibleItemsSnapshot(fields: WorldObjectState["fields"]): Uint32Array {
  const items = new Uint32Array(VISIBLE_ITEM_COUNT);
  for (let slot = 0; slot < VISIBLE_ITEM_COUNT; slot++) {
    items[slot] = fields.get(VISIBLE_ITEM_FIRST + slot * VISIBLE_ITEM_STRIDE) ?? 0;
  }
  return items;
}

/**
 * The model a unit wears. Creatures carry their textures in the display record; a player's body
 * and hair have to be looked up from its appearance bytes, and until that answer arrives the unit
 * keeps its stand-in rather than appearing untextured for good.
 */
export function unitModelFor(
  object: WorldObjectState,
  creatureModels: CreatureModelClient | undefined,
  itemMetadata: ItemMetadataClient | undefined,
  mirrorImages?: Pick<MirrorImages, "get" | "awaiting">, // 05.10-A7a-H 6.11б: SMSG_MIRRORIMAGE_DATA replies
): UnitModel | undefined {
  // 05.10-A7a-G2 6.05: a corpse (or the renderer's view of one) wears its owner's look or its bones.
  if (object.typeId === 7) return corpseModelFor(object, creatureModels);
  const displayId = object.fields.get(UPDATE_FIELDS.UNIT_FIELD_DISPLAYID.offset) ?? 0;
  const metadata = creatureModels?.get(displayId);
  if (!metadata || !creatureModels) return metadata;
  // 05.10-A7a-B 6.02: a creature's UNIT_VIRTUAL_ITEM_SLOT_ID weapons ride `held` (NpcWeapons.ts).
  if (object.typeId !== 4) {
    // 05.10-A7a-H 6.11б: a mirror image, outfit NPC or NPCBot wears the look its reply describes.
    const flags2 = object.fields.get(UPDATE_FIELDS.UNIT_FIELD_FLAGS_2.offset) ?? 0;
    const worn = mirrorImages !== undefined && (flags2 & UNIT_FLAG2_MIRROR_IMAGE) !== 0
      ? mirrorImageModelFor(object, metadata, mirrorImages.get(object.guid, displayId, flags2), creatureModels,
        mirrorImages.awaiting(object.guid, displayId))
      : metadata;
    return withVirtualWeapons(worn, object, creatureModels.npcWeapons);
  }
  // A player who is not currently in their own body: a cat, a bear, a sheep, a ghost wolf. The
  // server writes NATIVEDISPLAYID once, in `Player::InitDisplayIds`, and moves DISPLAYID for every
  // shapeshift — the field is PUBLIC (`generated/updateFields.ts:799-806`), so the difference is
  // readable here and it is the whole test. Pasting the character's own skin, hair and worn armour
  // onto a bear's record made a bear textured as a night elf; worse, the display records the
  // gateway serves for a `Character\` model already carry a baked appearance
  // (`gateway/CreatureModelMetadata.ts:103-105` → `CharacterAppearance.forModel:941-950`), so the
  // paste also threw away the correct look for any polymorph into another race.
  const nativeDisplayId = unit.nativeDisplayId(object) ?? displayId;
  if (displayId !== nativeDisplayId) return metadata;
  // UNIT_FIELD_BYTES_0 packs race, class, gender, power type; PLAYER_BYTES packs skin, face,
  // hair style and hair colour; PLAYER_BYTES_2 starts with the facial-hair choice. Face and
  // facial hair were simply never read, which is most of why a player had no face.
  const bytes = object.fields.get(UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset) ?? 0;
  const look = object.fields.get(UPDATE_FIELDS.PLAYER_BYTES.offset) ?? 0;
  const look2 = object.fields.get(UPDATE_FIELDS.PLAYER_BYTES_2.offset) ?? 0;
  const hiddenWorn = hiddenWornFlags(object); // 05.10-A7a-A 6.09
  const cached = resolvedPlayerModels.get(object);
  if (cached && cached.creatureModels === creatureModels && cached.itemMetadata === itemMetadata
    && cached.creatureGeneration === creatureModels.generation
    && cached.itemGeneration === itemMetadata?.generation
    && cached.displayId === displayId && cached.nativeDisplayId === nativeDisplayId
    && cached.bytes === bytes && cached.look === look && cached.look2 === look2
    && cached.hiddenWorn === hiddenWorn // 05.10-A7a-A 6.09
    && visibleItemsMatch(object.fields, cached.visibleItems)) return cached.model;
  const equipment = visibleEquipmentFor(object, itemMetadata);
  const appearance = creatureModels?.playerAppearance(
    bytes & 0xff, (bytes >>> 16) & 0xff,
    look & 0xff, (look >>> 8) & 0xff, (look >>> 16) & 0xff, (look >>> 24) & 0xff,
    look2 & 0xff, equipment, (bytes >>> 8) & 0xff); // 05.10-A7a-A 6.10: the class, for the DK eye glow
  if (appearance === undefined) return undefined;
  const appearancePending = visibleEquipmentMetadataPendingFor(object, itemMetadata);
  const wornSheathe = wornSheathes(equipment); // 05.10-A7a-G2 6.08: where the hands' weapons stow
  const model: UnitModel = {
    ...metadata,
    appearance,
    appearancePending,
    ...(wornSheathe === undefined ? {} : { wornSheathe }), // 05.10-A7a-G2 6.08
  };
  // Pending item rows must keep the existing retry path active. Both real clients expose a
  // generation that changes when their async answers arrive; replay/test clients without one
  // continue through the ordinary resolver so a mutable mock cannot leave a stale appearance.
  if (!appearancePending && Number.isFinite(creatureModels.generation)
    && (itemMetadata === undefined || Number.isFinite(itemMetadata.generation))) {
    resolvedPlayerModels.set(object, {
      creatureModels, itemMetadata, creatureGeneration: creatureModels.generation,
      itemGeneration: itemMetadata?.generation, displayId, nativeDisplayId,
      bytes, look, look2, visibleItems: visibleItemsSnapshot(object.fields), hiddenWorn, model, // 05.10-A7a-A 6.09
    });
  }
  return model;
}

/** The live wrapper retains the UI's current clients; replay callers pass the captured ones. */
export function unitModel(object: WorldObjectState): UnitModel | undefined {
  return unitModelFor(object, game.creatureModels, game.itemMetadata, game.world?.mirrorImages); // 05.10-A7a-H 6.11б
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
  // Which word an item came from is its EQUIPMENT_SLOT, and that is not the same thing as its
  // inventory type: a one-handed weapon is INVTYPE_WEAPON whichever hand it is in.
  const worn: { slot: number; entry: number }[] = [];
  for (let slot = 0; slot < VISIBLE_ITEM_COUNT; slot++) {
    const entry = object.fields.get(VISIBLE_ITEM_FIRST + slot * VISIBLE_ITEM_STRIDE) ?? 0;
    if (entry > 0) worn.push({ slot, entry });
  }
  if (worn.length === 0) return [];
  void itemMetadata?.load(worn.map(({ entry }) => entry)).catch(() => undefined);

  const equipment: EquippedItem[] = [];
  const hidden = hiddenWornFlags(object); // 05.10-A7a-A 6.09
  for (const { slot, entry } of worn) {
    // 05.10-A7a-A 6.09: a helm or cloak the player hid is not worn for the look (TC's mirror image
    // does the same, SpellHandler.cpp) — still loaded above, so the pending test does not wait on it.
    if ((slot === VISIBLE_SLOT_HEAD && (hidden & PLAYER_FLAGS_HIDE_HELM) !== 0)
      || (slot === VISIBLE_SLOT_BACK && (hidden & PLAYER_FLAGS_HIDE_CLOAK) !== 0)) continue;
    const item = itemMetadata?.get(entry);
    if (item && item.displayId > 0) {
      equipment.push({
        slot, inventoryType: item.inventoryType, displayId: item.displayId,
        ...(item.subClass === undefined ? {} : { subClass: item.subClass }),
        ...(item.sheath === undefined ? {} : { sheathe: item.sheath }), // 05.10-A7a-G2 6.08: not in the look's key
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
  for (let slot = 0; slot < VISIBLE_ITEM_COUNT; slot++) {
    const entry = object.fields.get(VISIBLE_ITEM_FIRST + slot * VISIBLE_ITEM_STRIDE) ?? 0;
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
function positionClassPortrait(image: HTMLImageElement): void {
  const carried = Number(image.dataset["class"]);
  if (!Number.isInteger(carried)) return;
  const offset = image === characterMicroIcon
    ? classPortraitPosition(image, carried, CLASS_MICRO_PORTRAIT_WIDTH, CLASS_MICRO_PORTRAIT_HEIGHT)
    : classPortraitPosition(image, carried);
  if (offset && image.style.objectPosition !== offset) image.style.objectPosition = offset;
}

/** Every write change-only: the player frame paints on each step the character takes. */
function paintClassIcon(image: HTMLImageElement, classId: number | undefined, wanted: string | undefined): void {
  if (classId === undefined || !wanted || !hasClassIcon(classId)) {
    if (!image.hidden) image.hidden = true;
    if (image.dataset["atlas"] !== undefined) delete image.dataset["atlas"];
    if (image.dataset["class"] !== undefined) delete image.dataset["class"];
    return;
  }
  if (image.hidden) image.hidden = false;
  const carried = String(classId);
  if (image.dataset["class"] !== carried) image.dataset["class"] = carried;
  positionClassPortrait(image);
  if (image.dataset["atlas"] === wanted) return;
  image.dataset["atlas"] = wanted;
  image.onerror = () => {
    image.onerror = null;
    image.hidden = true;
    // A transient gateway/decode failure must remain retryable. Keeping this marker made the next
    // HUD paint reveal the same broken image and return before asking for the atlas again.
    if (image.dataset["atlas"] === wanted) delete image.dataset["atlas"];
  };
  image.onload = () => positionClassPortrait(image);
  setIconSource(image, wanted);
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
  const wanted = origin ? `${origin}/texture?path=${encodeURIComponent(CLASS_ATLAS_PATH)}` : undefined;
  paintClassIcon(playerIcon, classId, wanted);
  paintClassIcon(characterMicroIcon, classId, wanted);
}

/**
 * The micro button's class icon alone, and only when what it shows would change.
 *
 * It is not in the player frame's lane (`#game-buttons` has a stock owner of its own), so it keeps
 * its class under the stock PlayerFrame; repositioning it reads the page's layout, which is why an
 * unchanged class is left as it is. A failed picture drops its atlas marker (`paintClassIcon`), so
 * it is still asked for again.
 */
function paintMicroClassIcon(classId: number | undefined): void {
  const origin = game.gatewayOrigin;
  const wanted = origin ? `${origin}/texture?path=${encodeURIComponent(CLASS_ATLAS_PATH)}` : undefined;
  const shown = classId !== undefined && wanted !== undefined && hasClassIcon(classId);
  const current = shown
    ? !characterMicroIcon.hidden && characterMicroIcon.dataset["class"] === String(classId)
      && characterMicroIcon.dataset["atlas"] === wanted
    : characterMicroIcon.hidden;
  if (!current) paintClassIcon(characterMicroIcon, classId, wanted);
}

function setTextIfChanged(element: HTMLElement, text: string): void {
  if (element.textContent !== text) element.textContent = text;
}

/** Widths as written: the style reads a long percentage back rounded, so it cannot be compared. */
const writtenWidths = new WeakMap<HTMLElement, string>();

function setWidthIfChanged(element: HTMLElement, width: string): void {
  if (writtenWidths.get(element) === width && element.style.width !== "") return;
  writtenWidths.set(element, width);
  element.style.width = width;
}

/** Paints the native player frame for the store it was last bound to; see `repaintPlayerHud`. */
let playerHudRepaint: (() => void) | undefined;

export function bindPlayerHud(store: WorldStore): void {
  const paint = (player: WorldObjectState | undefined): void => {
    // The renderer's portrait slot, not the native frame's alone: the stock PlayerFrame draws the
    // same canvas (`adoptPlayerPortraitCanvas`), so the target follows the character either way.
    setPlayerPortrait(player?.guid);
    // Under the stock PlayerFrame `#player-hud` is hidden, and everything below writes into it on
    // every change of the character — each step it takes included — for nobody. The mount's
    // teardown repaints it once the lane is handed back (`repaintPlayerHud`).
    if (nativeHudReplaced(NATIVE_LANES_REPLACED)) {
      paintMicroClassIcon(player ? unit.classId(player) : undefined);
      return;
    }
    if (!player) {
      paintClassPortrait(undefined);
      setTextIfChanged(playerHudDetails, "Ожидание параметров…");
      setWidthIfChanged(playerHealthBar, "0%");
      setTextIfChanged(playerHealthText, "");
      setWidthIfChanged(playerPowerBar, "0%");
      return;
    }
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
    // already looking to see how much of it is left. Written only when they read differently: the
    // same text written on every step replaced the text node and invalidated the frame's style.
    setTextIfChanged(playerHudDetails, `ур. ${level ?? "?"}${powerText}`);
    setWidthIfChanged(playerHealthBar, barWidth(health, maxHealth));
    setTextIfChanged(playerHealthText, health === undefined ? "" : `${health} / ${maxHealth ?? "?"}`);
    setWidthIfChanged(playerPowerBar, barWidth(power, maxPower));
    // Read by the stylesheet, so rage is not drawn in mana's blue.
    const powerKey = String(powerType);
    if (playerPowerBar.dataset["power"] !== powerKey) playerPowerBar.dataset["power"] = powerKey;
    paintClassPortrait(unit.classId(player));

    // Experience towards the next level. The fields have always arrived; nothing showed them.
    const experience = playerFields.experience(player);
    const nextLevel = playerFields.nextLevelExperience(player);
    const noExperience = experience === undefined || !nextLevel;
    if (experienceBar.root.hidden !== noExperience) experienceBar.root.hidden = noExperience;
    if (!noExperience) experienceBar.set(experience, nextLevel, `${experience} / ${nextLevel}`);
  };

  playerHudRepaint = () => {
    const self = store.state.selfGuid;
    paint(self === undefined ? undefined : store.state.objects.get(self));
  };
  store.object(SELF, paint);
}

/**
 * Paint the native player frame from the world as it stands: the stock PlayerFrame has just let
 * its lane go (the FrameXML mount's teardown), and the frame skipped every change while it was
 * hidden. A character standing still at full health changes nothing that would repaint it.
 */
export function repaintPlayerHud(): void {
  playerHudRepaint?.();
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
  // 5.24: a player's pet by the name it was given (CMSG_PET_NAME_QUERY), not its kind.
  const petName = world?.petNameOf?.(object);
  if (petName) return petName;
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

/** Painted target-frame values; when the signature matches, every write below is a no-op. */
let lastTargetSignature: string | undefined;

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
    // The empty frame is painted once: without a target every packet recomputed the same dozen
    // writes below (hidden flags, cleared labels, a zeroed bar) sixty times a second.
    if (lastTargetSignature === "") return;
    lastTargetSignature = "";
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
    const duel = duelButton();
    if (duel) duel.hidden = true;
    clearTargetButton.disabled = true;
    attackButton.textContent = "⚔";
    setTip(attackButton, "Начать атаку");
    return;
  }

  setTargetPortrait(target.guid);

  targetPanel.hidden = false;

  // Slice I2's three markings, on the two frames that were already in the page. The raid mark and
  // the reaction are attributes rather than text so the stylesheet owns how they look, and the
  // threat is the fraction of the highest on this creature — the raw number says nothing without
  // the tank's beside it.
  const marks = raidMarksByUnit(world.raidTargets);
  const targetMark = marks.get(target.guid);
  const targetReaction = reactionTo(target);
  const targetThreat = threatFraction(world.threat.get(target.guid)?.entries ?? [], world.state.selfGuid ?? 0n);
  const selfGuid = world.state.selfGuid;
  const selfMark = selfGuid === undefined ? undefined : marks.get(selfGuid);

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
  const targetNameText = metadata?.name ?? unitDisplayName(target);
  const targetIconUrl = creatureIconSource(metadata, game.gatewayOrigin);
  // Five things were being folded into one line 213px wide, and the line does not hold five.
  //
  // The GUID alone was 22 characters of it — «GUID 0x» and sixteen hex digits — unconditionally,
  // with no `?? ""` guard, so it was the one term data could never drop. It is a debugging fact
  // and not a fact about the creature, so it moves to the title, where hovering still answers it
  // and nothing has to be truncated to make room. The health numbers move onto the bar that was
  // already drawing them as a proportion.
  const targetDetailsText = [
    metadata?.subname ?? "",
    metadata ? creatureTypeName(metadata.type) : "",
    target.typeId === 4 ? className(unit.classId(target)) : "",
    level === undefined ? "" : `ур. ${level}`,
  ].filter(Boolean).join(" · ");
  const targetDetailsTitle = `GUID 0x${target.guid.toString(16).padStart(16, "0")}`;
  const healthWidth = `${health === undefined || !maxHealth ? 0 : Math.max(0, Math.min(100, health / maxHealth * 100))}%`;
  const healthText = health === undefined ? "" : `${health} / ${maxHealth ?? "?"}`;
  // A creature's own resource, read from the slot its power type names rather than from slot one.
  const targetPowerValue = unit.power(target);
  const targetMaxPower = unit.maxPower(target);
  const powerHidden = targetPowerValue === undefined || !targetMaxPower;
  const attackDisabled = target.typeId !== 3 && target.typeId !== 4;
  const npcFlags = target.fields.get(UPDATE_FIELDS.UNIT_NPC_FLAGS.offset) ?? 0;
  const self = world.state.selfGuid === undefined ? undefined : world.state.objects.get(world.state.selfGuid);
  const action = target.typeId === 5 && self?.position ? gameObjectAction(world, target, self.position) : undefined;
  // A lock without a known opener keeps its button, marked: the click explains the missing skill
  // instead of the button vanishing. Marked, never disabled — the loot button's rule.
  const lockHint = target.typeId === 5 && action === undefined && self?.position
    ? gameObjectLockHint(world, target, self.position) : undefined;
  const interactHidden = target.typeId === 5
    ? action === undefined && lockHint === undefined
    : target.typeId !== 3 || (npcFlags & NPC_FLAGS_INTERACTION_MASK) === 0;
  const interactDisabled = lockHint !== undefined;
  const interactLabel = target.typeId !== 5 ? "Поговорить"
    : action?.kind === "unlock" ? "Открыть" : lockHint ?? "Использовать";
  // A corpse only. A game object's loot is never requested — the server refuses the packet for
  // anything that is not a creature, and a chest's loot arrives once a spell has opened it.
  const lootHidden = !(target.typeId === 3 && isWorldObjectDead(target));
  // Marked, never disabled — the same rule the loot slots follow (`Npc.ts:109-117`). The bit is
  // the server's answer to «is there a sparkle on this body for you», and the server's answer to
  // «may I open it» is a stricter predicate the client cannot evaluate: `Player::SendLoot`
  // (`Player.cpp:8898-8902`) reads the raw flag, while the copy the client was sent has already
  // been through `isAllowedToLoot` per viewer and lags a round-robin handover by a packet
  // (`LootHandler.cpp:430` is the only forced resend, and only in one branch). So the mark says
  // what is known and the click still goes out; if the server disagrees it says so in words.
  const lootable = isLootable(target);
  // The accessible name is written here as well as the tooltip, for the reason the attack button
  // below already carries: the static `aria-label` in the markup wins over `title`, so a screen
  // reader would go on saying «Обыскать» over a body that has nothing on it.
  const lootLabel = lootable ? "Обыскать" : "Здесь нечего обыскивать";
  // WotLK vendors may advertise a title-specific bit (ammo/food/poison/reagent) without 0x80.
  const vendorHidden = target.typeId !== 3 || (npcFlags & NPC_FLAGS_VENDOR_MASK) === 0;
  const trainerHidden = target.typeId !== 3 || (npcFlags & 0x70) === 0;
  // UNIT_NPC_FLAG_BANKER is 0x20000. The vault itself is already in the player's update fields;
  // this is the only thing that grants permission to move anything in it.
  const bankerHidden = target.typeId !== 3 || (npcFlags & 0x20000) === 0;
  // A duel is challenged with the Duel spell at the selected player; the server validates
  // range, zone and state. Built lazily in code so no Dom.ts ids are needed.
  const duelHidden = target.typeId !== 4 || target.guid === world.state.selfGuid;
  // The state has to be in the accessible name too: a static `aria-label` in the markup overrides
  // the title, so a screen reader was told "autoattack" whether it was running or not.
  const attackLabel = world.attacking || world.attackRequested ? "Остановить атаку" : "Начать атаку";

  // One string for the whole painted frame: while the target stands still, every packet used to
  // recompute the forty writes below with identical values. The power bar below stays outside
  // the gate — it caches internally and must keep its own counsel.
  const signature = [
    target.guid.toString(), targetNameText, targetIconUrl, targetDetailsText, targetDetailsTitle,
    healthWidth, healthText, powerHidden, attackDisabled, npcFlags,
    interactHidden, interactDisabled, interactLabel, lootHidden, lootable, lootLabel,
    vendorHidden, trainerHidden, bankerHidden, duelHidden, attackLabel,
    targetMark ?? "", targetReaction ?? "", targetThreat ?? "", selfMark ?? "",
  ].join("");
  if (signature === lastTargetSignature) {
    targetPowerBar.set(targetPowerValue, targetMaxPower);
    targetPowerBar.setVariant(String(unit.powerType(target) ?? POWER.mana));
    return;
  }
  lastTargetSignature = signature;
  writeUnitMarkings(targetPanel, targetMark, targetReaction, targetThreat);
  writeUnitMarkings(playerHud, selfMark, undefined, undefined);
  targetName.textContent = targetNameText;
  targetIcon.hidden = false;
  setIconSource(targetIcon, targetIconUrl);
  targetIcon.onerror = () => {
    targetIcon.onerror = null;
    // The question mark, which is a spell icon like any other: a family whose picture is not in
    // this dataset falls back to the same route rather than to a file beside the page.
    setIconSource(targetIcon, spellIconUrl(2273, game.gatewayOrigin) ?? "");
  };
  targetDetails.textContent = targetDetailsText;
  setTip(targetDetails, targetDetailsTitle);
  targetHealthBar.style.width = healthWidth;
  targetHealthText.textContent = healthText;
  targetPowerBar.root.hidden = powerHidden;
  targetPowerBar.set(targetPowerValue, targetMaxPower);
  targetPowerBar.setVariant(String(unit.powerType(target) ?? POWER.mana));
  attackButton.disabled = attackDisabled;
  interactButton.hidden = interactHidden;
  if (interactDisabled) interactButton.setAttribute("aria-disabled", "true");
  else interactButton.removeAttribute("aria-disabled");
  setTip(interactButton, interactLabel);
  interactButton.setAttribute("aria-label", interactLabel);
  lootButton.hidden = lootHidden;
  if (lootable) lootButton.removeAttribute("aria-disabled");
  else lootButton.setAttribute("aria-disabled", "true");
  setTip(lootButton, lootLabel);
  lootButton.setAttribute("aria-label", lootLabel);
  vendorButton.hidden = vendorHidden;
  trainerButton.hidden = trainerHidden;
  bankerButton.hidden = bankerHidden;
  const duel = duelButton();
  if (duel) duel.hidden = duelHidden;
  clearTargetButton.disabled = false;
  attackButton.textContent = "⚔";
  setTip(attackButton, attackLabel);
  attackButton.setAttribute("aria-label", attackLabel);
}
