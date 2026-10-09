import type { GlueLoadScheduler } from "../glue/GlueLoadScheduler.js";
import { GlueLoader, type GlueFileProvider, type GlueLoadResult } from "../glue/GlueLoader.js";
import { GlueLuaVm, type GlueLuaOptions } from "../glue/GlueLua.js";
import { createFrameXmlClock, type FrameXmlClockSource } from "./FrameXmlClock.js"; // L5 3.27
import { installFrameXmlLuaEnvironment } from "./FrameXmlLuaEnvironment.js"; // L5 3.27
import { installFrameXmlEuropeanNumbers } from "./FrameXmlEuropeanNumbers.js"; // 05.10-3.27b
import {
  GlueWidgetBinder,
  type GameTooltipWidgetAdapter,
  type MinimapWidgetAdapter,
} from "../glue/GlueWidgets.js";
import { FrameXmlTemplateRegistry } from "../ui/framexml_compat/FrameXmlParser.js";
import { FrameXmlUiBridge } from "../ui/framexml_compat/FrameXmlRuntime.js";
import {
  FRAME_XML_WIDGET_TYPES,
  type FrameXmlFrame,
  type LuaAddonRuntime,
} from "../ui/framexml_compat/FrameXmlTypes.js";
import {
  FrameXmlCorpus,
  FRAMEXML_TOC_PATH,
  singleFileTocProvider,
  subsetTocProvider,
  subsetWithActiveTsAddonsTocProvider,
  type FrameXmlCorpusScan,
} from "./FrameXmlCorpus.js";
import { frameXmlStubPlanAsync, type FrameXmlStubPlan } from "./FrameXmlStubPlan.js";
import { FrameXmlTsAddonTracker, type FrameXmlTsAddonStatus } from "./FrameXmlTsAddonStatus.js";
import {
  FRAMEXML_FONT_METHODS,
  FRAMEXML_FONT_OBJECT_SETTERS,
  FRAMEXML_FONT_PRELUDE,
  frameXmlFontRecord,
  type FrameXmlFontRecord,
} from "./FrameXmlFontObjects.js";
import {
  FRAMEXML_NEUTRAL_API,
  FRAMEXML_NEUTRAL_CONSTANTS,
  FRAMEXML_NEUTRAL_PRELUDE,
} from "./FrameXmlNeutralApi.js";
import { FRAMEXML_BAG_COMPAT_PRELUDE, installOwnedGlobals, releaseOwnedGlobals } from "./FrameXmlBagCompat.js";
import { standInFrameXmlVehicleFrames } from "./FrameXmlDurabilityFrame.js";
import { installFrameXmlOptionsCategoryQueue } from "./FrameXmlOptionsCategoryQueue.js";
import { installFrameXmlLuaCompat } from "./FrameXmlLuaCompat.js";
import {
  frameXmlGlobalSelfCalls, frameXmlIsTsAddonChunk, type FrameXmlGlobalSelfCall,
} from "./FrameXmlTsAddonLint.js";
import {
  captureFrameXmlStockCombatLogLoadUi, frameXmlDefinesCombatLogLoadUi, FrameXmlLoginState,
  refuseFrameXmlCombatLogLoadUi,
} from "./FrameXmlLoginEdge.js";
import {
  FrameXmlCVarStore, frameXmlCVarStorageKey, installFrameXmlCVarPersistence,
} from "./FrameXmlCVarPersistence.js";
import {
  FRAMEXML_CHARACTER_COMPAT_PRELUDE,
  FRAMEXML_CHARACTER_OPTIONAL_SUBFRAMES,
} from "./FrameXmlCharacterCompat.js";
import {
  FRAMEXML_ATTRIBUTE_EXCLUDED_TYPES,
  FRAMEXML_ATTRIBUTE_PRELUDE,
} from "./FrameXmlSecureAttributes.js";
import {
  FRAMEXML_SEAM_BINDINGS,
  FRAMEXML_SEAM_NAMES,
  FRAMEXML_SEAM_PRELUDE,
  type FrameXmlWorldSeam,
} from "./FrameXmlWorldSeam.js";
import { createFrameXmlCharacterTooltipAdapter } from "./FrameXmlCharacterTooltip.js";
import { installFrameXmlSocketing } from "./FrameXmlSocketing.js";
import { FRAMEXML_SECURE_ENTRY_POINTS, installFrameXmlSecureWrappers } from "./FrameXmlSecureCalls.js";
import { installFrameXmlWorldMapArrowBindings } from "./FrameXmlWorldMapArrow.js";
import { pageModifiers, type ModifierSource } from "../input/Modifiers.js";
import { GlueLuaRef } from "../glue/GlueLua.js";
import { FrameXmlSavedVariables, type FrameXmlSavedVariablesOptions } from "./FrameXmlSavedVariables.js";
import {
  FrameXmlAddonRuntime,
  frameXmlAddonNotReadyText,
  type FrameXmlAddonRuntimeResult,
} from "./FrameXmlAddonRuntime.js";
import {
  FrameXmlClientNetworkBridge,
  type FrameXmlClientNetworkTransport,
} from "./FrameXmlClientNetwork.js";
import type {
  FrameXmlFileTiming,
  FrameXmlInventory,
  FrameXmlLuaFailure,
  FrameXmlPromotion,
  FrameXmlStubRecord,
} from "./FrameXmlInventory.js";

/** Stock owner whose zone handler requires the optional WorldMapFrame global. */
const WORLD_MAP_ZONE_EVENT_OWNERS = new Set(["WatchFrame"]);

const FRAMEXML_MICROBUTTON_ROW_NAMES = Object.freeze([
  "CharacterMicroButton", "SpellbookMicroButton", "TalentMicroButton", "AchievementMicroButton",
  "QuestLogMicroButton", "SocialsMicroButton", "PVPMicroButton", "LFDMicroButton",
  "MainMenuMicroButton", "HelpMicroButton",
]);

/** The owners read by stock UpdateMicroButtons, in the same order as the ten stock buttons. */
const FRAMEXML_MICROBUTTON_STATE_OWNERS = Object.freeze([
  ["CharacterMicroButton", "CharacterFrame"],
  ["SpellbookMicroButton", "SpellBookFrame"],
  ["TalentMicroButton", "PlayerTalentFrame"],
  ["AchievementMicroButton", "AchievementFrame"],
  ["QuestLogMicroButton", "QuestLogFrame"],
  ["SocialsMicroButton", "FriendsFrame"],
  ["PVPMicroButton", "PVPParentFrame"],
  ["LFDMicroButton", "LFDParentFrame"],
  ["MainMenuMicroButton", "GameMenuFrame"],
  ["HelpMicroButton", "HelpFrame"],
] as const);

/**
 * Keep the stock row's pre-exercise lifecycle safe for every FrameXmlBoot consumer, including
 * inventory/seam tests that do not mount the browser world.  Only the two handlers whose
 * PLAYER_ENTERING_WORLD path calls the optional-panel-wide UpdateMicroButtons() are replaced;
 * CharacterMicroButton_OnEvent remains stock so its SetPortraitTexture(MicroButtonPortrait,
 * "player") reaches the host's stock portrait claims (FrameXmlPortraits.ts), which paint the face
 * under the crop and alpha the adapter below writes. The global
 * UpdateMicroButtons itself is also owned here when an unguarded optional owner is absent: stock
 * calls InterfaceOptionsFrame/FriendsFrame/LFDParentFrame/HelpFrame without nil checks, while
 * this bounded world intentionally gates those surfaces to their native or lazy owners.
 */
export function installFrameXmlMicroButtonExerciseCompat(
  bridge: FrameXmlUiBridge,
  vm?: GlueLuaVm,
): void {
  const row = FRAMEXML_MICROBUTTON_ROW_NAMES
    .map((name) => bridge.getFrame(name))
    .filter((frame): frame is FrameXmlFrame => frame !== undefined);
  if (row.length !== FRAMEXML_MICROBUTTON_ROW_NAMES.length) return;
  // Do not apply this workaround to an arbitrary single-file/partial corpus.  The stock update
  // walk has several unconditional owners; only the measured world identity has all of these
  // frames and deliberately omits the optional LoD panels below. The update owners list also
  // includes InterfaceOptionsFrame: its absence must select the state adapter, not pass the fast
  // path.
  const unconditionalOwners = [
    "UIParent", "MainMenuBarArtFrame", "CharacterFrame", "SpellBookFrame", "QuestLogFrame",
    "GameMenuFrame", "PVPParentFrame",
  ];
  if (!unconditionalOwners.every((name) => bridge.getFrame(name))) return;
  const updateOwners = [
    "FriendsFrame", "LFDParentFrame", "HelpFrame", "AchievementFrame", "InterfaceOptionsFrame",
  ];
  const needsStateAdapter = updateOwners.some((name) => !bridge.getFrame(name));
  if (!needsStateAdapter) return;
  const talent = bridge.getFrame("TalentMicroButton");
  const achievement = bridge.getFrame("AchievementMicroButton");
  if (talent) bridge.SetScript(talent, "OnEvent", () => {});
  if (achievement) {
    bridge.SetScript(achievement, "OnEvent", () => {});
    bridge.SetScript(achievement, "OnEnter", () => {});
    bridge.SetScript(achievement, "OnLeave", () => {});
    bridge.update(achievement, (frame) => { frame.enabled = false; });
  }
  if (!vm) return;

  // Keep the stock function's useful part (selected owner -> PUSHED/NORMAL) without executing its
  // unguarded optional-owner reads. This is a host-owned adapter, not an exception sink: every
  // state write targets a real stock button, and an absent owner simply means NORMAL because the
  // corresponding native/lazy destination remains available through its click adapter.
  vm.registerGlobal("UpdateMicroButtons", () => {
    for (const [buttonName, ownerName] of FRAMEXML_MICROBUTTON_STATE_OWNERS) {
      const button = bridge.getFrame(buttonName);
      if (!button) continue;
      const owner = bridge.getFrame(ownerName);
      bridge.update(button, (frame) => {
        frame.buttonState = owner && bridge.isVisible(owner) ? "PUSHED" : "NORMAL";
      });
    }

    // CharacterMicroButton_SetPushed/SetNormal also changes the portrait crop/alpha. Keep that
    // small visual contract in the bridge so CharacterFrame's stock OnShow/OnHide remains usable.
    const character = bridge.getFrame("CharacterFrame");
    const portrait = bridge.getFrame("MicroButtonPortrait");
    if (character && portrait) {
      const pushed = bridge.isVisible(character);
      bridge.update(portrait, (frame) => {
        frame.alpha = pushed ? 0.5 : 1;
        frame.texCoords = pushed
          ? { left: 0.2666, right: 0.8666, top: 0, bottom: 0.8333 }
          : { left: 0.2, right: 0.8, top: 0.0666, bottom: 0.9 };
      });
    }
    return [];
  });
}

/**
 * FrameXML on the glue engine.
 *
 * Slice F1 is an inventory, not a working interface. It brings `Interface\FrameXML` up on exactly
 * the parts G2 built — the same fengari VM with the same measured Lua 5.1 shims, the same XML
 * parser, the same widget bridge and the same handler environment — and answers, with numbers, what
 * the rest of the lane has to pay for. Nothing here tries to make a frame usable; everything here
 * exists to count.
 *
 * The one mechanism that is genuinely new is the stub floor. The glue corpus had fourteen
 * unanswered globals and they could be listed by hand. This corpus names 1313, so the host cannot
 * be written first and measured second: every global the corpus *calls* and never defines resolves
 * to a recording stub created on first touch (see `FrameXmlStubPlan` for why "calls and never
 * defines" and not "anything that misses"), and every widget method it calls with `:` and never
 * attaches itself resolves the same way through the per-type method table. Both start out answering
 * **nothing** — a bare `return` — and are promoted to a typed answer only where a nil provably kills
 * a file's load. Every promotion is recorded below with the error that forced it.
 */

/** Chunk name of the prelude, so its own frames can be skipped when attributing a first touch. */
const PRELUDE_CHUNK = "framexml-boot";

/**
 * The legacy handler environment, which is not a corpus read at all.
 *
 * `GlueWidgets.ts`' invoke helper saves and restores `this`/`event`/`arg1..9` around every
 * dispatch, and at the outermost depth it restores them to nil — which *removes* the key, so the
 * next dispatch misses again. Left in the miss census these are the ten largest entries by a factor
 * of twenty and say nothing about the corpus. Counted on their own they say something useful: the
 * total is the number of handler dispatches the load performed.
 */
const HANDLER_ENVIRONMENT_NAMES: readonly string[] = Object.freeze([
  "this", "event", "arg1", "arg2", "arg3", "arg4", "arg5", "arg6", "arg7", "arg8", "arg9",
]);
const HANDLER_ENVIRONMENT: ReadonlySet<string> = new Set(HANDLER_ENVIRONMENT_NAMES);

/**
 * The host side of the stub floor, in Lua.
 *
 * It lives in Lua rather than in TypeScript for one measured reason: the counters are hit on every
 * call of every stub, and a JS binding round trip per call would make the measurement's own cost
 * the thing being measured. Only two things cross into the host, and both happen once per name —
 * the first-touch traceback, and the final report.
 *
 * The `_G` metatable this installs **replaces** the one `GlueLua.ts` sets up, so that module's rule
 * is carried forward explicitly rather than being lost: a global whose name was built out of 5.3
 * arithmetic is spelled `Name11.0`, and the miss is retried without the suffix.
 */
