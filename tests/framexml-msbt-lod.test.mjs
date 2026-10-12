import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test, { after } from "node:test";

// 3.18 (owner, 12.10) on the real corpus: MSBTOptions, the client's third-party load-on-demand
// add-on, is prefetched in the mount's loading window (read, not run) and `/msbt` loads it inside its
// LoadAddOn and opens it on the next line (MSBTProfiles.lua:1554-1566), on the first try, as in
// Wow.exe. Measured here, in Node off the client's own files: the prefetch (the loading window's
// cost now), the LoadAddOn inside `/msbt` (the cost moved to the first use), and for comparison the
// asynchronous load the loading window used to run.
let clientDirectory;
try {
  clientDirectory = (await import("../tools/paths.mjs")).clientDirectory();
} catch {
  clientDirectory = undefined;
}
const ADDONS = ["MikScrollingBattleText", "MSBTOptions"];
const available = clientDirectory !== undefined
  && ADDONS.every((name) => existsSync(join(clientDirectory, "Interface", "AddOns", name)));
const withMsbt = { skip: available ? false : "the client's MikScrollingBattleText/MSBTOptions are not installed", concurrency: false };

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const chain = available ? await (await import("../tools/mpq.mjs")).clientArchives(clientDirectory) : undefined;
after(() => chain?.close());
const decoder = new TextDecoder("utf-8");

async function msbtBoot() {
  const reads = [];
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        const data = await chain.read(path);
        const source = data ? decoder.decode(data) : undefined;
        reads.push({ path: path.toLowerCase(), bytes: data?.byteLength ?? 0 });
        return source;
      },
    },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam: new CannedWorldSeam(),
    installedAddons: ADDONS, eagerAddons: ["MikScrollingBattleText"],
    screen: () => ({ width: 1365, height: 768 }),
  });
  await boot.load();
  assert.deepEqual(boot.addonResults.filter((result) => !result.ok).map((result) => result.message), [], "MSBT loads eagerly");
  return { boot, reads };
}

function lua(boot, code, results = 1) {
  const fn = boot.vm.compileFunction(code, "msbt-lod", []);
  assert.ok(fn, code);
  try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
}

test("/msbt loads the prefetched MSBTOptions inside LoadAddOn and opens it on the first try", withMsbt, async (t) => {
  const { boot, reads } = await msbtBoot();
  try {
    lua(boot, `
      MSBT_LOD_LOADED = {}
      local frame = CreateFrame("Frame")
      frame:RegisterEvent("ADDON_LOADED")
      frame:SetScript("OnEvent", function(self, event, name) MSBT_LOD_LOADED[#MSBT_LOD_LOADED + 1] = name end)
    `, 0);
    const readsBefore = reads.length;
    const started = performance.now();
    const prefetched = await boot.prefetchAddon("MSBTOptions");
    const prefetchMs = performance.now() - started;
    assert.deepEqual(prefetched, { ok: true });
    const prefetchReads = reads.slice(readsBefore);
    assert.deepEqual(lua(boot, "return IsAddOnLoaded('MSBTOptions'), MSBTOptions", 2), [undefined, undefined],
      "nothing of it ran in the loading window");

    boot.vm.registerGlobal("__msbtNow", () => [performance.now()]);
    boot.vm.registerGlobal("__msbtErrors", () => [boot.errors.length]);
    lua(boot, `
      local load = LoadAddOn
      MSBT_LOAD_CALLS = {}
      LoadAddOn = function(name)
        local started, errors = __msbtNow(), __msbtErrors()
        local loaded, reason = load(name)
        MSBT_LOAD_CALLS[#MSBT_LOAD_CALLS + 1] = tostring(name) .. "=" .. tostring(loaded) .. "/" .. tostring(reason)
        -- The add-on's own code may call LoadAddOn while it runs: keep the /msbt call's own answer.
        if name == "MSBTOptions" then
          MSBT_LOAD_MS, MSBT_LOAD_ANSWER, MSBT_LOAD_REASON = __msbtNow() - started, loaded, reason
          MSBT_LOAD_ERRORS = __msbtErrors() - errors
        end
        return loaded, reason
      end
    `, 0);
    const errorsBefore = boot.errors.length;
    const readsBeforeCall = reads.length;
    const slashStarted = performance.now();
    lua(boot, "SlashCmdList.MSBT('')", 0);
    const slashMs = performance.now() - slashStarted;
    const [loadMs, answer, reason] = lua(boot, "return MSBT_LOAD_MS, MSBT_LOAD_ANSWER, MSBT_LOAD_REASON", 3);
    assert.deepEqual([answer, reason], [1, undefined], "LoadAddOn answered 1 inside /msbt");
    assert.deepEqual(reads.slice(readsBeforeCall), [], "the call read nothing: every file came from the prefetch");
    assert.deepEqual(lua(boot, "return IsAddOnLoaded('MSBTOptions'), MSBTMainOptionsFrame and MSBTMainOptionsFrame:IsShown()", 2),
      [true, true], "the options window is open after the first /msbt");
    assert.deepEqual(lua(boot, "return table.concat(MSBT_LOD_LOADED, ',')"), ["MSBTOptions"], "ADDON_LOADED inside the call");
    assert.deepEqual(lua(boot, "return MSBT_LOAD_ERRORS"), [0], "no Lua error while LoadAddOn ran MSBTOptions");
    // 3.48 (12.10): Frame:CreateTitleRegion answers as Wow.exe's (MSBTOptionsMain.lua:160-163), so the window is built
    // whole — nothing raises any more.
    const errors = boot.errors.slice(errorsBefore).map((error) => `${error.file}:${error.line} ${error.message}`);
    assert.deepEqual(errors, [], "no Lua error from the load or the open");
    assert.deepEqual(lua(boot, `local region = MSBTMainOptionsFrame:GetTitleRegion()
      return region:GetObjectType(), region:GetWidth(), region:GetHeight()`, 3), ["Region", 525, 20],
    "the options window's title strip");
    t.diagnostic(`prefetch ${prefetchMs.toFixed(1)} ms, ${prefetchReads.length} files read `
      + `(${prefetchReads.reduce((sum, read) => sum + read.bytes, 0)} bytes); `
      + `LoadAddOn inside /msbt ${Number(loadMs).toFixed(1)} ms; whole first /msbt ${slashMs.toFixed(1)} ms; `
      + `LoadAddOn calls ${lua(boot, "return table.concat(MSBT_LOAD_CALLS, ' ')")[0]}; open errors ${JSON.stringify(errors)}`);
  } finally {
    boot.close();
  }
});

test("for comparison: the asynchronous load of MSBTOptions the loading window used to run", withMsbt, async (t) => {
  const { boot } = await msbtBoot();
  try {
    const started = performance.now();
    const result = await boot.loadAddon("MSBTOptions");
    const loadMs = performance.now() - started;
    assert.equal(result.ok, true, result.message);
    t.diagnostic(`asynchronous loadAddon(MSBTOptions) ${loadMs.toFixed(1)} ms (files read from the client inside it)`);
  } finally {
    boot.close();
  }
});
