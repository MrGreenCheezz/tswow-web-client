// 6.05б (line A7a, slice G2, 05.10): a DynamicObject (object type 6) shows its spell's area.
//
// The server makes one for a lasting ground spell — Rain of Fire, Blizzard, Consecration, Death and
// Decay, a hunter's Flare — and destroys it when the area ends (TrinityCore
// `DynamicObject::CreateDynamicObject`, DynamicObject.cpp:99-109: entry = spell, CASTER,
// BYTES byte 0 = type (0 portal, 1 area spell, 2 far sight), SPELLID, RADIUS (a float), CASTTIME =
// game time in ms). Until this the object was nothing over WebGL (`SimpleScene` suppresses its marker),
// so an area cast before the player came into range, or by someone whose SPELL_GO this client never
// got, was invisible for its whole life.
//
// Wow.exe 3.3.5a 12340, CGDynamicObject_C:
//  - create, 0x00705230, asks 0x00804cc0 whether (caster, spell, cast time) is in the list of casts
//    the client itself saw, and keeps the answer as a flag;
//  - the area, 0x00704f60, runs only without that flag: the spell's SpellVisual (0x007fa290: the
//    first, or the second under a setting) → its PersistentAreaKit (SpellVisual +100) → the kit's
//    sound at the object and, for a CharProc of 9, a Blizzard-style area system over RADIUS
//    (0x007fbd70: a model out of the table at 0x00ad4a7c, else `Spells\Blizzard_Impact_Base.mdx`).
//
// Here: an object whose cast this client saw within `DYNAMIC_OBJECT_CAST_WINDOW_MS` belongs to that
// cast (its SPELL_GO plan already drew the PersistentAreaKit, `planSpellVisual`); any other gets
// the PersistentAreaKit at its position, held until the object leaves the world state. Deviations:
// the match is (caster, spell) within the window, not the cast time (our SPELL_GO reader does not
// keep the packet's timestamp); the CharProc-9 area system is not drawn (`.runtime/re-2026-10-05/A7a-G2/g2.c`);
// the kit's models are drawn as the SPELL_GO path draws them, and whether 0x00704f60's object also
// carries them through its own model is not settled. No radius scaling: type 1 is drawn at the kit's
// own size, as before.
//
// Per-frame cost: one pass over the world's objects comparing `typeId` (the renderer makes several
// such passes), one Map read per area object; an object still waiting for its row reads its spell word
// and asks for the row, and is parsed only while a seen cast is in the window (05.10: ревью G2).

import { UPDATE_FIELDS } from "../generated/updateFields.js";
import type { SpellVisualMetadata } from "../gateway/SpellVisual.js";
import { planPersistentArea, type SpellVisualPlan } from "./SpellVisuals.js";

export const DYNAMIC_OBJECT_TYPE_ID = 6;
/** How long after a SPELL_GO an object of the same caster and spell is that cast's own. */
export const DYNAMIC_OBJECT_CAST_WINDOW_MS = 1_000;

const CASTER = UPDATE_FIELDS.DYNAMICOBJECT_CASTER.offset;
const BYTES = UPDATE_FIELDS.DYNAMICOBJECT_BYTES.offset;
const SPELL_ID = UPDATE_FIELDS.DYNAMICOBJECT_SPELLID.offset;
const RADIUS = UPDATE_FIELDS.DYNAMICOBJECT_RADIUS.offset;
const CAST_TIME = UPDATE_FIELDS.DYNAMICOBJECT_CASTTIME.offset;

export interface DynamicObjectArea {
  readonly caster: bigint;
  readonly spellId: number;
  readonly radius: number;
  /** DynamicObjectType: 0 portal, 1 area spell, 2 far sight. */
  readonly type: number;
  readonly castTime: number;
}

interface AreaObject {
  readonly typeId?: number | undefined;
  readonly fields?: ReadonlyMap<number, number>;
  readonly position: { readonly x: number; readonly y: number; readonly z: number } | undefined;
}

const floatWord = new DataView(new ArrayBuffer(4));

