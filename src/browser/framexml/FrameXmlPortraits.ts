/**
 * Stock `SetPortraitTexture(texture, unit)` for every window that is not a HUD unit frame.
 *
 * The client draws the named unit's head into the Texture: GossipFrame, BankFrame and TaxiFrame
 * name "npc", MerchantFrame and TradeFrame's recipient "NPC", TradeFrame's own side and PVPFrame
 * "player", ReadyCheck its initiator, the load-on-demand trainer "npc", the talent frame
 * "player"/"pet" and CharacterMicroButton its MicroButtonPortrait "player" (on PLAYER_ENTERING_WORLD
 * and UNIT_PORTRAIT_UPDATE, MainMenuBarMicroButtons.lua:142-146). A Texture is an `<img>` in the
 * DOM renderer and cannot hold a 3D render. The client's call replaces the Texture's picture, so
 * the host puts the client's own «portrait not available» art there (the fallback, as
 * QuestFramePortrait gets its book) and lays a canvas over it that the world's PortraitRenderer
 * paints once per unit.
 *
 * The canvas is the Texture's twin in everything the DOM renderer writes on the `<img>`: its
 * geometry, its opacity and its TexCoords crop. The micro-button is the one portrait with a crop —
 * 0.2..0.8 × 0.0666..0.9 of the picture at rest, 0.2666..0.8666 × 0..0.8333 at half alpha while
 * CharacterFrame is open (CharacterMicroButton_SetPushed/SetNormal) — and the stage stylesheet's
 * `[data-framexml-texcoords]` rule crops a canvas exactly as it crops the picture (measured:
 * `object-view-box` applies to `<canvas>` in this Chromium).
 *
 * The lifetime follows the stock code rather than a window list: a claim exists from the
 * SetPortraitTexture call until Lua puts a picture of its own in that Texture (GossipFrame's book
 * for a game object) or names a unit with no model; the renderer surface behind it exists only
 * while the Texture is shown. Repeated calls for the same unit — MerchantFrame_UpdateMerchantInfo
 * on every MERCHANT_UPDATE, TradeFrame_Update on every item change — change nothing and cost one
 * lookup. With no claimed portrait on screen the host is not even subscribed to the bridge.
 */
import { unit as unitField } from "../../world/Fields.js";
import type { WorldClient } from "../../world/WorldClient.js";
import { setPortraitCanvasBackingStore } from "../PortraitCanvas.js";
import {
  stockPortraitTargets, type StockPortraitSlot, type StockPortraitTargets,
} from "../PortraitRenderer.js";
import type { FrameXmlMutationKind, MutableFrameXmlFrame } from "../ui/framexml_compat/FrameXmlRuntime.js";
import type { FrameXmlFrame, FrameXmlTexCoords } from "../ui/framexml_compat/FrameXmlTypes.js";
import { liveFrameXmlInteractionNpc } from "./FrameXmlGossipLive.js";
import { FRAMEXML_NPC_PORTRAIT_STAND_IN } from "./FrameXmlGossipOwner.js";
import type { FrameXmlWorldSeam } from "./FrameXmlWorldSeam.js";

/**
 * Textures a dedicated slot already paints, whatever stock Lua asks of them: the unit frames'
 * portraits (UnitFrame_Update calls SetPortraitTexture(self.portrait, self.unit) for all of them,
 * FocusFrameToT's "focus-target" row included) and CharacterFramePortrait's and QuestFramePortrait's
 * header busts. A second canvas here would paint the same head twice. MicroButtonPortrait is not
 * one of them: listed here without a slot of its own, the «Персонаж» button's face stayed blank
 * (measured offline: a 17x23 Texture with no picture and no canvas), so its stock call is an
 * ordinary claim.
 */
export const FRAMEXML_DEDICATED_PORTRAIT_TEXTURES: ReadonlySet<string> = new Set([
  "PlayerPortrait", "TargetFramePortrait", "TargetFrameToTPortrait", "FocusFramePortrait",
  "FocusFrameToTPortrait", "PetPortrait", "PartyMemberFrame1Portrait", "PartyMemberFrame2Portrait",
  "PartyMemberFrame3Portrait", "PartyMemberFrame4Portrait", "CharacterFramePortrait",
  "QuestFramePortrait",
]);

