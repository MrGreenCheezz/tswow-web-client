/**
 * L17 3.14: the C functions only Blizzard_BattlefieldMinimap calls (a static probe of the add-on found
 * them unbound: .runtime/re-2026-10-03/l3-bg/bfmm-unbound.mjs), as Wow.exe 12340 answers them (read-only
 * Ghidra, .runtime/re-2026-10-04/l17/g1.c, g2.c). GetBattlefieldVehicleInfo and GetBattlefieldMapIconScale
 * are the map's (FrameXmlMap.ts), since WorldMapFrame reads the first too.
 *
 * * `CreateMiniWorldMapArrowFrame(parent)` (0x00545f20 → 0x005448a0) is the world map's
 *   `CreateWorldMapArrowFrame` (0x00545e60 → 0x00544750) for a second pair of arrow models,
 *   PlayerMiniArrowFrame and PlayerMiniArrowEffectFrame, under the given frame; made once, scaled
 *   1.1111 against the world map's 1.6667 (0x00a0b690, 0x00a0b634) — two thirds of its size. As the
 *   world map's binding (FrameXmlWorldMapArrow.ts), the arrow is one frame, PlayerMiniArrowEffectFrame
 *   (the name the add-on's OnLoad sets a level and alpha on), holding the MinimapArrow texture.
 * * `PositionMiniWorldMapArrowFrame(point, frameName [, relativePoint] [, x, y])` (0x005432c0): anchors
 *   it; the relative point defaults to the point and the offsets to 0; nothing before the arrow exists.
 * * `ShowMiniWorldMapArrowFrame(show)` (0x00543540): shows or hides it.
 * * `UpdateWorldMapArrowFrames()` (0x00545fe0 → 0x005449f0) turns all four arrows to the player's
 *   facing; the world map's binding turns its own, and this wraps it to turn the mini arrow too.
 * * `PlayerIsPVPInactive(unit)` (0x00612e20): the unit carries aura 43681 («Неактивен», the battleground
 *   AFK debuff) — a unit in view from its aura list (0x007282a0), a party or raid member out of view from
 *   the member-stats auras.
 */
import type { GlueLuaVm } from "../glue/GlueLua.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";
import type { FrameXmlUiBridge } from "../ui/framexml_compat/FrameXmlRuntime.js";

/** 0xaaa1: the battleground «inactive» debuff PlayerIsPVPInactive looks for. */
export const FRAMEXML_PVP_INACTIVE_SPELL = 43_681;
/** The world map arrow's side here (FrameXmlWorldMapArrow.ts) times the client's 1.1111 / 1.6667. */
export const FRAMEXML_MINI_ARROW_SIZE = (32 * 2) / 3;
const NOTHING: readonly [] = Object.freeze([]);
const YES: readonly [boolean] = Object.freeze([true]);
const NO: readonly [boolean] = Object.freeze([false]);
const UPDATE_GLOBAL = "__webclientUpdateMiniArrow";

export interface FrameXmlBattlefieldMinimapApiWorld {
  readonly state: { readonly objects: { has(guid: bigint): boolean } };
  readonly auras?: ReadonlyMap<bigint, ReadonlyMap<number, { readonly spellId: number }>> | undefined;
  readonly partyStats?: ReadonlyMap<bigint, { readonly auras?: readonly { readonly spellId: number }[] | undefined }> | undefined;
}

export interface FrameXmlBattlefieldMinimapApiOptions {
  readonly vm: GlueLuaVm;
  readonly bridge: FrameXmlUiBridge;
  /** The player's facing in radians, as the world map arrow reads it. */
  readonly facing: () => number | undefined;
  readonly world: () => FrameXmlBattlefieldMinimapApiWorld | undefined;
  /** A unit token's GUID (the seam's resolution). */
  readonly unitGuid: (unit: string) => bigint | undefined;
}

