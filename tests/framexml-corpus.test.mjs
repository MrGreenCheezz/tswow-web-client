import assert from "node:assert/strict";
import test from "node:test";

/**
 * Slice F1's deliverable, as a test.
 *
 * Two halves, on purpose. The first is fixture-driven and always runs: the stub plan is a lexical
 * pass over Lua text and can be pinned exactly. The second loads the client's own
 * `Interface\FrameXML` out of the MPQ chain and pins the *measurement* — floors on what must keep
 * working and **ceilings** on what is still broken, so a later slice sees its progress as a ceiling
 * coming down rather than as a number in a report nobody re-runs. A machine without the 3.3.5a
 * client skips the second half cleanly.
 */
let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine" };

/**
 * One MPQ chain for the whole file.
 *
 * `clientArchives` hands back a shared handle, so closing it in one test closes it for the next —
 * measured, the second test then read zero files. Opened once, closed once, at the end.
 */
let sharedChain;
async function corpusProvider() {
  if (!sharedChain) {
    const { clientArchives } = await import("../tools/mpq.mjs");
    sharedChain = await clientArchives(clientDirectory);
  }
  const decoder = new TextDecoder("utf-8");
  return {
    async read(path) {
      const data = await sharedChain.read(path.replaceAll("/", "\\"));
      return data ? decoder.decode(data) : undefined;
    },
  };
}

const { frameXmlStubPlan, stripLuaText, frameXmlInlineScripts } =
  await import("../dist/code/browser/framexml/FrameXmlStubPlan.js");
const { collectFailures, parseLuaFailure, FrameXmlBoot, FRAMEXML_PROMOTED_METHODS } =
  await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const {
  singleFileTocProvider,
  subsetWithActiveTsAddonsTocProvider,
  FrameXmlCorpus,
  frameXmlAddonModules,
  frameXmlHandlerScripts,
} =
  await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { formatFrameXmlInventory } =
  await import("../dist/code/browser/framexml/FrameXmlInventory.js");
const { frameXmlFontRecord, FRAMEXML_FONT_METHODS, FRAMEXML_FONT_OBJECT_SETTERS } =
  await import("../dist/code/browser/framexml/FrameXmlFontObjects.js");
const { FRAMEXML_NEUTRAL_API, FRAMEXML_NEUTRAL_CONSTANTS } =
  await import("../dist/code/browser/framexml/FrameXmlNeutralApi.js");
const { parseFrameXml } =
  await import("../dist/code/browser/ui/framexml_compat/FrameXmlParser.js");

test("stripLuaText blanks comments and strings without moving token boundaries", () => {
  const source = [
    "-- CallInComment()",
    "--[==[ CallInLongComment() ]==]",
    'local text = "CallInString()"',
    "local long = [[ CallInLongString() ]]",
    "RealCall()",
  ].join("\n");
  const stripped = stripLuaText(source);
  assert.ok(!stripped.includes("CallInComment"), stripped);
  assert.ok(!stripped.includes("CallInLongComment"), stripped);
  assert.ok(!stripped.includes("CallInString"), stripped);
  assert.ok(!stripped.includes("CallInLongString"), stripped);
  assert.ok(stripped.includes("RealCall("), stripped);
});

test("the stub plan separates what the host owes from what the corpus owns", () => {
  const plan = frameXmlStubPlan([
    {
      file: "a.lua",
      source: [
        "function CorpusOwned(a) return a end",
        "OtherGlobal = 4",
        "local function LocalOnly() end",
        "local helper = 1",
        "function Run()",
        "  CorpusOwned(1)",
        "  OtherGlobal()",
        "  LocalOnly()",
        "  helper()",
        "  HostOwed(1)",
        "  HostOwed(2)",
        "  strlen('x')",
        "  math.floor(1)",
        "  local frame = _G['Probe']",
        "end",
      ].join("\n"),
    },
  ]);
  // Called and never defined anywhere in the corpus: the host owes it, twice.
  assert.equal(plan.apiCallSites.get("HostOwed"), 2);
  assert.ok(plan.apiNames.has("HostOwed"));
  // Defined by the corpus, in a local, or already in the VM: not the host's problem.
  for (const name of ["CorpusOwned", "OtherGlobal", "LocalOnly", "helper", "strlen", "math"]) {
    assert.ok(!plan.apiNames.has(name), `${name} must not be stubbed`);
  }
  // A global that is only *read* stays nil, which is what lets `_G["Frame"..i]` run out.
  assert.ok(!plan.apiNames.has("Probe"));
});

