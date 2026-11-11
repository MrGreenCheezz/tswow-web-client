/**
 * 3.27 (04.10, L5b): a number as Wow.exe 3.3.5a (12340) writes it — its lua_Number → string conversion
 * 0x00856ea0 (`tostring` 0x00854a20, registration 0x00a47d00; notes .runtime/re-2026-10-04/l5b/h1.c),
 * `sprintf("%.14g")` of the MSVC runtime the client links (its "1#INF"/"1#IND"/"1#QNAN" strings are at
 * 0x009e4adc/0x009e4ae4/0x009e4ad4): fourteen significant digits, trailing zeros dropped, the exponent
 * form below 1e-4 and from 1e14 on, with at least three exponent digits ("1e+015"), "-0" for negative
 * zero, "1.#INF"/"-1.#INF", and "-1.#IND" for 0/0's NaN. 3.27 (11.11): any other NaN by its bits, as the CRT's
 * $I10_OUTPUT (0x004192f4, .runtime/re-2026-11-11/fxapi/d7.c) names it — `msvcNanText`.
 *
 * The VM's own conversion is the same text (luaconf.h, `wl_number2str`; tests/lua-wasm-api.test.mjs);
 * this one serves the host's text built from Lua numbers (GlueLuaFormat.ts, GlueWidgetFormat.ts).
 * (Until ARC-4 A6, 12.10, this file also gave fengari's Lua 5.3 host versions of 5.1's `tostring`,
 * `pairs`, `ipairs` and `math.fmod`; PUC 5.1, the wasm VM, has its own.)
 */

const nanBits = new Float64Array(1);
const nanWords = new Uint32Array(nanBits.buffer);

/**
 * 3.27 (11.11): a NaN as the CRT's $I10_OUTPUT (Wow.exe 0x004192f4) classes it by its bits (the VM hands the
 * double over unchanged; JS arithmetic keeps a computed NaN's sign, only a constant folded 0/0 is positive): its sign,
 * and "1#SNAN" without the quiet bit, "1#IND" for the negative indefinite 0xFFF8000000000000 (0/0, inf − inf),
 * else "1#QNAN".
 */
export function msvcNan(value: number): { readonly negative: boolean; readonly digits: "1#IND" | "1#QNAN" | "1#SNAN" } {
  nanBits[0] = value;
  const low = nanWords[0]!;
  const high = nanWords[1]!;
  const negative = (high >>> 31) === 1;
  const mantissaHigh = high & 0xfffff;
  if ((mantissaHigh & 0x80000) === 0) return { negative, digits: "1#SNAN" };
  return { negative, digits: negative && mantissaHigh === 0x80000 && low === 0 ? "1#IND" : "1#QNAN" };
}

/**
 * A number as Wow.exe's lua_Number → string conversion (0x00856ea0) writes it: MSVC `"%.14g"`.
 * Exported for the host's own text built from Lua numbers.
 */
export function lua51NumberText(value: number): string {
  if (value === 0) return Object.is(value, -0) ? "-0" : "0";
  // Fourteen digits or fewer: the integer itself (the common case, ids and counts).
  if (Number.isInteger(value) && value > -1e14 && value < 1e14) return String(value);
  if (value !== value) {
    const nan = msvcNan(value);
    return `${nan.negative ? "-" : ""}1.${nan.digits.slice(1)}`;
  }
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