const FRAMEXML_PRELUDE = `
-- \`or {}\`, because the plan is seeded from the host *before* this runs and the locals below
-- capture the table itself: replacing it here would leave every closure pointing at an empty one.
__fxApi = __fxApi or {}
__fxNeutral = __fxNeutral or {}
__fxCalls = __fxCalls or {}
__fxMisses = __fxMisses or {}
__fxMethodNames = __fxMethodNames or {}
__fxMethodNeutral = __fxMethodNeutral or {}
__fxMethodCalls = __fxMethodCalls or {}
-- Created here and filled by the neutral-API chunk that loads after this one, so
-- the metamethod below can capture the table itself as an upvalue.
__fxNeutralImpl = __fxNeutralImpl or {}
-- Names the corpus declares as font objects, from the scan. Seeded by the host.
__fxFontNames = __fxFontNames or {}

local rawget, rawset, setmetatable, getmetatable = rawget, rawset, setmetatable, getmetatable
local type, unpack, match, byte = type, table.unpack, string.match, string.byte
local api, neutral, calls, misses = __fxApi, __fxNeutral, __fxCalls, __fxMisses
local impl, fontNames = __fxNeutralImpl, __fxFontNames
-- P1-14f: census "touch" (the host sets this before the prelude runs): an answered name is bound to
-- its answer itself after the first read — calls[key] then counts touches, not calls.
local touchOnly = __fxTouchOnly == true

-- Read only source/line in the host. A full debug.traceback recursively searches the
-- growing global table for function names, although this census only needs a location.
local origin = __fxOrigin

local function makeStub(counter, key, values)
  if values == nil then
    return function() counter[key] = (counter[key] or 0) + 1 end
  end
  local size = #values
  return function()
    counter[key] = (counter[key] or 0) + 1
    return unpack(values, 1, size)
  end
end

setmetatable(_G, {
  __index = function(globals, key)
    if type(key) ~= "string" then return nil end
    -- GlueLua.ts' rule, kept: 5.3's \`/\` answers a float, so a global named out of one is
    -- \`CharacterCreateClassButton11.0\`. rawget, so a chain of misses cannot recurse. Only a
    -- name ending in ".0" is matched: every miss comes through here, and most are not that.
    if byte(key, -1) == 48 and byte(key, -2) == 46 then
      local whole = match(key, "^(.-)%.0$")
      if whole ~= nil then return rawget(globals, whole) end
    end
    if api[key] then
      -- A neutral answer that needs state (the CVar map, the add-on list) is a
      -- Lua function the next chunk installed; the wrapper is what keeps it in
      -- the same census as a constant one, with the same counter and the same
      -- first-touch traceback.
      local answer = impl[key]
      local stub
      if answer ~= nil and touchOnly then
        -- P1-14f: no Lua wrapper in front of every C-API call; the touch is counted once.
        calls[key] = (calls[key] or 0) + 1
        stub = answer
      elseif answer ~= nil then
        stub = function(...)
          calls[key] = (calls[key] or 0) + 1
          return answer(...)
        end
      else
        stub = makeStub(calls, key, neutral[key])
      end
      rawset(globals, key, stub)
      __fxNoteApi(key, origin())
      return stub
    end
    -- A font object is neither a stub nor a miss: in the real client it is a
    -- global *object* with the Font API on it, and seven of this corpus' files
    -- die at file scope because it is nil here. Resolved on first read, because
    -- the bridge only knows a font object once the file that declares it has
    -- been parsed, and that happens in the middle of the same load.
    if fontNames[key] then
      local make = rawget(_G, "__fxMakeFont")
      local object = make and make(key) or nil
      if object ~= nil then return object end
    end
    misses[key] = (misses[key] or 0) + 1
    return nil
  end,
})

-- One wrapper per widget type's method table.
--
-- The widget layer builds a separate method table per type and hangs it off that type's metatable
-- as \`__index\`; a metatable *on that table* is therefore a per-type fallback, reached only after a
-- real method has already failed to resolve. Restricting it to names the corpus calls with \`:\` and
-- never assigns itself is what keeps \`if control.SetDisplayValue then\` answering the way it does in
-- the real client — see GlueWidgets.ts, which refuses a universal fallback for exactly that reason.
function __fxWrapMethodTable(methods, typeName)
  if type(methods) ~= "table" then return "no method table" end
  if getmetatable(methods) ~= nil then return "already wrapped" end
  setmetatable(methods, {
    __index = function(table_, key)
      if type(key) ~= "string" then return nil end
      if not __fxMethodNames[key] then return nil end
      local label = typeName .. ":" .. key
      local answer = makeStub(__fxMethodCalls, label, __fxMethodNeutral[key])
      local stub = function(self, ...)
        __fxRecordWidgetStub(self, typeName, key)
        return answer(self, ...)
      end
      rawset(table_, key, stub)
      __fxNoteMethod(label, origin())
      return stub
    end,
  })
  return "wrapped"
end

function __fxWrapMethods(widget, typeName)
  local meta = getmetatable(widget)
  if type(meta) ~= "table" then return "no metatable" end
  return __fxWrapMethodTable(meta.__index, typeName)
end

function __fxProbeWidgets(types, fontSetters, attributeTypes)
  local host = CreateFrame("Frame")
  local wrapped = 0
  local probes = 1
  local fontWraps = 0
  local attributeInstalls = 0
  local wrapFonts = rawget(_G, "__fxWrapFontMethods")
  local installAttributes = rawget(_G, "__fxInstallAttributes")
  for index = 1, #types do
    local name = types[index]
    local widget
    if name == "Texture" then widget = host:CreateTexture()
    elseif name == "FontString" then widget = host:CreateFontString()
    else widget = CreateFrame(name) end
    if widget ~= nil then
      probes = probes + 1
      widget:Hide()
      -- Order matters: the font-object interop replaces real entries in the
      -- method table, and the census fallback only ever sees names that are not
      -- there at all, so wrapping for fonts first keeps both honest.
      if wrapFonts then fontWraps = fontWraps + wrapFonts(widget, fontSetters) end
      -- F3's secure attributes, before the census fallback for the same reason:
      -- a name that is really in the table is never seen by the metamethod.
      if installAttributes and attributeTypes[name] then
        attributeInstalls = attributeInstalls + installAttributes(widget, name == "Cooldown")
      end
      if __fxWrapMethods(widget, name) == "wrapped" then wrapped = wrapped + 1 end
    end
  end
  -- Font objects get the same treatment as a widget type: an unimplemented Font
  -- method is recorded as \`Font:Name\` with its first touch, not raised.
  __fxWrapMethodTable(rawget(_G, "__fxFontMethods"), "Font")
  host:Hide()
  return wrapped, probes, fontWraps, attributeInstalls
end

function __fxReport()
  for name, count in pairs(calls) do __fxEmit("api", name, count) end
  for name, count in pairs(misses) do __fxEmit("miss", name, count) end
  for name, count in pairs(__fxMethodCalls) do __fxEmit("method", name, count) end
  local fontCalls = rawget(_G, "__fxFontCalls")
  if fontCalls then
    for name, count in pairs(fontCalls) do __fxEmit("font", name, count) end
  end
  local attrCalls = rawget(_G, "__fxAttrCalls")
  if attrCalls then
    for name, count in pairs(attrCalls) do __fxEmit("attr", name, count) end
  end
end
`;

/**
 * Lua 5.1 names the in-world corpus needs and the glue shim does not carry.
 *
 * Measured, one at a time, by the failure each one caused. They are *shims*, not stubs: the host
 * answers them honestly, so they never appear in the gold list.
 *
 * Full function-environment mutation remains absent — see `vm.setfenvSites` in the inventory.
 * The one root add-on call measured in this client is `getfenv(0)`, whose Lua 5.1 answer is exactly
 * `_G`; that safe, non-mutating form is supplied below without exposing the debug library.
 * L5 3.27 (03.10): `getfenv` and `newproxy` below are now stand-ins only — FrameXmlLuaEnvironment.ts
 * installs 5.1's `newproxy` (userdata), `setfenv` and `getfenv` over them right after this chunk.
 */
const FRAMEXML_LUA51_SHIMS = `
-- The only environment lookup in the selected client add-ons is getfenv(0), used to capture the
-- global table before localising standard functions. Function/stack-level environment inspection
-- and setfenv remain unsupported because emulating those would require debug upvalue access.
function getfenv(target)
  if target == nil or target == 0 then return _G end
  error("getfenv only supports level 0 in the browser client", 2)
end

-- 3.3.5's hook protocol. Two shapes: (table, name, hook) and (name, hook) against _G. The original
-- runs the hook *after* the original and discards its results; the original's results are what the
-- caller gets back.
function hooksecurefunc(target, name, hook)
  if hook == nil then
    target, name, hook = _G, target, name
  end
  if type(target) ~= "table" or type(hook) ~= "function" then return end
  local original = target[name]
  if type(original) ~= "function" then return end
  target[name] = function(...)
    local results = { original(...) }
    hook(...)
    return table.unpack(results)
  end
end

-- 5.1's newproxy, which 5.2 removed. RestrictedExecution.lua calls it at file scope
-- (\`local LOCAL_Restricted_Prototype = newproxy(true)\`), so without it that file dies on its
-- twenty-third line and takes the secure-handler layer with it. A table is not a userdata and
-- \`type()\` says so; that difference is recorded in the inventory rather than papered over.
function newproxy(prototype)
  local proxy = {}
  if prototype == true then
    setmetatable(proxy, {})
  elseif type(prototype) == "table" then
    setmetatable(proxy, getmetatable(prototype))
  end
  return proxy
end

-- The taint vocabulary. This client models no taint (GlueLua.ts: \`issecure\` answers honestly),
-- so \`scrub\` is the identity it degrades to when nothing is tainted and \`forceinsecure\` is a
-- no-op. Both are named here rather than left to the stub floor because a stub returning nothing
-- would silently drop every argument \`scrub\` was given.
function scrub(...) return ... end
function forceinsecure() end
function debugstack(level) return debug.traceback("", (level or 1) + 1) end
-- 3.3.5 publishes \`wipe\` twice: as a global (the glue preamble already has it)
-- and inside \`table\`. \`BuffFrame.lua:84\` calls the second spelling, and 5.3's
-- table library does not carry it, so the buff frame died on «attempt to call a
-- nil value (field 'wipe')». Same function, aliased — the vocabulary, not the API.
table.wipe = wipe
function debugprofilestart() end
function debugprofilestop() return 0 end

-- LuaBitOp, which 3.3.5 links into its Lua 5.1 and 5.3 replaced with operators.
--
-- Measured need: \`bor\` 13, \`band\` 13, \`rshift\` 3, \`lshift\` 1 — and the first \`bor\` is
-- \`Constants.lua:286\`, ninety lines before that file defines \`PI\`, \`QuestDifficultyColors\` and
-- the rest of the constants every later file reads. Without this the corpus lost Constants.lua,
-- AutoComplete.lua and TalentFrameBase.lua outright and four more files to the cascade.
-- \`bnot\`/\`bxor\`/\`tobit\`/\`tohex\` are here because they cost four lines and a missing one would
-- be the same cascade again.
--
-- LuaBitOp normalises to a *signed* 32-bit result, which is what the corpus' own
-- \`COMBATLOG_OBJECT_NONE = 0x80000000\` comparisons expect.
--
-- fengari's integers are 32-bit, not 5.3's 64: \`0xFFFFFFFF\` reads as -1, \`1 << 31\` is negative, and a
-- number at or past 2^31 (a GUID half, a flag sum, \`3000000000\`) is a float that an integer operator
-- refuses ("number has no integer representation"). So every argument is brought into the signed
-- 32-bit range in float arithmetic first — floor, then modulo 2^32 — and only then meets \`&\`, \`|\`,
-- \`~\` or \`<<\`, which wrap the same way in fengari and in a 64-bit Lua once \`s32\` folds the result.
-- The shifts that must not sign-extend or must keep the sign are float divisions by 2^n.
do
  local floor, tonumber, select, tointeger = math.floor, tonumber, select, math.tointeger
  local TWO32, TWO31 = 4294967296.0, 2147483648.0
  local function s32(value)
    local raw = floor(tonumber(value) or 0) % TWO32
    if raw >= TWO31 then raw = raw - TWO32 end
    return tointeger(raw) or 0
  end
  local function fold(operation, first, ...)
    local result = s32(first)
    for index = 1, select("#", ...) do
      result = s32(operation(result, s32((select(index, ...)))))
    end
    return result
  end
  bit = {
    tobit = function(value) return s32(value) end,
    bnot = function(value) return s32(~s32(value)) end,
    band = function(first, ...) return fold(function(a, b) return a & b end, first, ...) end,
    bor = function(first, ...) return fold(function(a, b) return a | b end, first, ...) end,
    bxor = function(first, ...) return fold(function(a, b) return a ~ b end, first, ...) end,
    lshift = function(value, shift) return s32(s32(value) << (s32(shift) & 31)) end,
    -- Logical: the unsigned value, divided down.
    rshift = function(value, shift) return s32(floor((s32(value) % TWO32) / 2 ^ (s32(shift) & 31))) end,
    -- Arithmetic, so a negative value keeps its sign: floor division by a power of two.
    arshift = function(value, shift) return s32(floor(s32(value) / 2 ^ (s32(shift) & 31))) end,
    -- Two 16-bit halves: \`%x\` of a negative integer is 8 digits in fengari but 16 in a 64-bit Lua.
    tohex = function(value)
      local unsigned = s32(value) % TWO32
      return string.format("%04x%04x", floor(unsigned / 65536), unsigned % 65536)
    end,
  }
end

-- The error census.
--
-- \`BasicControls.xml\` installs \`seterrorhandler(_ERRORMESSAGE)\` before any screen loads, and from
-- then on the invoke helper delivers every handler error *there* instead of to the VM's own sink —
-- so \`vm.errors\` sees only file-level failures. Measured on the first run of this slice: 15 in
-- \`vm.errors\` against 385 the corpus handled, which is the difference between an error census and
-- a rounding error. The corpus' handler still runs, unchanged, because what it does with an error
-- (\`LoadAddOn\`, \`IsAddOnLoaded\`, \`GetCVarBool\`) is itself part of the inventory.
do
  local install = seterrorhandler
  function seterrorhandler(handler)
    if type(handler) ~= "function" then return install(handler) end
    return install(function(message)
      __fxNoteError(tostring(message))
      return handler(message)
    end)
  end
end
`;

