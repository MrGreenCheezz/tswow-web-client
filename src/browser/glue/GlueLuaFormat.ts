/**
 * 3.27 (05.10): `string.format` as Wow.exe 3.3.5a (12340) has it — str_format 0x00853c50
 * (registration `format` 0x00a47900), as a host C function replacing the preamble's Lua shim
 * (GlueLua.ts, which rewrote positions and casts in Lua and handed the rest to fengari's 5.3
 * `string.format`). Notes: .runtime/re-2026-10-05/l327/f1.c, f2.txt (listing of 0x00853c50) and
 * .runtime/re-2026-10-04/l5b/h1.c.
 *
 * The client's variant of 5.1's str_format, item by item:
 *  - `%%` is a percent sign; any other byte is copied.
 *  - Position: when the byte after `%` is a digit followed by `$`, or two digits followed by `$`,
 *    that number N names the argument (`%2$s`, GlobalStrings' `%10$s`); N then also is where the
 *    running counter stands, so a later plain item takes N + 1. `%0$s` names the format string.
 *  - The item is scanned with Lua's own pattern matcher and "[-+ #0]*(%d*)%.?(%d*)" (0x00a47b08):
 *    more than two width digits, more than two precision digits or more than 16 characters is
 *    «invalid format (width or precision too long)» (0x00a446dc). Flags may repeat (no 5.1
 *    «repeated flags»).
 *  - The conversion: d/i — luaL_checknumber, then __ftol2_sse (0x0088b9c0, cvttsd2si: toward zero,
 *    -2147483648 outside int32 and for NaN/±inf), printed with an `l` added; c — the same cast,
 *    printed with `%c` (the int's low byte; the item is added with strlen, so a zero byte ends it);
 *    o/u/x/X — the number through FISTP with the chop mode into 64 bits, the low 32 printed with an
 *    `l` (0 outside the int64 range); e/E/f/g/G — the double through the CRT's sprintf; F — every
 *    `F` of the item lowered to `f`, sprintf, then 0x0084f030: under SetEuropeanNumbers (flag
 *    0x00d413b8, set by 0x0084f010) a `.` between digits becomes `,`; q — 5.1's addquoted
 *    (0x00853af0: `"`, `\"`, `\\`, `\` + newline, `\r`, `\000`), flags and width ignored; s —
 *    luaL_checklstring (a string or a number — nil, booleans and tables raise), and a value of 100
 *    bytes or more with no precision digits goes in whole (NULs included, width ignored), anything
 *    else through sprintf's `%s` (up to the first NUL, precision and width applied). Every other
 *    byte, a lone trailing `%` included, is «invalid option in `format'» (0x00a446c0). An argument
 *    that is missing is luaL_check*'s «… expected, got no value» (no «no value» check of its own).
 *
 * The CRT is MSVC's of that time: three exponent digits ("1e+006"), the mantissa rounded to 17
 * significant digits first and then, by its digit string, to the precision (half up), and the
 * special values printed from the digit strings "1#INF" and "1#IND" through the same rounding
 * ("1.#INF00", "%.2f" "1.#J", "%g" "1.#INF"; NaN as 0/0's "-1.#IND" — JS keeps no NaN sign).
 * Width and the `0` flag pad every conversion, strings and characters included, as its printf does;
 * a precision on an integer turns the `0` flag off; `#x` adds no prefix to a zero.
 *
 * Numbers that `%s`, `%q` and a number format string print are converted as `tostring` is
 * (lua51NumberText, "%.14g"): fengari's own conversion would write "3.0" for 6/2.
 *
 * Cost: one pass over the format bytes per call, no plan cache; the result is assembled in a
 * module buffer and pushed once (lua_pushlstring copies it). Integer items and `%.Nf` (N ≤ 9) with
 * a scaled value below 2^31 are written digit by digit; only `%e`/`%g`, wide `%f` and values next to
 * a rounding tie go through JS's toExponential. format cannot re-enter itself: it calls no
 * metamethod and no Lua.
 */
