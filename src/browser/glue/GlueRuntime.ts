import { FrameXmlUiBridge } from "../ui/framexml_compat/FrameXmlRuntime.js";
import { FrameXmlTemplateRegistry } from "../ui/framexml_compat/FrameXmlParser.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";
import { GlueLuaRef, GlueLuaVm, type GlueLuaOptions } from "./GlueLua.js";
import { GlueWidgetBinder } from "./GlueWidgets.js";
import { GlueApi, type GlueApiOptions } from "./GlueApi.js";
import type { GlueSession } from "./GlueSession.js";
import { GlueLoader, type GlueFileProvider, type GlueLoadResult } from "./GlueLoader.js";
import { hideGlueLoginControls } from "./GlueLoginScenePolicy.js";
import { resizeAuthoredLoginScene } from "./GlueLoginLayout.js";

/**
 * The glue screen's logical coordinate system.
 *
 * Measured, not assumed: `GlueParent.xml` declares `setAllPoints="true"` with
 * no size at all, and `GlueParent_OnLoad` reads `GetScreenWidth()/
 * GetScreenHeight()` and only pillarboxes itself when the ratio exceeds 16:9.
 * So the original is **not** a 1024x768 letterbox — height is the fixed axis at
 * 768 UI units and width follows the viewport's aspect (1024 at 4:3, 1365.33 at
 * 16:9). Everything else is anchored to edges or to the centre and adapts.
 *
 * Hence: 768 is the fixed axis. Normal and wide windows follow their mode instead of forcing a
 * 1024x768 box; narrow windows keep 1024 logical units and scroll so their panels cannot collide.
 * How the 768 units reach the viewport is `glueStageMapping`.
 */
export const GLUE_LOGICAL_HEIGHT = 768;
/** The narrowest authored mode with a verified, non-overlapping character creation layout. */
export const GLUE_MIN_LOGICAL_WIDTH = 1024;

export interface GlueViewportMetrics {
  readonly scale: number;
  readonly virtualWidth: number;
  readonly virtualHeight: number;
}

export function glueViewportMetrics(width: number, height: number): GlueViewportMetrics {
  const safeHeight = Number.isFinite(height) && height > 0 ? height : GLUE_LOGICAL_HEIGHT;
  const safeWidth = Number.isFinite(width) && width > 0 ? width : GLUE_LOGICAL_HEIGHT * (4 / 3);
  const scale = safeHeight / GLUE_LOGICAL_HEIGHT;
  return {
    scale,
    virtualWidth: safeWidth / scale,
    virtualHeight: GLUE_LOGICAL_HEIGHT,
  };
}

/**
 * The widest shape the glue screens are ever laid out in: 16:9, the corpus' own limit.
 *
 * `GlueParent_OnLoad` (stock, quoted at `glueStageMapping`) refuses to be wider than this and
 * pillarboxes itself when the screen is. A display *mode* wider than 16:9 is therefore not a thing
 * the corpus has a layout for, which is what makes this a cap and not a preference.
 */
export const GLUE_MAX_ASPECT = 16 / 9;

/** How the 768-unit-tall glue screen is mapped onto a browser viewport. */
export interface GlueStageMapping {
  /** Horizontal viewport pixels per UI unit. */
  readonly scaleX: number;
  /** Vertical viewport pixels per UI unit. */
  readonly scaleY: number;
  /** The width `GetScreenWidth()` answers, in UI units; a narrow window scrolls this canvas. */
  readonly virtualWidth: number;
  /** Always `GLUE_LOGICAL_HEIGHT`; the axis the client fixes. */
  readonly virtualHeight: number;
}

