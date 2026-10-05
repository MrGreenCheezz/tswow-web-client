import * as THREE from "three";
import type { CreatureModelMetadata } from "../../gateway/CreatureModelMetadata.js";
import type { CharacterSummary } from "../../world/CharacterProtocol.js";
import {
  M2_TO_SCENE, buildSkinnedTemplateFrom, disposeSkinnedInstance, instantiateSkinned,
  resolveAnimation, type SkinnedInstance, type SkinnedTemplate,
} from "../AnimatedModel.js";
import { attachmentOffset, attachmentPoint, boneOf } from "../Attachment.js"; // 05.10-A7a-G 6.18: SHEATH_MELEE → charSelectSheath
import {
  CHARACTER_APPEARANCE_VERSION, CREATURE_MODEL_VERSION, CharacterAtlasClient, appearanceKey,
  type CharacterAppearance,
} from "../CharacterAtlas.js";
import { EVERY_GEOSET, buildModel, characterSlots, type BuiltModel } from "../ModelBuild.js"; // 05.10-A7a-G 6.18: geosetList → figureGeosets
import { figureGeosets } from "../FigureGeosets.js"; // 05.10-A7a-G 6.18
import { charSelectWears, figureSheath } from "./CharSelectWorn.js"; // 05.10-A7a-G 6.18
import { ModelTextureLoader } from "../TextureLoad.js";
import {
  TEXTURE_TYPE_BODY, TEXTURE_TYPE_OBJECT_SKIN, decodeWvm9, isWvm9, visualModelUrl,
  type WvmModel,
} from "../Wvm.js";
import type { FrameXmlUiBridge } from "../ui/framexml_compat/FrameXmlRuntime.js";
import type { GlueCharacterView } from "./GlueCharacterApi.js";
import type { GlueModelStage, GlueStageActor } from "./GlueModelStage.js";
import { glueFigureScaleCompensation } from "./GlueModelStage.js";

/**
 * The character standing in the character-select backdrop.
 *
 * Every step is the shipping client's own: `/dbc/character-appearance` for the skin, face, hair and
 * what the armour does to the geosets, `CharacterAtlasClient.compose` for the body sheet,
 * `/dbc/creature-models` for the display record, `Wvm` + `ModelBuild` + `AnimatedModel` for the
 * mesh and the rig, `Attachment` for the helmet and the weapons. This is the same route
 * `lab/CharacterLab.ts` walks and the same one `WorldRenderer3D` walks in the world — a character
 * that comes out wrong here comes out wrong there, which is the point.
 *
 * What is *not* here is any of the world session: no `game`, no store, no item-metadata client. The
 * equipment comes straight out of `SMSG_CHAR_ENUM`, which already carries a display id and an
 * inventory type per slot, so the appearance request needs no item lookup at all.
 */

/** The equipment `SMSG_CHAR_ENUM` sends, in the `slot:invType:displayId` spelling the route takes. */
export function wornQuery(character: CharacterSummary): string {
  const worn: string[] = [];
  for (const [slot, item] of character.equipment.entries()) {
    // 05.10-A7a-G 6.18: hidden helm/cloak and the class's weapons, as Wow.exe 0x004e3cd0 (CharSelectWorn.ts).
    if (!charSelectWears(slot, character.classId, character.flags)) continue;
    if (item.displayId > 0) worn.push(`${slot}:${item.inventoryType}:${item.displayId}`);
  }
  // Sorted for a stable identity, exactly as `CreatureModelClient.playerAppearance` sorts it: the
  // paint order is the gateway's decision and not this list's.
  return worn.sort().join(",");
}

/**
 * One figure to draw: everything the appearance route and the model builder need, and nothing else.
 *
 * A description rather than a `CharacterSummary`, because two screens stand somebody in a backdrop
 * and only one of them has a character: the select screen reads `SMSG_CHAR_ENUM`, and the creation
 * screen reads its own five customisation axes and `CharStartOutfit`. Both walk the identical route
 * — `/dbc/character-appearance`, `CharacterAtlasClient.compose`, `Wvm`+`ModelBuild`+`AnimatedModel`,
 * `Attachment` — so it is walked once, here.
 */
