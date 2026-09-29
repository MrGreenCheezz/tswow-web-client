/**
 * Stock Blizzard_TokenUI — CharacterFrame's «Валюта» (TokenFrame, subframe id 5) and the backpack's
 * token strip (BackpackTokenFrame) — loaded on demand and fed by the currency model
 * (FrameXmlCurrency.ts).
 *
 * In 3.3.5a TokenFrame is not FrameXML: it is the load-on-demand Blizzard_TokenUI
 * (Interface\AddOns\Blizzard_TokenUI, TOC: Blizzard_TokenUI.lua, .xml, Localization.lua), which
 * MainMenuBar.lua loads on KNOWN_CURRENCY_TYPES_UPDATE/CURRENCY_DISPLAY_UPDATE through
 * `TokenFrame_LoadUI()` (`UIParentLoadAddOn("Blizzard_TokenUI")`, UIParent.lua:312-313), then calls
 * `TokenFrame_Update()` and `BackpackTokenFrame_Update()` at once (MainMenuBar.lua:224-235). This
 * host's LoadAddOn only reports a state (FrameXmlAddonRuntime.ts), so that synchronous sequence would
 * put «Ошибка загрузки» in the error dialog and call a nil TokenFrame_Update. Instead:
 *
 * 1. The model holds both events and says, through `onDemand`, when the player knows a currency.
 * 2. The owner loads the add-on (`boot.loadAddon`), and its TokenFrame replaces the inert
 *    placeholder FrameXmlCharacterCompat.ts left for CHARACTERFRAME_SUBFRAMES; stock
 *    `TokenFrame_LoadUI` is pointed at the owner, so stock's UIParentLoadAddOn is never reached.
 * 3. The gate checks the frames the XML declares and runs stock TokenFrame_Update and
 *    BackpackTokenFrame_Update against the model with no new Lua error; stock's own
 *    `TokenFrame_Update` shows CharacterFrameTab5 for a non-empty list (Blizzard_TokenUI.lua:155-159).
 * 4. The model's events are released: MainMenuBar's own handler runs from there, as in the client.
 *
 * A character who knows no currency loads nothing, and tab 5 stays hidden as stock hides it
 * (CharacterFrame.xml:141 `hidden="true"`, MainMenuBar.lua:230). A load or gate failure hides tab 5
 * and keeps the events held for good, so no stock handler reaches a missing add-on.
 */
