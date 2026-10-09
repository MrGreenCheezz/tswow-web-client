/**
 * Stock Blizzard_RaidUI, the group grid of the Raid tab (FriendsFrame tab 5): the lazy owner, its
 * gate and the one hook that starts it. The raid C API is FrameXmlRaid.ts.
 *
 * RaidFrame.xml shows only «convert to raid» and the raid-info button; the eight groups, the forty
 * member buttons and the class counts are the load-on-demand Blizzard_RaidUI, which the client
 * loads from `RaidFrame_LoadUI()` (`UIParentLoadAddOn("Blizzard_RaidUI")`, UIParent.lua:280) on
 * every RAID_ROSTER_UPDATE and at PLAYER_LOGIN in a raid (RaidFrame.lua:30-38). Lua's LoadAddOn is a
 * status view in this host (FrameXmlAddonRuntime.ts): while the files are on their way it answers
 * NOT_READY, and UIParentLoadAddOn would put «Ошибка загрузки (Blizzard_RaidUI)» in the script-error
 * dialog. So the owner takes `RaidFrame_LoadUI` over at publish: the first call starts the host's
 * load (`boot.loadAddon` → `renderer.addRoots` → sync → gate), every later call is answered by the
 * owner's state, and stock's UIParentLoadAddOn is never reached — not while loading, not after a
 * failure. Nothing loads at boot, nor ever outside a raid. The gate ends with stock's own
 * `RaidFrame_Update()`, which fills the grid (RaidGroupFrame_Update) from GetRaidRosterInfo.
 *
 * A failure demotes for good and puts back what the add-on replaced — RaidFrame's OnEvent, OnHide
 * and OnUpdate (the inline `RaidGroupFrame_OnLoad()` at Blizzard_RaidUI.xml:1220 takes them), the
 * stub plan's `RaidGroupFrame_Update`/`RaidPullout_RenewFrames`/`RaidGroupFrame_ReadyCheckFinished`
 * and the seam's `SetRaidSubgroup`/`SwapRaidSubgroup` (`answerDrops` below) — and hides the grid, so
 * the Raid tab is what it was before.
 */
