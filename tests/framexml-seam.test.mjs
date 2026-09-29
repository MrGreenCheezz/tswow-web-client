import assert from "node:assert/strict";
import test from "node:test";

/**
 * Slice F3, as a test: secure attributes, the world seam, and the vertical they make work.
 *
 * The same two halves the corpus test has. The first is fixture-driven and always runs — attribute
 * semantics and the canned seam are pure functions over data and can be pinned exactly. The second
 * loads the client's own `Interface\FrameXML` out of the MPQ chain, cut to the action bar's
 * dependency subset, and pins what the vertical actually produces: twelve buttons, twelve icons,
 * one count, one cooldown, and the events that drove them. A machine without the 3.3.5a client
 * skips the second half cleanly.
 */
let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine" };

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

const { frameXmlAttributeKey, frameXmlAttributeCandidates, frameXmlAttributeValue } =
  await import("../dist/code/browser/ui/framexml_compat/FrameXmlAttributes.js");
const { FrameXmlUiBridge } =
  await import("../dist/code/browser/ui/framexml_compat/FrameXmlRuntime.js");
const { FrameXmlTemplateRegistry, parseFrameXml } =
  await import("../dist/code/browser/ui/framexml_compat/FrameXmlParser.js");
const { FrameXmlBoot, FRAMEXML_IMPLEMENTED_METHODS, FRAMEXML_PROMOTED_METHODS } =
  await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { FRAMEXML_VERTICAL_TOC, subsetTocProvider } =
  await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { CannedWorldSeam, CANNED_ACTION_BAR, CANNED_PLAYER, CANNED_CLICK_COOLDOWN_SECONDS } =
  await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS, FRAMEXML_SEAM_NAMES, FRAMEXML_SEAM_EVENTS, FRAMEXML_POWER_EVENTS } =
  await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");

// Keep the historical F3 action-bar run scoped to the stable prefix.  The current vertical also
// carries the cast/player/target tail, which belongs to their focused lifecycle tests and makes
// this regression sensitive to unrelated unit-frame work.
const FRAMEXML_ACTION_BAR_TOC = FRAMEXML_VERTICAL_TOC.slice(
  0,
  FRAMEXML_VERTICAL_TOC.indexOf("MultiActionBars.xml") + 1,
);

/* ------------------------------------------------ attribute store semantics */

test("an attribute name is case-insensitive and nothing else is normalised", () => {
  assert.equal(frameXmlAttributeKey("chatType"), "chattype");
  assert.equal(frameXmlAttributeKey("UIPanelLayout-defined"), "uipanellayout-defined");
  // Not trimmed: the client does not trim either, and " type" really is another attribute.
  assert.equal(frameXmlAttributeKey(" type"), " type");
  assert.equal(frameXmlAttributeKey(42), undefined);
  assert.equal(frameXmlAttributeKey(undefined), undefined);
});

test("the three-argument GetAttribute is the client's five-step wildcard cascade", () => {
  assert.deepEqual(
    frameXmlAttributeCandidates("shift-", "action", "1"),
    ["shift-action1", "shift-action*", "*action1", "*action*", "action"],
  );
  // `SecureButton_GetAttribute` calls it with two empty strings; the first and last candidate are
  // then the same string, which is harmless and deliberately not filtered.
  assert.deepEqual(
    frameXmlAttributeCandidates("", "type", ""),
    ["type", "type*", "*type", "*type*", "type"],
  );
  // The prefix and the suffix are lower-cased with the name, or `SHIFT-` would miss `shift-`.
  assert.deepEqual(frameXmlAttributeCandidates("SHIFT-", "Action", "1")[0], "shift-action1");
  assert.deepEqual(frameXmlAttributeCandidates("", 7, ""), []);
});

test("an XML <Attribute> carries its declared type", () => {
  assert.equal(frameXmlAttributeValue("number", "6"), 6);
  assert.equal(frameXmlAttributeValue("boolean", "true"), true);
  assert.equal(frameXmlAttributeValue("boolean", "false"), false);
  assert.equal(frameXmlAttributeValue(undefined, "action"), "action");
  // A number that will not parse stays a string: NaN in `(page - 1) * 12` is silently wrong.
  assert.equal(frameXmlAttributeValue("number", "six"), "six");
});

