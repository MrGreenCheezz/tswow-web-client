import assert from "node:assert/strict";
import test from "node:test";

/**
 * The same fake document the widget tests use, for the same reason: the «Пакеты» tab is a handful
 * of nodes and the only way to know it builds them is to build them.
 *
 * It answers what `PacketsTab.ts` uses and nothing else, so anything that file starts using shows
 * up here as a crash rather than as a pane that quietly stays empty.
 */
function fakeDocument() {
  const make = (tag) => {
    const node = {
      tagName: tag.toUpperCase(),
      children: [],
      dataset: {},
      className: "",
      textContent: "",
      hidden: false,
      append(...nodes) { node.children.push(...nodes); },
      replaceChildren(...nodes) { node.children = [...nodes]; },
    };
    return node;
  };
  return { createElement: make, body: make("body") };
}

globalThis.document = fakeDocument();

const { CustomPacketRegistry } = await import("../dist/code/world/CustomPacketRegistry.js");
const { encodeCustom } = await import("../dist/code/world/CustomCodec.js");
const {
  formatCustomValue, formatHex, packetsChanged, packetsView,
} = await import("../dist/code/browser/ui/PacketsModel.js");
const { drawPacketsTab } = await import("../dist/code/browser/ui/PacketsTab.js");

const shopState = {
  name: "shop.State",
  opcode: 4001,
  direction: "in",
  fields: [{ name: "gold", type: "u32" }, { name: "title", type: "string" }],
};