/**
 * Stock 3.3.5 item-quality colors returned by the client's C API.
 *
 * The fourth value is a colour code, `|c` included: UIParent.lua:96-102 stores it as
 * `ITEM_QUALITY_COLORS[i].hex`, and its readers write `hex..name.."|r"` with no `|c` of their own
 * (UIParent.lua:583/844-857, LootFrame.lua:303, UnitPopup.lua:411). Quality 7 (heirloom) shares the
 * artifact colour in 3.3.5; the blue `00ccff` is a later client's.
 */
const FRAMEXML_ITEM_QUALITY_COLORS: Readonly<Record<number, readonly [number, number, number, string]>> = Object.freeze({
  [-1]: [1, 1, 1, "|cffffffff"],
  0: [0.62, 0.62, 0.62, "|cff9d9d9d"],
  1: [1, 1, 1, "|cffffffff"],
  2: [0.12, 1, 0, "|cff1eff00"],
  3: [0, 0.44, 0.87, "|cff0070dd"],
  4: [0.64, 0.21, 0.93, "|cffa335ee"],
  5: [1, 0.5, 0, "|cffff8000"],
  6: [0.9, 0.8, 0.5, "|cffe6cc80"],
  7: [0.9, 0.8, 0.5, "|cffe6cc80"],
});

/** Which shims F1 added, for the report; kept as data so prose and code cannot drift. */
export const FRAMEXML_ADDED_SHIMS: readonly string[] = Object.freeze([
  "getfenv(0)", "hooksecurefunc", "newproxy", "scrub", "forceinsecure", "debugstack",
  "debugprofilestart", "debugprofilestop", "table.wipe",
  "bit.tobit", "bit.bnot", "bit.band", "bit.bor", "bit.bxor", "bit.lshift", "bit.rshift",
  "bit.arshift", "bit.tohex",
]);

/**
 * The first frames of a live client, as events. A TOC walk only runs `OnLoad`, and almost every
 * in-world API call in FrameXML is behind one of these.
 *
 * `FRAMEXML_EXERCISE_EVENTS` is the census probe's set: its `ADDON_LOADED` carries the made-up name
 * `Blizzard_FrameXML` to reach every handler of the event, which the real client never raises for
 * FrameXML.toc. The session's own order is `FRAMEXML_VERTICAL_EXERCISE_EVENTS` below.
 */
export type FrameXmlExerciseEvent =
  | "VARIABLES_LOADED" | "ADDON_LOADED" | "PLAYER_LOGIN" | "PLAYER_ENTERING_WORLD";

export const FRAMEXML_EXERCISE_EVENTS: readonly FrameXmlExerciseEvent[] = Object.freeze([
  "VARIABLES_LOADED", "ADDON_LOADED", "PLAYER_LOGIN", "PLAYER_ENTERING_WORLD",
]);

/**
 * The session edges in Wow.exe 3.3.5a 12340's order (read-only Ghidra). The game-UI start
 * (0x0052a980) marks the character not logged in, runs FrameXML.toc — the TSWoW blocks included,
 * with no ADDON_LOADED of its own — then every enabled add-on, each closed by its ADDON_LOADED
 * (0x005f80b0, after its SavedVariables ran; FrameXmlAddonRuntime.ts), then asks for the two account
 * data sets and raises VARIABLES_LOADED once both are at hand (0x00518bf0; at once when they are
 * cached — this browser keeps them locally), and with the player in the world enters it
 * (0x00528010): PLAYER_LOGIN once per UI, cleared flag first so IsLoggedIn (0x0060a450) already
 * answers 1 inside it, then PLAYER_ENTERING_WORLD. The add-ons' ADDON_LOADED is raised by the load
 * itself, so it is not in this list.
 */
export const FRAMEXML_VERTICAL_EXERCISE_EVENTS: readonly FrameXmlExerciseEvent[] = Object.freeze([
  "VARIABLES_LOADED", "PLAYER_LOGIN", "PLAYER_ENTERING_WORLD",
]);

/**
 * Stubs promoted from nil to a typed answer, each with the failure that forced it.
 *
 * The rule the slice brief sets: start at nil, promote only where nil kills a file's load, record
 * every promotion. Nothing is here on the strength of a wiki signature.
 */
export const FRAMEXML_PROMOTED_STUBS: readonly FrameXmlPromotion[] = Object.freeze([]);

/**
 * Widget-method stubs promoted the same way — and, unlike the global ones, *added* to the set.
 *
 * The plan refuses to stub a method name the corpus attaches to one of its own tables, because
 * `if control.SetDisplayValue then` has to keep answering the way the real client answers. Measured,
 * that rule has exactly one false negative in this corpus, and it is an expensive one: `HANDLE`
 * in `RestrictedFrames.lua:507` is a *proxy* for a frame, so `function HANDLE:SetAttribute` reads
 * as "the corpus owns this name" when in fact the widget owns it. Promotions override the rule, one
 * measured failure at a time.
 */
export const FRAMEXML_PROMOTED_METHODS: readonly FrameXmlPromotion[] = Object.freeze([]);

/**
 * The two names that graduated out of the list above, and what happened to them.
 *
 * F1 promoted `SetAttribute`/`GetAttribute` from «raises» to «records nothing» because 145 raises
 * forced it, and F2 recorded 1,672 calls landing in that recording no-op. F3 replaces both with a
 * real store (`FrameXmlSecureAttributes.ts`), which means they are no longer promotions at all:
 * the method table carries the implementation, the census fallback never sees the names, and the
 * `neutral` column of the report cannot show them because they are methods rather than globals.
 * Kept as data so the census test can assert the graduation instead of the absence.
 */
export const FRAMEXML_IMPLEMENTED_METHODS: readonly FrameXmlPromotion[] = Object.freeze([
  {
    name: "SetAttribute",
    values: [],
    reason: "F1: 145 raises — ActionButton.lua:83 (90), UIDropDownMenu.lua:42 (52), "
      + "UIParent.lua:1951 (3). F2: 1,672 calls into a recording no-op. F3: a real per-frame store, "
      + "with OnAttributeChanged dispatched after every write.",
  },
  {
    name: "GetAttribute",
    values: [],
    reason: "The read half of the same surface: 140 static call sites, and the three-argument "
      + "wildcard cascade SecureTemplates.lua:160 depends on. F3 implements both forms.",
  },
  {
    name: "SetCooldown",
    values: [],
    reason: "One call site in the whole corpus (Cooldown.lua, eight lines) and the only part of an "
      + "action button that cannot be faked by drawing. F3 stores start/duration on the widget and "
      + "the DOM renderer sweeps a conic gradient over it.",
  },
]);

/**
 * C-side global *constants* — a category the stub floor cannot manufacture.
 *
 * A stub is a function, created when a name that the corpus *calls* misses. A name it only reads is
 * left nil on purpose, because that is how `_G["ActionButton" .. index]` is allowed to run out. That
 * leaves a third kind: a value the C client publishes and the corpus reads.
 *
 * Measured at boot, exactly one is load-bearing. `GameTime.lua:16` is `local PI = PI;` and line 17
 * divides by it, so without this the clock frame dies — and this corpus has no `PI = ` anywhere,
 * because in the real client the C side publishes it. Anything else that turns up joins this list
 * with its own failure quoted.
 */
export const FRAMEXML_HOST_CONSTANTS: Readonly<Record<string, unknown>> = Object.freeze({
  PI: Math.PI,
});

/**
 * A VM that times what it runs.
 *
 * `executeReported` is the loader's only entry point for a corpus chunk, so overriding it is how a
 * per-file cost is obtained without touching `GlueLoader`. Safe against the base constructor
 * because that one calls `execute`, never `executeReported` — so the field is always initialised by
 * the time the override can run.
 */
class TimedGlueLuaVm extends GlueLuaVm {
  readonly chunkTimings: FrameXmlFileTiming[] = [];

  override executeReported(source: string, chunkName: string, args: readonly unknown[] = []): boolean {
    const started = now();
    const ok = super.executeReported(source, chunkName, args);
    this.chunkTimings.push({ chunk: chunkName.replace(/^@/, ""), ms: now() - started, ok });
    return ok;
  }
}

