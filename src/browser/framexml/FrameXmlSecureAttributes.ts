/**
 * Secure attributes and the cooldown widget, as real methods — slice F3's first item.
 *
 * F1 and F2 both closed with the same honest gap: `SetAttribute`/`GetAttribute` are **1,672 calls
 * across four widget types** and every one of them was a recording no-op. That is not a missing
 * convenience. It is the whole mechanism a `SecureActionButtonTemplate` is built on: the button's
 * `OnClick` is `SecureActionButton_OnClick`, which asks `SecureButton_GetModifiedAttribute(self,
 * "type", button)` what kind of action it is, and `ActionButton_CalculateAction` asks the same
 * function for `actionpage` before it can name a slot at all. With the pair answering nothing, a
 * click was a no-op and every button on every bar addressed page 1.
 *
 * The semantics — name normalisation and the five-step wildcard cascade of the three-argument
 * `GetAttribute` — are in `ui/framexml_compat/FrameXmlAttributes.ts`, with the measurements that
 * decided them. This file is the two halves that need a VM: the Lua methods, installed on each
 * widget type's method table by the same probe that installs the font interop, and the host
 * bindings behind them.
 *
 * **No taint system, and it is not a shortcut.** In 3.3.5 a secure attribute is secure because
 * Blizzard's code may write one and an add-on's may not, and `issecure()` is what separates them.
 * This client *is* the host: every Lua chunk in this VM came out of the client's own MPQ chain
 * through the gateway, `GlueLua.ts` answers `issecure()` truthfully, and no add-on is ever loaded.
 * So `ActionButton_ShowGrid`'s `if ( issecure() ) then` takes the branch the real client takes for
 * its own code, and the thing that is not modelled — an untrusted caller being *refused* — has no
 * caller in this repository. `forceinsecure()` remains the no-op F1 measured it into.
 *
 * The cooldown widget rides along because it is the same kind of thing: one method
 * (`SetCooldown`, measured — exactly one call site in the whole corpus, `Cooldown.lua`) that the
 * glue widget layer never had a reason to implement, and without it the sweep is the one part of
 * an action button that cannot be faked by drawing.
 */

/**
 * Widget types that own the attribute API.
 *
 * Everything but the two regions. In 3.3.5 `SetAttribute` is a `Frame` method: a `Texture` and a
 * `FontString` are regions, not frames, and neither has it — which matters, because the corpus
 * tests for methods by truthiness and `if region.GetAttribute then` has to keep answering the way
 * it answers in the real client.
 */
export const FRAMEXML_ATTRIBUTE_EXCLUDED_TYPES: ReadonlySet<string> = new Set(["Texture", "FontString"]);

/** The method names this slice makes real, for the report and the census. */
export const FRAMEXML_ATTRIBUTE_METHODS: readonly string[] = Object.freeze([
  "SetAttribute", "GetAttribute",
]);

/**
 * The Lua half.
 *
 * Both methods are thin: they count (in Lua, for F1's reason — a JS round trip per call would make
 * the measurement's own cost the thing measured) and hand over to a host binding. The store itself
 * is on the frame, in TypeScript, and that is deliberate rather than convenient: it is the same
 * store the XML `<Attribute name= type= value=/>` declarations fill at instantiation, and those
 * have to be readable before the first `OnLoad` runs — `UIParent.lua` reads
 * `UIParent:GetAttribute("DEFAULT_FRAME_WIDTH")` while the corpus is still loading.
 *
 * `GetAttribute` forwards `select("#", ...)` because the *count* is what tells the one-argument
 * form from the three-argument one. `SecureButton_GetAttribute` calls the three-argument form with
 * two empty strings, so «is the third argument nil» is not the same question.
 */
export const FRAMEXML_ATTRIBUTE_PRELUDE = `
__fxAttrCalls = __fxAttrCalls or {}
-- Method-table entries this chunk has already written, so probing two widget types that share one
-- table installs nothing twice.
__fxAttrInstalled = __fxAttrInstalled or {}

do
  local calls = __fxAttrCalls
  local rawset, rawget, getmetatable, type, select = rawset, rawget, getmetatable, type, select

  local function setAttribute(self, name, value)
    calls.SetAttribute = (calls.SetAttribute or 0) + 1
    return __fxSetAttribute(self, name, value)
  end

  local function getAttribute(self, ...)
    calls.GetAttribute = (calls.GetAttribute or 0) + 1
    return __fxGetAttribute(self, select("#", ...), ...)
  end

  local function setCooldown(self, start, duration)
    calls.SetCooldown = (calls.SetCooldown or 0) + 1
    return __fxSetCooldown(self, start, duration)
  end

  local entries = {
    SetAttribute = setAttribute,
    GetAttribute = getAttribute,
  }

  -- Installed on one widget type's method table, given one instance of that type. The only handle
  -- on the table is a widget's metatable, exactly as the font interop found it.
  function __fxInstallAttributes(widget, isCooldown)
    local meta = getmetatable(widget)
    if type(meta) ~= "table" then return 0 end
    local table_ = meta.__index
    if type(table_) ~= "table" then return 0 end
    if __fxAttrInstalled[table_] then return 0 end
    __fxAttrInstalled[table_] = true
    local installed = 0
    for name, implementation in pairs(entries) do
      rawset(table_, name, implementation)
      installed = installed + 1
    end
    if isCooldown then
      rawset(table_, "SetCooldown", setCooldown)
      installed = installed + 1
    end
    return installed
  end
end
`;