import { lauxlib, lua as luaApi, to_luastring, type LuaState } from "fengari";
import { lua51NumberText } from "./GlueLuaBase51.js";

/** The C-API calls this file needs beyond src/types/fengari.d.ts; fengari implements each one. */
interface Lua53Calls {
  lua_tolstring(L: LuaState, index: number): Uint8Array | null;
  lua_pushlstring(L: LuaState, bytes: Uint8Array, length: number): void;
  lua_tonumberx(L: LuaState, index: number): number | false;
}
interface AuxCalls {
  luaL_checknumber(L: LuaState, arg: number): number;
  luaL_checklstring(L: LuaState, arg: number): Uint8Array;
}
const lua = luaApi as typeof luaApi & Lua53Calls;
const aux = lauxlib as typeof lauxlib & AuxCalls;

const INVALID_OPTION = to_luastring("invalid option in `format'");
const TOO_LONG = to_luastring("invalid format (width or precision too long)");

const FLAG_LEFT = 1;
const FLAG_PLUS = 2;
const FLAG_SPACE = 4;
const FLAG_ALT = 8;
const FLAG_ZERO = 16;

const INT32 = 2147483648;
const UINT32 = 4294967296;
const INT64 = 9223372036854775808;
const POW10 = [1, 10, 100, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9];

/** SetEuropeanNumbers, per Lua universe (the main state's global state: coroutines share it). */
const european = new WeakMap<object, boolean>();

function universe(L: LuaState): object {
  return (L as unknown as { l_G?: object }).l_G ?? (L as unknown as object);
}

/**
 * Wow.exe 0x0084f010: the flag SetEuropeanNumbers (0x00510de0) sets; only `%F` reads it. Exported
 * for the host's SetEuropeanNumbers answer.
 */
export function setLuaFormatEuropeanNumbers(L: LuaState, on: boolean): void {
  european.set(universe(L), on);
}

// The result being built, and one item's body before padding.
let out = new Uint8Array(256);
let outLength = 0;
const body = new Uint8Array(1024);
let bodyLength = 0;
// One item's prefix: a sign, or "0x".
let prefix0 = 0;
let prefix1 = 0;
let prefixLength = 0;

function reserve(extra: number): void {
  const need = outLength + extra;
  if (need <= out.length) return;
  let size = out.length * 2;
  while (size < need) size *= 2;
  const grown = new Uint8Array(size);
  grown.set(out.subarray(0, outLength));
  out = grown;
}

function putByte(byte: number): void {
  if (outLength === out.length) reserve(1);
  out[outLength++] = byte;
}

function putBytes(bytes: Uint8Array, start: number, length: number): void {
  reserve(length);
  out.set(bytes.subarray(start, start + length), outLength);
  outLength += length;
}

function putRepeat(byte: number, count: number): void {
  if (count <= 0) return;
  reserve(count);
  out.fill(byte, outLength, outLength + count);
  outLength += count;
}

/** The item as printf pads it: spaces, prefix, zeros, body — or prefix, body, spaces when left. */
function putItem(source: Uint8Array, start: number, length: number, flags: number, width: number): void {
  const padding = width - prefixLength - length;
  if ((flags & (FLAG_LEFT | FLAG_ZERO)) === 0) putRepeat(32, padding);
  if (prefixLength > 0) putByte(prefix0);
  if (prefixLength > 1) putByte(prefix1);
  if ((flags & (FLAG_LEFT | FLAG_ZERO)) === FLAG_ZERO) putRepeat(48, padding);
  putBytes(source, start, length);
  if ((flags & FLAG_LEFT) !== 0) putRepeat(32, padding);
}

function bodyText(text: string, from = 0): void {
  for (let index = from; index < text.length; index += 1) body[bodyLength++] = text.charCodeAt(index);
}

