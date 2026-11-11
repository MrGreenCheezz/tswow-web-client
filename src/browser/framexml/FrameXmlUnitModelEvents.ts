/**
 * 6.18 (11.11): UNIT_MODEL_CHANGED, the event the stock windows refresh their PlayerModel on —
 * PaperDollFrame_OnEvent's `CharacterModelFrame:SetUnit("player")` (PaperDollFrame.lua:157-159) and
 * InspectPaperDollFrame_OnEvent's `InspectModelFrame:RefreshUnit()` (InspectPaperDollFrame.lua:41-45).
 *
 * Wow.exe raises it from one place, 0x00618110 (reached through 0x00512b50): flag 2 signals
 * UNIT_PORTRAIT_UPDATE (event 0x91) after marking the unit's portrait stale, flag 1
 * UNIT_MODEL_CHANGED (0x92). It has 18 call sites (0x006e0fd0 and the 17 of 0x00512b50); the 13 read
 * (.runtime/re-2026-11-11/uimodels/r10.c) all pass 3, so the two go together. Two of them are used here:
 * - 0x006e1e10, a player's visible-item slot (0..18, PLAYER_VISIBLE_ITEM_N_ENTRYID at descriptor
 *   +0x21c + slot*8): a new entry rebuilds that slot of the model and raises both; the same entry
 *   with only its enchantment moved does not (it returns through 0x006d6c10 first);
 * - 0x006e0fd0, PLAYER_FLAGS: a change in the hide-helm/hide-cloak bits (0xc00) raises both.
 * The unit's display changing is the other source the seam already knows (UNIT_DISPLAY_ID →
 * UNIT_PORTRAIT_UPDATE, LiveWorldSeam.ts); the model event rides with it there.
 *
 * Cost: one comparison of twenty words per watched unit on a frame in which the world changed —
 * the store's once-per-frame `any` — and nothing else.
 */
import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import type { WorldObjectState } from "../../world/WorldState.js";

export const FRAMEXML_UNIT_MODEL_CHANGED = "UNIT_MODEL_CHANGED";
export const FRAMEXML_UNIT_PORTRAIT_UPDATE = "UNIT_PORTRAIT_UPDATE";

const TYPEID_PLAYER = 4;
const VISIBLE_ITEM_FIRST = UPDATE_FIELDS.PLAYER_VISIBLE_ITEM_1_ENTRYID.offset;
const VISIBLE_ITEM_STRIDE = UPDATE_FIELDS.PLAYER_VISIBLE_ITEM_2_ENTRYID.offset - VISIBLE_ITEM_FIRST;
const VISIBLE_ITEM_COUNT = 19;
/** PLAYER_FLAGS_HIDE_HELM | PLAYER_FLAGS_HIDE_CLOAK (Wow.exe 0x006e0fd0 tests `& 0xc00`). */
const HIDDEN_WORN_BITS = 0xc00;

/** The words whose change makes Wow.exe rebuild a player's model, as one comparable string. */
export function frameXmlUnitModelSignature(object: WorldObjectState | undefined): string | undefined {
  if (!object || object.typeId !== TYPEID_PLAYER) return undefined;
  let signature = String((object.fields.get(UPDATE_FIELDS.PLAYER_FLAGS.offset) ?? 0) & HIDDEN_WORN_BITS);
  for (let slot = 0; slot < VISIBLE_ITEM_COUNT; slot++) {
    signature += `,${object.fields.get(VISIBLE_ITEM_FIRST + slot * VISIBLE_ITEM_STRIDE) ?? 0}`;
  }
  return signature;
}

export interface FrameXmlUnitModelEventsOptions {
  /** The world store's once-per-frame change hook. */
  readonly any: (listener: () => void) => () => void;
  /** The object a unit token names now. */
  readonly unit: (token: string) => WorldObjectState | undefined;
  readonly fire: (event: string, unit: string) => void;
  /** The tokens watched; the ones a stock PlayerModel is pointed at. */
  readonly tokens?: readonly string[];
}

/**
 * Raise UNIT_PORTRAIT_UPDATE and UNIT_MODEL_CHANGED for a watched token whose player changed a
 * visible item or the helm/cloak bits. A token that now names another unit is only re-read: that is
 * a target change, which has its own event.
 */
export function watchFrameXmlUnitModelChanges(options: FrameXmlUnitModelEventsOptions): () => void {
  const tokens = options.tokens ?? ["player", "target", "focus"];
  const seen = new Map<string, { guid: bigint; signature: string }>();
  const read = (): void => {
    for (const token of tokens) {
      const object = options.unit(token);
      const signature = frameXmlUnitModelSignature(object);
      if (!object || signature === undefined) { seen.delete(token); continue; }
      const last = seen.get(token);
      if (last && last.guid === object.guid && last.signature === signature) continue;
      seen.set(token, { guid: object.guid, signature });
      if (last?.guid !== object.guid) continue;
      options.fire(FRAMEXML_UNIT_PORTRAIT_UPDATE, token);
      options.fire(FRAMEXML_UNIT_MODEL_CHANGED, token);
    }
  };
  read();
  return options.any(read);
}