/** `TYPEID_UNIT`/`TYPEID_PLAYER` (ObjectGuid.h): the objects that have a unit model to draw. */
const TYPEID_UNIT = 3;
const TYPEID_PLAYER = 4;

type PortraitWorld = Pick<WorldClient, "state" | "tradeOpen" | "tradePartnerGuid" | "vendor"
  | "trainer" | "auctioneerGuid" | "gossip" | "taxiMenu" | "bankerGuid">;

/**
 * The unit the stock "npc" token names while an interaction is open, in the order
 * `LiveWorldSeam.unitName("npc")` resolves it: the trade partner (TradeFrame_Update's
 * UnitName("NPC")), the vendor, the trainer, the auctioneer, then the conversation, flight master
 * or banker (`liveFrameXmlInteractionNpc`).
 */
export function frameXmlInteractionNpcGuid(world: PortraitWorld): bigint | undefined {
  if (world.tradeOpen && world.tradePartnerGuid !== 0n) return world.tradePartnerGuid;
  const guid = world.vendor?.guid ?? world.trainer?.guid
    ?? (world.auctioneerGuid !== 0n ? world.auctioneerGuid : undefined)
    ?? liveFrameXmlInteractionNpc(world as WorldClient);
  return guid === undefined || guid === 0n ? undefined : guid;
}

/**
 * A GUID only when it names an object in view with a unit model: a creature or a player whose
 * UNIT_FIELD_DISPLAYID is set. A mailbox, a chest or a lectern's gossip is a game object — the
 * client leaves the stock picture there (its icon, or GossipFrame's book), and so does this.
 */
function portraitUnit(world: PortraitWorld, guid: bigint | undefined): bigint | undefined {
  if (guid === undefined || guid === 0n) return undefined;
  const object = world.state.objects.get(guid);
  if (!object || (object.typeId !== TYPEID_UNIT && object.typeId !== TYPEID_PLAYER)) return undefined;
  return (unitField.displayId(object) ?? 0) > 0 ? guid : undefined;
}

/** `frameXmlGuid`'s `0x%016x` text back to the wire value; anything else names no unit. */
function parseFrameXmlGuid(text: string | undefined): bigint | undefined {
  if (!text || !/^0x[0-9a-f]{1,16}$/i.test(text)) return undefined;
  return BigInt(text);
}

/**
 * The unit a stock `SetPortraitTexture` names, as a GUID PortraitRenderer can draw. "questnpc" is
 * the quest page's giver (already display-checked by the seam), "npc" the interaction above, and
 * every other token — "player", "target", "pet", "focus", "party1".."party4", a ready-check
 * initiator — whatever `UnitGUID` answers for it.
 */
export function frameXmlPortraitUnitGuid(
  world: PortraitWorld | undefined,
  seam: Pick<FrameXmlWorldSeam, "questNpcPortraitGuid" | "unitGuid">,
  unit: string,
): bigint | undefined {
  if (!world) return undefined;
  const token = unit.toLowerCase();
  if (token === "questnpc") return seam.questNpcPortraitGuid();
  if (token === "npc") return portraitUnit(world, frameXmlInteractionNpcGuid(world));
  return portraitUnit(world, parseFrameXmlGuid(seam.unitGuid?.(token)));
}

/**
 * What of the bridge the host reads: visibility, the layout revision and its change stream while a
 * portrait is shown, and OnShow/OnHide of a portrait's window for when none is. It writes one
 * thing, the claimed Texture's picture (`SetTexture`, and the portrait crop a plain picture drops).
 */
export interface FrameXmlStockPortraitBridge {
  readonly layoutVersion: number;
  isVisible(frame: FrameXmlFrame): boolean;
  subscribe(listener: () => void): () => void;
  HookScript(frame: FrameXmlFrame, script: string, handler: (self: FrameXmlFrame) => void): boolean;
  SetTexture(frame: FrameXmlFrame, texture: string): boolean;
  update(frame: FrameXmlFrame, mutate: (frame: MutableFrameXmlFrame) => void, kind?: FrameXmlMutationKind): boolean;
}

