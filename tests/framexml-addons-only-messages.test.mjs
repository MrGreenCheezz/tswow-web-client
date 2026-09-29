import assert from "node:assert/strict";
import test, { after } from "node:test";

// MPQ-backed: the «WebClient + TSWoW add-ons» mode (`addonsOnly`) over the production vertical and
// the canned world. The native HUD stays; over it only what the modules draw — and that includes the
// stock StaticPopup dialogs and UIErrorsFrame lines a module raises itself (tswow-store's purchase
// confirmation, retail-talents' resets, survival's warnings). The server's questions and notices stay
// the native prompts' and the native notice line's.
//
// Frames are never handed to assert: names, counts and booleans only.
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
const presentationModule = await import("../dist/code/browser/framexml/FrameXmlTsAddonPresentation.js");
const {
  FrameXmlTsAddonPresentation, markFrameXmlNativeHud, escapeFrameXmlAddonDialogs, frameXmlAddonDialogsEscapePublished,
} = presentationModule;
const { FRAMEXML_STATIC_POPUP_COUNT } = await import("../dist/code/browser/framexml/FrameXmlPopupsOwner.js");
const { frameXmlPopupsPublished } = await import("../dist/code/browser/framexml/FrameXmlPopupsController.js");
const messages = await import("../dist/code/browser/framexml/FrameXmlAddonsOnlyMessages.js");
const decoder = new TextDecoder("utf-8");

const DIALOG = "WEBCLIENT_ADDON_TEST_CONFIRM";
const MODULE_CHUNK = "@interface/framexml/tsaddons/addons-only-test/addon/addon.lua";

/** The mount's `addonsOnly` load: the native-HUD flag before the corpus, the canned world as the seam. */
async function load() {
  const seam = new CannedWorldSeam();
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        const data = await chain.read(path);
        return data ? decoder.decode(data) : undefined;
      },
    },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, exercise: true, screen: () => ({ width: 1365, height: 768 }),
  });
  markFrameXmlNativeHud(boot);
  const inventory = await boot.load();
  return { boot, seam, inventory };
}

/** What FrameXmlWorldMount's `addonsOnly` branch builds over the loaded boot; `raises` counts host raises. */
function addonsOnly(boot, seam) {
  const presentation = new FrameXmlTsAddonPresentation(boot);
  const counter = { raises: 0 };
  const surfaces = messages.mountFrameXmlAddonsOnlySurfaces(boot, seam, { raise() { counter.raises += 1; } });
  return { presentation, surfaces, counter };
}

/** Run a Lua function body and return its values; a Lua failure raises. */
function lua(boot, code, results = 1) {
  const fn = boot.vm.compileFunction(code, "addons-only-test", []);
  assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
  try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
}

/** A module's own dialog, declared the way tswow-store and retail-talents declare theirs. */
function declareDialog(boot) {
  const declared = boot.vm.execute(`
    StaticPopupDialogs["${DIALOG}"] = {
      text = "Подтвердить покупку?\\n%s", button1 = "Да", button2 = "Нет",
      OnAccept = function() AddonAccepted = (AddonAccepted or 0) + 1 end,
      OnCancel = function(_, _, reason) AddonCancelled = reason end,
      timeout = 0, whileDead = true, hideOnEscape = true,
    }
  `, MODULE_CHUNK);
  assert.equal(declared.ok, true, declared.error);
}

/** Every visible StaticPopup as `which|text`. */
function visible(boot) {
  const rows = lua(boot, `
    local rows = {}
    for index = 1, STATICPOPUP_NUMDIALOGS do
      local dialog = _G["StaticPopup" .. index]
      if dialog:IsShown() then rows[#rows + 1] = tostring(dialog.which) .. "|" .. (dialog.text:GetText() or "") end
    end
    return table.concat(rows, "\\0")
  `)[0];
  return rows ? rows.split("\0") : [];
}

const frameNamed = (boot, name) => boot.bridge.getFrame(name);

