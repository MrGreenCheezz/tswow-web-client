/**
 * 15.11 (6.18): a dead character on the select screen, as Wow.exe 0x004e3cd0 draws one.
 *
 * When the enum record's flags carry 0x2000 (CHARACTER_FLAG_GHOST; TrinityCore sets it from
 * PLAYER_FLAGS_GHOST, Player.cpp `BuildEnumData`) the figure is passed to 0x004e2ce0, which reads
 * SpellVisualKit row 989 (0x3dd) and
 *  - hangs each of its effects through 0x004e2c30 on the figure's own attachment — Head 20, Chest 34,
 *    Base 19, the hands 21/22, Breath 17, the specials 23–25 — scaled by SpellVisualEffectName's scale,
 *    only where the figure has that attachment;
 *  - for each CharProc of the kit: 1 sets the model's colour from CharParamZero (an 0xRRGGBB number,
 *    CM2Model +0x180..+0x188 = channel / 255), 14 its alpha (+0x178, clamped to 0..1).
 *
 * The dataset's row 989 (read from SpellVisualKit.dbc on 15.11): BaseEffect 717 (`Spells\Ghost_state`,
 * four emitters and no mesh), CharProc 1 and 14 with CharParamZero 9222653 (0x8CB9FD: 140/185/253)
 * and 0.5. The effect and the colour come through `/dbc/spell-visual-kits` (its `tint` is the
 * CharProc 1 colour); that route does not carry CharProc 14, so the alpha is the row's number, here.
 *
 * Not drawn: the same function also switches the screen's light to a second preset (0x008c02e0 with
 * 0x00b6a184 instead of 0x00b6a188) and writes 0.15 instead of 0.4 into a glue setting (0x00d38b00
 * +300); what those two are was not read.
 */
import type { GlueFigureEffect } from "./GlueWornPieces.js";
import { fadeMaterial, tintMaterial } from "../ModelBuild.js";
import type * as THREE from "three";

export const CHARACTER_FLAG_GHOST = 0x2000;
/** SpellVisualKit id 0x004e2ce0 reads (0x3dd). */
export const GHOST_VISUAL_KIT = 989;
/** Kit 989's CharProc 14 parameter in this dataset (see above): the ghost's model alpha. */
export const GHOST_MODEL_ALPHA = 0.5;
/** SpellVisualKit route version the browser already asks with (SpellVisualClient.ts). */
const KIT_ROUTE_VERSION = 4;

export interface GhostLook {
  readonly effects: readonly GlueFigureEffect[];
  /** CharProc 1's colour, 0xRRGGBB; undefined when the kit has none. */
  readonly tint: number | undefined;
  readonly alpha: number;
}

/** The ghost look out of one `/dbc/spell-visual-kits` answer, or undefined when the kit is absent. */
export function ghostLookOf(answer: unknown): GhostLook | undefined {
  if (!Array.isArray(answer)) return undefined;
  const row = answer.find((entry: unknown) => typeof entry === "object" && entry !== null
    && (entry as { id?: unknown }).id === GHOST_VISUAL_KIT) as { kit?: unknown } | undefined;
  const kit = row?.kit as { effects?: unknown; tint?: unknown } | undefined;
  if (!kit || typeof kit !== "object") return undefined;
  const effects: GlueFigureEffect[] = [];
  if (Array.isArray(kit.effects)) {
    for (const effect of kit.effects as unknown[]) {
      const { path, attachment, scale } = (effect ?? {}) as { path?: unknown; attachment?: unknown; scale?: unknown };
      if (typeof path !== "string" || path.length === 0 || !Number.isInteger(attachment)) continue;
      effects.push({ path, point: attachment as number, scale: typeof scale === "number" && scale > 0 ? scale : 1 });
    }
  }
  const tint = Number.isInteger(kit.tint) ? (kit.tint as number) & 0xffffff : undefined;
  return { effects, tint, alpha: GHOST_MODEL_ALPHA };
}

export async function fetchGhostLook(origin: string, signal?: AbortSignal): Promise<GhostLook | undefined> {
  const response = await fetch(`${origin}/dbc/spell-visual-kits?v=${KIT_ROUTE_VERSION}&ids=${GHOST_VISUAL_KIT}`,
    signal ? { signal } : {});
  if (!response.ok) throw new Error(`набор ${GHOST_VISUAL_KIT}: шлюз ответил ${response.status}`);
  return ghostLookOf(await response.json());
}

/** The ghost's colour and alpha on one of the figure's own materials (built privately, so in place). */
export function paintGhost(material: THREE.Material, look: Pick<GhostLook, "tint" | "alpha">): void {
  if (look.tint !== undefined) tintMaterial(material, look.tint, material);
  if (look.alpha < 1) fadeMaterial(material, look.alpha);
}
