import type { AuthSessionResult } from "../../auth/login.js";
import type { WorldClient } from "../../world/WorldClient.js";
import type { WorldStore } from "../../world/WorldStore.js";
import type { EnvironmentClient, TerrainClient } from "../Terrain.js";
import type { TerrainSplatClient } from "../TerrainSplat.js";
import type { GroundCoverClient } from "../GroundCover.js";
import type { LightClient } from "../LightClient.js";
import type { LiquidTextureClient } from "../Water.js";
import type { SpellMetadata, SpellMetadataClient } from "../SpellMetadata.js";
import type { SpellVisualClient } from "../SpellVisualClient.js";
import type { SpellVisualCoordinator } from "../SpellVisualLifecycle.js";
import type { CreatureMetadataClient } from "../CreatureMetadata.js";
import type { GameObjectMetadataClient } from "../GameObjectMetadata.js";
import type { TransportPathClient } from "../TransportPath.js";
import type { HorizonClient } from "../Horizon.js";
import type { CreatureModelClient } from "../CreatureModelClient.js";
import type { LockClient } from "../LockClient.js";
import type { FactionClient } from "../FactionClient.js";
import type { TalentClient } from "../TalentClient.js";
import type { AreaClient } from "../AreaClient.js";
import type { MinimapTileClient } from "../MinimapTiles.js";
import type { TextureBitmapCache } from "../TextureBitmaps.js";
import type { CollisionSource } from "./CollisionSource.js";
import type { ItemMetadataClient } from "../ItemMetadata.js";
import type { WorldRenderer3D } from "../WorldRenderer3D.js";
import type { SimpleScene } from "../SimpleScene.js";
import {
  CAMERA_DEFAULT_DISTANCE, CAMERA_DEFAULT_EYE_HEIGHT, CAMERA_DEFAULT_PITCH, CAMERA_DEFAULT_PIVOT_HEIGHT,
  CAMERA_FIRST_PERSON_DISTANCE,
} from "../SimpleScene.js";
import type { SoundClient } from "../SoundClient.js";
import type { SoundPlayer } from "../Sound.js";
import type { ModuleLoader } from "../ui/ModuleLoader.js";
import type { CameraRig } from "./CameraRig.js";
import type { SessionAssetWarmup } from "../AssetWarmup.js";

/**
 * Everything that is current: the connection, the asset clients it feeds, and where the camera is
 * looking.
 *
 * These were module-level `let`s in one file that owned the whole interface. Panels in their own
 * files cannot share a `let`, and exporting one gives an importer a copy it may not write to, so
 * they live on one object instead. Every field is replaced on login and cleared on disconnect,
 * which is why they are all optional: a panel that reads one between worlds gets `undefined`
 * rather than a stale client pointed at the last realm.
 */
