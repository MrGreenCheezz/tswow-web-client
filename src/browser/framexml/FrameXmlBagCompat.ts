/**
 * The small part of PaperDollFrame.lua that MainMenuBarBagButtons.xml imports indirectly.
 *
 * The stock bag XML uses PaperDollItemSlotButton_OnLoad/Update, but the bounded bag vertical does
 * not load the 2,000-line PaperDollFrame.lua. Keep this prelude deliberately narrow: it supplies
 * the four carried-bag inventory slots and the slot-button lifecycle only. It is installed only
 * for a bag-only corpus (FrameXmlBoot excludes it when the real PaperDollFrame.lua is present).
 */
export const FRAMEXML_BAG_COMPAT_PRELUDE = `
do
  local rawget, rawset = rawget, rawset
  local impl = rawget(_G, "__fxNeutralImpl")
  local itemSlotButtons = {}
  local VERTICAL_FLYOUTS = { [16] = true, [17] = true, [18] = true }

  -- This is the stock 3.3.5a GetInventorySlotInfo result for the four carried bags.
  local inventorySlots = {
    Bag0Slot = { 20, "Interface\\\\Paperdoll\\\\UI-PaperDoll-Slot-Bag" },
    Bag1Slot = { 21, "Interface\\\\Paperdoll\\\\UI-PaperDoll-Slot-Bag" },
    Bag2Slot = { 22, "Interface\\\\Paperdoll\\\\UI-PaperDoll-Slot-Bag" },
    Bag3Slot = { 23, "Interface\\\\Paperdoll\\\\UI-PaperDoll-Slot-Bag" },
  }

  if rawget(_G, "GetInventorySlotInfo") == nil then
    rawset(_G, "GetInventorySlotInfo", function(slotName)
      local slot = inventorySlots[slotName]
      if slot == nil then return end
      return slot[1], slot[2]
    end)
  end

  if rawget(_G, "PaperDollItemSlotButton_OnLoad") == nil then
    impl.PaperDollItemSlotButton_OnLoad = function(self)
      self:RegisterForDrag("LeftButton")
      self:RegisterForClicks("LeftButtonUp", "RightButtonUp")
      local slotName = self:GetName()
      local id, textureName, checkRelic = GetInventorySlotInfo(strsub(slotName, 10))
      self:SetID(id)
      local texture = _G[slotName.."IconTexture"]
      texture:SetTexture(textureName)
      self.backgroundTextureName = textureName
      self.checkRelic = checkRelic
      self.UpdateTooltip = PaperDollItemSlotButton_OnEnter
      itemSlotButtons[id] = self
      self.verticalFlyout = VERTICAL_FLYOUTS[id]

      local popoutButton = self.popoutButton
      if popoutButton then
        if self.verticalFlyout then
          popoutButton:SetHeight(16)
          popoutButton:SetWidth(38)
          popoutButton:GetNormalTexture():SetTexCoord(0.15625, 0.84375, 0.5, 0)
          popoutButton:GetHighlightTexture():SetTexCoord(0.15625, 0.84375, 1, 0.5)
          popoutButton:ClearAllPoints()
          popoutButton:SetPoint("TOP", self, "BOTTOM", 0, 4)
        else
          popoutButton:SetHeight(38)
          popoutButton:SetWidth(16)
          popoutButton:GetNormalTexture():SetTexCoord(
            0.15625, 0.5, 0.84375, 0.5, 0.15625, 0, 0.84375, 0)
          popoutButton:GetHighlightTexture():SetTexCoord(
            0.15625, 1, 0.84375, 1, 0.15625, 0.5, 0.84375, 0.5)
          popoutButton:ClearAllPoints()
          popoutButton:SetPoint("LEFT", self, "RIGHT", -8, 0)
        end
      end
    end
  end

  if rawget(_G, "PaperDollItemSlotButton_OnShow") == nil then
    impl.PaperDollItemSlotButton_OnShow = function(self)
      self:RegisterEvent("UNIT_INVENTORY_CHANGED")
      self:RegisterEvent("MERCHANT_UPDATE")
      self:RegisterEvent("PLAYERBANKSLOTS_CHANGED")
      self:RegisterEvent("ITEM_LOCK_CHANGED")
      self:RegisterEvent("CURSOR_UPDATE")
      self:RegisterEvent("BAG_UPDATE_COOLDOWN")
      self:RegisterEvent("SHOW_COMPARE_TOOLTIP")
      self:RegisterEvent("UPDATE_INVENTORY_ALERTS")
      PaperDollItemSlotButton_Update(self)
    end
  end

  if rawget(_G, "PaperDollItemSlotButton_OnHide") == nil then
    impl.PaperDollItemSlotButton_OnHide = function(self)
      self:UnregisterEvent("UNIT_INVENTORY_CHANGED")
      self:UnregisterEvent("MERCHANT_UPDATE")
      self:UnregisterEvent("PLAYERBANKSLOTS_CHANGED")
      self:UnregisterEvent("ITEM_LOCK_CHANGED")
      self:UnregisterEvent("CURSOR_UPDATE")
      self:UnregisterEvent("BAG_UPDATE_COOLDOWN")
      self:UnregisterEvent("SHOW_COMPARE_TOOLTIP")
      self:UnregisterEvent("UPDATE_INVENTORY_ALERTS")
    end
  end

  if rawget(_G, "PaperDollItemSlotButton_Update") == nil then
    impl.PaperDollItemSlotButton_Update = function(self)
      local textureName = GetInventoryItemTexture("player", self:GetID())
      local cooldown = _G[self:GetName().."Cooldown"]
      if textureName then
        SetItemButtonTexture(self, textureName)
        SetItemButtonCount(self, GetInventoryItemCount("player", self:GetID()))
        if GetInventoryItemBroken("player", self:GetID()) then
          SetItemButtonTextureVertexColor(self, 0.9, 0, 0)
          SetItemButtonNormalTextureVertexColor(self, 0.9, 0, 0)
        else
          SetItemButtonTextureVertexColor(self, 1.0, 1.0, 1.0)
          SetItemButtonNormalTextureVertexColor(self, 1.0, 1.0, 1.0)
        end
        if cooldown then
          local start, duration, enable = GetInventoryItemCooldown("player", self:GetID())
          CooldownFrame_SetTimer(cooldown, start, duration, enable)
        end
        self.hasItem = 1
      else
        local emptyTexture = self.backgroundTextureName
        if self.checkRelic and UnitHasRelicSlot("player") then
          emptyTexture = "Interface\\\\Paperdoll\\\\UI-PaperDoll-Slot-Relic.blp"
        end
        SetItemButtonTexture(self, emptyTexture)
        SetItemButtonCount(self, 0)
        SetItemButtonTextureVertexColor(self, 1.0, 1.0, 1.0)
        SetItemButtonNormalTextureVertexColor(self, 1.0, 1.0, 1.0)
        if cooldown then cooldown:Hide() end
        self.hasItem = nil
      end

      -- These are optional owners outside the bounded bag vertical. The stock update calls them
      -- unconditionally, so guard only the omitted PaperDoll dependencies rather than inventing
      -- replacement frames or pulling the full PaperDoll corpus into this gate.
      if GearManagerDialog and not GearManagerDialog:IsShown() then self.ignored = nil end
      if PaperDollItemSlotButton_UpdateLock then PaperDollItemSlotButton_UpdateLock(self) end
      if MerchantFrame_UpdateGuildBankRepair then MerchantFrame_UpdateGuildBankRepair() end
      if MerchantFrame_UpdateCanRepairAll then MerchantFrame_UpdateCanRepairAll() end
    end
  end

  if rawget(_G, "PaperDollItemSlotButton_OnEvent") == nil then
    impl.PaperDollItemSlotButton_OnEvent = function(self, event, ...)
      local arg1, arg2 = ...
      if event == "UNIT_INVENTORY_CHANGED" then
        if arg1 == "player" then PaperDollItemSlotButton_Update(self) end
      elseif event == "ITEM_LOCK_CHANGED" then
        if not arg2 and arg1 == self:GetID() and PaperDollItemSlotButton_UpdateLock then
          PaperDollItemSlotButton_UpdateLock(self)
        end
      elseif event == "BAG_UPDATE_COOLDOWN" or event == "UPDATE_INVENTORY_ALERTS" then
        PaperDollItemSlotButton_Update(self)
      elseif event == "CURSOR_UPDATE" and CursorCanGoInSlot then
        if CursorCanGoInSlot(self:GetID()) then self:LockHighlight()
        else self:UnlockHighlight() end
      end
    end
  end
end
`;
