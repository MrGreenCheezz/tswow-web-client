// The character lab: one page that draws a character out of the shipping code, and says in words
// what it drew.
//
// Five separate render defects in this client end with "and only a screenshot can settle it", and
// getting that screenshot meant creating a character, logging in and walking somewhere. Everything
// a character needs is an unauthenticated GET on the gateway that is already running, so none of
// that is necessary: `/dbc/character-appearance`, `/dbc/character-options`, `/dbc/creature-models`,
// `/visual/model`, `/visual/animations` and `/texture` are the whole list.
//
// It imports the real `Wvm`, `ModelBuild`, `CharacterAtlas`, `AnimatedModel` and the client's own
// texture loader. Nothing here is a second implementation of anything — if the lab draws a green
// tauren, the client draws a green tauren, and that is the entire point of the page. What it adds
// is the panel: for a look that came out wrong, which geoset was missing and which texture was.
//
// It deliberately imports nothing from `game/Context`, `ui/Dom` or the login flow. There is no
// world server in this page, no account, and no session.

import * as THREE from "three";
import { ANIMATION_IDS, type AnimationName } from "../../generated/animations.js";
import type { CreatureModelMetadata } from "../../gateway/CreatureModelMetadata.js";
import {
  M2_TO_SCENE, addSkinnedClips, buildSkinnedTemplateFrom, instantiateSkinned, resolveAnimation,
  type SkinnedInstance, type SkinnedTemplate,
} from "../AnimatedModel.js";
import { attachmentOffset, boneOf } from "../Attachment.js";
import {
  CHARACTER_OPTIONS_VERSION, CREATURE_MODEL_VERSION, CharacterAtlasClient, appearanceKey,
  type CharacterAppearance,
} from "../CharacterAtlas.js";
import { EVERY_GEOSET, characterSlots, geosetList, type BuiltModel } from "../ModelBuild.js";
import { ModelTextureLoader } from "../TextureLoad.js";
import { raceName } from "../ui/UnitSnapshot.js";
import {
  TEXTURE_TYPE_BODY, TEXTURE_TYPE_OBJECT_SKIN, decodeWvaAnimations, decodeWvm9, isWvm9, textureUrl,
  type WvmModel, type WvmSkeletonClip,
} from "../Wvm.js";
import {
  LAB_FLAT_COLOUR, buildForLab, labAttachmentLines, labSummary,
  type LabAttachmentLine, type LabPanel,
} from "./LabReport.js";
import {
  PLAYABLE_RACE_DISPLAYS, appearanceQuery, labGatewayUrl, parseLabQuery, playableProfiles,
  type LabLook, type LabQuery,
} from "./LabQuery.js";

const element = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`В странице нет #${id}`);
  return found as T;
};

const progressText = element<HTMLParagraphElement>("lab-progress");
const summaryText = element<HTMLParagraphElement>("lab-summary");
const titleText = element<HTMLElement>("lab-title");
const canvas = element<HTMLCanvasElement>("lab-canvas");
const sheetCanvas = element<HTMLCanvasElement>("lab-sheet");
const geosetTable = element<HTMLDivElement>("lab-geosets");
const slotTable = element<HTMLDivElement>("lab-slots");
const materialTable = element<HTMLDivElement>("lab-materials");
const attachedTable = element<HTMLDivElement>("lab-attached");
const textureTable = element<HTMLDivElement>("lab-textures");
const stopButton = element<HTMLButtonElement>("lab-stop");

const baseUrl = labGatewayUrl(location);
const textures = new ModelTextureLoader();
const atlases = new CharacterAtlasClient(baseUrl);

/** Set by the stop button; every sheet loop checks it between cells. */
let stopped = false;
stopButton.addEventListener("click", () => {
  stopped = true;
  stopButton.disabled = true;
  say("Остановлено.");
});

function say(message: string): void {
  progressText.textContent = message;
}

/** An error that already names what it was doing, so the wrapper below does not say it twice. */
class LabError extends Error {}

