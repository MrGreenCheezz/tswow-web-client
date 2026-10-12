/**
 * 3.24 (12.10): stock HelpFrame as the help window — the gate and the published owner (controller:
 * FrameXmlHelpController.ts; the C API: FrameXmlHelp.ts).
 *
 * HelpFrame.xml and KnowledgeBaseFrame.xml are at their retail TOC slots (115-116, FrameXmlCorpus.ts): HelpFrame
 * is a hidden `center` UI panel (UIParent.lua:39) whose pages — the knowledge base, «talk to a GM», «report an
 * issue», «stuck», «lag», the ticket editor and the GM's response — HelpFrame_ShowFrame stacks (HelpFrame.lua:
 * 212-262); TicketStatusFrame, the «you have a ticket» box beside the buffs, answers UPDATE_TICKET by itself.
 * The help micro button and the menu open it through stock ToggleHelpFrame (UIParent.lua:431-441); Escape
 * walks back through HelpFrame.back (ToggleGameMenu, FrameXmlGameMenuOwner.ts).
 */
import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import type { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";
import type { FrameXmlHelpModel } from "./FrameXmlHelp.js";
import type { FrameXmlHelpOwner } from "./FrameXmlHelpController.js";
import { frameXmlSilentProbe } from "./FrameXmlGameMenuOwner.js";
import {
  frameXmlNpcClean, frameXmlNpcFrames, frameXmlNpcRegistered, frameXmlNpcRendered, type FrameXmlNpcFrameSpec,
} from "./FrameXmlGossipGateKit.js";

const HELP_FRAMES: readonly FrameXmlNpcFrameSpec[] = [
  ["HelpFrame", "Frame", ["OnLoad", "OnShow", "OnHide", "OnEvent"]],
  ["HelpFrameCloseButton", "Button", []],
  ["KnowledgeBaseFrame", "Frame", ["OnLoad", "OnShow", "OnEvent"]],
  ["KnowledgeBaseFrameGMTalk", "Button", ["OnClick"]],
  ["KnowledgeBaseFrameReportIssue", "Button", ["OnClick"]],
  ["KnowledgeBaseFrameEditTicket", "Button", ["OnClick"]],
  ["KnowledgeBaseFrameAbandonTicket", "Button", ["OnClick"]],
  ["KnowledgeBaseFrameEditBox", "EditBox", []],
  ["HelpFrameGMTalk", "Frame", ["OnShow"]],
  ["HelpFrameReportIssue", "Frame", ["OnShow"]],
  ["HelpFrameStuck", "Frame", ["OnShow"]],
  ["HelpFrameLag", "Frame", []],
  ["HelpFrameOpenTicket", "Frame", []],
  ["HelpFrameOpenTicketEditBox", "EditBox", []],
  ["HelpFrameOpenTicketSubmit", "Button", ["OnClick"]],
  ["HelpFrameOpenTicketCancel", "Button", ["OnClick"]],
  ["HelpFrameViewResponse", "Frame", []],
  ["HelpFrameViewResponseMoreHelp", "Button", ["OnClick"]],
];

/** What HelpFrame_OnLoad registers that this client raises (HelpFrame.lua:50-56; GMSURVEY_DISPLAY is out of the plan). */
const HELP_EVENTS = ["PLAYER_ENTERING_WORLD", "UPDATE_GM_STATUS", "UPDATE_TICKET", "GMRESPONSE_RECEIVED"] as const;

/**
 * Structural, rendered and transactional proof that stock HelpFrame can be the help window: the named pages under
 * HelpFrame with their scripts, TicketStatusFrame, the help model on the seam, the events registered; then one
 * silent pass — ToggleHelpFrame opens the knowledge base, HelpFrame_ShowFrame("Lag") stacks the lag page over it,
 * HelpFrame_PopFrame comes back, HideUIPanel closes — with GetGMTicket, GetGMStatus and KBSetup_BeginLoading
 * stubbed and the search box's SetFocus held for the pass (nothing is sent, the keyboard is not taken), and no new
 * Lua error or bridge diagnostic.
 */
export function frameXmlHelpGate(
  seam: { readonly help?: FrameXmlHelpModel | undefined },
  boot: Pick<FrameXmlBoot, "vm" | "bridge" | "errorCount">,
  renderer: Pick<FrameXmlDomRenderer, "elementFor">,
): { readonly frame: FrameXmlFrame } | undefined {
  try {
    if (!seam.help) return undefined;
    const frames = frameXmlNpcFrames(boot, HELP_FRAMES);
    const frame = frames?.get("HelpFrame");
    const status = boot.bridge.getFrame("TicketStatusFrame");
    if (!frames || !frame || !frameXmlNpcRendered(renderer, frame) || !status
      || !frameXmlNpcRegistered(frame, HELP_EVENTS) || !frameXmlNpcRegistered(status, ["UPDATE_TICKET", "GMRESPONSE_RECEIVED"])) {
      return undefined;
    }
    const probe = frameXmlNpcClean(boot, () => frameXmlSilentProbe(boot, "webclient/help-gate", `
      if type(ToggleHelpFrame) ~= "function" or type(HelpFrame_ShowFrame) ~= "function" then return 0, 0, 0, 1 end
      local ticket, status, kb = GetGMTicket, GetGMStatus, KBSetup_BeginLoading
      local box = KnowledgeBaseFrameEditBox
      GetGMTicket, GetGMStatus, KBSetup_BeginLoading = function() end, function() end, function() end
      box.SetFocus = function() end
      local ok, opened, stacked, back = pcall(function()
        ToggleHelpFrame()
        local opened = HelpFrame:IsShown() and KnowledgeBaseFrame:IsShown()
        HelpFrame_ShowFrame("Lag")
        local stacked = HelpFrameLag:IsShown() and not KnowledgeBaseFrame:IsShown()
        HelpFrame_PopFrame()
        local back = KnowledgeBaseFrame:IsShown() and not HelpFrameLag:IsShown()
        HideUIPanel(HelpFrame)
        return opened, stacked, back
      end)
      GetGMTicket, GetGMStatus, KBSetup_BeginLoading = ticket, status, kb
      box.SetFocus = nil
      if not ok then error(opened, 0) end
      return opened and 1 or 0, stacked and 1 or 0, back and 1 or 0, HelpFrame:IsShown() and 1 or 0
    `, 4));
    if (!probe) return undefined;
    const [opened, stacked, back, still] = probe.map((value) => Number(value));
    if (opened !== 1 || stacked !== 1 || back !== 1 || still !== 0 || frame.visible) return undefined;
    return { frame };
  } catch {
    return undefined;
  }
}

/** The published owner: the key is stock ToggleHelpFrame; a close is HideUIPanel. */
export function createFrameXmlHelpOwner(boot: Pick<FrameXmlBoot, "vm" | "bridge">, frame: FrameXmlFrame): FrameXmlHelpOwner {
  return {
    isOpen: () => boot.bridge.isVisible(frame),
    toggle: () => { boot.vm.executeReported("ToggleHelpFrame()", "@webclient/help-toggle"); },
    close: () => {
      if (boot.bridge.isVisible(frame)) boot.vm.executeReported("HideUIPanel(HelpFrame)", "@webclient/help-close");
    },
  };
}