export interface GameContext {
  session: AuthSessionResult | undefined;
  world: WorldClient | undefined;
  /** Turns world state into per-field subscriptions. Flushed once a frame by the render loop. */
  store: WorldStore | undefined;
  terrain: TerrainClient | undefined;
  terrainSplat: TerrainSplatClient | undefined;
  /** What grows on the ground: the per-tile recipe and the effect table it is read against. */
  groundCover: GroundCoverClient | undefined;
  light: LightClient | undefined;
  liquids: LiquidTextureClient | undefined;
  environment: EnvironmentClient | undefined;
  spellMetadataClient: SpellMetadataClient | undefined;
  /** What a spell looks like, asked for by the renderer rather than awaited by a window. */
  spellVisuals: SpellVisualClient | undefined;
  /** Owns authoritative cast/aura visual lifetimes across metadata and world epochs. */
  spellVisualCoordinator: SpellVisualCoordinator | undefined;
  creatureMetadata: CreatureMetadataClient | undefined;
  gameObjectMetadata: GameObjectMetadataClient | undefined;
  /** The paths lifts run on, by game object entry. Nothing else in the world uses them. */
  transportPaths: TransportPathClient | undefined;
  /** The far horizon, one `.wdl` per map. */
  horizon: HorizonClient | undefined;
  creatureModels: CreatureModelClient | undefined;
  locks: LockClient | undefined;
  /** Every faction template, which is the only place the reaction to a unit is written down. */
  factions: FactionClient | undefined;
  /** Talent trees, glyphs and skill lines. None of it is on the wire; all of it is client data. */
  talentData: TalentClient | undefined;
  /**
   * Zones, their rectangles and their exploration overlays. The server names an area with a number
   * and stops there, so every label and every shape on a map is answered from here.
   */
  areas: AreaClient | undefined;
  /** The baked minimap pictures, resolved cell to MD5 to texture. */
  minimapTiles: MinimapTileClient | undefined;
  /** The world map's parchment art and its exploration overlays, by path in the archives. */
  mapArt: TextureBitmapCache | undefined;
  /**
   * What is solid nearby, out of the server's own collision meshes. Absent until the first tile of
   * placements and the first mesh have landed, and the physics reads that as open ground.
   */
  collision: CollisionSource | undefined;
  /** True while a world transfer is waiting for terrain and collision around the destination. */
  worldLoading: boolean;
  /**
   * Where the gateway answers, as an http origin.
   *
   * Every client object in here works this out for itself from the WebSocket URL it was handed,
   * which is fine while the thing that wants a picture is a client. It is not fine for a single
   * `<img>` in the page — the class portrait in the player frame — which has no client of its own
   * and would otherwise have to grow one to ask for one texture.
   */
  gatewayOrigin: string | undefined;
  /** What `SoundEntries` says about the kits the server has named, gathered a batch at a time. */
  soundKits: SoundClient | undefined;
  /**
   * The one thing that makes a noise. Absent until a world is entered, and its `AudioContext` is
   * not built until the first sound is asked for — a browser suspends one built before the page
   * has been clicked, and a suspended context is a silent one.
   */
  sound: SoundPlayer | undefined;
  itemMetadata: ItemMetadataClient | undefined;
  /** Small, session-owned speculative queue; it never participates in loading readiness. */
  assetWarmup: SessionAssetWarmup | undefined;
  /**
   * What the tswow modules on this machine ship — windows, schemas, styles — and what went wrong.
   *
   * Beside `world.customPackets` and the window registry rather than inside either: those two are
   * what a module *is*, this is where it came from — and the diagnostics window wants both, one to
   * say what a module declared and the other to say which file said it.
   */
  modules: ModuleLoader | undefined;
  /** Spell rows already resolved, by spell id. */
  spells: Map<number, SpellMetadata>;
  /**
   * When the global cooldown ends. `SPELL_CAST_ACCEPTED` anchors it to the server-confirmed cast;
   * the duration is the accepted spell's `StartRecoveryTime` from the DBC.
   */
  globalCooldownUntil: number;
  /**
   * The unit the player has put a focus on. Its own frame belongs to slice I2; until then the key
   * still has somewhere to write, so nothing has to be rewired when the frame arrives.
   */
  focusGuid: bigint | undefined;
  renderer: WorldRenderer3D | undefined;
  scene: SimpleScene | undefined;
  /**
   * Where the camera is looking, and how it is getting there. Every field is documented on
   * `CameraRig`; what belongs here is why it lives on the context at all.
   *
   * Six separate places build a camera in the same frame — the world, the plates, the bubbles, the
   * picker, the boom scan and the sound listener — and they have to build the *same* camera or the
   * names drift off the heads they belong to. One object they all read is what guarantees that,
   * and the loop is the only thing that writes the eased half of it.
   */
  camera: CameraRig;
}

export const game: GameContext = {
  session: undefined,
  world: undefined,
  store: undefined,
  terrain: undefined,
  terrainSplat: undefined,
  groundCover: undefined,
  light: undefined,
  liquids: undefined,
  environment: undefined,
  spellMetadataClient: undefined,
  spellVisuals: undefined,
  spellVisualCoordinator: undefined,
  creatureMetadata: undefined,
  gameObjectMetadata: undefined,
  transportPaths: undefined,
  horizon: undefined,
  creatureModels: undefined,
  locks: undefined,
  factions: undefined,
  talentData: undefined,
  areas: undefined,
  minimapTiles: undefined,
  mapArt: undefined,
  collision: undefined,
  worldLoading: false,
  gatewayOrigin: undefined,
  soundKits: undefined,
  sound: undefined,
  itemMetadata: undefined,
  assetWarmup: undefined,
  modules: undefined,
  spells: new Map(),
  globalCooldownUntil: 0,
  focusGuid: undefined,
  renderer: undefined,
  scene: undefined,
  camera: {
    yaw: 0, pitch: CAMERA_DEFAULT_PITCH, distance: CAMERA_DEFAULT_DISTANCE, view: CAMERA_DEFAULT_DISTANCE,
    viewPitch: CAMERA_DEFAULT_PITCH, zoom: CAMERA_DEFAULT_DISTANCE,
    // Nothing has been scanned yet, and until something has, nothing is in the way.
    wallView: Number.POSITIVE_INFINITY, terrainView: Number.POSITIVE_INFINITY,
    pivotHeight: CAMERA_DEFAULT_PIVOT_HEIGHT, eyeHeight: CAMERA_DEFAULT_EYE_HEIGHT,
  },
};