/** 0x00612e20: the unit has the inactive debuff — in view from its auras, else from its member stats. */
export function frameXmlPlayerIsPvpInactive(
  world: FrameXmlBattlefieldMinimapApiWorld | undefined,
  guid: bigint | undefined,
): boolean {
  if (!world || guid === undefined || guid === 0n) return false;
  if (world.state.objects.has(guid)) {
    for (const aura of world.auras?.get(guid)?.values() ?? NOTHING) if (aura.spellId === FRAMEXML_PVP_INACTIVE_SPELL) return true;
    return false;
  }
  for (const aura of world.partyStats?.get(guid)?.auras ?? NOTHING) if (aura.spellId === FRAMEXML_PVP_INACTIVE_SPELL) return true;
  return false;
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Registers the add-on's own C functions on the running VM; safe to call before or after it loads. */
export function installFrameXmlBattlefieldMinimapApi(options: FrameXmlBattlefieldMinimapApiOptions): boolean {
  const { vm, bridge } = options;
  let arrow: FrameXmlFrame | undefined;
  let icon: FrameXmlFrame | undefined;

  vm.registerGlobal("CreateMiniWorldMapArrowFrame", (args) => {
    const parent = args[0] && typeof args[0] === "object" ? bridge.resolve(args[0] as FrameXmlFrame) : undefined;
    if (!parent || arrow) return NOTHING;
    arrow = bridge.getFrame("PlayerMiniArrowEffectFrame")
      ?? bridge.CreateFrame("Frame", "PlayerMiniArrowEffectFrame", parent);
    if (!arrow) return NOTHING;
    const size = String(FRAMEXML_MINI_ARROW_SIZE);
    bridge.update(arrow, (frame) => {
      frame.setAttribute("width", size);
      frame.setAttribute("height", size);
    });
    icon = arrow.children.find((child) => child.type === "Texture")
      ?? bridge.createChild(arrow, "Texture", undefined, "OVERLAY");
    if (icon) {
      bridge.SetTexture(icon, "Interface\\Minimap\\MinimapArrow");
      bridge.update(icon, (texture) => {
        texture.setAttribute("width", size);
        texture.setAttribute("height", size);
      });
      bridge.SetPoint(icon, "CENTER", arrow, "CENTER", 0, 0);
    }
    bridge.Hide(arrow);
    return NOTHING;
  });

  vm.registerGlobal("PositionMiniWorldMapArrowFrame", (args) => {
    const point = args[0];
    const target = args[1];
    if (!arrow || typeof point !== "string" || typeof target !== "string") return NOTHING;
    const relativeTo = bridge.getFrame(target);
    if (!relativeTo || relativeTo === arrow) return NOTHING;
    const relativePoint = typeof args[2] === "string" ? args[2] : point;
    const x = finiteOr(args[3], 0);
    const y = finiteOr(args[4], 0);
    const existing = arrow.points.find((entry) => entry.point === point);
    if (existing?.relativeTo !== relativeTo || existing.relativePoint !== relativePoint
      || existing.x !== x || existing.y !== y) {
      bridge.SetPoint(arrow, point, relativeTo, relativePoint, x, y);
    }
    return NOTHING;
  });

  vm.registerGlobal("ShowMiniWorldMapArrowFrame", (args) => {
    if (!arrow) return NOTHING;
    const visible = args[0] !== undefined && args[0] !== null && args[0] !== false;
    if (visible && !arrow.visible) bridge.Show(arrow);
    else if (!visible && arrow.visible) bridge.Hide(arrow);
    return NOTHING;
  });

  vm.registerGlobal(UPDATE_GLOBAL, () => {
    const facing = options.facing();
    if (icon && facing !== undefined && icon.textureRotation !== facing) {
      bridge.update(icon, (texture) => { texture.textureRotation = facing; });
    }
    return NOTHING;
  });

  vm.registerGlobal("PlayerIsPVPInactive", (args) => {
    const unit = typeof args[0] === "string" ? args[0] : typeof args[0] === "number" ? String(args[0]) : undefined;
    if (unit === undefined) return NO;
    return frameXmlPlayerIsPvpInactive(options.world(), options.unitGuid(unit.toLowerCase())) ? YES : NO;
  });

  // 0x005449f0 turns the world map's and the mini map's arrows in one call.
  const wrapped = vm.executeReported(`
    local update, mini = UpdateWorldMapArrowFrames, ${UPDATE_GLOBAL}
    if type(update) == "function" and not __webclientMiniArrowWrapped then
      __webclientMiniArrowWrapped = true
      UpdateWorldMapArrowFrames = function(...)
        update(...)
        mini()
      end
    end
  `, "@webclient/battlefield-minimap-api");
  return wrapped;
}
