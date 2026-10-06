/**
 * 3.27 (05.10-3.27b): the formatter behind `FontString:SetFormattedText` (0x0048d800, registration
 * 0x00ac11b0) and `Button:SetFormattedText` (0x009779b0, 0x00b2d488) — Wow.exe 3.3.5a (12340)
 * 0x00818070, which is not str_format (GlueLuaFormat.ts). Notes: .runtime/re-2026-09-30/a1-de-review/
 * r8.c (decompilation), .runtime/re-2026-10-05/l327b/g1.txt (listing, both callers, the Storm printf
 * 0x0076f070, __ftol2 0x0088b9c0).
 *
 * Both callers hand it the format at stack index 2 (the arguments follow) and a 4096-byte stack
 * buffer; FontString's first raises «<name>:SetFormattedText(): Font not set» without a font (not
 * modelled: every stock FontString has one). The formatter, item by item:
 *  - It stops as soon as fewer than 2 bytes of the buffer are left, so the text is at most 4095
 *    bytes and an item past that point is never read (its argument is not checked). Other bytes,
 *    NULs included, are copied one by one; `%%` is a percent sign.
 *  - Position: one digit followed by `$` (`%10$` is not a position: `1`, `0` are width and `$` an
 *    invalid option). As in str_format the number also moves the running counter.
 *  - The item: flags `-+ #0` any number of times, width digits, an optional `.`, an optional `-`,
 *    precision digits — any number of digits; more than 125 characters (0x7d, 0x00818175) is
 *    «invalid format (width or precision too long)» (0x00a446dc).
 *  - e/E/f/g/G — luaL_checknumber, the CRT's sprintf; F — every `F` lowered, sprintf, then
 *    0x0084f030 (SetEuropeanNumbers' decimal comma); d/i — __ftol2, sprintf, then 0x0084f030 (which
 *    finds no point in an integer); o/u/x/X — FISTP with the control word OR 0xC00 (chop: 0x0081823e
 *    to 0x00818261), the low 32 bits; c — __ftol2's low byte written raw, no width and no flags (a
 *    zero byte then ends the text: the callers set a C string); s — luaL_checklstring (a number
 *    argument is converted where it stands, so `%1$s %1$.16f` reads the 14-digit string back) and
 *    sprintf's `%s` (up to the NUL, precision, width — no 100-byte path); anything else, `q` and a
 *    lone trailing `%` included, «invalid option in `format'» (0x00a446c0).
 *  - Each sprintf goes through Storm's 0x0076f070 → 0x0076f010: the item is cut to the room left
 *    and NUL-terminated.
 * Argument errors are luaL_argerror's from a method call: «bad argument #N to 'SetFormattedText'
 * (number expected, got nil)», N counted without self.
 *
 * Not checked in bytes (MSVC CRT of the time, as GlueLuaFormat.ts): an integer precision above 512
 * prints 512 digits (MAXPRECISION); a `-` after the point, or after the width with no point, is
 * skipped here (how that CRT reads `%.-3f` is not known); widths are capped at 65536 and float
 * precisions at 4096, which only changes bytes past the 4095 the buffer keeps.
 *
 * Cost: one pass over the format, in GlueLuaFormat's module buffer; no allocation except a number
 * under `%s` (its tostring text) and the pushed result.
 */
import { lauxlib, lua as luaApi, to_luastring, type LuaState } from "fengari";
import { lua51NumberText } from "./GlueLuaBase51.js";
import {
  floatItem, formatOutput, formatOutputLength, integerItem, putByte, putBytes, setFormatOutputLength,
  stringItem,
} from "./GlueLuaFormat.js";

interface Lua53Calls {
  lua_tolstring(L: LuaState, index: number): Uint8Array | null;
  lua_pushlstring(L: LuaState, bytes: Uint8Array, length: number): void;
  lua_tonumberx(L: LuaState, index: number): number | false;
  lua_pushstring(L: LuaState, bytes: Uint8Array): void;
  lua_replace(L: LuaState, index: number): void;
}
const lua = luaApi as typeof luaApi & Lua53Calls;

const INVALID_OPTION = to_luastring("invalid option in `format'");
const TOO_LONG = to_luastring("invalid format (width or precision too long)");

/** The callers' 4096-byte buffer less its NUL. */
const TEXT_LIMIT = 4095;
/** 0x00818175: CMP EDI,0x7d. */
const SPEC_LIMIT = 125;
const INTEGER_PRECISION_LIMIT = 512;
const FLOAT_PRECISION_LIMIT = 4096;
const WIDTH_LIMIT = 65536;
const INT32 = 2147483648;

function isDigit(byte: number | undefined): boolean {
  return byte !== undefined && byte >= 48 && byte <= 57;
}