/** `value`'s decimal digits at the end of the body, at least `minimum` of them. */
function bodyDigits(value: number, minimum: number, radix: number, upper: boolean): void {
  let count = 0;
  let rest = value;
  do {
    count += 1;
    rest = Math.floor(rest / radix);
  } while (rest > 0);
  if (value === 0) count = 0;
  const total = Math.max(count, minimum);
  const end = bodyLength + total;
  let at = end;
  rest = value;
  for (let written = 0; written < count; written += 1) {
    const digit = rest % radix;
    rest = Math.floor(rest / radix);
    body[--at] = digit < 10 ? 48 + digit : (upper ? 55 : 87) + digit;
  }
  while (at > bodyLength) body[--at] = 48;
  bodyLength = end;
}

/** __ftol2_sse (cvttsd2si): toward zero; outside int32, NaN and ±inf are -2147483648. */
function castInt32(value: number): number {
  const whole = Math.trunc(value);
  return whole >= -INT32 && whole < INT32 ? whole : -INT32;
}

/** FISTP qword with the chop mode, the low 32 bits: toward zero; outside int64 (NaN, ±inf) 0. */
function castUint32(value: number): number {
  const whole = Math.trunc(value);
  if (!(whole >= -INT64 && whole < INT64)) return 0;
  const low = whole % UINT32;
  return low < 0 ? low + UINT32 : low;
}

// --- MSVC floating point --------------------------------------------------------------------

/** The CRT's digit string of |value| (17 significant digits, or "1#INF"/"1#IND") and its decimal point. */
let mantissa = "";
let decimalPoint = 0;

function decompose(value: number): void {
  if (value !== value) {
    mantissa = "1#IND";
    decimalPoint = 1;
    return;
  }
  if (value === Infinity || value === -Infinity) {
    mantissa = "1#INF";
    decimalPoint = 1;
    return;
  }
  if (value === 0) {
    mantissa = "0";
    decimalPoint = 1;
    return;
  }
  const text = Math.abs(value).toExponential(16);
  const at = text.indexOf("e");
  mantissa = text.charAt(0) + text.slice(2, at);
  decimalPoint = Number(text.slice(at + 1)) + 1;
}

/**
 * _fptostr: the first `count` characters of the mantissa (zeros past its end), rounded half up by
 * the character after them; a carry out of the first digit gives "1" and moves the decimal point.
 * Returns the characters (`count` of them, `count + 1` after a carry when `grow`).
 */
function roundMantissa(count: number, grow: boolean): string {
  // Below the first digit nothing rounds; at it, a first digit of 5 or more carries into a "1".
  if (count < 0) return "";
  let kept = mantissa.length >= count ? mantissa.slice(0, count) : mantissa + "0".repeat(count - mantissa.length);
  const next = count < mantissa.length ? mantissa.charCodeAt(count) : 48;
  if (next >= 53) {
    let index = count - 1;
    while (index >= 0 && kept.charCodeAt(index) === 57) index -= 1;
    if (index < 0) {
      decimalPoint += 1;
      kept = grow ? "1" + "0".repeat(count) : "1" + "0".repeat(count - 1);
    } else {
      kept = kept.slice(0, index) + String.fromCharCode(kept.charCodeAt(index) + 1) + "0".repeat(count - 1 - index);
    }
  }
  return kept;
}

function signPrefix(negative: boolean, flags: number): void {
  if (negative) {
    prefix0 = 45;
    prefixLength = 1;
  } else if ((flags & FLAG_PLUS) !== 0) {
    prefix0 = 43;
    prefixLength = 1;
  } else if ((flags & FLAG_SPACE) !== 0) {
    prefix0 = 32;
    prefixLength = 1;
  }
}

