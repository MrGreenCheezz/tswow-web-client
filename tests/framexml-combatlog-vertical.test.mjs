import assert from "node:assert/strict";
import test, { after } from "node:test";

// MPQ-backed 3.01: the client's own Blizzard_CombatLog loaded into the booted vertical (as the world
// mount's loading window does, FrameXmlCombatLogOwner.ts) over a combat log buffer — its
// ADDON_LOADED refills ChatFrame2 from CombatLogSetCurrentEntry/GetCurrentEntry/AdvanceEntry, and a
// COMBAT_LOG_EVENT prints one line — without a Lua error.
let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine", concurrency: false };
const { clientArchives } = await import("../tools/mpq.mjs");
const chain = clientDirectory ? await clientArchives(clientDirectory) : undefined;
after(() => chain?.close());

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { FrameXmlCombatLogBuffer } = await import("../dist/code/browser/framexml/FrameXmlCombatLog.js");
const { loadFrameXmlCombatLog, frameXmlCombatLogOwned } = await import("../dist/code/browser/framexml/FrameXmlCombatLogOwner.js");
const { CL } = await import("../dist/code/world/CombatEventModel.js");
const decoder = new TextDecoder("utf-8");

const ME = 0x10n;
const MOB = 0xf130000000000abcn;

function entry(buffer, event, { source = ME, dest = MOB, spellId = 0, time, fill = () => {} }) {
  const record = buffer.next();
  Object.assign(record, {
    event, source, dest, spellId, time,
    sourceName: source === ME ? "Тестовый" : "Кобольд", sourceFlags: source === ME ? 0x511 : 0xa48,
    destName: dest === ME ? "Тестовый" : "Кобольд", destFlags: dest === ME ? 0x511 : 0xa48,
  });
  fill(record);
  buffer.push(record);
  return record;
}

test("Blizzard_CombatLog loads after the session events, refills ChatFrame2 from the buffer and prints COMBAT_LOG_EVENT", withClient, async () => {
  const seam = new CannedWorldSeam();
  const buffer = new FrameXmlCombatLogBuffer({ spell: (id) => (id === 133 ? { name: "Огненный шар", schoolMask: 4 } : undefined) });
  Object.defineProperty(seam, "combatLog", { value: { buffer } });
  const now = Date.now() / 1000;
  entry(buffer, CL.SWING_DAMAGE, { time: now - 3, fill: (r) => { r.suffix = 0x10; r.n1 = 11; r.n3 = 1; } });
  entry(buffer, CL.SPELL_DAMAGE, { time: now - 2, spellId: 133, fill: (r) => { r.suffix = 0x10; r.n1 = 222; r.n3 = 4; } });
  entry(buffer, CL.SPELL_DAMAGE, { source: MOB, dest: ME, time: now - 1, spellId: 133, fill: (r) => { r.suffix = 0x10; r.n1 = 33; r.n3 = 4; } });
  const boot = new FrameXmlBoot({
    provider: { async read(path) { const data = await chain.read(path); return data ? decoder.decode(data) : undefined; } },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, exercise: true, screen: () => ({ width: 1365, height: 768 }),
  });
  try {
    await boot.load();
    const failures = () => boot.errors.map((failure) => `${failure.file}:${failure.line}: ${failure.message}`)
      .concat(boot.vm.errors.map(String));
    const before = failures();
    const messages = [];
    boot.vm.registerGlobal("message", (args) => { messages.push(String(args[0])); return []; });
    assert.equal(frameXmlCombatLogOwned(boot), false);
    const started = performance.now();
    assert.equal(await loadFrameXmlCombatLog(boot), true);
    const loadMs = performance.now() - started;
    assert.equal(frameXmlCombatLogOwned(boot), true, "the mirror switches off");
    assert.deepEqual(failures().slice(before.length), [], "no Lua error while loading and refiltering");
    assert.deepEqual(messages, []);
    // The refill is spread over frames (COMBATLOG_LIMIT_PER_FRAME, CombatLogUpdateFrame's OnUpdate).
    for (let step = 0; step < 6; step++) boot.bridge.tick(0.016);
    const frame = boot.bridge.getFrame("ChatFrame2");
    const lines = () => frame.messageFrame.messages.map((line) => line.text);
    const refilled = lines();
    assert.equal(refilled.length, 3, `three lines refilled: ${refilled.join(" | ")}`);
    assert.ok(refilled.some((line) => line.includes("222")) && refilled.some((line) => line.includes("33")) && refilled.some((line) => line.includes("11")));
    // The stock refill walks newest→oldest with AddMessage(..., addToTop) (Blizzard_CombatLog.lua:739-753),
    // so the window reads oldest first, as the entries happened (02.10: the bridge honours addToTop).
    assert.ok(refilled[0].includes("11") && refilled[1].includes("222") && refilled[2].includes("33"), refilled.join(" | "));
    // A new event, as FrameXmlCombatLogLive fires it: one more line.
    const added = entry(buffer, CL.SPELL_DAMAGE, { time: now, spellId: 133, fill: (r) => { r.suffix = 0x10; r.n1 = 4444; r.n3 = 4; } });
    const delivered = boot.pump.fire("COMBAT_LOG_EVENT", ...buffer.args(added));
    assert.ok(delivered >= 1, "COMBATLOG listens to COMBAT_LOG_EVENT");
    assert.ok(lines().at(-1).includes("4444"), lines().at(-1));
    assert.deepEqual(failures().slice(before.length), []);
    // Cost of one stock line (COMBAT_LOG_EVENT → CombatLog_OnEvent → AddMessage), measured, not asserted.
    const runs = 300;
    const t0 = performance.now();
    for (let index = 0; index < runs; index++) boot.pump.fire("COMBAT_LOG_EVENT", ...buffer.args(added));
    const perEvent = (performance.now() - t0) / runs;
    console.log(`Blizzard_CombatLog load + refill: ${loadMs.toFixed(1)} ms; one COMBAT_LOG_EVENT line: ${perEvent.toFixed(3)} ms`);
  } finally {
    boot.close?.();
  }
});
