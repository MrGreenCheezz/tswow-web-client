import type { FrameXmlFontStyle } from "../ui/framexml_compat/FrameXmlTypes.js";

/**
 * Font objects as Lua globals — slice F2's first item.
 *
 * F1 measured the whole of the in-world corpus' remaining file-level breakage as
 * one cause: `GameFontNormal` and its 148 siblings are declarations the XML
 * layer knows about and Lua globals the VM does not have. The real client
 * publishes every named font object as a global *object* with the Font API on
 * it, and seven files die on `_G.GameFontNormal:GetFont()` at file scope
 * because it is nil — measured, that is 100% of the load failures.
 *
 * Three decisions here, each of them measured rather than assumed:
 *
 * 1. **Which names.** Not only `<Font>`: the corpus writes most of its font
 *    objects as `<FontString virtual="true" inherits="GameFontNormal">`, and
 *    those are the ones it reads most (`GameFontHighlightSmallLeft` — 270 reads,
 *    `GameFontDisableSmallLeft` — 134). Both spellings become globals here; the
 *    set comes from the corpus scan, so it is complete before the first chunk
 *    runs.
 *
 * 2. **Which methods.** The static census over all 207 Lua chunks finds exactly
 *    one method the corpus calls on a font object: `GetFont`, eight sites, and
 *    all seven load failures are on it. So `GetFont` is implemented and
 *    everything else falls through to F1's per-type method census as
 *    `Font:Name`, recorded once with the file and line that wanted it. That is
 *    the same rule F1 held — a stub answers nothing until a measured failure
 *    promotes it — and it keeps the truthful shape of `if font.SetShadowColor`
 *    tests, because the fallback only manufactures names the corpus calls with
 *    `:` somewhere.
 *
 * 3. **Passing one to a widget.** `SetFontObject(GameFontNormal)` used to hand
 *    the widget layer a nil; with globals it hands it a *table*, and the glue
 *    binder's `str(args[0])` would turn that into garbage where it used to
 *    produce "". So the four font-object setters are wrapped, in Lua, on the way
 *    in: a font object becomes its own name and everything else is passed
 *    through untouched. `GetFontObject` is wrapped on the way out, so a
 *    round-trip returns the object the corpus gave.
 */

/** What Lua needs to answer `GetFont` for one font object. */
export interface FrameXmlFontRecord {
  readonly name: string;
  /** The `font=` file, flattened through the inherits cascade; "" when unset. */
  readonly file: string;
  readonly height: number;
  /** `OUTLINE`, `THICKOUTLINE`, `MONOCHROME`, joined — 3.3.5's third return. */
  readonly flags: string;
}

/**
 * Turn one resolved style into what `GetFont()` returns.
 *
 * 3.3.5's `GetFont` answers `fontFile, height, flags`, where flags is the
 * comma-free concatenation of the outline and monochrome settings — the same
 * string `SetFont` takes back. A font object that declares no file at all (a
 * `<FontString>` template that only overrides `justifyH`) still answers with
 * whatever its parent declared, because the style handed in here has already
 * been flattened through the registry's cascade.
 */
export function frameXmlFontRecord(style: FrameXmlFontStyle): FrameXmlFontRecord {
  const flags: string[] = [];
  // The XML spelling and the API spelling differ: `outline="NORMAL"` is the flag
  // `OUTLINE` and `outline="THICK"` is `THICKOUTLINE`. `NONE` never arrives —
  // the bridge drops it when it flattens the style.
  if (style.outline === "NORMAL") flags.push("OUTLINE");
  else if (style.outline === "THICK") flags.push("THICKOUTLINE");
  else if (style.outline) flags.push(style.outline);
  if (style.monochrome) flags.push("MONOCHROME");
  return {
    name: style.name,
    file: style.file ?? "",
    height: style.height ?? 0,
    // Comma-joined, because the string `GetFont` answers is the one `SetFont`
    // takes back.
    flags: flags.join(","),
  };
}

/**
 * The widget methods that take or return a font object.
 *
 * Measured from the corpus: 29 call sites across `UIDropDownMenu`,
 * `OptionsFrameTemplates`, `TargetFrame`, `ReputationFrame`, `LFDFrame`,
 * `MoneyFrame`, `BuffFrame` and `UIPanelTemplates`, and eight of them pass a
 * variable rather than a literal — which is why the conversion is a wrapper on
 * the method and not a rewrite of the call sites.
 */
