import assert from "node:assert/strict";
import test from "node:test";

let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine" };

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { CannedWorldSeam, CANNED_ACTION_BAR } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { formatClientTemplate } = await import("../dist/code/browser/glue/GlueWidgets.js");

const decoder = new TextDecoder("utf-8");

function close(actual, expected, message) {
  assert.ok(actual, `${message}: no colour`);
  for (const channel of ["r", "g", "b"]) {
    assert.ok(Math.abs(actual[channel] - expected[channel]) < 1e-6,
      `${message}: ${channel} ${actual[channel]} vs ${expected[channel]}`);
  }
}

test("client templates with positional arguments format the way the original does", () => {
  assert.equal(formatClientTemplate("%2$s, |3-6(%3$s) %1$s-го уровня", "80", "Человек", "Воин"),
    "Человек, |3-6(Воин) 80-го уровня");
  assert.equal(formatClientTemplate("Уровень %s (%s)", "??", "Гуманоид"), "Уровень ?? (Гуманоид)");
  assert.equal(formatClientTemplate("%d%%", 12.7), "12%");
});

test("GameTooltip keeps the original's colours, double lines, links and unit lines", withClient, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const chain = await clientArchives(clientDirectory);
  const provider = {
    async read(path) {
      const data = await chain.read(path);
      return data ? decoder.decode(data) : undefined;
    },
  };
  const items = new Map([[19019, {
    title: "Громовая Ярость", quality: 5,
    lines: [
      { text: "+5 к ловкости", tone: "stat" },
      { text: "Если на персонаже: шанс поразить молнией.", tone: "spell" },
      { text: "Требуется уровень 60", tone: "unmet" },
      { text: "«Благословенный клинок Искателя Ветра»", tone: "flavour" },
      { text: "", runs: [{ text: "красный", color: "#ff2020" }, { text: " и обычный" }] },
    ],
    footer: ["Щелкните правой кнопкой мыши, чтобы надеть"],
  }]]);
  const seam = new CannedWorldSeam(CANNED_ACTION_BAR);
  const boot = new FrameXmlBoot({
    provider, locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam,
    screen: () => ({ width: 1024, height: 768 }), exercise: false,
    gameTooltipAdapter: {
      inventoryItem: () => undefined,
      containerItem: () => undefined,
      item: (entry) => items.get(entry),
      spell: () => undefined,
    },
  });
  const run = (source, results = 0) => {
    const chunk = boot.vm.compileFunction(source, "@tooltip-style", []);
    assert.ok(chunk, `compiles: ${source}`);
    try { return boot.vm.call(chunk, [], results); } finally { boot.vm.release(chunk); }
  };
  const line = (side, index) => boot.bridge.getFrame(`GameTooltipText${side}${index}`);
  try {
    await boot.load();
    const tooltip = boot.bridge.getFrame("GameTooltip");
    assert.ok(tooltip);

    run(`GameTooltip:SetOwner(UIParent, "ANCHOR_NONE")
      GameTooltip:SetText("Заголовок", 1, 0.82, 0)
      GameTooltip:AddDoubleLine("Слева", "Справа", 0.1, 1, 0.1, 0.5, 0.5, 0.5)
      GameTooltip:AddLine("Без цвета")`);
    assert.equal(line("Left", 1).text, "Заголовок");
    close(line("Left", 1).textColor, { r: 1, g: 0.82, b: 0 }, "SetText keeps its colour arguments");
    assert.equal(line("Left", 2).text, "Слева");
    assert.equal(line("Right", 2).text, "Справа");
    assert.equal(line("Right", 2).visible, true, "the right half of a double line is shown");
    close(line("Left", 2).textColor, { r: 0.1, g: 1, b: 0.1 }, "left colour");
    close(line("Right", 2).textColor, { r: 0.5, g: 0.5, b: 0.5 }, "right colour");
    assert.equal(line("Left", 3).text, "Без цвета");
    close(line("Left", 3).textColor, { r: 1, g: 1, b: 1 }, "AddLine without a colour is white");
    assert.deepEqual(run("return GameTooltip:NumLines()", 1), [3], "a double line is one line");
    const twoColumns = Number(tooltip.attributes.width);
    run(`GameTooltip:AppendText(" (2)")`);
    assert.equal(line("Left", 1).text, "Заголовок (2)", "AppendText extends the title");
    run("GameTooltip:SetMinimumWidth(500)");
    assert.ok(Number(tooltip.attributes.width) >= 500 && twoColumns < 500, "SetMinimumWidth widens the root");

    assert.deepEqual(run(`return GameTooltip:SetHyperlink("|cffff8000|Hitem:19019:0:0:0:0:0:0:0|h[Громовая Ярость]|h|r")`, 1), [true]);
    assert.equal(tooltip.visible, true);
    assert.equal(line("Left", 1).text, "Громовая Ярость");
    close(line("Left", 1).textColor, { r: 1, g: 0x80 / 255, b: 0 }, "a legendary title is orange");
    close(line("Left", 2).textColor, { r: 1, g: 1, b: 1 }, "a base stat is white");
    close(line("Left", 3).textColor, { r: 0.1, g: 1, b: 0.1 }, "an Equip: line is green");
    close(line("Left", 4).textColor, { r: 1, g: 0.1, b: 0.1 }, "an unmet requirement is red");
    close(line("Left", 5).textColor, { r: 1, g: 0.82, b: 0 }, "flavour text is gold");
    assert.equal(line("Left", 5).attributes.wordWrap, "true", "flavour text wraps");
    assert.equal(line("Left", 6).text, "|cffff2020красный|r и обычный", "colour runs become escapes");
    close(line("Left", 7).textColor, { r: 0.1, g: 1, b: 0.1 }, "a click hint is green");
    assert.equal(line("Right", 2).visible, false, "the previous double line's right half is cleared");
    const [name, link] = run("return GameTooltip:GetItem()", 2);
    assert.equal(name, "Громовая Ярость");
    assert.match(link, /item:19019/);
    assert.deepEqual(run(`return GameTooltip:SetHyperlink("garbage")`, 1), [false]);
    assert.equal(tooltip.visible, false, "an unknown link hides the tooltip");

    const [playerName] = run(`return UnitName("player")`, 1);
    const [level] = run(`return UnitLevel("player")`, 1);
    assert.deepEqual(run(`GameTooltip:SetOwner(UIParent, "ANCHOR_NONE") return GameTooltip:SetUnit("player")`, 1), [true]);
    assert.equal(tooltip.visible, true, "SetUnit shows the tooltip");
    assert.equal(line("Left", 1).text, playerName, "the unit's name heads it");
    assert.ok([2, 3].some((index) => line("Left", index)?.visible && line("Left", index).text.includes(String(level))),
      "a level line follows");
    assert.deepEqual(run("return GameTooltip:GetUnit()", 2), [playerName, "player"]);
    assert.deepEqual(run(`return GameTooltip:SetUnit("nosuchunit")`, 1), [false]);
    assert.equal(tooltip.visible, false, "a unit that does not exist hides the tooltip");
    assert.equal(boot.errorCount, 0, "no Lua errors");
  } finally {
    boot.close();
  }
});
