/**
 * Stock GuildRegistrarFrame and ArenaRegistrarFrame (with PVPBannerFrame, the arena banner designer)
 * as the charter vendors: the gates and the published owner. The C API is FrameXmlRegistrar.ts.
 *
 * GuildRegistrarFrame.xml loads at stock TOC line 113, ArenaRegistrarFrame.xml at line 129 after
 * ArenaFrame.xml; all three frames are `parent="UIParent" hidden="true"` and `left` UI panels
 * (UIParent.lua:36-37; PVPBannerFrame is shown with ShowUIPanel from ArenaRegistrar_TurnInPetition).
 * One model serves both vendor frames, so both gates must pass before either is published: an arena
 * list raised to a frame whose gate failed would still open it through its registered event.
 */
import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import type { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";
import type { FrameXmlRegistrarModel, FrameXmlRegistrarProbe } from "./FrameXmlRegistrar.js";
import type { FrameXmlCharterOwner } from "./FrameXmlPetitionController.js";
import { frameXmlSilentProbe } from "./FrameXmlGameMenuOwner.js";
import {
  frameXmlNpcClean, frameXmlNpcFrames, frameXmlNpcRegistered, frameXmlNpcRendered,
  type FrameXmlNpcFrameSpec,
} from "./FrameXmlGossipGateKit.js";

const GUILD_FRAMES: readonly FrameXmlNpcFrameSpec[] = [
  ["GuildRegistrarFrame", "Frame", ["OnLoad", "OnEvent", "OnShow", "OnHide"]],
  ["GuildRegistrarFramePortrait", "Texture", []],
  ["GuildRegistrarFrameNpcNameText", "FontString", []],
  ["GuildRegistrarGreetingFrame", "Frame", []],
  ["GuildRegistrarButton1", "Button", ["OnClick"]],
  ["GuildRegistrarButton2", "Button", ["OnClick"]],
  ["GuildRegistrarFrameGoodbyeButton", "Button", ["OnClick"]],
  ["GuildRegistrarPurchaseFrame", "Frame", []],
  ["GuildRegistrarMoneyFrame", "Frame", []],
  ["GuildRegistrarFrameEditBox", "EditBox", []],
  ["GuildRegistrarFramePurchaseButton", "Button", ["OnClick"]],
  ["GuildRegistrarFrameCancelButton", "Button", ["OnClick"]],
  ["GuildRegistrarFrameCloseButton", "Button", ["OnClick"]],
];

const ARENA_FRAMES: readonly FrameXmlNpcFrameSpec[] = [
  ["ArenaRegistrarFrame", "Frame", ["OnLoad", "OnEvent", "OnShow", "OnHide"]],
  ["ArenaRegistrarFramePortrait", "Texture", []],
  ["ArenaRegistrarFrameNpcNameText", "FontString", []],
  ["ArenaRegistrarGreetingFrame", "Frame", []],
  ...[1, 2, 3, 4, 5, 6].map((id): FrameXmlNpcFrameSpec => [`ArenaRegistrarButton${id}`, "Button", ["OnClick"]]),
  ["ArenaRegistrarFrameGoodbyeButton", "Button", ["OnClick"]],
  ["ArenaRegistrarPurchaseFrame", "Frame", []],
  ["ArenaRegistrarMoneyFrame", "Frame", []],
  ["ArenaRegistrarFrameEditBox", "EditBox", []],
  ["ArenaRegistrarFramePurchaseButton", "Button", ["OnClick"]],
  ["ArenaRegistrarFrameCancelButton", "Button", ["OnClick"]],
  ["ArenaRegistrarFrameCloseButton", "Button", ["OnClick"]],
];

const BANNER_FRAMES: readonly FrameXmlNpcFrameSpec[] = [
  ["PVPBannerFrame", "Frame", ["OnShow", "OnHide"]],
  ["PVPBannerFramePortrait", "Texture", []],
  ["PVPBannerFrameStandard", "Frame", []],
  ["PVPBannerFrameStandardBanner", "Texture", []],
  ["PVPBannerFrameStandardEmblem", "Texture", []],
  ["PVPBannerFrameStandardBorder", "Texture", []],
  ["PVPBannerFrameCustomization1", "Frame", []],
  ["PVPBannerFrameCustomization2", "Frame", []],
  ["PVPColorPickerButton1", "Button", ["OnClick"]],
  ["PVPColorPickerButton2", "Button", ["OnClick"]],
  ["PVPColorPickerButton3", "Button", ["OnClick"]],
  ["PVPBannerFrameAcceptButton", "Button", ["OnClick"]],
  ["PVPBannerFrameCloseButton", "Button", ["OnClick"]],
];

const CHARTER_ITEM = 16161;

/** A guild list: one row, no team size (SendPetitionShowList's tabard-designer branch). */
const GUILD_PROBE: FrameXmlRegistrarProbe = Object.freeze({
  vendor: Object.freeze({ vendorGuid: 0n, offers: [
    { index: 1, itemId: 1, displayId: CHARTER_ITEM, cost: 1000, teamSize: 0, requiredSignatures: 1 },
  ] }),
  itemNames: new Map([[1, "WebClient"]]),
  carried: [],
});

/** An arena list, its three names known and a 2v2 charter carried. */
const ARENA_PROBE: FrameXmlRegistrarProbe = Object.freeze({
  vendor: Object.freeze({ vendorGuid: 0n, offers: [2, 3, 5].map((size, index) => (
    { index: index + 1, itemId: index + 1, displayId: CHARTER_ITEM, cost: 1000, teamSize: size, requiredSignatures: size }
  )) }),
  itemNames: new Map([[1, "WebClient"], [2, "WebClient"], [3, "WebClient"]]),
  carried: [{ guid: 1n, entry: 1 }],
});

export interface FrameXmlRegistrarGateResult {
  readonly guild: FrameXmlFrame;
  readonly arena: FrameXmlFrame;
  readonly banner: FrameXmlFrame;
}

function gateFrames(
  boot: Pick<FrameXmlBoot, "bridge">,
  renderer: Pick<FrameXmlDomRenderer, "elementFor">,
  specs: readonly FrameXmlNpcFrameSpec[],
): FrameXmlFrame | undefined {
  const frames = frameXmlNpcFrames(boot, specs);
  const root = frames?.get(specs[0]![0]);
  return root && frameXmlNpcRendered(renderer, root) ? root : undefined;
}

/**
 * Structural, rendered and transactional proof that the stock vendor frames can sell and register
 * charters. Muted probes: the guild frame opens, shows its purchase page with the price and hides;
 * the arena frame opens, shows the turn-in rows (PETITION_VENDOR_UPDATE), a purchase page, then the
 * banner designer, whose Accept runs TurnInArenaPetition and closes everything. Nothing is sent, no
 * new Lua error or bridge diagnostic is allowed, and every frame ends hidden.
 */
export function frameXmlRegistrarGate(
  seam: { readonly registrar?: FrameXmlRegistrarModel | undefined },
  boot: Pick<FrameXmlBoot, "vm" | "bridge" | "errorCount">,
  renderer: Pick<FrameXmlDomRenderer, "elementFor">,
): FrameXmlRegistrarGateResult | undefined {
  try {
    const registrar = seam.registrar;
    if (!registrar) return undefined;
    const guild = gateFrames(boot, renderer, GUILD_FRAMES);
    const arena = gateFrames(boot, renderer, ARENA_FRAMES);
    const banner = gateFrames(boot, renderer, BANNER_FRAMES);
    if (!guild || !arena || !banner) return undefined;
    if (!frameXmlNpcRegistered(guild, ["GUILD_REGISTRAR_SHOW", "GUILD_REGISTRAR_CLOSED"])
      || !frameXmlNpcRegistered(arena, ["PETITION_VENDOR_SHOW", "PETITION_VENDOR_CLOSED", "PETITION_VENDOR_UPDATE"])) {
      return undefined;
    }
    const guildProbe = frameXmlNpcClean(boot, () => registrar.probe(GUILD_PROBE, () =>
      frameXmlSilentProbe(boot, "webclient/guild-registrar-gate", `
        ShowUIPanel(GuildRegistrarFrame)
        local shown = GuildRegistrarFrame:IsShown() and GuildRegistrarGreetingFrame:IsShown() and 1 or 0
        GuildRegistrar_ShowPurchaseFrame()
        local purchase = GuildRegistrarPurchaseFrame:IsShown() and not GuildRegistrarGreetingFrame:IsShown() and 1 or 0
        HideUIPanel(GuildRegistrarFrame)
        return shown, purchase, GuildRegistrarFrame:IsShown() and 1 or 0
      `, 3)));
    if (!guildProbe) return undefined;
    const [guildShown, guildPurchase, guildStill] = guildProbe.map((value) => Number(value));
    if (guildShown !== 1 || guildPurchase !== 1 || guildStill !== 0 || guild.visible) return undefined;
    const arenaProbe = frameXmlNpcClean(boot, () => registrar.probe(ARENA_PROBE, () =>
      frameXmlSilentProbe(boot, "webclient/arena-registrar-gate", `
        ShowUIPanel(ArenaRegistrarFrame)
        ArenaRegistrar_OnEvent(ArenaRegistrarFrame, "PETITION_VENDOR_UPDATE")
        local shown = ArenaRegistrarFrame:IsShown() and 1 or 0
        local turnIn = ArenaRegistrarButton4:IsShown() and RegistrationText:IsShown() and 1 or 0
        ArenaRegistrar_ShowPurchaseFrame(ArenaRegistrarButton2)
        local purchase = ArenaRegistrarPurchaseFrame:IsShown() and 1 or 0
        HideUIPanel(ArenaRegistrarFrame)
        ShowUIPanel(ArenaRegistrarFrame)
        ArenaRegistrar_TurnInPetition(ArenaRegistrarButton4)
        local designer = PVPBannerFrame:IsShown() and not ArenaRegistrarFrame:IsShown() and 1 or 0
        local texture = PVPBannerFrameStandardBanner:GetTexture() or ""
        PVPBannerFrame_SaveBanner(PVPBannerFrameAcceptButton)
        return shown, turnIn, purchase, designer, texture ~= "" and 1 or 0,
          (ArenaRegistrarFrame:IsShown() or PVPBannerFrame:IsShown()) and 1 or 0
      `, 6)));
    if (!arenaProbe) return undefined;
    const [shown, turnIn, purchase, designer, textured, still] = arenaProbe.map((value) => Number(value));
    if (shown !== 1 || turnIn !== 1 || purchase !== 1 || designer !== 1 || textured !== 1 || still !== 0) return undefined;
    if (arena.visible || banner.visible) return undefined;
    return { guild, arena, banner };
  } catch {
    return undefined;
  }
}

export interface FrameXmlRegistrarMountOwner extends FrameXmlCharterOwner {
  /** Unmount: hide without ClosePetitionVendor/CloseGuildRegistrar, so the native vendor can repaint. */
  dispose(): void;
}

/** The published owner of both vendor frames. Opening is the server's. */
export function createFrameXmlRegistrarOwner(
  boot: Pick<FrameXmlBoot, "vm" | "bridge">,
  frames: FrameXmlRegistrarGateResult,
  registrar: FrameXmlRegistrarModel,
): FrameXmlRegistrarMountOwner {
  const open = (): boolean => boot.bridge.isVisible(frames.guild) || boot.bridge.isVisible(frames.arena)
    || boot.bridge.isVisible(frames.banner);
  const hide = (): void => {
    if (!open()) return;
    boot.vm.executeReported(
      "HideUIPanel(PVPBannerFrame) HideUIPanel(ArenaRegistrarFrame) HideUIPanel(GuildRegistrarFrame)",
      "@webclient/registrar-close");
  };
  return {
    isOpen: open,
    sync: () => registrar.sync(),
    close: hide,
    dispose: () => {
      registrar.muted(hide);
      registrar.owned = false;
    },
  };
}
