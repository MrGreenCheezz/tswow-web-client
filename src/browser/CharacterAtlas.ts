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

/** Where each piece lands on the body texture. Mirrors BODY_SECTIONS on the gateway. */
export const BODY_TEXTURE_SIZE = 512;
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
 * which changes `path` itself on 76.2% of the layers a dressed character paints.
 */
export const CHARACTER_APPEARANCE_VERSION = 5;

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
 * so an hour of pre-upgrade answers would be an hour of every unit standing as a capsule.
 */
export const CREATURE_MODEL_VERSION = 6;

/**
 * And for `/dbc/character-options`, which is the third route answering `max-age=3600` off a query
 * string with no moving part in it — a race and a sex.
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
 * until the review, and which an hour of cache would otherwise go on offering.
 */
export const CHARACTER_OPTIONS_VERSION = 3;

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

/** Composes one character body texture. Layers are painted in the order the gateway lists them. */
export class CharacterAtlasClient {
  readonly #baseUrl: string;
  readonly #images = new Map<string, Promise<ImageBitmap | undefined>>();
  readonly #atlases = new Map<string, THREE.Texture>();
  /** Incremented for every successful repaint, including an in-place CanvasTexture update. */
  readonly #generations = new Map<string, number>();
  /** Compositions under way, so one look is painted once however many units are waiting on it. */
  readonly #composing = new Map<string, Promise<THREE.Texture | undefined>>();
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
  constructor(baseUrl: string, now: () => number = Date.now) {
    this.#baseUrl = baseUrl;
    this.#now = now;
  }

  /** A finished texture if it has been composed, otherwise undefined while it is being built. */
  get(key: string): THREE.Texture | undefined {
    return this.#atlases.get(key);
  }

  /** A stable repaint token for consumers that cache a rendered image of the atlas. */
  generation(key: string): number {
    return this.#generations.get(key) ?? 0;
  }

  /**
   * Starts composing, or returns the finished texture. The caller polls with `get` on later
   * frames rather than waiting, because a unit is drawn as a stand-in until its body is ready.
   */
  async compose(key: string, layers: readonly BodyLayer[]): Promise<THREE.Texture | undefined> {
    const existing = this.#atlases.get(key);
    const pendingRetry = this.#failed.get(key);
    const waiting = pendingRetry !== undefined && this.#now() < pendingRetry.until;
    // A finished body, or one that is short a layer whose next attempt is not due yet. Falling
    // through with a texture in hand is the recomposition: the missing layer's wait is over.
    if (existing && (pendingRetry === undefined || waiting)) return existing;
    if (layers.length === 0) return undefined;
    // One composition per look, not one per caller. The renderer asks again on every frame a body
    // is not ready, and once for each unit wearing that look, so a single second of waiting at
    // 60 fps produced sixty 512x512 canvases for one character — all but the last thrown away,
    // and the last one replacing a texture other builds were already holding.
    const inFlight = this.#composing.get(key);
    if (inFlight) return inFlight;
    // And one composition per *failure*, not one per frame after it. Checked after `#composing`
    // so a build under way is still shared, and before any work at all.
    if (waiting) return undefined;
    const pending = this.#build(key, layers).finally(() => this.#composing.delete(key));
    this.#composing.set(key, pending);
    return pending;
  }

  async #build(key: string, layers: readonly BodyLayer[]): Promise<THREE.Texture | undefined> {
    const spellings = layers.map((layer) => layerPaths(layer));
    const images = await Promise.all(spellings.map(async (paths) => {
      for (const path of paths) {
        const image = await this.#image(path);
        if (image) return image;
      }
      return undefined;
    }));
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
    // Painted into the canvas the last composition used, when there was one. A material holds the
    // Texture object, not the atlas map, so a body that gains its missing trousers has to gain them
    // *in place* — a new CanvasTexture would sit in this map with nothing sampling it. Nothing is
    // cleared first because a layer only ever goes from missing to present: every layer that
    // painted before paints again from the image cache, in the same order, over the same rectangle.
    const previous = this.#atlases.get(key);
    const canvas = (previous?.image as HTMLCanvasElement | undefined) ?? document.createElement("canvas");
    canvas.width = BODY_TEXTURE_SIZE;
    canvas.height = BODY_TEXTURE_SIZE;
    const context = canvas.getContext("2d");
    if (!context) return undefined;

