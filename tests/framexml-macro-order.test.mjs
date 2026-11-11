import assert from "node:assert/strict";
import test from "node:test";

// 5.37 (11.11): the macro C API's positions in Wow.exe's order — within each set by name without case
// (0x00566240 qsorts with 0x00564a80, `_strnicmp`), account 1..N, character from 37.

const { FrameXmlMacroModel, createFrameXmlMemoryMacroStore } = await import("../dist/code/browser/framexml/FrameXmlMacro.js");

function model(macros) {
  const store = createFrameXmlMemoryMacroStore(macros);
  const instance = new FrameXmlMacroModel({ store });
  instance.attach({ now: () => 0, fire() { return 1; } });
  return { macros: instance, store };
}

test("positions are by name without case, not by slot", () => {
  const { macros } = model([
    { index: 1, name: "zeta", body: "/z" }, { index: 2, name: "Alpha", body: "/a" }, { index: 3, name: "beta", body: "/b" },
    { index: 37, name: "b", body: "/1" }, { index: 38, name: "A", body: "/2" },
  ]);
  assert.deepEqual([1, 2, 3].map((position) => macros.info(position)[0]), ["Alpha", "beta", "zeta"]);
  assert.deepEqual([37, 38].map((position) => macros.info(position)[0]), ["A", "b"]);
  assert.deepEqual(macros.counts(), [3, 2]);
  assert.equal(macros.indexByName("ZETA"), 3);
  assert.equal(macros.position(2), 1);
});

test("CreateMacro answers the new macro's place by name; EditMacro's rename moves it", () => {
  const { macros, store } = model([{ index: 1, name: "Mid", body: "/m" }]);
  assert.equal(macros.create("Aaa", 1, "/a", false), 1);
  assert.equal(store.list().find((macro) => macro.name === "Aaa").index, 2, "the lowest free slot");
  assert.equal(macros.edit(1, "Zzz", undefined, undefined), 2, "Aaa at 1 renamed: Mid, Zzz");
  assert.equal(macros.info(1)[0], "Mid");
});