test("a module's own dialog is drawn on top, sized by its measured text and answered by its OnAccept", withClient, async () => {
  const { boot, seam } = await load();
  let surfaces;
  try {
    const mounted = addonsOnly(boot, seam);
    surfaces = mounted.surfaces;
    const { presentation, counter } = mounted;
    assert.equal(surfaces.adapters, 5, "CAMP and QUIT OnShow, ShowReadyCheck, the deferred resize and the refused-invite line");
    const errors = boot.errorCount;
    declareDialog(boot);
    const dialog = frameNamed(boot, "StaticPopup1");
    assert.equal(presentation.includes(dialog), true, "StaticPopup1 is one of the painted stock surfaces");
    assert.equal(presentation.layoutOnly(dialog), false, "painted, not a bare layout ancestor");
    assert.equal(presentation.includes(frameNamed(boot, "StaticPopup1Button1")), true, "and so are its buttons");
    // What the bridge answers at Show before the renderer has measured the wrapped text (measured 0
    // on the rich route: every dialog opened 61 high, its text under the buttons).
    lua(boot, "StaticPopup1Text.GetHeight = function() return 0 end", 0);
    assert.equal(counter.raises, 0);
    assert.equal(lua(boot, `local shown = StaticPopup_Show("${DIALOG}", "Кольцо — 150")
      return shown and shown:GetName() or ""`)[0], "StaticPopup1");
    assert.equal(dialog.visible, true);
    assert.equal(counter.raises, 1, "the overlay rises over the native windows opened since");
    assert.deepEqual(visible(boot), [`${DIALOG}|Подтвердить покупку?\nКольцо — 150`]);
    assert.equal(lua(boot, "return StaticPopup1:GetHeight()")[0], 61, "32 + 0 + 8 + 21: sized from an unmeasured text");
    // The renderer's measure a frame later (two lines): the adapter resizes as stock's own
    // DISPLAY_SIZE_CHANGED handler would.
    lua(boot, "StaticPopup1Text.GetHeight = function() return 24 end", 0);
    boot.bridge.tick(0.02);
    assert.equal(lua(boot, "return StaticPopup1:GetHeight()")[0], 85, "32 + 24 + 8 + 21 (StaticPopup.lua:2922)");
    assert.equal(boot.bridge.Click(frameNamed(boot, "StaticPopup1Button1"), "LeftButton", false) !== false, true);
    assert.equal(boot.vm.getGlobal("AddonAccepted"), 1, "«Да» ran the module's OnAccept once");
    assert.equal(dialog.visible, false, "and closed the dialog");
    assert.equal(surfaces.counts().popups, 1, "one dialog shown this session");
    assert.equal(boot.errorCount, errors, "no Lua error");
  } finally {
    surfaces?.dispose();
    boot.close();
  }
});

