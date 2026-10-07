// P1-14 step 0: the offline stand for the fengari bridge's hot spots (docs/implementation/line-P-P1.ru.md,
// P1-14). Node only — no browser, Vite or gateway; the stock FrameXML vertical over the canned seam and
// the client's own MPQ chain.
//
//   node --import ./tools/register-test-sources.mjs bench/framexml-lua-bench.mjs
//     --scenario stock|decode|format|iter|api|string|tooltip|cooldowns
//     [--ticks 3000] [--warmup 500] [--label <name>] [--variant <dir>] [--heap-profile [--heap-top N]] [--census calls|touch]
//
// `stock`: one frame of the vertical — `bridge.runInMutationBatch(() => { seam.tick(now); bridge.tick(1/60); });
// bridge.flushDeferredPaint()` (buff durations on, so AuraButton_OnUpdate formats every frame). The micro
// scenarios run one compiled Lua loop of `--reps` (1000) repetitions per tick, each isolating one crossing:
//   decode   — `frame:GetName()` (the frame decode on every method's self)
//   format   — `fs:SetFormattedText(...)` over the census' common formats (constant text: no relayout)
//   string   — a host binding called with a 30-byte ASCII and a 30-byte Cyrillic string
//   api      — answered C API through the stub floor: `GetCVar` (Lua answer) and `UnitHealth` (seam binding)
//   iter     — `pairs` and `next` over a 20-entry mixed table
//   tooltip  — GameTooltip SetOwner/SetText/AddLine×4/Show/Hide (100 per tick)
//   cooldowns— `seam.tick(now)` alone
// Prints one JSON line: msPerTick (median/p95/max), handlersPerTick, apiCallsPerTick (sum of the Lua
// table `__fxCalls`), decodesPerTick (a wrapper over GlueWidgetBinder#decodeFrame), callsPerTick
// (host calls into Lua: GlueLuaVm.callWith, which `call` goes through, or `call` before P1-14d), errors, and with --heap-profile bytesPerTick (node:inspector HeapProfiler sampling,
// 16 KiB, objects collected by major and minor GC included — allocation volume, as bench/run.mjs).
//
// `--variant <dir>` loads `<dir>/<path from src>` (e.g. `<dir>/browser/glue/GlueLua.ts`) in place of the
// src file wherever one exists — an A/B in one tree. Pairs: run the variants alternately, at least five
// processes each, and compare medians. Client add-ons are not loaded: offline understates the load.
import { registerHooks } from "node:module";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { Session } from "node:inspector/promises";
import ts from "typescript";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback;
};
const scenario = option("scenario", "stock");
const ticks = Number(option("ticks", "3000"));
const warmup = Number(option("warmup", "500"));
const reps = Number(option("reps", scenario === "tooltip" ? "100" : "1000"));
const label = option("label", scenario);
const variantDir = option("variant", undefined);
const heapProfile = args.includes("--heap-profile");

const root = new URL("../", import.meta.url);
const dist = new URL("dist/code/", root).href;
const overridden = [];
if (variantDir) {
  const base = resolve(variantDir);
  const files = new Map();
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith(".ts")) files.set(relative(base, path).replaceAll("\\", "/"), path);
    }
  };
  walk(base);
  overridden.push(...files.keys());
  // Registered after tools/register-test-sources.mjs, so it runs first; anything not in the variant
  // falls through to that hook (dist/code/*.js → src/*.ts).
  registerHooks({
    load(url, context, nextLoad) {
      if (url.startsWith(dist) && url.endsWith(".js")) {
        const path = files.get(url.slice(dist.length).replace(/\.js$/, ".ts"));
        if (path) {
          const result = ts.transpileModule(readFileSync(path, "utf8"), {
            fileName: path,
            compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
          });
          return { format: "module", source: result.outputText, shortCircuit: true };
        }
      }
      return nextLoad(url, context);
    },
  });
}