export interface FrameXmlStockPortraitOptions {
  readonly bridge: FrameXmlStockPortraitBridge;
  /** The DOM renderer's element for a widget; undefined until it has drawn it. */
  readonly elementFor: (frame: FrameXmlFrame) => HTMLElement | undefined;
  /** A unit token to a drawable GUID; `frameXmlPortraitUnitGuid` over the live world. */
  readonly resolve: (unit: string) => bigint | undefined;
  /** The renderer's stock target set; the live one unless a test isolates it. */
  readonly targets?: StockPortraitTargets;
  readonly document?: Pick<Document, "createElement">;
  /** Runs the reconciliation after the current bridge notification; a test may run it inline. */
  readonly schedule?: (task: () => void) => void;
  /**
   * Subscribes to the stage being drawn at another scale — a window resize, the UI-scale setting —
   * which changes no frame and raises no bridge notification. Held only while a claimed portrait
   * is shown; each change is one layout read per shown portrait.
   */
  readonly watchScale?: (listener: () => void) => () => void;
}

export interface FrameXmlStockPortraits {
  /** The host half of stock `SetPortraitTexture` for one Texture; `unit` is already lower case. */
  setPortraitTexture(texture: FrameXmlFrame, unit: string): void;
  /** Textures currently claimed, shown or not. */
  readonly claims: number;
  /** Claims whose canvas is in the renderer's target set (shown Textures). */
  readonly active: number;
  dispose(): void;
}

/**
 * `active`: shown, canvas in the renderer's set. `waiting`: shown, but the DOM renderer has not
 * drawn the Texture yet (a load-on-demand root before `addRoots`). `dormant`: its window is closed.
 */
type StockPortraitState = "active" | "waiting" | "dormant";

interface StockPortraitClaim {
  readonly texture: FrameXmlFrame;
  readonly slot: StockPortraitSlot;
  guid: bigint;
  /**
   * `texture.texture` once the claim put its stand-in there: any other is Lua's own picture — even
   * one the Texture already held before the claim, such as GossipFrame's book put back for a chest.
   */
  picture: string;
  canvas: HTMLCanvasElement | undefined;
  state: StockPortraitState;
  /** The authored square size the backing store was last measured for. */
  authored: number | undefined;
  /** The crop inset the backing store was last measured for ("" for an uncropped picture). */
  crop: string;
  /**
   * The Texture's TexCoords and alpha as last mirrored onto the canvas. `SetTexCoord`/`SetAlpha`
   * are paint-only mutations, which bump no layout revision; these two identities are what the
   * per-notification watch compares instead.
   */
  texCoords: FrameXmlTexCoords | undefined;
  alpha: number | undefined;
}

/** The inline properties FrameXmlDomRenderer.applyGeometry/applyFrame writes on a Texture. */
const COPIED_STYLES = [
  "position", "left", "right", "top", "bottom", "width", "height", "transform", "transformOrigin",
  "translate", "zIndex", "opacity",
] as const;

function cssPixels(value: string | undefined): number | undefined {
  const match = value ? /^\s*(\d+(?:\.\d+)?)px\s*$/i.exec(value) : null;
  const pixels = match ? Number(match[1]) : Number.NaN;
  return Number.isFinite(pixels) && pixels > 0 ? pixels : undefined;
}

/**
 * The inset FrameXmlDomRenderer publishes for a Texture's TexCoords, spelled the same way so the
 * stylesheet crops the canvas as it crops the picture: an unordered rectangle (PlayerFrameTexture's
 * reversed U range mirrors through the copied `transform`, not through the inset).
 */
function textureCoordInset({ left, right, top, bottom }: FrameXmlTexCoords): string {
  const minX = Math.min(left, right);
  const maxX = Math.max(left, right);
  const minY = Math.min(top, bottom);
  const maxY = Math.max(top, bottom);
  return `${minY * 100}% ${(1 - maxX) * 100}% ${(1 - maxY) * 100}% ${minX * 100}%`;
}