export const FRAMEXML_FONT_OBJECT_SETTERS: readonly string[] = Object.freeze([
  "SetFontObject", "SetNormalFontObject", "SetHighlightFontObject", "SetDisabledFontObject",
]);

/** The Font API this slice answers; everything else is left to the method census. */
export const FRAMEXML_FONT_METHODS: readonly string[] = Object.freeze(["GetFont", "GetName"]);

/**
 * The Lua half.
 *
 * `__fxFontNames` is seeded by the host from the corpus scan and `__fxFontData`
 * is a host binding that resolves one declaration against the template registry
 * — called at most once per name, because the object is written straight into
 * `_G` afterwards and the `__index` metamethod never sees that name again.
 */
export const FRAMEXML_FONT_PRELUDE = `
__fxFontNames = __fxFontNames or {}
__fxFontObjects = __fxFontObjects or {}
__fxFontCalls = __fxFontCalls or {}
-- Which method-table entries this chunk has already replaced, so probing a
-- widget type twice (or two types sharing one table) wraps nothing twice.
__fxFontWrapped = __fxFontWrapped or {}

do
  local rawset, rawget, setmetatable, getmetatable = rawset, rawget, setmetatable, getmetatable
  local type, calls = type, __fxFontCalls

  -- One method table for every font object, wrapped by the same per-type
  -- fallback every widget type gets, so an unimplemented Font method is
  -- recorded as \`Font:Name\` with its first touch instead of raising.
  local methods = {
    GetFont = function(self)
      calls.GetFont = (calls.GetFont or 0) + 1
      local record = __fxFontObjects[self]
      if record == nil then return nil end
      -- "" is what the client answers for a font object with no file of its own;
      -- nil would read as "no font object" to the corpus' own \`if not font\`.
      return record.file, record.height, record.flags
    end,
    GetName = function(self)
      calls.GetName = (calls.GetName or 0) + 1
      local record = __fxFontObjects[self]
      return record and record.name or nil
    end,
  }
  __fxFontMethods = methods
  local meta = { __index = methods }

  -- A font object's identity, for the setter wrappers below. Kept off the object
  -- itself so a corpus table that merely happens to carry a \`name\` field is
  -- never mistaken for one.
  function __fxFontName(value)
    if type(value) ~= "table" then return nil end
    local record = __fxFontObjects[value]
    return record and record.name or nil
  end

  -- Called by the \`_G\` metamethod on the first read of a font-object name.
  function __fxMakeFont(name)
    local record = __fxFontData(name)
    if record == nil then return nil end
    local object = setmetatable({}, meta)
    __fxFontObjects[object] = record
    rawset(_G, name, object)
    return object
  end

  -- Widget-side interop, installed on each type's method table once the probe
  -- has produced one instance of that type. Wrapping rather than replacing: the
  -- widget layer's own implementation still runs, it just gets the name it
  -- expects instead of a table it would stringify into garbage.
  function __fxWrapFontMethods(widget, names)
    local widgetMeta = getmetatable(widget)
    if type(widgetMeta) ~= "table" then return 0 end
    local table_ = widgetMeta.__index
    if type(table_) ~= "table" then return 0 end
    local wrapped = 0
    for index = 1, #names do
      local key = names[index]
      local original = rawget(table_, key)
      if type(original) == "function" and not __fxFontWrapped[original] then
        local replacement = function(self, value, ...)
          return original(self, __fxFontName(value) or value, ...)
        end
        __fxFontWrapped[replacement] = true
        rawset(table_, key, replacement)
        wrapped = wrapped + 1
      end
    end
    local getter = rawget(table_, "GetFontObject")
    if type(getter) == "function" and not __fxFontWrapped[getter] then
      local replacement = function(self, ...)
        local answer = getter(self, ...)
        -- The corpus hands a font *object* back to \`SetFontObject\`, so the
        -- getter has to answer with one; the name is what the widget layer
        -- stores, and \`_G[name]\` is where the object for that name lives.
        if type(answer) == "string" then
          local object = _G[answer]
          if __fxFontName(object) ~= nil then return object end
        end
        return answer
      end
      __fxFontWrapped[replacement] = true
      rawset(table_, "GetFontObject", replacement)
      wrapped = wrapped + 1
    end
    return wrapped
  end
end
`;