/**
 * A fetch that always ends, body and all.
 *
 * The gateway generates an artifact on the first request for it — a character model is a couple of
 * seconds of M2 parsing — and a lab that shows an empty canvas while that happens is a lab nobody
 * trusts. Every request says what it is waiting for and gives up loudly rather than silently.
 *
 * The body is read inside the budget rather than after it. `fetch` resolves the moment the headers
 * land, so a timer cleared there covers the headers and nothing else: a gateway that answers 200
 * and then stalls mid-body would hang the page for ever with the progress line frozen on the
 * request that never finished — which is the exact silent wait this function exists to prevent.
 */
async function within<T>(url: string, what: string, read: (response: Response) => Promise<T>,
  timeout = 60_000): Promise<T> {
  say(`Запрос: ${what}…`);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeout);
  try {
    const response = await fetch(url, { signal: abort.signal });
    if (!response.ok) throw new LabError(`${what}: шлюз ответил ${response.status}`);
    return await read(response);
  } catch (error) {
    if (abort.signal.aborted) throw new LabError(`${what}: шлюз молчит дольше ${timeout / 1000} с`);
    if (error instanceof LabError) throw error;
    throw new LabError(`${what}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

async function getJson<T>(url: string, what: string): Promise<T> {
  return await within(url, what, (response) => response.json() as Promise<T>);
}

async function getBuffer(url: string, what: string): Promise<ArrayBuffer> {
  return await within(url, what, (response) => response.arrayBuffer());
}

/** The display record: the model path, its scale, and the texture slots the record fills. */
async function displayRecord(displayId: number): Promise<CreatureModelMetadata> {
  const rows = await getJson<CreatureModelMetadata[]>(
    `${baseUrl}/dbc/creature-models?v=${CREATURE_MODEL_VERSION}&ids=${displayId}`, `display ${displayId}`);
  const row = rows[0];
  if (!row) throw new Error(`display ${displayId}: в CreatureDisplayInfo такой строки нет`);
  return row;
}

async function appearanceOf(look: LabLook): Promise<CharacterAppearance> {
  return await getJson<CharacterAppearance>(
    `${baseUrl}/dbc/character-appearance?${appearanceQuery(look)}`,
    `внешность ${raceName(look.race)}/${look.sex ? "Ж" : "М"} `
    + `skin ${look.skin} face ${look.face} hair ${look.hair}/${look.hairColor} beard ${look.facialHair}`);
}

const modelCache = new Map<string, Promise<WvmModel>>();

/** The published artifact, once per path however many cells of a contact sheet want it. */
function modelOf(path: string): Promise<WvmModel> {
  let pending = modelCache.get(path);
  if (pending) return pending;
  pending = (async () => {
    const data = await getBuffer(`${baseUrl}/visual/model?path=${encodeURIComponent(path)}`, `модель ${path}`);
    // WWM1 is a building and WVM1..3 are the pre-appearance formats; a character is always WVM9,
    // and anything else means the gateway is older than this page.
    if (!isWvm9(data)) throw new Error(`${path}: артефакт не WVM9 — шлюз старше страницы`);
    return decodeWvm9(data);
  })();
  modelCache.set(path, pending);
  return pending;
}

/**
 * The animations held back out of the artifact, fetched only when the wanted pose is not in it.
 *
 * The cache holds the decoded clips rather than the promise of having added them to a template.
 * Keyed on the path and holding `Promise<void>`, the second character built from the same file
 * awaited a promise that had already given its clips to somebody else's template and got none of
 * its own — it would then silently strike whatever `resolveAnimation` fell back to instead of the
 * pose it was asked for.
 */
const animationCache = new Map<string, Promise<WvmSkeletonClip[]>>();
async function ensureAnimation(path: string, template: SkinnedTemplate, wanted: number): Promise<void> {
  if (template.clips.has(wanted)) return;
  let pending = animationCache.get(path);
  if (!pending) {
    pending = (async () => decodeWvaAnimations(
      await getBuffer(`${baseUrl}/visual/animations?path=${encodeURIComponent(path)}`, `анимации ${path}`),
      template.parents.length))();
    animationCache.set(path, pending);
  }
  addSkinnedClips(template, await pending);
}

interface LabCharacter {
  metadata: CreatureModelMetadata;
  appearance: CharacterAppearance;
  model: WvmModel;
  built: BuiltModel;
  panel: LabPanel;
  atlasKey: string;
  /**
   * Whether the body atlas produced a texture. `false` with layers to paint from is defect D9: the
   * renderer throws the composition away and starts it again on the next frame, for ever.
   */
  atlasComposed: boolean;
  template: SkinnedTemplate | undefined;
  object: THREE.Object3D;
  instance: SkinnedInstance | undefined;
  height: number;
}

/** Everything from the appearance bytes to a drawable object, by the client's own route. */
async function makeCharacter(look: LabLook, query: LabQuery): Promise<LabCharacter> {
  const appearance = await appearanceOf(look);
  // `model=` names the file outright, so the race is never asked for a display id it may not have:
  // this is how a custom or non-playable model is looked at at all.
  const metadata = query.model
    ? { id: 0, model: query.model, scale: 1, collisionHeight: 0, mountHeight: 0, textures: "" }
    : await displayRecord(query.display ?? raceDisplay(look.race, look.sex));
  const model = await modelOf(metadata.model);

  const atlasKey = appearanceKey(appearance);
  say(`Сборка атласа тела: ${appearance.body.length} слоёв…`);
  const body = appearance.body.length > 0 ? await atlases.compose(atlasKey, appearance.body) : undefined;
  const slotTextures = body ? new Map([[TEXTURE_TYPE_BODY, body]]) : undefined;

  const emitted = query.geosets ?? appearance.geosets;
  const { built, panel } = buildForLab(model, {
    modelPath: metadata.model,
    slots: characterSlots(metadata.textures, appearance),
    geosets: geosetList(emitted),
    baseUrl,
    loadTexture: (url) => textures.load(url),
    ...(slotTextures ? { slotTextures } : {}),
    skinned: Boolean(model.skeleton),
    emitted,
  });

  const rig = model.skeleton;
  const template = rig ? buildSkinnedTemplateFrom(built.geometry, rig, built.height) : undefined;
  if (template) {
    const instance = instantiateSkinned(template, built.materials);
    instance.root.scale.setScalar(metadata.scale);
    return {
      metadata, appearance, model, built, panel, atlasKey, atlasComposed: body !== undefined,
      template, object: instance.root, instance, height: built.height * metadata.scale,
    };
  }
  // No rig: the same static-mesh fallback the renderer uses for the tenth of the client's models
  // that have no bones. A character model always has them, so seeing this is itself a finding.
  const mesh = new THREE.Mesh(built.geometry, built.materials);
  mesh.quaternion.copy(M2_TO_SCENE);
  mesh.scale.setScalar(metadata.scale);
  return {
    metadata, appearance, model, built, panel, atlasKey, atlasComposed: body !== undefined,
    template: undefined, object: mesh, instance: undefined, height: built.height * metadata.scale,
  };
}

function raceDisplay(race: number, sex: number): number {
  const displays = PLAYABLE_RACE_DISPLAYS[race];
  if (!displays) throw new Error(`race=${race} — не играбельная раса; укажите display= или model=`);
  return sex ? displays[1] : displays[0];
}

/** Frees everything one character owns. A contact sheet builds thousands of them. */
function disposeCharacter(character: LabCharacter): void {
  const instance = character.instance;
  if (instance) {
    instance.mixer.stopAllAction();
    instance.mixer.uncacheRoot(instance.root);
    instance.skeleton.dispose();
  }
  character.built.geometry.dispose();
  for (const material of character.built.materials) material.dispose();
  for (const texture of character.built.ownedTextures) texture.dispose();
  // The composed body is the expensive half — a 512x512 canvas per look — and a sheet of three
  // thousand looks holds three thousand of them unless each is let go as its cell is drawn.
  atlases.release(character.atlasKey);
}

/* --- The stage ------------------------------------------------------------------------------ */

const renderer = (() => {
  try {
    // `preserveDrawingBuffer` because a contact sheet copies each cell out of this canvas with
    // `drawImage`, and a buffer the compositor is free to clear is a sheet of blank squares.
    return new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  } catch (error) {
    say(`WebGL недоступен: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
})();
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x15181d);
scene.add(new THREE.HemisphereLight(0xc9e2f4, 0x293326, 2.1));
const sun = new THREE.DirectionalLight(0xfff0cf, 2.2);
sun.position.set(4, 9, 6);
scene.add(sun);

