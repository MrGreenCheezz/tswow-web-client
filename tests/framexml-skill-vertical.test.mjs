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
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC, FRAMEXML_TOC_PATH } =
  await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { parseGlueToc } = await import("../dist/code/browser/glue/GlueLoader.js");

const decoder = new TextDecoder("utf-8");
const normalize = (path) => path.replaceAll("\\", "/").toLowerCase();

function metrics(inventory) {
  return {
    files: inventory.files.total,
    bytes: inventory.files.bytes,
    widgets: inventory.widgets.total,
    lua: inventory.lua.executed,
    luaFailed: inventory.lua.failed,
    errors: inventory.lua.errorsRaised,
    distinctErrors: inventory.errors.length,
  };
}

async function load(chain, subset, seam) {
  const requests = new Set();
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        requests.add(normalize(path));
        const data = await chain.read(path);
        return data ? decoder.decode(data) : undefined;
      },
    },
    locale: "ruRU",
    subset,
    seam,
    exercise: false,
    screen: () => ({ width: 1024, height: 768 }),
  });
  return { boot, inventory: await boot.load(), requests };
}

test("MPQ SkillFrame vertical reaches Tab4 and renders the Canned skill rows", withClient, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const chain = await clientArchives(clientDirectory);
  let baseline;
  let candidate;
  try {
    const toc = await chain.read(FRAMEXML_TOC_PATH);
    assert.ok(toc, "FrameXML.toc is present in the MPQ chain");
    const realPaths = parseGlueToc(decoder.decode(toc), "interface/framexml/")
      .map((entry) => normalize(entry.path));
    const positions = FRAMEXML_VERTICAL_TOC.map((entry) => realPaths.indexOf(
      normalize(`interface/framexml/${entry}`),
    ));
    assert.ok(positions.every((position) => position >= 0), "all vertical files are in stock TOC");
    assert.ok(positions.every((position, index) => index === 0 || position > positions[index - 1]),
      "vertical entries preserve stock TOC order");
    const skillPath = normalize("interface/framexml/skillframe.xml");
    const skillLua = normalize("interface/framexml/skillframe.lua");
    assert.equal(FRAMEXML_VERTICAL_TOC.filter((entry) => normalize(entry) === "skillframe.xml").length, 1);

    baseline = await load(chain,
      FRAMEXML_VERTICAL_TOC.filter((entry) => normalize(entry) !== "skillframe.xml"),
      new CannedWorldSeam());
    candidate = await load(chain, FRAMEXML_VERTICAL_TOC, new CannedWorldSeam());
    assert.equal(baseline.boot.bridge.getFrame("SkillFrame")?.name, undefined,
      "the comparison subset does not include SkillFrame");
    assert.ok(candidate.requests.has(skillPath), "SkillFrame.xml was read from MPQ");
    assert.ok(candidate.requests.has(skillLua), "SkillFrame.lua was reached through XML Script");
    assert.equal(candidate.inventory.files.missing.length, 0);
    assert.equal(candidate.inventory.xml.failed.length, 0);
    assert.equal(candidate.inventory.lua.failed, 0);

    const before = metrics(baseline.inventory);
    const after = metrics(candidate.inventory);
    const delta = Object.fromEntries(Object.keys(before).map((key) => [key, after[key] - before[key]]));
    assert.deepEqual(delta, {
      files: 2, bytes: 42_515, widgets: 233, lua: 1,
      luaFailed: 0, errors: 0, distinctErrors: 0,
    }, `SkillFrame delta: ${JSON.stringify(delta)}`);

    const frame = (name) => {
      const value = candidate.boot.bridge.getFrame(name);
      assert.ok(value, `${name} exists in stock SkillFrame`);
      return value;
    };
    const character = frame("CharacterFrame");
    const tab4 = frame("CharacterFrameTab4");
    const skill = frame("SkillFrame");
    assert.equal(tab4.id, 4);
    assert.equal(skill.id, 4);
    assert.equal(skill.visible, false);
    const errorsBefore = candidate.boot.vm.errors.length;
    assert.equal(candidate.boot.bridge.Show(character), true);
    assert.equal(candidate.boot.bridge.Click(tab4, "LeftButton", false), true,
      "stock CharacterFrame opens SkillFrame through Tab4");
    assert.equal(skill.visible, true);
    assert.equal(frame("SkillTypeLabel1").text, "Профессии");
    assert.equal(frame("SkillRankFrame2SkillName").text, "Кузнечное дело");
    assert.equal(frame("SkillRankFrame2SkillRank").text, "407 (|cff20ff20+10|r)/450");
    assert.equal(frame("SkillDetailDescriptionText").visible, false,
      "detail stays empty until a skill row is selected");
    assert.equal(candidate.boot.vm.errors.length, errorsBefore,
      "opening SkillFrame adds no Lua errors");

    const header = frame("SkillTypeLabel1");
    assert.equal(candidate.boot.bridge.Click(header, "LeftButton", false), true);
    assert.equal(frame("SkillRankFrame2").visible, false, "collapse hides child skill rows");
    assert.equal(candidate.boot.bridge.Click(header, "LeftButton", false), true);
    assert.equal(frame("SkillRankFrame2").visible, true, "expand restores child skill rows");
    assert.equal(candidate.boot.bridge.Hide(character), true);
    assert.equal(candidate.boot.bridge.isVisible(skill), false);
  } finally {
    candidate?.boot.close();
    baseline?.boot.close();
    chain.close();
  }
});
