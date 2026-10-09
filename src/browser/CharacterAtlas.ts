// Painting a character's body texture in the browser.
//
// A character model carries no body texture of its own; the client builds one 512x512 image from
// a base skin plus a face, a scalp, facial hair and underwear, each landing in a fixed rectangle.
// Only the base skin was ever used here, which is why faces had no eyes or mouth.
//
// The pieces are composed here rather than on the gateway so each one stays a shared, content-
// addressed download: every human of one skin colour fetches the same base, every beard of one
// colour the same overlay, and the composite lives only in this tab's GPU memory.

import * as THREE from "three";
import { textureUrl } from "./Wvm.js";
import { knownLogicalTextureBytes, type RetainedResourceVisitor } from "./ResourceAccounting.js";
import type { BenchmarkAsyncReadinessStats } from "./RenderBenchmarkReadiness.js";

/** Where each piece lands on the body texture. Mirrors BODY_SECTIONS on the gateway. */
export const BODY_TEXTURE_SIZE = 512;

/** How long a first body waits for its other layers once the base skin is in (see `#build`). */
export const CHARACTER_ATLAS_PARTIAL_PAINT_MS = 250;
const SECTIONS: Record<string, { x: number; y: number; width: number; height: number }> = {
  armUpper: { x: 0, y: 0, width: 256, height: 128 },
  armLower: { x: 0, y: 128, width: 256, height: 128 },
  hand: { x: 0, y: 256, width: 256, height: 64 },
  faceUpper: { x: 0, y: 320, width: 256, height: 64 },
  faceLower: { x: 0, y: 384, width: 256, height: 128 },
  torsoUpper: { x: 256, y: 0, width: 256, height: 128 },
  torsoLower: { x: 256, y: 128, width: 256, height: 64 },
  legUpper: { x: 256, y: 192, width: 256, height: 128 },
  legLower: { x: 256, y: 320, width: 256, height: 128 },
  foot: { x: 256, y: 448, width: 256, height: 64 },
};

// The payload's shape is the gateway's to define. Only the rectangles are mirrored here, because
// that module reads DBCs off disk and cannot be bundled into a page; the types themselves are
// erased at compile time, so importing them costs nothing and stops the two ends drifting apart —
// which they already had, one calling a section a `BodySection` and the other any string.
export type { BodyLayer, CharacterAppearance, CharacterOptions } from "../gateway/CharacterAppearance.js";
import type { BodyLayer, CharacterAppearance, CharacterOptions } from "../gateway/CharacterAppearance.js";

/**
 * The shape of the `/dbc/character-appearance` answer, as a number in its own query string.
 *
 * The route answers `max-age=3600` and a bare character's query has no other moving part, so
 * after a deploy the browser serves itself an hour of pre-upgrade responses out of its own HTTP
 * cache — which then fail validation and are never asked for again, because a look that has been
 * requested is never re-requested. **Bump this whenever the route changes what it answers**, and
 * note that it lives here, beside `appearanceKey`, precisely because those are the two things a
 * new field has to touch and forgetting either one is silent.
 *
 * "Changes what it answers", not "gains a field", and the review is why: Т3 filled the `hair` slot
 * of 59 bald rows from the hair colour and stopped sending the night elf's wig geoset for 48 looks,
 * and Т4 added the crown to seven bald styles, all without a new field and all without a bump. For
 * an hour after that deploy a returning browser would have gone on drawing the very green beard
 * the slice removed.
 *
 * Both askers share it: `CreatureModelClient` for the game and `LabQuery` for the character lab.
 * The lab is only worth having if it asks for exactly what the client asks for.
 *
 * 2: the first version with a face and geosets. 3: `skinExtra`, the tauren's type 8 slot. 4: Т4's
 * crown and Т3's three changes of mind about hair — the colour's picture where the row named none,
 * no wig where the row does not exist, and the wig back for a race the table never mentions. 5: Т7's
 * `candidates`, the spellings of an item's component texture in the order the archives hold them —
 * which changes `path` itself on 76.2% of the layers a dressed character paints. 6 adds the
 * optional weapon subclass to attached equipment, distinguishing a wand from a gun. 7 switches
 * visual-only character rows to the DBCs shipped with the installed HD model patch. 8 publishes
 * variant-1 garment geosets authored by that patch (notably HumanMale belt 1801). 9 selects the
 * foot-capable HumanMale boot mesh when an installed-patch item actually paints the foot section.
 * 10 selects profile-scoped belt 1802 and the Tauren worn boot shaft, while the world renderer
 * validates alternate foot meshes against the model's own UVs. 11 seeds the active patch's
 * model-aware neutral belt in player and NPC appearances. 12 publishes the measured 505 worn-boot
 * choice for every non-hoof profile that actually paints a FootTexture component. 13 marks the
 * coordinated visual profile explicitly so patch-W-only geoset policy cannot leak into classic.
 *
 * 14 is HD-1, and it changes both halves of the answer. The geosets gain the coordinated pack's
 * family-20 foot on the ten profiles that authored one, and the belt on all twenty — measured over
 * the naked look of the twenty playable profiles, the emitted list gained 1801 or 1802 on nineteen
 * of them and a 2001/2002 foot on ten. The body layers change with the re-extracted overlay: eleven
 * of the twenty name different scalp and facial-hair sheets, and over every (skin, face) pair the
 * form offers, the layers naming a file the live chain does not hold fall from **1,133 of 19,903 to
 * 0 of 18,643**. Both are exactly the kind of change the note above is about — same shape, different
 * values — so an hour of cached pre-HD-1 answers would be an hour of footless characters.
 *
 * 15 (05.10-A7a-A, 6.10): the request may carry `class`, and the geosets gain the ear stub 701
 * under a helmet that covers the ears and the death knight's eye glow 1703 (in place of 1702).
 */
export const CHARACTER_APPEARANCE_VERSION = 15;

/**
 * And the same for `/dbc/creature-models`, which answers `max-age=3600` too and whose ids are
 * likewise never asked for twice.
 *
 * It sits beside the appearance version rather than off in the client that fetches it because the
 * two are not independent: a creature-model answer *contains* an appearance, so everything that
 * changes the appearance changes this payload as well, and this one moves whenever that one does.
 * 3 carries `skinExtra`, and carries an appearance at all for the 74 character displays that used
 * to arrive with none. 4 is 4 for that reason and no other: an NPC's look is the thing that moved,
 * and the goblin's wig — which 601 extended display records lost and 517 displays wear — arrives
 * through this route rather than the one beside it. 5 moves with the appearance version beside it:
 * Т7's `candidates`, and the eight baked displays that now carry an assembled body instead of a
 * bake the archives do not hold. 6 adds `mountHeight`, which `CreatureModelData` has always held
 * and this route never read — and the browser now *requires* it (`CreatureModelClient.isMetadata`),
 * so an hour of pre-upgrade answers would be an hour of every unit standing as a capsule. 7 moves
 * creature display/model indirection and baked NPC names to the installed visual DBC overlay. 8
 * carries the matching HumanMale foot-capable appearance into baked/equipped NPC responses. 9
 * carries the active patch's model-aware neutral belt into NPC responses as well. 10 carries the
 * measured all-profile worn-boot choice into the same cached creature payload. 11 applies the
 * authoritative baked-NPC body item columns, including the waist and feet displays. 12 carries
 * the coordinated-profile marker embedded in the appearance. 13 moves with the appearance version
 * beside it for HD-1: `forNpc` builds its body through `forPlayer`, so every unbaked character
 * display gains the family-20 foot and the neutral belt, and every one of them reads the
 * re-extracted `CreatureDisplayInfo`/`CreatureDisplayInfoExtra`/`CreatureModelData` rows.
 *
 * 14 (05.10-A7a-A, 6.11а): the display's own `alpha`, `geosetData` and `particleColor`, and the
 * ear stub of 6.10 in every helmeted NPC appearance. 6.01 (helmet and shoulders of NPCs) shares
 * this bump: done before the next release or gateway restart, it must not raise it again.
 * 05.10-A7a-G 6.20 shares it as well (unreleased): `noMountSpecial`, CreatureModelData.Flags 0x400.
 */
export const CREATURE_MODEL_VERSION = 14;