/**
 * A chequerboard under the feet.
 *
 * Not decoration: a hole in a shin reads as a hole only against something that is obviously behind
 * it. Over a flat background a missing geoset and a dark texture look the same.
 */
const board = (() => {
  const tile = document.createElement("canvas");
  tile.width = 2;
  tile.height = 2;
  const context = tile.getContext("2d");
  if (context) {
    context.fillStyle = "#2b3038";
    context.fillRect(0, 0, 2, 2);
    context.fillStyle = "#3d4450";
    context.fillRect(0, 0, 1, 1);
    context.fillRect(1, 1, 1, 1);
  }
  const texture = new THREE.CanvasTexture(tile);
  texture.magFilter = THREE.NearestFilter;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(24, 24);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(24, 24),
    new THREE.MeshStandardMaterial({ map: texture, roughness: 1 }),
  );
  mesh.rotation.x = -Math.PI / 2;
  return mesh;
})();
scene.add(board);

const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 200);
const orbit = { yaw: 0.5, pitch: 0.22, distance: 5, height: 1 };

function placeCamera(): void {
  const target = new THREE.Vector3(0, orbit.height, 0);
  camera.position.set(
    target.x + Math.sin(orbit.yaw) * Math.cos(orbit.pitch) * orbit.distance,
    target.y + Math.sin(orbit.pitch) * orbit.distance,
    target.z + Math.cos(orbit.yaw) * Math.cos(orbit.pitch) * orbit.distance,
  );
  camera.lookAt(target);
}

