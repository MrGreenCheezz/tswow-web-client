/**
 * Stock Blizzard_ArenaUI — ArenaEnemyFrames: the five enemy unit frames `arena1`…`arena5` (name,
 * class circle, health and power bars, cast bar) with their pets `arenapet1`…`arenapet5`, under the
 * minimap in an arena — loaded on demand and fed by the arena model (FrameXmlArena.ts).
 *
 * The add-on is load-on-demand (Blizzard_ArenaUI.toc: `## LoadOnDemand: 1`, Blizzard_ArenaUI.xml and
 * Localization.lua). UIParent's PLAYER_ENTERING_WORLD calls `Arena_LoadUI()` —
 * `UIParentLoadAddOn("Blizzard_ArenaUI")` — when `IsInInstance()` says "arena" (UIParent.lua:335-336,
 * :666-669). This host's LoadAddOn only reports a state (FrameXmlAddonRuntime.ts): UIParentLoadAddOn
 * would put «Ошибка загрузки» in the error dialog while the files are on their way
 * (UIParent.lua:234-243). So, as FrameXmlRaidLod.ts does for RaidFrame_LoadUI, the owner takes
 * `Arena_LoadUI` over at publish; its first call starts the host's load (`boot.loadAddon` →
 * `renderer.addRoots` → sync → gate) and every later call is answered by the owner's state. The
 * model's own «a running arena match began» edge starts the same load, because the in-progress
 * SMSG_BATTLEFIELD_STATUS — the only thing `IsInInstance` answers "arena" from (FrameXmlArenaApi.ts) —
 * may land after the PLAYER_ENTERING_WORLD of the port. Nothing loads at boot, nor outside an arena.
 *
 * Before the files run, the client's CVar defaults the add-on reads at load are registered, as the
 * client registers them before any Lua runs: showArenaEnemyFrames "1", showArenaEnemyCastbar "1",
 * showArenaEnemyPets "1", showPartyBackground "0", partyBackgroundOpacity "0.5" — measured in this
 * client's Wow.exe, whose CVar registrations push each default string right before its description
 * and name. The host's CVar table knew none of them, and an unknown CVar is nil: GetCVarBool(nil) would
 * have disabled the frames for good (ArenaEnemyFrames_OnLoad, Blizzard_ArenaUI.lua:8-12). A player's
 * own value, once set, is never overwritten (RegisterCVar keeps it). The pets' UVar
 * `SHOW_ARENA_ENEMY_PETS`, which ArenaEnemyFrame_UpdatePet reads on UNIT_PET (:231), is the CVar's
 * value as InterfaceOptionsPanel_CheckButton_Update writes it (InterfaceOptionsPanels.lua:39-41) —
 * the options panel is itself load-on-demand here, so nothing else would.
 *
 * After the gate the model re-announces what it already knows (UNIT_PET, «seen»/«unseen»), and from
 * there stock's own handlers keep the frames current. A load, gate or Lua failure demotes for good:
 * the add-on's frames stop listening and hide.
 */
