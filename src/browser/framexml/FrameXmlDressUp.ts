/**
 * Stock DressUpFrame («Примерочная»): the DressUpModel methods it calls, IsDressableItem, the gate.
 * The model stage that draws the dressed character is FrameXmlDressUpStage.ts; the live host that
 * answers the player's look and the item rows is FrameXmlDressUpLive.ts; the world mount's one call
 * is FrameXmlDressUpMount.ts.
 *
 * DressUpFrame.xml loads at its retail slot after WorldStateFrame.xml (stock TOC line 123); the frame
 * is `parent="UIParent" hidden="true"` and a `left` UI panel (UIParent.lua:45). Its only way in is
 * DressUpItemLink (DressUpFrame.lua:2-11), reached from HandleModifiedItemClick's DRESSUP branch
 * (ItemButtonTemplate.lua:113-116: every bag, bank, paper-doll, merchant, loot and chat item link):
 *
 *   if not IsDressableItem(link) then return end
 *   if not DressUpFrame:IsShown() then ShowUIPanel(DressUpFrame); DressUpModel:SetUnit("player") end
 *   DressUpModel:TryOn(link)
 *
 * and its buttons: «Сброс» is `DressUpModel:Dress()` (DressUpFrame.xml:179-182), «Закрыть» is
 * HideParentPanel, the two arrows are Model_RotateLeft/Right → `SetRotation` (UIParent.lua:2829-2845).
 * Blizzard_AuctionUI's Blizzard_AuctionDressUp.lua:2-17 wraps DressUpItemLink: while AuctionFrame is
 * shown the same three calls go to the side AuctionDressUpFrame/AuctionDressUpModel, otherwise to the
 * original. That wrapper captures the original at its load, so DressUpFrame.lua must be in the boot
 * vertical before the auction add-on loads; it is (FrameXmlCorpus.ts), and the auction preload
 * (FrameXmlAuctionOwner.ts installFrameXmlAuctionPreload) then finds DressUpTexturePath defined.
 *
 * The widget methods are the 3.3.5 DressUpModel API — `Dress`, `Undress`, `TryOn` — plus PlayerModel's
 * `SetUnit` and `SetRotation`, installed on the DressUpModel widget type's method table so every
 * DressUpModel (DressUpModel, AuctionDressUpModel once its add-on loads) has them. The state they keep
 * is host-side (FrameXmlDressUpModels): which unit the model shows, whether it was undressed, and the
 * items tried on since, in order. Unknown stays unknown: an item whose row has not arrived is not
 * dressable yet and a tried-on item without its row is not drawn until it arrives.
 */