test("a method the corpus attaches to its own table is not stubbed, and the promotion overrides it", () => {
  const plan = frameXmlStubPlan([
    {
      file: "b.lua",
      source: [
        "function Handle:SetAttribute(name, value) end",
        "control.SetDisplayValue = function(self, value) end",
        "function Run()",
        "  frame:SetAttribute('a', 1)",
        "  control:SetDisplayValue(2)",
        "  frame:SetHostThing()",
        "end",
      ].join("\n"),
    },
  ]);
  assert.ok(plan.methodNames.has("SetHostThing"), "a plain `:` call the corpus never attaches");
  assert.ok(!plan.methodNames.has("SetAttribute"), "attached by the corpus, so excluded by the rule");
  assert.ok(!plan.methodNames.has("SetDisplayValue"));
  // …and the exclusion is still visible, which is what makes a promotion a measurement. Two, not
  // one: `function Handle:SetAttribute(` is itself a `:Name(` spelling, and the unfiltered count
  // deliberately keeps it — a name's declaration is part of how often the corpus writes it.
  assert.equal(plan.allMethodCallSites.get("SetAttribute"), 2);
  // F1 promoted `SetAttribute`/`GetAttribute` to recording no-ops because 145 raises forced it;
  // F3 replaced both with a real store, so the promotion list is empty and the graduation is
  // recorded instead. `tests/framexml-seam.test.mjs` pins what they do now.
  assert.deepEqual(FRAMEXML_PROMOTED_METHODS, []);
});

test("inline scripts are the ones without a file attribute", () => {
  const bodies = frameXmlInlineScripts(
    '<Ui><Script file="Other.lua"/><Script>\ninline()\n</Script></Ui>',
  );
  assert.equal(bodies.length, 1);
  assert.ok(bodies[0].includes("inline()"));
});

test("the error census groups repeats and keeps the position", () => {
  const failure = parseLuaFailure("interface/framexml/uiparent.lua:42: attempt to call a nil value", true);
  assert.equal(failure.file, "interface/framexml/uiparent.lua");
  assert.equal(failure.line, 42);
  assert.equal(failure.message, "attempt to call a nil value");
  assert.equal(failure.handled, true);

  const census = collectFailures(
    ["a.lua:1: boom"],
    ["b.lua:2: bang", "b.lua:2: bang", "b.lua:2: bang"],
  );
  assert.equal(census.length, 2);
  assert.equal(census[0].file, "b.lua");
  assert.equal(census[0].count, 3);
  assert.equal(census[0].handled, true);
  assert.equal(census[1].count, 1);
  assert.equal(census[1].handled, false);
});

test("a single-file TOC is a real TOC that resolves back through the interface tree", async () => {
  const source = {
    async read(path) {
      return path === "interface/framexml/uiparent.lua" ? "-- body" : undefined;
    },
  };
  const single = singleFileTocProvider(source, "Interface\\FrameXML\\UIParent.lua");
  const toc = await single.provider.read(single.toc);
  assert.ok(toc.trim().length > 0, "the synthetic TOC names the file");
  assert.equal(await single.provider.read("interface/framexml/uiparent.lua"), "-- body");
  // Anything that would climb out of `interface/` is refused rather than smuggled through.
  const escape = singleFileTocProvider(source, "..\\..\\..\\windows\\system32\\drivers\\etc\\hosts");
  assert.equal((await escape.provider.read(escape.toc)).trim(), "");
});

/* ---------------------------------------------------------------- slice F2 */