test("UIErrorsFrame says the module's lines, not the world's, even after /uierrorson", withClient, async () => {
  const { boot, seam } = await load();
  let surfaces;
  try {
    const errorsFrame = frameNamed(boot, "UIErrorsFrame");
    for (const event of messages.FRAMEXML_ADDONS_ONLY_WORLD_MESSAGE_EVENTS) {
      assert.equal(errorsFrame.registeredEvents.has(event), true, `UIErrorsFrame_OnLoad registered ${event}`);
    }
    const mounted = addonsOnly(boot, seam);
    surfaces = mounted.surfaces;
    const { presentation, counter } = mounted;
    assert.equal(surfaces.messagesDetached, true);
    for (const event of messages.FRAMEXML_ADDONS_ONLY_WORLD_MESSAGE_EVENTS) {
      assert.equal(errorsFrame.registeredEvents.has(event), false, `${event} no longer reaches UIErrorsFrame`);
    }
    assert.equal(presentation.includes(errorsFrame), true, "UIErrorsFrame is one of the painted stock surfaces");
    const errors = boot.errorCount;
    const before = boot.bridge.GetNumMessages(errorsFrame);
    // survival-ui.ts warnOnce: UIErrorsFrame.AddMessage(text, 1, 0.25, 0.15, 1, false).
    const added = boot.vm.execute('UIErrorsFrame:AddMessage("Голод начинает ослаблять вас!", 1, 0.25, 0.15, 1, false)', MODULE_CHUNK);
    assert.equal(added.ok, true, added.error);
    assert.equal(boot.bridge.GetNumMessages(errorsFrame), before + 1, "the module's line is there");
    assert.equal(boot.bridge.GetMessageInfo(errorsFrame, before + 1)[0], "Голод начинает ослаблять вас!");
    assert.equal(counter.raises, 1, "the overlay rises with the line");
    // The seam's own UI_ERROR_MESSAGE (FrameXmlLoot, FrameXmlTrade, FrameXmlBank …) is the native
    // notice's; in the stock frame it would be said twice.
    const world = () => {
      boot.pump.fire("UI_ERROR_MESSAGE", "Вы не можете этого сделать.");
      boot.pump.fire("UI_INFO_MESSAGE", "Задание выполнено.");
      boot.pump.fire("SYSMSG", "Сервер будет перезапущен.", 1, 1, 0);
    };
    world();
    assert.equal(boot.bridge.GetNumMessages(errorsFrame), before + 1, "no world message reached the stock frame");
    // /uierrorson (ChatFrame.lua SlashCmdList.UI_ERRORS_ON) and a module's suppress-then-restore
    // register UI_ERROR_MESSAGE again; in this mode the three world events stay off the frame.
    assert.equal(boot.vm.execute(`
      SlashCmdList.UI_ERRORS_OFF("")
      SlashCmdList.UI_ERRORS_ON("")
      UIErrorsFrame:RegisterEvent("UI_ERROR_MESSAGE")
      UIErrorsFrame:RegisterEvent("UI_INFO_MESSAGE")
      UIErrorsFrame:RegisterEvent("SYSMSG")
    `, MODULE_CHUNK).ok, true);
    for (const event of messages.FRAMEXML_ADDONS_ONLY_WORLD_MESSAGE_EVENTS) {
      assert.equal(errorsFrame.registeredEvents.has(event), false, `${event} stays off after a re-register`);
    }
    world();
    assert.equal(boot.bridge.GetNumMessages(errorsFrame), before + 1, "still no world message in the stock frame");
    assert.equal(counter.raises, 1, "and no raise for a line that was not said");
    // A module's own registration of another event on the frame is its own.
    assert.equal(boot.vm.execute('UIErrorsFrame:RegisterEvent("PLAYER_TARGET_CHANGED")', MODULE_CHUNK).ok, true);
    assert.equal(errorsFrame.registeredEvents.has("PLAYER_TARGET_CHANGED"), true);
    assert.equal(boot.vm.execute('UIErrorsFrame:UnregisterEvent("PLAYER_TARGET_CHANGED")', MODULE_CHUNK).ok, true);
    assert.equal(surfaces.counts().errors, 1, "one module line this session");
    assert.equal(boot.errorCount, errors, "no Lua error");
    // A module that answers an event through the stock handler itself still reaches the frame.
    assert.equal(boot.vm.execute('UIErrorsFrame_OnEvent(UIErrorsFrame, "UI_ERROR_MESSAGE", "Нужно больше воды.")',
      MODULE_CHUNK).ok, true);
    assert.equal(boot.bridge.GetNumMessages(errorsFrame), before + 2);
    assert.equal(counter.raises, 2);
  } finally {
    surfaces?.dispose();
    boot.close();
  }
});

test("the server's questions stay native: no stock dialog for an invite or a resurrection, nothing published", withClient, async () => {
  const { boot, seam } = await load();
  let surfaces;
  try {
    const mounted = addonsOnly(boot, seam);
    surfaces = mounted.surfaces;
    const world = seam.popupsWorld;
    assert.equal(seam.popups.popupsOwned, false, "the popup model does not hand the confirmations to stock");
    assert.equal(frameXmlPopupsPublished(), false, "the popup owner is not published: every native prompt keeps asking");
    world.invite("Джайна");
    seam.popups.tick();
    world.offerResurrect(0x52n);
    seam.popups.tick();
    assert.deepEqual(visible(boot), [], "PARTY_INVITE_REQUEST and RESURRECT_REQUEST did not fire");
    assert.equal(surfaces.counts().serverQuestions, "native");
    assert.equal(surfaces.counts().popups, 0);
    assert.equal(mounted.counter.raises, 0);
    // Positive control: the same world, handed to stock, shows both — the pipeline above was live.
    seam.popups.popupsOwned = true;
    assert.deepEqual(visible(boot).map((row) => row.split("|")[0]).sort(), ["PARTY_INVITE", "RESURRECT_NO_SICKNESS"]);
    assert.equal(surfaces.counts().serverQuestions, "stock");
  } finally {
    seam.popups.popupsOwned = false;
    surfaces?.dispose();
    boot.close();
  }
});