    let painted = 0;
    for (let index = 0; index < layers.length; index++) {
      const image = images[index];
      if (!image) continue;
      const section = layers[index]!.section;
      if (!section) {
        // No section: this is the whole body, either the base skin or a baked NPC texture.
        context.drawImage(image, 0, 0, BODY_TEXTURE_SIZE, BODY_TEXTURE_SIZE);
      } else {
        const rect = SECTIONS[section];
        if (!rect) continue;
        // Facial hair ships at half the rectangle's size, so every layer is scaled to fit rather
        // than assumed to match.
        context.drawImage(image, rect.x, rect.y, rect.width, rect.height);
      }
      painted++;
    }
    // Every picture arrived and every one of them named a rectangle this client does not have.
    // Nothing about that changes on the next frame, so it is remembered for good.
    if (painted === 0) {
      this.#defer(key, layers, retryAt);
      return undefined;
    }

    const texture = previous ?? new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    // The body atlas is sampled inside its rectangles; tiling would pull a neighbour's pixels in.
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.flipY = false;
    // The whole of the in-place repaint on the GPU side: the canvas behind this texture has new
    // pixels in it, so every material already sampling it gets them on the next frame.
    texture.needsUpdate = true;
    this.#atlases.set(key, texture);
    this.#generations.set(key, (this.#generations.get(key) ?? 0) + 1);
    // A body that painted in full is not in the ledger at all; one still short a layer stays, so
    // `refresh` comes back for it when that layer's wait is over.
    if (retryAt === Infinity) this.#failed.delete(key);
    else this.#defer(key, layers, retryAt);
    return texture;
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
    this.#nextRefresh = Math.min(this.#nextRefresh, until);
    while (this.#failed.size > ATLAS_FAILURE_LIMIT) {
      const oldest = this.#failed.keys().next().value;
      if (oldest === undefined) break;
      this.#failed.delete(oldest);
    }
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
    if (this.#now() < this.#nextRefresh) return;
    let next = Infinity;
    for (const [key, pending] of this.#failed) {
      if (!this.#atlases.has(key)) continue;
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

  #image(path: string): Promise<ImageBitmap | undefined> {
    const pending = this.#images.get(path);
    if (pending) return pending;
    // A path is in `#images` only while it is in flight or has answered with a picture; a failure
    // is taken back out, so this is what stands between a retry and a request storm.
    const failure = this.#imageFailures.get(path);
    if (failure && this.#now() < failure.after) return Promise.resolve(undefined);
    const attempt = (failure?.attempts ?? 0) + 1;
    // The bookkeeping hangs off the promise rather than living inside it, because it deletes the
    // very entry the line below adds: a `fetch` that threw synchronously would otherwise be
    // cleaned up first and then cached as a permanent undefined.
    const request = this.#fetchImage(path).then((answer) => {
      if (answer.image) {
        this.#imageFailures.delete(path);
        return answer.image;
      }
      this.#images.delete(path);
      // No wait left, or an answer that will not change: `Infinity`, which the guard above reads
      // as "never" without a second field saying so.
      const wait = answer.transient ? IMAGE_RETRY_BACKOFF_MS[attempt - 1] : undefined;
      this.#imageFailures.set(path, {
        attempts: attempt,
        after: wait === undefined ? Infinity : this.#now() + wait,
      });
      return undefined;
    });
    this.#images.set(path, request);
    return request;
  }

  async #fetchImage(path: string): Promise<{ image?: ImageBitmap; transient?: boolean }> {
    try {
      const response = await fetch(textureUrl(this.#baseUrl, path));
      // 404 is the gateway saying the archives do not hold this file, and asking three more times
      // gets three more 404s. 5xx is the gateway failing to make a picture it may well make next
      // time — a generation lane busy, a child that died — and that is what the backoff is for.
      // 408 and 429 are the two 4xx that mean "later", not "no".
      if (!response.ok) {
        return { transient: response.status >= 500 || response.status === 408 || response.status === 429 };
      }
      return { image: await createImageBitmap(await response.blob()) };
    } catch {
      // A throw is the network or a picture that would not decode, never an answer.
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
    const texture = this.#atlases.get(key);
    if (!texture) return;
    texture.dispose();
    this.#atlases.delete(key);
    this.#generations.delete(key);
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
    for (const key of [...this.#atlases.keys()]) {
      if (!keys.has(key)) this.release(key);
    }
  }

  dispose(): void {
    for (const texture of this.#atlases.values()) texture.dispose();
    this.#atlases.clear();
    this.#generations.clear();
    this.#images.clear();
    this.#imageFailures.clear();
    this.#failed.clear();
    this.#nextRefresh = Infinity;
  }
}