/**
 * The glue screen's own display mode, and the monitor that stretches it.
 *
 * Two separate things, and keeping them separate is the whole of this function.
 *
 * **The mode.** Measured on the clean corpus (`F:/CircleClean`, `Interface\GlueXML\GlueParent.lua`
 * out of `patch-ruRU-3.MPQ`, 16 897 B, sha1 `f6bfb7e58d068fd4dab3c6b9f1a72034b96872fe` — the same
 * bytes the owner's patched chain serves, so the pillarbox is Blizzard's and not a module's):
 *
 * ```lua
 * function GlueParent_OnLoad(self)
 *     local width = GetScreenWidth();
 *     local height = GetScreenHeight();
 *     if ( width / height > 16 / 9) then
 *         local maxWidth = height * 16 / 9;
 *         local barWidth = ( width - maxWidth ) / 2;
 *         self:ClearAllPoints();
 *         self:SetPoint("TOPLEFT", barWidth, 0);
 *         self:SetPoint("BOTTOMRIGHT", -barWidth, 0);
 *     end
 * ```
 *
 * That branch is only reachable if `GetScreenWidth()/GetScreenHeight()` carry the real aspect, so
 * the client's glue space is height-fixed at 768 with the width following the mode — not a 1024x768
 * box. `UIParent.lua` says the same thing twice over: `GetScreenWidthScale()` divides by 1024 and
 * `GetScreenHeightScale()` divides by 768 as **two** functions, which is only meaningful when the
 * two axes scale by different amounts.
 *
 * **The monitor.** A display mode is then stretched to whatever panel it is shown on, and that is
 * where the owner's «в оригинале растянуто» comes from: a 4:3 mode on a 16:9 panel is the classic
 * stretched-wide login screen. Nothing about it is the client's doing.
 *
 * So the mode is capped at 16:9 — the corpus refuses to lay out wider — and the result is stretched
 * to fill ordinary and wide viewports, exactly as a panel does. At every aspect **at or below** 16:9 the scales
 * are equal. If that would squeeze the authored screen below its verified 1024-unit layout, the
 * canvas stays 1024 units wide and the host scrolls horizontally; shrinking the controls further
 * makes the character creation panels overlap. Past 16:9 the screen is stretched instead of being
 * given black bars — measured at the owner's maximised 1920x969, where the stock pillarbox took
 * 78.2 UI units off each side and put a 99 px black bar down both edges of a window their real client fills.
 */
export function glueStageMapping(width: number, height: number): GlueStageMapping {
  const safeHeight = Number.isFinite(height) && height > 0 ? height : GLUE_LOGICAL_HEIGHT;
  const safeWidth = Number.isFinite(width) && width > 0 ? width : GLUE_LOGICAL_HEIGHT * (4 / 3);
  const scaleY = safeHeight / GLUE_LOGICAL_HEIGHT;
  const uncapped = safeWidth / scaleY;
  const fittedWidth = Math.min(uncapped, GLUE_LOGICAL_HEIGHT * GLUE_MAX_ASPECT);
  const virtualWidth = Math.max(GLUE_MIN_LOGICAL_WIDTH, fittedWidth);
  return {
    // Below the cap the horizontal scale is *the same number* rather than one that agrees to
    // fifteen decimal places. The same rule keeps controls readable when the minimum canvas
    // scrolls: squeezing it back to the viewport would recreate the character-panel overlap.
    scaleX: virtualWidth >= uncapped ? scaleY : safeWidth / virtualWidth,
    scaleY,
    virtualWidth,
    virtualHeight: GLUE_LOGICAL_HEIGHT,
  };
}

/** A minimum-width stage needs a scrollbar; ordinary and wide stages must never show one. */
export function glueNeedsHorizontalScroll(width: number, height: number): boolean {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return false;
  const mapping = glueStageMapping(width, height);
  return mapping.virtualWidth * mapping.scaleX > width + 0.5;
}

/** A box in UI units, the pair `GetSize()` answers with. */
export interface GlueBox {
  readonly width: number;
  readonly height: number;
}

type AnchorAxis = { readonly x: "LEFT" | "CENTER" | "RIGHT"; readonly y: "TOP" | "CENTER" | "BOTTOM" };

function anchorAxis(name: string): AnchorAxis {
  const upper = name.toUpperCase();
  return {
    x: upper.includes("LEFT") ? "LEFT" : upper.includes("RIGHT") ? "RIGHT" : "CENTER",
    y: upper.includes("TOP") ? "TOP" : upper.includes("BOTTOM") ? "BOTTOM" : "CENTER",
  };
}