test("Escape closes the open dialog alone through stock StaticPopup_EscapePressed, until dispose", withClient, async () => {
  const { boot, seam } = await load();
  let surfaces;
  try {
    surfaces = addonsOnly(boot, seam).surfaces;
    assert.equal(frameXmlAddonDialogsEscapePublished(), true);
    assert.equal(escapeFrameXmlAddonDialogs(), false, "nothing up: the press goes on down the native chain");
    declareDialog(boot);
    lua(boot, `StaticPopup_Show("${DIALOG}", "Кольцо — 150")`, 0);
    assert.equal(escapeFrameXmlAddonDialogs(), true, "a hideOnEscape dialog takes the press");
    assert.deepEqual(visible(boot), [], "Escape closed it");
    assert.equal(boot.vm.getGlobal("AddonCancelled"), "clicked", "through its own OnCancel, as stock Escape does");
    assert.equal(boot.vm.getGlobal("AddonAccepted"), undefined);
    assert.equal(escapeFrameXmlAddonDialogs(), false, "the next press is the native chain's");
    // A dialog without hideOnEscape (stock DEATH-like) is not Escape's to close.
    assert.equal(boot.vm.execute(`StaticPopupDialogs.WEBCLIENT_ADDON_TEST_STAY = { text = "x", button1 = "Да", timeout = 0,
      whileDead = true }; StaticPopup_Show("WEBCLIENT_ADDON_TEST_STAY")`, MODULE_CHUNK).ok, true);
    assert.equal(escapeFrameXmlAddonDialogs(), false);
    assert.equal(visible(boot).length, 1);
    lua(boot, 'StaticPopup_Hide("WEBCLIENT_ADDON_TEST_STAY")', 0);
    surfaces.dispose();
    assert.equal(frameXmlAddonDialogsEscapePublished(), false, "dispose withdrew the Escape step: no closure over the VM stays");
    lua(boot, `StaticPopup_Show("${DIALOG}", "Кольцо — 150")`, 0);
    assert.equal(escapeFrameXmlAddonDialogs(), false, "and a dialog up now is not Escape's any more");
    assert.equal(visible(boot).length, 1);
    surfaces.dispose();
    assert.equal(boot.errorCount, 0);
  } finally {
    surfaces?.dispose();
    boot.close();
  }
});

test("the stock surfaces are one exported list: four StaticPopups, UIErrorsFrame and the module dependencies", () => {
  const surfaces = presentationModule.FRAMEXML_ADDONS_ONLY_SURFACES;
  assert.equal(FRAMEXML_STATIC_POPUP_COUNT, 4);
  for (let index = 1; index <= FRAMEXML_STATIC_POPUP_COUNT; index += 1) {
    assert.equal(surfaces.includes(`StaticPopup${index}`), true, `StaticPopup${index}`);
  }
  for (const name of ["UIErrorsFrame", "ItemSocketingFrame", "GameTooltip"]) assert.equal(surfaces.includes(name), true, name);
  assert.equal(Object.isFrozen(surfaces), true);
});

test("measured cost of painting the surfaces: frames added to the painted set and one refresh", withClient, async () => {
  const { boot, seam } = await load();
  let surfaces;
  try {
    const mounted = addonsOnly(boot, seam);
    surfaces = mounted.surfaces;
    const { presentation } = mounted;
    const probe = frameNamed(boot, "UIParent");
    presentation.includes(probe);
    const painted = boot.bridge.frames.filter((frame) => !presentation.layoutOnly(frame)).length;
    const samples = [];
    for (let round = 0; round < 400; round += 1) {
      boot.bridge.touch();
      const started = performance.now();
      presentation.includes(probe);
      samples.push(performance.now() - started);
    }
    samples.sort((left, right) => left - right);
    const median = samples[samples.length >> 1] * 1000;
    console.log(`[addons-only] painted ${painted} of ${boot.bridge.frames.length} frames · refresh median ${median.toFixed(1)} µs`);
    assert.ok(Number.isFinite(median));
  } finally {
    surfaces?.dispose();
    boot.close();
  }
});