test("the bridge stores attributes, answers both forms, and reads <Attributes> out of XML", () => {
  const bridge = new FrameXmlUiBridge(new FrameXmlTemplateRegistry());
  const parsed = parseFrameXml([
    "<Ui>",
    '  <Frame name="Bar">',
    "    <Attributes>",
    '      <Attribute name="actionpage" type="number" value="6"/>',
    '      <Attribute name="showParty" type="boolean" value="true"/>',
    "    </Attributes>",
    "    <Frames>",
    '      <Button name="BarButton"/>',
    "    </Frames>",
    "  </Frame>",
    "</Ui>",
  ].join("\n"));
  const bar = bridge.instantiate(parsed.root.children[0]);
  assert.ok(bar, "the frame was built");
  assert.equal(bridge.declaredAttributes, 2);
  // Case-insensitive on the way in as well as on the way out.
  assert.equal(bridge.GetAttribute(bar, "ACTIONPAGE"), 6);
  assert.equal(bridge.GetAttribute(bar, "showparty"), true);

  const button = bridge.getFrame("BarButton");
  assert.ok(button);
  assert.equal(bridge.SetAttribute(button, "Type", "action"), "type");
  assert.equal(bridge.GetAttribute(button, "type"), "action");
  // The three-argument form: exact spelling first, then the wildcards, then the bare name.
  bridge.SetAttribute(button, "*type1", "target");
  assert.equal(bridge.GetAttribute(button, "", "type", "1", 3), "target");
  bridge.SetAttribute(button, "type1", "spell");
  assert.equal(bridge.GetAttribute(button, "", "type", "1", 3), "spell");
  // …and the one-argument form is a plain lookup that never falls back.
  assert.equal(bridge.GetAttribute(button, "type"), "action");
  assert.equal(bridge.GetAttribute(button, "nothing"), undefined);
});

test("SetCooldown is stored on the widget in GetTime seconds", () => {
  const bridge = new FrameXmlUiBridge(new FrameXmlTemplateRegistry());
  const frame = bridge.CreateFrame("Cooldown", "Sweep");
  assert.ok(frame);
  assert.deepEqual({ ...frame.cooldown }, { start: 0, duration: 0 });
  bridge.SetCooldown(frame, 1000.5, 10);
  assert.deepEqual({ ...frame.cooldown }, { start: 1000.5, duration: 10 });
  // A nonsense duration is clamped rather than propagated into a division.
  bridge.SetCooldown(frame, Number.NaN, -3);
  assert.deepEqual({ ...frame.cooldown }, { start: 0, duration: 0 });
});

test("the two attribute methods graduated out of the promotion list", () => {
  assert.deepEqual(FRAMEXML_PROMOTED_METHODS, [], "nothing is a recording no-op any more");
  const names = FRAMEXML_IMPLEMENTED_METHODS.map((entry) => entry.name);
  assert.deepEqual(names, ["SetAttribute", "GetAttribute", "SetCooldown"]);
  for (const entry of FRAMEXML_IMPLEMENTED_METHODS) {
    assert.ok(entry.reason.length > 40, `${entry.name} must carry its history`);
  }
});

/* ------------------------------------------------------------- the seam */

test("every seam binding is answered by the canned seam, with the client's own shapes", () => {
  const seam = new CannedWorldSeam();
  const fired = [];
  seam.attach({ fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => 1000 });
  // Attaching has to announce itself: `ActionButton_Update` only registers its dozen events once a
  // slot answers HasAction, and at OnLoad the seam was not there yet.
  assert.ok(fired.some(([event, slot]) => event === FRAMEXML_SEAM_EVENTS.actionSlotChanged && slot === 0));
  assert.ok(fired.some(([event]) => event === FRAMEXML_SEAM_EVENTS.health));

  const call = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);
  assert.deepEqual(call("HasAction", 1), [true]);
  assert.deepEqual(call("HasAction", 13), [false]);
  assert.deepEqual(call("GetActionTexture", 1), ["Interface\\Icons\\Ability_Rogue_Ambush"]);
  assert.deepEqual(call("GetActionTexture", 13), []);
  assert.deepEqual(call("GetActionText", 1), [], "only a macro has text");
  assert.deepEqual(call("GetActionTooltip", 1), ["spell", 78, "Удар героя", ""],
    "action tooltip keeps the server spell id separate from the 1-based slot");
  assert.deepEqual(call("GetActionTooltip", 11),
    ["item", 13446, "Огромный флакон с лечебным зельем", ""],
    "non-spell action payload keeps its kind and item entry");
  assert.deepEqual(call("GetActionTooltip", 13), [], "empty action slots have no tooltip payload");
  assert.deepEqual(call("GetActionCount", 11), [5]);
  assert.deepEqual(call("GetActionCount", 1), [0]);
  assert.deepEqual(call("IsStackableAction", 11), [true]);
  assert.deepEqual(call("IsStackableAction", 1), [false]);
  assert.deepEqual(call("GetActionBarPage"), [1]);
  assert.deepEqual(call("GetBonusBarOffset"), [0]);
  assert.deepEqual(call("UnitName", "player"), [CANNED_PLAYER.name]);
  assert.deepEqual(call("UnitName", "target"), [], "nothing but the player exists");
  assert.deepEqual(call("UnitLevel", "player"), [60]);
  assert.deepEqual(call("UnitClass", "player"), ["Воин", "WARRIOR"]);
  assert.deepEqual(call("UnitHealthMax", "player"), [CANNED_PLAYER.healthMax]);
  assert.deepEqual(call("UnitPowerType", "player"), [1, "RAGE"]);
  // The raise this answer exists for: MainMenuBar.lua:317 compares it with `>= 3`.
  assert.equal(call("GetRestState")[0], 1);
  // A self-cast has no range indicator, and the corpus tests `== 0` / `== 1` explicitly.
  assert.deepEqual(call("IsActionInRange", 9), []);
  assert.deepEqual(call("IsActionInRange", 1), [1]);
  // Every declared name has a binding and every binding is declared.
  assert.deepEqual([...FRAMEXML_SEAM_NAMES].sort(), Object.keys(FRAMEXML_SEAM_BINDINGS).sort());
});