/**
 * How big a frame is **before** the document exists to be measured.
 *
 * This is not a convenience: the glue screens lay themselves out inside `OnLoad`, which runs while
 * the TOC is still being walked and the roots have not been mounted, and the very first thing the
 * owner's login module does is `local width, height = GlueParent:GetSize()` (`lgzg.lua:210`). The
 * answer sizes `LoginScene`, and `LoginScene` sizes the background plate and **every one of the
 * thirty-two model widgets** (`mod:SetSize(LoginScene:GetWidth() / wSquish, …)`).
 *
 * The old fallback answered any `setAllPoints` frame with the whole stage. That is right at 16:9
 * and wrong at every aspect wider than it, because by the time the question is asked `GlueParent`
 * has already pillarboxed itself: `GlueParent_OnLoad` (`GlueParent.lua:174-184`) reads
 * `GetScreenWidth()/GetScreenHeight()` and, past 16:9, does `ClearAllPoints()` followed by
 * `SetPoint("TOPLEFT", barWidth, 0)` and `SetPoint("BOTTOMRIGHT", -barWidth, 0)`. Those two anchors
 * are the frame's real box and the stage is not.
 *
 * Worked through at a maximised 1920x1080 browser (viewport 1920x969 after the chrome): the stage
 * is 1521.7 x 768 UI units, `barWidth` is 78.2, and `GlueParent` is 1365.3 wide — while the old
 * fallback answered 1522. The login scene then came out 156 units wider than the screen it is
 * centred in, its background plate was cropped by 5.7 % on each side, and every model widget was
 * built at aspect 1.98 instead of 1.78, which moves what a 45° vertical frustum puts on screen.
 * That is the "logo and buttons all over the place" the owner is looking at, and it does not
 * reproduce at 1366x768 or 1280x720 because both of those are 16:9 and `barWidth` is 0.
 *
 * The rule: a frame pinned on both edges of an axis measures its parent minus the two offsets;
 * otherwise its declared size; otherwise, for `setAllPoints`, its parent. Anchors that name another
 * frame are skipped — nothing can be measured about them before layout — which is what keeps this
 * to the chain of screen-filling frames it exists for.
 */
export function gluePinnedSize(
  frame: FrameXmlFrame,
  stage: GlueBox,
  depth = 0,
): GlueBox | undefined {
  // A cycle would be a broken tree, and the corpus' deepest screen-filling chain is three.
  const parent = depth < 16 && frame.parent
    ? gluePinnedSize(frame.parent, stage, depth + 1) ?? stage
    : stage;
  let left: number | undefined;
  let right: number | undefined;
  let top: number | undefined;
  let bottom: number | undefined;
  for (const point of frame.points) {
    // Only anchors to the containing block itself: a sibling has no box yet either.
    if (point.relativeTo !== undefined && point.relativeTo !== frame.parent) continue;
    const own = anchorAxis(point.point);
    const target = anchorAxis(point.relativePoint ?? point.point);
    const targetX = target.x === "LEFT" ? 0 : target.x === "RIGHT" ? parent.width : parent.width / 2;
    const targetY = target.y === "TOP" ? 0 : target.y === "BOTTOM" ? parent.height : parent.height / 2;
    const edgeX = targetX + (point.x ?? 0);
    // FrameXML's positive Y points up; these boxes are measured downward from the top.
    const edgeY = targetY - (point.y ?? 0);
    if (own.x === "LEFT") left = edgeX;
    else if (own.x === "RIGHT") right = edgeX;
    if (own.y === "TOP") top = edgeY;
    else if (own.y === "BOTTOM") bottom = edgeY;
  }
  const declaredWidth = Number(frame.attributes["width"]);
  const declaredHeight = Number(frame.attributes["height"]);
  const width = left !== undefined && right !== undefined ? right - left
    : Number.isFinite(declaredWidth) && declaredWidth > 0 ? declaredWidth
      : frame.setAllPoints ? parent.width : undefined;
  const height = top !== undefined && bottom !== undefined ? bottom - top
    : Number.isFinite(declaredHeight) && declaredHeight > 0 ? declaredHeight
      : frame.setAllPoints ? parent.height : undefined;
  if (width === undefined || height === undefined) return undefined;
  return { width, height };
}

