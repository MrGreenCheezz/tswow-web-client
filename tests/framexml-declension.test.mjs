import assert from "node:assert/strict";
import test, { after } from "node:test";

// The ruRU client's `|3-N(word)` declension (FrameXmlDeclension.ts, ported from Wow.exe 12340): the
// escape pass, the word lookup order, the 55-rule/71-row engine behind `DeclineName`, the
// DeclinedWord/DeclinedWordCases dictionary, and the renderer redrawing strings once it arrives.
// The MPQ-backed part reads the owner's client and skips without one.

const D = await import("../dist/code/browser/ui/framexml_compat/FrameXmlDeclension.js");
const { parseFrameXmlText, plainFrameXmlText } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlText.js");
const { FrameXmlUiBridge } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlRuntime.js");
const { FrameXmlDomRenderer } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlDomRenderer.js");

let clientDirectory;
try {
  clientDirectory = (await import("../tools/paths.mjs")).clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine" };
const chain = clientDirectory ? await (await import("../tools/mpq.mjs")).clientArchives(clientDirectory) : undefined;
after(() => {
  D.setFrameXmlDeclensionSource(undefined);
  chain?.close();
});

/** A WDBC file: `rows` of uint32/string fields, strings interned into the block. */
function wdbc(rows) {
  const fields = rows[0].length;
  const strings = [0];
  const offsets = new Map([["", 0]]);
  const encoder = new TextEncoder();
  const intern = (text) => {
    if (!offsets.has(text)) {
      offsets.set(text, strings.length);
      strings.push(...encoder.encode(text), 0);
    }
    return offsets.get(text);
  };
  const values = rows.map((row) => row.map((value) => (typeof value === "string" ? intern(value) : value)));
  const bytes = new Uint8Array(20 + rows.length * fields * 4 + strings.length);
  const view = new DataView(bytes.buffer);
  bytes.set([0x57, 0x44, 0x42, 0x43]);
  view.setUint32(4, rows.length, true);
  view.setUint32(8, fields, true);
  view.setUint32(12, fields * 4, true);
  view.setUint32(16, strings.length, true);
  values.forEach((row, r) => row.forEach((value, f) => view.setUint32(20 + (r * fields + f) * 4, value, true)));
  bytes.set(strings, 20 + rows.length * fields * 4);
  return bytes;
}

test("the rule engine declines by the longest ending, capitalises, and knows its three sets", () => {
  D.setFrameXmlDeclensionSource(undefined);
  // Feminine -а: rule 32, suffix row 44.
  assert.deepEqual(D.declineFrameXmlName("Аэлинда", 2), ["Аэлинды", "Аэлинде", "Аэлинду", "Аэлиндой", "Аэлинде"]);
  // No ending matches: the masculine default, rule 35 → row 47.
  assert.deepEqual(D.declineFrameXmlName("Артас", 2), ["Артаса", "Артасу", "Артаса", "Артасом", "Артасе"]);
  // -й after a vowel, first rule of the two equal-length ones (gender 0) wins for gender 2.
  assert.deepEqual(D.declineFrameXmlName("Николай", 2), ["Николая", "Николаю", "Николая", "Николаем", "Николае"]);
  // Gender filters the rules: the feminine -ай rule's set 0 is row 0, which declines nothing.
  assert.deepEqual(D.declineFrameXmlName("Николай", 1), Array(5).fill("Николай"));
  // The executable's own case mapping: everything lowered, then the first letter raised.
  assert.deepEqual(D.declineFrameXmlName("АРТАС", 2), ["Артаса", "Артасу", "Артаса", "Артасом", "Артасе"]);
  // -ок with a fleeting vowel (rule 3, row 2) and indeclinable -о (rule 24, row 0).
  assert.deepEqual(D.declineFrameXmlName("Волчок", 2), ["Волчка", "Волчку", "Волчка", "Волчком", "Волчке"]);
  assert.deepEqual(D.declineFrameXmlName("Бордо", 2), Array(5).fill("Бордо"));
  // Rule 32's sets are (44, 0, 71): the second declines nothing, the third does not exist, and a
  // set out of range answers nothing either.
  assert.deepEqual(D.declineFrameXmlName("Аэлинда", 2, 1), Array(5).fill("Аэлинда"));
  assert.equal(D.declineFrameXmlName("Аэлинда", 2, 2), undefined);
  assert.equal(D.declineFrameXmlName("Аэлинда", 2, 3), undefined);
  assert.equal(D.frameXmlDeclensionSetCount("Николай", 0), 2);
  assert.equal(D.frameXmlDeclensionSetCount("Аэлинда", 2), 2);
  // Lua's argument mapping: UnitSex 2/3/1 → 0/1/2, 1-based sets, five nils when there is none.
  assert.deepEqual(D.frameXmlLuaDeclineName("Николай", 3, 1), Array(5).fill("Николай"));
  assert.deepEqual(D.frameXmlLuaDeclineName("Николай", 2, 1), D.declineFrameXmlName("Николай", 0, 0));
  assert.deepEqual(D.frameXmlLuaDeclineName("Аэлинда", 2, 3), Array(5).fill(undefined));
  assert.equal(D.frameXmlLuaDeclensionSetCount("Николай", 2), 2);
});

test("the |3 pass declines each escape in place, the client's way, with and without escapes inside", () => {
  D.setFrameXmlDeclensionSource(undefined);
  const expand = D.expandFrameXmlDeclension;
  assert.equal(expand("Заметка о |3-5(Аэлинда):"), "Заметка о Аэлинде:");
  assert.equal(expand("Предложить обмен |3-2(Джайна)?"), "Предложить обмен Джайне?");
  assert.equal(expand("Вы следуете за |3-4(Артас)."), "Вы следуете за Артасом.");
  // Cases outside 1–5 come only from the dictionary; without one the word stays.
  assert.equal(expand("Человек, |3-6(Паладин) 69-го уровня"), "Человек, Паладин 69-го уровня");
  assert.equal(expand("|3-0(Артас)"), "Артас");
  // A word that does not open with a Cyrillic letter is left alone.
  assert.equal(expand("|3-1(Smith) и |3-1(123)"), "Smith и 123");
  // A coloured or linked name keeps its escapes and only the name is declined.
  assert.equal(expand("|3-1(|cffffd200Кролик|r) убегает"), "|cffffd200Кролика|r убегает");
  assert.equal(expand("|3-2(|Hplayer:Тралл|h[Тралл]|h)"), "|Hplayer:Тралл|h[Траллу]|h");
  // `||` is an escaped pipe; `|3` and a digit is text; an unterminated escape runs to the end.
  assert.equal(expand("a||3-1(Артас)"), "a||3-1(Артас)");
  assert.equal(expand("|35(Артас)"), "|35(Артас)");
  assert.equal(expand("|3-2(Артас"), "Артасу");
  // No nesting: the word ends at the first `)`.
  assert.equal(expand("|3-1(Артас (Король-лич))"), "Артас (король-лича)");
  // Without the dash the `3` itself is the case.
  assert.equal(expand("|3(Артас)"), "Артаса");
  // A `Name-Realm` word: the realm is the rule engine's too when no name cache knows the name.
  assert.equal(expand("|3-3(Аэлинда-Гордунни)"), "Аэлинда-гордунни");
  // Other escapes pass through for the display parser.
  assert.deepEqual(parseFrameXmlText("|cffff0000|3-2(Джайна)|r"), [{ text: "Джайне", color: "#ff0000ff" }]);
  assert.equal(plainFrameXmlText("Заметка о |3-5(Аэлинда):"), "Заметка о Аэлинде:");
});

test("the dictionary and the name caches answer before the rules, as Wow.exe asks them", () => {
  const words = wdbc([[10, "Огонь"], [11, "Паладин"], [12, "Пустое"]]);
  const cases = wdbc([
    [1, 10, 1, "Огня"], [2, 10, 2, "Огню"], [3, 10, 6, "урона от огня"],
    [4, 11, 6, "паладин"],
  ]);
  const lookup = D.frameXmlDeclinedWordsFromDbc(words, cases);
  assert.equal(lookup("Огонь", 6), "урона от огня");
  assert.equal(lookup("Огонь", 2), "Огню");
  assert.equal(lookup("Огонь", 5), null, "listed, but no row for the case");
  assert.equal(lookup("Пустое", 1), undefined, "a word without rows is not in the client's table");
  assert.equal(lookup("огонь", 1), undefined, "the match is exact (strncmp)");
  D.setFrameXmlDeclensionSource({
    word: lookup,
    name: (name) => (name === "Аэлинда" ? ["Аэлинды", "Аэлинде", "Аэлинду", "Аэлиндой", "Аэлинде!"] : undefined),
  });
  try {
    const expand = D.expandFrameXmlDeclension;
    assert.equal(expand("%d - %d ед. |3-6(Огонь)"), "%d - %d ед. урона от огня");
    assert.equal(expand("|3-6(Паладин)"), "паладин");
    // Listed without the case: kept as written, the rules are not asked.
    assert.equal(expand("|3-3(Огонь)"), "Огонь");
    assert.equal(expand("|3-1(Пустое)"), "Пустого", "a listed word without rows goes to the rules (-ое)");
    // The name cache comes first for cases 1–5, and for the name part of `Name-Realm`.
    assert.equal(expand("Заметка о |3-5(Аэлинда):"), "Заметка о Аэлинде!:");
    assert.equal(expand("|3-5(Аэлинда-Гордунни)"), "Аэлинде!-Гордунни");
    assert.equal(expand("|3-6(Аэлинда)"), "Аэлинда");
  } finally {
    D.setFrameXmlDeclensionSource(undefined);
  }
  assert.throws(() => D.frameXmlDeclinedWordsFromDbc(new Uint8Array(8), cases), /not a WDBC file/);
});

test("the client's own dictionary gives the special cases, and the rules agree with it on plain words", withClient, async () => {
  const lookup = D.frameXmlDeclinedWordsFromDbc(
    new Uint8Array(await chain.read("DBFilesClient\\DeclinedWord.dbc")),
    new Uint8Array(await chain.read("DBFilesClient\\DeclinedWordCases.dbc")),
  );
  D.setFrameXmlDeclensionSource({ word: lookup });
  try {
    const expand = D.expandFrameXmlDeclension;
    assert.equal(expand("%d - %d ед. |3-6(Огонь)"), "%d - %d ед. урона от огня");
    assert.equal(expand("Человек, |3-6(Паладин) 69-го уровня"), "Человек, паладин 69-го уровня");
    assert.equal(expand("|cffffff00|3-8(Штормград) нападению!|r"), "|cffffff00Штормград подвергается нападению!|r");
    assert.equal(expand("Недостаточно |3-6(Мана)"), "Недостаточно маны");
  } finally {
    D.setFrameXmlDeclensionSource(undefined);
  }
  // Every single Cyrillic word the dictionary lists in all five cases, against the rule engine
  // (first letter's case aside): the tables read out of the executable decline nine in ten of
  // them exactly as Blizzard's list does (3,115 of 3,469 measured on this client).
  const bytes = new Uint8Array(await chain.read("DBFilesClient\\DeclinedWord.dbc"));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(4, true);
  const base = 20 + count * 8;
  const decoder = new TextDecoder();
  let compared = 0;
  let agreed = 0;
  for (let index = 0; index < count; index += 1) {
    const start = base + view.getUint32(20 + index * 8 + 4, true);
    let end = start;
    while (bytes[end] !== 0) end += 1;
    const word = decoder.decode(bytes.subarray(start, end));
    if (!/^[Ѐ-ӿ]+$/.test(word)) continue;
    const listed = [1, 2, 3, 4, 5].map((grammaticalCase) => lookup(word, grammaticalCase));
    if (listed.some((form) => typeof form !== "string")) continue;
    compared += 1;
    const ruled = D.declineFrameXmlName(word, 2, 0);
    if (ruled.every((form, index) => form.toLowerCase() === listed[index].toLowerCase())) agreed += 1;
  }
  assert.ok(compared > 3000, `${compared} words compared`);
  assert.ok(agreed / compared > 0.85, `${agreed} of ${compared} agree`);
});

function fakeDocument() {
  const doc = { createElement: (tag) => make(tag), createElementNS: (_namespace, tag) => make(tag) };
  function make(tag) {
    const attributes = new Map();
    const style = {
      setProperty(name, value) { this[name] = String(value); },
      removeProperty(name) { delete this[name]; },
    };
    const node = {
      ownerDocument: doc, tagName: tag.toUpperCase(), children: [], parentElement: undefined, style,
      hidden: false, className: "", textContent: "", value: "", disabled: false,
      classList: { add() {} },
      addEventListener() {},
      setAttribute(name, value) { attributes.set(name, String(value)); },
      getAttribute(name) { return attributes.get(name) ?? null; },
      removeAttribute(name) { attributes.delete(name); },
      append(...children) { for (const child of children) { child.parentElement = node; node.children.push(child); } },
      remove() {
        const index = node.parentElement?.children.indexOf(node) ?? -1;
        if (index >= 0) node.parentElement.children.splice(index, 1);
        node.parentElement = undefined;
      },
    };
    return node;
  }
  doc.head = make("head");
  return doc;
}

test("a drawn string is declined again when the host installs the dictionary", () => {
  D.setFrameXmlDeclensionSource(undefined);
  globalThis.document = fakeDocument();
  const bridge = new FrameXmlUiBridge();
  const loaded = bridge.loadAddon(`<Ui><Frame name="Root"><Size x="200" y="40"/>
    <Layers><Layer><FontString name="Header" text="Урон: |3-6(Огонь)"/></Layer></Layers>
  </Frame></Ui>`);
  const renderer = new FrameXmlDomRenderer(document.createElement("section"), { bridge });
  try {
    renderer.mount(loaded.roots);
    const element = renderer.elementFor(bridge.getFrame("Header"));
    assert.equal(element.textContent, "Урон: Огонь");
    D.setFrameXmlDeclensionSource({ word: (word, grammaticalCase) =>
      (word === "Огонь" && grammaticalCase === 6 ? "урона от огня" : undefined) });
    // Nothing about the string changed, so nothing redraws it by itself.
    bridge.touch();
    assert.equal(element.textContent, "Урон: Огонь");
    assert.equal(renderer.refreshDeclinedText(), 1);
    assert.equal(element.textContent, "Урон: урона от огня");
  } finally {
    D.setFrameXmlDeclensionSource(undefined);
    renderer.destroy();
  }
});