function now(): number {
  return typeof performance === "object" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

export interface FrameXmlBootOptions {
  /** Production world mounts yield between load steps so cached files cannot starve painting. */
  readonly loadScheduler?: GlueLoadScheduler;
  readonly savedVariables?: FrameXmlSavedVariablesOptions;
  /** Where the interface files come from; the gateway's `/client/file` in the browser. */
  readonly provider: GlueFileProvider;
  /** Defaults to `interface/framexml/framexml.toc`. */
  readonly toc?: string;
  /** `?file=` — load one file (and whatever it includes) instead of the whole TOC. */
  readonly only?: string | null;
  /**
   * A dependency subset of the TOC — `FRAMEXML_VERTICAL_TOC` is the measured one for the bar.
   *
   * Ignored when `only` is set. The plan, the scan and the loader all read this TOC, so the stub
   * floor is derived from exactly the files that will run.
   */
  readonly subset?: readonly string[];
  /**
   * Preserve the generated `tsaddon-begin-lib` and named TSAddon blocks from the active TOC after
   * the measured stock subset. Production follows its addon preference; stock-only tests omit it.
   */
  readonly includeActiveTsAddons?: boolean;
  readonly lua?: GlueLuaOptions;
  readonly locale?: string;
  readonly screen?: () => { readonly width: number; readonly height: number };
  /**
   * Dispatch the first four events of a live session after the TOC walk. Default true.
   *
   * Off for a `?file=` run, where the point is one subtree and not a session.
  */
  readonly exercise?: boolean;
  /** Override the typed session-event subset used by the exercise; defaults to all four events. */
  readonly exerciseEvents?: readonly FrameXmlExerciseEvent[];
  /**
   * Where the world comes from. Absent leaves F2's neutral answers in place, which is what the
   * census measures and what `tests/framexml-corpus.test.mjs` pins.
   */
  readonly seam?: FrameXmlWorldSeam;
  /** The world host paints stock QuestFramePortrait with its existing unit portrait renderer. */
  readonly onQuestPortrait?: (guid: bigint | undefined) => void;
  /** Every other stock SetPortraitTexture(texture, unit), unit lower-cased (FrameXmlPortraits.ts). */
  readonly onUnitPortrait?: (texture: FrameXmlFrame, unit: string) => void;
  /** Optional owner for the measured special methods on the legacy 3.3.5 Minimap widget. */
  readonly minimapAdapter?: MinimapWidgetAdapter;
  /** Optional item owner for GameTooltip; defaults to the supplied world seam's cached items. */
  readonly gameTooltipAdapter?: GameTooltipWidgetAdapter;
  /** Live TSWoW custom-packet transport. Absent leaves `_CLIENT_NETWORK` to the measured stub floor. */
  readonly clientNetwork?: FrameXmlClientNetworkTransport;
  /** The opcodes the TSWoW Lua subscribes to, on each change and empty at close (9.08). */
  readonly clientNetworkChanged?: (opcodes: ReadonlySet<number>) => void;
  /** Root-level add-ons present in the selected client. */
  readonly installedAddons?: readonly string[];
  /** Enabled non-LoD add-ons executed before the first world event. */
  readonly eagerAddons?: readonly string[];
  /**
   * Host publication seam that runs after the corpus has loaded and before the synthetic session
   * exercise dispatches its events.  World UI uses this narrow window to replace handlers on a
   * stock row and hide it before PLAYER_ENTERING_WORLD can paint it; callers that do not need a
   * pre-exercise publication leave it unset.
   */
  readonly beforeExercise?: (boot: FrameXmlBoot) => void;
  /**
   * The held modifiers and the current click's button behind IsShiftKeyDown, IsModifiedClick and
   * MODIFIER_STATE_CHANGED. Defaults to the page's own tracker, which a page-less boot never feeds.
   */
  readonly modifiers?: ModifierSource;
  /** L5 3.27: the milliseconds behind GetTime and `pump.now` (FrameXmlClock.ts); the page's monotonic clock by default. */
  readonly clock?: FrameXmlClockSource;
  /**
   * P1-14f: how the stub floor counts an *answered* C-API name. "calls" (the default — tests and
   * framexml.html) keeps a Lua wrapper in front of the answer and counts every call; "touch" binds
   * the global to the answer itself after the first read, so `__fxCalls` (and `frameXmlWorld().api`)
   * says 1 for it. Unanswered names count every call in both modes.
   */
  readonly census?: "calls" | "touch";
}

/** The build string the glue slice measured; the same client, so the same answer. */
const FRAMEXML_BUILD_INFO: readonly unknown[] = Object.freeze(["3.3.5", "12340", "Jul  2 2010", 30300]);

interface StubTouch {
  readonly firstTouch: string;
}

export class FrameXmlBoot {
  readonly vm: TimedGlueLuaVm;
  readonly bridge: FrameXmlUiBridge;
  readonly binder: GlueWidgetBinder;
  readonly corpus: FrameXmlCorpus;
  readonly #addons: FrameXmlAddonRuntime;
  readonly #savedVariables: FrameXmlSavedVariables;
  /** Plan item 3.19: the CVars and modified clicks the stock UI wrote, across sessions. */
  readonly #cvarStore: FrameXmlCVarStore | undefined;
  #stopSavedVariablesPersistence: (() => void) | undefined;
  #closed = false;
  /** Behind IsLoggedIn: set as the exercise raises PLAYER_LOGIN. */
  readonly #login = new FrameXmlLoginState();
  #stopModifierEvents: (() => void) | undefined;
  readonly #clientNetwork: FrameXmlClientNetworkBridge | undefined;
  readonly #options: FrameXmlBootOptions;
  /** SoundPlayer's only output route is the browser's default Web Audio destination. */
  readonly #browserAudioOutput: boolean;
  readonly #apiTouches = new Map<string, StubTouch>();
  readonly #methodTouches = new Map<string, StubTouch>();
  readonly #emitted = {
    api: new Map<string, number>(),
    miss: new Map<string, number>(),
    method: new Map<string, number>(),
    font: new Map<string, number>(),
    attr: new Map<string, number>(),
  };
  readonly #binderStubs: string[] = [];
  /** Errors the corpus' own `_ERRORMESSAGE` took, raw, in the order they were raised. */
  readonly #handledErrors: string[] = [];
  #exercise = {
    events: [] as string[], dispatched: 0,
    apiBefore: 0, apiAfter: 0, methodsBefore: 0, methodsAfter: 0, errorsBefore: 0, errorsAfter: 0,
  };
  #plan: FrameXmlStubPlan | undefined;
  #inventory: FrameXmlInventory | undefined;
  #roots: readonly FrameXmlFrame[] = [];
  readonly #addonRootNames = new Set<string>();
  #tsAddonResults: readonly FrameXmlTsAddonStatus[] = [];
  #tsAddonHints: readonly FrameXmlGlobalSelfCall[] = [];
  readonly #tsAddonFrames = new Map<FrameXmlFrame, string>();
  readonly #seenTocFrames = new Set<FrameXmlFrame>();

  /** Includes frames created later by module commands, events and shared helpers. */
  get tsAddonFrames(): ReadonlyMap<FrameXmlFrame, string> { return this.#tsAddonFrames; }

  tsAddonOwner(frame: FrameXmlFrame): string | undefined { return this.#tsAddonFrames.get(frame); }
  readonly #addonResults: FrameXmlAddonRuntimeResult[] = [];
  #probeFrames = 0;
  #wrappedTypes = 0;
  /** Font objects the corpus actually reached, with what `GetFont` answers. */
  readonly #fontObjects = new Map<string, FrameXmlFontRecord>();
  #fontMethodWraps = 0;
  /** Method-table entries F3 wrote: `SetAttribute`/`GetAttribute` per type, plus `SetCooldown`. */
  #attributeInstalls = 0;
  /** How many `OnAttributeChanged` handlers ran because an attribute was written. */
  #attributeDispatches = 0;
  /**
   * Lua values held in an attribute store, so the registry reference outlives the binding call.
   *
   * `pushBinding` releases every reference it decoded the moment the binding returns — a
   * deliberate rule, and the right one for a method that only reads its arguments. An attribute
   * store keeps them, so anything that arrives as a reference is retained here and the previous
   * holder of that key released, which is the difference between storing a Lua table and storing a
   * registry slot that has already been reused.
   */
  readonly #retainedAttributes = new WeakMap<object, Map<string, GlueLuaRef>>();
  /** The synthetic TOC of a subset load, or undefined for the whole corpus. */
  readonly #subsetToc: string | undefined;

  /** L5 3.27: GetTime's clock — whole milliseconds that never go back (FrameXmlClock.ts). */
  readonly #clock: () => number;

  constructor(options: FrameXmlBootOptions) {
    this.#options = options;
    this.#clock = createFrameXmlClock(options.clock); // L5 3.27
    this.#browserAudioOutput = typeof globalThis.AudioContext === "function"
      || typeof (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext === "function";
    // The subset TOC is injected *under* the corpus rather than over it, so the scan, the stub plan
    // and the loader all walk the same short list. `?file=` keeps F1's rule instead — one file
    // loads, but the plan is still built from the whole corpus, because a single file's stub floor
    // would be incomplete.
    const subset = !options.only && options.subset && options.subset.length > 0
      ? options.includeActiveTsAddons
        ? subsetWithActiveTsAddonsTocProvider(options.provider, options.subset)
        : subsetTocProvider(options.provider, options.subset)
      : undefined;
    this.#subsetToc = subset?.toc;
    this.corpus = new FrameXmlCorpus(subset?.provider ?? options.provider, { checkpoint: this.checkpoint });
    this.vm = new TimedGlueLuaVm(options.lua ?? {});
    this.#clientNetwork = options.clientNetwork
      ? new FrameXmlClientNetworkBridge(this.vm, options.clientNetwork,
        (callback) => this.bridge.runInMutationBatch(callback), options.clientNetworkChanged)
      : undefined;
    this.bridge = new FrameXmlUiBridge(new FrameXmlTemplateRegistry(), {
      // `text="SOME_GLOBAL_STRING"` in XML: GlobalStrings.lua is the TOC's first entry, so by the
      // time any XML is parsed the VM is the table that answers.
      globalStringResolver: (key) => this.vm.globalString(key),
    });
    const gameTooltipAdapter = options.gameTooltipAdapter
      ?? createFrameXmlCharacterTooltipAdapter(options.seam);
    this.binder = new GlueWidgetBinder(this.vm, this.bridge, {
      onBindFrame: (frame) => {
        const owner = this.vm.callingSources().map((source) =>
          source.replaceAll("\\", "/").match(/\/tsaddons\/([^/]+)\//i)?.[1]?.toLowerCase())
          .find((name) => name !== undefined && name !== "lib");
        if (owner) this.#tsAddonFrames.set(frame, owner);
      },
      onStub: (method) => { this.#binderStubs.push(method); },
      implicitGlobals: "referenced",
      ...(options.minimapAdapter === undefined ? {} : { minimapAdapter: options.minimapAdapter }),
      ...(gameTooltipAdapter === undefined ? {} : { gameTooltipAdapter }),
    });
    this.bridge.setRuntime(this.parentFirstRuntime(this.binder));
    this.#savedVariables = new FrameXmlSavedVariables(this.vm, options.savedVariables);
    this.#cvarStore = options.savedVariables ? new FrameXmlCVarStore(
      options.savedVariables.storage, frameXmlCVarStorageKey(options.savedVariables.scope.account),
    ) : undefined;
    this.#addons = new FrameXmlAddonRuntime({
      provider: this.corpus,
      checkpoint: this.checkpoint,
      vm: this.vm,
      bridge: this.bridge,
      savedVariables: this.#savedVariables,
      ...(options.installedAddons === undefined ? {} : { loadOnDemand: options.installedAddons }),
      onRoots: (roots) => {
        for (const root of roots) this.#addonRootNames.add(root.name);
        this.#roots = [...this.#roots, ...roots];
      },
    });
  }

  /**
   * The binder, with one thing put back in the client's order: a parent exists
   * before its children do.
   *
   * `parentKey="check"` publishes a child on its parent as `parent.check`, and
   * the binder does exactly that — but only if the parent already has a Lua
   * table, and it does not: the bridge builds a widget's children first and
   * binds the widget itself afterwards, so every `parentKey` in the corpus
   * landed on a parent that did not exist yet and was silently dropped.
   *
   * Measured on this corpus before the fix: **130 of 252 raises** are
   * «attempt to index a nil value (field 'X')» where X is a parentKey —
   * `.check` 22, `.name` 15, `.enableButton` 29, `.highlight` 23, and 60 more
   * spread one per frame across the scroll-list templates.
   *
   * Binding the ancestor chain first is idempotent (the binder returns early for
   * a frame it already knows) and changes nothing else: the frame that asked is
   * still bound at the same moment, its parent is simply bound a little earlier
   * than the bridge would have. The proper home for this is the bridge/binder
   * pair, and this stays inside the FrameXML boot so the glue lane's own
   * ordering is untouched.
   */
  private parentFirstRuntime(binder: GlueWidgetBinder): LuaAddonRuntime {
    return {
      name: binder.name,
      get luaVersion(): string { return binder.luaVersion; },
      execute: (source, context) => { binder.execute(source, context); },
      compileScript: (request) => binder.compileScript(request),
      resolveGlobalHandler: (name) => binder.resolveGlobalHandler(name),
      bindFrame: (frame) => {
        const chain: FrameXmlFrame[] = [];
        for (let current: FrameXmlFrame | undefined = frame; current; current = current.parent) {
          chain.push(current);
        }
        for (let index = chain.length - 1; index >= 0; index -= 1) {
          const ancestor = chain[index];
          if (ancestor) binder.bindFrame(ancestor);
        }
      },
        releaseFrame: (frame) => { binder.releaseFrame(frame); },
        bindAnimations: (frame, elements) => { binder.bindAnimations(frame, elements); },
        tickAnimations: (elapsedSeconds) => { binder.tickAnimations(elapsedSeconds); },
        hideAnimations: (frame) => { binder.hideAnimations(frame); },
    };
  }

  /** Widget methods the *glue* layer already recognises but implements as a no-op. */
  get binderStubs(): readonly string[] {
    return this.#binderStubs;
  }

  get inventory(): FrameXmlInventory | undefined {
    return this.#inventory;
  }

  get plan(): FrameXmlStubPlan | undefined {
    return this.#plan;
  }

  /** Top-level frames the TOC produced, for a host that wants to mount them. */
  get roots(): readonly FrameXmlFrame[] {
    return this.#roots;
  }

  /** Visible root names authored by successfully loaded root-level add-ons. */
  get addonRootNames(): ReadonlySet<string> {
    return this.#addonRootNames;
  }

  /** Startup results retain failures instead of silently pretending an installed add-on loaded. */
  get addonResults(): readonly FrameXmlAddonRuntimeResult[] {
    return this.#addonResults;
  }

  /** TSWoW blocks' `_G:Name(…)` calls, found at load (plan item 9.09). */
  get tsAddonHints(): readonly FrameXmlGlobalSelfCall[] {
    return this.#tsAddonHints;
  }

  get tsAddonResults(): readonly FrameXmlTsAddonStatus[] {
    return this.#tsAddonResults;
  }

  private readonly checkpoint = async (): Promise<void> => {
    if (this.#closed) throw new Error("FrameXML load cancelled");
    await this.#options.loadScheduler?.checkpoint();
    if (this.#closed) throw new Error("FrameXML load cancelled");
  };

  /**
   * Read the corpus, derive the stub floor, run it, and count everything that happened.
   *
   * The order is the measurement: the plan has to be complete before the first chunk executes,
   * because a global stubbed after the file that needed it is a global that was nil when it
   * mattered.
   */
  async load(): Promise<FrameXmlInventory> {
    const startedAt = now();
    const tocPath = this.#options.toc ?? this.#subsetToc ?? FRAMEXML_TOC_PATH;
    const scanStarted = now();
    const scan = await this.corpus.scan(tocPath);
    const scanMs = now() - scanStarted;

    const planStarted = now();
    await this.checkpoint();
    const plan = await frameXmlStubPlanAsync(scan.chunks, this.checkpoint);
    this.#plan = plan;
    const planMs = now() - planStarted;
    // 9.09: `_G:Name(…)` in a TSWoW block — reported, run as Wow.exe runs it (FrameXmlTsAddonLint.ts).
    this.#tsAddonHints = scan.chunks
      .filter((chunk) => frameXmlIsTsAddonChunk(chunk.file) && /_G\s*:/.test(chunk.source))
      .flatMap((chunk) => frameXmlGlobalSelfCalls(chunk.source, chunk.file));
    await this.checkpoint();

    const tsAddons = new FrameXmlTsAddonTracker(
      await this.corpus.read(tocPath) ?? "", tocPath.slice(0, tocPath.lastIndexOf("/") + 1),
    );
    await this.checkpoint();
    this.installBindings();
    this.#savedVariables.installBindings();
    this.#savedVariables.registerToc(await this.corpus.read(tocPath) ?? "");
    // Seeded first: the prelude's closures capture these tables, so they have to be the final ones.
    this.installStubFloor(plan, scan);
    this.vm.setGlobal("__fxBrowserAudioOutput", this.#browserAudioOutput);
    this.vm.setGlobal("__fxLocale", this.#options.locale ?? "ruRU");
    const preludeLoaded = this.vm.execute(FRAMEXML_PRELUDE, `@${PRELUDE_CHUNK}`);
    if (!preludeLoaded.ok) throw new Error(`framexml prelude failed: ${preludeLoaded.error}`);
    // After the prelude, because both fill tables it created and captured.
    const fontsLoaded = this.vm.execute(FRAMEXML_FONT_PRELUDE, `@${PRELUDE_CHUNK}:fonts`);
    if (!fontsLoaded.ok) throw new Error(`framexml font objects failed: ${fontsLoaded.error}`);
    const neutralLoaded = this.vm.execute(FRAMEXML_NEUTRAL_PRELUDE, `@${PRELUDE_CHUNK}:neutral`);
    if (!neutralLoaded.ok) throw new Error(`framexml neutral api failed: ${neutralLoaded.error}`);
    const hasBagButtons = scan.files.some((file) => file.path.endsWith("/mainmenubarbagbuttons.xml"));
    const hasPaperDoll = scan.files.some((file) => file.path.endsWith("/paperdollframe.lua"));
    if (hasBagButtons && !hasPaperDoll) {
      const bagCompatLoaded = this.vm.execute(FRAMEXML_BAG_COMPAT_PRELUDE, `@${PRELUDE_CHUNK}:bags`);
      if (!bagCompatLoaded.ok) throw new Error(`framexml bag compat failed: ${bagCompatLoaded.error}`);
    }
    const hasCharacterFrame = scan.files.some((file) => file.path.endsWith("/characterframe.xml"));
    if (hasCharacterFrame && hasPaperDoll) {
      const realOptional = new Set(
        scan.files
          .filter((file) => file.path.endsWith(".xml"))
          .map((file) => file.path.slice(file.path.lastIndexOf("/") + 1)),
      );
      const optional = FRAMEXML_CHARACTER_OPTIONAL_SUBFRAMES
        .filter(({ name }) => !realOptional.has(`${name.toLowerCase()}.xml`))
        .map(({ name, id }) => [name, id]);
      this.vm.setGlobal("__fxCharacterOptionalSubframes", optional);
      const characterCompatLoaded = this.vm.execute(
        FRAMEXML_CHARACTER_COMPAT_PRELUDE, `@${PRELUDE_CHUNK}:character`,
      );
      if (!characterCompatLoaded.ok) {
        throw new Error(`framexml character compat failed: ${characterCompatLoaded.error}`);
      }
    }
    const shimsLoaded = this.vm.execute(FRAMEXML_LUA51_SHIMS, `@${PRELUDE_CHUNK}:shims`);
    if (!shimsLoaded.ok) throw new Error(`framexml 5.1 shims failed: ${shimsLoaded.error}`);
    // L5 3.27: 5.1's newproxy (userdata), setfenv and getfenv over the stand-ins above (FrameXmlLuaEnvironment.ts).
    installFrameXmlLuaEnvironment(this.vm.state);
    // 05.10-3.27b: SetEuropeanNumbers sets the `%F` flag of format and SetFormattedText (FrameXmlEuropeanNumbers.ts).
    installFrameXmlEuropeanNumbers(this.vm.state);
    const attributesLoaded = this.vm.execute(
      FRAMEXML_ATTRIBUTE_PRELUDE, `@${PRELUDE_CHUNK}:attributes`,
    );
    if (!attributesLoaded.ok) throw new Error(`framexml attributes failed: ${attributesLoaded.error}`);
    // After the neutral chunk created `__fxNeutralImpl`, and before the corpus runs: the `_G`
    // metamethod reads `impl[name]` on the *first touch* of a name, and the corpus touches
    // `HasAction` while `ActionButton1` is still loading.
    if (this.#options.seam) {
      this.vm.setGlobal("__fxSeamNames", [...FRAMEXML_SEAM_NAMES]);
      const seamLoaded = this.vm.execute(FRAMEXML_SEAM_PRELUDE, `@${PRELUDE_CHUNK}:seam`);
      if (!seamLoaded.ok) throw new Error(`framexml world seam failed: ${seamLoaded.error}`);
    }
    // After the seam composed SetCVar, before the corpus touches it (3.19): CVAR_UPDATE from
    // SetCVar's third argument, and the saved CVars and modified clicks seeded back.
    installFrameXmlCVarPersistence(this.vm, {
      raise: (event, ...args) => this.pump.fire(event, ...args), store: this.#cvarStore,
    }, PRELUDE_CHUNK);
    this.probeWidgets();
    await this.checkpoint();

    // Before the corpus: Wow.exe's compat globals this VM lacked (sin/cos in degrees, strrev, …).
    if (!installFrameXmlLuaCompat(this.vm, `@${PRELUDE_CHUNK}:compat`)) throw new Error("framexml Lua compat failed");
    // Before the corpus: an add-on's options panel filed before the lazy options chain exists (3.18).
    if (!installFrameXmlOptionsCategoryQueue(this.vm, `@${PRELUDE_CHUNK}:options-categories`)) {
      throw new Error("framexml options category queue failed");
    }
    const socketing = installFrameXmlSocketing(this.vm, this.bridge, this.#options.seam);

    // Whatever the plan is, the loader must find these files through the *cached* corpus, or every
    // byte is fetched twice.
    const single = this.#options.only
      ? singleFileTocProvider(this.corpus, this.#options.only)
      : undefined;
    let unhandled = this.vm.errors.length;
    let handled = this.#handledErrors.length;
    const loader = new GlueLoader({
      vm: this.vm,
      bridge: this.bridge,
      provider: single?.provider ?? this.corpus,
      checkpoint: this.checkpoint,
      // ClientNetwork.lua is an unmodified library entry followed by TSAddon entries. Arm its
      // registration wrapper at that file boundary, so a TSAddon callback owns its exact raw
      // opcode before a top-level Send() can receive a synchronous reply.
      afterLuaFile: (path) => {
        this.#clientNetwork?.activateCallbacks();
        socketing.afterLuaFile(path);
        if (frameXmlDefinesCombatLogLoadUi(path)) captureFrameXmlStockCombatLogLoadUi(this.vm);
      },
      afterTocEntry: (entry, result) => {
        const owner = entry.path.replaceAll("\\", "/").match(/(?:^|\/)tsaddons\/([^/]+)\//i)?.[1]?.toLowerCase();
        for (const frame of this.bridge.frames) {
          if (!this.#seenTocFrames.has(frame) && owner && owner !== "lib") this.#tsAddonFrames.set(frame, owner);
          this.#seenTocFrames.add(frame);
        }
        tsAddons.record(entry, result, [
          ...this.vm.errors.slice(unhandled), ...this.#handledErrors.slice(handled),
        ]);
        unhandled = this.vm.errors.length;
        handled = this.#handledErrors.length;
        this.#tsAddonResults = tsAddons.results;
        this.#addons.setInitialModules(this.#tsAddonResults.filter((addon) => addon.ok)
          .map((addon) => addon.module));
      },
      maxFiles: 1024,
    });
    const loadStarted = now();
    const result = await loader.load(single?.toc ?? tocPath);
    await this.checkpoint();
    this.#savedVariables.finishBaseModules(this.#tsAddonResults.filter((addon) => addon.ok).map((addon) => addon.module));
    for (const addon of this.#tsAddonResults) {
      if (addon.ok) this.bridge.dispatchEvent("ADDON_LOADED", addon.module);
    }
    const loadMs = now() - loadStarted;
    this.#roots = result.roots;
    // L5c 3.18: GetAddOnMetadata answers every installed add-on from its TOC, loaded or not (0x00511430).
    await this.#addons.primeMetadata(this.#options.installedAddons ?? []);
    for (const name of this.#options.eagerAddons ?? []) {
      const addon = await this.#addons.loadAddon(name);
      this.#addonResults.push(addon);
      if (!addon.ok) console.warn(`FrameXML add-on ${name} did not load: ${addon.message ?? addon.status}`);
    }
    // A non-standard corpus may define ClientNetwork helpers outside a standalone Lua file. Keep
    // the end-of-load attempt as a fallback; the normal path armed at the ClientNetwork.lua file
    // boundary above, before any following TSAddon can register and send.
    this.#clientNetwork?.activateCallbacks();
    this.hideUnavailableCharacterTabs(scan);

    // UIParent.lua's world-entered path also touches constants owned by optional surfaces. A
    // deliberately narrow UIParent slice has no truthful bag/arena rows or owners to iterate, so
    // gate those unsupported loops with their empty counts. The full vertical loads the concrete
    // owners and keeps the stock values published by their Lua files.
    if (this.bridge.getFrame("UIParent")) {
      if (!this.bridge.getFrame("ContainerFrame1")) this.vm.setGlobal("NUM_CONTAINER_FRAMES", 0);
      if (!this.bridge.getFrame("PVPFrame")) this.vm.setGlobal("MAX_ARENA_TEAMS", 0);
    }

    // Keep non-mounted FrameXmlBoot consumers safe as well.  The world mount's callback below
    // replaces these same two handlers with its owned click adapters and keeps Character's stock
    // portrait event intact.
    installFrameXmlMicroButtonExerciseCompat(this.bridge, this.vm);

    // A host may need to publish a narrowly-owned callback before any session event can reach the
    // loaded corpus.  This is intentionally after the XML/Lua tree and its post-load constants
    // exist, but before seam.attach: LiveWorldSeam.attach itself can synchronously emit events.
    // Moving this after either attach or runExercise re-exposes stock handlers that reference an
    // optional panel the host has not loaded.
    await this.checkpoint();
    this.#options.beforeExercise?.(this);
    this.#secureStockEntryPoints();
    this.#standInOptionsFrame();
    // DurabilityFrame_SetAlerts and MainMenuBar_ToPlayerArt read VehicleMenuBar.xml's frames unguarded (3.06).
    standInFrameXmlVehicleFrames(this.vm, this.bridge);
    // UIParent's PLAYER_LOGIN would load Blizzard_CombatLog, which has no owner yet (3.01).
    refuseFrameXmlCombatLogLoadUi(this.vm);

    // Before the four session events, not after: `PLAYER_ENTERING_WORLD` is what makes every
    // action button ask `HasAction`, and a seam attached afterwards would answer a bar that had
    // already decided it was empty.
    this.#options.seam?.attach(this.pump);
    await this.checkpoint();

    this.collectCounters();
    this.#exercise.apiBefore = this.#emitted.api.size;
    this.#exercise.methodsBefore = this.#emitted.method.size;
    this.#exercise.errorsBefore = this.vm.errors.length + this.#handledErrors.length;
    if (this.#options.exercise !== false) await this.runExercise();
    this.disableUnavailableOptions();
    this.collectCounters();
    this.#exercise.apiAfter = this.#emitted.api.size;
    this.#exercise.methodsAfter = this.#emitted.method.size;
    this.#exercise.errorsAfter = this.vm.errors.length + this.#handledErrors.length;

    // Each side of a modifier going down or up, as the client raises it (key, 1/0) — PaperDoll's
    // comparison tooltips and the multicast flyouts redraw on it. From here on: the session is up.
    if (!this.#closed && !this.#stopModifierEvents) {
      this.#stopModifierEvents = (this.#options.modifiers ?? pageModifiers()).onChange?.((key, down) => {
        if (this.#closed) return;
        this.bridge.runInMutationBatch(() => this.bridge.dispatchEvent("MODIFIER_STATE_CHANGED", key, down ? 1 : 0));
      });
    }

    await this.checkpoint();
    this.#inventory = this.assemble(scan, plan, result, {
      scanMs, planMs, loadMs, totalMs: now() - startedAt,
    });
    return this.#inventory;
  }

  /** Keep stock tabs for optional CharacterFrame roots out of the bounded paper-doll surface. */
  private hideUnavailableCharacterTabs(scan: FrameXmlCorpusScan): void {
    if (!scan.files.some((file) => file.path.endsWith("/characterframe.xml"))) return;
    const realOptional = new Set(
      scan.files
        .filter((file) => file.path.endsWith(".xml"))
        .map((file) => file.path.slice(file.path.lastIndexOf("/") + 1)),
    );
    FRAMEXML_CHARACTER_OPTIONAL_SUBFRAMES.forEach(({ name, id }) => {
      if (realOptional.has(`${name.toLowerCase()}.xml`)) return;
      const tab = this.bridge.getFrame(`CharacterFrameTab${id}`);
      if (tab) this.bridge.Hide(tab);
    });
    // CharacterFrame.xml:109-116 anchors Tab3 LEFT to Tab2's RIGHT at -15, and only stock
    // PetPaperDollFrame_UpdateIsAvailable re-anchors it when the pet tab is hidden
    // (PetPaperDollFrame.lua:54-55: `CharacterFrameTab3:SetPoint("LEFT", "CharacterFrameTab2",
    // "LEFT", 0, 0)`). Without PetPaperDollFrame.xml that code never runs and a one-tab gap
    // (83 px at 1920x919) stayed between «Персонаж» and «Репутация». Same SetPoint, which replaces
    // the LEFT anchor exactly as the stock call does; a promoted pet page owns it again.
    if (!realOptional.has("petpaperdollframe.xml")) {
      const tab2 = this.bridge.getFrame("CharacterFrameTab2");
      const tab3 = this.bridge.getFrame("CharacterFrameTab3");
      if (tab2 && tab3) this.bridge.SetPoint(tab3, "LEFT", tab2, "LEFT", 0, 0);
    }
  }

  /** Leave unsupported stock device and display choices visibly unavailable. */
  private disableUnavailableOptions(): void {
    const controls = [
      "AudioOptionsSoundPanelHardwareDropDownButton",
      "AudioOptionsVoicePanelInputDeviceDropDownButton",
      "AudioOptionsVoicePanelOutputDeviceDropDownButton",
      "AudioOptionsVoicePanelChatModeDropDownButton",
      "VideoOptionsResolutionPanelResolutionDropDownButton",
      "VideoOptionsResolutionPanelRefreshDropDownButton",
      "VideoOptionsResolutionPanelMultiSampleDropDownButton",
      "VideoOptionsEffectsPanelTextureResolution",
      "InterfaceOptionsDisplayPanelAggroWarningDisplayButton",
      "InterfaceOptionsSocialPanelChatStyleButton",
      "InterfaceOptionsSocialPanelConversationModeButton",
      "InterfaceOptionsCombatTextPanelFCTDropDownButton",
      "InterfaceOptionsMousePanelClickMoveStyleDropDownButton",
      // (5.14: the camera style dropdown is cameraSmoothStyle now, FrameXmlSettingsCVar.ts.)
    ];
    for (const name of controls) {
      const frame = this.bridge.getFrame(name);
      if (frame) this.bridge.update(frame, (mutable) => { mutable.enabled = false; });
    }
    const unavailable = this.#options.locale === "ruRU" ? "Недоступно" : "Unavailable";
    for (const name of [
      "VideoOptionsResolutionPanelRefreshDropDownText",
      "VideoOptionsResolutionPanelMultiSampleDropDownText",
      ...(!this.#browserAudioOutput ? ["AudioOptionsSoundPanelHardwareDropDownText"] : []),
    ]) {
      const frame = this.bridge.getFrame(name);
      if (frame) this.bridge.SetText(frame, unavailable);
    }
  }

  /**
   * Show the root frame, deliver the first four events, run one frame of OnUpdate.
   *
   * This is not "starting the UI" — nothing here knows a unit, an item or a spell. It is the
   * cheapest honest way to reach the code behind an event registration, which is where the in-world
   * API actually lives: a TOC walk alone reaches only `OnLoad`.
   */
  private async runExercise(): Promise<void> {
    const parent = this.bridge.getFrame("UIParent");
    if (parent) this.bridge.Show(parent);
    const events = this.#options.exerciseEvents ?? FRAMEXML_EXERCISE_EVENTS;
    for (const event of events) {
      await this.checkpoint();
      this.#exercise.events.push(event);
      // 0x00528010 clears the «not logged in» flag before it raises PLAYER_LOGIN.
      if (event === "PLAYER_LOGIN") this.#login.logIn();
      this.#login.observe(event);
      // `ADDON_LOADED` carries the addon's name; the rest carry nothing in 3.3.5.
      this.#exercise.dispatched += event === "ADDON_LOADED"
        ? this.bridge.dispatchEvent(event, "Blizzard_FrameXML")
        : this.bridge.dispatchEvent(event);
    }
    this.#exercise.dispatched += this.bridge.tick(0.016);
    this.#evaluatePetTabAvailability();
  }

  /**
   * The client decides the pet tab once the character is in the world: its login-time UNIT_PET and
   * PET_BAR_UPDATE reach PetPaperDollFrame_UpdateTabs. Here the seam's HasPetUI/GetNumCompanions
   * answer only after it attached — after `hideUnavailableCharacterTabs` ran, and before the
   * session events above, none of which the stock handler acts on (PetPaperDollFrame.lua:119-160)
   * — so the stock function runs here, once, where the client's login edge lands. From then on the
   * seams' UNIT_PET and COMPANION_* events keep it current. Without the promoted page there is no
   * such global and `hideUnavailableCharacterTabs` has already hidden the tab.
   */
  #evaluatePetTabAvailability(): void {
    const update = this.vm.globalFunction("PetPaperDollFrame_UpdateIsAvailable");
    if (!update) return;
    try {
      this.bridge.runInMutationBatch(() => { this.vm.call(update, [], 0); });
    } finally {
      this.vm.release(update);
    }
  }

  /**
   * The way back into the interface, handed to the seam.
   *
   * `now` is the same expression the `GetTime` binding answers with, and it has to stay that way:
   * a cooldown start comes out of the seam in these units and is compared against `GetTime()` by
   * the corpus and against this clock by the renderer's sweep.
   */
  /**
   * The stock entry points that run as Blizzard's code, with `issecure()` true (FrameXmlSecureCalls.ts):
   * `ActionButton_ShowGrid`/`ActionButton_HideGrid` count a button's `showgrid` only `if ( issecure() )`
   * (ActionButton.lua:275, :291) — the empty slots a held spell is dropped on (ACTIONBAR_SHOWGRID,
   * MultiActionBars.lua:85-87) — and `UnitPopup_ShowMenu` hides «Выбрать целью» and the raid's main
   * tank/assist rows without it (UnitPopup.lua:593, :752, :758). Everywhere else `issecure()` is not
   * secure. Wrapped after the whole load, so the unit frames' load-time menu initializers build
   * exactly the rows (and dropdown buttons) they built before.
   */
  #secureStockEntryPoints(): void {
    installFrameXmlSecureWrappers(this.vm, FRAMEXML_SECURE_ENTRY_POINTS);
  }

  /** The owned `InterfaceOptionsFrame` global while the lazy options chain has not loaded (below). */
  #optionsStandIn: readonly (readonly [string, FrameXmlFrame])[] = [];

  /** That stand-in, which the bag gate accepts instead of aliasing its own (FrameXmlWorldMount.ts). */
  get optionsFrameStandIn(): FrameXmlFrame | undefined {
    return this.#optionsStandIn[0]?.[1];
  }

  /**
   * UIParent's PLAYER_CONTROL_LOST handler (UIParent.lua:800-819) closes the windows through
   * IsOptionFrameOpen (:2204-2210), which dereferences InterfaceOptionsFrame unconditionally — a
   * frame of the options chain, which loads only on its first open (FRAMEXML_OPTIONS_TOC,
   * FrameXmlOptionsOwner.ts). Until then an owned, hidden, unnamed stand-in answers «not open»; the
   * chain's real frame takes the global over (installOwnedGlobals never covers it). The world mount's
   * bag gate had its own stand-in, but only for its owner's lifetime and never in the add-ons-only
   * mount; a boot without UIParent's IsOptionFrameOpen needs none.
   */
  #standInOptionsFrame(): void {
    // rawget: a subset boot without UIParent must not count a miss for a name it never reads.
    const probe = this.vm.compileFunction(
      "return type(rawget(_G, 'IsOptionFrameOpen')) == 'function' and rawget(_G, 'InterfaceOptionsFrame') == nil",
      "webclient/options-stand-in", []);
    if (!probe) return;
    let needed = false;
    try {
      needed = this.vm.call(probe, [], 1)[0] === true;
    } finally {
      this.vm.release(probe);
    }
    if (!needed) return;
    const standIn = this.bridge.CreateFrame("Frame");
    if (!standIn) return;
    this.bridge.Hide(standIn);
    const installed: (readonly [string, FrameXmlFrame])[] = [];
    installOwnedGlobals(this.vm, [["InterfaceOptionsFrame", standIn]], installed);
    this.#optionsStandIn = installed;
  }

  get pump(): {
    fire: (event: string, ...args: readonly unknown[]) => number;
    now: () => number;
    listening: (event: string) => boolean;
  } {
    return {
      // A world event: the store flush and the packet handlers deliver these in bursts between two
      // frame steps, so what one changes may wait for the step (`runInDeferrableBatch`; the world
      // mount turns that on with `setLayoutDeferral`).
      fire: (event, ...args) => this.bridge.runInDeferrableBatch(() => {
        // A loading screen's PLAYER_LEAVING_WORLD/PLAYER_ENTERING_WORLD (FrameXmlWorldEntry.ts).
        this.#login.observe(event);
        // LiveWorldSeam publishes ZONE_CHANGED_NEW_AREA when the zone changes. The vertical
        // corpus deliberately leaves the stock world-map owner out: FrameXmlWorldMount keeps the
        // native map action as the owner until a complete WorldMapFrame gate passes. Delivering
        // this event into WatchFrame without that owner is not a harmless no-op — its stock
        // handler calls WorldMapFrame:IsShown() and raises. Skip only that dependent owner, while
        // preserving Minimap/Battlefield and every other zone handler; a boot that loaded the
        // real WorldMapFrame uses the ordinary dispatch path.
        if (event === "ZONE_CHANGED_NEW_AREA" && !this.bridge.getFrame("WorldMapFrame")) {
          return this.bridge.dispatchEventExcept(event, WORLD_MAP_ZONE_EVENT_OWNERS, ...args);
        }
        return this.bridge.dispatchEvent(event, ...args);
      }),
      now: this.#clock, // L5 3.27 (was Date.now() / 1000)
      // Whether a frame is registered for the event now: lets a source skip building arguments
      // nobody would receive, without missing a frame that registers later (FrameXmlCombatLogLive).
      listening: (event) => this.bridge.hasEventListeners(event),
    };
  }

  /** Advance the seam one rendered frame. A boot with no seam does nothing. */
  tickSeam(now = this.#clock()): void { // L5 3.27 (was Date.now() / 1000)
    this.#options.seam?.tick(now);
  }

  get seam(): FrameXmlWorldSeam | undefined {
    return this.#options.seam;
  }

  /** The character's in-combat flag, as the UI's own `UnitAffectingCombat("player")` answers it. */
  #playerInCombat(): boolean {
    const affecting = this.vm.globalFunction("UnitAffectingCombat");
    if (!affecting) return false;
    try {
      const [answer] = this.vm.call(affecting, ["player"], 1);
      return answer !== undefined && answer !== null && answer !== false;
    } catch {
      return false;
    } finally {
      this.vm.release(affecting);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#stopModifierEvents?.();
    this.#stopModifierEvents = undefined;
    this.#stopSavedVariablesPersistence?.();
    this.#fireTeardownOnce();
    this.#savedVariables.flush();
    this.#cvarStore?.flush();
    this.#clientNetwork?.close();
    this.#addons.close();
    this.#options.seam?.detach();
    releaseOwnedGlobals(this.vm, this.#optionsStandIn);
    this.#optionsStandIn = [];
    this.vm.close();
  }

  flushSavedVariables(): void {
    if (!this.#closed) this.#savedVariables.flush();
    if (!this.#closed) this.#cvarStore?.flush();
  }

  /** The 30 s save: budgeted, heavy variables rarely (`SAVED_VARIABLE_CHECKPOINT`, 9.06 review). */
  checkpointSavedVariables(): void {
    if (!this.#closed) this.#savedVariables.checkpoint();
    if (!this.#closed) this.#cvarStore?.flush();
  }

  /**
   * The UI teardown's events (PLAYER_LEAVING_WORLD, PLAYER_LOGOUT, see `FrameXmlLoginEdge`), once
   * per boot: `close()` and a page that is really going away (9.06) share the latch, so AceDB-style
   * handlers that strip their defaults run exactly once, before the last save.
   */
  #fireTeardownOnce(): void {
    if (this.#teardownFired) return;
    this.#teardownFired = true;
    for (const event of this.#login.teardownEvents(() => this.#playerInCombat())) {
      try { this.bridge.dispatchEvent(event); } catch { /* one handler must not cost the save */ }
    }
  }
  #teardownFired = false;

  /**
   * The mounted browser owns checkpoints; headless corpus probes never create timers.
   *
   * Only `pagehide` with `persisted === false` is a logout (9.06): the page is being destroyed, so
   * the teardown events run first and the save after them, as the real client saves after
   * PLAYER_LOGOUT. `beforeunload` (cancellable), a hidden tab and the 30 s timer only save — the game
   * goes on, and a PLAYER_LOGOUT there would make AceDB take the defaults off live data.
   */
  startSavedVariablesPersistence(target: Window, document: Document): void {
    if (this.#closed || !this.#options.savedVariables || this.#stopSavedVariablesPersistence) return;
    const save = (): void => this.flushSavedVariables();
    const leave = (event: Event): void => {
      if (!this.#closed && (event as PageTransitionEvent).persisted !== true) this.#fireTeardownOnce();
      save();
    };
    const hide = (): void => { if (document.visibilityState === "hidden") save(); };
    target.addEventListener("pagehide", leave);
    target.addEventListener("beforeunload", save);
    document.addEventListener("visibilitychange", hide);
    const interval = target.setInterval(() => this.checkpointSavedVariables(), 30000);
    this.#stopSavedVariablesPersistence = () => {
      target.removeEventListener("pagehide", leave);
      target.removeEventListener("beforeunload", save);
      document.removeEventListener("visibilitychange", hide);
      target.clearInterval(interval);
      this.#stopSavedVariablesPersistence = undefined;
    };
  }

  get savedVariableDiagnostics() { return this.#savedVariables.diagnostics; }

  /** The custom opcodes the TSWoW Lua is subscribed to; empty without a live transport (9.08). */
  clientNetworkOpcodes(): ReadonlySet<number> {
    return this.#clientNetwork?.opcodes() ?? new Set();
  }

  /** Load one LoD add-on into this boot's existing VM, registry, and widget bridge. */
  async loadAddon(name: string): Promise<FrameXmlAddonRuntimeResult> {
    return await this.#addons.loadAddon(name);
  }

  /** Synchronous status view used by the FrameXML IsAddOnLoaded C API. */
  isAddonLoaded(name: unknown): boolean {
    return this.#addons.isLoaded(name);
  }

  /**
   * The handful of globals the host answers honestly.
   *
   * Deliberately short. Every name bound here is a name that never appears in the gold list, so the
   * list stops being a work queue the moment this grows on a hunch: `CreateFrame` because the
   * widget layer *is* the answer, the clock and the screen because they are facts about the host,
   * and the build and locale because the same client answered them in G2.
   */
  private installBindings(): void {
    const vm = this.vm;
    // Stock RaidFrame.lua / PartyMemberFrame.lua declare these group limits, but their panels
    // are not part of the browser's HUD subset. WorldMapFrame iterates the same fixed slots.
    vm.setGlobal("MAX_RAID_MEMBERS", 40);
    vm.setGlobal("MAX_PARTY_MEMBERS", 4);
    // Before the stub floor and before the first TOC chunk: the real ClientNetwork.lua captures
    // this C-API entry while it defines CreateCustomPacket and the packet readers.
    this.#clientNetwork?.install();
    const recordDirectApi = (name: string): void => {
      if (!this.#apiTouches.has(name)) this.#apiTouches.set(name, { firstTouch: "FrameXmlBoot" });
      this.#emitted.api.set(name, (this.#emitted.api.get(name) ?? 0) + 1);
    };
    vm.registerGlobal("CreateFrame", (args) => {
      const type = String(args[0] ?? "Frame");
      const name = args[1] === undefined ? undefined : String(args[1]);
      const parent = args[2] as FrameXmlFrame | undefined;
      const inherits = args[3] === undefined ? undefined : String(args[3]);
      // The fifth argument is the frame's ID: FCF_OpenTemporaryWindow creates ChatFrame<N> with
      // FloatingChatFrameTemplate and N, and the template's OnLoad reads GetID() straight away
      // (FloatingChatFrame.lua:60, 713). Dropped, every whisper pop-out raised at :804.
      const id = typeof args[4] === "number" ? args[4] : undefined;
      return [this.bridge.CreateFrame(type, name, parent, inherits, id)];
    });
    // Read by the neutral chunk's modifier family (IsShiftKeyDown, IsModifiedClick, …), which
    // captures it before the corpus runs.
    const modifiers = this.#options.modifiers ?? pageModifiers();
    vm.registerGlobal("__fxModifierState", () => {
      const held = modifiers.state();
      return [held.LSHIFT, held.RSHIFT, held.LCTRL, held.RCTRL, held.LALT, held.RALT, held.button];
    });
    installFrameXmlWorldMapArrowBindings(vm, this.bridge, () => this.#options.seam?.map);
    vm.registerGlobal("__fxRecordWidgetStub", (args) => {
      const frame = args[0] && typeof args[0] === "object"
        ? this.bridge.resolve(args[0] as FrameXmlFrame) : undefined;
      this.binder.recordStubCall(String(args[2]), String(args[1]), frame);
      return [];
    });
    vm.registerGlobal("GetTime", () => [this.#clock()]); // L5 3.27 (was Date.now() / 1000)
    vm.registerGlobal("GetLocale", () => [this.#options.locale ?? "ruRU"]);
    // Only the selected client locale is installed through this MPQ chain.
    // The stock Languages panel sees one locale and does not offer a restart
    // choice that this browser cannot fulfill.
    vm.registerGlobal("GetExistingLocales", () => [this.#options.locale ?? "ruRU"]);
    vm.registerGlobal("GetBuildInfo", () => [...FRAMEXML_BUILD_INFO]);
    vm.registerGlobal("GetItemQualityColor", (args) => {
      const quality = typeof args[0] === "number" && Number.isFinite(args[0]) ? Math.trunc(args[0]) : -1;
      return [...(FRAMEXML_ITEM_QUALITY_COLORS[quality] ?? FRAMEXML_ITEM_QUALITY_COLORS[-1]!)];
    });
    vm.registerGlobal("GetScreenWidth", () => [this.#options.screen?.().width ?? 1024]);
    vm.registerGlobal("GetScreenHeight", () => [this.#options.screen?.().height ?? 768]);
    // The browser owns a single canvas viewport. Stock UIParent computes its widescreen offsets
    // through the resolution-list API, so expose that same viewport as its one selectable mode.
    vm.registerGlobal("GetScreenResolutions", () => {
      const screen = this.#options.screen?.() ?? { width: 1024, height: 768 };
      return [`${Math.max(1, Math.round(screen.width))}x${Math.max(1, Math.round(screen.height))}`];
    });
    vm.registerGlobal("GetCurrentResolution", () => [1]);
    // Stock video options use zero as the explicit unavailable refresh-rate
    // sentinel. There is no browser API here for enumerating display modes or
    // for switching the renderer's multisample format after creation.
    vm.registerGlobal("GetRefreshRates", () => [0]);
    vm.registerGlobal("GetMultisampleFormats", () => []);
    // The sound renderer connects to AudioContext.destination. It can use the
    // browser's selected default output, but cannot enumerate or switch devices.
    vm.registerGlobal("Sound_GameSystem_GetNumOutputDrivers", () =>
      [this.#browserAudioOutput ? 1 : 0]);
    vm.registerGlobal("Sound_GameSystem_GetOutputDriverNameByIndex", (args) =>
      this.#browserAudioOutput && args[0] === 0
        ? [this.#options.locale === "ruRU" ? "Выход браузера по умолчанию" : "Browser default output"]
        : []);
    vm.registerGlobal("GetCursorPosition", () => [...this.bridge.mousePosition]);
    // File IO is asynchronous in the browser. LoadAddOn therefore reports the current
    // synchronous state; the host calls loadAddon() and only then exposes a loaded LoD module to
    // Lua. Unknown names retain the stock false, "MISSING" contract.
    vm.registerGlobal("IsAddOnLoaded", (args) => {
      recordDirectApi("IsAddOnLoaded");
      return this.#addons.status(args[0]);
    });
    vm.registerGlobal("LoadAddOn", (args) => {
      recordDirectApi("LoadAddOn");
      return this.#addons.loadStatus(args[0]);
    });
    vm.registerGlobal("GetAddOnMetadata", (args) => {
      recordDirectApi("GetAddOnMetadata");
      return this.#addons.metadata(args[0], args[1]);
    });
    // 1 from the PLAYER_LOGIN edge on, nil before it (FrameXmlLoginEdge.ts, 0x0060a450).
    vm.registerGlobal("IsLoggedIn", () => {
      recordDirectApi("IsLoggedIn");
      return this.#login.isLoggedIn();
    });
    for (const [name, value] of Object.entries(FRAMEXML_HOST_CONSTANTS)) vm.setGlobal(name, value);
    // LoadAddOn's own reason while the files are on their way (FrameXmlAddonRuntime.loadStatus).
    vm.setGlobal("ADDON_NOT_READY", frameXmlAddonNotReadyText(this.#options.locale ?? "ruRU"));
    // First touch and the final read-back are the only two things that cross out of Lua.
    vm.registerGlobal("__fxOrigin", () => [vm.callingLocation(PRELUDE_CHUNK)]);
    vm.registerGlobal("__fxNoteApi", (args) => {
      const name = String(args[0] ?? "");
      if (name && !this.#apiTouches.has(name)) {
        this.#apiTouches.set(name, { firstTouch: String(args[1] ?? "") });
      }
      return [];
    });
    vm.registerGlobal("__fxNoteMethod", (args) => {
      const name = String(args[0] ?? "");
      if (name && !this.#methodTouches.has(name)) {
        this.#methodTouches.set(name, { firstTouch: String(args[1] ?? "") });
      }
      return [];
    });
    vm.registerGlobal("__fxNoteError", (args) => {
      this.#handledErrors.push(String(args[0] ?? ""));
      return [];
    });
    // One crossing per font object, on its first read: the object is written
    // into `_G` straight afterwards, so the metamethod never asks twice.
    vm.registerGlobal("__fxFontData", (args) => {
      const name = String(args[0] ?? "");
      const style = name ? this.bridge.fontObjectStyle(name) : undefined;
      if (!style) return [];
      const record = frameXmlFontRecord(style);
      this.#fontObjects.set(name, record);
      return [{ ...record }];
    });
    /**
     * `Frame:SetAttribute(name, value)` — store, then dispatch.
     *
     * The dispatch is here rather than in the bridge because the bridge is the model and the
     * script environment is the host's. `OnAttributeChanged` receives the *normalised* name, which
     * is what the client passes and what every handler in this corpus compares against
     * (`setframe`, `delframe`, `setstate`, `createframes`, `initmenu`, `openmenu`, and the two
     * patterns `^state%-` and `^_`).
     */
    vm.registerGlobal("__fxSetAttribute", (args) => {
      const frame = args[0] as FrameXmlFrame | undefined;
      if (!frame || typeof frame !== "object") return [];
      const value = this.retainAttribute(frame, args[1], args[2]);
      const key = this.bridge.SetAttribute(frame, args[1], value);
      if (key === undefined) return [];
      if (this.bridge.hasScript(frame, "OnAttributeChanged")) {
        this.#attributeDispatches += 1;
        this.bridge.fireScript(frame, "OnAttributeChanged", key, value);
      }
      return [];
    });
    // The argument *count* rather than «is the third nil»: `SecureButton_GetAttribute` calls the
    // three-argument form with two empty strings, which nil-checking would misread as one.
    vm.registerGlobal("__fxGetAttribute", (args) => {
      const frame = args[0] as FrameXmlFrame | undefined;
      if (!frame || typeof frame !== "object") return [];
      const count = Number(args[1]) || 0;
      const value = this.bridge.GetAttribute(frame, args[2], args[3], args[4], count);
      return value === undefined ? [] : [value];
    });
    vm.registerGlobal("__fxSetCooldown", (args) => {
      const frame = args[0] as FrameXmlFrame | undefined;
      if (!frame || typeof frame !== "object") return [];
      this.bridge.SetCooldown(frame, Number(args[1]) || 0, Number(args[2]) || 0);
      return [];
    });
    const seam = this.#options.seam;
    if (seam) {
      for (const [name, binding] of Object.entries(FRAMEXML_SEAM_BINDINGS)) {
        vm.registerGlobal(`__fxSeam_${name}`, (args) => binding(seam, args));
      }
      // A Texture widget cannot hold a 3D unit render; the world mount places a PortraitRenderer
      // canvas above it and the picture underneath is the fallback. QuestFrame.lua calls this
      // only after UnitExists("questnpc"), and its Texture gets the selected client's book icon.
      // Every other Texture and unit — "npc"/"NPC" for Gossip, Bank, Taxi, Merchant, Trainer and
      // the trade partner, "player", "pet", a party or ready-check unit — goes to the host
      // (FrameXmlPortraits.ts), which puts the client's «portrait not available» art in a Texture
      // it claims and leaves any other as stock Lua set it.
      vm.registerGlobal("SetPortraitTexture", (args) => {
        recordDirectApi("SetPortraitTexture");
        const frame = args[0] && typeof args[0] === "object"
          ? this.bridge.resolve(args[0] as FrameXmlFrame) : undefined;
        if (frame?.type !== "Texture" || typeof args[1] !== "string") return [];
        if (frame === this.bridge.getFrame("QuestFramePortrait")) {
          if (args[1] !== "questnpc") return [];
          this.bridge.SetTexture(frame, "Interface\\QuestFrame\\UI-QuestLog-BookIcon");
          this.#options.onQuestPortrait?.(seam.questNpcPortraitGuid());
          return [];
        }
        this.#options.onUnitPortrait?.(frame, args[1].toLowerCase());
        return [];
      });
    }
    vm.registerGlobal("__fxEmit", (args) => {
      const kind = String(args[0] ?? "");
      const name = String(args[1] ?? "");
      const count = Number(args[2]) || 0;
      if (kind === "api" || kind === "miss" || kind === "method" || kind === "font"
        || kind === "attr") {
        this.#emitted[kind].set(name, count);
      }
      return [];
    });
  }

  /**
   * Keep a Lua reference alive for as long as an attribute holds it, and drop the one it replaced.
   *
   * Anything that is not a reference (a string, a number, a boolean, a widget the decoder already
   * turned into a frame) passes straight through: only a raw table or function needs this.
   */
  private retainAttribute(frame: FrameXmlFrame, name: unknown, value: unknown): unknown {
    const key = typeof name === "string" ? name.toLowerCase() : undefined;
    if (key === undefined) return value;
    const held = this.#retainedAttributes.get(frame) ?? new Map<string, GlueLuaRef>();
    const previous = held.get(key);
    if (previous) {
      this.vm.release(previous);
      held.delete(key);
    }
    if (!(value instanceof GlueLuaRef)) {
      if (held.size > 0) this.#retainedAttributes.set(frame, held);
      return value;
    }
    const retained = this.vm.retain(value);
    held.set(key, retained);
    this.#retainedAttributes.set(frame, held);
    return retained;
  }

  /** Hand the derived plan, the measured promotions and F2's neutral answers to Lua. */
  private installStubFloor(plan: FrameXmlStubPlan, scan: FrameXmlCorpusScan): void {
    const api: Record<string, boolean> = {};
    for (const name of plan.apiNames) api[name] = true;
    // A seam name the plan did not derive still has to be answerable. The plan's rule — a name the
    // corpus calls and never defines — is about *inventing* a function for a name that may be a
    // frame (`_G["ActionButton" .. index]`); every name here is a C-API function this host
    // genuinely implements, so declaring it is a statement of fact rather than a fallback.
    if (this.#options.seam) for (const name of FRAMEXML_SEAM_NAMES) api[name] = true;
    // The same holds for F2's neutral table: every row is a C-API function with a documented
    // answer. Declaring them makes the answer reachable from code outside this scan — a client
    // add-on's file-scope capture, or a load-time read such as LFDFrame.lua:1's
    // `EXPANSION_LEVEL = GetExpansionLevel()` — while an untouched name still costs nothing.
    for (const answer of FRAMEXML_NEUTRAL_API) api[answer.name] = true;
    const methods: Record<string, boolean> = {};
    for (const name of plan.methodNames) methods[name] = true;
    for (const promotion of FRAMEXML_PROMOTED_METHODS) methods[promotion.name] = true;
    // Font methods resolve through the same per-type fallback, so a name the
    // corpus never calls with `:` anywhere still must not be manufactured.
    for (const name of FRAMEXML_FONT_METHODS) methods[name] = true;
    const neutral: Record<string, readonly unknown[]> = {};
    for (const promotion of FRAMEXML_PROMOTED_STUBS) neutral[promotion.name] = promotion.values;
    // F2's constant answers ride the same table the promotions do: the census
    // cannot tell them apart and should not — both are "the host answers this".
    for (const answer of FRAMEXML_NEUTRAL_CONSTANTS) neutral[answer.name] = answer.values ?? [];
    const methodNeutral: Record<string, readonly unknown[]> = {};
    for (const promotion of FRAMEXML_PROMOTED_METHODS) methodNeutral[promotion.name] = promotion.values;
    this.vm.setGlobal("__fxApi", api);
    // P1-14f: read once by the prelude that follows (FrameXmlBootOptions.census).
    this.vm.setGlobal("__fxTouchOnly", this.#options.census === "touch");
    this.vm.setGlobal("__fxMethodNames", methods);
    this.vm.setGlobal("__fxNeutral", neutral);
    this.vm.setGlobal("__fxMethodNeutral", methodNeutral);
    // Data for the two Lua chunks that follow: which names are font objects, and
    // which add-ons the TOC glued into itself.
    const fontNames: Record<string, boolean> = {};
    for (const name of scan.fontObjects) fontNames[name] = true;
    this.vm.setGlobal("__fxFontNames", fontNames);
    this.vm.setGlobal("__fxAddonModules", [...scan.addonModules]);
  }

  /**
   * Give every widget type one instance, so its method table can be wrapped.
   *
   * The method fallback hangs off the per-type method table, and the only handle on that table is a
   * widget of that type — the widget layer keeps its metatables private, and rightly so. Fourteen
   * throwaway frames is the price; they are hidden immediately and subtracted from the widget count
   * so the inventory reports the corpus' widgets and not this slice's.
   */
  private probeWidgets(): void {
    const types = [...FRAME_XML_WIDGET_TYPES];
    const probe = this.vm.globalFunction("__fxProbeWidgets");
    if (!probe) return;
    const attributeTypes: Record<string, boolean> = {};
    for (const type of types) {
      if (!FRAMEXML_ATTRIBUTE_EXCLUDED_TYPES.has(type)) attributeTypes[type] = true;
    }
    const [wrapped, probes, fontWraps, attributes] = this.vm.call(
      probe, [types, [...FRAMEXML_FONT_OBJECT_SETTERS], attributeTypes], 4,
    );
    this.vm.release(probe);
    this.#wrappedTypes = Number(wrapped) || 0;
    this.#probeFrames = Number(probes) || 0;
    this.#fontMethodWraps = Number(fontWraps) || 0;
    this.#attributeInstalls = Number(attributes) || 0;
  }

  /** How many times one of F3's real methods was called, from the Lua counters. */
  private attributeCall(name: string): number {
    return this.#emitted.attr.get(name) ?? 0;
  }

  private collectCounters(): void {
    const report = this.vm.globalFunction("__fxReport");
    if (!report) return;
    this.vm.call(report, [], 0);
    this.vm.release(report);
  }

  private stubRecords(
    counts: ReadonlyMap<string, number>,
    touches: ReadonlyMap<string, StubTouch>,
    sites: ReadonlyMap<string, number>,
    promotions: readonly FrameXmlPromotion[],
    answers: ReadonlyMap<string, string> = new Map(),
  ): readonly FrameXmlStubRecord[] {
    const neutral = new Map(promotions.map((entry) => [entry.name, JSON.stringify(entry.values)]));
    // F2's neutral answers ride the same column: a record whose `neutral` is not
    // empty is one the host answers, and the difference between the length of
    // this list and the number of such records is what is still unanswered.
    for (const [name, answer] of answers) neutral.set(name, answer);
    return [...counts.entries()]
      .map(([name, calls]): FrameXmlStubRecord => ({
        name,
        calls,
        firstTouch: touches.get(name)?.firstTouch ?? "",
        sites: sites.get(name.includes(":") ? name.slice(name.indexOf(":") + 1) : name) ?? 0,
        neutral: neutral.get(name) ?? "",
      }))
      .sort((left, right) => right.calls - left.calls || left.name.localeCompare(right.name));
  }

  private assemble(
    scan: Awaited<ReturnType<FrameXmlCorpus["scan"]>>,
    plan: FrameXmlStubPlan,
    result: GlueLoadResult,
    timings: { scanMs: number; planMs: number; loadMs: number; totalMs: number },
  ): FrameXmlInventory {
    const frames = this.bridge.frames;
    const byType = new Map<string, number>();
    let named = 0;
    for (const frame of frames) {
      byType.set(frame.type, (byType.get(frame.type) ?? 0) + 1);
      if (frame.named) named += 1;
    }
    const seamName = this.#options.seam?.name ?? "";
    const luaFiles = scan.files.filter((file) => file.kind === "lua");
    const xmlFiles = scan.files.filter((file) => file.kind === "xml");
    const executed = this.vm.chunkTimings;
    const errors = collectFailures(this.vm.errors, this.#handledErrors);
    // Which files name a VM-level facility at all. A whole-word text match over the corpus rather
    // than a parse: the question is "does anything in here need it", and the answer decides whether
    // the VM's Lua 5.3 core can carry FrameXML — a question worth over-reporting rather than under.
    const chunkSites = (name: string): string[] => {
      const pattern = new RegExp(`\\b${name}\\b`);
      const sites = new Set<string>();
      for (const chunk of scan.chunks) {
        if (pattern.test(chunk.source)) sites.add(chunk.file.replace(/:Script\[\d+\]$/, ""));
      }
      return [...sites];
    };
    return {
      tsAddons: this.#tsAddonResults,
      toc: scan.toc,
      tocEntries: scan.tocEntries,
      files: {
        total: scan.files.length,
        lua: luaFiles.length,
        xml: xmlFiles.length,
        blizzard: scan.files.filter((file) => !file.addon).length,
        addon: scan.files.filter((file) => file.addon).length,
        bytes: scan.files.reduce((sum, file) => sum + file.bytes, 0),
        addonBytes: scan.files.reduce((sum, file) => sum + (file.addon ? file.bytes : 0), 0),
        missing: scan.missing,
      },
      xml: {
        parsed: xmlFiles.length - scan.unparsable.length,
        failed: scan.unparsable,
        unknownDeclarations: [...scan.unknownDeclarations].map(([name, count]) => ({ name, count })),
      },
      lua: {
        executed: executed.filter((entry) => entry.ok).length,
        failed: executed.filter((entry) => !entry.ok).length,
        errorsRaised: this.vm.errors.length + this.#handledErrors.length,
        relaxed: [...this.vm.relaxedChunks],
      },
      widgets: {
        // The probe frames are this slice's, not the corpus'.
        total: Math.max(0, frames.length - this.#probeFrames),
        roots: result.roots.length,
        named,
        templates: result.templates.length,
        fonts: this.bridge.fontStyles.length,
        models: this.bridge.modelFrames.size,
        byType: [...byType].sort((left, right) => right[1] - left[1])
          .map(([type, count]) => ({ type, count })),
      },
      errors,
      widgetStubs: this.binder.stubDiagnostics,
      api: this.stubRecords(
        this.#emitted.api, this.#apiTouches, plan.apiCallSites, FRAMEXML_PROMOTED_STUBS,
        new Map([
          ...FRAMEXML_NEUTRAL_API.map((entry): [string, string] => [entry.name, entry.answer]),
          // A seam-answered name is answered, and the «still unanswered» column has to say so —
          // several of them (`UseAction`, `GetRestState`, `UnitPowerType`) have no F2 entry at all,
          // so without this the seam would make the work queue look longer by answering more of it.
          ...(this.#options.seam
            ? FRAMEXML_SEAM_NAMES.map((name): [string, string] => [name, `шов: ${seamName}`])
            : []),
        ]),
      ),
      methods: this.stubRecords(this.#emitted.method, this.#methodTouches, plan.allMethodCallSites, FRAMEXML_PROMOTED_METHODS),
      misses: [...this.#emitted.miss]
        .filter(([name]) => !HANDLER_ENVIRONMENT.has(name))
        .map(([name, reads]) => ({ name, reads }))
        .sort((left, right) => right.reads - left.reads || left.name.localeCompare(right.name)),
      handlerEnvironmentReads: HANDLER_ENVIRONMENT_NAMES
        .reduce((sum, name) => sum + (this.#emitted.miss.get(name) ?? 0), 0),
      plan: {
        apiNames: plan.apiNames.size,
        apiCallSites: [...plan.apiCallSites.values()].reduce((sum, count) => sum + count, 0),
        methodNames: plan.methodNames.size,
        methodCallSites: [...plan.methodCallSites.values()].reduce((sum, count) => sum + count, 0),
        definedGlobals: plan.definedGlobals,
        attachedMethods: plan.attachedMethods,
        chunks: plan.chunks,
      },
      promotions: FRAMEXML_PROMOTED_STUBS,
      neutral: FRAMEXML_NEUTRAL_API.map((answer) => ({
        name: answer.name,
        group: answer.group,
        answer: answer.answer,
        reason: answer.reason,
        calls: this.#emitted.api.get(answer.name) ?? 0,
      })),
      secure: {
        installs: this.#attributeInstalls,
        setAttributeCalls: this.attributeCall("SetAttribute"),
        getAttributeCalls: this.attributeCall("GetAttribute"),
        setCooldownCalls: this.attributeCall("SetCooldown"),
        attributeDispatches: this.#attributeDispatches,
        framesWithAttributes: frames.filter((frame) => frame.secureAttributes.size > 0).length,
        declaredInXml: this.bridge.declaredAttributes,
        seam: this.#options.seam?.name ?? "",
        // Empty without a seam, and that is not a formality: most of these names also carry an F2
        // neutral answer, so counting them here on a seamless boot would report F2's constants as
        // the seam's work.
        seamCalls: this.#options.seam
          ? FRAMEXML_SEAM_NAMES
            .map((name) => ({ name, calls: this.#emitted.api.get(name) ?? 0 }))
            .filter((entry) => entry.calls > 0)
            .sort((left, right) => right.calls - left.calls)
          : [],
      },
      fonts: {
        declared: scan.fontObjects.length,
        reached: this.#fontObjects.size,
        methodCalls: [...this.#emitted.font]
          .map(([name, calls]) => ({ name, calls }))
          .sort((left, right) => right.calls - left.calls || left.name.localeCompare(right.name)),
        interopWraps: this.#fontMethodWraps,
        resolved: [...this.#fontObjects.values()].map((record) => ({ ...record })),
      },
      exercise: { ...this.#exercise, events: [...this.#exercise.events] },
      vm: {
        setfenvSites: chunkSites("setfenv"),
        getfenvSites: chunkSites("getfenv"),
        loadstringSites: chunkSites("loadstring"),
        newproxySites: chunkSites("newproxy"),
        addedShims: FRAMEXML_ADDED_SHIMS,
      },
      timings: {
        ...timings,
        slowest: [...executed].sort((left, right) => right.ms - left.ms).slice(0, 15),
      },
    };
  }

  /** How many widget types actually got a method fallback; 15 means every one the layer knows. */
  get wrappedWidgetTypes(): number {
    return this.#wrappedTypes;
  }

  /** Total Lua failures, including errors handled by the corpus' `_ERRORMESSAGE` hook. */
  get errorCount(): number {
    return this.vm.errors.length + this.#handledErrors.length;
  }

  /** Current failures also include errors raised by packet handlers and clicks after boot. */
  get errors(): readonly FrameXmlLuaFailure[] {
    return collectFailures(this.vm.errors, this.#handledErrors);
  }
}

/**
 * Split a Lua error into file, line and message.
 *
 * The VM pushes a traceback handler, so a raised error arrives as `chunk:line: message` followed by
 * the stack. Only the first line carries the position, and the position is the whole point: a
 * census of 1300 stubs is useless if an error says "attempt to call a nil value" and nothing else.
 */
export function parseLuaFailure(
  raw: string,
  handled: boolean,
): FrameXmlLuaFailure {
  const first = raw.split("\n", 1)[0] ?? raw;
  const match = /^(.*?):(\d+):\s*(.*)$/.exec(first);
  if (!match) return { file: "", line: 0, message: first, count: 1, handled };
  return {
    file: match[1] ?? "", line: Number(match[2] ?? 0), message: match[3] ?? "", count: 1, handled,
  };
}

/**
 * The error census: distinct failures, each with how often it fired.
 *
 * Grouped rather than listed, because a handler that fails fires the same error once per dispatch
 * and a list of 385 lines with four distinct entries in it hides the four. The count is itself the
 * signal — an error that fired 200 times is in a loop the interface runs, and that is where a
 * slice's budget goes.
 */
export function collectFailures(
  unhandled: readonly string[],
  handled: readonly string[],
): readonly FrameXmlLuaFailure[] {
  const grouped = new Map<string, { failure: FrameXmlLuaFailure; count: number }>();
  const add = (raw: string, wasHandled: boolean): void => {
    const failure = parseLuaFailure(raw, wasHandled);
    const key = `${failure.file}:${failure.line}:${failure.message}`;
    const existing = grouped.get(key);
    if (existing) existing.count += 1;
    else grouped.set(key, { failure, count: 1 });
  };
  for (const raw of unhandled) add(raw, false);
  for (const raw of handled) add(raw, true);
  return [...grouped.values()]
    .map(({ failure, count }) => ({ ...failure, count }))
    .sort((left, right) => right.count - left.count || left.file.localeCompare(right.file));
}