const at = (rel) => new URL(rel, root).href;
const { FrameXmlBoot } = await import(at("dist/code/browser/framexml/FrameXmlBoot.js"));
const { CannedWorldSeam } = await import(at("dist/code/browser/framexml/CannedWorldSeam.js"));
const { FRAMEXML_VERTICAL_TOC } = await import(at("dist/code/browser/framexml/FrameXmlCorpus.js"));
const { GlueWidgetBinder } = await import(at("dist/code/browser/glue/GlueWidgets.js"));
const { GlueLuaVm } = await import(at("dist/code/browser/glue/GlueLua.js"));
const { clientArchives } = await import(at("tools/mpq.mjs"));
const { clientDirectory } = await import(at("tools/paths.mjs"));

const counters = { decodes: 0, calls: 0 };
const decode = GlueWidgetBinder.prototype.decodeFrame;
if (typeof decode === "function") {
  GlueWidgetBinder.prototype.decodeFrame = function (...rest) { counters.decodes += 1; return decode.apply(this, rest); };
}
const call = GlueLuaVm.prototype.call;
const callWith = GlueLuaVm.prototype.callWith;
if (typeof callWith === "function") {
  // P1-14d: `call` is `callWith` with no lead; count each host call once.
  GlueLuaVm.prototype.callWith = function (...rest) { counters.calls += 1; return callWith.apply(this, rest); };
} else {
  GlueLuaVm.prototype.call = function (...rest) { counters.calls += 1; return call.apply(this, rest); };
}

const chain = await clientArchives(clientDirectory());
const decoder = new TextDecoder("utf-8");
const seam = new CannedWorldSeam();
const boot = new FrameXmlBoot({
  provider: { async read(path) { const data = await chain.read(path); return data ? decoder.decode(data) : undefined; } },
  locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, exercise: false,
  census: option("census", undefined), // P1-14f: "touch" as the world mount sets it
  screen: () => ({ width: 1365, height: 768 }),
});
const inventory = await boot.load();
const { vm, bridge } = boot;
bridge.setPaintDeferral?.(true);
bridge.setLayoutDeferral?.(true);
vm.execute('SHOW_BUFF_DURATIONS = "1"', "@bench:durations");

const compile = (body, name) => {
  const fn = vm.compileFunction(body, `bench:${name}`, []);
  if (!fn) throw new Error(`bench body failed to compile: ${name}`);
  return fn;
};
const sumCalls = compile("local n = 0 for _, v in next, __fxCalls do n = n + v end return n", "sum-calls");
const apiCalls = () => Number(vm.call(sumCalls, [], 1)[0] ?? 0);

let sink = 0;
vm.registerGlobal("__benchSink", (values) => { sink += values.length; return []; });
const setup = {
  format: `
    __benchText = __benchText or UIParent:CreateFontString("BenchFormatText", "OVERLAY", "GameFontNormal")`,
  tooltip: "",
};
if (setup[scenario]) {
  const ok = vm.execute(setup[scenario], `@bench:setup-${scenario}`);
  if (!ok.ok) throw new Error(ok.error);
}
const bodies = {
  decode: `local f = PlayerFrame for i = 1, ${reps} do f:GetName() end`,
  format: `local t = __benchText for i = 1, ${reps / 4} do
    t:SetFormattedText("%d с.", 3.7)
    t:SetFormattedText("%s", "Восстановление")
    t:SetFormattedText("%2$s %1$d-го уровня", 80, "Воин")
    t:SetFormattedText("%d%%", 42)
  end`,
  string: `local a, b = "abcdefghijklmnopqrstuvwxyz0123", "Восстановление сил" for i = 1, ${reps / 2} do __benchSink(a) __benchSink(b) end`,
  api: `for i = 1, ${reps / 2} do GetCVar("buffDurations") UnitHealth("player") end`,
  iter: `local t = { 1, 2, 3, 4, 5, 6, 7, 8, a = 1, b = 2, c = 3, d = 4, e = 5, f = 6, g = 7, h = 8, [100] = 1, [true] = 2, x = "y", z = {} }
    local n = 0 for i = 1, ${reps / 2} do
      for k, v in pairs(t) do n = n + 1 end
      for k, v in next, t do n = n + 1 end
    end`,
  tooltip: `local tip = GameTooltip for i = 1, ${reps} do
    tip:SetOwner(UIParent, "ANCHOR_NONE") tip:SetText("Камень возвращения", 1, 1, 1)
    tip:AddLine("Использование: возвращает вас в", 1, 0.82, 0) tip:AddLine("Время восстановления 30 мин.")
    tip:AddLine("Персональный предмет") tip:AddLine("Уникальный")
    tip:Show() tip:Hide()
  end`,
};
const body = bodies[scenario] ? compile(bodies[scenario], scenario) : undefined;
if (scenario !== "stock" && scenario !== "cooldowns" && !body) throw new Error(`unknown scenario ${scenario}`);

