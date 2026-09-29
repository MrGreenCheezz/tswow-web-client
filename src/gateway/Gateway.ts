import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { connect as connectTcp, type Socket } from "node:net";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { environmentObjectInGrid, parseVMapGlobalSpawn, parseVMapTile, type EnvironmentObject } from "./VMapProtocol.js";
import { loadSpellMetadata } from "./SpellMetadata.js";
import { loadSpellVisualKits, loadSpellVisuals } from "./SpellVisual.js";
import { loadCreatureMetadata } from "./CreatureMetadata.js";
import { encodeVMapModel, parseVMapModel, parseVMapModelGroups, type CollisionGroup } from "./VMapModel.js";
import { loadGameObjectDisplayMetadata } from "./GameObjectMetadata.js";
import { loadTransportPaths } from "./TransportPaths.js";
import { loadLiquidClasses } from "./LiquidMetadata.js";
import { loadLoadingScreens } from "./LoadingScreenMetadata.js";
import { loadGroundEffects } from "./GroundEffects.js";
import { loadCreatureModelMetadata } from "./CreatureModelMetadata.js";
import { CharacterAppearanceIndex } from "./CharacterAppearance.js";
import { loadCharacterTextures, type CharacterTextureIndex } from "./CharacterTextures.js";
import { loadCharacterCreation } from "./CharacterCreation.js";
import { CharStartOutfitIndex } from "./CharStartOutfit.js";
import { loadLockData } from "./LockMetadata.js";
import { loadEmoteData } from "./EmoteMetadata.js";
import { loadFactionData } from "./FactionMetadata.js";
import { loadTalentData } from "./TalentMetadata.js";
import { loadCharacterStatData } from "./CharacterStatMetadata.js";
import { loadLfgDungeonMetadata } from "./LfgDungeonMetadata.js";
import { loadVendorCostMetadata } from "./VendorCostMetadata.js";
import { loadBarberStyles } from "./BarberMetadata.js";
import { loadBarberCosts } from "./BarberCostMetadata.js";
import { loadSlotPrices } from "./SlotPrices.js";
import { loadMacroIcons } from "./MacroIcons.js";
import { CALENDAR_CATALOG_VERSION, loadCalendarCatalog } from "./CalendarCatalog.js";
import { GLYPH_CATALOG_VERSION, loadGlyphCatalog } from "./GlyphCatalog.js";
import { CHAR_TITLES_VERSION, loadCharTitles } from "./CharTitleMetadata.js";
import { serveCatalogRoute, type CatalogCache } from "./CatalogRoutes.js";
import { CURRENCY_CATALOG_VERSION, loadCurrencyCatalog } from "./CurrencyCatalog.js";
import { ACHIEVEMENT_CATALOG_VERSION, loadAchievementCatalog } from "./AchievementMetadata.js";
import { loadReputationMetadata } from "./ReputationMetadata.js";
import { loadAreaData } from "./AreaMetadata.js";
import { loadBattlegroundMetadata } from "./BattlegroundMetadata.js";
import { loadWorldStateUiMetadata } from "./WorldStateUiMetadata.js";
import { loadTaxiMetadata } from "./TaxiMetadata.js";
import { loadDeclinedWords } from "./DeclinedWords.js";
import { COLLISION_TRIANGLE_BUDGET, encodeCollisionModel } from "../world/CollisionFormat.js";
import { GLOBAL_FALLBACK_MAP, loadLightMetadata } from "./LightMetadata.js";
import { loadItemMetadata, loadItemSubclassNames } from "./ItemMetadata.js";
import { loadItemEnchantments } from "./ItemEnchantments.js";
import {
  SoundIndex, WeaponSoundIndex, normaliseSoundPath, type ZoneMusicTracks,
} from "./SoundMetadata.js";
import { DatasetFingerprint } from "./DatasetFingerprint.js";
import {
  PatchStatusTracker, type ClientPatchChange, type PatchStatus, type PatchStatusSummary,
} from "./PatchStatus.js";
import { AUDIO_DBC_FILES, CLIENT_MEDIA_PROFILE_FILE, VISUAL_DBC_FILES } from "./ClientMediaOverlay.js";
import { validAssetPath } from "./AssetPath.js";
import { listeningServerError } from "./ProcessGuard.js";
import { originAllowed, refuseUpgrade, routeUpgrade } from "./UpgradeGuard.js";
import {
  isLoopbackAddress, MAX_MODULE_FILE_BYTES, moduleFileKind, readModuleFile, readModuleIndex,
  validModuleFileName, validModuleName, writeModuleFile, type ModuleRoot,
} from "./ModuleIndex.js";

const MAX_CLIENT_MESSAGE = 64 * 1024;
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
/** How often a bridged socket is pinged; two missed pongs in a row close it. */
const HEARTBEAT_INTERVAL_MS = 30_000;
/** Every upgrade opens a real worldserver socket, so an unbounded gateway exhausts the emulator. */
const MAX_BRIDGED_SOCKETS = 256;
const MAX_BRIDGED_SOCKETS_PER_ADDRESS = 8;

/**
 * WWM2/MONR changes WMO group streams only; keep the much larger M2 cache on its own namespace.
 *
 * visual-wmo-v17 is WWM2, authored MONR normals, and all prior WMO metadata. A v16 artifact parses
 * perfectly and simply has no authored normals, which is indistinguishable from a group that needs
 * the computed fallback — so the cache has to turn over rather than be left to expire.
 * visual-wmo-v22 adds the MOHD render-path bits (classic MapObj rooms, whose MOCV already holds the
 * ambient, 1,823 of 1,985 roots) and the WME4 MODR doodad rooms. A v17 artifact decodes as unified
 * with no rooms — Gundrak lit twice by its ambient — so the name has to turn over; 22 continues the
 * shared sequence past visual-v21.
 * visual-v21 is WVM9 with the G1 scene camera, A1/A2 clip metadata and the optional WVG1 global
 * bone-channel block, and remains independent of this WMO generation, so the two invalidated
 * artifact families keep distinct, monotonic generation numbers. It follows 19 rather than reusing
 * an earlier number for the same reason 16 followed 15: the numbers are one sequence shared by two
 * families, so a reader looking at a name can never be in doubt about which generation of the
 * pipeline wrote it.
 *
 * The A1 bump was the clearest case there has been for why the name and not the bytes decides. The
 * blend time went into a slot the encoder already wrote — a reserved u16 in every clip header —
 * so a v18 artifact and a v19 one are the same length, the same magic and the same layout, and
 * differ only in whether those two bytes are a zero or a number. Zero is also a legal answer in
 * v19 (26 of HumanMale's 241 sequences author one), so nothing in the file can distinguish a
 * pre-A1 artifact from a post-A1 artifact whose sequences carried no blend time. The namespace is
 * the only thing that says which generation wrote it, and it is what makes the old cache go away
 * instead of being read as a client that decided every pose blends on a constant.
 *
 * A2 is the opposite case and still needs the same treatment. Its clip extras table ("WVX1", after
 * the clips) *is* visible in the bytes — a v19 artifact simply ends at its last clip — so a v20
 * reader can tell them apart. What it cannot do is anything useful with the difference: a v19
 * artifact decodes perfectly and has no authored stride speeds, which is indistinguishable from a
 * rig whose sequences all travel at zero, and the mount over it would go on skating for as long as
 * the old entry stayed fresh. The name is what retires it.
 */
export function visualModelCacheNamespace(modelPath: string): "visual-v21" | "visual-wmo-v22" {
  return modelPath.toLowerCase().endsWith(".wmo") ? "visual-wmo-v22" : "visual-v21";
}

/**
 * Appearance textures are replaced together with the visual M2/DBC overlay.
 *
 * These prefixes are the client subtrees the coordinated appearance pipeline reads. The cache no
 * longer gives them a weaker or stronger provenance rule — every texture now requires a stamp —
 * but the classification remains the shared contract used by visual-pack regression tests.
 */
export function isCharacterVisualTexture(path: string): boolean {
  const normalised = path.replaceAll("/", "\\").toLowerCase();
  return [
    "character\\", "creature\\", "item\\objectcomponents\\", "item\\texturecomponents\\",
    "textures\\bakednpctextures\\",
  ].some((prefix) => normalised.startsWith(prefix));
}

/**
 * Routes whose answers have to belong to the client-media profile selected at gateway startup.
 *
 * A TSWoW publish may replace the archive chain while this process is alive. The generators then
 * see the new winners, but `visualDbcDirectory` and `coordinatedVisuals` still describe the pack
 * selected before the port opened. Serving either half after that point can pair an HD model with
 * classic geosets (or the reverse), so these routes fail closed until the process is restarted.
 */
function isClientVisualProfileRoute(method: string | undefined, pathname: string): boolean {
  return method === "GET" && (
    // A late LoD/custom TSAddon file must come from the same winning FrameXML.toc generation that
    // booted the VM.  Otherwise a TSWoW publish can leave the running UI half old and half new.
    pathname === "/client/file"
    || pathname === "/client/addons"
    || pathname === "/texture"
    || pathname === "/visual/model"
    || pathname === "/visual/animations"
    || /^\/visual\/texture\/[0-9a-f]{40}(?:-\d{1,3})?\.png$/.test(pathname)
    || pathname === "/dbc/creature-models"
    || pathname === "/dbc/character-options"
    || pathname === "/dbc/character-appearance"
    // Audio is part of the same extracted client-media generation. The raw file and both DBC
    // answers must not cross from (for example) an HD pack to the classic chain mid-session.
    || pathname === "/sound"
    || pathname === "/dbc/sounds"
    || pathname === "/dbc/emotes"
  );
}

export interface GatewayTarget {
  host: string;
  port: number;
}

export interface GatewayOptions {
  host: string;
  port: number;
  auth: GatewayTarget;
  world: GatewayTarget;
  allowedOrigins: readonly string[];
  mapsDirectory?: string;
  vmapsDirectory?: string;
  dbcDirectory?: string;
  /**
   * Optional client-visual DBC overlay matching an installed model patch. Gameplay tables remain
   * in `dbcDirectory`; only character geosets/textures and creature display/model indirection are
   * read here, so the web renderer and the MPQ assets belong to the same visual generation.
   */
  visualDbcDirectory?: string;
  /** Enables only the geoset corrections authored for the coordinated patch-W/X/Y/Z model set. */
  coordinatedVisuals?: boolean;
  /**
   * Optional client-media audio DBC overlay. This is deliberately separate from gameplay DBCs:
   * only EmotesTextSound is read here, while EmotesText/EmotesTextData stay dataset-owned.
   * Omitting it retains the legacy visual-directory fallback for direct API callers; `null`
   * explicitly disables that fallback after startup selection validates the two categories
   * independently.
   */
  audioDbcDirectory?: string | null;
  /**
   * The 3.3.5a client, i.e. the directory holding `Data`. Nothing here opens an archive — the
   * generators do that in their own processes — but the fingerprint watches the archive files and
   * the loose `patch-*.MPQ` overlays a module's assets are written into.
   */
  clientDirectory?: string;
  /** Root-level Interface/AddOns discovered at startup and offered to the FrameXML boot. */
  clientAddons?: readonly { readonly name: string; readonly loadOnDemand: boolean }[];
  /**
   * `tools/patch-status.mjs --json --no-gateway`, run in a child: the lettered patches, the winning
   * FrameXML.toc's TSAddon blocks, the TSWoW build marker and the native publication. A child
   * because the TOC is read through the MPQ chain, which this process never opens. Absent, the
   * detail half of `/client/patch-status` is null.
   */
  readPatchDetails?: () => Promise<unknown>;
  /**
   * Told each time the archive half of the fingerprint changes — the first time is the 409 latch.
   * `main.ts` forwards it over IPC to the opt-in supervisor (`GATEWAY_RESTART_ON_PATCH=1`).
   */
  onClientPatchChange?: (change: ClientPatchChange) => void;
  /** Reported by `/client/patch-status`: a supervisor restarts this process after a settled build. */
  supervised?: boolean;
  /**
   * Periodic fallback interval for the dataset fingerprint, in milliseconds. Archive writes also
   * invalidate this interval through `fs.watch`, so the next request sees a TSWoW publish without
   * making every texture request pay for the 33.5 ms archive walk. DBC-only edits still use this
   * fallback. Set to 0 by tests that would otherwise have to sleep through it.
   */
  datasetPollMs?: number;
  /**
   * Require every selected client-media DBC to carry a source stamp for this CLIENT_DIR. The
   * automatic extractor enables this; an explicit VISUAL_DBC_DIR remains an operator override.
   */
  requireClientMediaStamps?: boolean;
  creatureMetadataFile?: string;
  itemMetadataFile?: string;
  itemIconsDirectory?: string;
  generateItemIcon?: (displayId: number) => Promise<void>;
  /**
   * Where spell icons are published, keyed on `SpellIcon.id`, and where creature-family icons are,
   * keyed on `CreatureFamily.id`.
   *
   * These two directories are `public/icons` and `public/creature-icons`, which the page is also
   * served out of — `build-assets.bat` fills them and the browser used to ask the page for them
   * directly. They stay exactly where they were, as a warm cache this route reads first; what is
   * new is that a row the bulk pass never saw is extracted on demand instead of showing nothing
   * until an operator remembers to rerun the generator.
   */
  spellIconsDirectory?: string;
  generateSpellIcon?: (iconId: number) => Promise<void>;
  creatureIconsDirectory?: string;
  generateCreatureIcon?: (familyId: number) => Promise<void>;
  /**
   * Gives every published cache entry that carries no stamp one, in a single pass, at startup.
   *
   * Everything under `data/` and the two icon directories in `public/` was published before stamps
   * existed: 23,025 of the 24,796 files on this machine carry no sidecar. `ensureCurrent` used to
   * ask for an entry like that to be rebuilt once so that it gained one — right for a cache that
   * fills a file at a time, and wrong for a whole tree that a bulk pass filled, because every one
   * of those entries is then a generator process on its family's serial lane. Measured for the
   * icons in `ef685e6`: sixteen already-published, already-correct pictures asked for at once took
   * 5,921 ms and sixteen processes, one every 370 ms with nothing overlapping, which puts one
   * directory at twenty minutes of trickle; a texture is 308 ms and a city WMO or a terrain tile
   * is seconds, so the first zone visit after this build would stall for minutes and a module's
   * genuinely new asset would queue behind the backlog.
   *
   * So the unstamped entry is served as it stands and this runs once, in the background, when the
   * gateway starts — never on a request path, and on a lane of its own so that a first request for
   * a genuinely missing asset does not queue behind it. It renders nothing: it re-derives each
   * entry's stamp from the inputs its name names. `tools/restamp.mjs` carries the numbers.
   */
  restampCaches?: () => Promise<void>;
  buildingsDirectory?: string;
  terrainTexturesDirectory?: string;
  terrainLayersDirectory?: string;
  generateTerrainTexture?: (map: number, gridX: number, gridY: number) => Promise<void>;
  generateTerrainSplat?: (map: number, gridX: number, gridY: number) => Promise<void>;
  visualTilesDirectory?: string;
  generateVisualTile?: (map: number, gridX: number, gridY: number) => Promise<void>;
  visualModelsDirectory?: string;
  generateVisualModel?: (path: string, hash: string) => Promise<void>;
  /** Where the extracted `.wdl` files live: one per map, and the whole of the far horizon. */
  horizonDirectory?: string;
  generateHorizon?: (map: number) => Promise<void>;
  /** Where published client textures live, keyed on their path in the archives. */
  texturesDirectory?: string;
  /** Where the animated liquid strips live, one per liquid class. */
  liquidDirectory?: string;
  /**
   * Where the published minimap tile indexes live, one JSON per map.
   *
   * The tiles themselves need no route: they are ordinary client textures, and `/texture` already
   * publishes one by its path in the archives. What the browser cannot work out for itself is
   * *which* texture a grid cell is, because the client stores every bake under an MD5 and only
   * `md5translate.trs` — which lives in the archives this process does not open — says which.
   */
  minimapDirectory?: string;
  generateMinimapIndex?: (map: number) => Promise<void>;
  /** Published 128×128 uint32 continent hit masks, keyed only by Map.dbc id. */
  worldMapZoneMapsDirectory?: string;
  generateWorldMapZoneMap?: (map: number) => Promise<void>;
  generateLiquidTexture?: (liquidClass: string) => Promise<void>;
  generateTexture?: (path: string) => Promise<void>;
  /**
   * Called when the dataset poll finds the client's archives changed — a patch directory gained
   * or lost a file, an archive was replaced, installed or removed. The generators that keep an
   * archive chain open between jobs (`AssetWorker.ts`) reopen it on their next job; a one-shot
   * generator process reads the chain fresh anyway and needs nothing.
   */
  onArchivesChanged?: () => void;
  /**
   * Every path the client archives hold under the character pipeline's texture subtrees.
   *
   * Т7: `ItemDisplayInfo` names a component texture's stem and not its `_M`/`_F`/`_U` spelling, and
   * `CreatureDisplayInfoExtra` names a bake that may not be in the client at all — two questions
   * only the archives answer. This process does not open them (StormLib's heap only grows; the
   * measurement is written down in `tools/check-shadowed-tables.mjs`), so the listing arrives from
   * a child and only its answer stays: 36,027 paths, 2,347 KiB.
   */
  listCharacterTextures?: () => Promise<readonly string[]>;
  /**
   * Where published client sounds live, keyed on their path in the archives.
   *
   * The archives hold 6.1 GB of `.wav` and `.mp3`. This directory must only ever fill with what
   * was actually asked for, which is what keying on the requested path rather than sweeping the
   * table gets: a session plays a few dozen kits.
   */
  soundDirectory?: string;
  generateSound?: (path: string) => Promise<void>;
  /**
   * Where published raw interface files live — Lua, XML, TOC and TTF — keyed on their archive path.
   *
   * The one family in this cache that is not a conversion. Everything else here is a client format
   * turned into something a browser understands; these are handed over as the bytes the game itself
   * executes, because the GlueXML runtime has to run the owner's login screen and not a rendering of
   * it. The narrow extension list is the whole of the guard — see `validClientFilePath`.
   */
  clientFilesDirectory?: string;
  generateClientFile?: (path: string) => Promise<void>;
  /**
   * Where module definitions are read from: every tswow module, then the local drafts directory.
   *
   * Resolved by `tools/paths.mjs`'s `moduleDirectories()`. Absent means the two `/modules` routes
   * are not mounted at all, which is what the tests that do not care about them get.
   */
  moduleDirectories?: readonly ModuleRoot[];
  /**
   * Whether `PUT /modules/<kind>/<mod>/<file>` may write, and even then only from this machine.
   *
   * Off unless `MODULE_UI_WRITE=1`. The gateway is an unauthenticated pipe by design (the start-up
   * warning in `GatewayConfiguration.ts` says so when it listens beyond loopback and accepts any
   * Origin), so the one route that touches the disk is the one route that has to be asked for.
   */
  moduleWrite?: boolean;
  /**
   * Where the peer's address comes from, for the one route that writes to disk.
   *
   * The client never passes it: {@link socketPeerAddress} reads the socket, which is the whole
   * point of the check — a header is written by whoever is asking, and a socket's address is not.
   * It is injectable because the *refusal* could not otherwise be driven by a test: a gateway bound
   * to 127.0.0.1 has no peer that is not loopback, and binding one to a network interface to prove
   * a refusal means a listening socket on somebody's network for the length of a test run. With
   * this seam the 405 is driven through the real route, and the default is witnessed by the 204
   * beside it, which only happens because the socket really does say 127.0.0.1.
   */
  /**
   * Optional proof that this loopback resource helper belongs to the launching native client.
   * It is intentionally absent for ordinary gateway runs, which retain the token-free health body.
   */
  localAssetNonce?: string;
  peerAddress?: (request: IncomingMessage) => string | undefined;
}