test("a click starts a cooldown and says so, in the client's own units", () => {
  const seam = new CannedWorldSeam();
  let now = 500;
  const fired = [];
  seam.attach({ fire: (event) => { fired.push(event); return 1; }, now: () => now });
  fired.length = 0;
  assert.deepEqual(seam.actionCooldown(1), [0, 0, 0]);
  seam.useAction(1);
  // start, duration, enable — the triple `CooldownFrame_SetTimer` multiplies.
  assert.deepEqual(seam.actionCooldown(1), [500, CANNED_CLICK_COOLDOWN_SECONDS, 1]);
  assert.ok(fired.includes(FRAMEXML_SEAM_EVENTS.actionCooldown));
  assert.deepEqual(seam.actionUsable(1), [false, false], "a recovering action is not usable");
  // A spell with a real recovery time uses its own, not the seam's number.
  seam.useAction(10);
  assert.equal(seam.actionCooldown(10)[1], 60);
  // It retires itself, and fires the event that redraws the sweep.
  now = 500 + CANNED_CLICK_COOLDOWN_SECONDS + 0.1;
  fired.length = 0;
  seam.tick(now);
  assert.deepEqual(seam.actionCooldown(1), [0, 0, 0]);
  assert.ok(fired.includes(FRAMEXML_SEAM_EVENTS.actionCooldown));
});