/** The object's own words, or undefined for anything that is not a DynamicObject. */
export function dynamicObjectArea(object: Pick<AreaObject, "typeId" | "fields">): DynamicObjectArea | undefined {
  const fields = object.fields;
  if (object.typeId !== DYNAMIC_OBJECT_TYPE_ID || fields === undefined) return undefined;
  floatWord.setUint32(0, (fields.get(RADIUS) ?? 0) >>> 0, true);
  return {
    caster: (BigInt((fields.get(CASTER + 1) ?? 0) >>> 0) << 32n) | BigInt((fields.get(CASTER) ?? 0) >>> 0),
    spellId: fields.get(SPELL_ID) ?? 0,
    radius: floatWord.getFloat32(0, true),
    type: (fields.get(BYTES) ?? 0) & 0xff,
    castTime: (fields.get(CAST_TIME) ?? 0) >>> 0,
  };
}

interface DrawnArea {
  /** The renderer's handle, or null for an object its cast draws (or with nothing to draw). */
  handle: unknown;
  mark: number;
}

export interface DynamicObjectAreasOptions {
  /** The spell's visual row (asking for it again until it arrives), or undefined. */
  visual(spellId: number): SpellVisualMetadata | undefined;
  renderer(): { playSpellVisual(plan: SpellVisualPlan): unknown; cancelSpellVisual?(handle: unknown): void } | undefined;
}

/** The areas of the DynamicObjects in the world state that no seen cast already draws. */
export class DynamicObjectAreas {
  readonly #options: DynamicObjectAreasOptions;
  readonly #drawn = new Map<bigint, DrawnArea>();
  /** `${caster}:${spell}` → when its SPELL_GO arrived. */
  readonly #casts = new Map<string, number>();
  #mark = 0;

  constructor(options: DynamicObjectAreasOptions) {
    this.#options = options;
  }

  /** A SPELL_GO this client saw: an object of the same caster and spell soon after is its area. */
  noteCast(caster: bigint, spellId: number, now: number): void {
    this.#casts.set(`${caster}:${spellId}`, now);
  }

  sync(objects: ReadonlyMap<bigint, AreaObject>, now: number): void {
    const mark = ++this.#mark;
    for (const [guid, object] of objects) {
      if (object.typeId !== DYNAMIC_OBJECT_TYPE_ID) continue;
      const drawn = this.#drawn.get(guid);
      if (drawn !== undefined) {
        drawn.mark = mark;
        continue;
      }
      // 05.10: ревью G2 — an object waiting for its row comes back every frame: read the spell word only,
      // and parse the rest (a BigInt caster, a key string) only while some seen cast is in the window.
      const spellId = object.fields?.get(SPELL_ID) ?? 0;
      if (!object.position || spellId <= 0) continue;
      if (this.#casts.size > 0) {
        const area = dynamicObjectArea(object)!;
        const seen = this.#casts.get(`${area.caster}:${spellId}`);
        if (seen !== undefined && now - seen <= DYNAMIC_OBJECT_CAST_WINDOW_MS) {
          this.#drawn.set(guid, { handle: null, mark });
          continue;
        }
      }
      const visual = this.#options.visual(spellId);
      if (!visual) continue; // asked again next frame, until the row is here
      if (!visual.persistentArea) {
        this.#drawn.set(guid, { handle: null, mark });
        continue;
      }
      const renderer = this.#options.renderer();
      if (!renderer) continue;
      const handle = renderer.playSpellVisual(planPersistentArea(visual, object.position, now));
      this.#drawn.set(guid, { handle: handle ?? null, mark });
    }
    if (this.#drawn.size > 0) {
      for (const [guid, drawn] of this.#drawn) {
        if (drawn.mark === mark) continue;
        this.#cancel(drawn);
        this.#drawn.delete(guid);
      }
    }
    if (this.#casts.size > 0) {
      for (const [key, at] of this.#casts) if (now - at > DYNAMIC_OBJECT_CAST_WINDOW_MS) this.#casts.delete(key);
    }
  }

  /** Lets every area go: a teleport or a logout took the objects (and the renderer's visuals) away. */
  clear(): void {
    for (const drawn of this.#drawn.values()) this.#cancel(drawn);
    this.#drawn.clear();
    this.#casts.clear();
  }

  #cancel(drawn: DrawnArea): void {
    if (drawn.handle !== null) this.#options.renderer()?.cancelSpellVisual?.(drawn.handle);
  }
}