/**
 * How many times larger than its box the cropped picture is drawn: the box shows the crop's
 * fraction of it, so the backing store grows by the inverse to keep the face at the box's own
 * pixel density (a 23px micro-button showing 60% of the picture is a 38px picture).
 */
function textureCoordScale({ left, right, top, bottom }: FrameXmlTexCoords): number {
  const fraction = Math.min(Math.abs(right - left), Math.abs(bottom - top));
  return fraction >= 0.05 && fraction <= 1 ? 1 / fraction : 1;
}

/** A custom property on a real CSSStyleDeclaration, or a plain key on a test double's style. */
function setCustomProperty(style: CSSStyleDeclaration, name: string, value: string | undefined): void {
  const record = style as unknown as Record<string, string | undefined>;
  const current = typeof style.getPropertyValue === "function" ? style.getPropertyValue(name) : record[name] ?? "";
  if ((value ?? "") === current) return;
  if (value === undefined) {
    if (typeof style.removeProperty === "function") style.removeProperty(name);
    else delete record[name];
  } else if (typeof style.setProperty === "function") {
    style.setProperty(name, value);
  } else {
    record[name] = value;
  }
}

export function createFrameXmlStockPortraits(options: FrameXmlStockPortraitOptions): FrameXmlStockPortraits {
  const targets = options.targets ?? stockPortraitTargets;
  const schedule = options.schedule ?? ((task: () => void) => queueMicrotask(task));
  const claims = new Map<FrameXmlFrame, StockPortraitClaim>();
  const hooked = new WeakSet<FrameXmlFrame>();
  let unsubscribe: (() => void) | undefined;
  let unwatchScale: (() => void) | undefined;
  let seenLayout = -1;
  let queued = false;
  let disposed = false;

  const onMutation = (): void => {
    // Show, Hide, SetTexture and geometry all bump the layout revision; the many paint-only
    // notifications of an open window (cooldown sweeps, bar fills, alpha pulses) stop here —
    // unless one of them was a claimed Texture's own SetTexCoord/SetAlpha (the micro-button's
    // pushed crop and half alpha), which the canvas must mirror: two identity reads per shown claim.
    if (options.bridge.layoutVersion !== seenLayout) {
      request();
      return;
    }
    for (const claim of claims.values()) {
      if (claim.state !== "active") continue;
      if (claim.texture.texCoords !== claim.texCoords || claim.texture.alpha !== claim.alpha) {
        request();
        return;
      }
    }
  };

  /** The stage drew at another scale: a shown canvas's backing store is measured again. */
  const rescale = (): void => {
    let shown = false;
    for (const claim of claims.values()) {
      if (claim.state !== "active") continue;
      claim.authored = undefined;
      shown = true;
    }
    if (shown) request();
  };

  /**
   * The per-notification watch exists only while a claimed portrait is on screen (or about to be
   * drawn): it is what notices Lua's own picture, a moved Texture or a hide the window's scripts
   * did not announce. With every window closed the host listens to nothing but the windows'
   * OnShow/OnHide and the next SetPortraitTexture, so an idle HUD pays no per-frame cost here.
   *
   * The stage's scale matters only to a canvas on screen, so that watch waits for an active claim.
   * One exists only once the DOM renderer does, and with it the mount's cleanup for this host: a
   * mount that fails while its corpus loads leaves no window or settings listener behind.
   */
  const watch = (): void => {
    let shown = false;
    let active = false;
    for (const claim of claims.values()) {
      if (claim.state === "dormant") continue;
      shown = true;
      if (claim.state === "active") {
        active = true;
        break;
      }
    }
    if (shown && !unsubscribe && !disposed) {
      seenLayout = options.bridge.layoutVersion;
      unsubscribe = options.bridge.subscribe(onMutation);
    } else if (!shown && unsubscribe) {
      unsubscribe();
      unsubscribe = undefined;
    }
    if (active && !unwatchScale && !disposed) {
      unwatchScale = options.watchScale?.(rescale);
    } else if (!active && unwatchScale) {
      unwatchScale();
      unwatchScale = undefined;
    }
  };

  const hide = (claim: StockPortraitClaim): void => {
    targets.delete(claim.slot);
    if (claim.canvas && claim.canvas.style.display !== "none") claim.canvas.style.display = "none";
  };

  const release = (claim: StockPortraitClaim): void => {
    targets.delete(claim.slot);
    claim.canvas?.remove();
    claim.canvas = undefined;
    claim.state = "dormant";
    claims.delete(claim.texture);
    watch();
  };

  /**
   * A window's OnShow/OnHide reach its regions' owner through the bridge's show tree (an ancestor
   * such as UIParent coming back included), so one hook per portrait's parent frame is enough to
   * wake a closed window's claim. Hooks cannot be removed; after dispose they do nothing.
   */
  const hookWindow = (texture: FrameXmlFrame): void => {
    const owner = texture.parent;
    if (!owner || hooked.has(owner)) return;
    hooked.add(owner);
    const wake = (): void => {
      if (claims.size > 0) request();
    };
    options.bridge.HookScript(owner, "OnShow", wake);
    options.bridge.HookScript(owner, "OnHide", wake);
  };

  const canvasFor = (claim: StockPortraitClaim, element: HTMLElement): HTMLCanvasElement | undefined => {
    const parent = element.parentElement;
    if (!parent) return undefined;
    let canvas = claim.canvas;
    if (!canvas) {
      const document = options.document ?? globalThis.document;
      canvas = document.createElement("canvas");
      canvas.className = "portrait-canvas portrait-canvas-stock";
      canvas.dataset["portraitSlot"] = claim.slot;
      canvas.dataset["portraitReady"] = "false";
      canvas.style.pointerEvents = "none";
      claim.canvas = canvas;
    }
    // Directly above the stock picture, in its parent and draw layer: the frame's own ring art is
    // drawn over both, as it is over the client's portrait.
    if (canvas.parentElement !== parent || element.nextSibling !== canvas) {
      parent.insertBefore(canvas, element.nextSibling);
    }
    const from = element.style as unknown as Record<string, string | undefined>;
    const to = canvas.style as unknown as Record<string, string | undefined>;
    for (const name of COPIED_STYLES) {
      const value = from[name] ?? "";
      if ((to[name] ?? "") !== value) to[name] = value;
    }
    if (!from["position"]) to["position"] = "absolute";
    if (canvas.style.display !== "block") canvas.style.display = "block";
    // The crop, as the DOM renderer publishes it for the picture (`applyTexture`): the attribute the
    // stage stylesheet selects on and the inset it reads. The eight-number form is a transform on
    // the picture, already copied above with the rest of the geometry.
    const texCoords = claim.texture.texCoords;
    const cropped = texCoords !== undefined && texCoords.corners === undefined ? texCoords : undefined;
    const crop = cropped ? textureCoordInset(cropped) : "";
    const spelled = cropped ? `${cropped.left}:${cropped.right}:${cropped.top}:${cropped.bottom}` : undefined;
    if (canvas.dataset["framexmlTexcoords"] !== spelled) {
      if (spelled === undefined) delete canvas.dataset["framexmlTexcoords"];
      else canvas.dataset["framexmlTexcoords"] = spelled;
    }
    setCustomProperty(canvas.style, "--framexml-texcoord-inset", cropped ? crop : undefined);
    claim.texCoords = texCoords;
    claim.alpha = claim.texture.alpha;
    const width = cssPixels(from["width"]) ?? element.offsetWidth;
    const height = cssPixels(from["height"]) ?? element.offsetHeight;
    const authored = Math.max(width || 0, height || 0) || 60;
    // Stock portrait Textures are square (60x60, BankPortraitTexture included; TaxiPortrait 58x58,
    // ReadyCheckPortrait 50x50; the micro-button's 18x25 shows a crop of a square picture). The
    // stage is scaled by the UI scale (a 60px Texture drew 72px wide at 1920x919), so the backing
    // store follows the drawn size — read when the window opens, the authored size or crop changes
    // or the stage scale does (`rescale`), never on an ordinary reconcile, because it is a layout
    // read. A new size makes the renderer paint once.
    if (claim.state !== "active" || claim.authored !== authored || claim.crop !== crop) {
      claim.authored = authored;
      claim.crop = crop;
      const drawn = typeof element.getBoundingClientRect === "function" ? element.getBoundingClientRect() : undefined;
      const onScreen = drawn ? Math.max(drawn.width, drawn.height) : 0;
      const scale = cropped ? textureCoordScale(cropped) : 1;
      setPortraitCanvasBackingStore(canvas, (onScreen > 0 ? onScreen : authored) * scale);
    }
    return canvas;
  };

  const reconcile = (claim: StockPortraitClaim): void => {
    if (claim.texture.texture !== claim.picture) {
      // Lua drew its own picture there (GossipFrameUpdate's book for a game object): the stock
      // texture wins, as it does in the client, until the next SetPortraitTexture.
      release(claim);
      return;
    }
    if (!options.bridge.isVisible(claim.texture)) {
      // The window closed: give the renderer surface back, keep the claim for the next show.
      hide(claim);
      claim.state = "dormant";
      return;
    }
    const element = options.elementFor(claim.texture);
    const canvas = element ? canvasFor(claim, element) : undefined;
    if (!canvas) {
      hide(claim);
      claim.state = "waiting";
      return;
    }
    targets.set(claim.slot, claim.guid, canvas);
    claim.state = "active";
  };

  const flush = (): void => {
    queued = false;
    if (disposed) return;
    seenLayout = options.bridge.layoutVersion;
    for (const claim of [...claims.values()]) reconcile(claim);
    watch();
  };

  function request(): void {
    if (queued || disposed) return;
    queued = true;
    // After every observer of this notification — the DOM renderer syncs the element first.
    schedule(flush);
  }

  return {
    setPortraitTexture(texture, unit) {
      if (disposed || texture.type !== "Texture" || FRAMEXML_DEDICATED_PORTRAIT_TEXTURES.has(texture.name)) return;
      const guid = options.resolve(unit);
      const claim = claims.get(texture);
      if (guid === undefined) {
        // No drawable unit (none there, a game object, a token this client cannot name): the
        // Texture keeps its stock picture, and any earlier face over it goes.
        if (claim) release(claim);
        return;
      }
      // The client's call replaces the picture, a portrait crop included; the stand-in is what
      // shows under the canvas when nothing covers it, and what makes any later SetTexture of
      // Lua's — the same book as before the claim too — a change the reconcile sees. Unchanged,
      // a repeated call writes nothing.
      options.bridge.SetTexture(texture, FRAMEXML_NPC_PORTRAIT_STAND_IN);
      if (texture.portrait) options.bridge.update(texture, (mutable) => { mutable.portrait = false; }, "paint");
      if (claim) {
        // BankFrame_OnEvent names the unit before ShowUIPanel: a closed window's repeat is the
        // one that must look again, once its show has run.
        if (claim.guid === guid && claim.picture === texture.texture && claim.state === "active") return;
        claim.guid = guid;
        claim.picture = texture.texture;
        request();
        return;
      }
      claims.set(texture, {
        texture, slot: `stock:${texture.name}`, guid, picture: texture.texture,
        canvas: undefined, state: "dormant", authored: undefined, crop: "",
        texCoords: undefined, alpha: undefined,
      });
      hookWindow(texture);
      request();
    },
    get claims() {
      return claims.size;
    },
    get active() {
      let count = 0;
      for (const claim of claims.values()) if (claim.state === "active") count++;
      return count;
    },
    dispose() {
      if (disposed) return;
      for (const claim of [...claims.values()]) release(claim);
      disposed = true;
      unsubscribe?.();
      unsubscribe = undefined;
      unwatchScale?.();
      unwatchScale = undefined;
    },
  };
}