/** %f's body from the decomposed value. */
function fixedBody(precision: number, alternate: boolean): void {
  const digits = roundMantissa(decimalPoint + precision, true);
  const whole = decimalPoint;
  if (whole <= 0) {
    body[bodyLength++] = 48;
  } else {
    for (let index = 0; index < whole; index += 1) {
      body[bodyLength++] = index < digits.length ? digits.charCodeAt(index) : 48;
    }
  }
  if (precision > 0 || alternate) body[bodyLength++] = 46;
  for (let place = 0; place < precision; place += 1) {
    const index = whole + place;
    body[bodyLength++] = index >= 0 && index < digits.length ? digits.charCodeAt(index) : 48;
  }
}

/** %e's body: d.ddd e±xxx. */
function exponentBody(precision: number, alternate: boolean, upper: boolean): void {
  const digits = roundMantissa(precision + 1, false);
  body[bodyLength++] = digits.charCodeAt(0);
  if (precision > 0 || alternate) body[bodyLength++] = 46;
  bodyText(digits, 1);
  const exponent = mantissa === "0" ? 0 : decimalPoint - 1;
  body[bodyLength++] = upper ? 69 : 101;
  body[bodyLength++] = exponent < 0 ? 45 : 43;
  const size = Math.abs(exponent);
  bodyDigits(size, 3, 10, false);
}

/** _cropzeros: trailing zeros of the fraction (before an exponent) and a bare point go. */
function cropZeros(start: number): void {
  let point = -1;
  let exponentAt = bodyLength;
  for (let index = start; index < bodyLength; index += 1) {
    const byte = body[index];
    if (byte === 46) point = index;
    else if (byte === 101 || byte === 69) {
      exponentAt = index;
      break;
    }
  }
  if (point < 0) return;
  let end = exponentAt;
  while (end > point + 1 && body[end - 1] === 48) end -= 1;
  if (end === point + 1) end = point;
  if (end === exponentAt) return;
  body.copyWithin(end, exponentAt, bodyLength);
  bodyLength -= exponentAt - end;
}

/** %g: %e when the exponent after rounding to P digits is below -4 or at least P, else %f. */
function generalBody(precision: number, alternate: boolean, upper: boolean): void {
  const digits = precision === 0 ? 1 : precision;
  const saved = decimalPoint;
  roundMantissa(digits, false);
  const exponent = mantissa === "0" ? 0 : decimalPoint - 1;
  decimalPoint = saved;
  const start = bodyLength;
  if (exponent < -4 || exponent >= digits) exponentBody(digits - 1, alternate, upper);
  else fixedBody(digits - 1 - exponent, alternate);
  if (!alternate) cropZeros(start);
}

/** %.Nf without a tie in sight, digit by digit; false when the exact path has to answer. */
function fastFixed(value: number, precision: number, alternate: boolean): boolean {
  if (precision > 9) return false;
  const magnitude = value < 0 ? -value : value;
  const scaled = magnitude * POW10[precision]!;
  if (!(scaled < INT32)) return false;
  let units = Math.floor(scaled);
  const fraction = scaled - units;
  if (fraction > 0.499999 && fraction < 0.500001) return false;
  if (fraction > 0.5) units += 1;
  bodyDigits(units, precision + 1, 10, false);
  if (precision > 0 || alternate) {
    // Open the point before the last `precision` digits.
    const point = bodyLength - precision;
    body.copyWithin(point + 1, point, bodyLength);
    body[point] = 46;
    bodyLength += 1;
  }
  return true;
}