test("GetFont answers the file, the height and the flag string SetFont takes back", () => {
  assert.deepEqual(
    frameXmlFontRecord({ name: "GameFontNormal", file: "Fonts\\FRIZQT__.TTF", height: 12, monochrome: false }),
    { name: "GameFontNormal", file: "Fonts\\FRIZQT__.TTF", height: 12, flags: "" },
  );
  // The XML spelling and the API spelling are not the same word.
  assert.equal(
    frameXmlFontRecord({ name: "A", outline: "NORMAL", monochrome: false }).flags, "OUTLINE");
  assert.equal(
    frameXmlFontRecord({ name: "B", outline: "THICK", monochrome: true }).flags,
    "THICKOUTLINE,MONOCHROME");
  // A font object that declares no file of its own still answers "" rather than nil: the corpus
  // tests the *object*, and `local f = GameFontNormal:GetFont()` is the line seven files died on.
  assert.equal(frameXmlFontRecord({ name: "C", monochrome: false }).file, "");
  assert.equal(frameXmlFontRecord({ name: "C", monochrome: false }).height, 0);
  assert.ok(FRAMEXML_FONT_METHODS.includes("GetFont"));
  assert.ok(FRAMEXML_FONT_OBJECT_SETTERS.includes("SetFontObject"));
});

test("the stub plan sees the Lua written inside <Scripts>, not only <Script> files", () => {
  const parsed = parseFrameXml([
    "<Ui>",
    '  <Frame name="A">',
    "    <Scripts>",
    "      <OnLoad>GetActionBarToggles()</OnLoad>",
    '      <OnClick function="A_OnClick"/>',
    "    </Scripts>",
    "  </Frame>",
    "</Ui>",
  ].join("\n"));
  const chunks = frameXmlHandlerScripts(parsed.root, "a.xml");
  assert.equal(chunks.length, 1, "a handler with a function= attribute has no body of its own");
  assert.ok(chunks[0].file.startsWith("a.xml:OnLoad"));
  // The whole point: without this the name reads as "only ever read", is left nil by the plan's own
  // rule, and raises «attempt to call a nil value» — measured on six globals in this corpus.
  const plan = frameXmlStubPlan(chunks);
  assert.equal(plan.apiCallSites.get("GetActionBarToggles"), 1);
});

test("the add-on list comes from the TOC's own markers", () => {
  const modules = frameXmlAddonModules([
    "## Interface: 30300",
    "## tsaddon-begin-lib",
    "## tsaddon-end-lib",
    "## tsaddon-begin: survival",
    "TSAddons/survival/addon/survival-ui.lua",
    "## tsaddon-end: survival",
    "## tsaddon-begin: tswow-store",
    "## tsaddon-end: tswow-store",
  ].join("\n"));
  // `tsaddon-begin-lib` is the shared runtime, not a module, and it carries no name.
  assert.deepEqual(modules, ["survival", "tswow-store"]);
});