import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import type { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import type { FrameXmlArenaOpponents } from "./FrameXmlArena.js";
import { FRAMEXML_ARENA_OPPONENTS } from "./FrameXmlArena.js";
import { frameXmlSilentProbe } from "./FrameXmlGameMenuOwner.js";

export const FRAMEXML_ARENA_ADDON = "Blizzard_ArenaUI";

/** The host global the owner's `Arena_LoadUI` calls. */
const LOAD_GLOBAL = "__webclientArenaLoad";

type GateBoot = Pick<FrameXmlBoot, "vm" | "bridge" | "errorCount">;
type ArenaSeam = { readonly arena?: FrameXmlArenaOpponents | undefined };

/** The client's registrations (Wow.exe), in its order: name, default. */
const CVAR_DEFAULTS: readonly (readonly [name: string, value: string])[] = [
  ["showArenaEnemyFrames", "1"], ["showArenaEnemyCastbar", "1"], ["showArenaEnemyPets", "1"],
  ["showPartyBackground", "0"], ["partyBackgroundOpacity", "0.5"],
];

/** The frames Blizzard_ArenaUI.xml declares, their widget type and the parent each hangs from. */
function arenaFrames(): readonly (readonly [name: string, type: string, parent: string])[] {
  const frames: [string, string, string][] = [
    ["ArenaEnemyFrames", "Frame", "UIParent"],
    ["ArenaEnemyBackground", "Frame", "ArenaEnemyFrames"],
  ];
  for (let index = 1; index <= FRAMEXML_ARENA_OPPONENTS; index += 1) {
    frames.push([`ArenaEnemyFrame${index}`, "Button", "ArenaEnemyFrames"]);
    // ArenaEnemyPetFrame_OnLoad reparents the pet frame onto ArenaEnemyFrames (Blizzard_ArenaUI.lua:255).
    frames.push([`ArenaEnemyFrame${index}PetFrame`, "Button", "ArenaEnemyFrames"]);
    frames.push([`ArenaEnemyFrame${index}CastingBar`, "StatusBar", `ArenaEnemyFrame${index}`]);
    frames.push([`ArenaEnemyFrame${index}HealthBar`, "StatusBar", `ArenaEnemyFrame${index}`]);
    frames.push([`ArenaEnemyFrame${index}ManaBar`, "StatusBar", `ArenaEnemyFrame${index}`]);
  }
  return frames;
}

const STOCK_GLOBALS: readonly string[] = [
  "ArenaEnemyFrames_UpdateVisible", "ArenaEnemyFrame_OnEvent", "ArenaEnemyPetFrame_OnEvent",
  "ArenaEnemyFrame_UpdatePlayer", "ArenaEnemyFrame_UpdatePet", "UpdateArenaEnemyBackground",
];

function hasGlobalFunction(boot: GateBoot, name: string): boolean {
  const ref = boot.vm.globalFunction(name);
  if (!ref) return false;
  boot.vm.release(ref);
  return true;
}

export interface FrameXmlArenaGateResult {
  /** Measured by the probe: GetNumArenaOpponents(), enemy frames shown, and whether the set is up. */
  readonly opponents: number;
  readonly shown: number;
  readonly visible: boolean;
}

/**
 * Structural and transactional proof that the loaded add-on can own the enemy frames: every frame
 * hangs where the XML (and the pets' OnLoad) puts it, each frame, pet frame and cast bar carries its
 * stock unit token, the stock functions are real, and stock `ArenaEnemyFrames_UpdateVisible` +
 * `UpdateArenaEnemyBackground` raise nothing and leave ArenaEnemyFrames up exactly in an arena with
 * the frames enabled, and an enemy frame up for exactly each slot the model knows a GUID for.
 */
export function frameXmlArenaGate(seam: ArenaSeam, boot: GateBoot): FrameXmlArenaGateResult | undefined {
  try {
    const model = seam.arena;
    if (!model) return undefined;
    for (const [name, type, parent] of arenaFrames()) {
      const frame = boot.bridge.getFrame(name);
      if (!frame || frame.type !== type || frame.parent?.name !== parent) return undefined;
    }
    if (!STOCK_GLOBALS.every((name) => hasGlobalFunction(boot, name))) return undefined;
    const errors = boot.errorCount;
    const diagnostics = boot.bridge.diagnostics.length;
    const probe = frameXmlSilentProbe(boot, "webclient/arena-gate", `
      for i = 1, MAX_ARENA_ENEMIES do
        local frame = _G["ArenaEnemyFrame" .. i]
        if frame.unit ~= "arena" .. i or frame.petFrame ~= _G["ArenaEnemyFrame" .. i .. "PetFrame"]
          or frame.petFrame.unit ~= "arenapet" .. i or _G["ArenaEnemyFrame" .. i .. "CastingBar"].unit ~= "arena" .. i then
          return -1, 0, false
        end
      end
      ArenaEnemyFrames_UpdateVisible()
      UpdateArenaEnemyBackground()
      local shown = 0
      for i = 1, MAX_ARENA_ENEMIES do
        if _G["ArenaEnemyFrame" .. i]:IsShown() then shown = shown + 1 end
      end
      return GetNumArenaOpponents(), shown, ArenaEnemyFrames:IsShown() and true or false,
        ArenaEnemyFrames.show and true or false
    `, 4);
    if (!probe) return undefined;
    const opponents = Number(probe[0]);
    const shown = Number(probe[1]);
    const visible = probe[2] === true;
    const enabled = probe[3] === true;
    if (!Number.isInteger(opponents) || opponents < 0 || opponents !== model.count()) return undefined;
    // ArenaEnemyFrame_UpdatePlayer shows a frame for a unit with a GUID (Blizzard_ArenaUI.lua:143-146);
    // the model gives every slot one.
    if (shown !== opponents || visible !== (enabled && model.inArena())
      || boot.errorCount !== errors || boot.bridge.diagnostics.length !== diagnostics) return undefined;
    return { opponents, shown, visible };
  } catch {
    return undefined;
  }
}

/** The client's CVar defaults and the pets' UVar, before the add-on's OnLoad reads them. */
function registerDefaults(boot: GateBoot): void {
  const rows = CVAR_DEFAULTS.map(([name, value]) => `{ ${JSON.stringify(name)}, ${JSON.stringify(value)} }`).join(", ");
  frameXmlSilentProbe(boot, "webclient/arena-cvars", `
    if type(RegisterCVar) == "function" then
      for _, row in ipairs({ ${rows} }) do RegisterCVar(row[1], row[2]) end
    end
    if SHOW_ARENA_ENEMY_PETS == nil and type(GetCVar) == "function" then
      SHOW_ARENA_ENEMY_PETS = GetCVar("showArenaEnemyPets")
    end
  `, 0);
}

/** A failed add-on: its frames stop listening and hide, so no stock handler runs it again. */
function silence(boot: GateBoot): void {
  frameXmlSilentProbe(boot, "webclient/arena-silence", `
    local names = { "ArenaEnemyFrames", "ArenaEnemyBackground" }
    for i = 1, ${FRAMEXML_ARENA_OPPONENTS} do
      names[#names + 1] = "ArenaEnemyFrame" .. i
      names[#names + 1] = "ArenaEnemyFrame" .. i .. "PetFrame"
      names[#names + 1] = "ArenaEnemyFrame" .. i .. "CastingBar"
      names[#names + 1] = "ArenaEnemyFrame" .. i .. "HealthBar"
      names[#names + 1] = "ArenaEnemyFrame" .. i .. "ManaBar"
      names[#names + 1] = "ArenaEnemyFrame" .. i .. "PetFrameHealthBar"
      names[#names + 1] = "ArenaEnemyFrame" .. i .. "PetFrameManaBar"
    end
    for _, name in ipairs(names) do
      local frame = _G[name]
      if type(frame) == "table" and frame.UnregisterAllEvents then
        frame:UnregisterAllEvents()
        frame:SetScript("OnUpdate", nil)
        frame:Hide()
      end
    end
  `, 0);
}

export type FrameXmlArenaState = "idle" | "loading" | "ready" | "failed";

export interface FrameXmlArenaOwner {
  /** `Arena_LoadUI`: start the one load; later calls change nothing. */
  begin(): void;
  readonly state: FrameXmlArenaState;
  /** Resolves when the load in flight has settled (at once when none is). */
  settled(): Promise<void>;
  dispose(): void;
}

export interface FrameXmlArenaOwnerOptions {
  readonly seam: ArenaSeam;
  readonly boot: Pick<FrameXmlBoot, "loadAddon" | "vm" | "bridge" | "errorCount">;
  readonly renderer: Pick<FrameXmlDomRenderer, "addRoots" | "sync">;
  /** Told once, with the reason, when the add-on is demoted. */
  readonly onFailure?: (reason: string) => void;
  /** Told once when the stock enemy frames passed their gate and own the arena opponents. */
  readonly onReady?: () => void;
}

/**
 * Plan item 3.16: while the stock ArenaEnemyFrames own the opponents, the native `#arena-frames`
 * would draw the same five units a second time. The world mount hides them under this body class.
 */
export const FRAMEXML_ARENA_ENEMY_OWNED_CLASS = "framexml-arena-enemy-owned";
export const FRAMEXML_NATIVE_ARENA_HIDE_SELECTOR = `body.${FRAMEXML_ARENA_ENEMY_OWNED_CLASS} #arena-frames`;

function setArenaEnemyOwned(owned: boolean): void {
  if (typeof document === "undefined") return;
  document.body?.classList.toggle(FRAMEXML_ARENA_ENEMY_OWNED_CLASS, owned);
}

export function createLazyFrameXmlArenaOwner(options: FrameXmlArenaOwnerOptions): FrameXmlArenaOwner {
  const { seam, boot, renderer } = options;
  let state: FrameXmlArenaState = "idle";
  let disposed = false;
  let loaded = false;
  let pending: Promise<void> | undefined;

  const fail = (reason: string): void => {
    if (disposed || state === "failed") return;
    state = "failed";
    if (loaded) {
      try { silence(boot); } catch { /* reported below either way */ }
    }
    try { options.onFailure?.(reason); } catch { /* reporting only */ }
  };
  const load = async (): Promise<void> => {
    try {
      registerDefaults(boot);
      const result = await boot.loadAddon(FRAMEXML_ARENA_ADDON);
      if (disposed || state !== "loading") return;
      if (!result.ok) { fail(`${FRAMEXML_ARENA_ADDON}: ${result.message ?? result.status}`); return; }
      loaded = true;
      // ArenaEnemyFrames hangs from UIParent (Blizzard_ArenaUI.xml:463); only a parentless root would
      // draw at the top level. The renderer builds the frames when they are first shown.
      renderer.addRoots(result.roots.filter((root) => root.parent === undefined));
      renderer.sync();
      const gate = frameXmlArenaGate(seam, boot);
      if (disposed || state !== "loading") return;
      if (!gate) { fail(`${FRAMEXML_ARENA_ADDON} did not pass its gate`); return; }
      state = "ready";
      // What the model saw before the frames existed reaches them now, through stock's handlers.
      const errors = boot.errorCount;
      seam.arena?.replay();
      if (boot.errorCount !== errors) { fail(`${FRAMEXML_ARENA_ADDON} raised replaying the known opponents`); return; }
      try { options.onReady?.(); } catch { /* reporting only */ }
    } catch (error) {
      fail(`${FRAMEXML_ARENA_ADDON} failed: ${String(error)}`);
    }
  };

  return {
    get state() { return state; },
    begin: () => {
      if (disposed || state !== "idle") return;
      state = "loading";
      pending = load().finally(() => { pending = undefined; });
    },
    settled: () => pending ?? Promise.resolve(),
    dispose: () => { disposed = true; },
  };
}

/**
 * Point stock `Arena_LoadUI` at the owner: a microtask later — never inside the PLAYER_ENTERING_WORLD
 * dispatch that called it — `begin` runs. Answers whether `IsInInstance()` already says "arena", or
 * undefined when UIParent.lua's loader is not there to replace.
 */
export function installFrameXmlArenaLoadUI(boot: Pick<FrameXmlBoot, "vm">, begin: () => void): boolean | undefined {
  boot.vm.registerGlobal(LOAD_GLOBAL, () => {
    queueMicrotask(() => {
      try { begin(); } catch (error) { console.warn(`[FrameXML arena] ${String(error)}`); }
    });
    return [];
  });
  const probe = frameXmlSilentProbe(boot, "webclient/arena-hook", `
    if type(Arena_LoadUI) ~= "function" then return nil end
    local load = ${LOAD_GLOBAL}
    Arena_LoadUI = function() load() end
    local _, instanceType = IsInInstance()
    return instanceType == "arena"
  `, 1);
  const value = probe?.[0];
  return typeof value === "boolean" ? value : undefined;
}

/**
 * The world mount's one call: the owner, its `Arena_LoadUI`, the model's match edge and — as stock's
 * PLAYER_ENTERING_WORLD branch does for a player already in an arena — the load at once. Returns the
 * cleanup, or undefined when the seam has no arena model or UIParent.lua's loader is absent.
 */
export function mountFrameXmlArenaEnemy(
  seam: ArenaSeam,
  boot: Pick<FrameXmlBoot, "loadAddon" | "vm" | "bridge" | "errorCount">,
  renderer: Pick<FrameXmlDomRenderer, "addRoots" | "sync">,
  setOwned: (owned: boolean) => void = setArenaEnemyOwned,
): { readonly owner: FrameXmlArenaOwner; readonly cleanup: () => void } | undefined {
  const model = seam.arena;
  if (!model) return undefined;
  const owner = createLazyFrameXmlArenaOwner({
    seam, boot, renderer,
    onFailure: (reason) => {
      setOwned(false);
      console.warn(`[FrameXML arena] ${reason}; no enemy arena frames`);
    },
    onReady: () => setOwned(true),
  });
  const inArena = installFrameXmlArenaLoadUI(boot, () => owner.begin());
  if (inArena === undefined) return undefined;
  const onEnter = (): void => owner.begin();
  model.onEnter = onEnter;
  if (inArena || model.inArena()) owner.begin();
  return {
    owner,
    cleanup: () => {
      if (model.onEnter === onEnter) model.onEnter = undefined;
      owner.dispose();
      setOwned(false);
    },
  };
}