import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import type { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import type { FrameXmlCurrencyModel } from "./FrameXmlCurrency.js";
import { FrameXmlCurrencyCatalogClient } from "./FrameXmlCurrencyLive.js";
import { frameXmlSilentProbe } from "./FrameXmlGameMenuOwner.js";

export const FRAMEXML_TOKEN_ADDON = "Blizzard_TokenUI";

/** `MAX_WATCHED_TOKENS` (Blizzard_TokenUI.lua:3): the backpack strip's three buttons. */
const WATCHED_BUTTONS = 3;

/** The host global the owner's `TokenFrame_LoadUI` calls. */
const LOAD_GLOBAL = "__webclientTokenLoad";

type GateBoot = Pick<FrameXmlBoot, "vm" | "bridge" | "errorCount">;
type TokenSeam = { readonly currency?: FrameXmlCurrencyModel | undefined };

/** The frames Blizzard_TokenUI.xml declares, their widget type and the parent each hangs from. */
const TOKEN_FRAMES: readonly (readonly [name: string, type: string, parent: string])[] = [
  ["TokenFrame", "Frame", "CharacterFrame"],
  ["TokenFrameContainer", "ScrollFrame", "TokenFrame"],
  ["TokenFramePopup", "Frame", "TokenFrame"],
  ["TokenFramePopupInactiveCheckBox", "CheckButton", "TokenFramePopup"],
  ["TokenFramePopupBackpackCheckBox", "CheckButton", "TokenFramePopup"],
  ["BackpackTokenFrame", "Frame", "UIParent"],
  ...Array.from({ length: WATCHED_BUTTONS }, (_unused, index) =>
    [`BackpackTokenFrameToken${index + 1}`, "Button", "BackpackTokenFrame"] as const),
];

const STOCK_GLOBALS: readonly string[] = [
  "TokenFrame_Update", "BackpackTokenFrame_Update", "ManageBackpackTokenFrame", "GetNumWatchedTokens",
  "TokenButton_OnClick", "TokenFramePopup_CloseIfHidden",
];

function hasGlobalFunction(boot: GateBoot, name: string): boolean {
  const ref = boot.vm.globalFunction(name);
  if (!ref) return false;
  boot.vm.release(ref);
  return true;
}

export interface FrameXmlTokenGateResult {
  /** GetCurrencyListSize() at the gate, and whether stock's update left tab 5 shown for it. */
  readonly rows: number;
  readonly tabShown: boolean;
  /** The HybridScrollFrame buttons TokenFrame_OnLoad created. */
  readonly buttons: number;
  readonly watched: number;
}

/**
 * Structural and transactional proof that the loaded add-on can own tab 5 and the backpack strip:
 * every declared frame hangs where Blizzard_TokenUI.xml puts it, TokenFrame keeps stock id 5, the
 * stock functions are real, and one stock TokenFrame_Update + BackpackTokenFrame_Update over the
 * model raises nothing and leaves tab 5 shown exactly when the list has rows.
 */
export function frameXmlTokenGate(seam: TokenSeam, boot: GateBoot): FrameXmlTokenGateResult | undefined {
  try {
    if (!seam.currency) return undefined;
    for (const [name, type, parent] of TOKEN_FRAMES) {
      const frame = boot.bridge.getFrame(name);
      if (!frame || frame.type !== type || frame.parent?.name !== parent) return undefined;
    }
    if (boot.bridge.getFrame("TokenFrame")?.id !== 5) return undefined;
    if (!STOCK_GLOBALS.every((name) => hasGlobalFunction(boot, name))) return undefined;
    const errors = boot.errorCount;
    const diagnostics = boot.bridge.diagnostics.length;
    const probe = frameXmlSilentProbe(boot, "webclient/token-gate", `
      if type(TokenFrameContainer.buttons) ~= "table" then return -1, false, 0, 0 end
      TokenFrame_Update()
      BackpackTokenFrame_Update()
      return GetCurrencyListSize(), CharacterFrameTab5:IsShown() and true or false,
        #TokenFrameContainer.buttons, GetNumWatchedTokens()
    `, 4);
    if (!probe) return undefined;
    const rows = Number(probe[0]);
    const tabShown = probe[1] === true;
    const buttons = Number(probe[2]);
    const watched = Number(probe[3]);
    if (!Number.isInteger(rows) || rows < 0 || tabShown !== rows > 0 || !(buttons > 0) || !Number.isInteger(watched)
      || boot.errorCount !== errors || boot.bridge.diagnostics.length !== diagnostics) return undefined;
    return { rows, tabShown, buttons, watched };
  } catch {
    return undefined;
  }
}

export type FrameXmlTokenState = "idle" | "loading" | "ready" | "failed";

export interface FrameXmlTokenOwner {
  /** Start the one load; later calls change nothing. */
  begin(): void;
  readonly state: FrameXmlTokenState;
  /** Resolves when the load in flight has settled (at once when none is). */
  settled(): Promise<void>;
  dispose(): void;
}

export interface FrameXmlTokenOwnerOptions {
  readonly seam: TokenSeam;
  readonly boot: Pick<FrameXmlBoot, "loadAddon" | "vm" | "bridge" | "errorCount">;
  readonly renderer: Pick<FrameXmlDomRenderer, "addRoots" | "sync">;
  /** Told once, with the reason, when the add-on is demoted. */
  readonly onFailure?: (reason: string) => void;
}

/** A failed or disposed owner: tab 5 hidden, so nothing can select the add-on's frame. */
function hideTab(boot: GateBoot): void {
  frameXmlSilentProbe(boot, "webclient/token-hide", `
    if CharacterFrameTab5 then CharacterFrameTab5:Hide() end
    if BackpackTokenFrame and BackpackTokenFrame.Hide then BackpackTokenFrame:Hide() end
  `, 0);
}

export function createLazyFrameXmlTokenOwner(options: FrameXmlTokenOwnerOptions): FrameXmlTokenOwner {
  const { seam, boot, renderer } = options;
  let state: FrameXmlTokenState = "idle";
  let disposed = false;
  let pending: Promise<void> | undefined;

  const fail = (reason: string): void => {
    if (disposed || state === "failed") return;
    state = "failed";
    try { hideTab(boot); } catch { /* the events stay held below either way */ }
    try { options.onFailure?.(reason); } catch { /* reporting only */ }
  };
  const load = async (): Promise<void> => {
    try {
      const result = await boot.loadAddon(FRAMEXML_TOKEN_ADDON);
      if (disposed || state !== "loading") return;
      if (!result.ok) { fail(`${FRAMEXML_TOKEN_ADDON}: ${result.message ?? result.status}`); return; }
      // TokenFrame hangs from CharacterFrame and BackpackTokenFrame from UIParent; only a parentless
      // root would draw at the top level. The renderer builds the children when they are next shown.
      renderer.addRoots(result.roots.filter((root) => root.parent === undefined));
      // BackpackTokenFrame has no `hidden` and no anchor (Blizzard_TokenUI.xml:462); the client never
      // draws an unanchored frame, and stock's own ManageBackpackTokenFrame decides it from here:
      // hidden with no backpack open or nothing watched (Blizzard_TokenUI.lua:231-249).
      frameXmlSilentProbe(boot, "webclient/token-manage", "ManageBackpackTokenFrame()", 0);
      renderer.sync();
      const gate = frameXmlTokenGate(seam, boot);
      if (disposed || state !== "loading") return;
      if (!gate) { fail(`${FRAMEXML_TOKEN_ADDON} did not pass its gate`); return; }
      state = "ready";
      seam.currency?.release();
    } catch (error) {
      fail(`${FRAMEXML_TOKEN_ADDON} failed: ${String(error)}`);
    }
  };

  return {
    get state() { return state; },
    begin: () => {
      if (disposed || state !== "idle") return;
      state = "loading";
      pending = load().finally(() => { pending = undefined; });
    },
    settled: () => pending ?? Promise.resolve(),
    dispose: () => { disposed = true; },
  };
}

/**
 * Point stock `TokenFrame_LoadUI` at the owner: a microtask later — never inside the event dispatch
 * that called it — `begin` runs. False when UIParent.lua's function is not there to replace.
 */
export function installFrameXmlTokenLoadUI(boot: Pick<FrameXmlBoot, "vm">, begin: () => void): boolean {
  boot.vm.registerGlobal(LOAD_GLOBAL, () => {
    queueMicrotask(() => {
      try { begin(); } catch (error) { console.warn(`[FrameXML currency] ${String(error)}`); }
    });
    return [];
  });
  const probe = frameXmlSilentProbe(boot, "webclient/token-hook", `
    if type(TokenFrame_LoadUI) ~= "function" or type(CharacterFrame) ~= "table" then return false end
    local load = ${LOAD_GLOBAL}
    TokenFrame_LoadUI = function() load() end
    return true
  `, 1);
  return probe?.[0] === true;
}

export interface FrameXmlTokenMountOptions {
  /** Where `/dbc/currencies` is served; absent, the model keeps whatever catalog it already has. */
  readonly gatewayOrigin?: string;
}

/**
 * The world mount's one call, made once the stock CharacterFrame owner is published: the catalog
 * client, the owner, its `TokenFrame_LoadUI`, and the model's demand hook. Returns the cleanup, or
 * undefined when the seam has no currency model or UIParent.lua's loader is absent.
 */
export function mountFrameXmlToken(
  seam: TokenSeam,
  boot: Pick<FrameXmlBoot, "loadAddon" | "vm" | "bridge" | "errorCount">,
  renderer: Pick<FrameXmlDomRenderer, "addRoots" | "sync">,
  options: FrameXmlTokenMountOptions = {},
): { readonly owner: FrameXmlTokenOwner; readonly cleanup: () => void } | undefined {
  const model = seam.currency;
  if (!model) return undefined;
  if (options.gatewayOrigin !== undefined && !model.catalogSource) {
    model.catalogSource = new FrameXmlCurrencyCatalogClient(options.gatewayOrigin);
  }
  const owner = createLazyFrameXmlTokenOwner({
    seam, boot, renderer,
    onFailure: (reason) => console.warn(`[FrameXML currency] ${reason}; the currency tab stays hidden`),
  });
  if (!installFrameXmlTokenLoadUI(boot, () => owner.begin())) return undefined;
  model.onDemand = () => owner.begin();
  // A player who already knows a currency asks at once; otherwise the seam's tick asks later.
  model.tick();
  return {
    owner,
    cleanup: () => {
      if (model.onDemand) model.onDemand = undefined;
      owner.dispose();
    },
  };
}
