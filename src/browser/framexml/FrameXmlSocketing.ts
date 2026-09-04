import type { GlueLuaVm } from "../glue/GlueLua.js";
import type { FrameXmlUiBridge } from "../ui/framexml_compat/FrameXmlRuntime.js";
import type { FrameXmlWorldSeam } from "./FrameXmlWorldSeam.js";
import type { FrameXmlInventoryTooltipItem, FrameXmlInventoryTooltipSeam } from "./FrameXmlCharacterTooltip.js";
import { newSocketInfoFromLua, openSocketingFromLua } from "../ui/Socketing.js";

interface SocketSelection {
  readonly location: number;
  readonly bag: number;
  readonly slot: number;
  readonly entry: number;
}

/**
 * The socket-item window used by gem-abilities' original extraction action. Selection reads the
 * real equipped/carried item; the addon remains the owner of its button and OP85 request.
 * New-gem placement opens the native WebClient picker; pending replacements are exposed to the
 * addon's GetNewSocketInfo check so extraction cannot race a staged placement on the same item.
 */
export function installFrameXmlSocketing(
  vm: GlueLuaVm,
  bridge: FrameXmlUiBridge,
  seam: FrameXmlWorldSeam | undefined,
): { afterLuaFile(path: string): void } {
  const source = seam as (FrameXmlWorldSeam & FrameXmlInventoryTooltipSeam) | undefined;
  let selection: SocketSelection | undefined;
  const itemAt = (location: number, bag: number, slot: number): FrameXmlInventoryTooltipItem | undefined => {
    if (!Number.isInteger(slot) || !Number.isInteger(bag)) return undefined;
    if (location === 0 && bag === 0 && slot >= 1 && slot <= 19) {
      return source?.inventoryItemTooltip?.("player", slot);
    }
    if (location === 1 && bag >= 0 && bag <= 4 && slot >= 1 && slot <= (source?.containerNumSlots(bag) ?? 0)) {
      return source?.containerItemTooltip?.(bag, slot);
    }
    return undefined;
  };
  const current = (): FrameXmlInventoryTooltipItem | undefined => {
    if (!selection) return undefined;
    const item = itemAt(selection.location, selection.bag, selection.slot);
    return item?.entry === selection.entry ? item : undefined;
  };
  vm.registerGlobal("__fxSocketSelect", (args) => {
    selection = undefined;
    const location = Number(args[0]);
    const bag = Number(args[1]);
    const slot = Number(args[2]);
    const item = itemAt(location, bag, slot);
    if (!item || !Number.isSafeInteger(item.entry) || item.entry <= 0) return [false];
    selection = { location, bag, slot, entry: item.entry };
    return [true];
  });
  vm.registerGlobal("__fxSocketClear", () => { selection = undefined; return []; });
  vm.registerGlobal("__fxSocketInsert", () => selection && current()
    ? [openSocketingFromLua(selection.location, selection.bag, selection.slot)] : [false]);
  vm.registerGlobal("__fxSocketEvent", (args) => {
    bridge.dispatchEvent(String(args[0]));
    return [];
  });
  vm.registerGlobal("GetSocketItemInfo", () => {
    const item = current();
    if (!item || !selection) return [];
    const texture = selection.location === 0
      ? source?.inventoryItemTexture("player", selection.slot)
      : source?.containerItemInfo(selection.bag, selection.slot)?.[0];
    return [item.metadata?.name || item.template?.name || `Item ${item.entry}`,
      texture, item.metadata?.quality ?? item.template?.quality ?? 0];
  });
  vm.registerGlobal("GetNewSocketInfo", (args) => {
    if (!selection || !current()) return [];
    const staged = newSocketInfoFromLua(selection.location, selection.bag, selection.slot, Number(args[0]));
    return staged ? [staged] : [];
  });
  const result = vm.execute(SOCKETING_PRELUDE, "@FrameXmlSocketing");
  if (!result.ok) throw new Error(`FrameXML socketing binding failed: ${result.error}`);
  return {
    afterLuaFile(path) {
      // UIParent.lua defines the native LoadAddOn destination after the prelude. Replace that
      // destination before generated modules hook it, preserving their hooksecurefunc callbacks.
      if (!path.replaceAll("\\", "/").toLowerCase().endsWith("/uiparent.lua")) return;
      const rebound = vm.execute("ItemSocketingFrame_LoadUI = __fxSocketLoadUI; ItemSocketingFrame_Update = __fxSocketUpdate", "@FrameXmlSocketing:UIParent");
      if (!rebound.ok) throw new Error(`FrameXML socketing UI binding failed: ${rebound.error}`);
    },
  };
}

