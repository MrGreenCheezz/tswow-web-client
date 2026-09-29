/**
 * Stock FriendsFrame (with RaidFrame and ChannelFrame as its tabs) as the social window: the stock
 * entry points' routes, the gate and the published owner. The C API is FrameXmlFriends.ts.
 *
 * FriendsFrame.xml, RaidFrame.xml and ChannelFrame.xml load at stock TOC 101-103. Entry points into
 * the stock frame from Lua — the chat's FriendsMicroButton (`ToggleFriendsFrame(1)`), the channel
 * menu and channel links (`ToggleFriendsFrame(4)`), `/friends`, `/ignore`, `/who`, `/groster`,
 * `/raidinfo` — are routed through the host, so they reach the stock frame once it is published and
 * the native social windows before that; a stock frame never opens beside a native one.
 */
import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import type { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";
import type { FrameXmlFriendsModel } from "./FrameXmlFriends.js";
import { frameXmlChannelRow } from "./FrameXmlFriendsChannels.js";
import type { FrameXmlFriendsOwner, FrameXmlFriendsTab } from "./FrameXmlFriendsController.js";
import { frameXmlSilentProbe } from "./FrameXmlGameMenuOwner.js";

/** `IGNORES_TO_DISPLAY`, `GUILDMEMBERS_TO_DISPLAY` (FriendsFrame.lua:3, :13). */
const IGNORE_BUTTONS = 19;
const GUILD_BUTTONS = 13;

/** Named stock frames the social window needs, with their widget type and the scripts it must carry. */
const FRIENDS_FRAMES: readonly (readonly [name: string, type: string, scripts: readonly string[]])[] = [
  ["FriendsFrame", "Frame", ["OnLoad", "OnEvent", "OnShow", "OnHide"]],
  ["FriendsListFrame", "Frame", []],
  ["IgnoreListFrame", "Frame", []],
  ["WhoFrame", "Frame", ["OnShow"]],
  ["GuildFrame", "Frame", []],
  ["ChannelFrame", "Frame", ["OnShow"]],
  ["RaidFrame", "Frame", ["OnLoad", "OnEvent"]],
  ["FriendsTabHeader", "Frame", []],
  ["FriendsTabHeaderTab1", "Button", ["OnClick"]],
  ["FriendsTabHeaderTab2", "Button", ["OnClick"]],
  ["FriendsFrameTab1", "Button", ["OnClick"]],
  ["FriendsFrameTab2", "Button", ["OnClick"]],
  ["FriendsFrameTab3", "Button", ["OnClick"]],
  ["FriendsFrameTab4", "Button", ["OnClick"]],
  ["FriendsFrameTab5", "Button", ["OnClick"]],
  ["FriendsFrameCloseButton", "Button", ["OnClick"]],
  ["FriendsFrameFriendsScrollFrame", "ScrollFrame", ["OnLoad"]],
  ["FriendsFrameAddFriendButton", "Button", ["OnClick"]],
  ["FriendsFrameSendMessageButton", "Button", ["OnClick"]],
  ["FriendsFrameIgnorePlayerButton", "Button", ["OnClick"]],
  ["FriendsFrameUnsquelchButton", "Button", ["OnClick"]],
  ["WhoFrameEditBox", "EditBox", ["OnEnterPressed"]],
  ["WhoFrameWhoButton", "Button", ["OnClick"]],
  ["WhoFrameAddFriendButton", "Button", ["OnClick"]],
  ["WhoFrameGroupInviteButton", "Button", ["OnClick"]],
  ["GuildFrameAddMemberButton", "Button", ["OnClick"]],
  ["GuildFrameControlButton", "Button", ["OnClick"]],
  ["GuildFrameGuildInformationButton", "Button", ["OnClick"]],
  ["GuildMemberDetailFrame", "Frame", []],
  ["GuildInfoFrame", "Frame", []],
  ["GuildControlPopupFrame", "Frame", ["OnShow", "OnHide"]],
  ["GuildEventLogFrame", "Frame", ["OnEvent"]],
  ["RaidFrameConvertToRaidButton", "Button", ["OnClick"]],
  ["RaidFrameRaidInfoButton", "Button", ["OnClick"]],
  ["RaidInfoFrame", "Frame", ["OnShow"]],
];

/** Events the stock frames must have registered in OnLoad for the seam's pump to reach them. */
const FRIENDS_EVENTS: readonly (readonly [frame: string, events: readonly string[]])[] = [
  ["FriendsFrame", ["FRIENDLIST_UPDATE", "IGNORELIST_UPDATE", "WHO_LIST_UPDATE", "GUILD_ROSTER_UPDATE",
    "PLAYER_GUILD_UPDATE", "GUILD_MOTD"]],
  ["RaidFrame", ["RAID_ROSTER_UPDATE", "UPDATE_INSTANCE_INFO"]],
  ["GuildEventLogFrame", ["GUILD_EVENT_LOG_UPDATE"]],
];

function frameDescendsFrom(frame: FrameXmlFrame, ancestor: FrameXmlFrame): boolean {
  let current: FrameXmlFrame | undefined = frame;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function dataAttribute(element: HTMLElement, name: string): string | null {
  const value = element.getAttribute(name);
  if (value !== null) return value;
  const key = name.slice(5).replace(/-([a-z])/g, (_match, character: string) => character.toUpperCase());
  return element.dataset?.[key] ?? null;
}

function renderedFrameElement(element: HTMLElement | undefined, frame: FrameXmlFrame): element is HTMLElement {
  return !!element && dataAttribute(element, "data-framexml-name") === frame.name
    && dataAttribute(element, "data-framexml-type") === frame.type;
}

/** What the host routes do: the stock owner while published, the native windows otherwise. */
export interface FrameXmlFriendsRoutes {
  toggle(tab: FrameXmlFriendsTab | undefined): unknown;
  open(tab: FrameXmlFriendsTab): unknown;
}

const ROUTE_GLOBAL = "__webclientFriendsRoute";
const TAB_NAMES: readonly (FrameXmlFriendsTab | undefined)[] = [undefined, "friends", "who", "guild", "channel", "raid"];

function routeTab(value: unknown): FrameXmlFriendsTab | undefined {
  if (typeof value === "number") return TAB_NAMES[value];
  return typeof value === "string" && (TAB_NAMES as readonly unknown[]).includes(value) || value === "ignore"
    ? value as FrameXmlFriendsTab : undefined;
}

/**
 * Keep the stock entry points in `__webclientStockFriends` and point them at the host routes:
 * `ToggleFriendsFrame(tab)` (MainMenuBarMicroButtons, FriendsMicroButton, ItemRef, FloatingChatFrame,
 * /raidinfo), `ToggleFriendsPanel`/`ToggleIgnorePanel`/`ShowWhoPanel` (/friends, /ignore, /who) and
 * `SlashCmdList.GUILD_ROSTER` (/groster, which calls ShowUIPanel(FriendsFrame) itself). The owner
 * calls the saved stock functions, so nothing recurses.
 *
 * Two in-lane adapters ride along:
 * * `GuildEventMessage:GetFieldSize()` — GuildEventLog_Update compares the log's byte length with it
 *   (FriendsFrame.lua:1966, :1992) and the DOM widget layer answers nil («attempt to compare nil
 *   with number», measured). The FontString has no `bytes` attribute, so the client answers the
 *   UI.xsd default, 255 (read from Interface\FrameXML\UI.xsd in this client's MPQs). Retire this once
 *   the widget layer implements GetFieldSize.
 * * WEBCLIENT_WHO_TO_CHAT — the model's «print a short /who answer» edge — writes the prelude's
 *   `WebClientWhoChatLines()` into DEFAULT_CHAT_FRAME in the SYSTEM colour, as the chat's own help
 *   hook does (FrameXmlChatApi).
 */
export function installFrameXmlFriendsRoutes(boot: Pick<FrameXmlBoot, "vm">, routes: FrameXmlFriendsRoutes): boolean {
  boot.vm.registerGlobal(ROUTE_GLOBAL, (args) => {
    const action = args[0];
    const tab = routeTab(args[1]);
    try {
      if (action === "open" && tab !== undefined) void routes.open(tab);
      else void routes.toggle(tab);
    } catch (error) {
      console.warn(`[FrameXML friends] route: ${String(error)}`);
    }
    return [];
  });
  const installed = frameXmlSilentProbe(boot, "webclient/friends-routes", `
    if type(ToggleFriendsFrame) ~= "function" or type(FriendsFrame) ~= "table" then return 0 end
    if type(__webclientStockFriends) ~= "table" then
      __webclientStockFriends = {
        toggle = ToggleFriendsFrame, friends = ToggleFriendsPanel, ignore = ToggleIgnorePanel,
        who = ShowWhoPanel, roster = type(SlashCmdList) == "table" and SlashCmdList.GUILD_ROSTER or nil,
      }
    end
    local route = ${ROUTE_GLOBAL}
    ToggleFriendsFrame = function(tab) route("toggle", tab) end
    ToggleFriendsPanel = function() route("toggle", "friends") end
    ToggleIgnorePanel = function() route("toggle", "ignore") end
    ShowWhoPanel = function() route("open", "who") end
    if type(SlashCmdList) == "table" and SlashCmdList.GUILD_ROSTER ~= nil then
      SlashCmdList.GUILD_ROSTER = function() if IsInGuild() then route("open", "guild") end end
    end
    if GuildEventMessage and GuildEventMessage:GetFieldSize() == nil then
      GuildEventMessage.GetFieldSize = function() return 255 end
    end
    if not __webclientWhoChatFrame and type(CreateFrame) == "function" then
      local frame = CreateFrame("Frame")
      frame:RegisterEvent("WEBCLIENT_WHO_TO_CHAT")
      frame:SetScript("OnEvent", function()
        local target = DEFAULT_CHAT_FRAME
        if not target or type(WebClientWhoChatLines) ~= "function" then return end
        local info = type(ChatTypeInfo) == "table" and ChatTypeInfo["SYSTEM"] or nil
        local lines = WebClientWhoChatLines()
        for index = 1, #lines do
          if info then target:AddMessage(lines[index], info.r, info.g, info.b, info.id)
          else target:AddMessage(lines[index]) end
        end
      end)
      __webclientWhoChatFrame = frame
    end
    return 1
  `, 1);
  return Number(installed?.[0]) === 1 && installFrameXmlFriendsAdapters(boot);
}

/**
 * Two renderer differences the stock frame runs into, adapted for these frames only (retire each
 * once FrameXmlDomRenderer handles it; the stock geometry is untouched), and one absent module:
 *
 * * FriendsDropDown, ChannelListDropDown and ChannelRosterDropDown (`<Frame
 *   inherits="UIDropDownMenuTemplate"/>` with no anchor, FriendsFrame.xml/ChannelFrame.xml) have no
 *   rect in the client, so their dropdown art is never drawn; ToggleDropDownMenu only borrows them as
 *   the menu's owner and anchors DropDownList1 to the cursor. The DOM renderer drew the art at the
 *   parent's top-left corner (measured on the rich route: a 153×20 dropdown box over FriendsFrame's
 *   portrait, two more on the Chat tab). Each is hidden while it has no anchor; nothing in stock
 *   reads their visibility.
 * * WhoListScrollFrame, GuildListScrollFrame and ChannelRosterScrollFrame are FauxScrollFrames laid
 *   over their row buttons.
 *   In the client they take the mouse wheel but not clicks, so a click reaches the row below; the
 *   renderer gives a wheel-taking frame the pointer outright, and the rows could not be clicked
 *   (measured: elementsFromPoint on GuildFrameButton4's centre answered GuildListScrollFrame first).
 *   The scroll frame gives up the wheel and each row forwards its wheel to the scroll frame's own
 *   OnMouseWheel, so both the click and the wheel reach what they reach in the client.
 *
 * And one module this client does not ship: RaidFrame_OnEvent calls `RaidFrame_LoadUI()` on every
 * RAID_ROSTER_UPDATE and on PLAYER_LOGIN in a raid (RaidFrame.lua:32, :36), which is
 * `UIParentLoadAddOn("Blizzard_RaidUI")` (UIParent.lua:280). The add-on runtime does not know that
 * load-on-demand module, so LoadAddOn answers false, "MISSING" and stock put «Ошибка загрузки
 * (Blizzard_RaidUI): Отсутствует» in the script-error dialog the first time the player was in a raid
 * (measured over the canned raid). While LoadAddOn answers MISSING the load is skipped; any other
 * answer — the module registered, loaded, or failing for another reason — keeps the stock path.
 * LoadAddOn only reports status here (FrameXmlBoot), so the extra call starts no load.
 */
export function installFrameXmlFriendsAdapters(boot: Pick<FrameXmlBoot, "vm">): boolean {
  const installed = frameXmlSilentProbe(boot, "webclient/friends-adapters", `
    for _, menu in ipairs({ FriendsDropDown, ChannelListDropDown, ChannelRosterDropDown }) do
      if menu and menu:GetNumPoints() == 0 then menu:Hide() end
    end
    if type(RaidFrame_LoadUI) == "function" and type(__webclientStockRaidLoadUI) ~= "function" then
      local load = RaidFrame_LoadUI
      __webclientStockRaidLoadUI = load
      RaidFrame_LoadUI = function(...)
        local _, reason = LoadAddOn("Blizzard_RaidUI")
        if reason ~= "MISSING" then return load(...) end
      end
    end
    local lists = {
      { WhoListScrollFrame, "WhoFrameButton", WHOS_TO_DISPLAY },
      { GuildListScrollFrame, "GuildFrameButton", GUILDMEMBERS_TO_DISPLAY },
      { GuildListScrollFrame, "GuildFrameGuildStatusButton", GUILDMEMBERS_TO_DISPLAY },
      { ChannelRosterScrollFrame, "ChannelMemberButton", MAX_CHANNEL_MEMBER_BUTTONS or 22 },
    }
    for _, list in ipairs(lists) do
      local scroll, prefix, count = list[1], list[2], list[3] or 0
      local wheel = scroll and scroll:GetScript("OnMouseWheel")
      if wheel then
        scroll:EnableMouseWheel(false)
        for index = 1, count do
          local row = _G[prefix .. index]
          if row and not row:GetScript("OnMouseWheel") then
            row:EnableMouseWheel(true)
            row:SetScript("OnMouseWheel", function(_, delta) wheel(scroll, delta) end)
          end
        end
      end
    end
    return 1
  `, 1);
  return Number(installed?.[0]) === 1;
}

/** `ToggleFriendsFrame`'s tab number for a route tab; Ignore is tab 1 with its header's subtab 2. */
const TAB_NUMBERS: Readonly<Record<FrameXmlFriendsTab, number>> = {
  friends: 1, ignore: 1, who: 2, guild: 3, channel: 4, raid: 5,
};

export interface FrameXmlFriendsGateResult {
  readonly frame: FrameXmlFrame;
  /** Measured by the probe: visible ignore rows and guild rows (-1 when not in a guild). */
  readonly ignoreRows: number;
  readonly guildRows: number;
}

/**
 * Structural, rendered and transactional proof that stock FriendsFrame can own the social window.
 *
 * The frames, their scripts and their registered events must be there and rendered; the stock
 * entry points must already be kept by {@link installFrameXmlFriendsRoutes}. The probe then opens
 * the frame on every tab through the stock toggle — Friends, Ignore (header subtab 2), Who, Guild
 * (only in a guild, as stock refuses it otherwise), Chat, Raid — counts the ignore and guild rows,
 * restores the tabs and hides it: silently (no PlaySound) and without a packet (the model is muted,
 * so ShowFriends and the roster reads send nothing). Last it opens a friend row's menu the way a
 * right-click does (`FriendsFrame_ShowDropdown(name, 1, …, friendsList)`, FriendsFrame.lua:137) and
 * closes it: the menu must offer SET_NOTE and REMOVE_FRIEND, the one stock way to note or drop a
 * friend (UnitPopup.lua:144, :548-555), which the native panel's row menu also had. Any new Lua
 * error or bridge diagnostic, a tab whose subframe did not show, a row count that disagrees with the
 * model or a dead row menu fails the gate and leaves the native windows.
 */
export function frameXmlFriendsGate(
  seam: { readonly friends?: FrameXmlFriendsModel | undefined },
  boot: Pick<FrameXmlBoot, "vm" | "bridge" | "errorCount">,
  renderer: Pick<FrameXmlDomRenderer, "elementFor">,
): FrameXmlFriendsGateResult | undefined {
  try {
    const friends = seam.friends;
    if (!friends) return undefined;
    const frames = new Map<string, FrameXmlFrame>();
    for (const [name, type, scripts] of FRIENDS_FRAMES) {
      const frame = boot.bridge.getFrame(name);
      if (!frame || frame.type !== type || !scripts.every((script) => boot.bridge.hasScript(frame, script))) {
        return undefined;
      }
      frames.set(name, frame);
    }
    const parent = frames.get("FriendsFrame")!;
    if (parent.parent?.name !== "UIParent" || parent.visible) return undefined;
    for (const name of ["FriendsListFrame", "IgnoreListFrame", "WhoFrame", "GuildFrame", "ChannelFrame", "RaidFrame"]) {
      if (frames.get(name)!.parent !== parent) return undefined;
    }
    for (let index = 1; index <= IGNORE_BUTTONS; index += 1) {
      const button = boot.bridge.getFrame(`FriendsFrameIgnoreButton${index}`);
      if (!button || !frameDescendsFrom(button, parent)) return undefined;
    }
    for (let index = 1; index <= GUILD_BUTTONS; index += 1) {
      const button = boot.bridge.getFrame(`GuildFrameButton${index}`);
      if (!button || !frameDescendsFrom(button, parent)) return undefined;
    }
    for (const name of ["FriendsFrame", "FriendsFrameTab1", "FriendsFrameTab5", "WhoFrameEditBox", "GuildFrame", "RaidFrame"]) {
      const frame = frames.get(name)!;
      if (!renderedFrameElement(renderer.elementFor(frame), frame)) return undefined;
    }
    for (const [name, events] of FRIENDS_EVENTS) {
      const frame = frames.get(name)!;
      if (!events.every((event) => frame.registeredEvents.has(event))) return undefined;
    }
    const errors = boot.errorCount;
    const diagnostics = boot.bridge.diagnostics.length;
    const probe = friends.muted(() => frameXmlSilentProbe(boot, "webclient/friends-gate", `
      local stock = __webclientStockFriends
      if type(stock) ~= "table" or type(stock.toggle) ~= "function" then return 0 end
      local savedTab = PanelTemplates_GetSelectedTab(FriendsFrame) or 1
      local savedHeader = FriendsTabHeader.selectedTab or 1
      local function rows(prefix, count)
        local visible = 0
        for index = 1, count do
          local button = _G[prefix .. index]
          if button and button:IsVisible() then visible = visible + 1 end
        end
        return visible
      end
      PanelTemplates_SetTab(FriendsTabHeader, 1)
      stock.toggle(1)
      local shown = FriendsFrame:IsShown() and FriendsListFrame:IsVisible() and 1 or 0
      PanelTemplates_SetTab(FriendsTabHeader, 2)
      FriendsFrame_Update()
      local ignore = IgnoreListFrame:IsVisible() and 1 or 0
      local ignoreRows = rows("FriendsFrameIgnoreButton", IGNORES_TO_DISPLAY)
      PanelTemplates_SetTab(FriendsTabHeader, 1)
      stock.toggle(2)
      local who = WhoFrame:IsVisible() and 1 or 0
      local guild, guildRows = -1, -1
      if IsInGuild() then
        stock.toggle(3)
        guild = GuildFrame:IsVisible() and 1 or 0
        guildRows = rows(FriendsFrame.playerStatusFrame and "GuildFrameButton" or "GuildFrameGuildStatusButton", GUILDMEMBERS_TO_DISPLAY)
      end
      stock.toggle(4)
      local channel = ChannelFrame:IsVisible() and 1 or 0
      stock.toggle(5)
      local raid = RaidFrame:IsVisible() and 1 or 0
      PanelTemplates_SetTab(FriendsFrame, savedTab)
      PanelTemplates_SetTab(FriendsTabHeader, savedHeader)
      HideUIPanel(FriendsFrame)
      local menu = 0
      if type(FriendsFrame_ShowDropdown) == "function" and type(UnitPopupMenus) == "table" then
        CloseDropDownMenus()
        FriendsFrame_ShowDropdown(GetFriendInfo(1) or UnitName("player") or "?", 1, nil, nil, nil, 1)
        local offered = {}
        for index = 1, DropDownList1:IsShown() and (DropDownList1.numButtons or 0) or 0 do
          local button = _G["DropDownList1Button" .. index]
          if button and button.value then offered[button.value] = true end
        end
        menu = offered.SET_NOTE and offered.REMOVE_FRIEND and 1 or 0
        CloseDropDownMenus()
      end
      return shown, ignore, ignoreRows, who, guild, guildRows, channel, raid, FriendsFrame:IsShown() and 1 or 0, menu
    `, 10));
    if (!probe) return undefined;
    const [shown, ignore, ignoreRows, who, guild, guildRows, channel, raid, stillShown, menu] = probe.map((value) => Number(value));
    const ignores = friends.numIgnores();
    const expectedIgnoreRows = Math.min(IGNORE_BUTTONS, ignores + (ignores > 0 ? 1 : 0));
    const inGuild = friends.guild.isInGuild();
    const expectedGuildRows = inGuild ? Math.min(GUILD_BUTTONS, friends.guild.numMembers(false)) : -1;
    if (shown !== 1 || ignore !== 1 || who !== 1 || channel !== 1 || raid !== 1 || stillShown !== 0 || menu !== 1
      || guild !== (inGuild ? 1 : -1) || ignoreRows !== expectedIgnoreRows || guildRows !== expectedGuildRows
      || parent.visible || boot.errorCount !== errors || boot.bridge.diagnostics.length !== diagnostics) return undefined;
    return { frame: parent, ignoreRows: ignoreRows ?? 0, guildRows: guildRows ?? -1 };
  } catch {
    return undefined;
  }
}

/**
 * The published owner. `show(tab)` is stock ToggleFriendsFrame's open branch without its close
 * (FriendsFrame.lua:1442-1447) plus the header subtab for Friends/Ignore; the Guild tab opens only
 * in a guild, as stock does, and GuildFrame's own `OnShow="GuildRoster"` (FriendsFrame.xml) asks for
 * a fresh roster (one request in flight, FrameXmlGuild.ts).
 * `toggle(tab)` is the saved stock ToggleFriendsFrame/ToggleFriendsPanel/ToggleIgnorePanel.
 */
export function createFrameXmlFriendsOwner(
  boot: Pick<FrameXmlBoot, "vm" | "bridge">,
  frame: FrameXmlFrame,
): FrameXmlFriendsOwner {
  const run = (code: string, chunk: string): void => { boot.vm.executeReported(code, chunk); };
  const selected = (): readonly [tab: number, header: number] | undefined => {
    const probe = frameXmlSilentProbe(boot, "webclient/friends-tab",
      "return PanelTemplates_GetSelectedTab(FriendsFrame) or 0, FriendsTabHeader.selectedTab or 0", 2);
    return probe ? [Number(probe[0]), Number(probe[1])] : undefined;
  };
  return {
    isOpen: () => boot.bridge.isVisible(frame),
    isTabOpen: (tab) => {
      if (!boot.bridge.isVisible(frame)) return false;
      const current = selected();
      if (!current || current[0] !== TAB_NUMBERS[tab]) return false;
      return tab === "friends" ? current[1] === 1 : tab === "ignore" ? current[1] === 2 : true;
    },
    show: (tab) => {
      if (tab === undefined) {
        if (!boot.bridge.isVisible(frame)) run("ShowUIPanel(FriendsFrame)", "@webclient/friends-show");
        return;
      }
      const number = TAB_NUMBERS[tab];
      const header = tab === "ignore" ? 2 : tab === "friends" ? 1 : 0;
      run(`
        if ${number} == 3 and not IsInGuild() then return end
        PanelTemplates_SetTab(FriendsFrame, ${number})
        if ${header} > 0 then PanelTemplates_SetTab(FriendsTabHeader, ${header}) end
        if FriendsFrame:IsShown() then FriendsFrame_OnShow() else ShowUIPanel(FriendsFrame) end
      `, "@webclient/friends-show");
    },
    toggle: (tab) => {
      const call = tab === undefined ? "stock.toggle()"
        : tab === "friends" ? "stock.friends()"
        : tab === "ignore" ? "stock.ignore()"
        : `stock.toggle(${TAB_NUMBERS[tab]})`;
      run(`local stock = __webclientStockFriends if stock then ${call} end`, "@webclient/friends-toggle");
    },
    hide: () => {
      if (boot.bridge.isVisible(frame)) run("HideUIPanel(FriendsFrame)", "@webclient/friends-hide");
    },
    // The row a left click selects (ChannelList_OnClick: SetSelectedDisplayChannel, then the roster),
    // found by the rows' own display names; selecting asks the server for the roster, as a click does.
    selectChannel: (name) => {
      const listed = frameXmlSilentProbe(boot, "webclient/friends-channels", `
        local names = {}
        for index = 1, GetNumDisplayChannels() do
          local channel, header = GetChannelDisplayInfo(index)
          names[index] = (not header and channel) or ""
        end
        return #names, table.concat(names, "\\n")
      `, 2);
      const count = Number(listed?.[0] ?? 0);
      const rows = count > 0 && typeof listed?.[1] === "string" ? listed[1].split("\n") : [];
      const row = frameXmlChannelRow(rows, name);
      if (row === undefined) return false;
      run(`SetSelectedDisplayChannel(${row}) ChannelFrame_Update()`, "@webclient/friends-channel");
      return true;
    },
  };
}