function floatItem(L: LuaState, arg: number, conversion: number, flags: number, width: number, precision: number): void {
  const value = aux.luaL_checknumber(L, arg);
  bodyLength = 0;
  prefixLength = 0;
  const alternate = (flags & FLAG_ALT) !== 0;
  const negative = value < 0 || Object.is(value, -0) || value !== value;
  signPrefix(negative, flags);
  const places = precision < 0 ? 6 : precision;
  if (conversion === 102 || conversion === 70) {
    if (!(value === value && fastFixed(value, places, alternate))) {
      decompose(value);
      fixedBody(places, alternate);
    }
    if (conversion === 70 && european.get(universe(L)) === true) {
      // 0x0084f030: inside a number, a point with a digit after it becomes a comma.
      for (let index = 1; index + 1 < bodyLength; index += 1) {
        if (body[index] === 46 && body[index - 1]! >= 48 && body[index - 1]! <= 57
            && body[index + 1]! >= 48 && body[index + 1]! <= 57) body[index] = 44;
      }
    }
  } else {
    decompose(value);
    if (conversion === 101 || conversion === 69) exponentBody(places, alternate, conversion === 69);
    else generalBody(places, alternate, conversion === 71);
  }
  putItem(body, 0, bodyLength, flags, width);
}

function integerItem(L: LuaState, arg: number, conversion: number, flags: number, width: number, precision: number): void {
  const value = aux.luaL_checknumber(L, arg);
  bodyLength = 0;
  prefixLength = 0;
  let itemFlags = flags;
  let minimum = 1;
  if (precision >= 0) {
    minimum = precision;
    itemFlags &= ~FLAG_ZERO;
  }
  if (conversion === 100 || conversion === 105) {
    const number = castInt32(value);
    signPrefix(number < 0, flags);
    bodyDigits(number < 0 ? -number : number, minimum, 10, false);
  } else {
    const number = castUint32(value);
    const radix = conversion === 111 ? 8 : conversion === 117 ? 10 : 16;
    bodyDigits(number, minimum, radix, conversion === 88);
    if ((flags & FLAG_ALT) !== 0) {
      if (radix === 16 && number !== 0) {
        prefix0 = 48;
        prefix1 = conversion;
        prefixLength = 2;
      } else if (radix === 8 && (bodyLength === 0 || body[0] !== 48)) {
        body.copyWithin(1, 0, bodyLength);
        body[0] = 48;
        bodyLength += 1;
      }
    }
  }
  putItem(body, 0, bodyLength, itemFlags, width);
}

function charItem(L: LuaState, arg: number, flags: number, width: number): void {
  const byte = castInt32(aux.luaL_checknumber(L, arg)) & 255;
  prefixLength = 0;
  body[0] = byte;
  const start = outLength;
  putItem(body, 0, 1, flags, width);
  if (byte === 0) {
    // luaL_addstring: the item ends at its first zero byte.
    let end = start;
    while (out[end] !== 0) end += 1;
    outLength = end;
  }
}

/** luaL_checklstring's bytes: a string as it is, a number as tostring prints it. */
function stringArg(L: LuaState, arg: number): Uint8Array {
  const type = lua.lua_type(L, arg);
  if (type === lua.LUA_TSTRING) return lua.lua_tolstring(L, arg) as Uint8Array;
  if (type === lua.LUA_TNUMBER) return to_luastring(lua51NumberText(lua.lua_tonumber(L, arg)));
  return aux.luaL_checklstring(L, arg);
}

function stringItem(L: LuaState, arg: number, flags: number, width: number, precision: number, precisionDigits: number): void {
  const text = stringArg(L, arg);
  if (precisionDigits === 0 && text.length >= 100) {
    putBytes(text, 0, text.length);
    return;
  }
  let length = text.indexOf(0);
  if (length < 0) length = text.length;
  if (precision >= 0 && precision < length) length = precision;
  prefixLength = 0;
  putItem(text, 0, length, flags, width);
}

function quotedItem(L: LuaState, arg: number): void {
  const text = stringArg(L, arg);
  putByte(34);
  for (let index = 0; index < text.length; index += 1) {
    const byte = text[index]!;
    if (byte === 34 || byte === 92 || byte === 10) {
      putByte(92);
      putByte(byte);
    } else if (byte === 13) {
      putByte(92);
      putByte(114);
    } else if (byte === 0) {
      putByte(92);
      putByte(48);
      putByte(48);
      putByte(48);
    } else {
      putByte(byte);
    }
  }
  putByte(34);
}