const SOCKETING_PRELUDE = `
do
  local function extractionEnabled(enabled)
    local frame = rawget(_G, "ItemSocketingFrame")
    if not frame then return end
    for _, button in ipairs({ frame:GetChildren() }) do
      local kind = button:GetObjectType()
      if kind == "Button" or kind == "CheckButton" then
        if enabled then button:Enable() else button:Disable() end
      end
    end
  end

  function __fxSocketUpdate()
    local frame = rawget(_G, "ItemSocketingFrame")
    if not frame then return end
    local name, icon = GetSocketItemInfo()
    if not name then
      extractionEnabled(false)
      frame:Hide()
      return
    end
    ItemSocketingFrameItemName:SetText(name)
    ItemSocketingFrameItemIcon:SetTexture(icon)
    extractionEnabled(true)
  end

  function __fxSocketLoadUI()
    if rawget(_G, "ItemSocketingFrame") then return end
    local frame = CreateFrame("Frame", "ItemSocketingFrame", UIParent)
    UISpecialFrames = UISpecialFrames or {}
    table.insert(UISpecialFrames, "ItemSocketingFrame")
    frame:SetSize(390, 170)
    frame:SetPoint("CENTER", UIParent, "CENTER", 0, 0)
    frame:SetFrameStrata("DIALOG")
    frame:EnableMouse(true)
    frame:SetBackdrop({ bgFile = "Interface\\\\DialogFrame\\\\UI-DialogBox-Background",
      edgeFile = "Interface\\\\DialogFrame\\\\UI-DialogBox-Border", tile = true, tileSize = 32,
      edgeSize = 24, insets = { left = 6, right = 6, top = 6, bottom = 6 } })
    local title = frame:CreateFontString(nil, "OVERLAY", "GameFontNormalLarge")
    title:SetPoint("TOP", frame, "TOP", 0, -18)
    title:SetText(rawget(_G, "ITEM_SOCKETING") or "Item Socketing")
    local icon = frame:CreateTexture("ItemSocketingFrameItemIcon", "ARTWORK")
    icon:SetSize(40, 40)
    icon:SetPoint("TOPLEFT", frame, "TOPLEFT", 20, -50)
    local name = frame:CreateFontString("ItemSocketingFrameItemName", "OVERLAY", "GameFontHighlight")
    name:SetPoint("LEFT", icon, "RIGHT", 12, 0)
    name:SetWidth(245)
    name:SetJustifyH("LEFT")
    local close = CreateFrame("Button", "ItemSocketingFrameCloseButton", frame, "UIPanelCloseButton")
    close:SetSize(24, 24)
    close:SetPoint("TOPRIGHT", frame, "TOPRIGHT", -5, -5)
    close:SetScript("OnClick", function() CloseSocketInfo() end)
    local insert = CreateFrame("Button", "WebClientSocketInsertButton", frame, "UIPanelButtonTemplate")
    insert:SetSize(170, 24)
    insert:SetPoint("BOTTOMRIGHT", frame, "BOTTOMRIGHT", -10, 31)
    insert:SetText("Вставить камни")
    insert:SetScript("OnClick", function() if __fxSocketInsert() then CloseSocketInfo() end end)
    frame:RegisterEvent("UNIT_INVENTORY_CHANGED")
    frame:RegisterEvent("BAG_UPDATE")
    frame:SetScript("OnEvent", function(self) if self:IsShown() then __fxSocketUpdate() end end)
    frame:SetScript("OnHide", function() __fxSocketClear(); extractionEnabled(false) end)
    frame:Hide()
  end

  ItemSocketingFrame_LoadUI = __fxSocketLoadUI
  ItemSocketingFrame_Update = __fxSocketUpdate

  function CloseSocketInfo()
    __fxSocketClear()
    extractionEnabled(false)
    local frame = rawget(_G, "ItemSocketingFrame")
    if frame then frame:Hide() end
    __fxSocketEvent("SOCKET_INFO_CLOSE")
  end

  local function open(location, bag, slot)
    -- Frame creation starts hidden, so create it before committing the selected item: OnHide
    -- clears the previous session. The addon's LoadUI hook creates its own extraction button.
    ItemSocketingFrame_LoadUI()
    if not __fxSocketSelect(location, bag, slot) then CloseSocketInfo(); return end
    ItemSocketingFrame_Update()
    ItemSocketingFrame:Show()
    __fxSocketEvent("SOCKET_INFO_UPDATE")
  end
  function SocketInventoryItem(slot) open(0, 0, slot) end
  function SocketContainerItem(bag, slot) open(1, bag, slot) end
end
`;