export interface GlueSceneLook {
  /** Identity. The figure is rebuilt when and only when this changes. */
  readonly key: string;
  /** `CreatureDisplayInfo` row the mesh comes from. */
  readonly displayId: number;
  readonly race: number;
  /** 05.10-A7a-A 6.10: the class, sent as `class=` (the death knight's eye glow); absent sends none. */
  readonly classId?: number | undefined;
  readonly sex: number;
  readonly skin: number;
  readonly face: number;
  readonly hairStyle: number;
  readonly hairColor: number;
  readonly facialHair: number;
  /** `slot:inventoryType:displayId`, comma separated and already sorted; empty for undressed. */
  readonly items: string;
  /** Named in diagnostics, so a failure says who failed. */
  readonly label: string;
  /** 05.10-A7a-G review 6.18: the select screen's figure (its weapon hang, CharSelectWorn.figureSheath); absent elsewhere. */
  readonly charSelect?: true;
}

/** The look of a character out of the character list, for the select screen. */
export function characterLook(character: CharacterSummary, displayId: number): GlueSceneLook {
  const items = wornQuery(character);
  return {
    key: [
      character.guid.toString(16), character.race, character.gender, character.classId,
      character.skin, character.face, character.hairStyle, character.hairColor,
      character.facialHair, displayId, items,
    ].join("/"),
    displayId,
    race: character.race,
    classId: character.classId, // 05.10-A7a-A 6.10
    sex: character.gender,
    skin: character.skin,
    face: character.face,
    hairStyle: character.hairStyle,
    hairColor: character.hairColor,
    facialHair: character.facialHair,
    items,
    label: character.name,
    charSelect: true, // 05.10-A7a-G review 6.18
  };
}

export interface GlueCharacterSceneOptions {
  readonly gatewayOrigin: string;
  readonly bridge: FrameXmlUiBridge;
  readonly stage: GlueModelStage;
  /** What to draw right now, or nothing. Read on every `update()` and never cached elsewhere. */
  readonly look: () => GlueSceneLook | undefined;
  /** The figure's rotation in degrees, read every drawn frame — the drag moves it continuously. */
  readonly facing: () => number;
  /**
   * Viewport width over height, read every drawn frame for the figure's aspect compensation.
   * The stage stretches past 16:9 rather than pillarboxing, so the host box — not a constant —
   * is what the drawn frame's aspect follows. Absent means 4:3, where the compensation is the
   * identity by construction.
   */
  readonly aspect?: (() => number) | undefined;
  /** Which `Model` widget the figure stands in until `SetCharSelectModelFrame` says otherwise. */
  readonly modelFrame?: string;
  readonly onDiagnostic?: (message: string) => void;
}

interface BuiltCharacter {
  readonly key: string;
  readonly actor: GlueStageActor;
  /** Display scale the figure was built at, before aspect compensation. */
  readonly baseScale: number;
}

interface CharacterBuildRequest {
  readonly key: string;
  readonly epoch: number;
  readonly controller: AbortController;
  promise: Promise<void>;
}

export class GlueCharacterScene implements GlueCharacterView {
  readonly #options: GlueCharacterSceneOptions;
  readonly #textures = new ModelTextureLoader();
  #atlases: CharacterAtlasClient;
  /** Resolved model bytes are cheap to reuse; pending work belongs to the current build request. */
  readonly #models = new Map<string, WvmModel>();
  /** One request per look. A stale request is aborted, so it can never publish into a new look. */
  readonly #builds = new Map<string, CharacterBuildRequest>();
  #modelFrameName: string;
  #built: BuiltCharacter | undefined;
  /** The look currently being assembled, so two selections in a row do not race. */
  #wanted = "";
  /** Invalidates every continuation that crossed a suspend/dispose boundary. */
  #epoch = 0;
  /** True while the built actor is waiting for the backdrop's view to exist. */
  #unplaced = false;
  /** The last thing that went wrong, so the browser smoke can read it out of the page. */
  #problem = "";

  constructor(options: GlueCharacterSceneOptions) {
    this.#options = options;
    this.#modelFrameName = options.modelFrame ?? "CharacterSelect";
    this.#atlases = new CharacterAtlasClient(options.gatewayOrigin);
  }

  /** What the figure is doing right now; read by the browser smoke out of the live page. */
  get report(): {
    readonly frame: string; readonly wanted: string; readonly built: boolean;
    readonly placed: boolean; readonly problem: string;
    readonly at: readonly [number, number, number];
    readonly scale: number;
  } {
    const root = this.#built?.actor.root;
    return {
      frame: this.#modelFrameName,
      wanted: this.#wanted,
      built: this.#built !== undefined,
      placed: this.#built !== undefined && !this.#unplaced,
      problem: this.#problem,
      // Where the figure ended up, in scene units. Reported rather than assumed: the stand point
      // is a measurement off the backdrop and this is how a screenshot is checked against it.
      at: root ? [round(root.position.x), round(root.position.y), round(root.position.z)] : [0, 0, 0],
      scale: root ? round(root.scale.x) : 0,
    };
  }

