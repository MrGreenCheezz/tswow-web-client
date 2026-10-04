import assert from "node:assert/strict";
import test, { after } from "node:test";

// Plan item 3.09 (L17, 04.10), MPQ-backed: the stock LocalizationPost.xml — the ruRU DeclensionFrame —
// joins the vertical as its last stock entry (FrameXML.toc's last line). PET_FORCE_NAME_DECLENSION opens
// it with the rule engine's forms (DeclineName, FrameXmlPetDeclension.ts), «ОК» calls PetRename with the
// name and its five forms, which sends CMSG_PET_RENAME with the declined block; SMSG_PET_NAME_INVALID's
// declined block opens it again with the server's forms (Wow.exe 0x005d5670, case 0x178).
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
const { FRAMEXML_VERTICAL_TOC, FRAMEXML_TOC_PATH } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { parseGlueToc } = await import("../dist/code/browser/glue/GlueLoader.js");
const { FrameXmlPetDeclensionModel, FRAMEXML_PET_FORCE_NAME_DECLENSION } = await import(
  "../dist/code/browser/framexml/FrameXmlPetDeclension.js",
);
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const decoder = new TextDecoder("utf-8");
const normalize = (path) => path.replaceAll("\\", "/").toLowerCase();

const SELF = 0x10n;
const PET = 0xf1400000000000aan;

async function load(subset = FRAMEXML_VERTICAL_TOC) {
  const seam = new CannedWorldSeam();
  const boot = new FrameXmlBoot({
    provider: { async read(path) { const data = await chain.read(path); return data ? decoder.decode(data) : undefined; } },
    locale: "ruRU", subset, seam, exercise: true, screen: () => ({ width: 1365, height: 768 }),
  });
  const inventory = await boot.load();
  return { boot, seam, inventory };
}

function lua(boot, code, results = 1) {
  const fn = boot.vm.compileFunction(code, "declension-test", []);
  assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
  try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
}

/** A hunter's renameable pet in a world the model reads, and the renames it would send. */
function petWorld() {
  const fields = new Map();
  fields.set(UPDATE_FIELDS.UNIT_FIELD_SUMMONEDBY.offset, Number(SELF));
  fields.set(UPDATE_FIELDS.UNIT_FIELD_SUMMONEDBY.offset + 1, 0);
  fields.set(UPDATE_FIELDS.UNIT_FIELD_BYTES_2.offset, 0x01 << 16);
  const sent = [];
  const world = {
    state: { selfGuid: SELF, objects: new Map([[PET, { guid: PET, typeId: 3, fields }]]) },
    petSpells: { guid: PET },
    renamePet: (name, declined) => { sent.push(declined === undefined ? [name] : [name, ...declined]); },
    onPetNameInvalid: undefined,
  };
  return { world, sent };
}

const BOXES = `
  local out = {}
  for i = 1, RUSSIAN_DECLENSION_PATTERNS do out[i] = _G["DeclensionFrameDeclension" .. i .. "Edit"]:GetText() end
  return DeclensionFrame:IsShown() and 1 or 0, DeclensionFrameNominative:GetText(), unpack(out)`;

test("LocalizationPost.xml at the stock TOC's end: two files, DeclensionFrame, no Lua error; the frame renames the pet with declensions", withClient, async () => {
  const toc = parseGlueToc(decoder.decode(await chain.read(FRAMEXML_TOC_PATH)), "interface/framexml/")
    .map((entry) => normalize(entry.path).replace("interface/framexml/", ""))
    .filter((entry) => !entry.includes("tsaddons/"));
  const vertical = FRAMEXML_VERTICAL_TOC.map(normalize);
  assert.equal(toc.at(-1), "localizationpost.xml", "the stock TOC's last stock entry");
  assert.equal(vertical.at(-1), "localizationpost.xml");
  let baseline;
  let candidate;
  try {
    baseline = await load(FRAMEXML_VERTICAL_TOC.filter((entry) => normalize(entry) !== "localizationpost.xml"));
    candidate = await load();
    const metric = (inventory) => ({ files: inventory.files.total, bytes: inventory.files.bytes,
      widgets: inventory.widgets.total, errors: inventory.lua.errorsRaised, distinct: inventory.errors.length });
    const before = metric(baseline.inventory);
    const afterLoad = metric(candidate.inventory);
    const delta = Object.fromEntries(Object.keys(before).map((key) => [key, afterLoad[key] - before[key]]));
    console.log(`LocalizationPost delta ${JSON.stringify(delta)}`);
    assert.deepEqual(delta, { files: 2, bytes: 11_931, widgets: 47, errors: 0, distinct: 0 }, `delta ${JSON.stringify(delta)}`);
    assert.equal(baseline.boot.bridge.getFrame("DeclensionFrame")?.name, undefined);
    const frame = candidate.boot.bridge.getFrame("DeclensionFrame");
    assert.equal(frame?.type, "Frame");
    assert.equal(frame.visible, false);
    assert.ok(frame.registeredEvents.has(FRAMEXML_PET_FORCE_NAME_DECLENSION), "OnLoad registered the event");

    const { boot, seam } = candidate;
    const { world, sent } = petWorld();
    const model = new FrameXmlPetDeclensionModel({ world: () => world, locale: () => "ruRU" });
    seam.petDeclension = model;
    model.attach({ fire: (event, ...args) => boot.bridge.dispatchEvent(event, ...args), now: () => 0 });
    const errors = boot.vm.errors.length;

    // The stock rename popup's accept: PetRename(name) alone opens the frame (0x005d57de).
    lua(boot, `PetRename("Тузик")`, 0);
    const opened = lua(boot, BOXES, 7);
    assert.deepEqual(opened, [1, "Тузик", "Тузика", "Тузику", "Тузика", "Тузиком", "Тузике"]);
    assert.deepEqual(sent, [], "nothing is sent before «ОК»");

    // The player corrects the accusative, then «ОК»: the name and five forms go out.
    lua(boot, `DeclensionFrameDeclension3Edit:SetText("Тузика") DeclensionFrameOkayButton:Click()`, 0);
    assert.deepEqual(sent, [["Тузик", "Тузика", "Тузику", "Тузика", "Тузиком", "Тузике"]]);
    assert.equal(lua(boot, "return DeclensionFrame:IsShown() and 1 or 0")[0], 0);

    // The server's declined block (PET_NAME_DECLENSION_DOESNT_MATCH_BASE_NAME) opens it with its forms.
    const served = ["Шарика", "Шарику", "Шарика", "Шариком", "Шарике"];
    world.onPetNameInvalid({ error: 16, name: "Шарик", declined: served });
    assert.deepEqual(lua(boot, BOXES, 7), [1, "Шарик", ...served]);
    lua(boot, "DeclensionFrameCancelButton:Click()", 0);
    assert.equal(lua(boot, "return DeclensionFrame:IsShown() and 1 or 0")[0], 0);
    assert.equal(sent.length, 1, "«Отмена» sends nothing");
    assert.equal(boot.vm.errors.length, errors, `no Lua error: ${boot.vm.errors.slice(errors).join(" | ")}`);
    model.detach();
  } finally {
    baseline?.boot.close();
    candidate?.boot.close();
  }
});
