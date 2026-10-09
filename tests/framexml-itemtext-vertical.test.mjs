import assert from "node:assert/strict";
import test, { after } from "node:test";

// MPQ-backed: stock ItemTextFrame as the reader over the canned book and plaque — the real
// ItemTextFrame.lua draws the title, the SimpleHTML page, the page counter, the paper and the
// page buttons from FrameXmlItemText.ts's answers.
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
const { frameXmlItemTextGate } = await import("../dist/code/browser/framexml/FrameXmlItemTextOwner.js");
const { createFrameXmlNpcWindows } = await import("../dist/code/browser/framexml/FrameXmlGossipNpcWindows.js");
const controller = await import("../dist/code/browser/framexml/FrameXmlItemTextController.js");
const simpleHtml = await import("../dist/code/browser/ui/framexml_compat/FrameXmlSimpleHtml.js");
const decoder = new TextDecoder("utf-8");

async function load(seam = new CannedWorldSeam()) {
  const boot = new FrameXmlBoot({
    provider: { async read(path) { const data = await chain.read(path); return data ? decoder.decode(data) : undefined; } },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, exercise: true, screen: () => ({ width: 1365, height: 768 }),
  });
  await boot.load();
  return { boot, seam };
}

function lua(boot, code, results = 1) {
  const fn = boot.vm.compileFunction(code, "itemtext-test", []);
  assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
  try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
}

function renderer() {
  const elements = new Map();
  return {
    elementFor(frame) {
      if (!elements.has(frame)) {
        const attributes = new Map([["data-framexml-name", frame.name], ["data-framexml-type", frame.type]]);
        elements.set(frame, { dataset: {}, getAttribute: (name) => attributes.get(name) ?? null });
      }
      return elements.get(frame);
    },
  };
}

async function flush() {
  for (let round = 0; round < 3; round += 1) await Promise.resolve();
}

const newErrors = (boot, from) => JSON.stringify(boot.errors.slice(from).map((e) => `${e.file}:${e.line} ${e.message}`));

test("the reader: title, page 1 of a two-page parchment book, the page buttons, the close", withClient, async () => {
  const { boot, seam } = await load();
  const windows = createFrameXmlNpcWindows(seam, boot, renderer(), {});
  const release = windows.publish();
  try {
    assert.equal(windows.gates.itemText, true);
    const errors = boot.errorCount;
    assert.equal(frameXmlItemTextGate(seam, boot, renderer())?.frame.name, "ItemTextFrame", "the gate repeats cleanly");
    const world = seam.npc.itemText.world;
    world.open("item");
    await flush();
    const page = () => lua(boot, `return ItemTextFrame:IsShown() and 1 or 0, ItemTextTitleText:GetText(), ItemTextCurrentPage:GetText(),
      ItemTextPrevPageButton:IsShown() and 1 or 0, ItemTextNextPageButton:IsShown() and 1 or 0,
      ItemTextMaterialTopLeft:IsShown() and 1 or 0`, 6);
    assert.deepEqual(page(), [1, "Летопись каменщиков", "1", 0, 1, 0], "parchment keeps the frame's own paper");
    assert.match(String(lua(boot, "return ItemTextPageText:GetText()")[0]), /Давным-давно, когда Штормград/);
    boot.bridge.Click(boot.bridge.getFrame("ItemTextNextPageButton"));
    assert.deepEqual(page(), [1, "Летопись каменщиков", "2", 1, 0, 0]);
    assert.match(String(lua(boot, "return ItemTextPageText:GetText()")[0]), /собора/);
    boot.bridge.Click(boot.bridge.getFrame("ItemTextPrevPageButton"));
    assert.deepEqual(page().slice(2), ["1", 0, 1, 0]);
    assert.equal(controller.frameXmlItemTextOpen(), true);
    boot.bridge.Click(boot.bridge.getFrame("ItemTextCloseButton"));
    assert.deepEqual(lua(boot, "return ItemTextFrame:IsShown() and 1 or 0"), [0]);
    assert.equal(seam.itemText.reading, false, "CloseItemText forgot the reader");

    world.open("object");
    await flush();
    assert.deepEqual(lua(boot, `return ItemTextTitleText:GetText(), ItemTextMaterialTopLeft:IsShown() and 1 or 0,
      ItemTextMaterialTopLeft:GetTexture(), ItemTextCurrentPage:IsShown() and 1 or 0`, 4),
      ["Памятная плита", 1, "Interface\\ItemTextFrame\\ItemText-Stone-TopLeft", 0], "one stone page: no counter");
    controller.closeFrameXmlItemText();
    assert.deepEqual(lua(boot, "return ItemTextFrame:IsShown() and 1 or 0"), [0]);
    assert.equal(boot.errorCount, errors, newErrors(boot, errors));
  } finally {
    release();
    boot.close();
  }
  assert.equal(controller.frameXmlItemTextPublished(), false);
});

test("an HTML page keeps SimpleHTML's blocks: headers and paragraphs on their own lines, <BR/> a break", withClient, async () => {
  const { boot, seam } = await load();
  const windows = createFrameXmlNpcWindows(seam, boot, renderer(), {});
  const release = windows.publish();
  try {
    const errors = boot.errorCount;
    // ItemTextFrame_OnEvent's own call shape: "\n" .. ItemTextGetText() .. "\n\n".
    lua(boot, `ItemTextPageText:SetText("\\n<HTML><BODY>\\n<H1 align=\\"center\\">Глава первая</H1>\\n<P>Первая строка.</P><BR/>"
      .. "<P>Вторая &lt;строка&gt; &amp; конец.</P>\\n</BODY></HTML>\\n\\n")`, 0);
    // Since 3.35 the renderer draws the SimpleHTML page itself (framexml-simple-html.test.mjs); the
    // FontString mirror that stood in for it is gone, and the page parses into the client's blocks.
    assert.deepEqual(lua(boot, "return ItemTextPageTextWebClient == nil and 1 or 0"), [1], "no mirror painting the page twice");
    const [page] = lua(boot, "return ItemTextPageText:GetText()");
    assert.deepEqual(simpleHtml.parseFrameXmlSimpleHtml(page).map((block) => [block.level, block.align, block.text]), [
      [1, "CENTER", "Глава первая"], [0, "LEFT", "Первая строка."], [0, "LEFT", ""], [0, "LEFT", "Вторая <строка> & конец."],
    ]);
    assert.equal(boot.errorCount, errors, newErrors(boot, errors));
  } finally {
    release();
    boot.close();
  }
});