test("the canned bar is twelve real rows of this dataset", () => {
  assert.equal(CANNED_ACTION_BAR.length, 12);
  assert.deepEqual(CANNED_ACTION_BAR.map((entry) => entry.slot), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  for (const entry of CANNED_ACTION_BAR) {
    assert.ok(entry.id > 0, `${entry.name} carries its id`);
    assert.ok(entry.iconId > 0, `${entry.name} carries the icon number behind the picture`);
    assert.match(entry.texture, /^Interface\\Icons\\/, `${entry.name} answers a client texture name`);
  }
  // Exactly one stackable slot, or `ActionButton_UpdateCount` cannot be seen to run.
  assert.equal(CANNED_ACTION_BAR.filter((entry) => entry.count).length, 1);
  // A power change is announced with a *different* event per power type; a warrior is rage.
  assert.equal(FRAMEXML_POWER_EVENTS[CANNED_PLAYER.powerType], "UNIT_RAGE");
});

/* --------------------------------------------------------- the vertical */

test("the vertical TOC is a subset of the real one, in the real one's order", withClient, async () => {
  const provider = await corpusProvider();
  const toc = await provider.read("interface/framexml/framexml.toc");
  const real = toc.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  let previous = -1;
  for (const entry of FRAMEXML_VERTICAL_TOC) {
    const index = real.findIndex((line) => line.toLowerCase() === entry.toLowerCase());
    assert.ok(index >= 0, `${entry} is a real TOC entry`);
    assert.ok(index > previous, `${entry} keeps the TOC's own order`);
    previous = index;
  }
  // A synthetic TOC is a real TOC: the loader's own `..` resolution has to keep working.
  const subset = subsetTocProvider(provider, FRAMEXML_VERTICAL_TOC);
  const body = await subset.provider.read(subset.toc);
  assert.match(body, /^## Interface: 30300/);
  assert.equal(body.trim().split("\n").length, FRAMEXML_VERTICAL_TOC.length + 1);
  assert.ok(await subset.provider.read("interface/framexml/actionbutton.lua"));
});

test("the action bar vertical runs on the client's own corpus", withClient, async () => {
  const provider = await corpusProvider();
  const seam = new CannedWorldSeam();
  const boot = new FrameXmlBoot({
    provider, locale: "ruRU", subset: FRAMEXML_ACTION_BAR_TOC, seam,
    screen: () => ({ width: 1024, height: 768 }),
  });
  const inventory = await boot.load();

  // ---- what the subset costs, against the whole corpus' 335 files and 25,308 widgets ----
  // The closure includes MoneyInputFrame, MirrorTimer, TutorialFrame and promoted GameTime
  // with its stock relative Lua. Those last two files raise the old 67-file ceiling to 69.
  // StackSplitFrame.xml/.lua (stock TOC line 49, loaded for the bag gate) sits inside this
  // MultiActionBars prefix too: 2 more files, measured 71. So do FadingFrame.xml/.lua and
  // ZoneText.xml/.lua (stock TOC lines 50-51, the zone banners): 4 more, measured 75.
  assert.ok(inventory.files.total <= 75, `files: ${inventory.files.total}`);
  assert.ok(inventory.files.total >= 30, `files: ${inventory.files.total}`);
  assert.equal(inventory.files.missing.length, 0);
  assert.equal(inventory.lua.failed, 0, "no file fails to load on the subset either");
  assert.ok(inventory.widgets.total >= 700, `widgets: ${inventory.widgets.total}`);
  // Includes the authored tutorial alert regions; the bound still rejects runaway trees.
  assert.ok(inventory.widgets.total <= 1850, `widgets: ${inventory.widgets.total}`);
  // The ceiling that says the subset is a *clean* cut and not merely a short one.
  assert.ok(inventory.lua.errorsRaised <= 5, `errors raised: ${inventory.lua.errorsRaised}`);

  // ---- the bar exists, and it is the client's own ----
  const frame = (name) => boot.bridge.getFrame(name);
  assert.ok(frame("MainMenuBar"), "the bar");
  assert.ok(frame("MainMenuBarLeftEndCap"), "the gryphons are the bar's own art");
  assert.ok(frame("MainMenuBarRightEndCap"));
  for (let index = 1; index <= 12; index += 1) {
    const button = frame(`ActionButton${index}`);
    assert.ok(button, `ActionButton${index}`);
    assert.equal(button.visible, true, `ActionButton${index} is shown because it has an action`);
    // The attributes `ActionButton_OnLoad` writes, now that writing one means something.
    assert.equal(boot.bridge.GetAttribute(button, "type"), "action");
    assert.equal(boot.bridge.GetAttribute(button, "useparent-actionpage"), true);
    const icon = frame(`ActionButton${index}Icon`);
    assert.ok(icon, `ActionButton${index}Icon`);
    assert.equal(icon.texture, CANNED_ACTION_BAR[index - 1].texture,
      `slot ${index} draws the seam's own texture answer`);
    // A layer region with neither anchors nor a size fills its parent — without that the icon is
    // laid out at the picture's own size, below the button it belongs to.
    assert.equal(icon.setAllPoints, true, `ActionButton${index}Icon fills its button`);
  }
  // The one stackable slot carries its count, and no other slot does.
  assert.equal(frame("ActionButton11Count").text, "5");
  assert.equal(frame("ActionButton1Count").text, "");

  // ---- the cooldown reached the widget ----
  const cooldown = frame("ActionButton10Cooldown");
  assert.ok(cooldown, "the Cooldown widget exists");
  assert.equal(cooldown.visible, true, "CooldownFrame_SetTimer showed it");
  assert.equal(cooldown.cooldown.duration, 60, "Блок щитом's own recovery time, in seconds");
  assert.ok(cooldown.cooldown.start > 0);
  assert.equal(frame("ActionButton1Cooldown").visible, false, "and hid the ones with no cooldown");

  // ---- the census F3 adds ----
  assert.equal(inventory.secure.seam, "canned");
  assert.ok(inventory.secure.setAttributeCalls >= 60, `SetAttribute: ${inventory.secure.setAttributeCalls}`);
  assert.ok(inventory.secure.getAttributeCalls >= 500, `GetAttribute: ${inventory.secure.getAttributeCalls}`);
  assert.ok(inventory.secure.attributeDispatches >= 60,
    `OnAttributeChanged: ${inventory.secure.attributeDispatches}`);
  assert.ok(inventory.secure.declaredInXml >= 10, `XML attributes: ${inventory.secure.declaredInXml}`);
  assert.ok(inventory.secure.setCooldownCalls >= 1);
  const seamCalls = new Map(inventory.secure.seamCalls.map((entry) => [entry.name, entry.calls]));
  for (const name of ["HasAction", "GetActionTexture", "GetActionCooldown", "IsUsableAction",
    "GetActionBarPage", "GetActionCount"]) {
    assert.ok((seamCalls.get(name) ?? 0) > 0, `${name} was actually asked`);
  }

  // ---- and the click, which is the whole chain in one call ----
  const before = frame("ActionButton1Cooldown").cooldown.duration;
  assert.equal(before, 0);
  boot.bridge.Click(frame("ActionButton1"), "LeftButton", false);
  const after = frame("ActionButton1Cooldown").cooldown;
  assert.equal(after.duration, CANNED_CLICK_COOLDOWN_SECONDS,
    "SecureActionButton_OnClick → GetAttribute(prefix,name,suffix) → UseAction → the sweep");
  assert.equal(frame("ActionButton1Cooldown").visible, true);

  // The live action bar owns twelve 1-based stock slots. Exercise every rendered button through
  // the actual FrameXML click path; empty-slot fabrication would leave one of these cooldowns at
  // zero, while a shifted 0-based mapping would click the wrong slot.
  for (let index = 1; index <= 12; index += 1) {
    const button = frame(`ActionButton${index}`);
    const slotCooldown = frame(`ActionButton${index}Cooldown`);
    assert.ok(button && slotCooldown, `stock action slot ${index} has button and cooldown`);
    boot.bridge.Click(button, "LeftButton", false);
    assert.ok(slotCooldown.cooldown.duration > 0,
      `stock action slot ${index} click reaches the seam action`);
  }

  console.log(`[framexml F3] подмножество: ${inventory.files.total} файлов, `
    + `${(inventory.files.bytes / 1024).toFixed(0)} КиБ, ${inventory.widgets.total} виджетов, `
    + `ошибок ${inventory.lua.errorsRaised} (различных ${inventory.errors.length}); `
    + `атрибуты Set ${inventory.secure.setAttributeCalls} / Get ${inventory.secure.getAttributeCalls}, `
    + `OnAttributeChanged ${inventory.secure.attributeDispatches}; шов отвечает на `
    + `${inventory.secure.seamCalls.reduce((sum, entry) => sum + entry.calls, 0)} вызовов`);
  for (const error of inventory.errors) {
    console.log(`[framexml F3] осталось: ${error.count} ${error.file}:${error.line}: ${error.message}`);
  }
  boot.close();
});

/**
 * The whole corpus with a world in it — the slice's own «not worse than F2» claim, pinned.
 *
 * `tests/framexml-corpus.test.mjs` measures the boot with **no** seam. This is the same corpus
 * with the canned world attached, as in `framexml.html`. The tighter ceiling protects the APIs
 * now resolved by the live seam instead of retaining F2's historical 126 / 57 allowance.
 */
test("the whole corpus with a world seam is better than F2 left it", withClient, async () => {
  const provider = await corpusProvider();
  const boot = new FrameXmlBoot({
    provider, locale: "ruRU", seam: new CannedWorldSeam(),
    screen: () => ({ width: 1024, height: 768 }),
  });
  const inventory = await boot.load();
  assert.equal(inventory.lua.failed, 0);
  assert.ok(inventory.lua.errorsRaised <= 30,
    `errors raised with a seam: ${inventory.lua.errorsRaised} (current ceiling: 30)`);
  assert.ok(inventory.errors.length <= 24,
    `distinct failures with a seam: ${inventory.errors.length} (current ceiling: 24)`);
  assert.equal(inventory.errors.filter((entry) => /unitpopup/.test(entry.file)).length, 0,
    "stock unit menus resolve authoritative loot settings without nil arithmetic");
  // The two raises F2 named as F3's: `UnitLevel("player")` at MainMenuBarMicroButtons.lua:39.
  assert.equal(
    inventory.errors.filter((entry) => /mainmenubarmicrobuttons/.test(entry.file)).length, 0,
    "the synthetic self F2 deferred is answered",
  );
  const answered = inventory.secure.seamCalls.reduce((sum, entry) => sum + entry.calls, 0);
  assert.ok(answered >= 2000, `seam-answered calls on the whole corpus: ${answered}`);
  console.log(`[framexml F3] весь корпус со швом: ошибок ${inventory.lua.errorsRaised} `
    + `(различных ${inventory.errors.length}), шов отвечает на ${answered} вызовов, `
    + `виджетов ${inventory.widgets.total}`);
  boot.close();
  sharedChain.close();
  sharedChain = undefined;
});
