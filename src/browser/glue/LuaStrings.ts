/**
 * P1-14b: a Lua string's bytes as the JS string fengari's lossy decoder makes of them
 * (`to_jsstring(bytes, 0, n, true)`, what `lua_tojsstring` and fengari-interop's `tojs` answer),
 * without its one-`+=`-per-byte loop.
 *
 *  - Short ASCII (the common case: unit tokens, event names, CVar names): a char-code loop that
 *    leaves at the first byte ≥ 0x80.
 *  - Anything else: `TextDecoder("utf-8", { fatal: true, ignoreBOM: true })`. A strict decoder
 *    accepts only well-formed UTF-8, on which fengari's decoder gives the same code points; `ignoreBOM`
 *    keeps a leading U+FEFF as fengari does. On malformed input — where fengari substitutes U+FFFD
 *    and swallows a byte where WHATWG would not, and accepts overlongs and surrogates — the strict
 *    decoder throws and fengari's own decoder answers.
 * Measured on Node 22 (.runtime/perf-step22/p114/strmicro.mjs): fengari 45 ns for 6 ASCII bytes,
 * 197 ns for 30, 212 ns for 34 bytes of Cyrillic; the loop 28 ns for 6, TextDecoder 58 ns for 30 and
 * 160 ns for the Cyrillic. A cache keyed by the byte array's identity was not taken: only constants
 * keep their array, while every string built by `..` or `format` would add a dead weak entry.
 */
import { to_jsstring } from "fengari";

/** Below this many bytes the char-code loop beats a TextDecoder call. */
const SHORT = 16;
const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function luaStringToJs(bytes: Uint8Array): string {
  const length = bytes.length;
  if (length < SHORT) {
    let text = "";
    let index = 0;
    for (; index < length; index += 1) {
      const byte = bytes[index]!;
      if (byte >= 0x80) break;
      text += String.fromCharCode(byte);
    }
    if (index === length) return text;
  }
  try {
    return strict.decode(bytes);
  } catch {
    return to_jsstring(bytes, 0, length, true);
  }
}