/**
 * How high the camera hangs on the character this frame, and which of the two heights that is.
 *
 * Asked here rather than at each of the four places that build a camera, because they have to
 * agree: the plates and the bubbles are projected through their own camera and drift off the
 * heads the moment it differs from the one the world was drawn with.
 *
 * First person is decided by the distance the *wheel* asked for and never by the one a wall
 * granted — a corner tight enough to squeeze the boom to nothing must leave the player in an
 * awkward close shot, not silently behind their own eyes.
 */
export function cameraPivotHeight(): number {
  return game.camera.distance <= CAMERA_FIRST_PERSON_DISTANCE ? game.camera.eyeHeight : game.camera.pivotHeight;
}

/** Drops everything a realm owns. Called when leaving a world and before entering another. */
export function clearWorldContext(): void {
  // Invalidate packet, metadata and asynchronous audio callbacks before dropping the world
  // identity. This must precede the ordinary renderer/sound cleanup so no stale replay can race it.
  game.spellVisualCoordinator?.clear();
  game.spellVisualCoordinator = undefined;
  game.assetWarmup?.dispose();
  game.assetWarmup = undefined;
  game.world = undefined;
  game.store = undefined;
  game.terrain = undefined;
  game.terrainSplat = undefined;
  game.groundCover = undefined;
  game.light = undefined;
  game.liquids = undefined;
  game.environment = undefined;
  game.spellMetadataClient = undefined;
  game.spellVisuals = undefined;
  game.creatureMetadata = undefined;
  game.gameObjectMetadata = undefined;
  game.transportPaths = undefined;
  game.horizon = undefined;
  game.creatureModels = undefined;
  game.locks = undefined;
  game.factions = undefined;
  game.talentData = undefined;
  game.areas = undefined;
  game.minimapTiles?.clear();
  game.minimapTiles = undefined;
  game.mapArt?.clear();
  game.mapArt = undefined;
  game.collision = undefined;
  game.worldLoading = false;
  game.renderer?.setCollisionModels(undefined);
  game.renderer?.clearPortraits();
  // And the ground cover with it, for the same reason: the recipes belong to the realm being left,
  // and a meadow still standing while the next world loads is a meadow from the wrong zone.
  game.renderer?.setGroundCover(undefined);
  game.gatewayOrigin = undefined;
  game.soundKits = undefined;
  // Closed rather than dropped: the buffers belong to an `AudioContext`, and a context that is
  // only forgotten keeps its output device open for the life of the tab.
  game.sound?.close();
  game.sound = undefined;
  game.itemMetadata = undefined;
  // Unloaded rather than dropped: `unload` takes the schemas back out of the packet registry, the
  // windows off the screen, the patches out of the built-in windows, the slash commands out of the
  // chat table, the keys out of the bindings window and the `<style>` nodes out of the head. The
  // packet registry belongs to the world client and the next login replaces it anyway; the others
  // do not, and would otherwise outlive the session that loaded them.
  game.modules?.unload();
  game.modules = undefined;
  game.spells.clear();
  game.globalCooldownUntil = 0;
  game.focusGuid = undefined;
  // The wheel's own setting survives a change of world, but how far a wall was letting the camera
  // out in the last one does not: the collision world it was measured against has just been thrown
  // away, and without this the first frame in the new one starts pressed against a vanished wall
  // and then eases out of it over the next half second, in the new zone, for no reason.
  game.camera.view = game.camera.distance;
  game.camera.zoom = game.camera.distance;
  game.camera.wallView = Number.POSITIVE_INFINITY;
  game.camera.terrainView = Number.POSITIVE_INFINITY;
  // Nor does the tilt the floor granted: the floor it was measured against is in the old zone too.
  game.camera.viewPitch = game.camera.pitch;
  // Nor does the body it was hanging off. The renderer that measured the last character's shoulder
  // is going with it, and a tauren's 2.67 carried into the first frames as a gnome would put the
  // orbit centre a yard above that gnome's head until its model arrived.
  game.camera.pivotHeight = CAMERA_DEFAULT_PIVOT_HEIGHT;
  game.camera.eyeHeight = CAMERA_DEFAULT_EYE_HEIGHT;
}
