/**
 * 3.27 (04.10, L5b): a number as Wow.exe 3.3.5a (12340) writes it — its lua_Number → string conversion
 * 0x00856ea0 (`tostring` 0x00854a20, registration 0x00a47d00; notes .runtime/re-2026-10-04/l5b/h1.c),
 * `sprintf("%.14g")` of the MSVC runtime the client links (its "1#INF"/"1#IND"/"1#QNAN" strings are at
 * 0x009e4adc/0x009e4ae4/0x009e4ad4): fourteen significant digits, trailing zeros dropped, the exponent
 * form below 1e-4 and from 1e14 on, with at least three exponent digits ("1e+015"), "-0" for negative
 * zero, "1.#INF"/"-1.#INF", and "-1.#IND" for 0/0's NaN. Not reproduced: a NaN whose sign bit is clear
 * prints "1.#QNAN" in the client (JS keeps no NaN sign).
 *
 * The VM's own conversion is the same text (luaconf.h, `wl_number2str`; tests/lua-wasm-api.test.mjs);
 * this one serves the host's text built from Lua numbers (GlueLuaFormat.ts, GlueWidgetFormat.ts).
 * (Until ARC-4 A6, 12.10, this file also gave fengari's Lua 5.3 host versions of 5.1's `tostring`,
 * `pairs`, `ipairs` and `math.fmod`; PUC 5.1, the wasm VM, has its own.)
 */

/**
 * A number as Wow.exe's lua_Number → string conversion (0x00856ea0) writes it: MSVC `"%.14g"`.
 * Exported for the host's own text built from Lua numbers.
 */
export function lua51NumberText(value: number): string {
  if (value === 0) return Object.is(value, -0) ? "-0" : "0";
  // Fourteen digits or fewer: the integer itself (the common case, ids and counts).
  if (Number.isInteger(value) && value > -1e14 && value < 1e14) return String(value);
  if (value !== value) return "-1.#IND";
  if (value === Infinity) return "1.#INF";
  if (value === -Infinity) return "-1.#INF";
  // d.ddddddddddddde±x: fourteen significant digits, correctly rounded, ties away from zero.
  const scientific = value.toExponential(13);
  const at = scientific.indexOf("e");
  const exponent = Number(scientific.slice(at + 1));
  const sign = value < 0 ? "-" : "";
  const digits = scientific.slice(sign.length, at).replace(".", "");
  const significant = digits.replace(/0+$/, "");
  if (exponent < -4 || exponent >= 14) {
    const mantissa = significant.length > 1 ? `${significant[0]}.${significant.slice(1)}` : significant;
    return `${sign}${mantissa}e${exponent < 0 ? "-" : "+"}${String(Math.abs(exponent)).padStart(3, "0")}`;
  }
  if (exponent < 0) return `${sign}0.${"0".repeat(-exponent - 1)}${significant}`;
  const fraction = significant.slice(exponent + 1);
  return `${sign}${digits.slice(0, exponent + 1)}${fraction ? `.${fraction}` : ""}`;
}
