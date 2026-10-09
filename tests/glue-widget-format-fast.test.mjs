import assert from "node:assert/strict";
import test from "node:test";
import { lua } from "fengari";

// P1-14e: SetFormattedText answers the stock UI's common formats in JS (GlueWidgetFormatFast.ts);
// whatever the fast path answers must be what Wow.exe's widget formatter (GlueWidgetFormat.ts,
// reached through vm.call as before) makes of the same format and arguments.
const { GlueLuaVm } = await import("../dist/code/browser/glue/GlueLua.js");
const { GlueWidgetBinder } = await import("../dist/code/browser/glue/GlueWidgets.js");
const { luaWidgetFormat } = await import("../dist/code/browser/glue/GlueWidgetFormat.js");
const { formatWidgetTextFast } = await import("../dist/code/browser/glue/GlueWidgetFormatFast.js");
const { FrameXmlUiBridge } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlRuntime.js");

/** The full path: the C formatter under vm.call, undefined when it raised. */
function slowFormatter() {
  const errors = [];
  const vm = new GlueLuaVm({ onError: (message) => errors.push(message) });
  lua.lua_pushjsfunction(vm.state, luaWidgetFormat);
  lua.lua_setglobal(vm.state, "__widgetFormat");
  const ref = vm.globalFunction("__widgetFormat");
  return {
    format(format, args) {
      const answer = vm.call(ref, [format, ...args], 1);
      return answer.length === 0 ? undefined : answer[0];
    },
    close() { vm.release(ref); vm.close(); },
  };
}

// A small deterministic generator (mulberry32): the same cases on every run.
function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const PIECES = ["", " ", "x", "Уровень ", " с.", "-го уровня", "%%", "%s", "%d", "%i", "%05d", "%02d", "%1$s",
  "%2$s", "%3$d", "%1$d", "%2$d", "%9$s", "%.2f", "%x", "%c", "%5s", "%0$s", "%10$s", "%012d", "%-d", "%", "%q", "%u"];
const VALUES = [0, 1, 7, 42, -3, 3.7, -3.7, -0.5, 59.99, 2147483647, 2147483648, -2147483648, -2147483649, 1e15,
  0.1 + 0.2, 0.999999999999999, Number.NaN, Infinity, -Infinity, -0, 123456.789,
  "", "a", "Воин", "Восстановление сил", "12", "3.5", "nul\0byte", true, false, undefined];

test("whatever the fast path answers equals the widget formatter, on 20000 generated cases", () => {
  const slow = slowFormatter();
  const next = random(14);
  const pick = (list) => list[Math.floor(next() * list.length)];
  let answered = 0;
  try {
    for (let index = 0; index < 20000; index += 1) {
      const format = Array.from({ length: 1 + Math.floor(next() * 4) }, () => pick(PIECES)).join("");
      const args = Array.from({ length: Math.floor(next() * 4) }, () => pick(VALUES));
      const fast = formatWidgetTextFast(format, args);
      if (fast === undefined) continue;
      answered += 1;
      assert.equal(fast, slow.format(format, args), `${JSON.stringify(format)} ${JSON.stringify(args.map(String))}`);
    }
  } finally { slow.close(); }
  assert.ok(answered > 3000, `the fast path answered ${answered} cases`);
});

test("the census formats are answered in JS", () => {
  const slow = slowFormatter();
  try {
    const cases = [
      ["%d с.", [3.7]], ["%d мин.", [59.99]], ["%s", ["Восстановление"]], ["%s", [12]],
      ["%2$s %1$d-го уровня", [80, "Воин"]], ["%1$s: %2$s", ["Сила", "+10"]], ["%d%%", [42]],
      ["%02d:%02d", [5, 7]], ["Уровень %d %s", [80, "Воин"]], ["%d", [-2147483649]], ["%i", [-3.7]],
      ["Без формата", []], ["%d", [Number.NaN]],
    ];
    for (const [format, args] of cases) {
      const fast = formatWidgetTextFast(format, args);
      assert.notEqual(fast, undefined, `answered: ${format}`);
      assert.equal(fast, slow.format(format, args), format);
    }
    // Refused, so the formatter answers (or raises) as Wow.exe does.
    for (const [format, args] of [["%.2f", [1]], ["%d", ["12"]], ["%s", [undefined]], ["%d", []],
      ["%1$s %1$d", [3]], ["%05d", [-4]], ["%c", [65]], [12, []], ["a\0b", []], ["%s", ["a\0b"]]]) {
      assert.equal(formatWidgetTextFast(format, args), undefined, `refused: ${JSON.stringify(format)}`);
    }
  } finally { slow.close(); }
});

test("SetFormattedText on a white-listed format sets the text without a vm.call; legacyFormat keeps the call", () => {
  for (const legacyFormat of [false, true]) {
    const vm = new GlueLuaVm();
    const bridge = new FrameXmlUiBridge();
    const binder = new GlueWidgetBinder(vm, bridge, { legacyFormat });
    bridge.setRuntime(binder);
    vm.registerGlobal("CreateFrame", (args) => [bridge.CreateFrame(String(args[0] ?? "Frame"),
      args[1] === undefined ? undefined : String(args[1]), args[2], args[3] === undefined ? undefined : String(args[3]))]);
    try {
      assert.equal(vm.execute('FormatProbe = CreateFrame("Frame", "FormatProbe"):CreateFontString("FormatProbeText")', "@setup").ok, true);
      const body = vm.compileFunction('FormatProbe:SetFormattedText("%d с.", 3.7) FormatProbe:SetFormattedText("%2$s %1$d", 80, "Воин")',
        "format-probe", []);
      const original = vm.call;
      let calls = 0;
      vm.call = function (...rest) { calls += 1; return original.apply(this, rest); };
      vm.call(body);
      vm.call = original;
      assert.equal(calls - 1, legacyFormat ? 2 : 0, `vm.call inside SetFormattedText (legacyFormat ${legacyFormat})`);
      assert.equal(bridge.getFrame("FormatProbeText").text, "Воин 80");
      vm.release(body);
    } finally { vm.close(); }
  }
});
