import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// 3.01 acceptance with a real consumer: MikScrollingBattleText's parser (MSBTParser.lua, the copy in the
// client's AddOns) hears COMBAT_LOG_EVENT_UNFILTERED as FrameXmlCombatLogLive builds it and turns a
// player's critical SPELL_DAMAGE into `eventType == "damage"`. Its gate (MSBTParser.lua:375) drops any
// event that is neither the player's nor about the player: the flags decide.
let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const msbt = clientDirectory ? join(clientDirectory, "Interface", "AddOns", "MikScrollingBattleText") : undefined;
const present = msbt ? await readFile(join(msbt, "MSBTParser.lua"), "utf8").then(() => true, () => false) : false;
const withMsbt = { skip: present ? false : "no MikScrollingBattleText in the client", concurrency: false };
const { clientArchives } = await import("../tools/mpq.mjs");
const chain = present ? await clientArchives(clientDirectory) : undefined;
after(() => chain?.close());

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { FrameXmlCombatLogBuffer } = await import("../dist/code/browser/framexml/FrameXmlCombatLog.js");
const { CL } = await import("../dist/code/world/CombatEventModel.js");
const decoder = new TextDecoder("utf-8");

test("MSBT parses the player's critical SPELL_DAMAGE; an outsider's is dropped by its flags", withMsbt, async () => {
  const seam = new CannedWorldSeam();
  const boot = new FrameXmlBoot({
    provider: { async read(path) { const data = await chain.read(path); return data ? decoder.decode(data) : undefined; } },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, exercise: true, screen: () => ({ width: 1365, height: 768 }),
  });
  try {
    await boot.load();
    const playerGuid = boot.vm.execute("__fxMsbtPlayer = UnitGUID('player')", "@msbt-guid");
    assert.ok(playerGuid.ok);
    const player = boot.vm.getGlobal("__fxMsbtPlayer");
    assert.match(String(player), /^0x[0-9a-f]{16}$/);
    // Loaded bare here, not as a client add-on: its TOC version is what the mount's add-on list would answer.
    boot.vm.execute(`local get = GetAddOnMetadata
      GetAddOnMetadata = function(name, field)
        if name == "MikScrollingBattleText" and field == "Version" then return "5.4.78" end
        return get(name, field)
      end`, "@msbt-meta");
    for (const file of ["MikSBT.lua", "MSBTParser.lua"]) {
      const source = await readFile(join(msbt, file), "utf8");
      const result = boot.vm.execute(source, `@MikScrollingBattleText/${file}`);
      assert.ok(result.ok, `${file}: ${result.error ?? ""}`);
    }
    const setup = boot.vm.execute(`
      __fxMsbt = {}
      MikSBT.Parser.RegisterHandler(function(e)
        __fxMsbt[#__fxMsbt + 1] = table.concat({ tostring(e.eventType), tostring(e.amount), tostring(e.isCrit),
          tostring(e.skillName), tostring(e.sourceUnit), tostring(e.recipientUnit) }, "|")
      end)
      MikSBT.Parser.Enable()
    `, "@msbt-setup");
    assert.ok(setup.ok, setup.error);
    const buffer = new FrameXmlCombatLogBuffer({ spell: (id) => (id === 133 ? { name: "Огненный шар", schoolMask: 4 } : undefined) });
    const fire = (source, sourceFlags) => {
      const entry = buffer.next();
      Object.assign(entry, {
        event: CL.SPELL_DAMAGE, source, dest: 0xf130000000000abcn, spellId: 133, time: Date.now() / 1000,
        sourceName: "Тестовый", sourceFlags, destName: "Кобольд", destFlags: 0xa48,
        suffix: 0x10, n1: 512, n3: 4, bits: 1,
      });
      buffer.push(entry);
      return boot.pump.fire("COMBAT_LOG_EVENT_UNFILTERED", ...buffer.args(entry));
    };
    const playerBig = BigInt(String(player));
    assert.ok(fire(playerBig, 0x511) >= 1, "MSBT's event frame listens");
    fire(0x21n, 0x548);
    boot.vm.execute("__fxMsbtOut = table.concat(__fxMsbt, ';')", "@msbt-out");
    assert.equal(boot.vm.getGlobal("__fxMsbtOut"), "damage|512|1|Огненный шар|player|nil",
      "one parser event: the player's; the outsider hitting an outsider is not parsed");
  } finally {
    boot.close?.();
  }
});