/**
 * The address the socket itself reports. The only thing the write route trusts.
 *
 * Exported so the claim can be asserted rather than read: `X-Forwarded-For` and `Host` are written
 * by whoever is asking, and a guard that read one of those would be no guard at all.
 */
export function socketPeerAddress(request: IncomingMessage): string | undefined {
  return request.socket.remoteAddress;
}

export interface RunningGateway {
  host: string;
  port: number;
  close(): Promise<void>;
  /** The patch generation this process serves, and whether a TSWoW build has moved past it. */
  patchSummary(): PatchStatusSummary;
  /** The summary plus the `readPatchDetails` child's report (memoised per fingerprint epoch). */
  patchStatus(): Promise<PatchStatus>;
  /**
   * One fingerprint poll outside any request, so an idle supervised gateway still latches a
   * publish. Interval-limited like a request's poll; `patchEventsPending` says when it is worth it.
   */
  checkPatchChain(): Promise<PatchStatusSummary>;
  readonly patchEventsPending: boolean;
  /** Bridged sockets now. The supervisor restarts the process only when both are zero. */
  connections(): { auth: number; world: number };
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

/** A browser same-origin GET omits Origin; Fetch Metadata still distinguishes it from cross-site. */
function sameOriginBrowserGet(request: IncomingMessage): boolean {
  return request.headers.origin === undefined
    && request.headers["sec-fetch-site"] === "same-origin";
}

/** How long a failed generation is remembered before the generator is given another chance. */
const GENERATION_FAILURE_TTL_MS = 5 * 60_000;
/**
 * How long a failure that was *not* "the archives do not hold this" is remembered.
 *
 * A missing source stays missing for the five minutes above. A run that died — a crashed child, a
 * worker recycled under it, a rename a virus scanner held up — is this minute's problem, and the
 * browser answers it with Т6's retry ladder at 2 s, 8 s and 30 s. With the five-minute memory every
 * one of those retries was refused with the same 500, so one transient failure left the texture or
 * the building missing for the rest of the session (measured: the ladder gives up after ~40 s).
 * Long enough to fold the burst of requests that arrive together into the one refusal, short
 * enough that the first retry runs the generator again.
 */
const GENERATION_RETRY_TTL_MS = 1_500;
/** Beyond this the expired half of the failure map is swept; it only ever holds broken keys. */
const GENERATION_FAILURE_LIMIT = 4096;

/**
 * The exit code a generator uses for "the archives do not hold this source".
 *
 * Every other way of failing — a child that crashed, a decoder that threw, a lane that refused —
 * is a fact about this minute rather than about the file, and the two have to leave this process
 * as different status codes. Т6 taught the browser to retry a 5xx on a backoff and to take a 404
 * as final; until this existed **every** way for `/texture` to fail answered 404, so a generator
 * child that died removed that layer — or, for a baked NPC whose only layer it was, the whole
 * unit — for the life of the tab, which is the very failure Т6 was written to end. Т7 sharpened
 * it: the first spelling the gateway offers is now one its own listing says is in the archives, so
 * a 404 on it is *more* likely to be a dead child than a missing file.
 *
 * Mirrored in `tools/generate-texture.mjs`, which is the end that chooses it; `npm test` pins the
 * two together, because a silent disagreement here reads to the browser as "no such file".
 */
export const SOURCE_MISSING_EXIT = 3;

/**
 * Whether a generator's rejection means the source is not in the client.
 *
 * The channel is the child's exit code, carried onto the rejection by whoever spawned it. The
 * message cannot be the channel: a child that crashes has no message at all, and one that throws
 * has whatever it last wrote to stderr.
 */
export function sourceMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && (error as { exitCode?: unknown }).exitCode === SOURCE_MISSING_EXIT;
}

/**
 * One family of generated assets: a serial lane so generators do not fight over the MPQ archives,
 * a per-key in-flight map so concurrent requests share one run, and a short-lived record of
 * failures.
 *
 * The lane runs one job at a time, highest priority first and in arrival order within a priority.
 * It used to be a plain promise chain, strictly first come first served, and the texture lane
 * carries everything from a unit's skin to the minimap's tiles: measured on the owner's session of
 * 2026-09-28, 241 baked NPC skins went through it behind 80 minimap tiles, 33 icons and 21 world-map
 * tiles, and every one of those NPCs stood as a capsule until its skin was published.
 */
interface GenerationLane {
  running: boolean;
  sequence: number;
  readonly waiting: { priority: number; sequence: number; start(): void }[];
  readonly jobs: Map<string, Promise<void>>;
  // Why it failed, and not only until when: a missing source is remembered for five minutes, and a
  // route that answered 404 for it has to go on answering 404 for the whole of that.
  // Otherwise the first request tells the browser the truth and the next one tells it to come back.
  readonly failures: Map<string, { until: number; missing: boolean }>;
}

function generationLane(): GenerationLane {
  return { running: false, sequence: 0, waiting: [], jobs: new Map(), failures: new Map() };
}

/** Starts the lane's best waiting job if nothing is running. */
function pumpLane(lane: GenerationLane): void {
  if (lane.running || lane.waiting.length === 0) return;
  let best = 0;
  for (let index = 1; index < lane.waiting.length; index++) {
    const candidate = lane.waiting[index]!;
    const chosen = lane.waiting[best]!;
    if (candidate.priority > chosen.priority
      || (candidate.priority === chosen.priority && candidate.sequence < chosen.sequence)) best = index;
  }
  const [next] = lane.waiting.splice(best, 1);
  lane.running = true;
  next!.start();
}

/** Queues `run` on the lane; the promise settles with it. */
function laneRun(lane: GenerationLane, run: () => Promise<void>, priority: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    lane.waiting.push({
      priority,
      sequence: lane.sequence++,
      start: () => {
        void Promise.resolve()
          .then(run)
          .then(resolve, reject)
          .finally(() => {
            lane.running = false;
            pumpLane(lane);
          });
      },
    });
    pumpLane(lane);
  });
}

/**
 * How urgently a `/texture` path is wanted, for its lane.
 *
 * 2 — what makes a unit appear: character and item component layers, creature skins and the baked
 *     NPC faces; until they are published the unit is a capsule (`CharacterAtlas` waits for its
 *     layers).
 * 0 — interface art that is drawn in a corner or a window: minimap tiles, world-map art, icons.
 * 1 — everything else, the world's own model textures.
 */
export function texturePriority(path: string): number {
  const lower = path.replaceAll("/", "\\").toLowerCase();
  if (lower.startsWith("character\\") || lower.startsWith("item\\") || lower.startsWith("creature\\")
    || lower.startsWith("textures\\bakednpctextures\\")) return 2;
  if (lower.startsWith("textures\\minimap\\") || lower.startsWith("interface\\")) return 0;
  return 1;
}

/**
 * Runs the generator for one key at most once at a time, on the family's lane.
 *
 * Nothing writes a negative result to disk, so without the failure memory an asset the client
 * simply does not ship — or one the generator cannot parse — re-enters the lane on every request
 * from every player and starves the assets that would have succeeded. The TTL is there so a
 * generator fixed at runtime, or a dependency that came back, heals without a restart.
 */
async function generateOnce(
  lane: GenerationLane, key: string, run: () => Promise<void>, priority = 1,
): Promise<void> {
  const remembered = lane.failures.get(key);
  if (remembered && remembered.until > Date.now()) {
    // Refused, but refused with the same news the run itself gave. A source the client does not
    // hold does not start being held inside the five minutes, and the route above turns this into
    // the 404 it turned the original rejection into rather than into "try again".
    const refusal = new Error(`Generating ${key} failed recently`);
    if (remembered.missing) (refusal as Error & { exitCode?: number }).exitCode = SOURCE_MISSING_EXIT;
    throw refusal;
  }
  lane.failures.delete(key);
  let job = lane.jobs.get(key);
  if (!job) {
    const generation = laneRun(lane, run, priority);
    job = generation.finally(() => lane.jobs.delete(key));
    lane.jobs.set(key, job);
  }
  try {
    await job;
  } catch (error) {
    if (lane.failures.size >= GENERATION_FAILURE_LIMIT) {
      const now = Date.now();
      for (const [failed, failure] of lane.failures) if (failure.until <= now) lane.failures.delete(failed);
    }
    const missing = sourceMissing(error);
    lane.failures.set(key, {
      until: Date.now() + (missing ? GENERATION_FAILURE_TTL_MS : GENERATION_RETRY_TTL_MS),
      missing,
    });
    throw error;
  }
}

/** The lane key the whole published cache is stamped under: one pass, however it is started. */
const RESTAMP_KEY = "restamp";

/**
 * Whether this key's last run failed recently enough that `generateOnce` will refuse to run it.
 *
 * A caller that swallows the rejection needs to know which of the two it swallowed: the generator
 * having just run and failed, which is worth a line in the log, or the memory of a failure it
 * already reported, which is not — that one arrives once per request for the whole TTL.
 */
function recentlyFailed(lane: GenerationLane, key: string): boolean {
  const failure = lane.failures.get(key);
  return failure !== undefined && failure.until > Date.now();
}

function peerAddress(request: IncomingMessage): string {
  return request.socket.remoteAddress ?? "unknown";
}

function bridge(webSocket: WebSocket, target: GatewayTarget): Socket {
  const tcp = connectTcp(target);
  // A WoW session is a stream of small packets, so Nagle plus the peer's delayed ACK can add up
  // to ~40 ms to each one — the largest latency win available for one line.
  tcp.setNoDelay(true);
  let failed = false;

  const fail = (reason: string) => {
    if (failed) return;
    failed = true;
    clearInterval(heartbeat);
    tcp.destroy();
    if (webSocket.readyState === WebSocket.OPEN) webSocket.close(1011, reason);
  };

  // `ws` does not ping on its own, so an idle NAT or load balancer drops the world session with
  // no error on either side and the player only finds out when they try to move.
  let alive = true;
  webSocket.on("pong", () => { alive = true; });
  const heartbeat = setInterval(() => {
    if (!alive) {
      fail("Client stopped responding");
      return;
    }
    alive = false;
    if (webSocket.readyState === WebSocket.OPEN) webSocket.ping();
  }, HEARTBEAT_INTERVAL_MS);

  webSocket.on("message", (data, isBinary) => {
    if (!isBinary) {
      webSocket.close(1003, "Binary messages only");
      return;
    }

    const payload = rawDataToBuffer(data);
    if (payload.byteLength > MAX_CLIENT_MESSAGE) {
      webSocket.close(1009, "Message too large");
      return;
    }
    if (tcp.destroyed) {
      fail("Backend unavailable");
      return;
    }

    tcp.write(payload);
    if (tcp.writableLength > MAX_BUFFERED_BYTES) fail("Backend is too slow");
  });

  tcp.on("data", (data) => {
    if (webSocket.readyState !== WebSocket.OPEN) return;
    if (webSocket.bufferedAmount > MAX_BUFFERED_BYTES) {
      fail("Client is too slow");
      return;
    }
    webSocket.send(data, { binary: true });
  });
  tcp.on("error", () => fail("Backend connection failed"));
  tcp.on("close", () => {
    if (!failed && webSocket.readyState === WebSocket.OPEN) webSocket.close(1000);
  });
  webSocket.on("close", () => { clearInterval(heartbeat); tcp.destroy(); });
  webSocket.on("error", () => { clearInterval(heartbeat); tcp.destroy(); });

  return tcp;
}

/**
 * Every index the gateway memoises for the life of the process, in one object.
 *
 * These were sixteen `let`s filled with `??=` at eighteen sites and cleared by nothing, which is
 * what made a rebuilt dataset invisible until somebody restarted the process: a module could add a
 * spell, an icon or a race and the client would go on being served the tables that were on disk
 * when the gateway started. Gathered here so that forgetting them is one call rather than sixteen
 * lines, and so that a route added beside these does not have to know about invalidation at all.
 */
class DatasetIndexes {
  spellMetadata: ReturnType<typeof loadSpellMetadata> | undefined = undefined;
  spellVisuals: ReturnType<typeof loadSpellVisuals> | undefined = undefined;
  spellVisualKits: ReturnType<typeof loadSpellVisualKits> | undefined = undefined;
  creatureMetadata: ReturnType<typeof loadCreatureMetadata> | undefined = undefined;
  gameObjectMetadata: ReturnType<typeof loadGameObjectDisplayMetadata> | undefined = undefined;
  transportPaths: ReturnType<typeof loadTransportPaths> | undefined = undefined;
  liquidClasses: ReturnType<typeof loadLiquidClasses> | undefined = undefined;
  loadingScreens: ReturnType<typeof loadLoadingScreens> | undefined = undefined;
  groundEffects: ReturnType<typeof loadGroundEffects> | undefined = undefined;
  creatureModelMetadata: ReturnType<typeof loadCreatureModelMetadata> | undefined = undefined;
  characterAppearance: ReturnType<typeof CharacterAppearanceIndex.load> | undefined = undefined;
  characterCreation: ReturnType<typeof loadCharacterCreation> | undefined = undefined;
  charStartOutfit: ReturnType<typeof CharStartOutfitIndex.load> | undefined = undefined;
  itemMetadata: ReturnType<typeof loadItemMetadata> | undefined = undefined;
  itemSubclassNames: ReturnType<typeof loadItemSubclassNames> | undefined = undefined;
  itemEnchantments: ReturnType<typeof loadItemEnchantments> | undefined = undefined;
  lockData: ReturnType<typeof loadLockData> | undefined = undefined;
  factionData: ReturnType<typeof loadFactionData> | undefined = undefined;
  emoteData: ReturnType<typeof loadEmoteData> | undefined = undefined;
  talentData: ReturnType<typeof loadTalentData> | undefined = undefined;
  characterStatData: ReturnType<typeof loadCharacterStatData> | undefined = undefined;
  lfgDungeonMetadata: ReturnType<typeof loadLfgDungeonMetadata> | undefined = undefined;
  vendorCostMetadata: ReturnType<typeof loadVendorCostMetadata> | undefined = undefined;
  barberStyles: ReturnType<typeof loadBarberStyles> | undefined = undefined;
  barberCosts: ReturnType<typeof loadBarberCosts> | undefined = undefined;
  slotPrices: ReturnType<typeof loadSlotPrices> | undefined = undefined;
  macroIcons: ReturnType<typeof loadMacroIcons> | undefined = undefined;
  /** The stock calendar's holidays, icon picker rows and raid names (CalendarCatalog.ts), serialized once. */
  calendarCatalog: Promise<string> | undefined = undefined;
  /** The stock glyph tab's glyph, socket and glyph-item rows (GlyphCatalog.ts), serialized once. */
  glyphCatalog: Promise<string> | undefined = undefined;
  /** The stock title picker's CharTitles rows (CharTitleMetadata.ts), serialized once. */
  charTitles: Promise<string> | undefined = undefined;
  /** The stock currency tab's CurrencyTypes/CurrencyCategory rows (CurrencyCatalog.ts), serialized once. */
  currencyCatalog: Promise<string> | undefined = undefined;
  /** Every CatalogRoutes.ts answer, serialized once and keyed by pathname; `reset()` forgets the map. */
  catalogs: CatalogCache | undefined = undefined;
  /** The serialized body and its validator, not the rows: the JSON is built once per dataset, not per request. */
  achievementCatalog: Promise<{ readonly body: string; readonly etag: string }> | undefined = undefined;
  reputationMetadata: ReturnType<typeof loadReputationMetadata> | undefined = undefined;
  areaData: ReturnType<typeof loadAreaData> | undefined = undefined;
  battlegroundMetadata: ReturnType<typeof loadBattlegroundMetadata> | undefined = undefined;
  worldStateUiMetadata: ReturnType<typeof loadWorldStateUiMetadata> | undefined = undefined;
  taxiMetadata: ReturnType<typeof loadTaxiMetadata> | undefined = undefined;
  /** The two DeclinedWord tables packed and gzipped once (DeclinedWords.ts). */
  declinedWords: ReturnType<typeof loadDeclinedWords> | undefined = undefined;
  lightIndex: ReturnType<typeof loadLightMetadata> | undefined = undefined;
  soundIndex: ReturnType<typeof SoundIndex.load> | undefined = undefined;
  /**
   * Its own entry rather than a part of `soundIndex`, because of `Item.dbc`: 46,098 rows that only
   * a combat sound needs, and a request about a creature's scream should not pay to open them.
   */
  weaponSounds: ReturnType<typeof WeaponSoundIndex.load> | undefined = undefined;
  /**
   * The only one of these read out of the archives rather than the dataset, and the only one with
   * a second way of going stale — see `forgetArchives`.
   */
  characterTextures: ReturnType<typeof loadCharacterTextures> | undefined = undefined;

  /** Forgets all of them; the next request that needs one reads the dataset from disk again. */
  reset(): void {
    const fields = this as unknown as Record<string, undefined>;
    for (const field of Object.keys(fields)) fields[field] = undefined;
  }

  /**
   * Forgets what a change to the archives makes stale, which is not the same set.
   *
   * A DBC build and an archive change are two different events — `DatasetFingerprint` reports them
   * separately — and until Т7 nothing here was built out of an archive, so `reset()` covered
   * everything. The listing is; and so, by containment, are the two indexes that fold it in, since
   * an appearance carries the spellings it chose. The other fifteen are untouched: a patch archive
   * appearing has nothing to say about `SoundEntries`.
   */
  forgetArchives(): void {
    this.characterTextures = undefined;
    this.characterAppearance = undefined;
    this.creatureModelMetadata = undefined;
  }
}