/**
 * And for `/dbc/character-options`, keyed by race, sex and, on creation screens, class. The
 * current gateway answers `no-store`; the version also separates this contract from older
 * deployments that cached answers for an hour.
 *
 * Here rather than in `Login.ts` for the same reason as the other two: this is the one place a
 * change to what the gateway answers has to be written down, and three cache-busters in three
 * files is three chances to forget one. Nothing in this file reads it.
 *
 * 1: five counts, `{ skins: 15, faces: 24, … }`. 2: five lists of the indices that exist, plus
 * `facesBySkin`. A browser that read version 2 as version 1 would offer no choices at all — the
 * counts it looks for are arrays — so the bump is not a nicety. 3: the same lists, shorter by the
 * 98 hairstyles and 2 hair colours the core refuses at creation whatever the class — a change of
 * values and not of shape, which is exactly the kind that went unbumped on the two routes above
 * until the review, and which an hour of cache would otherwise go on offering. 4 switches the
 * offered hair/geoset rows to the installed visual model patch. 5 rolls over the former cached
 * HD answer when visual metadata becomes non-cacheable across pack switches. 6 adds the selected
 * class to the URL so the core's death-knight-only CharSections are not offered to other classes.
 *
 * **HD-1 deliberately does not bump this**, and that is a measurement rather than an omission.
 * `options()` reads `CharSections` flags and `CharacterFacialHairStyles` keys and nothing else, and
 * although the re-extracted overlay adds 1,102 `CharSections` rows and 50 facial-hair rows, the
 * offered rectangle does not move: built both ways on 2026-08-30, all twenty playable profiles came
 * back byte-identical — HumanMale 13 skins / 24 faces / 12 styles / 13 colours / 9 facial, TaurenMale
 * 22 / 10 / 8 / 3 / 7, and so on for the other eighteen. That extraction changed no options
 * payload and therefore needed no contract version change.
 */
export const CHARACTER_OPTIONS_VERSION = 6;

/**
 * Whether an answer to that route is the lists this bundle reads and not the counts before them.
 *
 * The version in the query is a cache-buster, not a handshake: an older gateway ignores it and
 * answers `{skins: 15, faces: 24, …}` all the same, and the page and the gateway are deployed
 * separately — the plan says in so many words that until Д0 a DBC change is invisible until the
 * gateway is restarted. Without this check the form does `values.entries()` on a number, throws
 * inside a `void`ed promise, aborts the loop over the five selects on the first of them, and puts
 * up five empty controls that submit five zeros: the bald character Т3 exists to prevent. With it
 * the controls hide themselves, which is what they did before any of them was ever filled.
 *
 * Here rather than in `Login.ts` because it is the same fact as the version beside it — what shape
 * the answer has — and because a guard in a module that can only run in a page is a guard nothing
 * can test.
 */
export function isCharacterOptions(answer: unknown): answer is CharacterOptions {
  if (typeof answer !== "object" || answer === null) return false;
  const lists = answer as Record<string, unknown>;
  return (["skins", "faces", "hairStyles", "hairColors", "facialHairs"] as const)
    .every((key) => Array.isArray(lists[key]) && (lists[key] as unknown[]).every((value) => typeof value === "number"))
    && typeof lists.facesBySkin === "object" && lists.facesBySkin !== null;
}

/**
 * A name for one look: exactly the inputs that decide what gets built from a model.
 *
 * Everything downstream of a character model — the composed body, the geometry, the materials,
 * the rigged template — depends on the appearance and not just on the file. Before this, all of
 * it was keyed on the model path plus the display record's texture-slot string, and every playable
 * race's display record leaves that string empty: fifteen thousand character displays shared 41
 * keys, so the first human male to come into view decided the skin, face, hair and armour of every
 * human male behind him.
 *
 * Two looks that resolve to the same files and the same geosets really are the same build,
 * whichever appearance bytes produced them, so the resolved answer is the name rather than the
 * question that produced it.
 */
export function appearanceKey(appearance: CharacterAppearance): string {
  // `skinExtra` is in here for the same reason the hair path is: it is one of the files the build
  // reaches for, so two looks that differ only in it are two different builds and must not share
  // a name. A gateway too old to send the field leaves it undefined, which is still one stable
  // name per look; the `v=` on the request is what stops a browser serving itself an hour of
  // pre-upgrade answers out of its own HTTP cache.
  // `path` and not the whole of `candidates`: the gateway derives the list from the name, the sex
  // and the archives, so two looks with the same first spelling have the same rest of it.
  return `${appearance.body.map((layer) => layer.path).join(",")};${appearance.hair};${appearance.cloak}`
    + `;${appearance.skinExtra ?? ""};${appearance.geosets.join(",")}`;
}

/**
 * Every spelling of one layer's file, in the order to try them.
 *
 * Т7 moved the decision to the gateway, which is the only end that can see the archives; this is
 * the reader for what it decided, and the fallback for a gateway too old to have decided anything.
 * The old pair is exactly the new list of two, so the two branches agree wherever both apply.
 */
export function layerPaths(layer: BodyLayer): readonly string[] {
  if (layer.candidates && layer.candidates.length > 0) return layer.candidates;
  return layer.alternate ? [layer.path, layer.alternate] : [layer.path];
}

/** Paints the layers that have a picture, in order, each into its rectangle; says how many did. */
function paintBodyLayers(context: CanvasRenderingContext2D, layers: readonly BodyLayer[],
  images: readonly (ImageBitmap | undefined)[]): number {
  let painted = 0;
  for (let index = 0; index < layers.length; index++) {
    const image = images[index];
    if (!image) continue;
    const section = layers[index]!.section;
    if (!section) {
      context.drawImage(image, 0, 0, BODY_TEXTURE_SIZE, BODY_TEXTURE_SIZE);
    } else {
      const rect = SECTIONS[section];
      if (!rect) continue;
      context.drawImage(image, rect.x, rect.y, rect.width, rect.height);
    }
    painted++;
  }
  return painted;
}

/** The sampling every composed body is uploaded with; the pixels changed, so it is re-uploaded. */
function configureBodyTexture(texture: THREE.Texture): void {
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.flipY = false;
  texture.needsUpdate = true;
}

/**
 * How long to wait before asking again for something that did not come, once per retry.
 *
 * Three retries after the first attempt — four requests over forty seconds — and then the path is
 * left alone. The case is a texture the gateway has to generate out of the archives on demand: a
 * 500 while a generation lane is busy or a child has died is a fact about this second, not about
 * the file, and before this one such answer removed that layer — or, for a baked NPC whose only
 * layer it was, the whole unit — for the life of the tab.
 *
 * Deliberately not applied to a 404 — and the review is why that needed a change at the *other*
 * end first. `/texture` used to answer 404 for every way of failing, a generator child that died
 * included, so reading a 404 as "the client has no such file" would have gone on stranding the
 * very failure this backoff exists for. The route now answers 500 unless the generator says in so
 * many words that the archives do not hold the path (`SOURCE_MISSING_EXIT`), and only then is one
 * more request pointless. Т7 makes that distinction matter more rather than less: the first
 * spelling offered is one the gateway's own listing found, so a 404 on it is the surprising answer.
 *
 * Shared with `CreatureModelClient`, whose appearance fetch is the same shape of failure and used
 * to be the same kind of permanent.
 */
export const IMAGE_RETRY_BACKOFF_MS: readonly number[] = [2_000, 8_000, 30_000];

/**
 * How many looks the ledger of failures holds.
 *
 * Bounded because it is fed by whatever walks past: a key is a model path, a texture-slot string
 * and a digest of the look, so it is long — measured over 512 keys built by the real `appearanceKey`
 * from real `CharSections` rows, the mean is 389 characters and the whole ledger costs **375.1 KiB**
 * when nothing else is holding the strings alive. That is the price of never allocating a 512x512
 * canvas sixty times a second, and it is paid only by a session that meets 512 distinct unpaintable
 * looks. Eviction is by insertion order, so the oldest look is the one that gets another chance.
 *
 * An entry carries the look's layers as well as its deadline, because a body that painted without
 * one of them has to be recomposable without the renderer, which has stopped asking. Measured over
 * 512 distinct looks enumerated from the creation options of every race — mean key 455 characters,
 * mean 7.8 layers — the map's own table costs **42.1 KiB** against **14.0 KiB** for a map of bare
 * deadlines, and the layer list itself is the array the appearance already owns rather than a copy.
 */
export const ATLAS_FAILURE_LIMIT = 512;

/** Soft residency defaults. Logical texture bytes are an allocation estimate, never a VRAM claim. */
export const CHARACTER_ATLAS_CACHE_COUNT_LIMIT = 96;
export const CHARACTER_ATLAS_KNOWN_LOGICAL_TEXTURE_BYTE_LIMIT = 128 * 1024 * 1024;
export const CHARACTER_ATLAS_SOURCE_CACHE_COUNT_LIMIT = 512;
/** Exact decoded surface area. Browser-owned decoded byte storage remains unknown. */
export const CHARACTER_ATLAS_SOURCE_DECODED_PIXEL_LIMIT = 64 * 1024 * 1024;
export const CHARACTER_ATLAS_SOURCE_RESPONSE_LIMIT_BYTES = 4 * 1024 * 1024;
export const CHARACTER_ATLAS_SOURCE_ENTRY_PIXEL_LIMIT = 1024 * 1024;
/** Canvas paints are indivisible; spread a burst of completed looks over animation frames. */
export const CHARACTER_ATLAS_PAINTS_PER_FRAME = 2;