test("a decoded value is printed without JSON.stringify choking on the bigint in it", () => {
  // `u64` and `i64` decode to bigint by design, and `JSON.stringify` answers one with a TypeError.
  // A diagnostics window that throws while describing the packet it was opened to describe is
  // worse than no window, so this printer is written out rather than borrowed.
  assert.equal(formatCustomValue({ guid: 0xdeadbeefcafen, gold: 12 }), "{guid: 244837814094590n, gold: 12}");
  assert.equal(formatCustomValue([1, 2, 3]), "[1, 2, 3]");
  assert.equal(formatCustomValue([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), "[1, 2, 3, 4, 5, 6, 7, 8, …ещё 2]");
  assert.equal(formatCustomValue("Лавка"), '"Лавка"');
  assert.equal(formatCustomValue(undefined), "—");
  assert.equal(formatCustomValue({ a: { b: { c: { d: 1 } } } }), "{a: {b: {c: …}}}");
  assert.equal(formatHex(Uint8Array.of(0xde, 0xad, 0xbe, 0xef)), "de ad be ef");
  assert.equal(formatHex("00010203", 2), "00 01 …ещё 2 Б");
});

test("the packets view names a claimed opcode and shows hex for one nothing declared", () => {
  const registry = new CustomPacketRegistry();
  registry.define([{ ...shopState, fields: [{ name: "gold", type: { kind: "u32" } }] }], "shop");
  registry.deliver(4001, encodeCustom({ ...shopState, direction: "both", fields: [{ name: "gold", type: { kind: "u32" } }] }, { gold: 12 }));
  registry.deliver(9000, Uint8Array.of(0xde, 0xad));

  const view = packetsView({
    opcodes: registry.summary(),
    transportWarnings: [{ kind: "reader-skew", opcode: 4001, totalFrags: 2, bytes: 40, text: "склейка" }],
    problems: registry.problems,
    files: [{ module: "shop", source: "module", file: "shop.json", sha1: "abcdef1234567890", count: 1 }],
    loadProblems: ["shop/shop.json: что-то не так"],
  });

  assert.equal(view.status, "Пакеты модулей: 1 файлов схем · опкодов 2 · принято 2 · без схемы 1");
  assert.equal(view.statusKind, "error", "a load problem colours the line, or nobody looks for it");
  assert.deepEqual(view.modules, ["shop/shop.json · 1 сообщ. · module · abcdef12", "shop/shop.json: что-то не так"]);
  assert.deepEqual(view.warnings, ["склейка"]);

  const [claimed, unclaimed] = view.rows;
  assert.equal(claimed.title, "4001 · shop.State · shop · in");
  assert.equal(claimed.counts, "принято 1 (4 Б) · разобрано 1");
  assert.equal(claimed.body, "{gold: 12}");
  assert.equal(claimed.kind, "message");
  // No schema, so the bytes are the whole of what can be said about it — which is exactly what a
  // livescript already sending on an opcode whose JSON is not written yet looks like.
  assert.equal(unclaimed.title, "9000 · схемы нет");
  assert.equal(unclaimed.body, "de ad");
  assert.equal(unclaimed.kind, "unclaimed");
});

test("a schema that has carried nothing yet is still a row, and one this client only sends is not «схемы нет»", () => {
  const sent = [];
  const registry = new CustomPacketRegistry({ send: (opcode, body) => sent.push([opcode, body.byteLength]) });
  registry.define([
    { name: "shop.State", opcode: 4001, direction: "in", fields: [{ name: "gold", type: { kind: "u32" } }] },
    { name: "shop.Buy", opcode: 4002, direction: "out", fields: [{ name: "entry", type: { kind: "u32" } }] },
    { name: "shop.Ping", opcode: 4003, direction: "out", fields: [{ name: "entry", type: { kind: "u32" } }] },
  ], "shop");
  registry.send("shop.Buy", { entry: 60001 });
  // And an outbound message the server sent back: named, counted, and reported as a direction that
  // is wrong rather than as a number nobody knows.
  registry.deliver(4003, Uint8Array.of(1, 0, 0, 0));

  const view = packetsView({
    opcodes: registry.summary(), transportWarnings: [], problems: registry.problems, files: [], loadProblems: [],
  });
  const rows = new Map(view.rows.map((row) => [row.opcode, row]));
  // Sent and never received. Nothing here can *decode* it — that is what "out" means — but the
  // module owns the number, so painting it in the no-schema colour under a title that names its
  // schema said two opposite things on one line.
  assert.equal(rows.get(4002).title, "4002 · shop.Buy · shop · out");
  assert.equal(rows.get(4002).counts, "отправлено 1 (4 Б)");
  assert.equal(rows.get(4002).kind, "message");
  assert.equal(rows.get(4003).kind, "error");
  // «без схемы» is the count of opcodes nobody owns, and both of these have an owner — a status
  // line asking «can anything decode it» instead would report a loaded module's message as
  // schemaless in the very line that says how many schemas loaded.
  assert.equal(view.status, "Пакеты модулей: 0 файлов схем · опкодов 3 · принято 1 · ошибок 1");
  // Loaded and silent, which is what every schema is until the first packet: the first question a
  // module author asks is «did the client take my file, and on which number», and the answer used
  // to be nowhere on the screen.
  assert.equal(rows.get(4001).title, "4001 · shop.State · shop · in");
  assert.equal(rows.get(4001).counts, "тишина");
  assert.equal(rows.get(4001).kind, "message");
  assert.equal(rows.get(4001).body, "—");
});

test("the pane redraws when one of the four numbers behind it moves, and not otherwise", () => {
  const drawn = { revision: 3, warnings: 1, files: 2, problems: 0 };
  assert.equal(packetsChanged(undefined, drawn), true, "nothing has been drawn yet");
  assert.equal(packetsChanged(drawn, { ...drawn }), false, "a frame where nothing happened costs one comparison");
  for (const key of ["revision", "warnings", "files", "problems"]) {
    assert.equal(packetsChanged(drawn, { ...drawn, [key]: drawn[key] + 1 }), true, `${key} moved and nobody noticed`);
  }
});

test("the tab draws one block per opcode, and drawing twice replaces rather than appends", () => {
  const hosts = {
    status: document.createElement("p"),
    modules: document.createElement("div"),
    list: document.createElement("div"),
    warnings: document.createElement("div"),
  };
  const view = {
    status: "Пакеты модулей: 1 файлов схем",
    statusKind: "success",
    modules: ["shop/shop.json · 1 сообщ."],
    rows: [
      { opcode: 4001, title: "4001 · shop.State", counts: "принято 1", body: "{gold: 12}", kind: "message" },
      { opcode: 9000, title: "9000 · схемы нет", counts: "принято 1", body: "de ad", kind: "unclaimed" },
    ],
    warnings: ["склейка"],
  };

  drawPacketsTab(hosts, view);
  assert.equal(hosts.status.className, "success");
  assert.equal(hosts.status.textContent, "Пакеты модулей: 1 файлов схем");
  assert.equal(hosts.modules.children.length, 1);
  assert.equal(hosts.list.children.length, 2);
  const [first] = hosts.list.children;
  assert.equal(first.className, "custom-packet custom-packet-message");
  assert.equal(first.dataset.opcode, "4001");
  // Three lines: what it is, whether anything arrived, and what it arrived as. Only the last wraps.
  assert.deepEqual(first.children.map((child) => child.textContent), ["4001 · shop.State", "принято 1", "{gold: 12}"]);
  assert.equal(hosts.list.children[1].className, "custom-packet custom-packet-unclaimed");
  assert.equal(hosts.warnings.children[0].className, "error");

  drawPacketsTab(hosts, { ...view, rows: [view.rows[0]] });
  assert.equal(hosts.list.children.length, 1, "a second draw replaces the blocks rather than adding another set");
});