let now = boot.pump.now();
let handlers = 0;
const step = () => {
  now += 1 / 60;
  if (scenario === "stock") {
    bridge.runInMutationBatch(() => { seam.tick(now); handlers += bridge.tick(1 / 60); });
    bridge.flushDeferredPaint();
  } else if (scenario === "cooldowns") {
    bridge.runInMutationBatch(() => { seam.tick(now); });
    bridge.flushDeferredPaint();
  } else {
    bridge.runInMutationBatch(() => { vm.call(body, [], 0); });
    bridge.flushDeferredPaint();
  }
};

for (let index = 0; index < warmup; index += 1) step();
const errorCountBefore = boot.errorCount;
const vmErrorsBefore = vm.errors.length;
handlers = 0;
counters.decodes = 0;
counters.calls = 0;
const apiBefore = apiCalls();
const times = new Float64Array(ticks);
for (let index = 0; index < ticks; index += 1) {
  const begin = performance.now();
  step();
  times[index] = performance.now() - begin;
}
const measuredCalls = counters.calls;
const apiAfter = apiCalls();
const sorted = Array.from(times).sort((a, b) => a - b);
const quantile = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
const result = {
  label, scenario, variant: variantDir ?? null, overridden, ticks, warmup, reps: scenario === "stock" || scenario === "cooldowns" ? undefined : reps,
  msPerTick: { median: +quantile(0.5).toFixed(4), p95: +quantile(0.95).toFixed(4), max: +sorted.at(-1).toFixed(4),
    mean: +(sorted.reduce((a, b) => a + b, 0) / ticks).toFixed(4) },
  handlersPerTick: +(handlers / ticks).toFixed(2),
  apiCallsPerTick: +((apiAfter - apiBefore) / ticks).toFixed(2),
  decodesPerTick: +(counters.decodes / ticks).toFixed(2),
  callsPerTick: +(measuredCalls / ticks).toFixed(2),
  luaErrors: vm.errors.length - vmErrorsBefore,
  errorCount: boot.errorCount - errorCountBefore,
  loadFailed: inventory.lua.failed,
};

if (heapProfile) {
  const session = new Session();
  session.connect();
  await session.post("HeapProfiler.enable");
  await session.post("HeapProfiler.startSampling", {
    samplingInterval: 16384, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true,
  });
  for (let index = 0; index < ticks; index += 1) step();
  const { profile } = await session.post("HeapProfiler.stopSampling");
  let total = 0;
  const self = new Map();
  const walk = (node) => {
    total += node.selfSize;
    if (node.selfSize > 0) {
      const frame = node.callFrame;
      const name = `${frame.functionName || "(anonymous)"} ${frame.url.split("/").pop()}:${frame.lineNumber + 1}`;
      self.set(name, (self.get(name) ?? 0) + node.selfSize);
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(profile.head);
  result.bytesPerTick = Math.round(total / ticks);
  // `--heap-top N`: the N allocating functions by sampled self bytes per tick.
  const top = Number(option("heap-top", "0"));
  if (top > 0) {
    result.heapTop = [...self].sort((a, b) => b[1] - a[1]).slice(0, top)
      .map(([name, bytes]) => `${Math.round(bytes / ticks)} ${name}`);
  }
  session.disconnect();
}
result.sink = sink > 0 ? sink : undefined;
console.log(JSON.stringify(result));
boot.close();
chain.close();
