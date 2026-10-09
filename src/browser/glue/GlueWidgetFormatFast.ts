/**
 * P1-14e (e1): `SetFormattedText` without entering Lua for the formats the stock UI spends its frames
 * on. The full formatter is Wow.exe's 0x00818070 as a Lua C function (GlueWidgetFormat.ts), reached
 * through `vm.call`: the arguments the method binding already decoded are pushed back onto the Lua
 * stack, a traceback handler is staged and the text is decoded again — every frame, for every aura
 * with a timer (`AuraButton_UpdateDuration`, BuffFrame.lua: `duration:SetFormattedText(
 * SecondsToTimeAbbrev(timeLeft))`, a format like "%d с." and a fractional number).
 *
 * This answers only a white list whose result is the formatter's by construction, and `undefined`
 * for everything else, which then takes the full path unchanged (and raises there, as Wow.exe does):
 *  - a string format with no NUL byte; items `%%`, `%s`, `%d`, `%i`, `%0Nd`/`%0Ni` (N 1–9, the value
 *    not negative), each optionally `%N$` positioned (N 1–9);
 *  - `%d`/`%i`: a JS number — __ftol2: toward zero, outside int32 (NaN, ±inf included) −2^31;
 *  - `%s`: a JS string with no NUL, or a number as its "%.14g" text (lua51NumberText) — but only
 *    when no other item reads the same argument (luaL_checklstring converts it in place);
 *  - the text at most 1365 UTF-16 units, so its UTF-8 fits the callers' 4095-byte buffer.
 * Argument strings reached the binding through fengari's decoder and the full path would encode
 * them back to the same bytes, so a JS string in, a JS string out, is the same text.
 */
import { lua51NumberText } from "./GlueLuaBase51.js";

const INT32 = 2147483648;
/** 4095 bytes; a UTF-16 unit is at most three UTF-8 bytes. */
const SAFE_LENGTH = 1365;

/** One item's argument slot per item read, to refuse a slot read twice (the `%s` conversion in place). */
const used = new Uint8Array(16);

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

/** The text 0x00818070 makes of `format` and `args`, or `undefined` when the full formatter must answer. */
export function formatWidgetTextFast(format: unknown, args: readonly unknown[]): string | undefined {
  if (typeof format !== "string" || format.includes("\0")) return undefined;
  let percent = format.indexOf("%");
  if (percent < 0) return format.length <= SAFE_LENGTH ? format : undefined;
  used.fill(0);
  let out = "";
  let position = 0;
  let arg = 0;
  while (percent >= 0) {
    out += format.slice(position, percent);
    let at = percent + 1;
    let code = format.charCodeAt(at);
    if (code === 37) {
      out += "%";
      position = at + 1;
      percent = format.indexOf("%", position);
      continue;
    }
    // `%N$`: one digit 1–9 and a dollar sign; the counter becomes N.
    if (code >= 49 && code <= 57 && format.charCodeAt(at + 1) === 36) {
      arg = code - 48 - 1;
      at += 2;
      code = format.charCodeAt(at);
    }
    let width = 0;
    if (code === 48) {
      const digit = format.charCodeAt(at + 1);
      if (!(digit >= 49 && digit <= 57)) return undefined;
      width = digit - 48;
      at += 2;
      code = format.charCodeAt(at);
    }
    if (isDigit(code)) return undefined;
    // Arguments count from 1 after the format; the slot a plain item reads is the counter plus one.
    arg += 1;
    if (arg > 9 || used[arg] !== 0) return undefined;
    used[arg] = 1;
    const value = args[arg - 1];
    if (code === 100 || code === 105) { // d i
      if (typeof value !== "number") return undefined;
      const whole = Math.trunc(value);
      const number = whole >= -INT32 && whole < INT32 ? whole : -INT32;
      if (width > 0) {
        if (number < 0) return undefined;
        out += String(number).padStart(width, "0");
      } else {
        out += number === 0 ? "0" : String(number);
      }
    } else if (code === 115 && width === 0) { // s
      if (typeof value === "string") {
        if (value.includes("\0")) return undefined;
        out += value;
      } else if (typeof value === "number") {
        out += lua51NumberText(value);
      } else {
        return undefined;
      }
    } else {
      return undefined;
    }
    position = at + 1;
    if (out.length > SAFE_LENGTH) return undefined;
    percent = format.indexOf("%", position);
  }
  out += format.slice(position);
  return out.length <= SAFE_LENGTH ? out : undefined;
}
