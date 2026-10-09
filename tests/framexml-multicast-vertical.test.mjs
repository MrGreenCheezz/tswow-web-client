import assert from "node:assert/strict";
import test, { after } from "node:test";

// MPQ-backed 3.07: the stock MultiCastActionBarFrame.xml in the vertical over a multi-cast model —
// four slots with spells and totem items show the bar (MultiCastActionBarFrame.lua:300-358); no
// spells, or no totem item, keep it hidden; SetMultiCastSpell from the flyout reaches the model with
// the button's action; no Lua error.
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
const decoder = new TextDecoder("utf-8");

// Searing (fire), Stoneskin (earth), Healing Stream (water), Windfury (air); Call of the Elements.
const LISTS = { 1: [3599], 2: [8071], 3: [5394], 4: [8512] };

function model({ spells = true, items = true } = {}) {
  const calls = [];
  return {
    calls,
    totemSpells: (slot) => (spells ? LISTS[((slot - 1) & 3) + 1] : []),
    setMultiCastSpell: (action, spellId) => calls.push(["set", action, spellId]),
    hasTotemItem: () => items,
    isSpellKnown: (id) => spells && (id === 66842 || Object.values(LISTS).flat().includes(id)),
    castSpellById: (id) => calls.push(["cast", id]),
    isCurrentSpell: () => false,
  };
}

async function booted(multiCast) {
  const seam = new CannedWorldSeam();
  Object.defineProperty(seam, "multiCast", { value: multiCast });
  const boot = new FrameXmlBoot({
    provider: { async read(path) { const data = await chain.read(path); return data ? decoder.decode(data) : undefined; } },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, exercise: true, screen: () => ({ width: 1365, height: 768 }),
  });
  await boot.load();
  const failures = () => boot.errors.map((failure) => `${failure.file}:${failure.line}: ${failure.message}`)
    .concat(boot.vm.errors.map(String));
  return { boot, failures };
}

function lua(boot, code, results = 1) {
  const fn = boot.vm.compileFunction(code, "multicast-test", []);
  assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
  try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
}

test("four slots with spells and totems: the bar shows four slot buttons; the flyout sets an action", withClient, async () => {
  const multiCast = model();
  const { boot, failures } = await booted(multiCast);
  try {
    const before = failures();
    assert.ok(boot.bridge.getFrame("MultiCastActionBarFrame"), "the stock frame is in the vertical");
    boot.pump.fire("UPDATE_MULTI_CAST_ACTIONBAR");
    assert.deepEqual(lua(boot, "return MultiCastActionBarFrame.numActiveSlots, HasMultiCastActionBar() and 1 or 0", 2), [4, 1]);
    for (let index = 1; index <= 4; index++) {
      assert.deepEqual(lua(boot, `return MultiCastSlotButton${index}:IsShown() and 1 or 0`), [1], `slot ${index}`);
    }
    assert.deepEqual(lua(boot, "return select('#', GetMultiCastTotemSpells(6)), (GetMultiCastTotemSpells(6))", 2), [1, 8071],
      "action id 6 folds onto earth (0x005a8330)");
    lua(boot, "SetMultiCastSpell(134, 8071)", 0);
    assert.deepEqual(multiCast.calls, [["set", 134, 8071]]);
    assert.deepEqual(failures().slice(before.length), [], "no Lua error");
  } finally {
    boot.close?.();
  }
});

test("no totem spells: hidden; no totem item: only the slots with a totem down show", withClient, async () => {
  for (const options of [{ spells: false }, { items: false }]) {
    const { boot, failures } = await booted(model(options));
    try {
      const before = failures();
      boot.pump.fire("UPDATE_MULTI_CAST_ACTIONBAR");
      // The canned world has totems down; a slot with one answers its own GetTotemInfo (true).
      const [active] = lua(boot, "local n = 0 for s = 1, 4 do if GetTotemTimeLeft(s) > 0 then n = n + 1 end end return n");
      const expected = options.spells === false ? 0 : active;
      assert.ok(options.spells === false || active < 4, "the canned world leaves some slot empty");
      assert.deepEqual(lua(boot, "return MultiCastActionBarFrame.numActiveSlots, HasMultiCastActionBar() and 1 or 0", 2),
        [expected, expected > 0 ? 1 : 0], JSON.stringify(options));
      assert.deepEqual(failures().slice(before.length), []);
    } finally {
      boot.close?.();
    }
  }
});