export interface CharacterAtlasResidencyLimits {
  readonly atlasCount: number;
  readonly atlasKnownLogicalTextureBytes: number;
  readonly sourceCount: number;
  readonly sourceDecodedPixels: number;
  readonly sourceResponseBytes: number;
  readonly sourceEntryPixels: number;
}

export interface CharacterAtlasClientOptions {
  readonly limits?: Partial<CharacterAtlasResidencyLimits>;
}

export interface CharacterAtlasResidencyStats {
  readonly atlases: Readonly<{
    readonly count: number;
    readonly knownLogicalTextureBytes: number;
    readonly unknownLogicalTextureCount: number;
    readonly pinnedCount: number;
    readonly overflowCount: number;
    readonly overflowKnownLogicalTextureBytes: number;
  }>;
  readonly sources: Readonly<{
    readonly count: number;
    readonly uniqueReadyBitmaps: number;
    readonly decodedPixels: number;
    /** Ready bitmap identities whose browser-owned decoded byte size is deliberately unsupported. */
    readonly decodedByteSizeUnsupportedCount: number;
    readonly activeLeases: number;
    readonly pinnedCount: number;
    readonly terminalCount: number;
    readonly overflowCount: number;
    readonly overflowDecodedPixels: number;
  }>;
}

type CharacterAtlasImageStatus = "pending" | "ready" | "terminal";

interface CharacterAtlasBitmapOwnership {
  readonly image: ImageBitmap;
  readonly pixels: number;
  /** Resource-level LRU token: touching any aliased path promotes the shared decoded surface. */
  lastTouch: number;
  references: number;
}

interface CharacterAtlasImageEntry {
  readonly path: string;
  readonly epoch: number;
  readonly requestId: number;
  readonly abort: AbortController;
  status: CharacterAtlasImageStatus;
  promise: Promise<ImageBitmap | undefined>;
  image?: ImageBitmap;
  bitmap?: CharacterAtlasBitmapOwnership;
  readonly leases: Set<CharacterAtlasImageLease>;
}

interface CharacterAtlasImageLease {
  readonly entry: CharacterAtlasImageEntry;
  readonly owner: CharacterAtlasComposeRequest;
  image?: ImageBitmap;
  released: boolean;
}

interface CharacterAtlasEntry {
  readonly key: string;
  readonly texture: THREE.Texture;
  knownLogicalTextureBytes: number | undefined;
}

interface CharacterAtlasComposeRequest {
  readonly key: string;
  readonly epoch: number;
  readonly requestId: number;
  readonly leases: Set<CharacterAtlasImageLease>;
  promise: Promise<THREE.Texture | undefined>;
}

interface CharacterAtlasPaintWaiter {
  readonly request: CharacterAtlasComposeRequest;
  readonly resolve: () => void;
}

class DeterministicCharacterAtlasImageError extends Error {}

/** A renderer capability that is not finite or below three's baseline cannot improve sampling. */
export function normalizeCharacterAtlasAnisotropy(maxAnisotropy: number): number {
  return Number.isFinite(maxAnisotropy) ? Math.max(1, maxAnisotropy) : 1;
}

/**
 * Applies the sampling state owned by a character atlas before it is handed to a world material.
 *
 * Supplied textures deliberately stay untouched in `ModelBuild`; this is the atlas/renderer
 * integration point instead. The return value lets callers and tests tell an actual state change
 * from an idempotent handoff, so `needsUpdate` is not bumped once per frame.
 */
export function configureCharacterAtlasTexture(texture: THREE.Texture, maxAnisotropy: number): boolean {
  const anisotropy = normalizeCharacterAtlasAnisotropy(maxAnisotropy);
  let changed = false;
  if (texture.colorSpace !== THREE.SRGBColorSpace) {
    texture.colorSpace = THREE.SRGBColorSpace;
    changed = true;
  }
  if (texture.wrapS !== THREE.ClampToEdgeWrapping) {
    texture.wrapS = THREE.ClampToEdgeWrapping;
    changed = true;
  }
  if (texture.wrapT !== THREE.ClampToEdgeWrapping) {
    texture.wrapT = THREE.ClampToEdgeWrapping;
    changed = true;
  }
  if (texture.flipY !== false) {
    texture.flipY = false;
    changed = true;
  }
  if (texture.anisotropy !== anisotropy) {
    texture.anisotropy = anisotropy;
    changed = true;
  }
  if (changed) texture.needsUpdate = true;
  return changed;
}

/** Composes one character body texture. Layers are painted in the order the gateway lists them. */
export class CharacterAtlasClient {
  readonly #baseUrl: string;
  readonly #limits: CharacterAtlasResidencyLimits;
  readonly #images = new Map<string, CharacterAtlasImageEntry>();
  readonly #atlases = new Map<string, CharacterAtlasEntry>();
  /** Raw appearance keys; the client instance/epoch, not a rewritten key, is the session boundary. */
  #residencyPins = new Set<string>();
  #readinessKeys = new Set<string>();
  #hasCommittedFootprint = false;
  #atlasKnownLogicalTextureBytes = 0;
  #sourceDecodedPixels = 0;
  #sourceBitmapCount = 0;
  #bitmapOwnership = new WeakMap<ImageBitmap, CharacterAtlasBitmapOwnership>();
  /** Incremented for every successful repaint, including an in-place CanvasTexture update. */
  readonly #generations = new Map<string, number>();
  /** Compositions under way, so one look is painted once however many units are waiting on it. */
  readonly #composing = new Map<string, CharacterAtlasComposeRequest>();
  /** Loaded looks awaiting a small, shared canvas-paint allowance. */
  readonly #paintQueue: CharacterAtlasPaintWaiter[] = [];
  #paintScheduled = false;
  #paintFrameId: number | undefined;
  #paintFallbackTimer: ReturnType<typeof setTimeout> | undefined;
  /** Image paths with a request actually in flight; resolved image promises are cache, not work. */
  readonly #activeImages = new Set<string>();
  /** Looks whose current atlas can never become complete without a new owner/cache epoch. */
  readonly #terminalFailures = new Set<string>();
  /** Exact successful image/composition settles; errors are current terminal failures below. */
  #success = 0;
  #generation = 0;
  #epoch = 0;
  #requestSequence = 0;
  #imageTouchSequence = 0;
  #disposed = false;
  /** A decoder is expected to return a fresh bitmap, but non-standard implementations need this guard. */
  readonly #closedImages = new WeakSet<ImageBitmap>();
  /** THREE emits disposal listeners synchronously and on every call; ownership closes exactly once. */
  readonly #disposedTextures = new WeakSet<THREE.Texture>();
  /**
   * Paths whose picture did not come: how many times it has been asked for, and when to ask again.
   *
   * `after` is `Infinity` for a path that will not be asked for again — the backoff has run out, or
   * the gateway answered something definitive like a 404.
   */
  readonly #imageFailures = new Map<string, { attempts: number; after: number }>();
  /**
   * Looks that did not paint in full, and the moment — if ever — worth composing them again.
   *
   * Two failures share this ledger because they are one question, "when is this look worth another
   * composition", and they differ only in what the caller sees meanwhile.
   *
   * A look that composed to **nothing** is Т6's first half: `#build` returned undefined when
   * nothing painted, `#composing` was cleared in `finally`, and the renderer called `compose` again
   * on the very next frame because the unit's `applied` was still empty — so an affected unit
   * allocated a fresh 512x512 canvas sixty times a second and stayed a capsule for ever. Reachable
   * on the eight extended displays whose bake is not in the archives, and after Т1 on any of the
   * twenty playable base displays, the most reused humanoid ids in `creature_template`.
   *
   * A look that composed **without one of its layers** is the review's finding and the shape of the
   * player report that opened the plan — «у кого-то не видно ног», a body with no trousers rather
   * than a capsule. That unit is built, so `applied` is set and the renderer never asks about it
   * again; `refresh` is its driver, and the repaint goes into the canvas the material is already
   * sampling rather than into a new texture nothing would look at.
   *
   * The layers are kept beside the deadline because that second case has no other way back: the
   * only other holder of them is the unit's metadata, which the renderer has stopped consulting.
   */
  readonly #failed = new Map<string, { until: number; layers: readonly BodyLayer[] }>();
  /**
   * The earliest deadline in that ledger, so `refresh` is one number comparison on a frame with
   * nothing to do — which is every frame but a handful in a session.
   */
  #nextRefresh = Infinity;
  readonly #now: () => number;

