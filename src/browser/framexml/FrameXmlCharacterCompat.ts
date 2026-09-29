/**
 * CharacterFrame.lua publishes these names in CHARACTERFRAME_SUBFRAMES and uses the fixed stock
 * tab IDs below. Keep missing globals as plain, hidden Lua objects until their real XML roots are
 * promoted into the corpus; they are deliberately not bridge widgets, so this compatibility floor
 * cannot change the measured widget corpus. The list is intentionally not positional: Skill is tab
 * 4 and Reputation is tab 3, so filtering an optional pane must never renumber placeholders.
 *
 * PetPaperDollFrame.xml is in the vertical (FrameXmlCorpus.ts), so its entry stands only for a
 * narrower subset without it: the boot filters the promoted roots out (FrameXmlBoot.ts), and with
 * the real page loaded stock PetPaperDollFrame_UpdateIsAvailable owns tab 2 (FrameXmlCompanions.ts).
 *
 * TokenFrame is never a FrameXML file in 3.3.5a: it is the load-on-demand Blizzard_TokenUI. Its
 * placeholder stands until FrameXmlTokenOwner.ts loads that add-on, whose `<Frame name="TokenFrame"
 * parent="CharacterFrame" id="5">` then takes the global, and stock TokenFrame_Update shows tab 5.
 */
export const FRAMEXML_CHARACTER_OPTIONAL_SUBFRAMES = Object.freeze([
  Object.freeze({ name: "PetPaperDollFrame", id: 2 }),
  Object.freeze({ name: "ReputationFrame", id: 3 }),
  Object.freeze({ name: "SkillFrame", id: 4 }),
  Object.freeze({ name: "TokenFrame", id: 5 }),
] as const);

/**
 * The stock inventory-slot lookup is a C API rather than part of PaperDollFrame.lua. Answer its
 * structural 3.3.5 values here so the nineteen inherited equipment buttons (and the separate ammo
 * button) receive their IDs during XML OnLoad. The function is installed through the neutral
 * implementation table, preserving the normal first-touch/API census and allowing a later world
 * seam to replace the answer without loading a second PaperDoll implementation.
 */
export const FRAMEXML_CHARACTER_COMPAT_PRELUDE = `
do
  local rawget, rawset = rawget, rawset
  local impl = rawget(_G, "__fxNeutralImpl") or {}
  local optional = rawget(_G, "__fxCharacterOptionalSubframes") or {}

  local function inertSubFrame(id)
    return {
      hidden = true,
      GetID = function() return id end,
      Show = function() end,
      Hide = function() end,
      IsShown = function() return false end,
      IsVisible = function() return false end,
    }
  end

  for index = 1, #optional do
    local row = optional[index]
    local name, id = row[1], row[2]
    if name and rawget(_G, name) == nil then
      rawset(_G, name, inertSubFrame(id))
    end
  end

  -- PaperDollFrame.lua calls this for each stock item-slot button, and the stock bag buttons reuse
  -- the same handler for Bag0Slot..Bag3Slot. The bag-only compat prelude carries the same four
  -- structural values when PaperDollFrame.lua is absent; FrameXmlBoot never installs both
  -- preludes, so the handler implementation is not duplicated.
  if rawget(_G, "GetInventorySlotInfo") == nil then
    local inventorySlots = {
      HeadSlot = { 1, "Interface\\\\Paperdoll\\\\UI-PaperDoll-Slot-Head" },
      NeckSlot = { 2, "Interface\\\\Paperdoll\\\\UI-PaperDoll-Slot-Neck" },
      ShoulderSlot = { 3, "Interface\\\\Paperdoll\\\\UI-PaperDoll-Slot-Shoulder" },
      ShirtSlot = { 4, "Interface\\\\Paperdoll\\\\UI-PaperDoll-Slot-Shirt" },
      ChestSlot = { 5, "Interface\\\\Paperdoll\\\\UI-PaperDoll-Slot-Chest" },
      WaistSlot = { 6, "Interface\\\\Paperdoll\\\\UI-PaperDoll-Slot-Waist" },
      LegsSlot = { 7, "Interface\\\\Paperdoll\\\\UI-PaperDoll-Slot-Legs" },
      FeetSlot = { 8, "Interface\\\\Paperdoll\\\\UI-PaperDoll-Slot-Feet" },
      WristSlot = { 9, "Interface\\\\Paperdoll\\\\UI-PaperDoll-Slot-Wrists" },
      HandsSlot = { 10, "Interface\\\\Paperdoll\\\\UI-PaperDoll-Slot-Hands" },
      Finger0Slot = { 11, "Interface\\\\Paperdoll\\\\UI-PaperDoll-Slot-Finger" },
      Finger1Slot = { 12, "Interface\\\\Paperdoll\\\\UI-PaperDoll-Slot-Finger" },
      Trinket0Slot = { 13, "Interface\\\\Paperdoll\\\\UI-PaperDoll-Slot-Trinket" },
      Trinket1Slot = { 14, "Interface\\\\Paperdoll\\\\UI-PaperDoll-Slot-Trinket" },
      BackSlot = { 15, "Interface\\\\Paperdoll\\\\UI-PaperDoll-Slot-Rear" },
      MainHandSlot = { 16, "Interface\\\\Paperdoll\\\\UI-PaperDoll-Slot-MainHand" },
      SecondaryHandSlot = { 17, "Interface\\\\Paperdoll\\\\UI-PaperDoll-Slot-SecondaryHand" },
      RangedSlot = { 18, "Interface\\\\Paperdoll\\\\UI-PaperDoll-Slot-Ranged" },
      TabardSlot = { 19, "Interface\\\\Paperdoll\\\\UI-PaperDoll-Slot-Tabard" },
      AmmoSlot = { 0, "Interface\\\\Paperdoll\\\\UI-PaperDoll-Slot-Ammo" },
      Bag0Slot = { 20, "Interface\\\\Paperdoll\\\\UI-PaperDoll-Slot-Bag" },
      Bag1Slot = { 21, "Interface\\\\Paperdoll\\\\UI-PaperDoll-Slot-Bag" },
      Bag2Slot = { 22, "Interface\\\\Paperdoll\\\\UI-PaperDoll-Slot-Bag" },
      Bag3Slot = { 23, "Interface\\\\Paperdoll\\\\UI-PaperDoll-Slot-Bag" },
    }
    impl.GetInventorySlotInfo = function(slotName)
      local slot = inventorySlots[slotName]
      if slot == nil and type(slotName) == "string" then
        local wanted = string.lower(slotName)
        for name, candidate in pairs(inventorySlots) do
          if string.lower(name) == wanted then slot = candidate break end
        end
      end
      if slot == nil then return end
      return slot[1], slot[2], slot[3]
    end
  end
end
`;
