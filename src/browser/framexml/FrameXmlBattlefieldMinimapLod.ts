/**
 * L17 3.14: stock Blizzard_BattlefieldMinimap — the zone minimap a battleground shows under the
 * minimap (Shift+M, the world map's «Карта зоны» dropdown) — loaded on demand through the host.
 *
 * Three stock paths reach it, each «if it may be shown: load it unless loaded, then
 * `BattlefieldMinimap:Show()`»: WorldStateFrame_ToggleBattlefieldMinimap on every PLAYER_ENTERING_WORLD
 * (WorldStateFrame.lua:359-373), UIParent's VARIABLES_LOADED (UIParent.lua:458-462) and the world map's
 * zone-map dropdown (WorldMapFrame.lua:691-695); the key binding's ToggleBattlefieldMinimap
 * (UIParent.lua:392-397) loads and calls BattlefieldMinimap_Toggle. The permission is
 * `WorldStateFrame_CanShowBattlefieldMinimap` (:376-386): `IsInInstance()` "pvp" with the CVar
 * showBattlefieldMinimap "1", or "none" with "2". Wow.exe's LoadAddOn is synchronous (0x00528920); the
 * files here come over the network, so the owner keeps the stock decisions and defers their effect:
 *
 * * Until the add-on is in and has passed its gate, `WorldStateFrame_CanShowBattlefieldMinimap` asks
 *   stock and answers false — so no path indexes a nil `BattlefieldMinimap` — and a true answer asks for
 *   the load with the intent «show»; `ToggleBattlefieldMinimap` asks with «toggle»;
 *   `BattlefieldMinimap_LoadUI` asks with no intent. The hooks are installed before the session events
 *   (the world mount's `beforeExercise`); the load itself starts once the stock HUD is published.
 * * After the gate, the intents run in the order they came: «show» is stock
 *   WorldStateFrame_ToggleBattlefieldMinimap (it asks the permission again), «toggle» stock
 *   BattlefieldMinimap_Toggle. From then on the three functions are stock's own.
 * * The gate: the add-on's frames are where its XML puts them, its functions are real, its saved
 *   options are a table (SavedVariablesPerCharacter, FrameXmlSavedVariables.ts, restored before
 *   ADDON_LOADED), and stock BattlefieldMinimap_Update runs without a Lua error. A load, gate or Lua
 *   failure demotes for good: the frames stop listening and hide, and the permission stays false.
 *
 * Its own C functions are FrameXmlBattlefieldMinimapApi.ts', the map's FrameXmlMap.ts' (with the
 * battlefield source FrameXmlBattlefieldMapSource.ts). Nothing loads outside a battleground unless the
 * player chose «always» (CVar "2") or presses the key.
 */
