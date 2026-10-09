/**
 * The global `GetText(token [, gender] [, ordinal])`: a GlobalStrings entry by name, in the
 * grammatical gender and plural form asked for.
 *
 * Stock caller: `ReputationFrame.lua:167` — `GetText("FACTION_STANDING_LABEL"..standingID, gender)`
 * with `UnitSex("player")` — whose answer is each row's standing label and the bar tooltip's text.
 *
 * The original client (Wow.exe 3.3.5a build 12340, read-only Ghidra; the Lua function 0x81b720 and
 * its lookup 0x819d40), in this file's words:
 * * The token is read as a string (a number converts); anything else is a usage error. Gender and
 *   ordinal are read as integers only when they are numbers; otherwise gender is 0 and ordinal -1.
 * * The ordinal picks a plural form by the locale's rule (0x817d10, mode set at start-up from the
 *   locale, 0x40642a): mode 0 (enUS and the rest) `n ~= 1`; mode 1 (koKR, frFR, zhCN, zhTW) `n > 1`;
 *   mode 2 (ruRU) the Russian rule — 11..14 by the last two digits give 2, a last digit 1 gives 0,
 *   2..4 give 1, anything else 2 (C remainders, so negative ordinals give 2). A form of 1..9 adds
 *   the suffix `_P<form>`; form 0 adds nothing.
 * * Gender 3 (female, as `UnitSex` answers) adds `_FEMALE`.
 * * Four names are tried in order — token + plural + female, token + plural, token + female,
 *   token — and the first global that is a string (or a number, converted) is the answer (0x818010:
 *   `_G[name]` with lua_isstring). When none is, the answer is the empty string, not nil.
 *
 * Globals are read with `rawget`, so a miss does not reach this client's `_G` census metamethod.
 * The locale comes from `__fxLocale`, the one the neutral CVar map reads.
 */
import type { FrameXmlNeutralAnswer } from "./FrameXmlNeutralApi.js";

/** The census row: answered by the Lua below. */
export const FRAMEXML_GETTEXT_NEUTRAL: readonly FrameXmlNeutralAnswer[] = Object.freeze([{
  name: "GetText", group: "options",
  answer: "the GlobalStrings entry for token, gender and plural form; \"\" when there is none",
  reason: "ReputationFrame.lua:167: without it every standing label on the reputation bars is empty. "
    + "Semantics per Wow.exe 0x81b720/0x819d40.",
}]);

/** Appended to FRAMEXML_NEUTRAL_PRELUDE. */
export const FRAMEXML_GETTEXT_PRELUDE = `
do
  local impl = __fxNeutralImpl
  local type, tostring, tonumber, rawget, error = type, tostring, tonumber, rawget, error
  local floor, fmod = math.floor, math.fmod
  local modes = { koKR = 1, frFR = 1, zhCN = 1, zhTW = 1, ruRU = 2 }
  local mode = (type(__fxLocale) == "string" and modes[__fxLocale]) or 0

  -- The client's integer read of a Lua number: round to nearest, ties to even.
  local function integer(value)
    local number = tonumber(value)
    if number == nil or number ~= number then return nil end
    local whole = floor(number)
    local fraction = number - whole
    if fraction > 0.5 or (fraction == 0.5 and fmod(whole, 2) ~= 0) then return whole + 1 end
    return whole
  end

  local function pluralForm(n)
    if mode == 0 then return n ~= 1 and 1 or 0 end
    if mode == 1 then return n > 1 and 1 or 0 end
    local hundreds, tens = fmod(n, 100), fmod(n, 10)
    if hundreds >= 11 and hundreds <= 14 then return 2 end
    if tens == 1 then return 0 end
    if tens >= 2 and tens <= 4 then return 1 end
    return 2
  end

  local function lookup(name)
    local value = rawget(_G, name)
    local kind = type(value)
    if kind == "string" then return value end
    if kind == "number" then return tostring(value) end
    return nil
  end

  impl.GetText = function(token, gender, ordinal)
    local kind = type(token)
    if kind == "number" then
      token = tostring(token)
    elseif kind ~= "string" then
      error('Usage: GetText("token" [,gender] [,ordinal])', 2)
    end
    local form = pluralForm(integer(ordinal) or -1)
    local plural = (form >= 1 and form <= 9) and ("_P" .. form) or ""
    local female = integer(gender) == 3 and "_FEMALE" or ""
    return lookup(token .. plural .. female) or lookup(token .. plural)
      or lookup(token .. female) or lookup(token) or ""
  end
end
`;