  /** `SetCharSelectModelFrame("CharacterSelect")` — which widget the figure is drawn in. */
  setModelFrame(name: string): void {
    if (name) this.#modelFrameName = name;
  }

  /** The figure the screen wants right now, or nothing. */
  update(): void {
    const look = this.#options.look();
    if (!look || look.displayId <= 0) {
      this.#wanted = "";
      this.cancelBuilds();
      this.clear();
      return;
    }
    if (look.key === this.#wanted) return;
    this.#wanted = look.key;
    this.cancelBuilds();
    const controller = new AbortController();
    const request: CharacterBuildRequest = {
      key: look.key,
      epoch: ++this.#epoch,
      controller,
      promise: Promise.resolve(),
    };
    // Publish before entering the async build. This keeps a re-entrant update from starting a
    // second request for the same key while the first one is at its first await.
    this.#builds.set(look.key, request);
    request.promise = this.build(look, request)
      .finally(() => {
        if (this.#builds.get(request.key) === request) this.#builds.delete(request.key);
      });
    void request.promise;
  }

  /**
   * Called once per page frame.
   *
   * Two jobs, both of which have to happen outside the C API: push the drag's facing onto the
   * object, and put a character that was built before its backdrop had a view into it as soon as
   * one exists. `SetCharSelectBackground` and the model load behind it are asynchronous, so the
   * order "character ready, scene not" is the normal one and not an edge case.
   */
  frame(): void {
    const built = this.#built;
    if (!built) return;
    built.actor.facingDegrees = this.#options.facing();
    // The backdrop camera covers narrower as the viewport widens; without this the figure grows
    // with the zoom and fills four fifths of a 16:9 frame. Scaling about the model origin keeps
    // the feet planted on the authored mark at every aspect. The FOV is the set's, read live —
    // the figure's own model carries a portrait camera made for a different frame.
    const aspect = this.#options.aspect?.() ?? 4 / 3;
    const fov = this.#options.stage.backgroundFov(this.#modelFrameName) ?? Number.NaN;
    built.actor.root.scale.setScalar(built.baseScale * glueFigureScaleCompensation(fov, aspect));
    if (!this.#unplaced) return;
    const frame = this.modelFrame();
    if (frame && this.#options.stage.setActor(frame, built.actor)) this.#unplaced = false;
  }

  /** Take the figure off the screen and free everything it holds. */
  clear(): void {
    const built = this.#built;
    if (!built) return;
    this.#built = undefined;
    this.#unplaced = false;
    const frame = this.modelFrame();
    // `setActor(frame, undefined)` disposes it; without a view left to take it off, dispose here.
    if (!frame || !this.#options.stage.setActor(frame, undefined)) built.actor.dispose();
  }

  dispose(): void {
    // `dispose()` is used for suspend as well as final teardown. Abort and advance the epoch, but
    // leave the scene reusable by `resume()`; the old implementation cleared caches without
    // cancelling their network/decode continuations.
    this.#epoch++;
    this.cancelBuilds();
    this.clear();
    this.#models.clear();
    this.#textures.clear();
    this.#atlases.dispose();
    // CharacterAtlasClient.dispose() is intentionally terminal. Bootstrap calls this method on
    // every world handoff, so give the next resume a fresh owner instead of a permanently inert
    // atlas client.
    this.#atlases = new CharacterAtlasClient(this.#options.gatewayOrigin);
    // `clear()` deliberately leaves `#wanted` alone — it runs mid-build, and forgetting the target
    // there would make a build cancel itself. Disposal is the other case: the scene is being put
    // away and may be asked for the *same* character again (this is exactly what leaving the world
    // does), and `update()` short-circuits on `look.key === #wanted`. Without this line the figure
    // would never come back on the way in from the world.
    this.#wanted = "";
    this.#unplaced = false;
  }

  private modelFrame() {
    return this.#options.bridge.getFrame(this.#modelFrameName);
  }

  private async build(look: GlueSceneLook, request: CharacterBuildRequest): Promise<void> {
    const key = look.key;
    const { signal } = request.controller;
    try {
      // These routes only depend on the immutable look/display id, not on one another. Starting
      // them together removes one full gateway round trip from the first character frame.
      const [metadata, appearance] = await Promise.all([
        this.displayRecord(look.displayId, signal),
        this.appearanceOf(look, signal),
      ]);
      if (!this.isCurrent(request)) return;
      const wvm = await this.model(metadata.model, signal);
      if (!this.isCurrent(request)) return;

      const atlasKey = appearanceKey(appearance);
      const body = appearance.body.length > 0
        ? await this.#atlases.compose(atlasKey, appearance.body) : undefined;
      if (!this.isCurrent(request)) return;

      const built = buildModel(wvm, {
        modelPath: metadata.model,
        slots: characterSlots(metadata.textures, appearance),
        geosets: figureGeosets(wvm, appearance), // 05.10-A7a-G 6.18: the world's boot choice (worldCharacterGeosets)
        baseUrl: this.#options.gatewayOrigin,
        loadTexture: (url) => this.#textures.load(url),
        ...(body ? { slotTextures: new Map([[TEXTURE_TYPE_BODY, body]]) } : {}),
        skinned: Boolean(wvm.skeleton),
      });
      // `buildModel` is synchronous and cannot be interrupted half-way. Drop its allocations as
      // soon as the controller says the request went stale, before constructing a rig/actor.
      if (!this.isCurrent(request)) {
        disposeBuild(built);
        return;
      }
      const rig = wvm.skeleton;
      const template = rig ? buildSkinnedTemplateFrom(built.geometry, rig, built.height) : undefined;
      const instance = template ? instantiateSkinned(template, built.materials) : undefined;
      const root = instance
        ? instance.root
        : new THREE.Mesh(built.geometry, built.materials);
      if (!instance) (root as THREE.Mesh).quaternion.copy(M2_TO_SCENE);
      root.scale.setScalar(metadata.scale);
      // A figure carried by animated bones has no meaningful rest-pose bounds; the world renderer
      // turns culling off for the same reason.
      root.frustumCulled = false;

      let mixer: THREE.AnimationMixer | undefined;
      if (instance && template) {
        // Stand, id 0, looped. Measured on this client's own artifact: `HumanMale.m2` publishes
        // clips 0..16 inside the model, so the 9.8 MB animation sidecar is not on this path at all.
        const resolved = resolveAnimation(template.clips, [STAND_ANIMATION])
          ?? (template.clips.has(0) ? 0 : template.clips.keys().next().value);
        const clip = resolved === undefined ? undefined : template.clips.get(resolved);
        if (clip) {
          const action = instance.mixer.clipAction(clip);
          action.setLoop(THREE.LoopRepeat, Infinity);
          action.reset();
          action.play();
        } else {
          this.diagnose(`${metadata.model}: нет клипа Stand — фигура стоит в позе покоя`);
        }
        mixer = instance.mixer;
      }

      const actor: GlueStageActor = {
        root,
        ...(mixer ? { mixer } : {}),
        facingDegrees: this.#options.facing(),
        dispose: () => {
          disposeSkinnedInstance(instance);
          disposeBuild(built);
        },
      };

      if (!this.isCurrent(request)) {
        actor.dispose();
        return;
      }
      this.clear();
      this.#built = { key, actor, baseScale: metadata.scale };
      const frame = this.modelFrame();
      this.#unplaced = !(frame && this.#options.stage.setActor(frame, actor));
      // `retain` is "keep only these": the previous character's body sheet — a 512x512 canvas —
      // goes with the previous character, and the one being drawn stays. Called after the swap so
      // the outgoing figure is never sampling a texture that has already been freed.
      this.#atlases.retain(new Set(body ? [atlasKey] : []));

      // After the figure is on the screen: each worn piece is its own download, and a character
      // that appears only once its helmet has is a screen that looks broken while the gateway
      // thinks. Exactly the order `CharacterLab` puts them in.
      if (instance && template) {
        await this.hangAttachments(request, wvm, appearance, instance, template, look.charSelect === true); // 05.10-A7a-G review 6.18: + the screen
      }
    } catch (error) {
      // Stale/aborted work is expected during a fast selection or world handoff, and must not
      // replace the current screen's diagnostic with an error from the old look.
      if (this.isCurrent(request)) {
        const message = `${look.label}: ${error instanceof Error ? error.message : String(error)}`;
        // Promise.all rejects as soon as one route fails. Abort its sibling and release the key so
        // the next frame can retry the same look instead of being short-circuited by #wanted.
        this.#wanted = "";
        request.controller.abort();
        this.diagnose(message);
      }
    }
  }

  /** The helmet, the pauldrons and whatever is in the hands, on the bones the client uses. */
  private async hangAttachments(
    request: CharacterBuildRequest,
    wvm: WvmModel,
    appearance: CharacterAppearance,
    instance: SkinnedInstance,
    template: SkinnedTemplate,
    charSelect: boolean, // 05.10-A7a-G review 6.18
  ): Promise<void> {
    const { signal } = request.controller;
    for (const item of appearance.attached ?? []) {
      // Sheath state is not in `SMSG_CHAR_ENUM` and the original draws the character on this screen
      // with its weapons out, which is `SHEATH_MELEE`.
      // 05.10-A7a-G 6.18: the hunter's bow in the left hand (Wow.exe 0x004eacd0, CharSelectWorn.ts).
      const point = attachmentPoint(item, figureSheath(item.slot, charSelect)); // 05.10-A7a-G review 6.18: the creation screen keeps SHEATH_MELEE
      if (point === undefined) continue;
      const bone = boneOf(wvm, instance, point);
      if (!bone) continue;
      try {
        const piece = await this.model(item.model, signal);
        if (!this.isCurrent(request)) return;
        const built = buildModel(piece, {
          modelPath: item.model,
          // An item model almost never names its own diffuse texture: it declares the type 2 slot
          // and the wearer's `ItemDisplayInfo` fills it.
          slots: new Map(item.texture ? [[TEXTURE_TYPE_OBJECT_SKIN, item.texture]] : []),
          geosets: EVERY_GEOSET,
          baseUrl: this.#options.gatewayOrigin,
          loadTexture: (url) => this.#textures.load(url),
          skinned: false,
        });
        if (!this.isCurrent(request)) {
          disposeBuild(built);
          return;
        }
        const mesh = new THREE.Mesh(built.geometry, built.materials);
        mesh.frustumCulled = false;
        mesh.position.copy(attachmentOffset(wvm, template.pivots, point));
        bone.add(mesh);
      } catch (error) {
        if (this.isCurrent(request)) {
          this.diagnose(`${item.model}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }

  private async displayRecord(displayId: number, signal: AbortSignal): Promise<CreatureModelMetadata> {
    const url = `${this.#options.gatewayOrigin}/dbc/creature-models`
      + `?v=${CREATURE_MODEL_VERSION}&ids=${displayId}`;
    const rows = await this.json<CreatureModelMetadata[]>(url, `display ${displayId}`, signal);
    const row = rows[0];
    if (!row) throw new Error(`display ${displayId}: в CreatureDisplayInfo такой строки нет`);
    return row;
  }

  private async appearanceOf(look: GlueSceneLook, signal: AbortSignal): Promise<CharacterAppearance> {
    // The same spelling `CreatureModelClient.playerAppearance` sends, version included.
    const query = `v=${CHARACTER_APPEARANCE_VERSION}&race=${look.race}&sex=${look.sex}`
      + `&skin=${look.skin}&face=${look.face}&hair=${look.hairStyle}`
      + `&hairColor=${look.hairColor}&facialHair=${look.facialHair}`
      + (look.items ? `&items=${encodeURIComponent(look.items)}` : "")
      + (look.classId === undefined ? "" : `&class=${look.classId}`); // 05.10-A7a-A 6.10
    return await this.json<CharacterAppearance>(
      `${this.#options.gatewayOrigin}/dbc/character-appearance?${query}`, "внешность", signal);
  }

  private async model(path: string, signal: AbortSignal): Promise<WvmModel> {
    throwIfAborted(signal);
    const resolved = this.#models.get(path);
    if (resolved) return resolved;
    const response = await fetch(visualModelUrl(this.#options.gatewayOrigin, path), { signal });
    throwIfAborted(signal);
    if (!response.ok) throw new Error(`${path}: шлюз ответил ${response.status}`);
    const data = await response.arrayBuffer();
    throwIfAborted(signal);
    if (!isWvm9(data)) throw new Error(`${path}: артефакт не WVM9`);
    const decoded = decodeWvm9(data);
    throwIfAborted(signal);
    this.#models.set(path, decoded);
    return decoded;
  }

  private async json<T>(url: string, what: string, signal: AbortSignal): Promise<T> {
    throwIfAborted(signal);
    const response = await fetch(url, { signal });
    throwIfAborted(signal);
    if (!response.ok) throw new Error(`${what}: шлюз ответил ${response.status}`);
    const value = await response.json() as T;
    throwIfAborted(signal);
    return value;
  }

  private isCurrent(request: CharacterBuildRequest): boolean {
    return !request.controller.signal.aborted
      && request.epoch === this.#epoch
      && request.key === this.#wanted;
  }

  private cancelBuilds(): void {
    for (const request of this.#builds.values()) request.controller.abort();
    this.#builds.clear();
  }

  private diagnose(message: string): void {
    this.#problem = message;
    this.#options.onDiagnostic?.(message);
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error("aborted");
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** `AnimationData` id 0. */
const STAND_ANIMATION = 0;

function disposeBuild(built: BuiltModel): void {
  built.geometry.dispose();
  for (const material of built.materials) material.dispose();
  for (const texture of built.ownedTextures) texture.dispose();
}
