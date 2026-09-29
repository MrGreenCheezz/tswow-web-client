/**
 * The world mount's half of the stock trade skill window (FrameXmlTradeSkill.ts): the facts only the
 * mount has — `/dbc/talents`' profession tables, the `ItemSubClass` words and the native craft queue
 * of `ui/Professions.ts` — and the lazy owner wired to the native profession window.
 */
import { game } from "../game/Context.js";
import {
  castProfessionRecipeOnItem, craftProfessionRecipe, hideProfessionWindows, nativeProfessionOpen, openNativeProfession,
  professionCraftRemaining, stopProfessionCraftRepeat,
} from "../ui/Professions.js";
import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import type { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import {
  createFrameXmlSubclassNames,
  type FrameXmlTradeSkillCraft, type FrameXmlTradeSkillLiveHost, type FrameXmlTradeSkillModel,
} from "./FrameXmlTradeSkill.js";
import { createLazyFrameXmlTradeSkillOwner } from "./FrameXmlTradeSkillOwner.js";
import { publishFrameXmlTradeSkill, type FrameXmlTradeSkillOwner } from "./FrameXmlTradeSkillController.js";

/** The native queue as the stock window drives it. */
export const FRAMEXML_LIVE_TRADESKILL_CRAFT: FrameXmlTradeSkillCraft = Object.freeze({
  craft: craftProfessionRecipe,
  castOnItem: castProfessionRecipeOnItem,
  stop: stopProfessionCraftRepeat,
  remaining: professionCraftRemaining,
});

/** The host LiveWorldSeam's trade skill model reads (`LiveWorldSeamContext.tradeSkill`). */
export function frameXmlLiveTradeSkillHost(): FrameXmlTradeSkillLiveHost {
  return {
    professionData: () => game.talentData,
    subclassName: createFrameXmlSubclassNames(() => game.gatewayOrigin),
    craft: FRAMEXML_LIVE_TRADESKILL_CRAFT,
    spells: () => game.spells,
  };
}

export interface FrameXmlTradeSkillMount {
  readonly owner: FrameXmlTradeSkillOwner;
  /** Publish the owner; the returned cleanup unpublishes and disposes it (idempotent). */
  publish(): () => void;
}

/** The body class style.css draws the cast cursor for, and the custom property holding its picture. */
export const FRAMEXML_CAST_CURSOR_CLASS = "framexml-cast-cursor";
export const FRAMEXML_CAST_CURSOR_PROPERTY = "--framexml-cast-cursor";
/**
 * The client's own spell cursor: 32x32 on this client (measured through the gateway's `/texture`,
 * 2,501 bytes of PNG), with the gauntlet's fingertip — its hotspot — on pixel 0,0 (the first opaque
 * pixel, measured). Until it arrives, and if it never does, the stylesheet's crosshair stands in.
 */
const CAST_CURSOR_TEXTURE = "Interface\\Cursor\\Cast.blp";

/**
 * The enchant cursor on screen: while DoTradeSkill's enchant waits for its item the stock bags and
 * paper doll show the cast cursor, as the client's spell targeting does. The picture is asked for on
 * the first enchant, never at boot.
 */
export function createFrameXmlCastCursor(
  textureUrl: ((path: string) => string) | undefined,
  fetcher: typeof fetch = (input, init) => fetch(input, init),
): { show(armed: boolean): void; dispose(): void } {
  let requested = false;
  let disposed = false;
  let picture: string | undefined;
  const root = (): HTMLElement | undefined => typeof document === "undefined" ? undefined : document.documentElement;
  const load = async (): Promise<void> => {
    try {
      const response = await fetcher(textureUrl!(CAST_CURSOR_TEXTURE));
      if (!response.ok) throw new Error(`the cast cursor answered ${response.status}`);
      const blob = await response.blob();
      if (disposed) return;
      picture = URL.createObjectURL(blob);
      root()?.style?.setProperty(FRAMEXML_CAST_CURSOR_PROPERTY, `url("${picture}") 0 0, crosshair`);
    } catch {
      // The next enchant asks again; the crosshair shows meanwhile.
      requested = false;
    }
  };
  return {
    show(armed) {
      if (disposed || typeof document === "undefined") return;
      document.body?.classList?.toggle(FRAMEXML_CAST_CURSOR_CLASS, armed);
      if (!armed || requested || !textureUrl) return;
      requested = true;
      void load();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (typeof document === "undefined") return;
      document.body?.classList?.toggle(FRAMEXML_CAST_CURSOR_CLASS, false);
      root()?.style?.removeProperty(FRAMEXML_CAST_CURSOR_PROPERTY);
      if (picture) URL.revokeObjectURL(picture);
      picture = undefined;
    },
  };
}

/**
 * The lazy stock owner in front of the native profession window. A failed load or gate unpublishes
 * it, and the line the player wanted opens natively. `textureUrl` is the mount's `/texture` route,
 * for the cast cursor's picture.
 */
export function mountFrameXmlTradeSkill(
  seam: { readonly tradeSkill?: FrameXmlTradeSkillModel | undefined },
  boot: FrameXmlBoot,
  renderer: FrameXmlDomRenderer,
  textureUrl?: (path: string) => string,
): FrameXmlTradeSkillMount | undefined {
  const model = seam.tradeSkill;
  if (!model) return undefined;
  let cleanup: (() => void) | undefined;
  const owner = createLazyFrameXmlTradeSkillOwner({
    seam, boot, renderer,
    native: { open: openNativeProfession, stepAside: hideProfessionWindows, isOpen: nativeProfessionOpen },
    onFailure: () => {
      console.warn("[FrameXML trade skill] Blizzard_TradeSkillUI not published; the native profession window stays");
      cleanup?.();
    },
  });
  return {
    owner,
    publish: () => {
      if (!cleanup) {
        const unpublish = publishFrameXmlTradeSkill(owner);
        const cursor = createFrameXmlCastCursor(textureUrl);
        const unobserve = model.observeTargeting((armed) => cursor.show(armed));
        cleanup = () => {
          unobserve();
          cursor.dispose();
          unpublish();
        };
      }
      return () => cleanup?.();
    },
  };
}