export interface GatewayAssetHandler {
  handle(request: IncomingMessage, response: ServerResponse): void;
  close(): void;
  /** See {@link RunningGateway}. */
  patchSummary(): PatchStatusSummary;
  patchStatus(): Promise<PatchStatus>;
  checkPatchChain(): Promise<PatchStatusSummary>;
  readonly patchEventsPending: boolean;
}

/** Shared resource implementation. Creating it opens no listening or gameplay sockets. */
export async function createGatewayAssetHandler(options: GatewayOptions): Promise<GatewayAssetHandler> {
  const localAssetNonce = options.localAssetNonce;
  if (localAssetNonce !== undefined && !/^[0-9a-f]{64}$/.test(localAssetNonce)) {
    throw new Error("localAssetNonce must be 64 lowercase hexadecimal characters.");
  }
  const indexes = new DatasetIndexes();
  const audioDbcDirectory = options.audioDbcDirectory === null
    ? undefined : options.audioDbcDirectory ?? options.visualDbcDirectory;
  const visualDbcFiles = options.visualDbcDirectory === undefined ? []
    : VISUAL_DBC_FILES.map((file) => join(options.visualDbcDirectory!, file));
  const clientMediaProfileFiles = options.visualDbcDirectory === undefined ? []
    : [join(options.visualDbcDirectory, CLIENT_MEDIA_PROFILE_FILE)];
  const audioDbcFiles = audioDbcDirectory === undefined ? []
    : AUDIO_DBC_FILES.map((file) => join(audioDbcDirectory, file));
  // Nothing on the network asks for a reload; the dataset is watched instead. `DatasetFingerprint`
  // carries the reason a route would be the wrong shape on a port with no authentication.
  const fingerprint = new DatasetFingerprint({
    dbcDirectory: options.dbcDirectory,
    dbcFiles: [...new Set([options.creatureMetadataFile, options.itemMetadataFile]
      .filter((file): file is string => file !== undefined)
      .concat(visualDbcFiles, audioDbcFiles))],
    clientDirectory: options.clientDirectory,
    intervalMs: options.datasetPollMs,
    watchArchives: true,
  });
  // Establish the archive baseline now, while startup's visual DBC/profile selection is still the
  // active one. Leaving the first snapshot to the first HTTP request creates a gap in which a
  // publish can finish after selection but before the watcher has anything to compare against.
  if (fingerprint.watching) await fingerprint.poll({ force: true });
  if (options.requireClientMediaStamps) {
    const current = await Promise.all([...visualDbcFiles, ...audioDbcFiles, ...clientMediaProfileFiles]
      .map((file) => fingerprint.isCurrent(file, { requireStamp: true })));
    if (current.some((value) => !value)) {
      fingerprint.close();
      throw new Error(
        "The selected client-media DBCs no longer match the active client patch chain. "
        + "Restart the gateway so startup can extract one complete generation.",
      );
    }
    // Selection happened before this DatasetFingerprint existed. A second forced snapshot closes
    // the remaining startup window; unlike request-time polling, paying one extra walk here has no
    // steady-state cost.
    const startupChange = await fingerprint.poll({ force: true });
    if (startupChange.archives) {
      fingerprint.close();
      throw new Error(
        "The client patch chain changed while the gateway was starting. Restart the gateway to "
        + "extract and select one complete client-media generation.",
      );
    }
  }
  let clientVisualProfileChanged = false;
  // The generation is taken from the baseline walk above, i.e. the chain the startup profile was
  // selected against — the same instant the latch below measures "changed" from.
  const patches = new PatchStatusTracker({
    archivesHash: fingerprint.archivesHash,
    chain: fingerprint.chain,
    addons: options.clientAddons ?? [],
    supervised: options.supervised ?? false,
    ...(options.readPatchDetails ? { readDetails: options.readPatchDetails } : {}),
    ...(options.onClientPatchChange ? { onChange: options.onClientPatchChange } : {}),
  });
  /**
   * The archives' listing, started at most once and shared by the two indexes that want it.
   *
   * Deliberately not awaited here: the callers hand the promise straight to a loader that already
   * waits on a `Promise.all` of DBC reads, so the child runs beside them instead of before them.
   * Returning the promise rather than the value is also what keeps the `??=` below synchronous —
   * an `await` between the test and the assignment is how two requests start two loads.
   */
  const characterTextures = (): Promise<CharacterTextureIndex | undefined> =>
    (indexes.characterTextures ??= loadCharacterTextures(options.listCharacterTextures));
  const environmentModels = new Map<string, Promise<Uint8Array>>();
  const collisionModels = new Map<string, Promise<CollisionGroup[]>>();
  const terrainTextureLane = generationLane();
  const itemIconLane = generationLane();
  // Spell icons and creature-family icons share one lane and one generator process. A lane is a
  // promise of at most one child at a time, so a second one here would mean a third generator on
  // the archives beside the item icons for two routes that ask the same script for the same kind
  // of picture. The keys are prefixed because both count from 1.
  const spellIconLane = generationLane();
  const visualTileLane = generationLane();
  const horizonLane = generationLane();
  const visualModelLane = generationLane();
  const textureLane = generationLane();
  const soundLane = generationLane();
  // Its own lane rather than a share of the texture one: a glue screen asks for its `.toc`, then
  // every `.lua` and `.xml` that names, and those requests are a burst at the very start of a
  // session — exactly when the terrain and character caches are cold too. On the texture lane the
  // whole interface would queue behind whichever building is being published.
  const clientFileLane = generationLane();
  const liquidLane = generationLane();
  const minimapLane = generationLane();
  const worldMapZoneMapLane = generationLane();
  // Its own lane, and not one of the eleven above: the pass reads every family, and putting it on
  // any of them would make the first genuinely missing asset of that family queue behind the whole
  // of it — which is the stall this slice exists to remove.
  const restampLane = generationLane();
  // One poll and what it makes stale. A request runs it first; so does the supervised gateway's
  // idle timer (`checkPatchChain`), which is how a publish is latched with no page open.
  const observeDataset = async (): Promise<void> => {
    const changed = await fingerprint.poll();
    if (changed.dbc) indexes.reset();
    if (changed.archives) {
      // The startup-selected visual DBC directory and coordinated-model policy cannot be
      // switched safely under already loaded browser assets. Latch this for the rest of the
      // process even if the files are changed back: only a restart establishes one new atomic
      // archive/profile generation.
      clientVisualProfileChanged = true;
      patches.noteArchivesChanged(changed.epoch);
      // Not because these two are read out of the archives — they are the vmap extractor's own
      // files — but because the only thing that rewrites a patch directory is a dataset build,
      // and a dataset build is what rewrites the vmaps beside it. Watching the vmaps themselves
      // would cost 469.3 ms a poll for 15,087 files.
      environmentModels.clear();
      collisionModels.clear();
      // And the one index that is read out of the archives, plus the two that fold it in. A
      // module dropping a component texture into a patch directory changes which spelling of it
      // exists, and that is the whole of the answer this listing gives.
      indexes.forgetArchives();
      // A generator holding the old chain open would go on publishing out of it.
      options.onArchivesChanged?.();
    }
  };
  const handle = (request: IncomingMessage, response: ServerResponse): void => void (async () => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(localAssetNonce === undefined
        ? '{"status":"ok"}'
        : JSON.stringify({ status: "ok", localAssetNonce }));
      return;
    }

    // Before anything is answered out of memory: if the dataset has moved since the last request,
    // forget what it made stale. `/health` is answered above this line, so a liveness probe never
    // pays for the walk, and between polls this costs one clock read.
    if (fingerprint.watching) await observeDataset();

    const url = new URL(request.url ?? "/", "http://gateway.local");
    const pathname = url.pathname;

    // Deliberately outside `isClientVisualProfileRoute`: this is how the latch is reported, so it
    // keeps answering after it. Read-only (nothing on the network may reload anything) and
    // origin-checked like `/client/addons`. `?summary=1` skips the child — the banner polls that.
    if (request.method === "GET" && pathname === "/client/patch-status") {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      const body = url.searchParams.get("summary") === "1"
        ? patches.summary() : await patches.details(fingerprint.epoch);
      response.writeHead(200, {
        "access-control-allow-origin": origin,
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify(body));
      return;
    }

    if (clientVisualProfileChanged && isClientVisualProfileRoute(request.method, pathname)) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)
        && !(pathname === "/texture" && sameOriginBrowserGet(request))) {
        response.writeHead(403).end();
        return;
      }
      respondClientVisualProfileChanged(response, origin);
      return;
    }

    if (request.method === "GET" && pathname === "/client/addons") {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      response.writeHead(200, {
        "access-control-allow-origin": origin!,
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify({ addons: options.clientAddons ?? [] }));
      return;
    }

    // One client texture, addressed by its path in the archives. Keying on the path rather than
    // on the model that asked for it means a BLP used by fifty models is one file, one URL and
    // one GPU texture; the published cache used to hold 1,092 files for 646 distinct images.
    if (request.method === "GET" && pathname === "/texture" && options.texturesDirectory) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins) && !sameOriginBrowserGet(request)) {
        response.writeHead(403).end();
        return;
      }
      const texturePath = (url.searchParams.get("path") ?? "").replaceAll("/", "\\");
      if (!validTexturePath(texturePath)) {
        respondError(response, 400, origin);
        return;
      }
      const id = createHash("sha1").update(`texture-v1\0${texturePath.toLowerCase()}`).digest("hex");
      const filename = join(options.texturesDirectory, `${id}.png`);
      try {
        // One thunk for both ways a route needs the generator — the file is not there at all, or
        // it is there and the stamp check has something to say about it — on the same lane under
        // the same key, so a miss and a rebuild that meet on one file collapse into a single run.
        const rebuild = () => generateOnce(
          textureLane, id, () => options.generateTexture!(texturePath), texturePriority(texturePath));
        // A cache entry keyed on a path is not keyed on what that path held when it was
        // written, so its stamp is checked against the dataset as it is now before it is
        // served; a stale one is dropped here and the miss below rebuilds that one entry.
        // An unstamped legacy entry cannot prove which patch chain produced its bytes. The request
        // already carries the original archive path, so this route can safely regenerate that one
        // entry instead of blessing an old PNG with the active chain's stamp.
        if (options.generateTexture) {
          await fingerprint.ensureCurrent(filename, { requireStamp: true });
        }
        let data: Buffer;
        try {
          data = await readFile(filename);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !options.generateTexture) throw error;
          await rebuild();
          data = await readFile(filename);
        }
        // Every texture URL is path-stable, including scenery: a TSWoW module may replace any BLP
        // without changing the path. Conditional revalidation keeps unchanged reloads at 304 while
        // allowing the newly generated bytes to replace the browser's cached response immediately.
        respondRevalidated(request, response, data, origin, "image/png");
      } catch (error) {
        // The two ways this route fails are not the same news, and answering 404 for both is what
        // left a character without his legs for the life of the tab: the browser takes a 404 as
        // "this file is not in the client" and never asks again, so a generator child that died —
        // or a lane still refusing that key — retired the layer permanently. `SOURCE_MISSING_EXIT`
        // is how the generator says which it was; everything else is a 500, which the browser
        // retries on Т6's 2 s / 8 s / 30 s backoff. With no generator wired up at all, a file that
        // is not on disk is simply not there and nothing is going to make it, so that stays a 404.
        const absent = sourceMissing(error)
          || (!options.generateTexture && (error as NodeJS.ErrnoException).code === "ENOENT");
        respondError(response, absent ? 404 : 500, origin);
      }
      return;
    }

    // The model and its held-back animations are one artifact in two files, so they share a key
    // and a generator: whichever is asked for first builds both.
    const visualModel = pathname === "/visual/model";
    if (request.method === "GET" && (visualModel || pathname === "/visual/animations") && options.visualModelsDirectory) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      const modelPath = (url.searchParams.get("path") ?? "").replaceAll("/", "\\");
      if (!validVisualModelPath(modelPath)) {
        respondError(response, 400, origin);
        return;
      }
      // v6 keys on the model path alone. Up to v5 the resolved texture list was part of the key,
      // so one HumanMale.m2 became one artifact per skin and hair combination — 24,263 creature
      // displays over 1,105 distinct models produced 17,217 keys, and geoset selection would have
      // multiplied that again. The model no longer knows about appearance; the browser resolves
      // slots against /texture and picks geosets itself.
      //
      // v8 is where a WMO started carrying the triangles its MOBA batches actually draw and the
      // MOMT state each run is drawn with. A v7 artifact holds neither, so it has to be rebuilt.
      //
      // v9 is WVM6: every animation the model has is listed, the external .anim files are read at
      // last, and the poses that are not locomotion move into the `.anim.bin` beside it.
      //
      // v12 is WWM1: a WMO is published as its groups, and a model over the triangle budget writes
      // one file per group beside a header that lists every group's box. `group` asks for one of
      // them. Publishing them at build time rather than slicing here is deliberate — the gateway
      // has no WMO parser and answering a fetch is not the place to grow one.
      //
      // v13 was WVM8: the `M2Color` and `M2TextureWeight` tables a batch's indices point at, and the
      // type-0 `M2Camera`. Both are additions to the same `.bin` from the same generator, so they
      // ride one key: taken apart, the owner would pay the cold rebuild of the whole cache twice.
      //
      // visual-wmo-v14 adds WME2's small MOPV/MOPT/MOPR portal graph. It is deliberately a WMO-only
      // namespace: no M2 byte changed, so invalidating every creature, spell and doodad would buy
      // nothing. Header and `.gNNN` requests use this same hash.
      //
       // visual-wmo-v17 adds the WWM2 envelope and authored MONR normals. The WMO namespace turns
       // over as one family so whole/header/group requests share the same source identity, while
      // visual-v21 stays the M2/WVM9 namespace.
      // visual-v16 was WVM9: `M2TextureTransform`, so a batch that names one can move its UVs.
      //
      // visual-v18 was the same WVM9 with the G1 camera flag: `cameras[0]` of a model that carries no
      // type-0 record travels as a scene camera under flag 0x04, which is what the 13 camera-
      // bearing glue models under `Interface\Glues\Models\` need and what none of them had. Measured
      // over the 1,114 distinct `CreatureModelData` models this client holds, not one artifact
      // changes a byte — 930 have a portrait and keep it, and the other 184 have no camera block to
      // read. The namespace still turned over, because the flag is a body-layout fact: a v16 artifact
      // is indistinguishable from a v18 one that simply has no camera, and a cache that cannot say
      // which generation wrote it is a cache that will one day be read as the wrong one.
      //
      // visual-v19 (slice A1) puts `M2Sequence.blendTime` in the reserved u16 of every clip header,
      // in the model's skeleton block and in the `.anim` sidecar alike, so a pose is entered over
      // the window its own file authored instead of one of two constants. Same argument as above,
      // sharper: the bytes were already being written as zero, so nothing but the name separates
      // the two generations. The sidecar shares this namespace by construction — it is the same
      // hash with an `.anim` suffix — so the model and the clips held back from it can never be
      // read out of two different generations.
      //
      // visual-v20 (slice A2) appends the optional "WVX1" clip extras table after the clips of both
      // containers: `M2Sequence.movingSpeed`, so a mount's stride is replayed at the speed the unit
      // is really travelling instead of the one its author built it for, plus the two variation
      // indices a fidget chain will need. Unlike A1 the difference is visible in the file — a v19
      // artifact ends at its last clip — but a v19 artifact is also a perfectly valid decode with
      // no stride speeds in it, so a stale entry means a mount that goes on skating. Hence the name.
      //
      // visual-v21 appends WVG1 after the skeleton clips. It carries bones driven exclusively by
      // M2 global sequences — notably Holy Light's hand ribbons — so a v20 artifact is valid but
      // visibly static and must not remain addressable under the new renderer.
      const group = url.searchParams.get("group");
      if (group !== null && (!visualModel || !/^\d{1,3}$/.test(group))) {
        respondError(response, 400, origin);
        return;
      }
      const namespace = visualModelCacheNamespace(modelPath);
      const hash = createHash("sha1").update(`${namespace}\0${modelPath.toLowerCase()}`).digest("hex");
      const suffix = group !== null ? `.g${group.padStart(3, "0")}` : visualModel ? "" : ".anim";
      const filename = join(options.visualModelsDirectory, `${hash}${suffix}.bin`);
      try {
        const rebuild = () => generateOnce(visualModelLane, hash, () => options.generateVisualModel!(modelPath, hash));
        // A visual-model filename hashes the route generation and MPQ path, not the source bytes.
        // The background restamper cannot recover that path from the hash, so an unstamped cache
        // made before a coordinated HD pack was installed must be regenerated on its first request.
        if (options.generateVisualModel) await fingerprint.ensureCurrent(filename, { requireStamp: true });
        let data: Buffer;
        try {
          data = await readFile(filename);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !options.generateVisualModel) throw error;
          await rebuild();
          data = await readFile(filename);
        }
        respondRevalidated(request, response, data, origin, "application/octet-stream");
      } catch (error) {
        // The twin of the split `/texture` was given in Т6, and the one this route was left
        // without. Every way of failing here answered 404 — a generator child that died, a decoder
        // that threw, a stale-stamp unlink that could not run, and «the client does not ship this
        // model» alike — and `EnvironmentClient` reads a 404 as final and never asks again. One
        // transient failure therefore left a building missing for the life of the tab, and until
        // this same slice took the box away it left a 1,270 × 1,406 × 269-yard grey cube standing
        // over Orgrimmar instead. `SOURCE_MISSING_EXIT` out of `generate-visual-model.mjs` is how
        // the generator says which it was; everything else is a 500 the browser retries on the
        // 2 s / 8 s / 30 s ladder. With no generator wired up, a file that is not on disk is not
        // going to appear, and that stays a 404.
        const absent = sourceMissing(error)
          || (!options.generateVisualModel && (error as NodeJS.ErrnoException).code === "ENOENT");
        respondError(response, absent ? 404 : 500, origin);
      }
      return;
    }

    const visualTexture = pathname.match(/^\/visual\/texture\/([0-9a-f]{40}(?:-\d{1,3})?)\.png$/);
    if (request.method === "GET" && visualTexture && options.visualModelsDirectory) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      try {
        const data = await readFile(join(options.visualModelsDirectory, `${visualTexture[1]}.png`));
        // The WMO generator rewrites this same hash-keyed PNG when an archive overlay changes.
        // It has no independent route key, so a one-day freshness window could leave an already
        // open browser drawing the previous building texture. A content validator keeps the URL
        // backwards-compatible while max-age=0 makes cached responses revalidate after republish.
        const etag = `"${createHash("sha1").update(data).digest("hex")}"`;
        const cacheHeaders = {
          "access-control-allow-origin": origin,
          "cache-control": "public, max-age=0, must-revalidate",
          etag,
          "content-type": "image/png",
        };
        const ifNoneMatch = request.headers["if-none-match"];
        if (ifNoneMatch && ifNoneMatch.split(",").some((value) => value.trim() === etag || value.trim() === "*")) {
          response.writeHead(304, cacheHeaders);
          response.end();
          return;
        }
        response.writeHead(200, { ...cacheHeaders, "content-length": data.byteLength });
        response.end(data);
      } catch (error) {
        respondError(response, (error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500, origin);
      }
      return;
    }

    const visualEnvironment = pathname.match(/^\/visual\/environment\/(\d{1,4})\/(\d{1,2})\/(\d{1,2})$/);
    if (request.method === "GET" && visualEnvironment && options.visualTilesDirectory) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      const map = Number(visualEnvironment[1]);
      const gridX = Number(visualEnvironment[2]);
      const gridY = Number(visualEnvironment[3]);
      if (gridX > 63 || gridY > 63) {
        respondError(response, 400, origin);
        return;
      }
      const key = `${map}/${gridX}/${gridY}`;
      const filename = join(options.visualTilesDirectory, String(map), `${gridX}-${gridY}.json`);
      try {
        const rebuild = () => generateOnce(visualTileLane, key, () => options.generateVisualTile!(map, gridX, gridY));
        if (options.generateVisualTile) {
          await fingerprint.ensureCurrent(filename, { generation: "visual-tile-v4" });
        }
        let data: Buffer;
        try {
          data = await readFile(filename);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !options.generateVisualTile) throw error;
          await rebuild();
          data = await readFile(filename);
        }
        response.writeHead(200, {
          "access-control-allow-origin": origin,
          "cache-control": "public, max-age=3600",
          "content-length": data.byteLength,
          "content-type": "application/json; charset=utf-8",
        });
        response.end(data);
      } catch (error) {
        respondError(response, (error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500, origin);
      }
      return;
    }

    const itemIcon = pathname.match(/^\/item-icon\/(\d{1,8})$/);
    if (request.method === "GET" && itemIcon && options.itemIconsDirectory) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      const displayId = Number(itemIcon[1]);
      const filename = join(options.itemIconsDirectory, `${displayId}.png`);
      try {
        const rebuild = () => generateOnce(itemIconLane, String(displayId), () => options.generateItemIcon!(displayId));
        if (options.generateItemIcon) await fingerprint.ensureCurrent(filename);
        let data: Buffer;
        try {
          data = await readFile(filename);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !options.generateItemIcon) throw error;
          await rebuild();
          data = await readFile(filename);
        }
        response.writeHead(200, {
          "access-control-allow-origin": origin,
          "cache-control": "public, max-age=86400",
          "content-length": data.byteLength,
          "content-type": "image/png",
        });
        response.end(data);
      } catch (error) {
        respondError(response, (error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500, origin);
      }
      return;
    }

    const worldMapZoneMap = pathname.match(/^\/world-map\/(\d{1,4})\/zones\.bin$/);
    if (request.method === "GET" && worldMapZoneMap && options.worldMapZoneMapsDirectory) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      const map = Number(worldMapZoneMap[1]);
      const filename = join(options.worldMapZoneMapsDirectory, `${map}.bin`);
      try {
        const rebuild = () => generateOnce(worldMapZoneMapLane, String(map),
          () => options.generateWorldMapZoneMap!(map));
        if (options.generateWorldMapZoneMap) {
          await fingerprint.ensureCurrent(filename, { requireStamp: true });
        }
        let data: Buffer;
        try {
          data = await readFile(filename);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !options.generateWorldMapZoneMap) throw error;
          await rebuild();
          data = await readFile(filename);
        }
        // Never serve a truncated cache entry as a grid: its offsets would still parse and point
        // every click after the truncation at area zero, which looks like legitimate ocean. A
        // generator can repair an interrupted/corrupt existing publish just as it repairs ENOENT;
        // without this branch the bad file would make every bounded browser retry return 500.
        if (data.byteLength !== 128 * 128 * 4 && options.generateWorldMapZoneMap) {
          await rebuild();
          data = await readFile(filename);
        }
        if (data.byteLength !== 128 * 128 * 4) throw new Error(`Invalid world-map zone map ${map}`);
        respondRevalidated(request, response, data, origin, "application/octet-stream");
      } catch (error) {
        const absent = sourceMissing(error)
          || (!options.generateWorldMapZoneMap && (error as NodeJS.ErrnoException).code === "ENOENT");
        respondError(response, absent ? 404 : 500, origin);
      }
      return;
    }

    const minimapIndex = pathname.match(/^\/minimap\/(\d{1,4})\/index\.json$/);
    if (request.method === "GET" && minimapIndex && options.minimapDirectory) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      const map = Number(minimapIndex[1]);
      const filename = join(options.minimapDirectory, `${map}.json`);
      try {
        const rebuild = () => generateOnce(minimapLane, String(map), () => options.generateMinimapIndex!(map));
        if (options.generateMinimapIndex) await fingerprint.ensureCurrent(filename);
        let data: Buffer;
        try {
          data = await readFile(filename);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !options.generateMinimapIndex) throw error;
          await rebuild();
          data = await readFile(filename);
        }
        response.writeHead(200, {
          "access-control-allow-origin": origin,
          "cache-control": "public, max-age=3600",
          "content-length": data.byteLength,
          "content-type": "application/json; charset=utf-8",
        });
        response.end(data);
      } catch (error) {
        respondError(response, (error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500, origin);
      }
      return;
    }

    // Ground textures are shared between neighbouring tiles, so they are served from one flat
    // directory and the browser downloads each of them exactly once. The id is sha1 of the BLP's
    // *path* and not of its content, so the same id holds a different picture after a module
    // replaces the grass — calling it "named by content", as this used to, is what made it look
    // as though the ground could not be served stale.
    //
    // Nothing is checked or dropped here, and that is deliberate: an id does not name a path, so
    // this route has no generator of its own and a layer it deleted could not be rebuilt — the
    // player would get a hole in the ground instead of an old picture. The tile that owns the
    // layer carries every one of its ground textures in its own stamp, so the same edit makes the
    // splat stale, and rebuilding the splat rewrites the layers whose source moved
    // (`tools/generate-terrain-splat.mjs` skips only the layers whose stamp still agrees).
    const terrainLayer = pathname.match(/^\/terrain-layer\/([0-9a-f]{40})\.png$/);
    if (request.method === "GET" && terrainLayer && options.terrainLayersDirectory) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      try {
        const data = await readFile(join(options.terrainLayersDirectory, `${terrainLayer[1]}.png`));
        response.writeHead(200, {
          "access-control-allow-origin": origin,
          "cache-control": "public, max-age=86400",
          "content-length": data.byteLength,
          "content-type": "image/png",
        });
        response.end(data);
      } catch (error) {
        respondError(response, (error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500, origin);
      }
      return;
    }

    // The ingredients the terrain shader blends: which ground textures a chunk uses, their alpha
    // maps, and the list of textures themselves. All three come from one generated tile.
    // One map's far horizon: the client's own `.wdl`, served whole. 780 KB for a continent, once
    // per session, against a ring of real ground that ends 533 yards from the player.
    const horizon = pathname.match(/^\/horizon\/(\d{1,4})$/);
    if (request.method === "GET" && horizon && options.horizonDirectory) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      const map = Number(horizon[1]);
      const filename = join(options.horizonDirectory, `${map}.wdl`);
      try {
        const rebuild = () => generateOnce(horizonLane, `horizon:${map}`, () => options.generateHorizon!(map));
        if (options.generateHorizon) await fingerprint.ensureCurrent(filename);
        let data: Buffer;
        try {
          data = await readFile(filename);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !options.generateHorizon) throw error;
          await rebuild();
          data = await readFile(filename);
        }
        response.writeHead(200, {
          "access-control-allow-origin": origin,
          "cache-control": "public, max-age=86400",
          "content-length": data.byteLength,
          "content-type": "application/octet-stream",
        });
        response.end(data);
      } catch (error) {
        // A map with no `.wdl` is an instance or a battleground, which has no horizon to draw.
        respondError(response, (error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500, origin);
      }
      return;
    }

    // The ingredients of one tile, five files from one read of its ADT: the layer list, the alpha
    // maps, the per-chunk index, the painted vertex colours and — since the ground-cover slice —
    // the recipe for what grows on it. `cover.bin` is a *new name* in the family rather than a new
    // version of an old one, and that is what makes the change need no cache key and no manual
    // delete: it is absent for every tile published before it existed, and absent is exactly the
    // case the ENOENT path below rebuilds. `fingerprint.ensureCurrent` runs first and is keyed on
    // this file's own name, so a tile whose `alpha.png` is current and whose `cover.bin` has never
    // been written finds no stamp for it, remembers that, and falls through to the rebuild.
    const terrainSplat = pathname.match(/^\/terrain-splat\/(\d{1,4})\/(\d{1,2})\/(\d{1,2})(?:\/(alpha\.png|index\.png|mccv\.png|cover\.bin))?$/);
    if (request.method === "GET" && terrainSplat && options.terrainTexturesDirectory) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      const map = Number(terrainSplat[1]);
      const gridX = Number(terrainSplat[2]);
      const gridY = Number(terrainSplat[3]);
      const part = terrainSplat[4];
      if (gridX > 63 || gridY > 63) {
        respondError(response, 400, origin);
        return;
      }
      const suffix = part ?? "splat.json";
      const filename = join(options.terrainTexturesDirectory, String(map), `${gridX}-${gridY}.${suffix}`);
      try {
        const rebuild = () => generateOnce(terrainTextureLane, `splat:${map}/${gridX}/${gridY}`,
          () => options.generateTerrainSplat!(map, gridX, gridY));
        if (options.generateTerrainSplat) await fingerprint.ensureCurrent(filename);
        let data: Buffer;
        try {
          data = await readFile(filename);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !options.generateTerrainSplat) throw error;
          await rebuild();
          data = await readFile(filename);
        }
        response.writeHead(200, {
          "access-control-allow-origin": origin,
          "cache-control": "public, max-age=86400",
          "content-length": data.byteLength,
          "content-type": part === "cover.bin"
            ? "application/octet-stream"
            : part ? "image/png" : "application/json; charset=utf-8",
        });
        response.end(data);
      } catch (error) {
        respondError(response, (error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500, origin);
      }
      return;
    }

    const terrainTexture = pathname.match(/^\/terrain-texture\/(\d{1,4})\/(\d{1,2})\/(\d{1,2})$/);
    if (request.method === "GET" && terrainTexture && options.terrainTexturesDirectory) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      const map = Number(terrainTexture[1]);
      const gridX = Number(terrainTexture[2]);
      const gridY = Number(terrainTexture[3]);
      if (gridX > 63 || gridY > 63) {
        respondError(response, 400, origin);
        return;
      }
      const filename = join(options.terrainTexturesDirectory, String(map), `${gridX}-${gridY}.png`);
      try {
        const rebuild = () => generateOnce(terrainTextureLane, `${map}/${gridX}/${gridY}`,
          () => options.generateTerrainTexture!(map, gridX, gridY));
        if (options.generateTerrainTexture) await fingerprint.ensureCurrent(filename);
        let data: Buffer;
        try {
          data = await readFile(filename);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !options.generateTerrainTexture) throw error;
          await rebuild();
          data = await readFile(filename);
        }
        response.writeHead(200, {
          "access-control-allow-origin": origin,
          "cache-control": "public, max-age=86400",
          "content-length": data.byteLength,
          "content-type": "image/png",
        });
        response.end(data);
      } catch (error) {
        respondError(response, (error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500, origin);
      }
      return;
    }

    const terrain = pathname.match(/^\/terrain\/(\d{1,4})\/(\d{1,2})\/(\d{1,2})$/);
    if (request.method === "GET" && terrain && options.mapsDirectory) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      const map = Number(terrain[1]);
      const gridX = Number(terrain[2]);
      const gridY = Number(terrain[3]);
      if (gridX > 63 || gridY > 63) {
        respondError(response, 400, origin);
        return;
      }

      const filename = `${String(map).padStart(3, "0")}${String(gridX).padStart(2, "0")}${String(gridY).padStart(2, "0")}.map`;
      try {
        const data = await readFile(join(options.mapsDirectory, filename));
        response.writeHead(200, {
          "access-control-allow-origin": origin,
          "cache-control": "public, max-age=3600",
          "content-length": data.byteLength,
          "content-type": "application/octet-stream",
        });
        response.end(data);
      } catch (error) {
        respondError(response, (error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500, origin);
      }
      return;
    }

    /**
     * One client sound, addressed by its path in the archives.
     *
     * Keyed the way `/texture` is, and cached the same way, because the content is fixed by the
     * path. The one difference is what a miss costs. Nothing is decoded here — a sound is a read
     * and a write, 0.42 ms for a footstep — so the whole 285 ms of a miss is starting node and
     * opening the twenty-two archives, 152 ms of it the chain alone. A footstep kit is five files,
     * and asking one at a time would pay that five times over for two milliseconds of reading, so
     * the generator publishes the whole `SoundEntries` row and the other four are already there.
     *
     * That also decides the lane key. Keyed on this file's own hash, five concurrent requests for
     * one kit would start five processes; keyed on the directory, a kit's variants — which by
     * construction share one — queue behind a single job.
     */
    if (request.method === "GET" && pathname === "/sound" && options.soundDirectory) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      const soundPath = normaliseSoundPath(url.searchParams.get("path") ?? "");
      if (!validSoundPath(soundPath)) {
        respondError(response, 400, origin);
        return;
      }
      const lower = soundPath.toLowerCase();
      const id = createHash("sha1").update(`sound-v1\0${lower}`).digest("hex");
      const extension = lower.endsWith(".mp3") ? ".mp3" : ".wav";
      const filename = join(options.soundDirectory, `${id}${extension}`);
      try {
        // The lane's key is the sound's directory, not the file: one generator run publishes the
        // whole `SoundEntries` row, so a footstep kit asked for a file at a time would otherwise
        // pay for the twenty-two archives five times over.
        const rebuild = () => generateOnce(soundLane, lower.slice(0, lower.lastIndexOf("\\") + 1) || lower,
          () => options.generateSound!(soundPath));
        if (options.generateSound) await fingerprint.ensureCurrent(filename);
        let data: Buffer;
        try {
          data = await readFile(filename);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !options.generateSound) throw error;
          await rebuild();
          data = await readFile(filename);
        }
        respondRevalidated(request, response, data, origin,
          extension === ".mp3" ? "audio/mpeg" : "audio/wav");
      } catch {
        respondError(response, 404, origin);
      }
      return;
    }

    /**
     * One raw interface file out of the archives: Lua, XML, TOC or TTF, as the game reads it.
     *
     * The only route here that hands over a client file unconverted, because the GlueXML runtime
     * (G1..G3 of live-plan-6) has to *execute* what the game executes. What makes it load-bearing
     * rather than a convenience is which copy it hands over: this server's login screen is a tswow
     * module, and `patch-ruRU-F.MPQ` is a directory pointed at `LoginScreenModule/assets`. Measured
     * on this client through the chain `tools/mpq.mjs` ranks — 28 sources, lettered patches above
     * the locale families — `Interface\GlueXML\GlueXML.toc` and `AccountLogin.{lua,xml}` resolve to
     * `patch-ruRU-F.MPQ` and `CharacterCreate.{lua,xml}` to tswow's `patch-ruRU-A.MPQ`, while the
     * 50 GlueXML entries inside `locale-ruRU.MPQ` win nothing at all. A route that read the locale
     * archive would run Blizzard's login screen against this server's account flow, and there would
     * be no error anywhere to say why the buttons were the wrong ones.
     *
     * The extension gate is the security boundary and it is deliberately four items long: the chain
     * this reads includes real directories on disk that module authors write into, and `.lua`,
     * `.xml`, `.toc` and `.ttf` are what an interface is made of. Art has `/texture` and models have
     * `/visual/model`, so nothing legitimate is left outside the list — and a DBC, a map, a `.wtf`
     * or anything else somebody dropped beside a module's assets is not reachable through it.
     *
     * Served revalidating for the same reason as every other path-stable client asset: the archive
     * path does not change when the owner edits `AccountLogin.lua`. The ETag is over the bytes, so
     * an unchanged file still costs one 304 and no body.
     */
    if (request.method === "GET" && pathname === "/client/file" && options.clientFilesDirectory) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      const clientPath = (url.searchParams.get("path") ?? "").replaceAll("/", "\\");
      if (!validClientFilePath(clientPath)) {
        respondError(response, 400, origin);
        return;
      }
      const lower = clientPath.toLowerCase();
      const id = createHash("sha1").update(`client-file-v1\0${lower}`).digest("hex");
      const extension = lower.slice(lower.lastIndexOf("."));
      const filename = join(options.clientFilesDirectory, `${id}${extension}`);
      try {
        const rebuild = () => generateOnce(clientFileLane, id, () => options.generateClientFile!(clientPath));
        // `requireStamp`, as `/visual/model` does and unlike `/texture`: the filename hashes the
        // path, nothing on disk holds the path back, and `restamp` therefore cannot give an entry
        // in this family a stamp after the fact. Every entry here is stamped by its own generator
        // on the way out, so an unstamped one is a half-written cache rather than a legacy file,
        // and rebuilding it is right where serving it would be a guess.
        if (options.generateClientFile) await fingerprint.ensureCurrent(filename, { requireStamp: true });
        let data: Buffer;
        try {
          data = await readFile(filename);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !options.generateClientFile) throw error;
          await rebuild();
          data = await readFile(filename);
        }
        respondRevalidated(request, response, data, origin, clientFileContentType(extension));
      } catch (error) {
        // The same split `/texture` and `/visual/model` carry, and it matters more here than in
        // either: a `.toc` lists files that need not exist, so the loader has to treat a 404 as "not
        // shipped" and move on. If a dead generator child also answered 404, one bad minute would
        // silently remove a frame from the login screen for the rest of the session.
        const absent = sourceMissing(error)
          || (!options.generateClientFile && (error as NodeJS.ErrnoException).code === "ENOENT");
        respondError(response, absent ? 404 : 500, origin);
      }
      return;
    }

    /**
     * What `SoundEntries` says about a handful of kits, by id.
     *
     * By id and not whole: 12,941 rows carrying 20,642 paths is about a megabyte and a half of
     * JSON and a session plays a few dozen of them. `ZoneMusic` and `ZoneIntroMusicTable` ride
     * along on the same route because they answer *in* `SoundEntries` ids and are nothing on their
     * own — the kits they name are resolved here rather than costing a second round trip.
     */
    /**
     * Which `SoundEntries` row each `SpellVisualKit` names, whole and once.
     *
     * `SMSG_PLAY_SPELL_VISUAL_KIT` carries a kit id and the noise has to start now, not after a
     * round trip, so this one is not batched by id like its neighbours. 4,680 of the 8,663 kits
     * name a sound and the pairs are 58 KB — less than one spell icon.
     */
    if (request.method === "GET" && pathname === "/dbc/spell-kit-sounds" && options.dbcDirectory) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      try {
        indexes.soundIndex ??= SoundIndex.load(options.dbcDirectory);
        const data = JSON.stringify({ kits: (await indexes.soundIndex).spellKitSounds() });
        response.writeHead(200, {
          "access-control-allow-origin": origin,
          "cache-control": "public, max-age=3600",
          "content-type": "application/json; charset=utf-8",
        });
        response.end(data);
      } catch {
        respondError(response, 500, origin);
      }
      return;
    }

    /**
     * What every tswow module on this machine ships for this client.
     *
     * The one index in this gateway that is *not* memoised, and deliberately: every other one
     * answers from a dataset that changes when the dataset is rebuilt, while this one exists to
     * notice that somebody just saved a file. Measured on this machine, warm, four runs of 20: the
     * whole scan of `data/ui` plus the configured TSWoW modules has a median between 0.20
     * and 0.31 ms as they stand today, and between 0.93 and 1.28 ms with two modules holding four
     * schema files across both roots — cheaper than the round trip that asked for it, and М6 polls
     * it every two seconds while the window editor is open.
     *
     * Shaped so М6 only adds keys: a module entry grows `windows` and `css` beside `messages`.
     */
    if (request.method === "GET" && pathname === "/modules/index" && options.moduleDirectories) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      try {
        const index = await readModuleIndex(options.moduleDirectories);
        response.writeHead(200, {
          "access-control-allow-origin": origin,
          // The whole point is to see an edit, so nothing may hold this — not the browser cache
          // and not a proxy in between.
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
        });
        response.end(JSON.stringify(index));
      } catch {
        respondError(response, 500, origin);
      }
      return;
    }

    /**
     * One definition file, by kind, module and name: a message schema, a window or a stylesheet.
     *
     * Three routes out of one block because they differ in exactly two things — the directory the
     * kind names and the content type — and `MODULE_FILE_KINDS` already holds the first. A copy of
     * this per kind is three copies of the path validation, which is the half that has to be right.
     *
     * Path validation is `validModuleName` rather than `validTexturePath`, and it is stricter for a
     * reason: a texture path has to be allowed to hold separators, so its validator checks for `..`
     * by hand. A module and a filename never hold one, so the shape `[A-Za-z0-9_-]` already rules
     * out `..`, both separators and every absolute path — there is nothing left to check by hand.
     *
     * `PUT` is answered by the same block, and refused by default. The gateway is an unauthenticated
     * pipe (`createGatewayConfiguration` warns so at start-up when it listens beyond loopback and
     * accepts any Origin), so a route that writes files has to be
     * switched on deliberately (`MODULE_UI_WRITE=1`) *and* has to be talking to this machine: the
     * check is on the socket's own address rather than on any header, because a header is written
     * by whoever is asking. М8's builder overlay is what turns it on.
     *
     * `OPTIONS` is answered too, and it is the one thing that makes the `PUT` reachable at all.
     * The page is served from `:5173` and this gateway listens on `:8090`, so every request here is
     * cross-origin — and `PUT` is not one of the three methods a browser may send without asking
     * first (`GET`, `HEAD`, `POST`). Without a preflight answer carrying
     * `access-control-allow-methods`, the browser blocks the request before it is ever sent: М6's
     * write route existed and no page could reach it, and the builder would have reported «шлюз
     * недоступен» for every export. The answer advertises `PUT` **even when `MODULE_UI_WRITE` is
     * off**, on purpose: the method is a fact about the route, while writing is a fact about this
     * gateway's configuration, and the second is what the 405 below says in words the author can
     * act on. A preflight that refused the method instead would turn that sentence into a network
     * error with nothing in it.
     */
    if ((request.method === "GET" || request.method === "PUT" || request.method === "OPTIONS")
      && pathname.startsWith("/modules/") && options.moduleDirectories) {
      const parts = pathname.slice("/modules/".length).split("/");
      const [kind, module, file] = parts;
      // `moduleFileKind` and not `kind in …`: `in` answers true for `constructor` and `toString`,
      // and a kind nobody declared has to fall through to the 404 at the end like any other path.
      if (kind !== undefined && moduleFileKind(kind) !== undefined) {
        const origin = request.headers.origin;
        if (!originAllowed(origin, options.allowedOrigins)) {
          response.writeHead(403).end();
          return;
        }
        if (request.method === "OPTIONS") {
          response.writeHead(204, {
            "access-control-allow-origin": origin,
            "access-control-allow-methods": "GET, PUT",
            // Echoed rather than written out, so that a browser asking about a header this route
            // has never heard of gets an answer instead of a silent block.
            "access-control-allow-headers": request.headers["access-control-request-headers"] ?? "content-type",
            // Ten minutes: an export is one preflight and one write, and an author saving a window
            // every few seconds should pay for the first pair only.
            "access-control-max-age": "600",
          }).end();
          return;
        }
        if (parts.length !== 3 || !module || !file || !validModuleName(module) || !validModuleFileName(file, kind)) {
          respondError(response, 400, origin);
          return;
        }
        const contentType = file.toLowerCase().endsWith(".css")
          ? "text/css; charset=utf-8"
          : "application/json; charset=utf-8";
        if (request.method === "PUT") {
          const peer = (options.peerAddress ?? socketPeerAddress)(request);
          if (!options.moduleWrite || !isLoopbackAddress(peer)) {
            // 405 and not 403: the route exists and the method is the part that is refused. The
            // `allow` header says so in the one word a client can act on.
            response.writeHead(405, { "access-control-allow-origin": origin, allow: "GET" }).end();
            return;
          }
          const body = await readRequestBody(request, MAX_MODULE_FILE_BYTES);
          if (!body) {
            respondError(response, 413, origin);
            return;
          }
          const written = await writeModuleFile(options.moduleDirectories, kind, module, file, body);
          if (written.kind === "too-large") {
            respondError(response, 413, origin);
            return;
          }
          if (written.kind === "bad-name") {
            respondError(response, 400, origin);
            return;
          }
          if (written.kind === "failed") {
            respondError(response, 500, origin);
            return;
          }
          response.writeHead(204, { "access-control-allow-origin": origin }).end();
          return;
        }
        const result = await readModuleFile(options.moduleDirectories, kind, module, file);
        if (result.kind === "too-large") {
          respondError(response, 413, origin);
          return;
        }
        if (result.kind === "missing") {
          respondError(response, 404, origin);
          return;
        }
        response.writeHead(200, {
          "access-control-allow-origin": origin,
          // Held by its sha1 in the index, not by a max-age: the file is being edited.
          "cache-control": "no-store",
          "content-length": result.data.byteLength,
          "content-type": contentType,
        });
        response.end(result.data);
        return;
      }
    }

    if (request.method === "GET" && pathname === "/dbc/sounds" && options.dbcDirectory) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      const numbers = (name: string): number[] => [...new Set((url.searchParams.get(name) ?? "")
        .split(",")
        .map(Number)
        .filter((id) => Number.isInteger(id) && id > 0))];
      const ids = numbers("ids");
      const zones = numbers("music");
      const intros = numbers("intro");
      const displays = numbers("creatures");
      // `SoundAmbience` rides here for the same reason `ZoneMusic` does: it answers *in*
      // `SoundEntries` ids and is nothing on its own, so the kits come back in the same reply.
      const ambiences = numbers("ambience");
      // Names rather than ids, because that is what the client's own Lua calls the interface's
      // noises and a number here would be a magic number at the other end.
      const names = [...new Set((url.searchParams.get("names") ?? "").split(",").filter(Boolean))]
        .filter((name) => /^[A-Za-z0-9_]{1,64}$/.test(name));
      const asked = ids.length + zones.length + intros.length + displays.length + names.length
        + ambiences.length;
      if (asked === 0 || ids.length > 200 || zones.length > 200 || intros.length > 200
        || displays.length > 200 || names.length > 200 || ambiences.length > 200) {
        respondError(response, 400, origin);
        return;
      }
      try {
        indexes.soundIndex ??= SoundIndex.load(options.dbcDirectory);
        const index = await indexes.soundIndex;
        const music = zones
          .map((id) => ({ id, tracks: index.zoneMusic(id) }))
          .filter((entry): entry is { id: number; tracks: ZoneMusicTracks } => entry.tracks !== undefined);
        const intro = intros
          .map((id) => ({ id, sound: index.zoneIntro(id) ?? 0 }))
          .filter((entry) => entry.sound > 0);
        const ambience = ambiences
          .map((id) => ({ id, tracks: index.ambience(id) }))
          .filter((entry): entry is { id: number; tracks: { day: number; night: number } } => entry.tracks !== undefined);
        const wanted = new Set(ids);
        for (const entry of music) {
          wanted.add(entry.tracks.day.kit);
          wanted.add(entry.tracks.night.kit);
        }
        for (const entry of ambience) {
          wanted.add(entry.tracks.day);
          wanted.add(entry.tracks.night);
        }
        for (const entry of intro) wanted.add(entry.sound);
        const creatures = displays.map((id) => index.creature(id)).filter(Boolean);
        for (const entry of creatures) {
          // Every id the row names, not the four this used to carry: a client that has the row but
          // not the kit behind it is a client that goes quiet on the first critical hit.
          for (const id of SoundIndex.creatureSoundIds(entry!)) wanted.add(id);
        }
        const named = names.map((name) => ({ name, id: index.named(name) ?? 0 })).filter((entry) => entry.id > 0);
        for (const entry of named) wanted.add(entry.id);
        const data = JSON.stringify({
          kits: [...wanted].map((id) => index.kit(id)).filter(Boolean),
          music: music.map((entry) => ({ id: entry.id, ...entry.tracks })),
          intro,
          ambience: ambience.map((entry) => ({ id: entry.id, day: entry.tracks.day, night: entry.tracks.night })),
          creatures,
          named,
        });
        response.writeHead(200, {
          "access-control-allow-origin": origin,
          "cache-control": "public, max-age=3600",
          "content-type": "application/json; charset=utf-8",
        });
        response.end(data);
      } catch {
        respondError(response, 500, origin);
      }
      return;
    }

    if (request.method === "GET" && pathname === "/dbc/spells" && options.dbcDirectory) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      const ids = [...new Set((url.searchParams.get("ids") ?? "")
        .split(",")
        .map(Number)
        .filter((id) => Number.isInteger(id) && id > 0))];
      if (ids.length === 0 || ids.length > 200) {
        respondError(response, 400, origin);
        return;
      }
      try {
        indexes.spellMetadata ??= loadSpellMetadata(options.dbcDirectory);
        const metadata = await indexes.spellMetadata;
        const data = JSON.stringify(ids.map((id) => metadata.get(id)).filter(Boolean));
        response.writeHead(200, {
          "access-control-allow-origin": origin,
          "cache-control": "public, max-age=3600",
          "content-type": "application/json; charset=utf-8",
        });
        response.end(data);
      } catch {
        respondError(response, 500, origin);
      }
      return;
    }

    /**
     * What a spell looks like, by id and in batches -- for the same reason its name is.
     *
     * Whole would be 9.29 MB of JSON: 31,579 of the client's spells have a visual, and between
     * them they name 76,009 effect placements. A batch of two hundred is 84 KB, and the browser
     * only ever asks about spells something actually cast.
     */
    if (request.method === "GET" && pathname === "/dbc/spell-visuals" && options.dbcDirectory) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      const ids = [...new Set((url.searchParams.get("ids") ?? "")
        .split(",")
        .map(Number)
        .filter((id) => Number.isInteger(id) && id > 0))];
      if (ids.length === 0 || ids.length > 200) {
        respondError(response, 400, origin);
        return;
      }
      try {
        indexes.spellVisuals ??= loadSpellVisuals(options.dbcDirectory, options.visualDbcDirectory);
        const visuals = await indexes.spellVisuals;
        // A spell with no visual answers with its own id and nothing else, so the browser learns
        // that it asked and stops asking.
        const data = JSON.stringify(ids.map((id) => visuals.get(id) ?? { id }));
        response.writeHead(200, {
          "access-control-allow-origin": origin,
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
        });
        response.end(data);
      } catch {
        // Not kept once it has rejected: a dataset half-written during a rebuild would
        // otherwise answer 500 until the gateway is restarted, and every cast in the session
        // would draw nothing.
        indexes.spellVisuals = undefined;
        respondError(response, 500, origin);
      }
      return;
    }

    /**
     * The same kits, by the number the *packet* names.
     *
     * `SMSG_PLAY_SPELL_VISUAL` and `SMSG_PLAY_SPELL_IMPACT` carry a `SpellVisualKit` id and no
     * spell at all — a boss emote, a trainer's flash, a player sitting down to eat. The route
     * beside this one is keyed by spell, so those packets reached the client, resolved to a sound
     * and drew nothing, for the plain reason that no route could answer the question they ask.
     *
     * Measured on this dataset: 8,217 of the 8,663 kit rows resolve to something with a model, a
     * pose or a sound, and 1,194 of those are named by no `Spell` row at all — among them 7668,
     * which this server's own Illidan script sends.
     */
    if (request.method === "GET" && pathname === "/dbc/spell-visual-kits" && options.dbcDirectory) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      const ids = [...new Set((url.searchParams.get("ids") ?? "")
        .split(",")
        .map(Number)
        .filter((id) => Number.isInteger(id) && id > 0))];
      if (ids.length === 0 || ids.length > 200) {
        respondError(response, 400, origin);
        return;
      }
      try {
        indexes.spellVisualKits ??= loadSpellVisualKits(options.dbcDirectory, options.visualDbcDirectory);
        const kits = await indexes.spellVisualKits;
        // A kit that resolves to nothing answers with its own id and no `kit`, exactly as a spell
        // with no visual answers with its own id and nothing else.
        const data = JSON.stringify(ids.map((id) => {
          const kit = kits.get(id);
          return kit ? { id, kit } : { id };
        }));
        response.writeHead(200, {
          "access-control-allow-origin": origin,
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
        });
        response.end(data);
      } catch {
        // Dropped on failure for the same reason its neighbour is: a dataset half-written during
        // a rebuild must not answer 500 for the rest of the process's life.
        indexes.spellVisualKits = undefined;
        respondError(response, 500, origin);
      }
      return;
    }

    // Both tables whole rather than a query per object: 388 locks and 222 spells that open them
    // is a few kilobytes, and the alternative is a round trip for every rock in Elwynn.
    if (request.method === "GET" && pathname === "/dbc/locks" && options.dbcDirectory) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      try {
        indexes.lockData ??= loadLockData(options.dbcDirectory);
        const data = JSON.stringify(await indexes.lockData);
        response.writeHead(200, {
          "access-control-allow-origin": origin,
          "cache-control": "public, max-age=3600",
          "content-type": "application/json; charset=utf-8",
        });
        response.end(data);
      } catch {
        respondError(response, 500, origin);
      }
      return;
    }

    // Every faction template at once. Nothing on the wire says whether a unit is an enemy: the
    // client works it out of this table, the same way the core's own FactionTemplateEntry does,
    // and it is asked of every unit in view several times a second.
    if (request.method === "GET" && pathname === "/dbc/factions" && options.dbcDirectory) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      try {
        indexes.factionData ??= loadFactionData(options.dbcDirectory);
        const data = JSON.stringify(await indexes.factionData);
        response.writeHead(200, {
          "access-control-allow-origin": origin,
          "cache-control": "public, max-age=3600",
          "content-type": "application/json; charset=utf-8",
        });
        response.end(data);
      } catch {
        respondError(response, 500, origin);
      }
      return;
    }

    // Battleground queue labels and limits are client data. The live list only carries a
    // battlemaster's type id and current instances, so this fixed catalog is cached like the
    // other DBC routes and invalidated with the dataset fingerprint.
    if (request.method === "GET" && pathname === "/dbc/world-state-ui" && options.dbcDirectory) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      try {
        indexes.worldStateUiMetadata ??= loadWorldStateUiMetadata(options.dbcDirectory);
        const data = JSON.stringify(await indexes.worldStateUiMetadata);
        response.writeHead(200, {
          "access-control-allow-origin": origin,
          "cache-control": "public, max-age=3600",
          "content-type": "application/json; charset=utf-8",
        });
        response.end(data);
      } catch {
        indexes.worldStateUiMetadata = undefined;
        respondError(response, 500, origin);
      }
      return;
    }

    if (request.method === "GET" && pathname === "/dbc/battlegrounds" && options.dbcDirectory) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      try {
        indexes.battlegroundMetadata ??= loadBattlegroundMetadata(options.dbcDirectory);
        const data = JSON.stringify(await indexes.battlegroundMetadata);
        response.writeHead(200, {
          "access-control-allow-origin": origin,
          "cache-control": "public, max-age=3600",
          "content-type": "application/json; charset=utf-8",
        });
        response.end(data);
      } catch {
        // Do not retain a rejection when a dataset rebuild briefly exposes a partial DBC set.
        indexes.battlegroundMetadata = undefined;
        respondError(response, 500, origin);
      }
      return;
    }

    // A SHOWTAXINODES packet is only a discovery mask. Names, costs and which pairs are real
    // directed legs live in TaxiNodes/TaxiPath; the client needs all three to avoid presenting a
    // discovered node as a direct flight that the server will silently reject.
    if (request.method === "GET" && pathname === "/dbc/taxi" && options.dbcDirectory) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      try {
        indexes.taxiMetadata ??= loadTaxiMetadata(options.dbcDirectory);
        const data = JSON.stringify(await indexes.taxiMetadata);
        response.writeHead(200, {
          "access-control-allow-origin": origin,
          "cache-control": "public, max-age=3600",
          "content-type": "application/json; charset=utf-8",
        });
        response.end(data);
      } catch {
        indexes.taxiMetadata = undefined;
        respondError(response, 500, origin);
      }
      return;
    }

    // Every text emote and every sentence it can produce. The wire carries three numbers and a
    // name; which words go with them has always been the client's job, out of this table.
    if (request.method === "GET" && pathname === "/dbc/emotes" && options.dbcDirectory) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      try {
        indexes.emoteData ??= loadEmoteData(options.dbcDirectory, audioDbcDirectory);
        const data = JSON.stringify(await indexes.emoteData);
        response.writeHead(200, {
          "access-control-allow-origin": origin,
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
        });
        response.end(data);
      } catch {
        respondError(response, 500, origin);
      }
      return;
    }

    // One liquid's thirty animation frames as a single strip, and the sidecar that says how many
    // and how big. Generated on first request like every other asset here.
    const liquid = pathname.match(/^\/liquid\/([a-z]{4,6})(\.png)?$/);
    if (request.method === "GET" && liquid && options.liquidDirectory) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      const name = liquid[1]!;
      const image = liquid[2] !== undefined;
      const filename = join(options.liquidDirectory, `${name}.${image ? "png" : "json"}`);
      try {
        const rebuild = () => generateOnce(liquidLane, name, () => options.generateLiquidTexture!(name));
        if (options.generateLiquidTexture) await fingerprint.ensureCurrent(filename);
        let data: Buffer;
        try {
          data = await readFile(filename);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !options.generateLiquidTexture) throw error;
          await rebuild();
          data = await readFile(filename);
        }
        respondRevalidated(request, response, data, origin,
          image ? "image/png" : "application/json; charset=utf-8");
      } catch (error) {
        respondError(response, (error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500, origin);
      }
      return;
    }

    // One map's sky, sun and fog whole. There is nothing to ask per position that the browser
    // cannot decide for itself, and it has to decide it every frame: map 0 is 82 light volumes
    // over 30 parameter sets.
    const mapLight = pathname.match(/^\/dbc\/light\/(\d{1,4})$/);
    if (request.method === "GET" && mapLight && options.dbcDirectory) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      try {
        indexes.lightIndex ??= loadLightMetadata(options.dbcDirectory);
        const lightIndex = await indexes.lightIndex;
        // 62 of the 135 maps in `Map.dbc` own no `Light.dbc` row at all — Gnomeregan, Molten Core,
        // Uldaman, Gundrak and the 28 transports among them — so they are simply absent from the
        // index. Serving them the global default is better than a 404: the browser's own last
        // resort is a compiled-in sky that never changes with the hour.
        const lighting = lightIndex.get(Number(mapLight[1])) ?? lightIndex.get(GLOBAL_FALLBACK_MAP);
        if (!lighting) {
          respondError(response, 404, origin);
          return;
        }
        const data = JSON.stringify(lighting);
        response.writeHead(200, {
          "access-control-allow-origin": origin,
          "cache-control": "public, max-age=3600",
          "content-type": "application/json; charset=utf-8",
        });
        response.end(data);
      } catch {
        respondError(response, 500, origin);
      }
      return;
    }

    // Talent trees, glyphs and skill lines. `SMSG_TALENTS_INFO` carries a list of ids and ranks
    // and nothing else — no tier, no column, no prerequisite, no name — so the shape of a talent
    // tree is entirely client data and there was no way to draw one before this.
    if (request.method === "GET" && pathname === "/dbc/areas" && options.dbcDirectory) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      try {
        indexes.areaData ??= loadAreaData(options.dbcDirectory);
        const data = JSON.stringify(await indexes.areaData);
        response.writeHead(200, {
          "access-control-allow-origin": origin,
          "cache-control": "public, max-age=3600",
          "content-type": "application/json; charset=utf-8",
        });
        response.end(data);
      } catch {
        // The rejected promise is not kept: a DBC that failed to open once — a half-written
        // dataset during a rebuild — would otherwise answer 500 until the gateway is restarted.
        indexes.areaData = undefined;
        respondError(response, 500, origin);
      }
      return;
    }

    if (request.method === "GET" && pathname === "/dbc/reputation" && options.dbcDirectory) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      if (url.searchParams.get("v") !== "1") {
        respondError(response, 400, origin);
        return;
      }
      try {
        indexes.reputationMetadata ??= loadReputationMetadata(options.dbcDirectory);
        const data = JSON.stringify(await indexes.reputationMetadata);
        response.writeHead(200, {
          "access-control-allow-origin": origin,
          "cache-control": "public, max-age=3600",
          "content-type": "application/json; charset=utf-8",
        });
        response.end(data);
      } catch {
        indexes.reputationMetadata = undefined;
        respondError(response, 500, origin);
      }
      return;
    }

    if (request.method === "GET" && pathname === "/dbc/vendor-costs" && options.dbcDirectory) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      if (url.searchParams.get("v") !== "1") {
        respondError(response, 400, origin);
        return;
      }
      try {
        indexes.vendorCostMetadata ??= loadVendorCostMetadata(options.dbcDirectory);
        const data = JSON.stringify(await indexes.vendorCostMetadata);
        response.writeHead(200, {
          "access-control-allow-origin": origin,
          // DatasetFingerprint can invalidate this catalog while the gateway stays up. The
          // catalog is loaded once per world session, and a one-hour browser cache could otherwise
          // keep an obsolete price after the realm's vendor list has already changed.
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
        });
        response.end(data);
      } catch {
        indexes.vendorCostMetadata = undefined;
        respondError(response, 500, origin);
      }
      return;
    }

    if (request.method === "GET" && pathname === "/dbc/lfg-dungeons" && options.dbcDirectory) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      try {
        indexes.lfgDungeonMetadata ??= loadLfgDungeonMetadata(options.dbcDirectory);
        const data = JSON.stringify(await indexes.lfgDungeonMetadata);
        // Catalog version 2 (LFG_DUNGEON_CATALOG_VERSION) changed the shape under the same path:
        // an hour-long freshness window would let a browser keep the version-1 body, whose rows
        // lack the stock list's group headers. A content validator revalidates on every open and
        // still answers 304 for an unchanged dataset.
        const etag = `"${createHash("sha1").update(data).digest("hex")}"`;
        const cacheHeaders = {
          "access-control-allow-origin": origin,
          "cache-control": "public, max-age=0, must-revalidate",
          etag,
          "content-type": "application/json; charset=utf-8",
        };
        const ifNoneMatch = request.headers["if-none-match"];
        if (ifNoneMatch && ifNoneMatch.split(",").some((value) => value.trim() === etag || value.trim() === "*")) {
          response.writeHead(304, cacheHeaders);
          response.end();
          return;
        }
        response.writeHead(200, cacheHeaders);
        response.end(data);
      } catch {
        respondError(response, 500, origin);
      }
      return;
    }

    // The ruRU declension dictionary (DeclinedWords.ts), fetched once per page by the FrameXML host.
    // Binary, gzipped when the browser accepts it; packed once per dataset (a DatasetIndexes entry,
    // which the dataset watch drops on a DBC change) and revalidated by content like the LFG catalog,
    // so a rebuilt dataset is picked up and an unchanged one answers 304.
    if (request.method === "GET" && pathname === "/dbc/declined-words" && options.dbcDirectory) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      if (url.searchParams.get("v") !== "1") {
        respondError(response, 400, origin);
        return;
      }
      try {
        indexes.declinedWords ??= loadDeclinedWords(options.dbcDirectory);
        const body = await indexes.declinedWords;
        const gzipped = /\bgzip\b/.test(String(request.headers["accept-encoding"] ?? ""));
        const cacheHeaders = {
          "access-control-allow-origin": origin,
          "cache-control": "public, max-age=0, must-revalidate",
          etag: body.etag,
          vary: "Accept-Encoding",
          "content-type": "application/octet-stream",
        };
        const ifNoneMatch = request.headers["if-none-match"];
        if (ifNoneMatch && ifNoneMatch.split(",").some((value) => value.trim() === body.etag || value.trim() === "*")) {
          response.writeHead(304, cacheHeaders);
          response.end();
          return;
        }
        response.writeHead(200, gzipped ? { ...cacheHeaders, "content-encoding": "gzip" } : cacheHeaders);
        response.end(gzipped ? body.gzip : body.raw);
      } catch {
        indexes.declinedWords = undefined;
        respondError(response, 500, origin);
      }
      return;
    }

    if (request.method === "GET" && pathname === "/dbc/slot-prices" && options.dbcDirectory) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      if (url.searchParams.get("v") !== "1") {
        respondError(response, 400, origin);
        return;
      }
      try {
        indexes.slotPrices ??= loadSlotPrices(options.dbcDirectory);
        const data = JSON.stringify(await indexes.slotPrices);
        response.writeHead(200, {
          "access-control-allow-origin": origin,
          "cache-control": "public, max-age=3600",
          "content-type": "application/json; charset=utf-8",
        });
        response.end(data);
      } catch {
        indexes.slotPrices = undefined;
        respondError(response, 500, origin);
      }
      return;
    }

    // The stock calendar's client tables (CalendarCatalog.ts), fetched once when the window first opens.
    if (request.method === "GET" && pathname === "/dbc/calendar" && options.dbcDirectory) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      if (url.searchParams.get("v") !== String(CALENDAR_CATALOG_VERSION)) {
        respondError(response, 400, origin);
        return;
      }
      try {
        const dbcDirectory = options.dbcDirectory;
        indexes.calendarCatalog ??= loadCalendarCatalog(dbcDirectory).then((catalog) => JSON.stringify(catalog));
        const data = await indexes.calendarCatalog;
        response.writeHead(200, {
          "access-control-allow-origin": origin,
          // Fetched once per page; a rebuilt dataset resets the index (DatasetFingerprint).
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
        });
        response.end(data);
      } catch {
        indexes.calendarCatalog = undefined;
        respondError(response, 500, origin);
      }
      return;
    }

    // The stock currency tab's client tables (CurrencyCatalog.ts), fetched once per world mount.
    if (request.method === "GET" && pathname === "/dbc/currencies" && options.dbcDirectory) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      if (url.searchParams.get("v") !== String(CURRENCY_CATALOG_VERSION)) {
        respondError(response, 400, origin);
        return;
      }
      try {
        const dbcDirectory = options.dbcDirectory;
        indexes.currencyCatalog ??= loadCurrencyCatalog(dbcDirectory).then((catalog) => JSON.stringify(catalog));
        const data = await indexes.currencyCatalog;
        response.writeHead(200, {
          "access-control-allow-origin": origin,
          // Fetched once per page; a rebuilt dataset resets the index (DatasetFingerprint).
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
        });
        response.end(data);
      } catch {
        indexes.currencyCatalog = undefined;
        respondError(response, 500, origin);
      }
      return;
    }

    // The stock glyph tab's client tables (GlyphCatalog.ts), fetched once per world mount.
    if (request.method === "GET" && pathname === "/dbc/glyphs" && options.dbcDirectory) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      if (url.searchParams.get("v") !== String(GLYPH_CATALOG_VERSION)) {
        respondError(response, 400, origin);
        return;
      }
      try {
        const dbcDirectory = options.dbcDirectory;
        indexes.glyphCatalog ??= loadGlyphCatalog(dbcDirectory).then((catalog) => JSON.stringify(catalog));
        const data = await indexes.glyphCatalog;
        response.writeHead(200, {
          "access-control-allow-origin": origin,
          // Fetched once per page; a rebuilt dataset resets the index (DatasetFingerprint).
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
        });
        response.end(data);
      } catch {
        indexes.glyphCatalog = undefined;
        respondError(response, 500, origin);
      }
      return;
    }

    // Every catalog route added since char-titles (CatalogRoutes.ts): one table, one memo per dataset.
    if (await serveCatalogRoute(request, response, url, indexes.catalogs ??= new Map(), options)) return;

    // The stock PaperDoll title picker's CharTitles rows (CharTitleMetadata.ts), fetched once per world mount.
    if (request.method === "GET" && pathname === "/dbc/char-titles" && options.dbcDirectory) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      if (url.searchParams.get("v") !== String(CHAR_TITLES_VERSION)) {
        respondError(response, 400, origin);
        return;
      }
      try {
        const dbcDirectory = options.dbcDirectory;
        indexes.charTitles ??= loadCharTitles(dbcDirectory).then((catalog) => JSON.stringify(catalog));
        const data = await indexes.charTitles;
        response.writeHead(200, {
          "access-control-allow-origin": origin,
          // Fetched once per page; a rebuilt dataset resets the index (DatasetFingerprint).
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
        });
        response.end(data);
      } catch {
        indexes.charTitles = undefined;
        respondError(response, 500, origin);
      }
      return;
    }

    // The stock macro window's icon lists (MacroIcons.ts), fetched once when it first opens.
    if (request.method === "GET" && pathname === "/dbc/macro-icons" && options.dbcDirectory) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      if (url.searchParams.get("v") !== "1") {
        respondError(response, 400, origin);
        return;
      }
      try {
        indexes.macroIcons ??= loadMacroIcons(options.dbcDirectory);
        const data = JSON.stringify(await indexes.macroIcons);
        response.writeHead(200, {
          "access-control-allow-origin": origin,
          // A rebuilt dataset can add icons while the gateway stays up (DatasetFingerprint resets
          // the index); the list is fetched once per page, so there is nothing to cache for.
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
        });
        response.end(data);
      } catch {
        indexes.macroIcons = undefined;
        respondError(response, 500, origin);
      }
      return;
    }

    // The stock achievement window's catalog (AchievementMetadata.ts), fetched once per page the
    // first time the window, a toast or an achievement chat line needs a name.
    if (request.method === "GET" && pathname === "/dbc/achievements" && options.dbcDirectory) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      if (url.searchParams.get("v") !== String(ACHIEVEMENT_CATALOG_VERSION)) {
        respondError(response, 400, origin);
        return;
      }
      try {
        const dbcDirectory = options.dbcDirectory;
        indexes.achievementCatalog ??= loadAchievementCatalog(dbcDirectory).then((catalog) => {
          const body = JSON.stringify(catalog);
          return { body, etag: `"${createHash("sha1").update(body).digest("hex")}"` };
        });
        const { body, etag } = await indexes.achievementCatalog;
        // A rebuilt dataset changes the body under the same path (DatasetFingerprint resets the
        // index): revalidate on every page, and answer 304 while the tables are unchanged.
        const cacheHeaders = {
          "access-control-allow-origin": origin,
          "cache-control": "public, max-age=0, must-revalidate",
          etag,
          "content-type": "application/json; charset=utf-8",
        };
        const ifNoneMatch = request.headers["if-none-match"];
        if (ifNoneMatch && ifNoneMatch.split(",").some((value) => value.trim() === etag || value.trim() === "*")) {
          response.writeHead(304, cacheHeaders);
          response.end();
          return;
        }
        response.writeHead(200, cacheHeaders);
        response.end(body);
      } catch {
        indexes.achievementCatalog = undefined;
        respondError(response, 500, origin);
      }
      return;
    }

    if (request.method === "GET" && pathname === "/dbc/barber-styles" && options.dbcDirectory) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      if (url.searchParams.get("v") !== "1") {
        respondError(response, 400, origin);
        return;
      }
      try {
        indexes.barberStyles ??= loadBarberStyles(options.dbcDirectory);
        const data = JSON.stringify(await indexes.barberStyles);
        response.writeHead(200, {
          "access-control-allow-origin": origin,
          "cache-control": "public, max-age=3600",
          "content-type": "application/json; charset=utf-8",
        });
        response.end(data);
      } catch {
        indexes.barberStyles = undefined;
        respondError(response, 500, origin);
      }
      return;
    }

    // gtBarberShopCostBase: the base haircut price by level, which the stock BarberShopFrame prices
    // its selection from with the core's own formula (BarberCostMetadata.ts).
    if (request.method === "GET" && pathname === "/dbc/barber-cost" && options.dbcDirectory) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      if (url.searchParams.get("v") !== "1") {
        respondError(response, 400, origin);
        return;
      }
      try {
        indexes.barberCosts ??= loadBarberCosts(options.dbcDirectory);
        const data = JSON.stringify(await indexes.barberCosts);
        response.writeHead(200, {
          "access-control-allow-origin": origin,
          "cache-control": "public, max-age=3600",
          "content-type": "application/json; charset=utf-8",
        });
        response.end(data);
      } catch {
        indexes.barberCosts = undefined;
        respondError(response, 500, origin);
      }
      return;
    }

    if (request.method === "GET" && pathname === "/dbc/character-stats" && options.dbcDirectory) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      try {
        indexes.characterStatData ??= loadCharacterStatData(options.dbcDirectory);
        const data = JSON.stringify(await indexes.characterStatData);
        response.writeHead(200, {
          "access-control-allow-origin": origin,
          "cache-control": "public, max-age=3600",
          "content-type": "application/json; charset=utf-8",
        });
        response.end(data);
      } catch {
        indexes.characterStatData = undefined;
        respondError(response, 500, origin);
      }
      return;
    }

    if (request.method === "GET" && pathname === "/dbc/talents" && options.dbcDirectory) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      try {
        indexes.talentData ??= loadTalentData(options.dbcDirectory);
        const data = JSON.stringify(await indexes.talentData);
        response.writeHead(200, {
          "access-control-allow-origin": origin,
          "cache-control": "public, max-age=3600",
          "content-type": "application/json; charset=utf-8",
        });
        response.end(data);
      } catch {
        respondError(response, 500, origin);
      }
      return;
    }

    if (request.method === "GET" && pathname === "/dbc/gameobjects" && options.dbcDirectory) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      const ids = [...new Set((url.searchParams.get("ids") ?? "")
        .split(",")
        .map(Number)
        .filter((id) => Number.isInteger(id) && id > 0))];
      if (ids.length === 0 || ids.length > 200) {
        respondError(response, 400, origin);
        return;
      }
      try {
        indexes.gameObjectMetadata ??= loadGameObjectDisplayMetadata(options.dbcDirectory);
        const metadata = await indexes.gameObjectMetadata;
        const data = JSON.stringify(ids.map((id) => metadata.get(id)).filter(Boolean));
        response.writeHead(200, {
          "access-control-allow-origin": origin,
          "cache-control": "public, max-age=3600",
          "content-type": "application/json; charset=utf-8",
        });
        response.end(data);
      } catch {
        respondError(response, 500, origin);
      }
      return;
    }

    // The path a lift runs on, by game object template entry. Asked for by entry rather than
    // served whole because 82 entries is 5,262 keyframes, and a player stands near one lift.
    if (request.method === "GET" && pathname === "/dbc/transport-paths" && options.dbcDirectory) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      const entries = [...new Set((url.searchParams.get("entries") ?? "")
        .split(",")
        .map(Number)
        .filter((entry) => Number.isInteger(entry) && entry > 0))];
      if (entries.length === 0 || entries.length > 200) {
        respondError(response, 400, origin);
        return;
      }
      try {
        indexes.transportPaths ??= loadTransportPaths(options.dbcDirectory);
        const paths = await indexes.transportPaths;
        // An entry with no path answers with its own number and no frames, so the browser learns
        // that this object does not move rather than asking again on every frame it is in view.
        const data = JSON.stringify(entries.map((entry) => paths.get(entry) ?? { entry, period: 0, frames: [] }));
        response.writeHead(200, {
          "access-control-allow-origin": origin,
          "cache-control": "public, max-age=3600",
          "content-type": "application/json; charset=utf-8",
        });
        response.end(data);
      } catch {
        respondError(response, 500, origin);
      }
      return;
    }

    // Which of the four surfaces each LiquidType row is drawn as. Twenty-six rows, so the whole
    // table travels at once and the browser asks for it exactly once per session.
    if (request.method === "GET" && pathname === "/dbc/liquid-types" && options.dbcDirectory) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      try {
        indexes.liquidClasses ??= loadLiquidClasses(options.dbcDirectory);
        const data = JSON.stringify(await indexes.liquidClasses);
        response.writeHead(200, {
          "access-control-allow-origin": origin,
          "cache-control": "public, max-age=3600",
          "content-type": "application/json; charset=utf-8",
        });
        response.end(data);
      } catch {
        respondError(response, 500, origin);
      }
      return;
    }

    // The world-entry curtain's art for every map: `Map.LoadingScreenID` → `LoadingScreens` row,
    // 100 maps and about 9 KB, so it travels whole and is asked for once a session.
    if (request.method === "GET" && pathname === "/dbc/loading-screens" && options.dbcDirectory) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      try {
        indexes.loadingScreens ??= loadLoadingScreens(options.dbcDirectory);
        const data = JSON.stringify(await indexes.loadingScreens);
        response.writeHead(200, {
          "access-control-allow-origin": origin,
          "cache-control": "public, max-age=3600",
          "content-type": "application/json; charset=utf-8",
        });
        response.end(data);
      } catch {
        // A rejected load must not be memoised: the next request after a dataset rebuild retries.
        indexes.loadingScreens = undefined;
        respondError(response, 500, origin);
      }
      return;
    }

    // What grows on a patch of ground: the 892 `GroundEffectTexture` rows that carry a doodad, and
    // the 485 models they name. The tile's own `cover.bin` says which effect id each detail cell
    // grows and this says what that id is, so the pair is the whole recipe; asked for once a
    // session, like the liquid table above.
    if (request.method === "GET" && pathname === "/dbc/ground-effects" && options.dbcDirectory) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      try {
        indexes.groundEffects ??= loadGroundEffects(options.dbcDirectory);
        const data = JSON.stringify(await indexes.groundEffects);
        response.writeHead(200, {
          "access-control-allow-origin": origin,
          "cache-control": "public, max-age=3600",
          "content-type": "application/json; charset=utf-8",
        });
        response.end(data);
      } catch {
        respondError(response, 500, origin);
      }
      return;
    }

    if (request.method === "GET" && pathname === "/dbc/creature-models" && options.dbcDirectory) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      const ids = [...new Set((url.searchParams.get("ids") ?? "")
        .split(",")
        .map(Number)
        .filter((id) => Number.isInteger(id) && id > 0))];
      if (ids.length === 0 || ids.length > 200) {
        respondError(response, 400, origin);
        return;
      }
      try {
        indexes.creatureModelMetadata ??= loadCreatureModelMetadata(
          options.dbcDirectory, characterTextures(), options.visualDbcDirectory,
          options.coordinatedVisuals ?? false);
        const metadata = await indexes.creatureModelMetadata;
        const data = JSON.stringify(ids.map((id) => metadata.get(id)).filter(Boolean));
        response.writeHead(200, {
          "access-control-allow-origin": origin,
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
        });
        response.end(data);
      } catch {
        respondError(response, 500, origin);
      }
      return;
    }

    /**
     * What a character of this race, sex and class may look like, so the creation form can offer it.
     *
     * The form used to send name, race, class, sex and five zeros, and zero is a legal appearance
     * — so the server accepted it and the character was born with `skin 0, face 0, hair 0`. For a
     * human male that hair row is `GeosetID 0`, `Showscalp 1` and three empty texture slots: bald,
     * correctly drawn, because bald is what was asked for. These are the choices that let it ask
     * for something else, listed out of the same tables the appearance itself is read from.
     *
     * The answer is five lists of indices and a map, not five counts — a count offers every gap
     * inside its range, and the twenty playable profiles had 1,900 such gaps between them. The
     * shape changed with it, so the request carries `v=` exactly as the appearance does. The
     * route now answers `no-store`; the version also separates these lists from older deployments
     * that cached counts. The optional `class` excludes death-knight-only sections for other classes.
     */
    if (request.method === "GET" && pathname === "/dbc/character-options" && options.dbcDirectory) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      const race = Number.parseInt(url.searchParams.get("race") ?? "", 10);
      const sex = Number.parseInt(url.searchParams.get("sex") ?? "", 10);
      const classParam = url.searchParams.get("class");
      const classId = classParam === null ? undefined : Number.parseInt(classParam, 10);
      if (!Number.isInteger(race) || race < 1 || race > 255 || (sex !== 0 && sex !== 1)
        || (classId !== undefined && (!Number.isInteger(classId) || classId < 1 || classId > 255))) {
        respondError(response, 400, origin);
        return;
      }
      try {
        indexes.characterAppearance ??= CharacterAppearanceIndex.load(
          options.dbcDirectory, characterTextures(), options.visualDbcDirectory,
          options.coordinatedVisuals ?? false);
        const data = JSON.stringify((await indexes.characterAppearance).options(race, sex, classId));
        response.writeHead(200, {
          "access-control-allow-origin": origin,
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
        });
        response.end(data);
      } catch {
        respondError(response, 500, origin);
      }
      return;
    }

    // A player has no baked texture, so its body and hair are looked up in CharSections from the
    // appearance bytes the server publishes.
    if (request.method === "GET" && pathname === "/dbc/character-appearance" && options.dbcDirectory) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      // `face` and `facialHair` are new; a caller that omits them gets 0, the plain look.
      const appearance = ["race", "sex", "skin", "face", "hair", "hairColor", "facialHair"]
        .map((name) => Number.parseInt(url.searchParams.get(name) ?? "0", 10));
      if (appearance.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
        respondError(response, 400, origin);
        return;
      }
      try {
        indexes.characterAppearance ??= CharacterAppearanceIndex.load(
          options.dbcDirectory, characterTextures(), options.visualDbcDirectory,
          options.coordinatedVisuals ?? false);
        const index = await indexes.characterAppearance;
        // Layers and geoset choices go out as data: the browser already fetches each texture by
        // path, so the pieces stay shared and the composite costs nothing on disk.
        // `items` is `slot:inventoryType:displayId[:subClass]` for what the character is wearing.
        const equipment = parseEquipment(url.searchParams.get("items") ?? "");
        const data = JSON.stringify(index.forPlayer(
          appearance[0]!, appearance[1]!, appearance[2]!, appearance[3]!,
          appearance[4]!, appearance[5]!, appearance[6]!, equipment));
        response.writeHead(200, {
          "access-control-allow-origin": origin,
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
        });
        response.end(data);
      } catch {
        respondError(response, 500, origin);
      }
      return;
    }

    // Who may be created, and what they are called. The creation form built its two lists from ten
    // hardcoded names each, so a race or a class a module adds could not be picked — and the names
    // it did have were this client's own translation rather than the dataset's. Deliberately not
    // part of `/dbc/character-options`: that answer is per race, sex and selected class and is being reshaped
    // by the appearance work, and two slices rewriting one payload is how a contract gets lost.
    if (request.method === "GET" && pathname === "/dbc/character-creation" && options.dbcDirectory) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      try {
        indexes.characterCreation ??= loadCharacterCreation(options.dbcDirectory);
        const data = JSON.stringify(await indexes.characterCreation);
        response.writeHead(200, {
          "access-control-allow-origin": origin,
          "cache-control": "public, max-age=3600",
          "content-type": "application/json; charset=utf-8",
        });
        response.end(data);
      } catch {
        // Dropped rather than kept, as `/dbc/areas` does: a table half-written by a dataset build
        // in progress would otherwise answer 500 until somebody restarted the gateway.
        indexes.characterCreation = undefined;
        respondError(response, 500, origin);
      }
      return;
    }

    /**
     * What a newly created character of this race, class and sex is wearing.
     *
     * The creation screen's 3D preview is the only caller, and it needs the answer in the same
     * spelling `/dbc/character-appearance` takes: `slot:inventoryType:displayId`. `CharStartOutfit`
     * carries the display id directly, so this walks no `Item.dbc` chain — see
     * `CharStartOutfit.ts` for the measurement that says the column is the right one.
     *
     * `v=` marks the payload contract as on `/dbc/character-options`. This route answers
     * `max-age=3600`, so a shape change without a new query string would be served out of a
     * browser's own cache for an hour.
     */
    if (request.method === "GET" && pathname === "/dbc/char-start-outfit" && options.dbcDirectory) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      const race = Number.parseInt(url.searchParams.get("race") ?? "", 10);
      const classId = Number.parseInt(url.searchParams.get("class") ?? "", 10);
      const sex = Number.parseInt(url.searchParams.get("sex") ?? "", 10);
      const outfit = Number.parseInt(url.searchParams.get("outfit") ?? "0", 10);
      const byte = (value: number) => Number.isInteger(value) && value >= 0 && value <= 255;
      if (!byte(race) || race < 1 || !byte(classId) || classId < 1 || (sex !== 0 && sex !== 1)
        || !byte(outfit)) {
        respondError(response, 400, origin);
        return;
      }
      try {
        indexes.charStartOutfit ??= CharStartOutfitIndex.load(options.dbcDirectory);
        const data = JSON.stringify((await indexes.charStartOutfit).outfit(race, classId, sex, outfit));
        response.writeHead(200, {
          "access-control-allow-origin": origin,
          "cache-control": "public, max-age=3600",
          "content-type": "application/json; charset=utf-8",
        });
        response.end(data);
      } catch {
        indexes.charStartOutfit = undefined;
        respondError(response, 500, origin);
      }
      return;
    }

    // A spell's picture, and the one a hunter pet family shows on its tab. Modelled on
    // `/item-icon` down to the failure memory, and here for the same reason: `SpellIcon` is a
    // table a module writes rows into, and until this route existed the only thing that turned a
    // row into a picture was an operator rerunning `build-assets.bat`. The published directories
    // are the warm cache and are checked first, so nothing that was already there costs an
    // extraction.
    const spellIcon = pathname.match(/^\/spell-icon\/(\d{1,8})$/);
    const creatureIcon = pathname.match(/^\/creature-icon\/(\d{1,8})$/);
    const iconRequest = spellIcon
      ? {
        id: Number(spellIcon[1]),
        family: "spell",
        directory: options.spellIconsDirectory,
        generate: options.generateSpellIcon,
      }
      : creatureIcon
        ? {
          id: Number(creatureIcon[1]),
          family: "family",
          directory: options.creatureIconsDirectory,
          generate: options.generateCreatureIcon,
        }
        : undefined;
    if (request.method === "GET" && iconRequest && iconRequest.directory) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      const { id, family, directory, generate } = iconRequest;
      // On the parsed number and not on the digits that were typed, the way `/item-icon` keys on
      // `String(displayId)`. `\d{1,8}` spells one icon up to eight ways — `/spell-icon/080901` is
      // the same file as `/spell-icon/80901` — and a key made of the capture gave each spelling a
      // failure memory of its own, so eight requests could each spawn the generator for a picture
      // already known not to exist. `ensureCurrent` was already keyed on the filename.
      const key = `${family}:${id}`;
      const filename = join(directory, `${id}.png`);
      try {
        const rebuild = () => generateOnce(spellIconLane, key, () => generate!(id));
        // An entry with no stamp is the warm cache, not a stale picture: it is served as it
        // stands, and `restampCaches` — started once at startup, off every request path — is what
        // gives it one.
        if (generate) await fingerprint.ensureCurrent(filename);
        let data: Buffer;
        try {
          data = await readFile(filename);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !generate) throw error;
          // An id that names no picture in this dataset is a 404 and not a 500: 22 of the 3,226
          // stock `SpellIcon` rows point at a file no archive holds, and the browser drops the
          // element and keeps the coloured square either way. The generator's failure is already
          // remembered by the lane, so the second request answers without spawning it again — it
          // is the read below, not the run above, that says the icon is not there.
          //
          // Swallowed, but said once: `runAssetGenerator` puts the child's stderr in the rejection
          // message and this is its only reader, so without the line a mis-set `DBC_DIR` or a full
          // disk is indistinguishable from one of those 22 rows — 404s and coloured squares with
          // nothing written anywhere. Once per key rather than once per request, because the lane
          // answers the next five minutes of requests from memory without running anything.
          const known = recentlyFailed(spellIconLane, key);
          await rebuild().catch((failure: unknown) => {
            if (!known) console.warn(`No picture for ${key}: ${failure instanceof Error ? failure.message : String(failure)}`);
          });
          data = await readFile(filename);
        }
        response.writeHead(200, {
          "access-control-allow-origin": origin,
          "cache-control": "public, max-age=86400",
          "content-length": data.byteLength,
          "content-type": "image/png",
        });
        response.end(data);
      } catch (error) {
        respondError(response, (error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500, origin);
      }
      return;
    }

    /**
     * What a weapon sounds like when it swings, lands, misses, is parried or is blocked.
     *
     * The two tables and the swing sizes come back whole — 4,671 bytes on this dataset, «fetch
     * once and hold for the session», the shape `/dbc/spell-kit-sounds` already uses — because a
     * swing's noise belongs to the moment it happens and a round trip there arrives after it.
     *
     * `Item.dbc` does **not** come back whole. It is 46,098 rows, which is 796 KB of JSON even
     * flattened to bare numbers against 18.2 KB for the 200 entries this answers at once, and a
     * session cares about the handful of items the two fighters have on. `?items=` is that batch,
     * and it answers with the items **instead of** the tables rather than beside them: the tables
     * are fetched once and held, and repeating 4,671 bytes of them on every batch would be the
     * whole payload again for nothing.
     */
    if (request.method === "GET" && pathname === "/dbc/weapon-sounds" && options.dbcDirectory) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      const entries = [...new Set((url.searchParams.get("items") ?? "")
        .split(",")
        .map(Number)
        .filter((entry) => Number.isInteger(entry) && entry > 0))];
      if (entries.length > 200) {
        respondError(response, 400, origin);
        return;
      }
      try {
        indexes.weaponSounds ??= WeaponSoundIndex.load(options.dbcDirectory);
        const index = await indexes.weaponSounds;
        const data = JSON.stringify(entries.length > 0
          ? { items: entries.map((entry) => index.item(entry)).filter(Boolean) }
          : index.tables());
        response.writeHead(200, {
          "access-control-allow-origin": origin,
          "cache-control": "public, max-age=3600",
          "content-type": "application/json; charset=utf-8",
        });
        response.end(data);
      } catch {
        // Dropped rather than kept, as `/dbc/areas` does: a DBC half-written by a dataset build
        // would otherwise answer 500 until somebody restarted the gateway.
        indexes.weaponSounds = undefined;
        respondError(response, 500, origin);
      }
      return;
    }

    if (request.method === "GET" && pathname === "/data/creatures" && options.creatureMetadataFile) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      const entries = [...new Set((url.searchParams.get("entries") ?? "")
        .split(",")
        .map(Number)
        .filter((entry) => Number.isInteger(entry) && entry > 0))];
      if (entries.length === 0 || entries.length > 200) {
        respondError(response, 400, origin);
        return;
      }
      try {
        indexes.creatureMetadata ??= loadCreatureMetadata(options.creatureMetadataFile);
        const metadata = await indexes.creatureMetadata;
        const data = JSON.stringify(entries.map((entry) => metadata.get(entry)).filter(Boolean));
        response.writeHead(200, {
          "access-control-allow-origin": origin,
          "cache-control": "public, max-age=300",
          "content-type": "application/json; charset=utf-8",
        });
        response.end(data);
      } catch {
        respondError(response, 500, origin);
      }
      return;
    }

    if (request.method === "GET" && pathname === "/dbc/item-enchantments" && options.dbcDirectory) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      try {
        indexes.itemEnchantments ??= loadItemEnchantments(options.dbcDirectory);
        const data = JSON.stringify(await indexes.itemEnchantments);
        response.writeHead(200, {
          "access-control-allow-origin": origin,
          "cache-control": "no-cache",
          "content-type": "application/json; charset=utf-8",
        });
        response.end(data);
      } catch {
        indexes.itemEnchantments = undefined;
        respondError(response, 500, origin);
      }
      return;
    }

    /**
     * `ItemSubClass.dbc` whole — 119 rows, 8 KB — for the words on an item tooltip's slot row: the
     * «Топор» beside «Двуручное», the «Латы» beside «Грудь». Keyed on class and subclass, which the
     * item query carries, so the browser asks once per session and joins it itself. `no-cache`
     * like the enchantments beside it: a rebuilt dataset is then read at the next session, not an
     * hour later.
     */
    if (request.method === "GET" && pathname === "/dbc/item-subclasses" && options.dbcDirectory) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      try {
        indexes.itemSubclassNames ??= loadItemSubclassNames(options.dbcDirectory);
        const data = JSON.stringify(await indexes.itemSubclassNames);
        response.writeHead(200, {
          "access-control-allow-origin": origin,
          "cache-control": "no-cache",
          "content-type": "application/json; charset=utf-8",
        });
        response.end(data);
      } catch {
        indexes.itemSubclassNames = undefined;
        respondError(response, 500, origin);
      }
      return;
    }

    if (request.method === "GET" && pathname === "/data/items" && options.itemMetadataFile) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      const entries = [...new Set((url.searchParams.get("entries") ?? "")
        .split(",")
        .map(Number)
        .filter((entry) => Number.isInteger(entry) && entry > 0))];
      if (entries.length === 0 || entries.length > 200) {
        respondError(response, 400, origin);
        return;
      }
      try {
        indexes.itemMetadata ??= loadItemMetadata(options.itemMetadataFile);
        const metadata = await indexes.itemMetadata;
        const data = JSON.stringify(entries.map((entry) => metadata.get(entry)).filter(Boolean));
        response.writeHead(200, {
          "access-control-allow-origin": origin,
          "cache-control": "public, max-age=300",
          "content-type": "application/json; charset=utf-8",
        });
        response.end(data);
      } catch {
        respondError(response, 500, origin);
      }
      return;
    }

    const environmentModel = pathname.match(/^\/environment\/model\/([A-Za-z0-9_.-]{1,200})$/);
    if (request.method === "GET" && environmentModel && options.buildingsDirectory) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      const name = environmentModel[1]!;
      try {
        let job = environmentModels.get(name);
        if (!job) {
          const filename = name.toLowerCase().endsWith(".wmo") ? `${name}.vmo` : name;
          job = readFile(join(options.buildingsDirectory, filename))
            .then((file) => encodeVMapModel(parseVMapModel(file)))
            .catch((error) => {
              environmentModels.delete(name);
              throw error;
            });
          environmentModels.set(name, job);
        }
        const data = await job;
        response.writeHead(200, {
          "access-control-allow-origin": origin,
          "cache-control": "public, max-age=86400",
          "content-length": data.byteLength,
          "content-type": "application/octet-stream",
        });
        response.end(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
      } catch (error) {
        respondError(response, (error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500, origin);
      }
      return;
    }

    // The server's own collision geometry, by the name the vmap tile calls the model.
    //
    // Groups rather than a file: a WMO is already stored as one, and a city is hundreds of
    // thousands of triangles that no browser has any business downloading whole. A model under the
    // budget arrives complete on the first request; a bigger one answers with its groups' boxes
    // and nothing else, and the caller comes back naming the handful it is standing in.
    const collisionModel = pathname.match(/^\/collision\/model\/([A-Za-z0-9_.-]{1,200})$/);
    if (request.method === "GET" && collisionModel && options.buildingsDirectory) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      const name = collisionModel[1]!;
      const wanted = url.searchParams.get("groups");
      let include: Set<number> | undefined;
      if (wanted !== null) {
        include = new Set(wanted.split(",").map(Number).filter((id) => Number.isInteger(id) && id >= 0));
        if (include.size > 512) {
          respondError(response, 400, origin);
          return;
        }
      }
      try {
        let job = collisionModels.get(name);
        if (!job) {
          // A WMO's collision sits beside it as `<name>.vmo`; an M2's is the file itself, which is
          // already in this format. That is how the extractor writes them.
          //
          // Except when it does not: the extractor also writes `<name>.m2.vmo` for M2 rows (every
          // tree in Elwynn, for example), and asking for the bare name then answers ENOENT while
          // the server happily collides with the same tree. Fall back to the suffixed file before
          // reporting the model missing, so the client and the server collide with one world.
          const filename = name.toLowerCase().endsWith(".wmo") ? `${name}.vmo` : name;
          const buildings = options.buildingsDirectory;
          const readCollisionFile = async (): Promise<Buffer> => {
            try {
              return await readFile(join(buildings, filename));
            } catch (error) {
              if (!name.toLowerCase().endsWith(".wmo")
                && (error as NodeJS.ErrnoException).code === "ENOENT") {
                return await readFile(join(buildings, `${name}.vmo`));
              }
              throw error;
            }
          };
          job = readCollisionFile()
            .then((file) => parseVMapModelGroups(file))
            .catch((error) => {
              collisionModels.delete(name);
              throw error;
            });
          collisionModels.set(name, job);
        }
        const groups = await job;
        const triangles = groups.reduce((sum, group) => sum + group.indices.length / 3, 0);
        // No explicit choice and too big to send: the header alone, so the caller can choose.
        const selected = include ?? (triangles > COLLISION_TRIANGLE_BUDGET ? new Set<number>() : undefined);
        const data = encodeCollisionModel(groups, selected);
        response.writeHead(200, {
          "access-control-allow-origin": origin,
          "cache-control": "public, max-age=86400",
          "content-length": data.byteLength,
          "content-type": "application/octet-stream",
        });
        response.end(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
      } catch (error) {
        // VMAP tiles contain many render-only M2 names. No collision is a valid answer, not a
        // failed resource load; 204 keeps DevTools quiet while malformed requests and I/O/parser
        // failures still take their normal 4xx/500 paths.
        respondError(response, (error as NodeJS.ErrnoException).code === "ENOENT" ? 204 : 500, origin);
      }
      return;
    }

    const environment = pathname.match(/^\/environment\/(\d{1,4})\/(\d{1,2})\/(\d{1,2})$/);
    if (request.method === "GET" && environment && options.vmapsDirectory) {
      const origin = request.headers.origin;
      if (!originAllowed(origin, options.allowedOrigins)) {
        response.writeHead(403).end();
        return;
      }
      const map = Number(environment[1]);
      const gridX = Number(environment[2]);
      const gridY = Number(environment[3]);
      if (gridX > 63 || gridY > 63) {
        respondError(response, 400, origin);
        return;
      }

      const filename = `${String(map).padStart(3, "0")}_${String(gridY).padStart(2, "0")}_${String(gridX).padStart(2, "0")}.vmtile`;
      try {
        let objects: EnvironmentObject[];
        try {
          objects = parseVMapTile(await readFile(join(options.vmapsDirectory, filename)));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          // No tile: either nothing stands here, or the map is one WMO with no tiles at all, whose
          // spawn lives in its tree (`parseVMapGlobalSpawn`). That one answers every cell its box
          // reaches; the rest of such a map is empty, not missing. A tiled map's absent tile is
          // still the 404 it was.
          const tree = await readFile(join(options.vmapsDirectory, `${String(map).padStart(3, "0")}.vmtree`));
          const global = parseVMapGlobalSpawn(tree);
          if (!global) throw error;
          objects = environmentObjectInGrid(global, gridX, gridY) ? [global] : [];
        }
        const data = JSON.stringify(objects);
        response.writeHead(200, {
          "access-control-allow-origin": origin,
          "cache-control": "public, max-age=3600",
          "content-type": "application/json; charset=utf-8",
        });
        response.end(data);
      } catch (error) {
        respondError(response, (error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500, origin);
      }
      return;
    }
    // The routing fallback has no handler above it to have checked the origin, so it checks here.
    const unmatchedOrigin = request.headers.origin;
    respondError(response, 404, originAllowed(unmatchedOrigin, options.allowedOrigins) ? unmatchedOrigin : undefined);
  })().catch((error: unknown) => {
    // Every route has its own try/catch, but the code between them does not — the URL parse, the
    // regex preamble, and respondError itself, which throws ERR_HTTP_HEADERS_SENT if a 200 header
    // already went out. Node 20 defaults to --unhandled-rejections=throw, so without this one
    // slip would take the process down and drop every bridged player mid-session.
    console.error(`Unhandled error serving ${request.method} ${request.url}:`, error);
    if (!response.headersSent) respondError(response, 500, undefined);
    else response.destroy();
  });
  if (options.restampCaches) {
    void generateOnce(restampLane, RESTAMP_KEY, options.restampCaches).catch((error: unknown) => {
      console.warn(`Not stamping the published cache: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  return {
    handle,
    close: () => fingerprint.close(),
    patchSummary: () => patches.summary(),
    patchStatus: () => patches.details(fingerprint.epoch),
    checkPatchChain: async () => {
      if (fingerprint.watching) await observeDataset();
      return patches.summary();
    },
    get patchEventsPending() { return fingerprint.archiveEventsPending; },
  };
}

export async function startGateway(options: GatewayOptions): Promise<RunningGateway> {
  const assets = await createGatewayAssetHandler(options);
  const server: HttpServer = createServer(assets.handle);
  const authServer = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_MESSAGE, perMessageDeflate: false });
  const worldServer = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_MESSAGE, perMessageDeflate: false });

  // Each bridge holds one authserver or worldserver socket for as long as the browser keeps it,
  // so the counts below are what stops one caller from exhausting the emulator's socket budget.
  // They are a resource limit, not authentication: Origin is a client-supplied header and any
  // script can set it, so the gateway still belongs behind something that knows who is calling.
  let bridged = 0;
  const bridgedPerAddress = new Map<string, number>();

  const track = (webSocket: WebSocket, address: string, target: GatewayTarget): void => {
    bridged++;
    bridgedPerAddress.set(address, (bridgedPerAddress.get(address) ?? 0) + 1);
    webSocket.once("close", () => {
      bridged--;
      const remaining = (bridgedPerAddress.get(address) ?? 1) - 1;
      if (remaining > 0) bridgedPerAddress.set(address, remaining);
      else bridgedPerAddress.delete(address);
    });
    bridge(webSocket, target);
  };

  authServer.on("connection", (socket, request) => track(socket, peerAddress(request), options.auth));
  worldServer.on("connection", (socket, request) => track(socket, peerAddress(request), options.world));

  // Nothing in here may throw or leave an `error` unheard: Node has already taken its own handling
  // off the socket, so either one would end the process (see UpgradeGuard.ts). Refusals go only
  // through `refuseUpgrade`, which answers and then destroys.
  server.on("upgrade", (request, socket, head) => {
    socket.on("error", () => socket.destroy());
    try {
      const route = routeUpgrade(request, { allowedOrigins: options.allowedOrigins });
      if (route.kind === "refuse") {
        refuseUpgrade(socket, route.status);
        return;
      }
      const address = peerAddress(request);
      if (bridged >= MAX_BRIDGED_SOCKETS || (bridgedPerAddress.get(address) ?? 0) >= MAX_BRIDGED_SOCKETS_PER_ADDRESS) {
        refuseUpgrade(socket, 503);
        return;
      }
      const selected = route.kind === "auth" ? authServer : worldServer;
      selected.handleUpgrade(request, socket, head, (webSocket) => selected.emit("connection", webSocket, request));
    } catch (error) {
      console.error("Gateway: the upgrade handler failed; answered 500:", error);
      refuseUpgrade(socket, 500);
    }
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port, options.host, () => {
        server.off("error", reject);
        // From here an `error` is the running server's, not a failed start. A failed accept is thrown
        // on with a line that says so: on Windows the server never accepts again after one, and the
        // process guard closes the gateway in order rather than leave it deaf. Anything else is only
        // logged (`listeningServerError`, ProcessGuard.ts).
        server.on("error", (error) => listeningServerError(error));
        resolve();
      });
    });
  } catch (error) {
    assets.close();
    throw error;
  }

  const address = server.address();
  if (!address || typeof address === "string") {
    assets.close();
    throw new Error("Gateway did not bind a TCP address");
  }

  return {
    host: options.host,
    port: address.port,
    close: async () => {
      assets.close();
      for (const webSocket of [...authServer.clients, ...worldServer.clients]) webSocket.terminate();
      await Promise.all([
        new Promise<void>((resolve) => authServer.close(() => resolve())),
        new Promise<void>((resolve) => worldServer.close(() => resolve())),
        new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
      ]);
    },
    patchSummary: () => assets.patchSummary(),
    patchStatus: () => assets.patchStatus(),
    checkPatchChain: () => assets.checkPatchChain(),
    get patchEventsPending() { return assets.patchEventsPending; },
    connections: () => ({ auth: authServer.clients.size, world: worldServer.clients.size }),
  };
}

/**
 * An error response has to carry the CORS header too. Without it the browser reports every 400,
 * 404 and 500 as a cross-origin failure and the real status never reaches the page. A rejected
 * origin is the one exception: echoing it back would defeat the check.
 */
function respondRevalidated(
  request: IncomingMessage,
  response: ServerResponse,
  data: Buffer,
  origin: string | undefined,
  contentType: string,
): void {
  const etag = `"${createHash("sha1").update(data).digest("hex")}"`;
  const headers = {
    ...(origin ? { "access-control-allow-origin": origin } : {}),
    "cache-control": "public, max-age=0, must-revalidate",
    "content-type": contentType,
    etag,
  };
  const ifNoneMatch = request.headers["if-none-match"];
  if (ifNoneMatch && ifNoneMatch.split(",").some((value) => value.trim() === etag || value.trim() === "*")) {
    response.writeHead(304, headers);
    response.end();
    return;
  }
  response.writeHead(200, { ...headers, "content-length": data.byteLength });
  response.end(data);
}

function respondError(response: ServerResponse, status: number, origin: string | undefined): void {
  response.writeHead(status, origin ? { "access-control-allow-origin": origin } : {}).end();
}

function respondClientVisualProfileChanged(response: ServerResponse, origin: string | undefined): void {
  const data = JSON.stringify({
    error: "client_patch_chain_changed",
    message: "The client patch set changed while the gateway was running. Restart the gateway and reload the client to apply it atomically.",
  });
  response.writeHead(409, {
    ...(origin ? { "access-control-allow-origin": origin } : {}),
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
  });
  response.end(data);
}

/**
 * The whole body of a request, or `undefined` once it has gone past a ceiling.
 *
 * Counted as it arrives rather than trusted from `content-length`: a header is what the sender
 * says, and this process would otherwise hold whatever was actually sent.
 *
 * Past the ceiling the chunks are dropped but the stream is still drained, and that is deliberate:
 * destroying it on the first byte over kills the connection before the 413 can be written, and the
 * browser reports a network failure instead of the answer that says what was wrong. Draining is
 * bounded in turn — eight times the ceiling and the socket really is destroyed, because at that
 * point the sender is not going to read the answer either.
 */
const BODY_DRAIN_LIMIT = 8;

async function readRequestBody(request: IncomingMessage, limit: number): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  let over = false;
  for await (const chunk of request) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += part.byteLength;
    if (total > limit) {
      over = true;
      chunks.length = 0;
      if (total > limit * BODY_DRAIN_LIMIT) {
        request.destroy();
        return undefined;
      }
      continue;
    }
    chunks.push(part);
  }
  return over ? undefined : Buffer.concat(chunks);
}

/**
 * `slot:inventoryType:displayId[:subClass]` entries, ignoring anything malformed rather than
 * failing the request. The fourth field is optional for old browser clients.
 *
 * The slot is which of the nineteen PLAYER_VISIBLE_ITEM words the item came from, and it is not
 * redundant with the inventory type: a one-handed weapon is INVTYPE_WEAPON in either hand, so
 * without it there is no telling which hand to put a sword in.
 */
function parseEquipment(spec: string): { slot: number; inventoryType: number; displayId: number; subClass?: number }[] {
  const items: { slot: number; inventoryType: number; displayId: number; subClass?: number }[] = [];
  for (const entry of spec.split(",")) {
    const parts = entry.split(":");
    if (parts.length !== 3 && parts.length !== 4) continue;
    const [slot, inventoryType, displayId, subClass] = parts.map((part) => Number.parseInt(part, 10));
    if (!Number.isInteger(slot) || slot! < 0 || slot! > 18) continue;
    if (!Number.isInteger(inventoryType) || inventoryType! < 0 || inventoryType! > 30) continue;
    if (!Number.isInteger(displayId) || displayId! <= 0 || displayId! > 1_000_000) continue;
    if (parts.length === 4 && (!Number.isInteger(subClass) || subClass! < 0 || subClass! > 255)) continue;
    items.push({
      slot: slot!, inventoryType: inventoryType!, displayId: displayId!,
      ...(parts.length === 4 ? { subClass: subClass! } : {}),
    });
    // A character has nineteen visible slots; anything past that is not a real request.
    if (items.length >= 20) break;
  }
  return items;
}

/** A path that could name a texture inside the archives. */
function validTexturePath(value: string): boolean {
  // Parentheses are in five real filenames the client ships, all PvP shoulder textures spelt
  // `..._B_01Gold(Left).blp`. They are ordinary characters in a path, not a traversal risk.
  return validAssetPath(value, { extensions: ["blp"] });
}

/** A path that could name a sound inside the archives. */
function validSoundPath(value: string): boolean {
  // The apostrophe is in the client's own filenames, on the Nightmare and Ghoul voice sets.
  return validAssetPath(value, { extensions: ["wav", "mp3"] });
}

/**
 * A path that could name a model inside the archives.
 *
 * The ampersand is not an oversight to be tolerated — it is in the client's own directory names,
 * `PASSIVE DOODADS\FOOD&UTENSILS` and `WEAPONS&ARMOR`. Measured over 46,064 placement names from
 * real tiles, it is the ONLY character outside this class that occurs at all, 780 times. Leaving
 * it out answered 400 to every request for a doodad in those two directories, and a 400 is not
 * retried, so the plates, the cleavers and the wall weapons of every human building were missing
 * for good.
 */
function validVisualModelPath(path: string): boolean {
  return validAssetPath(path, { extensions: ["m2", "wmo"] });
}

/**
 * The four extensions `/client/file` will serve, lower case and without the dot.
 *
 * Exported because it is the route's security boundary rather than a detail of it, and a boundary
 * that is only asserted through a running server is one nobody re-checks. `.lua` and `.xml` are what
 * an interface *is*; `.toc` is the manifest that names them; `.ttf` is what the owner's login screen
 * draws its text with (`Fonts\` holds nine of them in this client, and a module ships its own
 * beside its assets). Everything else in the archives has its own route or has no business leaving
 * this machine.
 */
export const CLIENT_FILE_EXTENSIONS = ["lua", "xml", "toc", "ttf"] as const;

/** A path that could name an interface file inside the archives. */
export function validClientFilePath(value: string): boolean {
  return validAssetPath(value, { extensions: CLIENT_FILE_EXTENSIONS, allowBang: true });
}

/**
 * What `/client/file` calls each of the four, given the extension with its dot.
 *
 * **The charset is measured, not assumed.** A 3.3.5a ruRU client is the case where this could have
 * gone wrong: the game itself renders Lua strings through the locale codepage, so cp1251 was the
 * expected answer and would have made `charset=utf-8` turn every Russian label into mojibake.
 * Counted over this machine's client, decoding each file with a strict UTF-8 decoder: 1,101 `.lua`,
 * `.xml` and `.toc` files inside the six stock ruRU archives (`locale-ruRU`, `patch-ruRU`,
 * `patch-ruRU-2`, `patch-ruRU-3`, and the two expansion locale archives), 15 of them carrying bytes
 * above 0x7F, and **not one that is not valid UTF-8** — no BOM on any of them either. The live
 * chain agrees: all 561 interface text files the chain resolves, 56 with high bytes, every one
 * valid UTF-8. `GlueStrings.lua` decoded as cp1251 reads `РЎРїРѕСЃРѕР±РЅРѕСЃС‚`, and as UTF-8 reads
 * `Способност`, which settles it in the only direction it can be settled.
 *
 * So the route declares the encoding rather than shipping `application/octet-stream` and leaving
 * every caller to sniff. That is the whole difference between `response.text()` working and a
 * runtime needing its own decoder before it can read a single `.toc` line.
 */
export function clientFileContentType(extension: string): string {
  return extension.toLowerCase() === ".ttf" ? "font/ttf" : "text/plain; charset=utf-8";
}