import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import type { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import { frameXmlSilentProbe } from "./FrameXmlGameMenuOwner.js";

export const FRAMEXML_BATTLEFIELD_MINIMAP_ADDON = "Blizzard_BattlefieldMinimap";
const REQUEST_GLOBAL = "__webclientBattlefieldMinimapRequest";
const READY_GLOBAL = "__webclientBattlefieldMinimapReady";
/** NUM_WORLDMAP_DETAIL_TILES, MAX_PARTY_MEMBERS, MAX_RAID_MEMBERS and the two flags of its XML. */
const TILES = 12;
const PARTY = 4;
const RAID = 40;
const FLAGS = 2;
/** A burst of stock asks before the files are in is replayed in order; more than this is noise. */
const MAX_INTENTS = 8;

export type FrameXmlBattlefieldMinimapIntent = "load" | "show" | "toggle";
export type FrameXmlBattlefieldMinimapState = "idle" | "waiting" | "loading" | "ready" | "failed";

type GateBoot = Pick<FrameXmlBoot, "vm" | "bridge" | "errorCount">;
type OwnerBoot = GateBoot & Pick<FrameXmlBoot, "loadAddon">;
type OwnerRenderer = Pick<FrameXmlDomRenderer, "addRoots" | "sync">;

/** The add-on's frames, their widget type and the parent each hangs from. */
function minimapFrames(): readonly (readonly [name: string, type: string, parent: string])[] {
  const frames: [string, string, string][] = [
    ["BattlefieldMinimap", "Frame", "UIParent"],
    ["BattlefieldMinimapTab", "Button", "UIParent"],
    ["BattlefieldMinimapCloseButton", "Button", "BattlefieldMinimap"],
    ["PlayerMiniArrowEffectFrame", "Frame", "BattlefieldMinimap"],
  ];
  for (let index = 1; index <= TILES; index += 1) frames.push([`BattlefieldMinimap${index}`, "Texture", "BattlefieldMinimap"]);
  for (let index = 1; index <= PARTY; index += 1) frames.push([`BattlefieldMinimapParty${index}`, "Frame", "BattlefieldMinimap"]);
  for (let index = 1; index <= RAID; index += 1) frames.push([`BattlefieldMinimapRaid${index}`, "Frame", "BattlefieldMinimap"]);
  for (let index = 1; index <= FLAGS; index += 1) frames.push([`BattlefieldMinimapFlag${index}`, "Frame", "BattlefieldMinimap"]);
  return frames;
}

const STOCK_GLOBALS: readonly string[] = [
  "BattlefieldMinimap_Toggle", "BattlefieldMinimap_OnEvent", "BattlefieldMinimap_OnUpdate",
  "BattlefieldMinimap_Update", "BattlefieldMinimap_UpdateOpacity", "BattlefieldMinimapTab_OnClick",
];

function hasGlobalFunction(boot: GateBoot, name: string): boolean {
  const ref = boot.vm.globalFunction(name);
  if (!ref) return false;
  boot.vm.release(ref);
  return true;
}

/** Structural and transactional proof that the loaded add-on can own the battlefield minimap. */
export function frameXmlBattlefieldMinimapGate(boot: GateBoot): boolean {
  try {
    for (const [name, type, parent] of minimapFrames()) {
      const frame = boot.bridge.getFrame(name);
      if (!frame || frame.type !== type || frame.parent?.name !== parent) return false;
    }
    if (!STOCK_GLOBALS.every((name) => hasGlobalFunction(boot, name))) return false;
    const errors = boot.errorCount;
    const diagnostics = boot.bridge.diagnostics.length;
    const probe = frameXmlSilentProbe(boot, "webclient/battlefield-minimap-gate", `
      if type(BattlefieldMinimapOptions) ~= "table" then return false end
      BattlefieldMinimap_Update()
      return true
    `, 1);
    return probe?.[0] === true && boot.errorCount === errors && boot.bridge.diagnostics.length === diagnostics;
  } catch {
    return false;
  }
}

/** A failed add-on: its frames stop listening and hide, so no stock handler runs it again. */
function silence(boot: GateBoot): void {
  frameXmlSilentProbe(boot, "webclient/battlefield-minimap-silence", `
    for _, name in ipairs({ "BattlefieldMinimap", "BattlefieldMinimapTab" }) do
      local frame = _G[name]
      if type(frame) == "table" and frame.UnregisterAllEvents then
        frame:UnregisterAllEvents()
        frame:SetScript("OnUpdate", nil)
        frame:Hide()
      end
    end
  `, 0);
}

export interface FrameXmlBattlefieldMinimapOwner {
  readonly state: FrameXmlBattlefieldMinimapState;
  /** A stock path asked for the add-on (the Lua hooks below). */
  request(intent: FrameXmlBattlefieldMinimapIntent): void;
  /** The stock HUD is published: a load asked for before starts now. Returns the cleanup. */
  publish(renderer: OwnerRenderer): () => void;
  /** Resolves when the load in flight has settled (at once when none is). */
  settled(): Promise<void>;
  dispose(): void;
}

export interface FrameXmlBattlefieldMinimapOwnerOptions {
  /** The boot, read when a load starts (the hooks are installed while it is still loading). */
  readonly boot: () => OwnerBoot | undefined;
  /** Told once, with the reason, when the add-on is demoted. */
  readonly onFailure?: (reason: string) => void;
}

export function createFrameXmlBattlefieldMinimapOwner(
  options: FrameXmlBattlefieldMinimapOwnerOptions,
): FrameXmlBattlefieldMinimapOwner {
  let state: FrameXmlBattlefieldMinimapState = "idle";
  let disposed = false;
  let loaded = false;
  let renderer: OwnerRenderer | undefined;
  let pending: Promise<void> | undefined;
  const intents: FrameXmlBattlefieldMinimapIntent[] = [];

  const fail = (boot: OwnerBoot | undefined, reason: string): void => {
    if (disposed || state === "failed") return;
    state = "failed";
    intents.length = 0;
    if (loaded && boot) {
      try { silence(boot); } catch { /* reported below either way */ }
    }
    try { options.onFailure?.(reason); } catch { /* reporting only */ }
  };

  /** Stock's own effect of each ask, in order, now that the add-on answers. */
  const replay = (boot: OwnerBoot): void => {
    while (intents.length > 0 && state === "ready" && !disposed) {
      const intent = intents.shift()!;
      if (intent === "load") continue;
      const errors = boot.errorCount;
      frameXmlSilentProbe(boot, "webclient/battlefield-minimap-replay", intent === "toggle"
        ? "BattlefieldMinimap_Toggle()"
        : "WorldStateFrame_ToggleBattlefieldMinimap()", 0);
      if (boot.errorCount !== errors) { fail(boot, `${FRAMEXML_BATTLEFIELD_MINIMAP_ADDON} raised replaying «${intent}»`); return; }
    }
  };

  const load = async (): Promise<void> => {
    const boot = options.boot();
    const target = renderer;
    if (!boot || !target) { fail(boot, `${FRAMEXML_BATTLEFIELD_MINIMAP_ADDON}: no boot to load into`); return; }
    try {
      const result = await boot.loadAddon(FRAMEXML_BATTLEFIELD_MINIMAP_ADDON);
      if (disposed || state !== "loading") return;
      if (!result.ok) { fail(boot, `${FRAMEXML_BATTLEFIELD_MINIMAP_ADDON}: ${result.message ?? result.status}`); return; }
      loaded = true;
      // BattlefieldMinimap and its tab hang from UIParent; the renderer builds them when first shown.
      target.addRoots(result.roots.filter((root) => root.parent === undefined));
      target.sync();
      if (!frameXmlBattlefieldMinimapGate(boot)) { fail(boot, `${FRAMEXML_BATTLEFIELD_MINIMAP_ADDON} did not pass its gate`); return; }
      if (disposed || state !== "loading") return;
      state = "ready";
      replay(boot);
    } catch (error) {
      fail(boot, `${FRAMEXML_BATTLEFIELD_MINIMAP_ADDON} failed: ${String(error)}`);
    }
  };

  const start = (): void => {
    if (disposed || (state !== "idle" && state !== "waiting")) return;
    if (!renderer) { state = "waiting"; return; }
    state = "loading";
    pending = load().finally(() => { pending = undefined; });
  };

  return {
    get state() { return state; },
    request: (intent) => {
      if (disposed || state === "failed") return;
      if (state === "ready") {
        const boot = options.boot();
        if (boot && intent !== "load") { intents.push(intent); replay(boot); }
        return;
      }
      if (intents.length < MAX_INTENTS) intents.push(intent);
      start();
    },
    publish: (next) => {
      renderer = next;
      if (state === "waiting") start();
      return () => { disposed = true; };
    },
    settled: () => pending ?? Promise.resolve(),
    dispose: () => { disposed = true; },
  };
}

/**
 * Point the stock paths at the owner, before the session events: BattlefieldMinimap_LoadUI,
 * WorldStateFrame_CanShowBattlefieldMinimap and ToggleBattlefieldMinimap keep stock's decisions and
 * defer their effect until the add-on answers. False when UIParent's or WorldStateFrame's functions are
 * not there to wrap (a trimmed TOC); the boot is then left as it is.
 */
export function installFrameXmlBattlefieldMinimapHooks(
  boot: Pick<FrameXmlBoot, "vm">,
  owner: FrameXmlBattlefieldMinimapOwner,
): boolean {
  boot.vm.registerGlobal(REQUEST_GLOBAL, (args) => {
    const intent = args[0] === "show" || args[0] === "toggle" ? args[0] : "load";
    // A microtask later — never inside the PLAYER_ENTERING_WORLD dispatch or the key press that asked.
    queueMicrotask(() => {
      try { owner.request(intent); } catch (error) { console.warn(`[FrameXML battlefield minimap] ${String(error)}`); }
    });
    return [];
  });
  boot.vm.registerGlobal(READY_GLOBAL, () => [owner.state === "ready"]);
  const probe = frameXmlSilentProbe(boot, "webclient/battlefield-minimap-hooks", `
    if type(BattlefieldMinimap_LoadUI) ~= "function" or type(WorldStateFrame_CanShowBattlefieldMinimap) ~= "function" then
      return false
    end
    local request, ready = ${REQUEST_GLOBAL}, ${READY_GLOBAL}
    local canShow, toggle = WorldStateFrame_CanShowBattlefieldMinimap, ToggleBattlefieldMinimap
    BattlefieldMinimap_LoadUI = function()
      if not ready() then request("load") end
    end
    WorldStateFrame_CanShowBattlefieldMinimap = function(...)
      local answer = canShow(...)
      if ready() then return answer end
      if answer then request("show") end
      return false
    end
    if type(toggle) == "function" then
      ToggleBattlefieldMinimap = function(...)
        if ready() then return toggle(...) end
        request("toggle")
      end
    end
    return true
  `, 1);
  return probe?.[0] === true;
}