  /**
   * @param now the clock the backoff is measured against. Injected so a test can drive half a
   * minute of waiting without spending it.
   */
  constructor(baseUrl: string, now: () => number = Date.now, options: CharacterAtlasClientOptions = {}) {
    this.#baseUrl = baseUrl;
    this.#now = now;
    const limits: CharacterAtlasResidencyLimits = {
      atlasCount: options.limits?.atlasCount ?? CHARACTER_ATLAS_CACHE_COUNT_LIMIT,
      atlasKnownLogicalTextureBytes: options.limits?.atlasKnownLogicalTextureBytes
        ?? CHARACTER_ATLAS_KNOWN_LOGICAL_TEXTURE_BYTE_LIMIT,
      sourceCount: options.limits?.sourceCount ?? CHARACTER_ATLAS_SOURCE_CACHE_COUNT_LIMIT,
      sourceDecodedPixels: options.limits?.sourceDecodedPixels
        ?? CHARACTER_ATLAS_SOURCE_DECODED_PIXEL_LIMIT,
      sourceResponseBytes: options.limits?.sourceResponseBytes
        ?? CHARACTER_ATLAS_SOURCE_RESPONSE_LIMIT_BYTES,
      sourceEntryPixels: options.limits?.sourceEntryPixels
        ?? CHARACTER_ATLAS_SOURCE_ENTRY_PIXEL_LIMIT,
    };
    for (const [name, value] of Object.entries(limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError(`character atlas ${name} limit must be a positive safe integer`);
      }
    }
    this.#limits = Object.freeze(limits);
  }