import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import type { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";
import type { FrameXmlFriendsModel } from "./FrameXmlFriends.js";
import { frameXmlSilentProbe } from "./FrameXmlGameMenuOwner.js";

export const FRAMEXML_RAID_ADDON = "Blizzard_RaidUI";

/** `NUM_RAID_GROUPS`, `MEMBERS_PER_RAID_GROUP`, `MAX_RAID_MEMBERS` (RaidFrame.lua:2-4). */
const GROUPS = 8;
const GROUP_SLOTS = 5;
const MEMBER_BUTTONS = 40;
/**
 * The class buttons Blizzard_RaidUI.xml itself defines (`RaidClassButton1`..`13`), which the gate
 * requires. Not a class count: `MAX_RAID_CLASS_BUTTONS` = MAX_CLASSES + 3 (Blizzard_RaidUI.lua:23)
 * is 15 on this dataset's 12 classes and stock nil-guards the two the XML lacks; the demotion hides
 * up to whichever is larger (9.05).
 */
const CLASS_BUTTONS = 13;

/** The host global the owner's `RaidFrame_LoadUI` calls. */
const LOAD_GLOBAL = "__webclientRaidGridLoad";
/** What the add-on replaces on RaidFrame and in _G, kept for a demotion. */
const SAVED_GLOBAL = "__webclientRaidGridBefore";

type GateBoot = Pick<FrameXmlBoot, "vm" | "bridge" | "errorCount">;
type RaidSeam = { readonly friends?: FrameXmlFriendsModel | undefined };

function dataAttribute(element: HTMLElement, name: string): string | null {
  const value = element.getAttribute(name);
  if (value !== null) return value;
  const key = name.slice(5).replace(/-([a-z])/g, (_match, character: string) => character.toUpperCase());
  return element.dataset?.[key] ?? null;
}

function renderedFrameElement(element: HTMLElement | undefined, frame: FrameXmlFrame): boolean {
  return !!element && dataAttribute(element, "data-framexml-name") === frame.name
    && dataAttribute(element, "data-framexml-type") === frame.type;
}

/** The grid's named frames, with their widget type and the parent each must hang from. */
function gridFrames(): readonly (readonly [name: string, type: string, parent: string])[] {
  const frames: [string, string, string][] = [
    ["RaidFrameReadyCheckButton", "Button", "RaidFrame"],
    ["RaidFrameRaidBrowserButton", "Button", "RaidFrame"],
  ];
  for (let group = 1; group <= GROUPS; group += 1) {
    frames.push([`RaidGroup${group}`, "Frame", "RaidFrame"]);
    for (let slot = 1; slot <= GROUP_SLOTS; slot += 1) frames.push([`RaidGroup${group}Slot${slot}`, "Button", `RaidGroup${group}`]);
  }
  for (let index = 1; index <= MEMBER_BUTTONS; index += 1) frames.push([`RaidGroupButton${index}`, "Button", "RaidFrame"]);
  for (let index = 1; index <= CLASS_BUTTONS; index += 1) frames.push([`RaidClassButton${index}`, "Button", "RaidFrame"]);
  return frames;
}

/** Stock functions the grid runs on, which the stub plan answered with no-ops before the load. */
const STOCK_GLOBALS: readonly string[] = [
  "RaidGroupFrame_Update", "RaidGroupFrame_OnEvent", "RaidPullout_RenewFrames", "RaidClassButton_Update",
  "RaidFrameReadyCheckButton_Update",
];

function hasGlobalFunction(boot: GateBoot, name: string): boolean {
  const ref = boot.vm.globalFunction(name);
  if (!ref) return false;
  boot.vm.release(ref);
  return true;
}

export interface FrameXmlRaidGridGateResult {
  readonly frame: FrameXmlFrame;
  /** Measured by the probe: raid members, member buttons shown, groups shown. */
  readonly members: number;
  readonly buttons: number;
  readonly groups: number;
}

/**
 * Structural, rendered and transactional proof that the loaded grid can own the Raid tab.
 *
 * Every group, slot, member and class button must hang from RaidFrame as the XML says, RaidFrame's
 * OnEvent must be the add-on's `RaidGroupFrame_OnEvent` (so the inline OnLoad ran), and the grid's
 * functions must be real. The probe then runs stock `RaidFrame_Update()` with the raid model muted
 * and counts: outside a raid no group and no button shows; in one all eight groups show and one
 * button per member, capped at five a group as stock caps it. Any new Lua error or bridge diagnostic
 * fails the gate.
 */
export function frameXmlRaidGridGate(
  seam: RaidSeam,
  boot: GateBoot,
  renderer: Pick<FrameXmlDomRenderer, "elementFor">,
): FrameXmlRaidGridGateResult | undefined {
  try {
    const friends = seam.friends;
    const raid = boot.bridge.getFrame("RaidFrame");
    if (!friends || !raid || raid.type !== "Frame") return undefined;
    for (const [name, type, parent] of gridFrames()) {
      const frame = boot.bridge.getFrame(name);
      if (!frame || frame.type !== type || frame.parent?.name !== parent) return undefined;
    }
    // RaidFrame is drawn; the renderer builds its new children when it is next shown (a hidden
    // subtree stays parked until then), as it does for every frame Lua adds under a hidden one.
    if (!renderedFrameElement(renderer.elementFor(raid), raid)) return undefined;
    if (!STOCK_GLOBALS.every((name) => hasGlobalFunction(boot, name))) return undefined;
    const errors = boot.errorCount;
    const diagnostics = boot.bridge.diagnostics.length;
    const probe = friends.muted(() => frameXmlSilentProbe(boot, "webclient/raid-grid-gate", `
      if RaidFrame:GetScript("OnEvent") ~= RaidGroupFrame_OnEvent then return -1, 0, 0 end
      RaidFrame_Update()
      local buttons, groups = 0, 0
      for index = 1, MAX_RAID_MEMBERS do
        if _G["RaidGroupButton" .. index]:IsShown() then buttons = buttons + 1 end
      end
      for index = 1, NUM_RAID_GROUPS do
        if _G["RaidGroup" .. index]:IsShown() then groups = groups + 1 end
      end
      return GetNumRaidMembers(), buttons, groups
    `, 3));
    if (!probe) return undefined;
    const [members, buttons, groups] = probe.map((value) => Number(value));
    if (members === undefined || buttons === undefined || groups === undefined || members < 0) return undefined;
    // Stock places at most MEMBERS_PER_RAID_GROUP buttons in a group; the rest of a hiccuping
    // server's overfull group stay hidden. The model's subgroups say how many that is.
    let expected = 0;
    const perGroup = new Map<number, number>();
    for (let index = 1; index <= Math.min(members, MEMBER_BUTTONS); index += 1) {
      const subgroup = Number(friends.raid.rosterInfo(index)?.[2]);
      const placed = perGroup.get(subgroup) ?? 0;
      if (placed < GROUP_SLOTS) expected += 1;
      perGroup.set(subgroup, placed + 1);
    }
    if (buttons !== expected || groups !== (members > 0 ? GROUPS : 0)
      || boot.errorCount !== errors || boot.bridge.diagnostics.length !== diagnostics) return undefined;
    return { frame: raid, members, buttons, groups };
  } catch {
    return undefined;
  }
}

export type FrameXmlRaidGridState = "idle" | "loading" | "ready" | "failed";

export interface FrameXmlRaidGridOwner {
  /** `RaidFrame_LoadUI`: start the one load; later calls change nothing. */
  begin(): void;
  readonly state: FrameXmlRaidGridState;
  /** Resolves when the load in flight has settled (at once when none is). */
  settled(): Promise<void>;
  dispose(): void;
}

export interface FrameXmlRaidGridOwnerOptions {
  readonly seam: RaidSeam;
  readonly boot: Pick<FrameXmlBoot, "loadAddon" | "vm" | "bridge" | "errorCount">;
  readonly renderer: Pick<FrameXmlDomRenderer, "addRoots" | "sync" | "elementFor">;
  /** Told once, with the reason, when the grid is demoted. */
  readonly onFailure?: (reason: string) => void;
}

/**
 * `RaidGroupTemplate` and `RaidGroupButtonTemplate` declare `parent="RaidFrame"` (Blizzard_RaidUI.xml:
 * 104, :320), and a frame takes its template's parent in the client. The XML runtime reads `parent` on
 * the frame's own element only (FrameXmlRuntime `parentFrameOf`), so RaidGroup1-8 and
 * RaidGroupButton1-40 came out parentless: measured, 48 top-level roots, which would draw over the
 * world whether the Raid tab was open or not. They are RaidFrame's here, as the client has them; their
 * frame levels (0 and the 3 RaidGroupButton_OnLoad computes) keep the buttons over the slots. Retire
 * once the runtime inherits a template's `parent`.
 *
 * And one renderer difference: the client draws a member's name over the button's bar. The bar is the
 * button's NormalTexture (UI-RaidFrame-GroupButton, Blizzard_RaidUI.xml:292) and the name, level and
 * class are ARTWORK FontStrings (:110-141); the renderer gives a texture and a string of one layer the
 * same z-index and lets DOM order decide, so the bar, added after them, covered the name (measured on
 * the rich route: RaidGroupButton1Name and the NormalTexture both z 300, Level and Class 301/302 above
 * it; the names were blank once the picture arrived). The bar goes to BACKGROUND, under all three,
 * which is where the client draws it relative to them. Retire once a layer's strings draw over its
 * textures in the renderer.
 */
function adoptTemplateParents(boot: GateBoot): void {
  frameXmlSilentProbe(boot, "webclient/raid-grid-adopt", `
    for index = 1, NUM_RAID_GROUPS do
      local group = _G["RaidGroup" .. index]
      if group and group:GetParent() == nil then group:SetParent(RaidFrame) end
    end
    for index = 1, MAX_RAID_MEMBERS do
      local button = _G["RaidGroupButton" .. index]
      if button and button:GetParent() == nil then button:SetParent(RaidFrame) end
      local bar = button and button:GetNormalTexture()
      if bar and bar:GetDrawLayer() == "ARTWORK" then bar:SetDrawLayer("BACKGROUND") end
    end
  `, 0);
}

/**
 * The drag's requests. `RaidGroupButton_OnDragStop` (Blizzard_RaidUI.lua:626-652) moves the member's
 * button into the target group before it asks the server, and only the server's SMSG_GROUP_LIST
 * (RAID_ROSTER_UPDATE → RaidGroupFrame_Update) puts it where the roster says. When the seam sent
 * nothing (FrameXmlRaidLodApi.ts: a swap, which TrinityCore 3.3.5 does not handle; a move its handler
 * would refuse; no world) no list will come, so the grid is redrawn from the roster at once and the
 * member stays in their real group — where the client would leave the button until the next list.
 * False when the seam's two functions are not there to wrap.
 */
function answerDrops(boot: GateBoot): boolean {
  const probe = frameXmlSilentProbe(boot, "webclient/raid-grid-drops", `
    local set, swap = SetRaidSubgroup, SwapRaidSubgroup
    if type(set) ~= "function" or type(swap) ~= "function" then return false end
    SetRaidSubgroup = function(index, subgroup)
      if not set(index, subgroup) then RaidGroupFrame_Update() end
    end
    SwapRaidSubgroup = function(index, other)
      if not swap(index, other) then RaidGroupFrame_Update() end
    end
    return true
  `, 1);
  return probe?.[0] === true;
}

/** Keep what the add-on's inline OnLoad and its function definitions replace, and what `answerDrops` wraps. */
function saveBefore(boot: GateBoot): void {
  frameXmlSilentProbe(boot, "webclient/raid-grid-save", `
    ${SAVED_GLOBAL} = {
      onEvent = RaidFrame:GetScript("OnEvent"), onHide = RaidFrame:GetScript("OnHide"),
      onUpdate = RaidFrame:GetScript("OnUpdate"), update = RaidGroupFrame_Update,
      renew = RaidPullout_RenewFrames, finished = RaidGroupFrame_ReadyCheckFinished,
      set = SetRaidSubgroup, swap = SwapRaidSubgroup,
    }
  `, 0);
}

/** Put RaidFrame, the stub plan's and the seam's functions back and hide whatever of the grid is up. */
function restoreBefore(boot: GateBoot): void {
  frameXmlSilentProbe(boot, "webclient/raid-grid-restore", `
    local saved = ${SAVED_GLOBAL}
    if type(saved) ~= "table" then return end
    RaidFrame:SetScript("OnEvent", saved.onEvent)
    RaidFrame:SetScript("OnHide", saved.onHide)
    RaidFrame:SetScript("OnUpdate", saved.onUpdate)
    RaidGroupFrame_Update = saved.update
    RaidPullout_RenewFrames = saved.renew
    RaidGroupFrame_ReadyCheckFinished = saved.finished
    SetRaidSubgroup, SwapRaidSubgroup = saved.set, saved.swap
    for _, name in ipairs({ "RaidFrameReadyCheckButton", "RaidFrameRaidBrowserButton" }) do
      if _G[name] then _G[name]:Hide() end
    end
    for index = 1, ${GROUPS} do if _G["RaidGroup" .. index] then _G["RaidGroup" .. index]:Hide() end end
    for index = 1, ${MEMBER_BUTTONS} do if _G["RaidGroupButton" .. index] then _G["RaidGroupButton" .. index]:Hide() end end
    local classButtons = math.max(${CLASS_BUTTONS}, tonumber(MAX_RAID_CLASS_BUTTONS) or 0)
    for index = 1, classButtons do if _G["RaidClassButton" .. index] then _G["RaidClassButton" .. index]:Hide() end end
    ${SAVED_GLOBAL} = nil
  `, 0);
}

/**
 * The lazy owner. `begin` starts Blizzard_RaidUI's load once; the gate then fills the grid with stock
 * `RaidFrame_Update`, and from there stock's own RAID_ROSTER_UPDATE/PARTY_MEMBERS_CHANGED handlers
 * keep it current. A load, gate or Lua failure demotes for good (see the module doc).
 */
export function createLazyFrameXmlRaidGridOwner(options: FrameXmlRaidGridOwnerOptions): FrameXmlRaidGridOwner {
  const { seam, boot, renderer } = options;
  let state: FrameXmlRaidGridState = "idle";
  let disposed = false;
  let pending: Promise<void> | undefined;
  let saved = false;

  const fail = (reason: string): void => {
    if (disposed || state === "failed") return;
    state = "failed";
    if (saved) {
      try { restoreBefore(boot); } catch { /* the grid stays hidden behind the demotion below */ }
    }
    try { options.onFailure?.(reason); } catch { /* reporting only */ }
  };
  const load = async (): Promise<void> => {
    try {
      saveBefore(boot);
      saved = true;
      const result = await boot.loadAddon(FRAMEXML_RAID_ADDON);
      if (disposed || state !== "loading") return;
      if (!result.ok) { fail(`${FRAMEXML_RAID_ADDON}: ${result.message ?? result.status}`); return; }
      adoptTemplateParents(boot);
      if (!answerDrops(boot)) { fail(`${FRAMEXML_RAID_ADDON}: the seam answers no SetRaidSubgroup`); return; }
      // Only what is still parentless draws at the top level; the adopted groups and buttons are
      // RaidFrame's now, and the renderer builds them when the Raid tab is first shown.
      renderer.addRoots(result.roots.filter((root) => root.parent === undefined));
      renderer.sync();
      const gate = frameXmlRaidGridGate(seam, boot, renderer);
      if (disposed || state !== "loading") return;
      if (!gate) { fail(`${FRAMEXML_RAID_ADDON} did not pass its gate`); return; }
      state = "ready";
      // The rest of stock's RAID_ROSTER_UPDATE after RaidFrame_LoadUI (RaidFrame.lua:36-38): the
      // gate ran RaidFrame_Update; the saved pullouts (none on a fresh character) come back here.
      boot.vm.executeReported("RaidPullout_RenewFrames()", "@webclient/raid-grid-renew");
    } catch (error) {
      fail(`${FRAMEXML_RAID_ADDON} failed: ${String(error)}`);
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
 * Point stock `RaidFrame_LoadUI` at the owner: a microtask later — never inside the RAID_ROSTER_UPDATE
 * dispatch that called it — the owner's `begin` runs. Answers GetNumRaidMembers() for the stock
 * PLAYER_LOGIN branch, or undefined when RaidFrame.xml is not loaded.
 */
export function installFrameXmlRaidLoadUI(boot: Pick<FrameXmlBoot, "vm">, begin: () => void): number | undefined {
  boot.vm.registerGlobal(LOAD_GLOBAL, () => {
    queueMicrotask(() => {
      try { begin(); } catch (error) { console.warn(`[FrameXML raid] ${String(error)}`); }
    });
    return [];
  });
  const probe = frameXmlSilentProbe(boot, "webclient/raid-grid-hook", `
    if type(RaidFrame_LoadUI) ~= "function" or type(RaidFrame) ~= "table" then return -1 end
    local load = ${LOAD_GLOBAL}
    RaidFrame_LoadUI = function() load() end
    return GetNumRaidMembers()
  `, 1);
  const members = Number(probe?.[0]);
  return Number.isInteger(members) && members >= 0 ? members : undefined;
}

/**
 * The world mount's one call: the owner, its `RaidFrame_LoadUI` and — as stock's PLAYER_LOGIN branch
 * does for a player already in a raid — the load at once. Returns the cleanup.
 */
export function mountFrameXmlRaidGrid(
  seam: RaidSeam,
  boot: Pick<FrameXmlBoot, "loadAddon" | "vm" | "bridge" | "errorCount">,
  renderer: Pick<FrameXmlDomRenderer, "addRoots" | "sync" | "elementFor">,
): { readonly owner: FrameXmlRaidGridOwner; readonly cleanup: () => void } | undefined {
  if (!seam.friends) return undefined;
  const owner = createLazyFrameXmlRaidGridOwner({
    seam, boot, renderer,
    onFailure: (reason) => console.warn(`[FrameXML raid] ${reason}; the Raid tab keeps no group grid`),
  });
  const members = installFrameXmlRaidLoadUI(boot, () => owner.begin());
  if (members === undefined) return undefined;
  if (members > 0) owner.begin();
  return { owner, cleanup: () => owner.dispose() };
}