function resizeStage(): void {
  const width = Math.max(160, canvas.clientWidth);
  const height = Math.max(160, canvas.clientHeight);
  // Guarded rather than set every frame: `setSize` reallocates the drawing buffer, and doing that
  // sixty times a second for a window nobody is resizing is the whole frame budget of a lab.
  if (canvas.width === Math.round(width * renderer.getPixelRatio())
    && canvas.height === Math.round(height * renderer.getPixelRatio())) return;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

let dragging = false;
canvas.addEventListener("pointerdown", (event) => {
  dragging = true;
  canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener("pointerup", (event) => {
  dragging = false;
  canvas.releasePointerCapture(event.pointerId);
});
canvas.addEventListener("pointermove", (event) => {
  if (!dragging) return;
  orbit.yaw -= event.movementX * 0.008;
  orbit.pitch = Math.max(-1.2, Math.min(1.3, orbit.pitch + event.movementY * 0.006));
});
canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  orbit.distance = Math.max(0.4, Math.min(40, orbit.distance * (1 + Math.sign(event.deltaY) * 0.12)));
}, { passive: false });

/* --- One character -------------------------------------------------------------------------- */

async function showOne(query: LabQuery): Promise<void> {
  const character = await makeCharacter(query, query);
  scene.add(character.object);
  orbit.height = character.height * 0.55;
  orbit.distance = Math.max(2.2, character.height * 1.9);
  board.visible = true;

  let clock: THREE.Clock | undefined;
  if (character.template && character.instance) {
    const name = query.animation as AnimationName;
    const wanted = ANIMATION_IDS[name];
    if (wanted === undefined) throw new Error(`animation=${query.animation} — такой позы нет в AnimationData`);
    await ensureAnimation(character.metadata.model, character.template, wanted);
    // Walked down `AnimationData.Fallback` exactly as the renderer walks it, so a model without
    // the pose strikes the one the table says is its equivalent instead of freezing.
    const played = resolveAnimation(character.template.clips, [wanted]);
    const clip = played === undefined ? undefined : character.template.clips.get(played);
    if (clip) {
      character.instance.mixer.clipAction(clip).play();
      clock = new THREE.Clock();
    } else {
      say(`Поза ${query.animation} не пришла с моделью; персонаж стоит в позе покоя.`);
    }
  }

  showPanel(query, character);
  void fillTextureStatus(character);

  const frame = (): void => {
    requestAnimationFrame(frame);
    resizeStage();
    if (clock && character.instance) character.instance.mixer.update(clock.getDelta());
    placeCamera();
    renderer.render(scene, camera);
  };
  frame();
  // After the first frame is on the screen: each piece is a separate download, and a character
  // that appears only once its helmet has is a page that looks broken while the gateway thinks.
  await hangAttachments(query, character);
  say(`Готово. ${character.metadata.model}`);
}

/**
 * Everything the character hangs off itself, on the bones the client hangs it from.
 *
 * The same walk `WorldRenderer3D.#updateAttachments` makes, through the same `attachmentPoint`,
 * `boneOf` and `attachmentOffset`: a helmet, two pauldrons and whatever is in the hands are their
 * own models on their own bones, and the appearance's geosets have already taken the ears and the
 * face away to make room for the helmet. Drawn nowhere, the page showed a bare earless head and a
 * panel that called the build clean.
 *
 * Sheets do not come through here: `sheet=legs` is about geosets and the pieces it would hang are
 * the same twenty for every cell.
 */
async function hangAttachments(query: LabQuery, character: LabCharacter): Promise<void> {
  const lines = labAttachmentLines(character.appearance.attached ?? [], query.sheath);
  showAttachments(lines);
  if (lines.length === 0) return;
  const { instance, template } = character;
  for (const line of lines) {
    if (line.point === undefined) {
      line.status = "не нарисована";
    } else if (!instance || !template) {
      line.status = "у модели нет скелета — вешать не на что";
    } else {
      const bone = boneOf(character.model, instance, line.point);
      if (!bone) {
        // Not a fault of the item: several character models genuinely lack a point, and the
        // renderer skips the piece and tries again next frame rather than putting it at the feet.
        line.status = `в модели нет точки ${line.point}`;
      } else {
        try {
          const wvm = await modelOf(line.model);
          const { built, panel } = buildForLab(wvm, {
            modelPath: line.model,
            // An item model almost never names its own diffuse texture: it declares the type 2
            // slot and the wearer's ItemDisplayInfo fills it. Exactly what the renderer passes.
            slots: new Map(line.texture ? [[TEXTURE_TYPE_OBJECT_SKIN, line.texture]] : []),
            geosets: EVERY_GEOSET,
            baseUrl,
            loadTexture: (url) => textures.load(url),
            skinned: false,
          });
          const mesh = new THREE.Mesh(built.geometry, built.materials);
          // Carried around by an animated bone, so its rest-pose bounds say nothing about where
          // it is — the same reason the renderer turns culling off for a worn piece.
          mesh.frustumCulled = false;
          mesh.position.copy(attachmentOffset(character.model, template.pivots, line.point));
          bone.add(mesh);
          line.triangles = panel.triangles;
          line.flatTriangles = panel.flatTriangles;
          line.status = `точка ${line.point}`;
        } catch (error) {
          line.status = error instanceof Error ? error.message : String(error);
        }
      }
    }
    showAttachments(lines);
  }
}

/* --- The panel ------------------------------------------------------------------------------ */

function row(cells: string[], className = ""): HTMLParagraphElement {
  const line = document.createElement("p");
  if (className) line.className = className;
  for (const cell of cells) {
    const span = document.createElement("span");
    span.textContent = cell;
    line.append(span);
  }
  return line;
}

function showPanel(query: LabQuery, character: LabCharacter): void {
  const { panel, appearance } = character;
  titleText.textContent = `${raceName(query.race)}`
    + ` · ${query.sex ? "женщина" : "мужчина"} · ${character.metadata.model}`;
  summaryText.textContent = labSummary(panel)
    + (appearance.body.length > 0 && !character.atlasComposed ? " · АТЛАС ТЕЛА НЕ СОБРАЛСЯ" : "")
    + (character.template ? "" : " · БЕЗ СКЕЛЕТА");

  // «в модели» has three answers, not two: the id is there, or it is not there and nothing is
  // drawn, or it is not there and the nearest member of its family was drawn in its place — which
  // is the whole of Т5 and is invisible in a screenshot. A substituted line is not a fault.
  geosetTable.replaceChildren(
    row(["геосет", "выдан", "в модели", "тр. в файле", "нарисовано"], "head"),
    ...panel.geosets.map((line) => row(
      [`${line.id}`, line.emitted ? "да" : "—",
        line.inModel ? "да" : line.drawnAs === undefined ? "НЕТ" : `нет → ${line.drawnAs}`,
        `${line.triangles}`, `${line.drawn}`],
      line.emitted && !line.inModel && line.drawnAs === undefined ? "bad" : line.emitted ? "" : "muted",
    )),
  );

  // An empty slot is only a defect when something drawn samples it. Every character model declares
  // a cloak slot; a character with no cloak draws no cloak batch, and painting that row red made a
  // flawless human male look like two faults.
  slotTable.replaceChildren(
    row(["слот", "тип", "чем заполнен"], "head"),
    ...panel.slots.map((line) => row(
      [`${line.type}`, line.label,
        line.kind !== "empty" ? line.filledWith || line.declared
          : line.sampled ? "НИЧЕМ" : "ничем · и никто его не рисует"],
      line.kind === "empty" ? (line.sampled ? "bad" : "muted") : "",
    )),
  );

  materialTable.replaceChildren(
    row(["материал", "геосет", "слот", "тр.", "текстура"], "head"),
    ...panel.materials.map((line) => row(
      [`${line.index}`, line.geoset === undefined ? "?" : `${line.geoset}`,
        line.slot < 0 ? "—" : `${line.slot} ${line.slotLabel}`, line.hidden ? `${line.triangles} · не рисуется` : `${line.triangles}`,
        line.flat ? `плоский ${LAB_FLAT_COLOUR}` : line.texture],
      line.flat ? "bad" : line.hidden ? "muted" : "",
    )),
  );

  // The body layers are named here rather than in the slots table because they are not slots: they
  // are the pieces the atlas is painted from, and «hair: ""» versus «hair: a path that 404s» is
  // exactly the distinction three of the open defects turn on.
  textureTable.replaceChildren(
    row(["файл", "роль", "статус"], "head"),
    ...appearance.body.map((layer) => row([layer.path, layer.section ?? "тело", "…"])),
    ...panel.texturePaths.map((path) => row([path, "слот", "…"])),
  );
}

/** EQUIPMENT_SLOT_* by name, for the five slots that hang a model of their own. */
const ATTACHMENT_SLOT_NAMES: Readonly<Record<number, string>> = {
  0: "голова", 2: "плечо", 15: "правая рука", 16: "левая рука", 17: "стрелковое",
};

function showAttachments(lines: readonly LabAttachmentLine[]): void {
  if (lines.length === 0) {
    attachedTable.replaceChildren(row(["—", "шлюз не назвал ни одной вещи с моделью", "", ""], "muted"));
    return;
  }
  attachedTable.replaceChildren(
    row(["слот", "модель", "тр.", "куда"], "head"),
    ...lines.map((line) => row(
      [`${ATTACHMENT_SLOT_NAMES[line.slot] ?? `слот ${line.slot}`}${line.side === "right" ? " пр." : ""}`,
        line.model,
        line.triangles > 0 ? `${line.triangles}${line.flatTriangles > 0 ? ` (${line.flatTriangles} пл.)` : ""}` : "—",
        line.point === undefined ? (line.refusal ?? "не рисуется") : line.status],
      // Grey for a piece the client deliberately does not hang, red for one it meant to and did
      // not, and nothing at all while its own artifact is still on its way.
      line.point === undefined ? "muted"
        : line.status === "…" ? ""
          : line.triangles === 0 || line.flatTriangles > 0 ? "bad" : "",
    )),
  );
}

/** Fills the status column of the texture table by asking the gateway for each file. */
async function fillTextureStatus(character: LabCharacter): Promise<void> {
  const paths = [
    ...character.appearance.body.map((layer) => layer.path),
    ...character.panel.texturePaths,
  ];
  const lines = [...textureTable.children].slice(1);
  for (let index = 0; index < paths.length; index++) {
    const line = lines[index];
    const status = line?.children[2];
    if (!status) continue;
    try {
      const response = await fetch(textureUrl(baseUrl, paths[index]!));
      const bytes = response.ok ? (await response.blob()).size : 0;
      status.textContent = response.ok ? `${response.status} · ${bytes} Б` : `${response.status}`;
      if (!response.ok) line?.classList.add("bad");
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
      line?.classList.add("bad");
    }
  }
}

/* --- Contact sheets ------------------------------------------------------------------------- */

const HAIR_CELL = 96;
const LEG_CELL = 128;
/** How many cells a contact sheet draws before it lets go of the images it has fetched. */
const ATLAS_FLUSH_EVERY = 200;

interface SheetCell {
  look: LabLook;
  caption: string;
  /** How the camera frames it: the head for a hairstyle, the whole body for an outfit. */
  head: boolean;
  yaw: number;
  /**
   * Where the cell goes, decided by whoever built the list rather than by the running count.
   *
   * A hairstyle sheet laid out as one long ribbon is unreadable: what makes it evidence is that
   * one race and sex is a block, one row per style and one column per colour, so a colour that is
   * broken for every style is a column and a style that is broken for every colour is a row.
   */
  column: number;
  row: number;
}

async function drawSheet(cells: SheetCell[], cellSize: number, query: LabQuery): Promise<void> {
  canvas.hidden = true;
  sheetCanvas.hidden = false;
  const columns = Math.max(1, ...cells.map((cell) => cell.column + 1));
  const rows = Math.max(1, ...cells.map((cell) => cell.row + 1));
  sheetCanvas.width = columns * cellSize;
  sheetCanvas.height = rows * (cellSize + 14);
  const context = sheetCanvas.getContext("2d");
  if (!context) throw new Error("2D-контекст для контактного листа недоступен");
  context.fillStyle = "#15181d";
  context.fillRect(0, 0, sheetCanvas.width, sheetCanvas.height);
  context.font = "10px system-ui, sans-serif";
  // Every cell resolves its own model, so a `display=` or `model=` meant for the single-character
  // view would draw the same body in all three thousand squares.
  const cellQuery: LabQuery = { ...query, display: undefined, model: undefined };

  renderer.setSize(cellSize, cellSize, false);
  camera.aspect = 1;
  camera.updateProjectionMatrix();
  board.visible = false;

  let drawn = 0;
  let failed = 0;
  let flat = 0;
  for (const cell of cells) {
    if (stopped) break;
    const x = cell.column * cellSize;
    const y = cell.row * (cellSize + 14);
    try {
      const character = await makeCharacter(cell.look, cellQuery);
      scene.add(character.object);
      orbit.yaw = cell.yaw;
      orbit.pitch = cell.head ? 0.06 : 0.12;
      orbit.height = cell.head ? character.height * 0.92 : character.height * 0.52;
      orbit.distance = cell.head ? character.height * 0.5 : character.height * 1.8;
      placeCamera();
      renderer.render(scene, camera);
      context.drawImage(renderer.domElement, x, y, cellSize, cellSize);
      if (character.panel.flatTriangles > 0) {
        flat++;
        // A cell whose triangles fell back to the flat colour is ringed in that same colour, so a
        // sheet of three thousand faces can be read at a glance instead of cell by cell.
        context.strokeStyle = LAB_FLAT_COLOUR;
        context.lineWidth = 2;
        context.strokeRect(x + 1, y + 1, cellSize - 2, cellSize - 2);
      }
      scene.remove(character.object);
      disposeCharacter(character);
    } catch (error) {
      failed++;
      context.fillStyle = "#5a2530";
      context.fillRect(x, y, cellSize, cellSize);
      context.fillStyle = "#ffb4c0";
      context.fillText(error instanceof Error ? error.message.slice(0, 24) : "ошибка", x + 4, y + cellSize / 2);
    }
    context.fillStyle = "#9fb0c5";
    context.fillText(cell.caption.slice(0, Math.floor(cellSize / 5)), x + 2, y + cellSize + 10);
    drawn++;
    say(`Контактный лист: ${drawn} из ${cells.length} · плоских ${flat} · ошибок ${failed}`);
    // The atlas client caches every source image it has ever fetched and never evicts one — right
    // for a session in the world, where a crowd shares a few dozen files, and wrong for a sweep
    // over three thousand looks. Dropped wholesale now and then rather than leaked; what it costs
    // is re-fetching a handful of already-warm files.
    if (drawn % ATLAS_FLUSH_EVERY === 0) atlases.dispose();
    // One cell per animation frame: the tab stays answerable and the sheet fills in front of you
    // rather than after a minute of a white page.
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  summaryText.textContent = `Ячеек ${drawn} из ${cells.length} · с плоскими треугольниками ${flat} · ошибок ${failed}`;
  say(stopped ? "Остановлено." : "Контактный лист готов.");
}

/**
 * Every playable race and sex against every (style, colour) their own options endpoint offers.
 *
 * One block per profile, one row per style, one column per colour. The sheet is the endpoint's
 * own answer and not a range of its own, which is what makes it a check on the endpoint: it used
 * to be 3,278 cells, 48 of them a flat green night-elf wig for colours 8 and 9, which exist for no
 * night elf at all. It is 3,230 now — the columns are the colours that have a row, so a broken
 * colour cannot come back as a column of green without the endpoint offering it again.
 */
async function hairCells(): Promise<SheetCell[]> {
  const cells: SheetCell[] = [];
  let row = 0;
  for (const profile of playableProfiles()) {
    const options = await getJson<{ hairStyles: number[]; hairColors: number[] }>(
      `${baseUrl}/dbc/character-options?v=${CHARACTER_OPTIONS_VERSION}&race=${profile.race}&sex=${profile.sex}`,
      `варианты ${raceName(profile.race)}/${profile.sex ? "Ж" : "М"}`);
    for (const style of options.hairStyles) {
      for (const [column, colour] of options.hairColors.entries()) {
        cells.push({
          look: {
            race: profile.race, sex: profile.sex, skin: 0, face: 0,
            hair: style, hairColor: colour, facialHair: 0, items: [],
          },
          caption: `${profile.race}/${profile.sex} ${style}:${colour}`,
          head: true,
          yaw: 0.35,
          column,
          row,
        });
      }
      row++;
    }
  }
  return cells;
}

/**
 * Every playable model, naked and in whatever leg outfits the query names, front and three-quarter.
 *
 * The outfits come from `&legs=<displayId>,…` rather than from a sweep of the item tables, because
 * no gateway route enumerates item displays: the browser only ever learns the display id of an item
 * somebody is actually wearing. `&legs=` with nothing in it is the naked look, which is the one the
 * `BODY_ONLY` defect is about.
 */
function legCells(query: LabQuery): SheetCell[] {
  const cells: SheetCell[] = [];
  const outfits = query.legs.length > 0 ? query.legs : [0];
  // One row per model, one pair of columns per outfit, so a defect that belongs to a race is a row
  // and one that belongs to an outfit is a column.
  playableProfiles().forEach((profile, row) => {
    outfits.forEach((display, outfit) => {
      // EQUIPMENT_SLOT_LEGS is 6 and INVTYPE_LEGS is 7, the pair `visibleEquipment` puts on the wire.
      const items = display > 0 ? [{ slot: 6, inventoryType: 7, displayId: display }] : [];
      ([["анфас", 0], ["3/4", 0.7]] as const).forEach(([label, yaw], view) => {
        cells.push({
          look: {
            race: profile.race, sex: profile.sex, skin: 0, face: 0,
            hair: 0, hairColor: 0, facialHair: 0, items,
          },
          caption: `${profile.race}/${profile.sex} ${display || "гол"} ${label}`,
          head: false,
          yaw,
          column: outfit * 2 + view,
          row,
        });
      });
    });
  });
  return cells;
}

/* --- Start ---------------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const query = parseLabQuery(location.search);
  titleText.textContent = query.sheet === "hair" ? "Контактный лист причёсок"
    : query.sheet === "legs" ? "Контактный лист ног"
      : "Персонаж";
  if (query.sheet === "hair") {
    say("Считаю, сколько причёсок предлагает шлюз…");
    await drawSheet(await hairCells(), HAIR_CELL, query);
    return;
  }
  if (query.sheet === "legs") {
    await drawSheet(legCells(query), LEG_CELL, query);
    return;
  }
  stopButton.disabled = true;
  await showOne(query);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  say(`Ошибка: ${message}`);
  progressText.className = "bad";
});
