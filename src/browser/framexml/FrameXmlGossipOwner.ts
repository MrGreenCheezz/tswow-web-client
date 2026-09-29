/**
 * Stock GossipFrame as the NPC conversation window: the gate, the published owner and the one
 * hand-off the stock panel manager cannot make here. The C API itself is FrameXmlGossip.ts.
 *
 * GossipFrame.xml loads at its retail slot after ColorPickerFrame.xml (stock TOC line 118); the
 * frame is `parent="UIParent" hidden="true"` and needs no visible-root admission. Its two
 * confirmation dialogs are StaticPopup.lua's GOSSIP_CONFIRM/GOSSIP_ENTER_CODE, raised by
 * UIParent_OnEvent (UIParent.lua:913-939), both already in the vertical.
 */
import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import type { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";
import type { FrameXmlGossipModel, FrameXmlGossipProbePage } from "./FrameXmlGossip.js";
import type { FrameXmlGossipOwner } from "./FrameXmlGossipController.js";
import { frameXmlSilentProbe } from "./FrameXmlGameMenuOwner.js";
import {
  frameXmlNpcClean, frameXmlNpcFrames, frameXmlNpcRegistered, frameXmlNpcRendered,
  type FrameXmlNpcFrameSpec,
} from "./FrameXmlGossipGateKit.js";

/** `NUMGOSSIPBUTTONS` (GossipFrame.lua:2). */
const GOSSIP_BUTTONS = 32;

const GOSSIP_FRAMES: readonly FrameXmlNpcFrameSpec[] = [
  ["GossipFrame", "Frame", ["OnLoad", "OnEvent", "OnShow", "OnHide"]],
  ["GossipFrameGreetingPanel", "Frame", []],
  ["GossipGreetingScrollFrame", "ScrollFrame", []],
  ["GossipGreetingText", "FontString", []],
  ["GossipFrameNpcNameText", "FontString", []],
  ["GossipFramePortrait", "Texture", []],
  ["GossipFrameGreetingGoodbyeButton", "Button", ["OnClick"]],
  ["GossipFrameCloseButton", "Button", ["OnClick"]],
  ["GossipSpacerFrame", "Frame", []],
  ...Array.from({ length: GOSSIP_BUTTONS }, (_, index): FrameXmlNpcFrameSpec =>
    [`GossipTitleButton${index + 1}`, "Button", ["OnClick"]]),
];

/**
 * The page the gate shows: one quest to take, one to turn in, a chat row and a paid service row —
 * every row kind GossipFrameUpdate draws and the GOSSIP_CONFIRM branch. Never sent anywhere.
 */
const PROBE_PAGE: FrameXmlGossipProbePage = Object.freeze({
  text: "WebClient",
  page: Object.freeze({
    guid: 0n, menuId: 0, textId: 0,
    options: [
      { id: 0, icon: 0, coded: false, money: 0, text: "WebClient", boxText: "" },
      { id: 1, icon: 1, coded: false, money: 100, text: "WebClient", boxText: "WebClient" },
    ],
    quests: [
      { id: 1, icon: 2, level: 1, flags: 0, repeatable: false, title: "WebClient" },
      { id: 2, icon: 4, level: 1, flags: 0, repeatable: false, title: "WebClient" },
    ],
  }),
});

/**
 * GossipTitleButtonTemplate draws its rows in `<NormalFont style="QuestFontLeft"/>` — QuestFont with
 * justifyH LEFT (FontStyles.xml) — in a 275-wide ButtonText anchored LEFT +20. The DOM renderer does
 * not carry a button's NormalFont justification onto its ButtonText (measured: the rows came out
 * centred in the parchment), so each row's font string is set LEFT once, as the style says. Remove
 * this once the renderer applies a NormalFont's justifyH.
 */
const GOSSIP_TITLE_JUSTIFY = `
for index = 1, NUMGOSSIPBUTTONS or 0 do
  local button = _G["GossipTitleButton" .. index]
  local text = button and button:GetFontString()
  if text then text:SetJustifyH("LEFT") end
end
`;

export function installFrameXmlGossipTitleText(boot: Pick<FrameXmlBoot, "vm">): boolean {
  return boot.vm.executeReported(GOSSIP_TITLE_JUSTIFY, "@webclient/gossip-title-justify");
}

/** The client's own «portrait not available» art (ArenaUI uses it for a unit it cannot draw). */
export const FRAMEXML_NPC_PORTRAIT_STAND_IN = "Interface\\CharacterFrame\\TempPortrait";

/**
 * GossipFrameUpdate (when `UnitExists("npc")`), BankFrame_OnEvent and TaxiFrame_OnEvent call
 * `SetPortraitTexture(<portrait>, "npc")` for the NPC's 3D bust. The host's SetPortraitTexture
 * draws only QuestFramePortrait's quest giver (FrameXmlBoot, a PortraitRenderer canvas above it);
 * for these three it drew nothing and the round frame stayed an empty dark ring. Until a renderer
 * slot paints them, each gets the stock unknown-portrait art first, then the host's call — which a
 * future canvas above the texture would cover, as the quest giver's covers its book icon.
 */
const NPC_PORTRAIT_STAND_IN = `
do
  local host = SetPortraitTexture
  local portraits = { GossipFramePortrait = true, BankPortraitTexture = true, TaxiPortrait = true }
  SetPortraitTexture = function(texture, unit, ...)
    local widget = type(texture) == "string" and _G[texture] or texture
    if type(widget) == "table" and type(widget.GetName) == "function" and portraits[widget:GetName() or ""]
      and type(unit) == "string" and string.lower(unit) == "npc" then
      widget:SetTexture(${JSON.stringify(FRAMEXML_NPC_PORTRAIT_STAND_IN)})
    end
    if type(host) == "function" then return host(texture, unit, ...) end
  end
end
`;

export function installFrameXmlNpcPortraits(boot: Pick<FrameXmlBoot, "vm">): boolean {
  return boot.vm.executeReported(NPC_PORTRAIT_STAND_IN, "@webclient/npc-portraits");
}

export interface FrameXmlGossipGateResult {
  readonly frame: FrameXmlFrame;
  /** Measured by the probe: visible title buttons for the probe page (2 quests + 2 options = 4). */
  readonly rows: number;
}

/**
 * Structural, rendered and transactional proof that stock GossipFrame can own NPC conversations.
 *
 * The probe runs GossipFrame_OnEvent's GOSSIP_SHOW over a synthetic page (muted: CloseGossip and
 * every Select* send nothing), counts the visible rows, asks for the paid row to prove the
 * GOSSIP_CONFIRM dialog opens, closes it and the frame, and requires zero new Lua errors or bridge
 * diagnostics with the frame ending hidden. Any failure leaves the native window as the route.
 */
export function frameXmlGossipGate(
  seam: { readonly gossip?: FrameXmlGossipModel | undefined },
  boot: Pick<FrameXmlBoot, "vm" | "bridge" | "errorCount">,
  renderer: Pick<FrameXmlDomRenderer, "elementFor">,
): FrameXmlGossipGateResult | undefined {
  try {
    const gossip = seam.gossip;
    if (!gossip) return undefined;
    const frames = frameXmlNpcFrames(boot, GOSSIP_FRAMES);
    const frame = frames?.get("GossipFrame");
    if (!frames || !frame || !frameXmlNpcRendered(renderer, frame)) return undefined;
    if (!frameXmlNpcRegistered(frame, ["GOSSIP_SHOW", "GOSSIP_CLOSED"])
      || !frameXmlNpcRegistered(boot.bridge.getFrame("UIParent"),
        ["GOSSIP_CONFIRM", "GOSSIP_ENTER_CODE", "GOSSIP_CONFIRM_CANCEL", "GOSSIP_CLOSED"])) return undefined;
    const probe = frameXmlNpcClean(boot, () => gossip.probe(PROBE_PAGE, () =>
      frameXmlSilentProbe(boot, "webclient/gossip-gate", `
        if type(StaticPopupDialogs) ~= "table" or not StaticPopupDialogs.GOSSIP_CONFIRM
          or not StaticPopupDialogs.GOSSIP_ENTER_CODE then return 0, 0, 0, 0, 1 end
        GossipFrame_OnEvent(GossipFrame, "GOSSIP_SHOW")
        local shown = GossipFrame:IsShown() and 1 or 0
        local rows = 0
        for index = 1, NUMGOSSIPBUTTONS do
          if _G["GossipTitleButton" .. index]:IsShown() then rows = rows + 1 end
        end
        SelectGossipOption(2)
        local confirm = StaticPopup_Visible("GOSSIP_CONFIRM") and 1 or 0
        StaticPopup_Hide("GOSSIP_CONFIRM")
        HideUIPanel(GossipFrame)
        return shown, rows, confirm, (GossipGreetingText:GetText() == "WebClient") and 1 or 0,
          (GossipFrame:IsShown() or StaticPopup_Visible("GOSSIP_CONFIRM")) and 1 or 0
      `, 5)));
    if (!probe) return undefined;
    const [shown, rows, confirm, text, still] = probe.map((value) => Number(value));
    if (shown !== 1 || rows !== 4 || confirm !== 1 || text !== 1 || still !== 0 || frame.visible) return undefined;
    return { frame, rows: rows ?? 0 };
  } catch {
    return undefined;
  }
}

export interface FrameXmlGossipMountOwner extends FrameXmlGossipOwner {
  /** Unmount: hide without CloseGossip, so the native fallback can repaint the open page. */
  dispose(): void;
}

/** The published owner. Opening is the server's; the host only syncs, closes and disposes. */
export function createFrameXmlGossipOwner(
  boot: Pick<FrameXmlBoot, "vm" | "bridge">,
  frame: FrameXmlFrame,
  gossip: FrameXmlGossipModel,
): FrameXmlGossipMountOwner {
  const hide = (): void => {
    if (boot.bridge.isVisible(frame)) boot.vm.executeReported("HideUIPanel(GossipFrame)", "@webclient/gossip-close");
  };
  return {
    isOpen: () => boot.bridge.isVisible(frame),
    sync: () => gossip.sync(),
    close: hide,
    dispose: () => {
      gossip.muted(hide);
      gossip.owned = false;
    },
  };
}

/**
 * QuestFrame takes GossipFrame's place when a quest is picked from a conversation.
 *
 * Both are `area = "left", pushable = 0` panels (UIParent.lua:40, :29), so stock ShowUIPanel would
 * hide GossipFrame; the stock quest owner here shows QuestFrame directly (FrameXmlQuestGiverMount),
 * which the panel manager never sees. A hook on QuestFrame's OnShow closes the conversation the way
 * the panel manager would — HideUIPanel, whose OnHide calls CloseGossip — so the two never stack.
 */
export function installFrameXmlGossipQuestHandoff(
  boot: Pick<FrameXmlBoot, "vm" | "bridge">,
  frame: FrameXmlFrame,
): boolean {
  const quest = boot.bridge.getFrame("QuestFrame");
  if (!quest) return false;
  return boot.bridge.HookScript(quest, "OnShow", () => {
    if (boot.bridge.isVisible(frame)) boot.vm.executeReported("HideUIPanel(GossipFrame)", "@webclient/gossip-to-quest");
  });
}