test("the production subset preserves complete active TSAddon blocks in winning TOC order", async () => {
  const active = [
    "## Interface: 30300",
    "GlobalStrings.lua",
    "## tsaddon-begin-lib",
    "RequireStub.lua",
    "ClientNetwork.lua",
    "## tsaddon-end-lib",
    "## tsaddon-begin: retail-talents",
    "TSAddons\\retail-talents\\addon\\talent-ui.lua",
    "TSAddons\\retail-talents\\addon\\addon.lua",
    "## tsaddon-end: retail-talents",
    // A truncated generated block is unsafe to execute and must not leak into the subset.
    "## tsaddon-begin: broken",
    "TSAddons\\broken\\addon.lua",
  ].join("\n");
  let activeReads = 0;
  const source = {
    async read(path) {
      if (path.replaceAll("\\", "/").toLowerCase() === "interface/framexml/framexml.toc") {
        activeReads += 1;
        return active;
      }
      return undefined;
    },
  };
  const subset = subsetWithActiveTsAddonsTocProvider(source, ["GlobalStrings.lua", "UIParent.xml"]);
  const first = await subset.provider.read(subset.toc);
  const second = await subset.provider.read(subset.toc);

  assert.equal(first, second, "scan and load observe one memoized synthetic TOC");
  assert.equal(activeReads, 1, "the winning TOC is read once");
  assert.match(first, /GlobalStrings\.lua\nUIParent\.xml\n## tsaddon-begin-lib/);
  assert.match(first, /RequireStub\.lua\nClientNetwork\.lua\n## tsaddon-end-lib/);
  assert.match(first, /## tsaddon-begin: retail-talents[\s\S]*addon\\talent-ui\.lua[\s\S]*addon\\addon\.lua[\s\S]*## tsaddon-end: retail-talents/);
  assert.doesNotMatch(first, /TSAddons\\broken/);
  assert.deepEqual(frameXmlAddonModules(first), ["retail-talents"]);
});

test("every neutral answer says what it answers and why", () => {
  const names = FRAMEXML_NEUTRAL_API.map((entry) => entry.name);
  assert.equal(new Set(names).size, names.length, "no name is answered twice");
  for (const entry of FRAMEXML_NEUTRAL_API) {
    assert.ok(entry.answer.length > 0, `${entry.name} must say what it answers`);
    assert.ok(entry.reason.length > 0, `${entry.name} must say why that and not nil`);
  }
  // The eight that were *forced* by a measured failure name the file and the line that forced them,
  // which is the rule F1 set for a promotion and F2 inherits.
  for (const name of ["GetActionBarPage", "GetBonusBarOffset", "GetMultiCastBarOffset", "GetMoney",
    "GetNumPartyMembers", "GetNumDisplayChannels", "GetNumVoiceSessions", "UnitLevel"]) {
    const entry = FRAMEXML_NEUTRAL_API.find((candidate) => candidate.name === name);
    assert.match(entry.reason, /\w+\.lua:\d+/, `${name} must quote the failure that forced it`);
  }
  // Constant and stateful are the two halves and nothing is in both.
  const constants = new Set(FRAMEXML_NEUTRAL_CONSTANTS.map((entry) => entry.name));
  const stateful = FRAMEXML_NEUTRAL_API.filter((entry) => entry.values === undefined);
  assert.equal(constants.size + stateful.length, FRAMEXML_NEUTRAL_API.length);
  // The three arithmetic failures the action-bar group exists for.
  const answerOf = (name) => FRAMEXML_NEUTRAL_API.find((entry) => entry.name === name);
  assert.deepEqual(answerOf("GetActionBarPage").values, [1]);
  assert.deepEqual(answerOf("GetBonusBarOffset").values, [0]);
  assert.deepEqual(answerOf("GetMultiCastBarOffset").values, [0]);
  assert.deepEqual(answerOf("GetMoney").values, [0]);
  // Deliberately *not* answered: a name whose only honest answer is nil keeps it, and says so.
  assert.deepEqual(answerOf("UnitName").values, []);
  assert.deepEqual(answerOf("UnitLevel").values, []);
  assert.deepEqual(answerOf("GetChatWindowInfo").values, []);
  // The CVar registry is a map, not a table of plausible values.
  assert.equal(answerOf("GetCVar").values, undefined);
  assert.equal(answerOf("LoadAddOn").values, undefined);
});

/**
 * The measurement.
 *
 * Floors are what must not regress; ceilings are the work queue. The numbers are the ones F2
 * actually took against `F:/Circle` on 2026-08-30, with headroom for a dataset that is not
 * byte-identical. F1's own numbers are quoted beside each ceiling it lowered.
 */
test("the real FrameXML corpus loads through the glue engine", withClient, async () => {
  const provider = await corpusProvider();
  const boot = new FrameXmlBoot({ provider, locale: "ruRU", screen: () => ({ width: 1024, height: 768 }) });
  const inventory = await boot.load();

  // ---- the corpus itself -------------------------------------------------
  assert.ok(inventory.tocEntries >= 200, `TOC entries: ${inventory.tocEntries}`);
  assert.ok(inventory.files.total >= 330, `files: ${inventory.files.total}`);
  assert.ok(inventory.files.bytes >= 10_000_000, `bytes: ${inventory.files.bytes}`);
  assert.equal(inventory.files.missing.length, 0, "every TOC entry resolves through the MPQ chain");

  // ---- what parsed and ran ----------------------------------------------
  assert.equal(inventory.xml.failed.length, 0, "no XML file is refused by the parser");
  assert.ok(inventory.xml.parsed >= 130, `parsed XML: ${inventory.xml.parsed}`);
  assert.equal(inventory.xml.unknownDeclarations.length, 0,
    `declarations the grammar drops: ${JSON.stringify(inventory.xml.unknownDeclarations)}`);
  assert.ok(inventory.lua.executed >= 208, `executed Lua chunks: ${inventory.lua.executed}`);
  // F1: 7, every one of them `_G.GameFontNormal:GetFont()` at file scope. F2 made font objects
  // globals, so this is a floor now and not a ceiling — nothing may fail to load again.
  assert.equal(inventory.lua.failed, 0, `Lua files that failed to load: ${inventory.lua.failed}`);

  // ---- what exists afterwards -------------------------------------------
  // F1 24,770 → F2 25,308 → F3 25,352: a working `SetAttribute` lets `UIDropDownMenu`'s
  // `createframes` attribute reach `UIDropDownMenu_CreateFrames`, which builds the rest.
  assert.ok(inventory.widgets.total >= 25_300, `widgets: ${inventory.widgets.total}`);
  assert.ok(inventory.widgets.templates >= 450, `templates: ${inventory.widgets.templates}`);
  assert.ok(inventory.widgets.fonts >= 140, `font objects: ${inventory.widgets.fonts}`);
  assert.ok(inventory.widgets.roots >= 60, `roots: ${inventory.widgets.roots}`);
  assert.ok(boot.bridge.getFrame("UIParent"), "UIParent exists");
  assert.ok(boot.bridge.getFrame("WorldFrame"), "WorldFrame exists");
  assert.ok(boot.bridge.getFrame("GameTooltip"), "GameTooltip exists — the F1 grammar addition");
  assert.ok(boot.bridge.getFrame("ActionButton1"), "the action bar's buttons exist");
  assert.ok(boot.bridge.getFrame("MainMenuBar"), "the main bar exists");
  // The dedicated Minimap, UIDropDownMenu and model-widget method tables bring the census to 18.
  assert.equal(boot.wrappedWidgetTypes, 18,
    "every widget type the layer knows has a method fallback, including Minimap and model frames");

  // ---- the VM verdict, which is what item (3) of the slice was for -------
  assert.deepEqual(inventory.vm.getfenvSites, [], "FrameXML never names getfenv");
  assert.deepEqual(inventory.vm.setfenvSites, ["interface/framexml/restrictedexecution.lua"],
    "setfenv is one file's problem, not the corpus'");
  assert.equal(inventory.errors.filter((entry) => /restricted|secure/i.test(entry.file)).length, 0,
    "the secure-template layer loads without raising");

  // ---- what F2 answers ---------------------------------------------------
  // Font objects: declared before the first chunk runs, resolved on first read.
  assert.ok(inventory.fonts.declared >= 145, `font objects declared: ${inventory.fonts.declared}`);
  assert.ok(inventory.fonts.reached >= 10, `font objects read: ${inventory.fonts.reached}`);
  assert.ok(inventory.fonts.interopWraps >= 15,
    `widget methods rewired for font objects: ${inventory.fonts.interopWraps}`);
  assert.ok(inventory.fonts.methodCalls.some((entry) => entry.name === "GetFont" && entry.calls > 0),
    "GetFont is the one Font method this corpus calls, and it is answered");
  assert.equal(inventory.misses.filter((entry) => /^GameFont/.test(entry.name)).length, 0,
    "no font object is a nil global any more");
  const answeredNames = new Set(inventory.neutral.filter((entry) => entry.calls > 0)
    .map((entry) => entry.name));
  for (const name of ["GetActionBarPage", "GetMoney", "GetCVar", "LoadAddOn", "IsShiftKeyDown"]) {
    assert.ok(answeredNames.has(name), `${name} must be answered, not stubbed`);
  }
  const answeredCalls = inventory.neutral.reduce((sum, entry) => sum + entry.calls, 0);
  assert.ok(answeredCalls >= 3000, `calls the neutral API answered: ${answeredCalls}`);

  // ---- what F3 answers ---------------------------------------------------
  // This boot has **no seam**, so what is measured here is F2's neutral world plus F3's secure
  // attributes — which is the honest baseline for the ceilings below. The seam's own numbers, and
  // the whole corpus run *with* one, are pinned by `tests/framexml-seam.test.mjs`.
  assert.equal(inventory.secure.seam, "", "the census boot runs on the neutral world");
  assert.ok(inventory.secure.installs >= 20,
    `attribute methods installed: ${inventory.secure.installs}`);
  assert.ok(inventory.secure.setAttributeCalls >= 900,
    `SetAttribute calls: ${inventory.secure.setAttributeCalls}`);
  assert.ok(inventory.secure.getAttributeCalls >= 3000,
    `GetAttribute calls: ${inventory.secure.getAttributeCalls}`);
  // F1 and F2 dispatched none of these: the write was a no-op, so nothing could change.
  assert.ok(inventory.secure.attributeDispatches >= 900,
    `OnAttributeChanged dispatches: ${inventory.secure.attributeDispatches}`);
  // The `<Attribute>` elements F1 counted as unparsed grammar.
  assert.ok(inventory.secure.declaredInXml >= 10,
    `attributes declared in XML: ${inventory.secure.declaredInXml}`);
  assert.ok(boot.bridge.GetAttribute(boot.bridge.getFrame("UIParent"), "DEFAULT_FRAME_WIDTH") === 384,
    "UIParent's own XML attributes are readable, which is what UIParent.lua asks for");

  // ---- the ceilings: this is the work queue ------------------------------
  // F1 → F2 → F3, every number re-measured on the same dataset: 183 → 57 → 58 distinct,
  // 415 → 126 → 128 raises. F3's two extra raises are the expected shape and they are named in the
  // journal: with attributes real and layer regions filling their parents, more of the interface
  // runs far enough to reach the host. The same corpus *with* the world seam is 124/54 — better
  // than F2 — and that is what `tests/framexml-seam.test.mjs` pins.
  assert.ok(inventory.errors.length <= 60, `distinct Lua failures: ${inventory.errors.length}`);
  assert.ok(inventory.lua.errorsRaised <= 130, `errors raised: ${inventory.lua.errorsRaised}`);
  // The active TSWoW-patched corpus reaches 212 C-API globals (including `_CLIENT_NETWORK`);
  // keep a small measured ceiling while the vertical's exact metrics remain pinned separately.
  assert.ok(inventory.api.length <= 215, `C-API globals reached: ${inventory.api.length}`);
  // The real queue: reached *and still nil*. F1 had no such split, because it answered nothing.
  const unanswered = inventory.api.filter((entry) => entry.neutral === "");
  assert.ok(unanswered.length <= 130, `C-API globals still unanswered: ${unanswered.length}`);
  assert.ok(inventory.methods.length <= 32, `unanswered widget methods reached: ${inventory.methods.length}`);

  // ---- the gold list, which is the deliverable ---------------------------
  console.log(formatFrameXmlInventory(inventory, 30));
  console.log(`[framexml] план: ${inventory.plan.apiNames} глобалов в корпусе, `
    + `достигнуто ${inventory.api.length}; методов ${inventory.plan.methodNames}, `
    + `достигнуто ${inventory.methods.length}`);
  console.log(`[framexml] промахи (не хендлер-env): ${inventory.misses.length} имён, `
    + `${inventory.misses.reduce((sum, entry) => sum + entry.reads, 0)} чтений; `
    + `хендлер-env ${inventory.handlerEnvironmentReads}`);
  console.log(`[framexml] F2: шрифтов объявлено ${inventory.fonts.declared}, прочитано `
    + `${inventory.fonts.reached}; нейтральный API отвечает на ${answeredCalls} вызовов `
    + `(${answeredNames.size} имён из ${inventory.neutral.length}); C-API без ответа `
    + `${unanswered.length}`);

  boot.close();
});

test("the corpus provider reads each file once", withClient, async () => {
  const source = await corpusProvider();
  let reads = 0;
  const corpus = new FrameXmlCorpus({
    async read(path) {
      reads += 1;
      return await source.read(path);
    },
  });
  const scan = await corpus.scan();
  const before = reads;
  // The loader walks the same TOC straight afterwards; over HTTP that is the difference between
  // 335 requests and 670.
  for (const file of scan.files) await corpus.read(file.path);
  assert.equal(reads, before, "a second walk costs no reads at all");
  assert.equal(corpus.requests, reads);
  assert.ok(scan.files.length >= 330, `scanned files: ${scan.files.length}`);
  sharedChain.close();
  sharedChain = undefined;
});