/** luaL_argerror from `frame:SetFormattedText(…)`: the method's self is not counted. */
function argumentError(L: LuaState, arg: number, expected: string): never {
  const got = lua.lua_typename(L, lua.lua_type(L, arg));
  lua.lua_pushstring(L, to_luastring(
    `bad argument #${arg} to 'SetFormattedText' (${expected} expected, got ${String.fromCharCode(...got)})`,
  ));
  return lua.lua_error(L) as never;
}

function checkNumber(L: LuaState, arg: number): number {
  const value = lua.lua_tonumberx(L, arg);
  if (value === false) argumentError(L, arg, "number");
  return value as number;
}

/** luaL_checklstring: a number is turned into its tostring text where it stands. */
function checkString(L: LuaState, arg: number): Uint8Array {
  const type = lua.lua_type(L, arg);
  if (type === lua.LUA_TNUMBER) {
    lua.lua_pushstring(L, to_luastring(lua51NumberText(lua.lua_tonumber(L, arg))));
    lua.lua_replace(L, arg);
  } else if (type !== lua.LUA_TSTRING) {
    argumentError(L, arg, "string");
  }
  return lua.lua_tolstring(L, arg) as Uint8Array;
}

/** Cut what an item wrote to the room the buffer had (Storm's printf, 0x0076f010). */
function clampOutput(): void {
  if (formatOutputLength() > TEXT_LIMIT) setFormatOutputLength(TEXT_LIMIT);
}

/** `luaWidgetFormat(format, ...)`: the text SetFormattedText sets (a C function; raises as 0x00818070). */
export function luaWidgetFormat(L: LuaState): number {
  const fmt = checkString(L, 1);
  const end = fmt.length;
  setFormatOutputLength(0);
  let arg = 1;
  let position = 0;
  while (position < end && formatOutputLength() < TEXT_LIMIT) {
    if (fmt[position] !== 37) {
      let stop = fmt.indexOf(37, position);
      if (stop < 0) stop = end;
      putBytes(fmt, position, Math.min(stop - position, TEXT_LIMIT - formatOutputLength()));
      position = stop;
      continue;
    }
    position += 1;
    if (fmt[position] === 37) {
      putByte(37);
      position += 1;
      continue;
    }
    if (isDigit(fmt[position]) && fmt[position + 1] === 36) {
      arg = fmt[position]! - 48;
      position += 2;
    }
    arg += 1;
    const spec = position;
    let at = position;
    let flags = 0;
    for (;;) {
      const flag = fmt[at];
      if (flag === 45) flags |= 1;
      else if (flag === 43) flags |= 2;
      else if (flag === 32) flags |= 4;
      else if (flag === 35) flags |= 8;
      else if (flag === 48) flags |= 16;
      else break;
      at += 1;
    }
    let width = 0;
    while (isDigit(fmt[at])) width = Math.min(width * 10 + fmt[at++]! - 48, WIDTH_LIMIT);
    let precision = -1;
    if (fmt[at] === 46) {
      at += 1;
      precision = 0;
    }
    if (fmt[at] === 45) at += 1;
    while (isDigit(fmt[at])) {
      if (precision >= 0) precision = Math.min(precision * 10 + fmt[at]! - 48, FLOAT_PRECISION_LIMIT);
      at += 1;
    }
    if (at - spec > SPEC_LIMIT) return lauxlib.luaL_error(L, TOO_LONG);
    const conversion = at < end ? fmt[at] : 0;
    position = at + 1;
    switch (conversion) {
      case 100: case 105: case 111: case 117: case 120: case 88: // d i o u x X
        checkNumber(L, arg);
        integerItem(L, arg, conversion, flags, width, Math.min(precision, INTEGER_PRECISION_LIMIT));
        break;
      case 99: { // c: __ftol2's low byte, raw
        const whole = Math.trunc(checkNumber(L, arg));
        putByte((whole >= -INT32 && whole < INT32 ? whole : -INT32) & 255);
        break;
      }
      case 101: case 69: case 102: case 70: case 103: case 71: // e E f F g G
        checkNumber(L, arg);
        floatItem(L, arg, conversion, flags, width, precision);
        break;
      case 115: // s: sprintf's `%s` — precision digits "1" keeps str_format's 100-byte path shut
        checkString(L, arg);
        stringItem(L, arg, flags, width, precision, 1);
        break;
      default:
        return lauxlib.luaL_error(L, INVALID_OPTION);
    }
    clampOutput();
  }
  // The callers set a C string: the text ends at its first zero byte.
  const out = formatOutput();
  let length = formatOutputLength();
  for (let index = 0; index < length; index += 1) {
    if (out[index] === 0) {
      length = index;
      break;
    }
  }
  lua.lua_pushlstring(L, out, length);
  return 1;
}
