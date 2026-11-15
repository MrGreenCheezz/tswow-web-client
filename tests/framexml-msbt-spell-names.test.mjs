import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test, { after } from "node:test";

// 3.43 (15.11, names10), where the defect showed: MikScrollingBattleText builds its spell-name tables from ids while it
// loads (MSBTMain.lua:102-108, MSBTProfiles.lua:63…, MSBTCooldowns.lua:40-43, through MikSBT.lua:106-110 GetSkillName)
// and prints «MSBT: Skill ID N has been removed by Blizzard.» for every id GetSpellInfo answers nil. In Wow.exe
// GetSpellInfo(id) answers any id at once (0x00540a30, Spell.dbc in memory). Booted here off the client's own add-on
// and the stock interface, with LiveWorldSeam's GetSpellInfo/GetSpellLink: without the dataset-wide table (the old
// behaviour, no `/dbc/spells` row cached at load) and with it (`/dbc/spell-info`, src/world/SpellInfoTable.ts).
let clientDirectory;
let dbc;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
  dbc = paths.dbcDirectory();
} catch {
  clientDirectory = undefined;
}
const available = clientDirectory !== undefined && dbc !== undefined
  && existsSync(join(clientDirectory, "Interface", "AddOns", "MikScrollingBattleText")) && existsSync(join(dbc, "Spell.dbc"));
const withMsbt = { skip: available ? false : "no MikScrollingBattleText in the client, or no dataset Spell.dbc", concurrency: false };

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { encodeSpellInfoTable, SpellInfoTable } = await import("../dist/code/world/SpellInfoTable.js");
const chain = available ? await (await import("../tools/mpq.mjs")).clientArchives(clientDirectory) : undefined;
after(() => chain?.close());
const decoder = new TextDecoder("utf-8");

// Prepended to MikSBT.lua (the add-on's first file) as it is read: every chat line the add-on prints is kept.
const CAPTURE = "do local add = DEFAULT_CHAT_FRAME.AddMessage; __NAMES10_LINES = {}; "
  + "DEFAULT_CHAT_FRAME.AddMessage = function(self, text, ...) __NAMES10_LINES[#__NAMES10_LINES + 1] = tostring(text); "
  + "return add(self, text, ...) end end ";

async function bootMsbt(spellInfoRow) {
  const live = new LiveWorldSeam({
    world: () => undefined, store: () => undefined, spell: () => undefined, spellInfoRow,
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  const seam = new CannedWorldSeam();
  // The by-id spell answers are LiveWorldSeam's (the page's); everything else stays canned.
  seam.spellInfo = (idOrName, rank) => live.spellInfo(idOrName, rank);
  seam.spellLink = (value, bookType) => live.spellLink(value, bookType);
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        const data = await chain.read(path);
        const source = data ? decoder.decode(data) : undefined;
        return source !== undefined && /mikscrollingbattletext[\\/]miksbt\.lua$/i.test(path) ? CAPTURE + source : source;
      },
    },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam,
    installedAddons: ["MikScrollingBattleText"], eagerAddons: ["MikScrollingBattleText"],
    screen: () => ({ width: 1365, height: 768 }),
  });
  await boot.load();
  assert.deepEqual(boot.addonResults.filter((result) => !result.ok).map((result) => result.message), [], "MSBT loads");
  const fn = boot.vm.compileFunction("return table.concat(__NAMES10_LINES or {}, '\\n')", "names10", []);
  const [text] = boot.vm.call(fn, [], 1);
  boot.vm.release(fn);
  const removed = String(text ?? "").split("\n").filter((line) => /has been removed by Blizzard/.test(line));
  return removed.map((line) => Number(/Skill ID (\d+)/.exec(line)?.[1]));
}

test("MSBT's «Skill ID … has been removed by Blizzard» lines go once GetSpellInfo answers any dataset id", withMsbt, async (t) => {
  const { loadSpellMetadata } = await import("../dist/code/gateway/SpellMetadata.js");
  const rows = await loadSpellMetadata(dbc);
  const table = SpellInfoTable.decode(encodeSpellInfoTable(rows.values()).slice().buffer);

  let started = performance.now();
  const before = await bootMsbt(() => undefined);
  const beforeMs = performance.now() - started;
  assert.ok(before.length > 0, "the old behaviour: ids nobody had asked /dbc/spells for answer nil");

  started = performance.now();
  const afterIds = await bootMsbt((id) => table.row(id));
  const afterMs = performance.now() - started;
  // What is left must be ids the dataset itself has no row for (then Wow.exe prints the line too).
  const present = afterIds.filter((id) => rows.has(id));
  assert.deepEqual(present, [], "no line for a spell the dataset has");
  t.diagnostic(`before: ${before.length} lines (${[...new Set(before)].sort((a, b) => a - b).join(", ")}); `
    + `after: ${afterIds.length} lines${afterIds.length ? ` (absent from the dataset: ${afterIds.join(", ")})` : ""}; `
    + `boots ${beforeMs.toFixed(0)} / ${afterMs.toFixed(0)} ms`);
});