import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import type { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";
import { frameXmlItemEntry } from "./FrameXmlWorldSeam.js";
import { frameXmlSilentProbe } from "./FrameXmlGameMenuOwner.js";
import { FRAMEXML_HOST_HOOK_GLOBAL, withFrameXmlHostHooks } from "./FrameXmlHostHooks.js"; // L5b 3.27
import {
  frameXmlNpcClean, frameXmlNpcFrames, frameXmlNpcRendered, type FrameXmlNpcFrameSpec,
} from "./FrameXmlGossipGateKit.js";

/** One worn piece in the spelling `/dbc/character-appearance` takes (CreatureModelClient.EquippedItem). */
export interface FrameXmlDressUpWorn {
  /** EQUIPMENT_SLOT_* (0-18). */
  readonly slot: number;
  readonly inventoryType: number;
  readonly displayId: number;
  readonly subClass?: number;
}

/** The item row a try-on needs: Item.dbc's InventoryType and DisplayInfoID (ItemMetadata.ts). */
export interface FrameXmlDressUpItem {
  readonly inventoryType: number;
  readonly displayId: number;
  readonly subClass?: number | undefined;
}

/** A unit's own look: its native display and the appearance bytes the server publishes. */
export interface FrameXmlDressUpLook {
  /** UNIT_FIELD_NATIVEDISPLAYID: the body the clothes go on, not a shapeshift's display. */
  readonly displayId: number;
  readonly race: number;
  readonly sex: number;
  readonly skin: number;
  readonly face: number;
  readonly hairStyle: number;
  readonly hairColor: number;
  readonly facialHair: number;
  /** 05.10-A7a-G 6.18: UNIT_FIELD_BYTES_0 byte 1, sent as `class=` (the death knight's eye glow, 6.10). */
  readonly classId?: number | undefined;
  /** What the unit is visibly wearing now (PLAYER_VISIBLE_ITEM_*), rows that have arrived only. */
  readonly equipment: readonly FrameXmlDressUpWorn[];
}

/** What the dress-up models read from the world. Both answers may be undefined (not known yet). */
export interface FrameXmlDressUpHost {
  /** `SetUnit(unit)`'s look; undefined for a unit the host cannot resolve. */
  look(unit: string): FrameXmlDressUpLook | undefined;
  /** The item row for an entry; undefined until it arrives (the host asks for it). */
  item(entry: number): FrameXmlDressUpItem | undefined;
}

/**
 * INVTYPE_* → the EQUIPMENT_SLOT_* a try-on puts it in: the first slot of TrinityCore's
 * Player::FindEquipSlot (Player.cpp:9784-9900), restricted to the slots a character model shows —
 * the body layers and geosets of the gateway's SLOT_APPEARANCE (shirt, chest, waist, legs, feet,
 * wrists, hands, back, tabard, robe; gateway/CharacterAppearance.ts:353-374) and the slots that hang
 * a model (head, shoulders, both hands, ranged; SLOT_MODEL_DIRECTORY, :457-463). Neck, finger,
 * trinket, bag, ammo, quiver and relic have no appearance and are not dressable.
 */
export const FRAMEXML_DRESSUP_SLOT_BY_INVENTORY_TYPE: Readonly<Record<number, number>> = Object.freeze({
  1: 0, // INVTYPE_HEAD → EQUIPMENT_SLOT_HEAD
  3: 2, // INVTYPE_SHOULDERS → EQUIPMENT_SLOT_SHOULDERS
  4: 3, // INVTYPE_BODY → EQUIPMENT_SLOT_BODY
  5: 4, // INVTYPE_CHEST → EQUIPMENT_SLOT_CHEST
  6: 5, // INVTYPE_WAIST
  7: 6, // INVTYPE_LEGS
  8: 7, // INVTYPE_FEET
  9: 8, // INVTYPE_WRISTS
  10: 9, // INVTYPE_HANDS
  13: 15, // INVTYPE_WEAPON → EQUIPMENT_SLOT_MAINHAND (FindEquipSlot's first choice)
  14: 16, // INVTYPE_SHIELD → EQUIPMENT_SLOT_OFFHAND
  15: 17, // INVTYPE_RANGED → EQUIPMENT_SLOT_RANGED
  16: 14, // INVTYPE_CLOAK → EQUIPMENT_SLOT_BACK
  17: 15, // INVTYPE_2HWEAPON → EQUIPMENT_SLOT_MAINHAND
  19: 18, // INVTYPE_TABARD
  20: 4, // INVTYPE_ROBE → EQUIPMENT_SLOT_CHEST
  21: 15, // INVTYPE_WEAPONMAINHAND
  22: 16, // INVTYPE_WEAPONOFFHAND
  23: 16, // INVTYPE_HOLDABLE
  25: 17, // INVTYPE_THROWN
  26: 17, // INVTYPE_RANGEDRIGHT
});

const INVTYPE_2HWEAPON = 17;
const EQUIPMENT_SLOT_MAINHAND = 15;
const EQUIPMENT_SLOT_OFFHAND = 16;
/** Tried-on entries kept per model; the nineteen slots are all a model can show at once. */
const TRY_ON_LIMIT = 64;

/** The slot a try-on of this row fills, or undefined when the row has nothing to show. */
export function frameXmlDressUpSlot(item: FrameXmlDressUpItem | undefined): number | undefined {
  if (!item || !Number.isInteger(item.displayId) || item.displayId <= 0) return undefined;
  return FRAMEXML_DRESSUP_SLOT_BY_INVENTORY_TYPE[item.inventoryType];
}

/**
 * Put one row on an outfit. A two-hander empties the off hand, and an off-hand piece takes a
 * two-hander out of the main hand: the equip rule (Player::FindEquipSlot/AutoUnequipOffhandIfNeed,
 * Player.cpp:9855-9877) applied to the preview; how the real DressUpModel resolves it is not measured.
 */
function wear(worn: Map<number, FrameXmlDressUpWorn>, item: FrameXmlDressUpItem): void {
  const slot = frameXmlDressUpSlot(item);
  if (slot === undefined) return;
  if (item.inventoryType === INVTYPE_2HWEAPON) worn.delete(EQUIPMENT_SLOT_OFFHAND);
  if (slot === EQUIPMENT_SLOT_OFFHAND && worn.get(EQUIPMENT_SLOT_MAINHAND)?.inventoryType === INVTYPE_2HWEAPON) {
    worn.delete(EQUIPMENT_SLOT_MAINHAND);
  }
  worn.set(slot, {
    slot, inventoryType: item.inventoryType, displayId: item.displayId,
    ...(item.subClass === undefined ? {} : { subClass: item.subClass }),
  });
}

interface DressUpState {
  unit: string;
  /** `Undress()` since the last `SetUnit`/`Dress`: the unit's own equipment is off. */
  naked: boolean;
  /** `TryOn` entries in call order; a later one in the same slot wins. */
  tries: number[];
}

/** One dress-up model's picture: whose body, and what it wears. */
export interface FrameXmlDressUpOutfit {
  readonly unit: string;
  readonly look: FrameXmlDressUpLook;
  /** Sorted by slot, at most one per slot. */
  readonly equipment: readonly FrameXmlDressUpWorn[];
  /** A tried-on entry whose row has not arrived is not in `equipment` yet. */
  readonly pending: boolean;
}

/** The host-side half of every DressUpModel's `SetUnit`/`Dress`/`Undress`/`TryOn`. */
export class FrameXmlDressUpModels {
  readonly #host: FrameXmlDressUpHost;
  readonly #states = new Map<FrameXmlFrame, DressUpState>();
  #revision = 0;

  constructor(host: FrameXmlDressUpHost) {
    this.#host = host;
  }

  /** Bumped by every call that changes what a model shows. */
  get revision(): number { return this.#revision; }

  /** The models that show a unit (the stage's `models()`). */
  frames(): IterableIterator<FrameXmlFrame> { return this.#states.keys(); }

  has(frame: FrameXmlFrame): boolean { return this.#states.has(frame); }

  /** PlayerModel:SetUnit(unit): the unit as it is dressed now; earlier try-ons are gone. */
  setUnit(frame: FrameXmlFrame, unit: unknown): void {
    if (typeof unit !== "string" || unit === "") { this.clear(frame); return; }
    this.#states.set(frame, { unit: unit.toLowerCase(), naked: false, tries: [] });
    this.#revision += 1;
  }

  /** DressUpModel:Dress(): back to the unit's own equipment (DressUpFrameResetButton). */
  dress(frame: FrameXmlFrame): void {
    const state = this.#states.get(frame);
    if (!state) return;
    state.naked = false;
    state.tries = [];
    this.#revision += 1;
  }

  /** DressUpModel:Undress(): everything off, try-ons included. */
  undress(frame: FrameXmlFrame): void {
    const state = this.#states.get(frame);
    if (!state) return;
    state.naked = true;
    state.tries = [];
    this.#revision += 1;
  }

  /**
   * DressUpModel:TryOn(item): an item link, item string or id. Kept by entry, so a row that has
   * not arrived yet is worn as soon as it does. Answers whether an entry was recorded.
   */
  tryOn(frame: FrameXmlFrame, item: unknown): boolean {
    const state = this.#states.get(frame);
    const entry = frameXmlItemEntry(item);
    if (!state || entry === undefined) return false;
    const tries = state.tries.filter((value) => value !== entry);
    tries.push(entry);
    if (tries.length > TRY_ON_LIMIT) tries.splice(0, tries.length - TRY_ON_LIMIT);
    state.tries = tries;
    // Ask for the row now rather than on the first drawn frame.
    this.#host.item(entry);
    this.#revision += 1;
    return true;
  }

  /** SetModel/SetCreature/SetDisplayInfo/ClearModel: the model no longer shows a unit. */
  clear(frame: FrameXmlFrame): void {
    if (this.#states.delete(frame)) this.#revision += 1;
  }

  /**
   * IsDressableItem(item): 1 when the item's row is known and it has a visible slot and a display;
   * false when its row says it has none; undefined while the row is unknown (the host asks for it).
   */
  isDressable(item: unknown): boolean | undefined {
    const entry = frameXmlItemEntry(item);
    if (entry === undefined) return false;
    const row = this.#host.item(entry);
    if (!row) return undefined;
    return frameXmlDressUpSlot(row) !== undefined;
  }

  /** What `frame` shows now, or undefined when it shows no unit or the unit is unknown. */
  outfit(frame: FrameXmlFrame): FrameXmlDressUpOutfit | undefined {
    const state = this.#states.get(frame);
    if (!state) return undefined;
    const look = this.#host.look(state.unit);
    if (!look || !(look.displayId > 0)) return undefined;
    const worn = new Map<number, FrameXmlDressUpWorn>();
    if (!state.naked) for (const item of look.equipment) worn.set(item.slot, item);
    let pending = false;
    for (const entry of state.tries) {
      const row = this.#host.item(entry);
      if (!row) { pending = true; continue; }
      wear(worn, row);
    }
    const equipment = [...worn.values()].sort((a, b) => a.slot - b.slot);
    return { unit: state.unit, look, equipment, pending };
  }

  dispose(): void {
    this.#states.clear();
    this.#revision += 1;
  }
}

/** Named stock frames DressUpFrame.xml declares that the owner relies on, with their scripts. */
const DRESSUP_FRAMES: readonly FrameXmlNpcFrameSpec[] = [
  ["DressUpFrame", "Frame", ["OnLoad", "OnShow", "OnHide"]],
  ["DressUpModel", "DressUpModel", ["OnLoad", "OnUpdate"]],
  ["DressUpFramePortrait", "Texture", []],
  ["DressUpFrameTitleText", "FontString", []],
  ["DressUpFrameDescriptionText", "FontString", []],
  ["DressUpBackgroundTopLeft", "Texture", []],
  ["DressUpBackgroundTopRight", "Texture", []],
  ["DressUpBackgroundBotLeft", "Texture", []],
  ["DressUpBackgroundBotRight", "Texture", []],
  ["DressUpFrameCloseButton", "Button", ["OnClick"]],
  ["DressUpFrameCancelButton", "Button", ["OnClick"]],
  ["DressUpFrameResetButton", "Button", ["OnClick"]],
  ["DressUpModelRotateLeftButton", "Button", ["OnClick"]],
  ["DressUpModelRotateRightButton", "Button", ["OnClick"]],
];

/** The hidden host names the Lua methods call; never read by stock. */
const BINDING = {
  setUnit: "__fxDressUpSetUnit",
  dress: "__fxDressUpDress",
  undress: "__fxDressUpUndress",
  tryOn: "__fxDressUpTryOn",
  clear: "__fxDressUpClear",
  wake: "__fxDressUpWake",
} as const;

/**
 * The DressUpModel type's methods, set once on the widget type's shared method table (its
 * metatable's `__index`), so they shadow the widget layer's recorded no-ops for every DressUpModel.
 *
 * `SetRotation(radians)` (PlayerModel, Model_OnLoad/Model_RotateLeft/Right, UIParent.lua:2824-2845)
 * turns the model about its vertical axis, which is what the model stage's `facing` is; the widget
 * layer only records it, so here it is the model's `SetFacing`. Model_OnLoad already ran for
 * DressUpModel at boot (rotation 0.61), so that rotation is applied once on install.
 * SetModel/SetCreature/SetDisplayInfo/ClearModel still do what they did and also end the unit view.
 */
const DRESSUP_MODEL_METHODS = `
local model = rawget(_G, "DressUpModel")
if type(model) ~= "table" then return 0 end
local meta = getmetatable(model)
local methods = type(meta) == "table" and rawget(meta, "__index")
if type(methods) ~= "table" then return 0 end
local setUnit, dress, undress = rawget(_G, "${BINDING.setUnit}"), rawget(_G, "${BINDING.dress}"), rawget(_G, "${BINDING.undress}")
local tryOn, clear, wake = rawget(_G, "${BINDING.tryOn}"), rawget(_G, "${BINDING.clear}"), rawget(_G, "${BINDING.wake}")
if not (setUnit and dress and undress and tryOn and clear and wake) then return 0 end
if not rawget(methods, "__webclientDressUp") then
  rawset(methods, "__webclientDressUp", true)
  methods.SetUnit = function(self, unit) setUnit(self, unit) end
  methods.Dress = function(self) dress(self) end
  methods.Undress = function(self) undress(self) end
  methods.TryOn = function(self, item) tryOn(self, item) end
  methods.SetRotation = function(self, rotation)
    if type(rotation) == "number" then self:SetFacing(rotation) end
  end
  for _, name in ipairs({ "SetModel", "SetCreature", "SetDisplayInfo", "ClearModel" }) do
    local base = rawget(methods, name)
    if type(base) == "function" then
      methods[name] = function(self, ...) clear(self); return base(self, ...) end
    end
  end
end
if type(model.rotation) == "number" then model:SetRotation(model.rotation) end
${FRAMEXML_HOST_HOOK_GLOBAL}(DressUpFrame, "OnShow", function() wake() end) -- L5b 3.27 (was DressUpFrame:HookScript)
return 1
`;

/**
 * Structural proof that stock DressUpFrame can be the dressing room: every named frame of the
 * stock tree with its scripts, the root hidden under UIParent and rendered, SetDressUpBackground's
 * four race textures set at OnLoad, DressUpItemLink and the UIPanelWindows entry defined.
 * No show: the first open is the user's own (its OnShow claims the player portrait and plays).
 */
export function frameXmlDressUpGate(
  boot: Pick<FrameXmlBoot, "vm" | "bridge" | "errorCount">,
  renderer: Pick<FrameXmlDomRenderer, "elementFor">,
): FrameXmlFrame | undefined {
  try {
    const frames = frameXmlNpcFrames(boot, DRESSUP_FRAMES);
    const frame = frames?.get("DressUpFrame");
    if (!frames || !frame || !frameXmlNpcRendered(renderer, frame)) return undefined;
    const model = frames.get("DressUpModel");
    if (!model || !frameXmlNpcRendered(renderer, model)) return undefined;
    const probe = frameXmlNpcClean(boot, () => frameXmlSilentProbe(boot, "webclient/dressup-gate", `
      local path = type(DressUpTexturePath) == "function" and DressUpTexturePath() or ""
      local set = 1
      for index, name in ipairs({ "DressUpBackgroundTopLeft", "DressUpBackgroundTopRight", "DressUpBackgroundBotLeft", "DressUpBackgroundBotRight" }) do
        local texture = _G[name]:GetTexture()
        if type(texture) ~= "string" or texture:lower() ~= (path .. index):lower() then set = 0 end
      end
      local routed = (type(DressUpItemLink) == "function" and type(SetDressUpBackground) == "function"
        and type(UIPanelWindows) == "table" and type(UIPanelWindows["DressUpFrame"]) == "table") and 1 or 0
      return path ~= "" and set or 0, routed
    `, 2));
    if (!probe) return undefined;
    const [background, routed] = probe.map((value) => Number(value));
    return background === 1 && routed === 1 && !frame.visible ? frame : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Bind the DressUpModel methods and IsDressableItem to `models`. `onChange` runs after every call
 * that changes a model's picture and on DressUpFrame's OnShow (the stage wakes on it). False when
 * the stock tree is not there to bind to; nothing is left half-installed in that case except the
 * hidden `__fxDressUp*` names, which stock never reads.
 */
export function installFrameXmlDressUp(
  boot: Pick<FrameXmlBoot, "vm" | "bridge">,
  models: FrameXmlDressUpModels,
  onChange: () => void,
): boolean {
  const frameArg = (value: unknown): FrameXmlFrame | undefined =>
    value && typeof value === "object" ? boot.bridge.resolve(value as FrameXmlFrame) : undefined;
  const command = (run: (frame: FrameXmlFrame, args: readonly unknown[]) => void) => (args: readonly unknown[]): unknown[] => {
    const frame = frameArg(args[0]);
    if (frame?.type === "DressUpModel") { run(frame, args.slice(1)); onChange(); }
    return [];
  };
  boot.vm.registerGlobal(BINDING.setUnit, command((frame, args) => models.setUnit(frame, args[0])));
  boot.vm.registerGlobal(BINDING.dress, command((frame) => models.dress(frame)));
  boot.vm.registerGlobal(BINDING.undress, command((frame) => models.undress(frame)));
  boot.vm.registerGlobal(BINDING.tryOn, command((frame, args) => { models.tryOn(frame, args[0]); }));
  boot.vm.registerGlobal(BINDING.clear, command((frame) => models.clear(frame)));
  boot.vm.registerGlobal(BINDING.wake, () => { onChange(); return []; });
  // L5b 3.27: DressUpFrame's wake is a host hook (FrameXmlHostHooks.ts): an add-on's SetScript keeps it.
  const installed = withFrameXmlHostHooks(boot, () => frameXmlSilentProbe(boot, "@webclient/dressup-model", DRESSUP_MODEL_METHODS, 1));
  if (Number(installed?.[0]) !== 1) return false;
  // Stock calls it as a flag: `if ( not link or not IsDressableItem(link) )` (DressUpFrame.lua:3).
  boot.vm.registerGlobal("IsDressableItem", (args) => models.isDressable(args[0]) === true ? [1] : []);
  return true;
}