export interface GlueRuntimeOptions {
  readonly provider: GlueFileProvider;
  readonly lua?: GlueLuaOptions;
  readonly api?: Omit<GlueApiOptions, "vm" | "bridge">;
  /** Reported once per widget method or C-API global that only recorded. */
  readonly onStub?: (kind: "method" | "global", name: string) => void;
}

/**
 * One glue session: VM, widget bridge, C-API and loader, wired in the only
 * order that works.
 *
 * The VM must exist before the bridge can compile a script body, the bridge
 * must exist before the widget binder can expose a frame, and the C-API needs
 * both. Constructing them separately at every call site is how that order gets
 * broken, so it is done exactly once, here.
 */
export class GlueRuntime {
  readonly vm: GlueLuaVm;
  readonly bridge: FrameXmlUiBridge;
  readonly binder: GlueWidgetBinder;
  readonly api: GlueApi;
  readonly loader: GlueLoader;
  #result: GlueLoadResult | undefined;

  constructor(options: GlueRuntimeOptions) {
    this.vm = new GlueLuaVm(options.lua ?? {});
    this.bridge = new FrameXmlUiBridge(new FrameXmlTemplateRegistry(), {
      // `text="MANAGE_ACCOUNT"` in XML is a GlobalString key; GlueStrings.lua
      // has already run by the time any XML is parsed, so the VM is the table.
      globalStringResolver: (key) => this.vm.globalString(key),
    });
    this.binder = new GlueWidgetBinder(this.vm, this.bridge, {
      ...(options.onStub ? { onStub: (name: string) => options.onStub?.("method", name) } : {}),
    });
    this.bridge.setRuntime(this.binder);
    this.api = new GlueApi({
      vm: this.vm,
      bridge: this.bridge,
      ...options.api,
      ...(options.onStub ? { onStub: (name: string) => options.onStub?.("global", name) } : {}),
    });
    this.api.install();
    this.loader = new GlueLoader({ vm: this.vm, bridge: this.bridge, provider: options.provider });
  }

  async load(tocPath?: string): Promise<GlueLoadResult> {
    this.#result = await this.loader.load(tocPath);
    // The stock login XML declares these optional controls visible. Apply the browser's explicit
    // login policy after the complete TOC walk, before any caller can show a screen; other screen
    // trees and the account fields remain untouched because the policy requires AccountLogin ancestry.
    hideGlueLoginControls(this.bridge);
    return this.#result;
  }

  get result(): GlueLoadResult | undefined {
    return this.#result;
  }

  get roots(): readonly FrameXmlFrame[] {
    return this.#result?.roots ?? [];
  }

  /** The account, realm list, world connection and character list this page is showing. */
  get session(): GlueSession {
    return this.api.session;
  }

  /** Resize the login module's already-created scene without replaying its OnLoad side effects. */
  resizeLoginScene(virtualWidth: number): boolean {
    const value = this.vm.getGlobal("LoginScene");
    if (value instanceof GlueLuaRef) {
      this.vm.release(value);
      return false;
    }
    return value && typeof value === "object"
      ? resizeAuthoredLoginScene(this.bridge, value as FrameXmlFrame, virtualWidth)
      : false;
  }

  /** Advance OnUpdate by `elapsedSeconds`, the unit 3.3.5 hands the corpus. */
  tick(elapsedSeconds: number): number {
    return this.bridge.tick(elapsedSeconds);
  }

  close(): void {
    this.api.cancelLogin();
    // The world socket belongs to this runtime and to nothing else, so it goes with it.
    this.api.session.close();
    this.vm.close();
  }
}