  /** Immutable asynchronous work snapshot for the formal replay readiness barrier. */
  get stats(): Readonly<BenchmarkAsyncReadinessStats> {
    const active = (key: string): boolean => !this.#hasCommittedFootprint || this.#readinessKeys.has(key);
    let pendingImages = 0;
    for (const entry of this.#images.values()) {
      if (entry.status !== "pending") continue;
      if (!this.#hasCommittedFootprint
        || [...entry.leases].some((lease) => !lease.released && active(lease.owner.key))) {
        pendingImages++;
      }
    }
    return Object.freeze({
      // `#images` also holds resolved successful promises, so only this set is pending. A
      // composition remains pending until its canvas has been painted and installed. A finite
      // failed-look deadline is scheduled retry work as well; an Infinity entry is terminal. A
      // due retry already present in `#composing` is counted there once, not twice.
      pending: pendingImages + [...this.#composing.keys()].filter(active).length
        + [...this.#failed.entries()]
          .filter(([key, { until }]) => active(key)
            && until !== Infinity && !this.#composing.has(key)).length,
      success: this.#success,
      // Candidate 404s and retryable gateway failures are not owner-terminal errors. They remain
      // pending while retryable; only a look with no possible retry is fail-closed here.
      error: [...this.#terminalFailures].filter(active).length,
      generation: this.#generation,
    });
  }

  /** Immutable exact current atlas/source residency and soft-budget overflow. */
  get residencyStats(): Readonly<CharacterAtlasResidencyStats> {
    let atlasUnknown = 0;
    let atlasPinned = 0;
    for (const entry of this.#atlases.values()) {
      if (entry.knownLogicalTextureBytes === undefined) atlasUnknown++;
      if (this.#atlasPinned(entry.key)) atlasPinned++;
    }
    let activeLeases = 0;
    let sourcePinned = 0;
    let terminalCount = 0;
    for (const entry of this.#images.values()) {
      activeLeases += entry.leases.size;
      if (entry.status === "pending" || entry.leases.size > 0) sourcePinned++;
      if (entry.status === "terminal") terminalCount++;
    }
    return Object.freeze({
      atlases: Object.freeze({
        count: this.#atlases.size,
        knownLogicalTextureBytes: this.#atlasKnownLogicalTextureBytes,
        unknownLogicalTextureCount: atlasUnknown,
        pinnedCount: atlasPinned,
        overflowCount: Math.max(0, this.#atlases.size - this.#limits.atlasCount),
        overflowKnownLogicalTextureBytes: Math.max(
          0, this.#atlasKnownLogicalTextureBytes - this.#limits.atlasKnownLogicalTextureBytes,
        ),
      }),
      sources: Object.freeze({
        count: this.#images.size,
        uniqueReadyBitmaps: this.#sourceBitmapCount,
        decodedPixels: this.#sourceDecodedPixels,
        decodedByteSizeUnsupportedCount: this.#sourceBitmapCount,
        activeLeases,
        pinnedCount: sourcePinned,
        terminalCount,
        overflowCount: Math.max(0, this.#images.size - this.#limits.sourceCount),
        overflowDecodedPixels: Math.max(
          0, this.#sourceDecodedPixels - this.#limits.sourceDecodedPixels,
        ),
      }),
    });
  }

  get revision(): number {
    return this.#generation;
  }

  /** Applies a renderer's current atlas policy to every cached body without replacing its Texture. */
  setAnisotropy(maxAnisotropy: number): void {
    for (const { texture } of this.#atlases.values()) {
      configureCharacterAtlasTexture(texture, maxAnisotropy);
    }
  }

  /** Visits cached atlases and decoded sources without inventing browser-owned decoded bytes. */
  visitRetainedResources(visitor: RetainedResourceVisitor): void {
    for (const entry of this.#atlases.values()) visitor.referenceGpuTexture(entry, entry.texture);
    for (const entry of this.#images.values()) {
      if (entry.image) visitor.referenceUnsupported(entry, entry.image);
    }
  }

  /** A finished texture if it has been composed, otherwise undefined while it is being built. */
  get(key: string): THREE.Texture | undefined {
    if (this.#disposed) return undefined;
    const entry = this.#atlases.get(key);
    if (!entry) return undefined;
    this.#touchAtlas(entry);
    return entry.texture;
  }

  /** A stable repaint token for consumers that cache a rendered image of the atlas. */
  generation(key: string): number {
    if (this.#disposed) return 0;
    return this.#generations.get(key) ?? 0;
  }

  /**
   * Starts composing, or returns the finished texture. The caller polls with `get` on later
   * frames rather than waiting, because a unit is drawn as a stand-in until its body is ready.
   */
  async compose(key: string, layers: readonly BodyLayer[]): Promise<THREE.Texture | undefined> {
    if (this.#disposed) return undefined;
    const existingEntry = this.#atlases.get(key);
    if (existingEntry) this.#touchAtlas(existingEntry);
    const existing = existingEntry?.texture;
    const pendingRetry = this.#failed.get(key);
    const waiting = pendingRetry !== undefined && this.#now() < pendingRetry.until;
    // A finished body, or one that is short a layer whose next attempt is not due yet. Falling
    // through with a texture in hand is the recomposition: the missing layer's wait is over.
    if (existing && (pendingRetry === undefined || waiting)) return existing;
    if (layers.length === 0) return undefined;
    // An exhausted look is terminal ownership, not a reason to allocate another canvas or
    // re-request the same paths on every frame. `release`/`retain` remove this ledger when a new
    // owner appears, so a genuine new ownership epoch can still retry it.
    if (this.#terminalFailures.has(key)) return existing;
    // One composition per look, not one per caller. The renderer asks again on every frame a body
    // is not ready, and once for each unit wearing that look, so a single second of waiting at
    // 60 fps produced sixty 512x512 canvases for one character — all but the last thrown away,
    // and the last one replacing a texture other builds were already holding.
    const inFlight = this.#composing.get(key);
    if (inFlight) return inFlight.promise;
    // And one composition per *failure*, not one per frame after it. Checked after `#composing`
    // so a build under way is still shared, and before any work at all.
    if (waiting) return undefined;
    const request: CharacterAtlasComposeRequest = {
      key,
      epoch: this.#epoch,
      requestId: ++this.#requestSequence,
      leases: new Set(),
      promise: Promise.resolve(undefined),
    };
    let resolveRequest!: (texture: THREE.Texture | undefined) => void;
    const requestPromise = new Promise<THREE.Texture | undefined>((resolve) => {
      resolveRequest = resolve;
    });
    request.promise = requestPromise;
    // Publish the exact request before starting any source call. A synchronous test loader may
    // re-enter compose(); it must receive this same facade rather than start duplicate ownership.
    this.#composing.set(key, request);
    let settled = false;
    const settle = (texture: THREE.Texture | undefined): void => {
      if (settled || !this.#isCurrentCompose(request)) return;
      settled = true;
      this.#generation++;
      const failure = this.#failed.get(key);
      if (this.#terminalFailures.has(key)
        || failure?.until === Infinity
        || texture === undefined && failure === undefined) {
        this.#terminalFailures.add(key);
      } else if (failure === undefined) {
        this.#terminalFailures.delete(key);
      }
      if (texture !== undefined) this.#success++;
    };
    const pending = this.#build(request, layers)
      .then((texture) => {
        if (!this.#isCurrentCompose(request)) return undefined;
        settle(texture);
        return texture;
      }, () => {
        if (!this.#isCurrentCompose(request)) return undefined;
        // A synchronous canvas/decoder rejection is an owned terminal look, too. Record it through
        // the same Infinity ledger as an exhausted image request so a renderer frame cannot retry
        // the rejected composition forever. Production callers deliberately fire-and-forget this
        // work, so the owned failure resolves empty instead of escaping as an unhandled rejection.
        this.#defer(key, layers, Infinity);
        settle(undefined);
        return undefined;
      })
      .finally(() => {
        if (this.#composing.get(key) === request) {
          this.#composing.delete(key);
          this.#pruneImageFailures();
          this.#evictAtlases();
        }
      });
    // The facade was installed before #build began, so even a synchronous reentrant caller shares
    // this settlement. The owned work handles its own failures above; keep the facade non-rejecting
    // even if a future cleanup callback unexpectedly throws.
    void pending.then(resolveRequest, () => resolveRequest(undefined));
    return requestPromise;
  }

  #waitForPaintTurn(request: CharacterAtlasComposeRequest): Promise<void> {
    // Node tools and page-free tests have no frame clock; their composition remains immediate.
    if (typeof requestAnimationFrame !== "function") return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.#paintQueue.push({ request, resolve });
      this.#schedulePaintTurn();
    });
  }

  #schedulePaintTurn(): void {
    if (this.#paintScheduled || this.#paintQueue.length === 0) return;
    this.#paintScheduled = true;
    this.#paintFrameId = requestAnimationFrame(() => this.#flushPaintTurn());
    // requestAnimationFrame pauses in a hidden tab. Settle pending work there as well, so an
    // ownership change cannot leave decoded image leases waiting until the tab is shown again.
    this.#paintFallbackTimer = setTimeout(() => this.#checkHiddenPaintTurn(), 100);
  }

  #checkHiddenPaintTurn(): void {
    if (!this.#paintScheduled) return;
    if (document.hidden) {
      this.#flushPaintTurn();
    } else {
      // A slow visible frame still has just one frame allowance; the timer only substitutes for
      // a paused rAF once the tab is actually hidden.
      this.#paintFallbackTimer = setTimeout(() => this.#checkHiddenPaintTurn(), 100);
    }
  }

  #stopPaintSchedule(): void {
    if (this.#paintFrameId !== undefined && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this.#paintFrameId);
    }
    if (this.#paintFallbackTimer !== undefined) clearTimeout(this.#paintFallbackTimer);
    this.#paintFrameId = undefined;
    this.#paintFallbackTimer = undefined;
    this.#paintScheduled = false;
  }

  #flushPaintTurn(): void {
    if (!this.#paintScheduled) return;
    this.#stopPaintSchedule();
    let admitted = 0;
    while (this.#paintQueue.length > 0 && admitted < CHARACTER_ATLAS_PAINTS_PER_FRAME) {
      const waiter = this.#paintQueue.shift()!;
      if (this.#isCurrentCompose(waiter.request)) admitted++;
      waiter.resolve();
    }
    this.#schedulePaintTurn();
  }

  #cancelPaintWaiters(request: CharacterAtlasComposeRequest): void {
    for (let index = this.#paintQueue.length - 1; index >= 0; index--) {
      const waiter = this.#paintQueue[index]!;
      if (waiter.request !== request) continue;
      this.#paintQueue.splice(index, 1);
      waiter.resolve();
    }
    if (this.#paintQueue.length === 0) this.#stopPaintSchedule();
  }

  #cancelAllPaintWaiters(): void {
    this.#stopPaintSchedule();
    for (const waiter of this.#paintQueue.splice(0)) waiter.resolve();
  }

  /**
   * Publishes a first body out of the layers that have arrived, so the unit can leave its capsule;
   * `#build` repaints the same canvas with every layer once the rest land. Nothing here touches the
   * failure ledger — the full paint that follows is what decides whether a layer is missing.
   */
  async #paintFirst(request: CharacterAtlasComposeRequest, layers: readonly BodyLayer[],
    arrived: readonly (CharacterAtlasImageLease | undefined | null)[]): Promise<void> {
    await this.#waitForPaintTurn(request);
    if (!this.#isCurrentCompose(request) || this.#atlases.has(request.key)) return;
    const canvas = document.createElement("canvas");
    canvas.width = BODY_TEXTURE_SIZE;
    canvas.height = BODY_TEXTURE_SIZE;
    const context = canvas.getContext("2d");
    if (!context) return;
    if (paintBodyLayers(context, layers, arrived.map((lease) => lease?.image)) === 0) return;
    const texture = new THREE.CanvasTexture(canvas);
    configureBodyTexture(texture);
    this.#setAtlasEntry({ key: request.key, texture, knownLogicalTextureBytes: undefined });
    this.#generations.set(request.key, (this.#generations.get(request.key) ?? 0) + 1);
    // Owed its remaining layers: were this composition abandoned before its full paint, `compose`
    // would otherwise hand the partial body out as finished. The full paint clears it.
    this.#defer(request.key, layers, this.#now());
  }

  async #build(request: CharacterAtlasComposeRequest,
    layers: readonly BodyLayer[]): Promise<THREE.Texture | undefined> {
    const { key } = request;
    const spellings = layers.map((layer) => layerPaths(layer));
    // What each layer settled to so far: `null` still on its way, `undefined` settled with nothing.
    const arrived: (CharacterAtlasImageLease | undefined | null)[] = layers.map(() => null);
    const pending = spellings.map(async (paths, index) => {
      let found: CharacterAtlasImageLease | undefined;
      for (const path of paths) {
        // A released primary candidate can settle empty after its last lease aborts. Do not let
        // that stale continuation acquire an alternate-path lease that did not exist when release
        // walked the request's ownership set.
        if (!this.#isCurrentCompose(request)) break;
        found = await this.#image(path, request);
        if (found) break;
      }
      arrived[index] = found;
      return found;
    });
    const everything = Promise.all(pending);
    // A first body gets painted once its base skin is here, rather than when its last layer is: the
    // unit stays a capsule until `get` answers, and one cold layer used to hold all of it. Measured on
    // the owner's session of 2026-09-28, the gateway published a cold texture every ~412 ms, one at a
    // time, and a dressed character paints up to 24 layers. The grace keeps a body whose layers all
    // arrive together from flashing bare skin; the full paint below lands in the same canvas.
    if (layers.length > 1 && layers[0]?.section === undefined && !this.#atlases.has(key)) {
      const base = await pending[0];
      if (base && arrived.includes(null)) {
        const complete = await Promise.race([
          everything.then(() => true),
          new Promise<false>((resolve) => { setTimeout(() => resolve(false), CHARACTER_ATLAS_PARTIAL_PAINT_MS); }),
        ]);
        if (!complete) await this.#paintFirst(request, layers, arrived);
      }
    }
    const leases = await everything;
    try {
      const images = leases.map((lease) => lease?.image);
      // `release` and `dispose` are ownership boundaries. A request that crossed either may finish
      // its shared image reads, but it must not allocate a canvas or publish into a replacement key.
      if (!this.#isCurrentCompose(request)) return undefined;
      // When — if ever — a layer that did not arrive could arrive. Only the layers with no picture
      // are asked about: a layer that painted from its second spelling has a failure recorded against
      // its first, and recomposing a finished body to change which spelling it used would be work for
      // no pixels.
      const retryAt = this.#retryAt(spellings, images);
      // Before the canvas, not after it: a look that resolves to nothing is exactly the case this
      // whole ledger exists for, and allocating 512x512 to discover it is the cost that was being
      // paid sixty times a second.
      if (!images.some((image) => image !== undefined)) {
        this.#defer(key, layers, retryAt);
        return undefined;
      }
      // Several decoded looks can finish in one microtask turn when entering a city. Painting all
      // their 512x512 canvases there blocks the next frame even though the downloads were async.
      // Admit at most two paints per animation frame; a hidden tab uses the fallback timer.
      await this.#waitForPaintTurn(request);
      if (!this.#isCurrentCompose(request)) return undefined;
      // Painted into the canvas the last composition used, when there was one. A material holds the
      // Texture object, not the atlas map, so a body that gains its missing trousers has to gain them
      // *in place* — a new CanvasTexture would sit in this map with nothing sampling it.
      const previous = this.#atlases.get(key);
      const canvas = (previous?.texture.image as HTMLCanvasElement | undefined)
        ?? document.createElement("canvas");
      canvas.width = BODY_TEXTURE_SIZE;
      canvas.height = BODY_TEXTURE_SIZE;
      const context = canvas.getContext("2d");
      if (!context) {
        this.#defer(key, layers, Infinity);
        return undefined;
      }

      const painted = paintBodyLayers(context, layers, images);
      if (painted === 0) {
        this.#defer(key, layers, retryAt);
        return undefined;
      }

      const texture = previous?.texture ?? new THREE.CanvasTexture(canvas);
      configureBodyTexture(texture);
      const entry = previous ?? { key, texture, knownLogicalTextureBytes: undefined };
      this.#setAtlasEntry(entry);
      this.#generations.set(key, (this.#generations.get(key) ?? 0) + 1);
      if (painted === layers.length) {
        this.#failed.delete(key);
        this.#terminalFailures.delete(key);
      } else if (retryAt === Infinity) {
        this.#failed.delete(key);
        this.#markTerminal(key);
      } else {
        this.#defer(key, layers, retryAt);
      }
      return texture;
    } finally {
      for (const lease of leases) {
        if (lease) this.#releaseImageLease(lease);
      }
    }
  }

  /**
   * The earliest moment a layer that did not arrive could arrive, or `Infinity` for never.
   *
   * Never, unless one of the missing layers is a picture that failed transiently and still has
   * attempts left. Being wrong in the other direction — deferring for ever a look that would have
   * worked — is what the old code did by never recording anything at all and rebuilding instead.
   */
  #retryAt(spellings: readonly (readonly string[])[], images: readonly (ImageBitmap | undefined)[]): number {
    let until = Infinity;
    for (let index = 0; index < spellings.length; index++) {
      if (images[index]) continue;
      for (const path of spellings[index]!) {
        const failure = this.#imageFailures.get(path);
        if (failure) until = Math.min(until, failure.after);
      }
    }
    return until;
  }

  /** Remembers this look and when it is next worth composing, on a ledger with a ceiling. */
  #defer(key: string, layers: readonly BodyLayer[], until: number): void {
    // Re-inserted rather than updated, so a look that fails again goes to the back of the queue and
    // the oldest one is what a full ledger forgets. A partly painted body evicted that way keeps
    // the pixels it has and stops waiting for the rest, which is the right way round to be wrong.
    this.#failed.delete(key);
    this.#failed.set(key, { until, layers });
    if (until === Infinity) this.#markTerminal(key);
    this.#recomputeNextRefresh();
    while (this.#failed.size > ATLAS_FAILURE_LIMIT) {
      const oldest = this.#failed.keys().next().value;
      if (oldest === undefined) break;
      this.#failed.delete(oldest);
      this.#terminalFailures.delete(oldest);
    }
    this.#recomputeNextRefresh();
  }

  /**
   * Repaints any body that is short a layer whose next attempt has come due.
   *
   * Called once a frame by the renderer, and it has to be: a unit whose body painted at all is a
   * built unit, its `applied` is set, and nothing asks the atlas about it ever again — which is why
   * a leg layer that 500'd once used to be missing for the life of the tab even after Т6 gave the
   * *path* a backoff. A look that painted nothing has the renderer itself as its driver, because
   * the unit is still a capsule and still asking, so those are left alone here.
   *
   * The guard is one comparison against the earliest deadline in the ledger; the map is only walked
   * on the handful of frames where something is actually due.
   */
  refresh(): void {
    if (this.#disposed) return;
    if (this.#now() < this.#nextRefresh) return;
    let next = Infinity;
    for (const [key, pending] of this.#failed) {
      if (!this.#atlases.has(key)) continue;
      // After the renderer has committed a submitted-frame footprint, dormant warm atlases are
      // residency only. Retrying one inside a formal run would add unrelated network/composition
      // work and advance global readiness generations even though no submitted borrower can see
      // the result. Re-entry is not lost: commitPins() recomputes #nextRefresh from the newly active
      // raw keys, so an already-due dormant retry starts as soon as that appearance is submitted.
      if (this.#hasCommittedFootprint && !this.#readinessKeys.has(key)) continue;
      if (pending.until <= this.#now()) void this.compose(key, pending.layers);
      else next = Math.min(next, pending.until);
    }
    // Set before the composes above settle, and `#defer` lowers it again from inside them.
    this.#nextRefresh = next;
  }

  /**
   * How many looks are being remembered as not fully painted — the ones that painted nothing and
   * the ones still short a layer. Read by the tests that bound the ledger.
   */
  get failures(): number {
    return this.#failed.size;
  }

  #image(path: string, owner: CharacterAtlasComposeRequest): Promise<CharacterAtlasImageLease | undefined> {
    if (this.#disposed) return Promise.resolve(undefined);
    let entry = this.#images.get(path);
    if (entry) {
      this.#touchImage(entry);
      if (entry.status === "terminal") return Promise.resolve(undefined);
    } else {
      const failure = this.#imageFailures.get(path);
      if (failure && this.#now() < failure.after) return Promise.resolve(undefined);
      entry = this.#startImage(path, (failure?.attempts ?? 0) + 1);
    }
    const lease: CharacterAtlasImageLease = { entry, owner, released: false };
    entry.leases.add(lease);
    owner.leases.add(lease);
    return entry.promise.then((image) => {
      if (lease.released || !image || entry?.image !== image) {
        this.#releaseImageLease(lease);
        return undefined;
      }
      lease.image = image;
      return lease;
    }, () => {
      this.#releaseImageLease(lease);
      return undefined;
    });
  }

  #startImage(path: string, attempt: number): CharacterAtlasImageEntry {
    const entry: CharacterAtlasImageEntry = {
      path,
      epoch: this.#epoch,
      requestId: ++this.#requestSequence,
      abort: new AbortController(),
      status: "pending",
      promise: Promise.resolve(undefined),
      leases: new Set(),
    };
    this.#activeImages.add(path);
    this.#images.set(path, entry);
    let settled = false;
    const settle = (success: boolean): void => {
      if (settled || !this.#isCurrentImage(entry)) return;
      settled = true;
      this.#activeImages.delete(path);
      this.#generation++;
      if (success) this.#success++;
    };
    let request: Promise<ImageBitmap | undefined>;
    try {
      request = this.#fetchImage(path, entry.abort.signal)
        .then((answer) => {
          if (!this.#isCurrentImage(entry)) {
            if (answer.image) this.#closeUnownedImage(answer.image);
            return undefined;
          }
          if (answer.image) {
            this.#admitImage(entry, answer.image, answer.pixels!);
            this.#imageFailures.delete(path);
            settle(true);
            this.#evictImages();
            return answer.image;
          }
          this.#recordImageFailure(path, attempt, answer.transient === true);
          settle(false);
          if (answer.terminal === true) {
            entry.status = "terminal";
            this.#touchImage(entry);
            this.#evictImages();
          } else if (this.#images.get(path) === entry) {
            this.#images.delete(path);
          }
          return undefined;
        })
        .catch(() => {
          if (!this.#isCurrentImage(entry)) return undefined;
          this.#recordImageFailure(path, attempt, true);
          settle(false);
          this.#images.delete(path);
          return undefined;
        });
    } catch {
      if (this.#isCurrentImage(entry)) {
        this.#recordImageFailure(path, attempt, true);
        settle(false);
        this.#images.delete(path);
      }
      request = Promise.resolve(undefined);
    }
    entry.promise = request;
    return entry;
  }

  async #fetchImage(path: string, signal: AbortSignal): Promise<{
    image?: ImageBitmap;
    pixels?: number;
    transient?: boolean;
    terminal?: boolean;
  }> {
    try {
      const response = await fetch(textureUrl(this.#baseUrl, path), { signal });
      if (signal.aborted) return { transient: true };
      // 404 and deterministic size violations are exact session/path answers. Gateway or network
      // faults retain the existing 2/8/30 second retry policy.
      if (!response.ok) {
        const transient = response.status >= 500 || response.status === 408 || response.status === 429;
        return { transient, terminal: !transient };
      }
      const blob = await readBoundedCharacterAtlasImage(response, this.#limits.sourceResponseBytes);
      // A minimal fetch polyfill may ignore AbortSignal. Do not decode or publish its answer after
      // the last exact compose owner has left, even in that non-standard environment.
      if (signal.aborted) return { transient: true };
      const image = await createImageBitmap(blob);
      try {
        if (signal.aborted) {
          this.#closeUnownedImage(image);
          return { transient: true };
        }
        if (this.#closedImages.has(image)) return { terminal: true };
        const pixels = decodedImagePixels(image, this.#limits.sourceEntryPixels);
        if (pixels !== undefined) return { image, pixels };
        this.#closeUnownedImage(image);
        return { terminal: true };
      } catch {
        this.#closeUnownedImage(image);
        return { terminal: true };
      }
    } catch (error) {
      if (error instanceof DeterministicCharacterAtlasImageError) return { terminal: true };
      // A throw is the network or a decoder failure, never a definitive source answer.
      return { transient: true };
    }
  }

  /** How many composed bodies are being held. */
  get size(): number {
    return this.#atlases.size;
  }

  /**
   * Forgets one composed body.
   *
   * The source images stay: they are shared between every character that wears the piece, they
   * are the cheap half, and a body that is composed again would only have to fetch them back.
   */
  release(key: string): void {
    if (this.#disposed) return;
    const composing = this.#composing.get(key);
    if (composing) {
      // Invalidate publication first. Releasing its exact leases may synchronously abort the last
      // pending source request, whose callbacks must already see this compose as stale.
      this.#composing.delete(key);
      this.#cancelPaintWaiters(composing);
      for (const lease of [...composing.leases]) this.#releaseImageLease(lease);
    }
    const entry = this.#atlases.get(key);
    // Remove the complete ownership boundary before invoking external disposal listeners. A
    // listener is allowed to compose the same raw key synchronously; it must see an empty slot and
    // the outer release must not subsequently delete its replacement.
    if (entry) this.#dropAtlasOwnership(entry);
    this.#generations.delete(key);
    this.#terminalFailures.delete(key);
    this.#failed.delete(key);
    this.#recomputeNextRefresh();
    this.#pruneImageFailures();
    if (entry) this.#disposeTexture(entry.texture);
    this.#evictImages();
  }

  /**
   * Forgets every composed body but these.
   *
   * A body is composed before the model that wears it has necessarily arrived, so an atlas can
   * outlive the only look that wanted it without a build ever being made from it — and the build
   * cache is what usually carries a look out of memory. This is the backstop for the ones that
   * never get that far.
   */
  retain(keys: ReadonlySet<string>): void {
    if (this.#disposed) return;
    const owned = new Set([
      ...this.#atlases.keys(),
      ...this.#composing.keys(),
      ...this.#failed.keys(),
      ...this.#terminalFailures,
    ]);
    for (const key of owned) {
      if (!keys.has(key)) this.release(key);
    }
  }

  /**
   * Cancels asynchronous/failure ownership that no submitted-frame borrower can still reach.
   *
   * Kept separate from `retain`: a small successful atlas cache is allowed to stay warm, while a
   * no-paint 500/404 must not keep formal readiness pending/failed after its unit has left view.
   */
  pruneInactiveWork(keys: ReadonlySet<string>): void {
    if (this.#disposed) return;
    // A partial atlas may still be sampled by an inactive built-cache entry. Keep its retry ledger
    // dormant so it can resume on re-entry; only no-atlas capsule work is safe to cancel outright.
    const owned = new Set([...this.#composing.keys(), ...this.#failed.keys(), ...this.#terminalFailures]);
    for (const key of owned) {
      if (!keys.has(key) && !this.#atlases.has(key)) this.release(key);
    }
    this.#recomputeNextRefresh();
  }

  /** Replaces the last submitted frame's exact atlas pins and applies both soft residency caps. */
  commitPins(residencyKeys: ReadonlySet<string>, readinessKeys: ReadonlySet<string> = residencyKeys): void {
    if (this.#disposed) return;
    this.#residencyPins = new Set(residencyKeys);
    this.#readinessKeys = new Set(readinessKeys);
    this.#hasCommittedFootprint = true;
    this.#recomputeNextRefresh();
    this.#evictAtlases();
    this.#evictImages();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#epoch++;
    const textures = new Set([...this.#atlases.values()].map((entry) => entry.texture));
    const images = [...this.#images.values()]
      .map((entry) => entry.image)
      .filter((image): image is ImageBitmap => image !== undefined);
    const pendingAborts = [...this.#images.values()]
      .filter((entry) => entry.status === "pending")
      .map((entry) => entry.abort);
    // Make the whole client inert before any synchronous THREE disposal listener can re-enter it.
    // Cleanup callbacks therefore observe the same empty state as every later caller, and a
    // throwing listener cannot prevent the remaining owned resources from being released.
    this.#atlases.clear();
    this.#residencyPins.clear();
    this.#readinessKeys.clear();
    this.#hasCommittedFootprint = false;
    this.#generations.clear();
    for (const entry of this.#images.values()) {
      for (const lease of entry.leases) lease.released = true;
      entry.leases.clear();
    }
    this.#images.clear();
    this.#bitmapOwnership = new WeakMap();
    this.#atlasKnownLogicalTextureBytes = 0;
    this.#sourceDecodedPixels = 0;
    this.#sourceBitmapCount = 0;
    this.#composing.clear();
    this.#cancelAllPaintWaiters();
    this.#activeImages.clear();
    this.#imageFailures.clear();
    this.#failed.clear();
    this.#terminalFailures.clear();
    this.#nextRefresh = Infinity;
    this.#success = 0;
    this.#generation = 0;
    for (const abort of pendingAborts) {
      try { abort.abort(); } catch { /* ownership is already inert; continue teardown */ }
    }
    for (const texture of textures) this.#disposeTexture(texture);
    for (const image of images) this.#closeImage(image);
  }

  #atlasPinned(key: string): boolean {
    return this.#residencyPins.has(key) || this.#composing.has(key);
  }

  #touchAtlas(entry: CharacterAtlasEntry): void {
    if (this.#atlases.get(entry.key) !== entry) return;
    this.#atlases.delete(entry.key);
    this.#atlases.set(entry.key, entry);
  }

  #setAtlasEntry(entry: CharacterAtlasEntry): void {
    const current = this.#atlases.get(entry.key);
    if (current && current !== entry) {
      this.#dropAtlasOwnership(current);
      this.#disposeTexture(current.texture);
    } else if (current?.knownLogicalTextureBytes !== undefined) {
      this.#atlasKnownLogicalTextureBytes -= current.knownLogicalTextureBytes;
    }
    entry.knownLogicalTextureBytes = knownLogicalTextureBytes(entry.texture);
    if (entry.knownLogicalTextureBytes !== undefined) {
      this.#atlasKnownLogicalTextureBytes += entry.knownLogicalTextureBytes;
    }
    this.#atlases.delete(entry.key);
    this.#atlases.set(entry.key, entry);
    this.#evictAtlases();
  }

  /** Removes only client ownership/cost. External callbacks run after this boundary. */
  #dropAtlasOwnership(entry: CharacterAtlasEntry): void {
    if (this.#atlases.get(entry.key) !== entry) return;
    this.#atlases.delete(entry.key);
    if (entry.knownLogicalTextureBytes !== undefined) {
      this.#atlasKnownLogicalTextureBytes -= entry.knownLogicalTextureBytes;
    }
  }

  #evictAtlases(): void {
    const evicted: CharacterAtlasEntry[] = [];
    for (const entry of [...this.#atlases.values()]) {
      const countOverflow = this.#atlases.size > this.#limits.atlasCount;
      const byteOverflow = this.#atlasKnownLogicalTextureBytes
        > this.#limits.atlasKnownLogicalTextureBytes;
      if (!countOverflow && !byteOverflow) break;
      if (this.#atlasPinned(entry.key)) continue;
      if (!countOverflow && byteOverflow && (entry.knownLogicalTextureBytes ?? 0) === 0) continue;
      this.#dropAtlasOwnership(entry);
      this.#generations.delete(entry.key);
      this.#failed.delete(entry.key);
      this.#terminalFailures.delete(entry.key);
      evicted.push(entry);
    }
    if (evicted.length > 0) {
      this.#recomputeNextRefresh();
      this.#pruneImageFailures();
    }
    for (const entry of evicted) this.#disposeTexture(entry.texture);
  }

  #disposeTexture(texture: THREE.Texture): void {
    if (this.#disposedTextures.has(texture)) return;
    this.#disposedTextures.add(texture);
    try { texture.dispose(); } catch { /* client ownership is already closed; continue cleanup */ }
  }

  #touchImage(entry: CharacterAtlasImageEntry): void {
    if (this.#images.get(entry.path) !== entry) return;
    if (entry.bitmap) entry.bitmap.lastTouch = ++this.#imageTouchSequence;
    this.#images.delete(entry.path);
    this.#images.set(entry.path, entry);
  }

  #admitImage(entry: CharacterAtlasImageEntry, image: ImageBitmap, pixels: number): void {
    let ownership = this.#bitmapOwnership.get(image);
    if (!ownership) {
      ownership = { image, pixels, lastTouch: ++this.#imageTouchSequence, references: 0 };
      this.#bitmapOwnership.set(image, ownership);
      this.#sourceDecodedPixels += pixels;
      this.#sourceBitmapCount++;
    } else {
      ownership.lastTouch = ++this.#imageTouchSequence;
    }
    ownership.references++;
    entry.status = "ready";
    entry.image = image;
    entry.bitmap = ownership;
    this.#touchImage(entry);
  }

  #releaseImageLease(lease: CharacterAtlasImageLease): void {
    if (lease.released) return;
    lease.released = true;
    lease.entry.leases.delete(lease);
    lease.owner.leases.delete(lease);
    if (this.#disposed) return;
    const entry = lease.entry;
    if (entry.status === "pending" && entry.leases.size === 0 && this.#isCurrentImage(entry)) {
      // Pending reads are shared only by their exact leases. Once the last borrower leaves, remove
      // current ownership before aborting so an ignored/late transport result cannot advance global
      // readiness generations or admit a dormant bitmap during a formal run.
      this.#images.delete(entry.path);
      this.#activeImages.delete(entry.path);
      try { entry.abort.abort(); } catch { /* late completion remains stale by exact identity */ }
      return;
    }
    this.#evictImages();
  }

  #removeImageEntry(entry: CharacterAtlasImageEntry): void {
    if (this.#images.get(entry.path) !== entry || entry.status === "pending" || entry.leases.size > 0) return;
    this.#images.delete(entry.path);
    const ownership = entry.bitmap;
    delete entry.image;
    delete entry.bitmap;
    if (!ownership) return;
    ownership.references--;
    if (ownership.references > 0) return;
    this.#bitmapOwnership.delete(ownership.image);
    this.#sourceDecodedPixels -= ownership.pixels;
    this.#sourceBitmapCount--;
    this.#closeImage(ownership.image);
  }

  #evictImages(): void {
    for (const entry of [...this.#images.values()]) {
      const countOverflow = this.#images.size > this.#limits.sourceCount;
      const pixelOverflow = this.#sourceDecodedPixels > this.#limits.sourceDecodedPixels;
      if (!countOverflow && !pixelOverflow) break;
      if (entry.status === "pending" || entry.leases.size > 0) continue;
      // Removing one alias path does not release its shared decoded surface. Under pixel-only
      // pressure, preserve LRU entries that cannot improve the violated metric and scan onward to
      // an ownership whose final reference really does reduce it.
      if (!countOverflow && pixelOverflow
        && (entry.bitmap === undefined || entry.bitmap.references !== 1)) continue;
      this.#removeImageEntry(entry);
      if (!this.#images.has(entry.path)) this.#imageFailures.delete(entry.path);
    }

    if (this.#images.size > this.#limits.sourceCount
      || this.#sourceDecodedPixels <= this.#limits.sourceDecodedPixels) return;
    // If every candidate aliases the same surface, no single path can improve pixel pressure.
    // Remove the oldest complete unpinned ownership group instead; a group containing a pending or
    // leased path remains an exact active pin and may honestly overflow until that lease leaves.
    const groups = new Map<CharacterAtlasBitmapOwnership, CharacterAtlasImageEntry[]>();
    for (const entry of this.#images.values()) {
      if (!entry.bitmap) continue;
      const group = groups.get(entry.bitmap) ?? [];
      group.push(entry);
      groups.set(entry.bitmap, group);
    }
    const oldestOwnerships = [...groups.entries()]
      .sort(([left], [right]) => left.lastTouch - right.lastTouch);
    for (const [ownership, group] of oldestOwnerships) {
      if (this.#sourceDecodedPixels <= this.#limits.sourceDecodedPixels) break;
      if (group.length !== ownership.references
        || group.some((entry) => entry.status === "pending" || entry.leases.size > 0)) continue;
      for (const entry of group) {
        this.#removeImageEntry(entry);
        if (!this.#images.has(entry.path)) this.#imageFailures.delete(entry.path);
      }
    }
  }

  #closeUnownedImage(image: ImageBitmap): void {
    if ((this.#bitmapOwnership.get(image)?.references ?? 0) > 0) return;
    this.#closeImage(image);
  }

  #isCurrentCompose(request: CharacterAtlasComposeRequest): boolean {
    return !this.#disposed
      && request.epoch === this.#epoch
      && this.#composing.get(request.key) === request;
  }

  #isCurrentImage(entry: CharacterAtlasImageEntry): boolean {
    return !this.#disposed
      && entry.epoch === this.#epoch
      && this.#images.get(entry.path) === entry;
  }

  #closeImage(image: ImageBitmap): void {
    if (this.#closedImages.has(image)) return;
    this.#closedImages.add(image);
    try { image.close(); } catch { /* best-effort release must continue through every bitmap */ }
  }

  /** Failure paths are owned by retained/in-flight looks; discard stale terminal path state. */
  #pruneImageFailures(): void {
    if (this.#composing.size > 0) return;
    const owned = new Set<string>();
    for (const { layers } of this.#failed.values()) {
      for (const layer of layers) {
        for (const path of layerPaths(layer)) owned.add(path);
      }
    }
    for (const path of this.#imageFailures.keys()) {
      if (!owned.has(path)) this.#imageFailures.delete(path);
    }
  }

  #recordImageFailure(path: string, attempts: number, transient: boolean): void {
    const wait = transient ? IMAGE_RETRY_BACKOFF_MS[attempts - 1] : undefined;
    this.#imageFailures.set(path, {
      attempts,
      after: wait === undefined ? Infinity : this.#now() + wait,
    });
  }

  /** Keep terminal look ownership bounded just like retry ownership. */
  #markTerminal(key: string): void {
    this.#terminalFailures.delete(key);
    this.#terminalFailures.add(key);
    while (this.#terminalFailures.size > ATLAS_FAILURE_LIMIT) {
      const oldest = this.#terminalFailures.values().next().value;
      if (oldest === undefined) break;
      this.#terminalFailures.delete(oldest);
    }
  }

  #recomputeNextRefresh(): void {
    this.#nextRefresh = Infinity;
    // A look with no atlas is still a renderer-driven capsule. Scheduling it here would leave an
    // already-due deadline behind after it leaves view and turn refresh's O(1) guard into a scan of
    // the whole failure ledger every frame. Only partial atlases are owned by refresh.
    for (const [key, { until }] of this.#failed) {
      if (this.#atlases.has(key)
        && (!this.#hasCommittedFootprint || this.#readinessKeys.has(key))) {
        this.#nextRefresh = Math.min(this.#nextRefresh, until);
      }
    }
  }
}

/** Exact decoded surface area, with multiplication performed only after an overflow-safe check. */
export function decodedCharacterAtlasImagePixels(
  image: Pick<ImageBitmap, "width" | "height">,
  limit: number = CHARACTER_ATLAS_SOURCE_ENTRY_PIXEL_LIMIT,
): number | undefined {
  return decodedImagePixels(image, limit);
}

function decodedImagePixels(image: Pick<ImageBitmap, "width" | "height">, limit: number): number | undefined {
  const { width, height } = image;
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
    return undefined;
  }
  if (width > Math.floor(limit / height)) return undefined;
  return width * height;
}

/**
 * Reads one encoded source under a hard cap before decoding it.
 *
 * The current local 3,298-file PNG corpus tops out at 612,032 bytes and 512x512 pixels. The 4 MiB
 * response and 1024x1024 decoded caps are conservative format guards, not performance claims.
 */
async function readBoundedCharacterAtlasImage(response: Response, limit: number): Promise<Blob> {
  const header = response.headers?.get?.("content-length")?.trim();
  if (header !== undefined && /^[0-9]+$/.test(header) && Number(header) > limit) {
    try { await response.body?.cancel(); } catch { /* preserve the deterministic size answer */ }
    throw new DeterministicCharacterAtlasImageError(
      `Character image response declares ${header} bytes; limit is ${limit}`,
    );
  }

  const reader = response.body?.getReader?.();
  if (reader) {
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        length += value.byteLength;
        if (length > limit) {
          try { await reader.cancel(); } catch { /* preserve the deterministic size answer */ }
          throw new DeterministicCharacterAtlasImageError(
            `Character image response exceeded ${limit} bytes while streaming`,
          );
        }
        chunks.push(value);
      }
    } finally {
      try { reader.releaseLock(); } catch { /* do not mask a deterministic overflow answer */ }
    }
    const joined = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new Blob([joined.buffer], { type: response.headers?.get?.("content-type") ?? "" });
  }

  // Minimal Response polyfills expose only blob(). This checks before decode, but cannot prevent
  // that synthetic implementation from allocating its complete Blob while reading it.
  const blob = await response.blob();
  if (blob.size > limit) {
    throw new DeterministicCharacterAtlasImageError(
      `Character image response contains ${blob.size} bytes; limit is ${limit}`,
    );
  }
  return blob;
}