function isDigit(byte: number | undefined): boolean {
  return byte !== undefined && byte >= 48 && byte <= 57;
}

/** The host C function `string.format` / `format`. */
export function luaFormat(L: LuaState): number {
  const fmt = lua.lua_type(L, 1) === lua.LUA_TNUMBER
    ? to_luastring(lua51NumberText(lua.lua_tonumber(L, 1)))
    : aux.luaL_checklstring(L, 1);
  const end = fmt.length;
  outLength = 0;
  let arg = 1;
  let position = 0;
  while (position < end) {
    const byte = fmt[position];
    if (byte !== 37) {
      // A literal run up to the next '%'.
      let stop = fmt.indexOf(37, position);
      if (stop < 0) stop = end;
      putBytes(fmt, position, stop - position);
      position = stop;
      continue;
    }
    position += 1;
    if (fmt[position] === 37) {
      putByte(37);
      position += 1;
      continue;
    }
    // A position of one or two digits.
    let spec = position;
    if (isDigit(fmt[position])) {
      if (fmt[position + 1] === 36) {
        arg = fmt[position]! - 48;
        spec = position + 2;
      } else if (isDigit(fmt[position + 1]) && fmt[position + 2] === 36) {
        arg = (fmt[position]! - 48) * 10 + fmt[position + 1]! - 48;
        spec = position + 3;
      }
    }
    arg += 1;
    // "[-+ #0]*(%d*)%.?(%d*)"
    let at = spec;
    let flags = 0;
    for (;;) {
      const flag = fmt[at];
      if (flag === 45) flags |= FLAG_LEFT;
      else if (flag === 43) flags |= FLAG_PLUS;
      else if (flag === 32) flags |= FLAG_SPACE;
      else if (flag === 35) flags |= FLAG_ALT;
      else if (flag === 48) flags |= FLAG_ZERO;
      else break;
      at += 1;
    }
    let width = 0;
    const widthStart = at;
    while (isDigit(fmt[at])) width = width * 10 + fmt[at++]! - 48;
    const widthDigits = at - widthStart;
    let precision = -1;
    let precisionDigits = 0;
    if (fmt[at] === 46) {
      at += 1;
      precision = 0;
      const precisionStart = at;
      while (isDigit(fmt[at])) precision = precision * 10 + fmt[at++]! - 48;
      precisionDigits = at - precisionStart;
    }
    if (widthDigits > 2 || precisionDigits > 2 || at - spec > 16) return lauxlib.luaL_error(L, TOO_LONG);
    const conversion = at < end ? fmt[at] : 0;
    position = at + 1;
    switch (conversion) {
      case 100: case 105: case 111: case 117: case 120: case 88: // d i o u x X
        integerItem(L, arg, conversion, flags, width, precision);
        break;
      case 99: // c
        charItem(L, arg, flags, width);
        break;
      case 101: case 69: case 102: case 70: case 103: case 71: // e E f F g G
        floatItem(L, arg, conversion, flags, width, precision);
        break;
      case 115: // s
        stringItem(L, arg, flags, width, precision, precisionDigits);
        break;
      case 113: // q
        quotedItem(L, arg);
        break;
      default:
        return lauxlib.luaL_error(L, INVALID_OPTION);
    }
  }
  lua.lua_pushlstring(L, out, outLength);
  return 1;
}

/** Install `luaFormat` as `string.format` and the 5.1 global alias `format`. */
export function installGlueLuaFormat(L: LuaState): void {
  lua.lua_pushjsfunction(L, luaFormat);
  lua.lua_getglobal(L, to_luastring("string"));
  if (lua.lua_type(L, -1) === lua.LUA_TTABLE) {
    lua.lua_pushvalue(L, -2);
    lua.lua_setfield(L, -2, to_luastring("format"));
  }
  lua.lua_pop(L, 1);
  lua.lua_setglobal(L, to_luastring("format"));
}
