import assert from "node:assert/strict";
import test, { after } from "node:test";

// MPQ-backed: the stock StaticPopup dialogs and ReadyCheckFrame of the production vertical, driven
// over the canned popup world. Everything here runs the real 3.3.5 Lua — UIParent_OnEvent's
// branches, StaticPopup_Show/OnUpdate/OnClick, ReadyCheck.xml — against FrameXmlPopups.ts.
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
const {
  FrameXmlCannedPopupsWorld, createCannedFrameXmlPopups, FRAMEXML_CANNED_SPIRIT_HEALER_GUID,
  FRAMEXML_CANNED_INNKEEPER_GUID, FRAMEXML_CANNED_TRAINER_GUID,
} = await import("../dist/code/browser/framexml/FrameXmlPopupsCanned.js");
const {
  createFrameXmlPopupsOwner, frameXmlPopupsGate, installFrameXmlPopupsAdapters,
} = await import("../dist/code/browser/framexml/FrameXmlPopupsOwner.js");
const { FRAMEXML_NO_RELEASE_WINDOW_FLAG } = await import("../dist/code/browser/framexml/FrameXmlPopups.js");
const { frameXmlPopupsLeftToNative } = await import("../dist/code/browser/framexml/FrameXmlPopupsController.js");
const { markFrameXmlPopupAnswered } = await import("../dist/code/browser/framexml/FrameXmlPopupsAnswered.js");
const decoder = new TextDecoder("utf-8");
const normalize = (path) => path.replaceAll("\\", "/").toLowerCase();

/** A canned seam whose popup model runs on a clock the test moves. */
function scriptedSeam() {
  const clock = { now: 1_000_000 };
  const { model, world } = createCannedFrameXmlPopups(new FrameXmlCannedPopupsWorld(() => clock.now));
  const seam = new CannedWorldSeam();
  Object.defineProperty(seam, "popups", { value: model, configurable: true });
  Object.defineProperty(seam, "popupsWorld", { value: world, configurable: true });
  // CannedWorldSeam has no bag cursor; LiveWorldSeam's one cursor is what the popup world keeps.
  Object.defineProperty(seam, "cursorHasItem", { value: () => world.cursor !== undefined, configurable: true });
  Object.defineProperty(seam, "clearCursor", { value: () => world.clearCursor(), configurable: true });
  return { seam, world, model, clock };
}

async function load(seam) {
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        const data = await chain.read(path);
        return data ? decoder.decode(data) : undefined;
      },
    },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, exercise: true, screen: () => ({ width: 1365, height: 768 }),
  });
  const started = performance.now();
  const inventory = await boot.load();
  return { boot, inventory, loadMs: performance.now() - started };
}

/** Run a Lua function body and return its values; a Lua failure raises. */
function lua(boot, code, results = 1) {
  const fn = boot.vm.compileFunction(code, "popups-test", []);
  assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
  try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
}

/** A renderer stand-in: one element per frame carrying the renderer's identity attributes. */
function renderer() {
  const elements = new Map();
  return {
    elementFor(frame) {
      if (!elements.has(frame)) {
        const attributes = new Map([["data-framexml-name", frame.name], ["data-framexml-type", frame.type]]);
        elements.set(frame, { dataset: {}, parentElement: null, getAttribute: (name) => attributes.get(name) ?? null });
      }
      return elements.get(frame);
    },
  };
}

/** Every visible StaticPopup as `which|text|button1|button1 enabled|button2`. */
function visible(boot) {
  const rows = lua(boot, `
    local rows = {}
    for index = 1, STATICPOPUP_NUMDIALOGS do
      local dialog = _G["StaticPopup" .. index]
      if dialog:IsShown() then
        rows[#rows + 1] = table.concat({ dialog.which, dialog.text:GetText() or "",
          dialog.button1:IsShown() and dialog.button1:GetText() or "-",
          -- 3.3.5's Button:IsEnabled answers 1 or 0 (LFDFrame.lua:222 compares == 1).
          dialog.button1:IsEnabled() == 1 and "on" or "off",
          dialog.button2:IsShown() and dialog.button2:GetText() or "-" }, "|")
      end
    end
    return table.concat(rows, "\\0")
  `)[0];
  // NUL between dialogs: DELETE_GOOD_ITEM's own text spans lines.
  return rows ? rows.split("\0") : [];
}

/** Click button `index` (1 or 2) of the visible dialog showing `which`, through the stock OnClick. */
function click(boot, which, index = 1) {
  const name = lua(boot, `
    for i = 1, STATICPOPUP_NUMDIALOGS do
      local dialog = _G["StaticPopup" .. i]
      if dialog:IsShown() and dialog.which == "${which}" then return dialog:GetName() end
    end
  `)[0];
  assert.ok(name, `${which} is visible to click`);
  const button = boot.bridge.getFrame(`${name}Button${index}`);
  assert.ok(boot.bridge.Click(button, "LeftButton", false) !== false);
}

/** Advance the popup clock and run the stock OnUpdate scripts over the same span. */
function advance(boot, clock, model, seconds) {
  clock.now += seconds * 1000;
  model.tick();
  boot.bridge.tick(seconds);
}

async function published() {
  const scripted = scriptedSeam();
  const { boot } = await load(scripted.seam);
  assert.equal(installFrameXmlPopupsAdapters(boot), 5,
    "CAMP and QUIT OnShow, ShowReadyCheck, the deferred resize and the refused-invite line");
  assert.ok(frameXmlPopupsGate(scripted.seam, boot, renderer()), "the stock dialogs pass their gate");
  scripted.model.popupsOwned = true;
  return { ...scripted, boot };
}

test("the confirmations add no corpus: StaticPopup.xml and ReadyCheck.xml are already in the vertical, zero Lua errors", withClient, async () => {
  const vertical = FRAMEXML_VERTICAL_TOC.map(normalize);
  assert.ok(vertical.indexOf("staticpopup.xml") > vertical.indexOf("autocomplete.xml"), "retail slot after AutoComplete.xml");
  assert.ok(vertical.indexOf("readycheck.xml") > vertical.indexOf("voicechat.xml"), "retail slot after VoiceChat.xml");
  const scripted = scriptedSeam();
  const { boot, inventory } = await load(scripted.seam);
  try {
    assert.deepEqual(inventory.errors, []);
    const errors = boot.errorCount;
    const diagnostics = boot.bridge.diagnostics.length;
    installFrameXmlPopupsAdapters(boot);
    const gate = frameXmlPopupsGate(scripted.seam, boot, renderer());
    assert.ok(gate);
    assert.match(gate.inviteText, /^WebClientProbe приглашает вас в группу\.$/, "INVITATION formatted by stock");
    assert.equal(gate.dialogs.length, 4);
    assert.deepEqual(visible(boot), [], "the probe ends with no dialog up");
    assert.equal(boot.bridge.getFrame("ReadyCheckFrame").visible, false);
    assert.deepEqual(scripted.world.calls, [], "the probe sends nothing: PARTY_INVITE's OnHide DeclineGroup is inert");
    assert.equal(boot.errorCount, errors);
    assert.equal(boot.bridge.diagnostics.length, diagnostics);
    // Without the popup model there is no stock owner (the native prompts stay).
    assert.equal(frameXmlPopupsGate({}, boot, renderer()), undefined);
  } finally {
    boot.close();
  }
});

test("an unpublished owner shows nothing; publication hands over what is pending", withClient, async () => {
  const scripted = scriptedSeam();
  const { boot } = await load(scripted.seam);
  try {
    installFrameXmlPopupsAdapters(boot);
    scripted.world.invite("Джайна");
    scripted.model.tick();
    assert.deepEqual(visible(boot), [], "the native prompt owns it until publication");
    scripted.model.popupsOwned = true;
    assert.deepEqual(visible(boot), ["PARTY_INVITE|Джайна приглашает вас в группу.|Принять|on|Отказаться"]);
    scripted.model.tick();
    assert.equal(visible(boot).length, 1, "shown once, not once per frame");
    assert.equal(boot.errorCount, 0);
  } finally {
    boot.close();
  }
});

test("PARTY_INVITE: Accept sends one CMSG_GROUP_ACCEPT; a withdrawn invite hides without a decline", withClient, async () => {
  const { boot, world, model } = await published();
  try {
    world.invite("Джайна");
    model.tick();
    click(boot, "PARTY_INVITE", 1);
    assert.deepEqual(world.calls, [{ kind: "group", accept: true }], "OnHide's DeclineGroup follows an accepted invite: inert");
    assert.deepEqual(visible(boot), []);
    world.invite("Утер");
    model.tick();
    click(boot, "PARTY_INVITE", 2);
    assert.deepEqual(world.calls.at(-1), { kind: "group", accept: false });
    world.invite("Тралл");
    model.tick();
    world.groupInvite = undefined; // SMSG_GROUP_CANCEL / answered elsewhere
    model.tick();
    assert.deepEqual(visible(boot), [], "PARTY_INVITE_CANCEL hid it");
    assert.equal(world.calls.length, 2, "and its OnHide decline found nothing to answer");
    // An invitee already in a group gets the client's chat line, not a dialog.
    world.invite("Джайна", false);
    model.tick();
    assert.deepEqual(visible(boot), []);
    const line = lua(boot, "return DEFAULT_CHAT_FRAME:GetNumMessages() > 0 and select(1, DEFAULT_CHAT_FRAME:GetMessageInfo(DEFAULT_CHAT_FRAME:GetNumMessages())) or ''")[0];
    assert.match(String(line), /не было принято, так как вы уже находитесь в группе/);
    assert.equal(boot.errorCount, 0);
  } finally {
    boot.close();
  }
});

test("DUEL_REQUESTED and DUEL_OUTOFBOUNDS count down stock's ten seconds; the challenger is not asked", withClient, async () => {
  const { boot, world, model, clock } = await published();
  try {
    world.duel(0x42n);
    model.tick();
    assert.deepEqual(visible(boot), [], "SMSG_DUEL_REQUESTED naming the player itself asks nothing");
    world.endDuel();
    world.duel(0x53n);
    model.tick();
    assert.deepEqual(visible(boot), ["DUEL_REQUESTED|Тралл вызывает вас на поединок.|Принять|on|Отказаться"]);
    click(boot, "DUEL_REQUESTED", 1);
    assert.deepEqual(world.calls, [{ kind: "duel", accept: true }]);
    world.bounds(false);
    model.tick();
    advance(boot, clock, model, 1);
    assert.deepEqual(visible(boot), ["DUEL_OUTOFBOUNDS|Вы покидаете место дуэли. Через 9 с будет считаться, что вы бежали.|-|on|-"]);
    world.bounds(true);
    model.tick();
    assert.deepEqual(visible(boot), [], "DUEL_INBOUNDS");
    world.bounds(false);
    model.tick();
    assert.equal(visible(boot).length, 1);
    world.endDuel(); // SMSG_DUEL_COMPLETE
    model.tick();
    assert.deepEqual(visible(boot), [], "DUEL_FINISHED hides it (UIParent.lua:692)");
    assert.equal(boot.errorCount, 0);
  } finally {
    boot.close();
  }
});

test("DEATH counts the server's six minutes, releases once, and offers the corpse's self-resurrection", withClient, async () => {
  const { boot, world, model, clock } = await published();
  try {
    world.die();
    model.tick();
    advance(boot, clock, model, 1);
    assert.deepEqual(visible(boot), ["DEATH|До выхода духа из тела осталось 6 мин.|Покинуть тело|on|-"]);
    advance(boot, clock, model, 300);
    assert.match(visible(boot)[0], /^DEATH\|До выхода духа из тела осталось 59 с\|/, "360 - 301 s");
    click(boot, "DEATH", 1);
    assert.deepEqual(world.calls, [{ kind: "repop" }]);
    assert.deepEqual(visible(boot), []);
    lua(boot, "RepopMe()", 0);
    assert.equal(world.calls.length, 1, "one CMSG_REPOP_REQUEST per death");
    world.revive();
    model.tick();
    // An instance death has no release timer; a soulstone adds the second button.
    world.selfResSpell = 20608;
    world.die(0);
    model.tick();
    assert.deepEqual(visible(boot), ["DEATH|Вы умерли. Переместиться на ближайшее кладбище?|Покинуть тело|on|Перерождение"]);
    click(boot, "DEATH", 2);
    assert.deepEqual(world.calls.at(-1), { kind: "selfRes" });
    world.revive();
    model.tick();
    world.die(FRAMEXML_NO_RELEASE_WINDOW_FLAG);
    model.tick();
    assert.deepEqual(visible(boot), [], "PLAYER_FIELD_BYTE_NO_RELEASE_WINDOW: no release dialog at all");
    assert.equal(boot.errorCount, 0);
  } finally {
    boot.close();
  }
});

test("RECOVER_CORPSE waits for the server's reclaim delay; RESURRECT names the caster and answers once", withClient, async () => {
  const { boot, world, model, clock } = await published();
  try {
    world.die();
    model.tick();
    world.release(200, 25_000);
    model.tick();
    assert.deepEqual(visible(boot), [], "a ghost at the graveyard, 200 yd from its body: out of range until it walks");
    world.position = { ...world.position, x: world.corpse.x - 30 };
    model.tick();
    advance(boot, clock, model, 1);
    assert.deepEqual(visible(boot), ["RECOVER_CORPSE|До воскрешения: 24 с|Принять|off|-"]);
    advance(boot, clock, model, 25);
    assert.deepEqual(visible(boot), ["RECOVER_CORPSE|Воскреснуть?|Принять|on|-"]);
    click(boot, "RECOVER_CORPSE", 1);
    assert.deepEqual(world.calls, [{ kind: "reclaim" }]);
    world.position = { ...world.position, x: world.corpse.x - 300 };
    model.tick();
    assert.deepEqual(visible(boot), [], "CORPSE_OUT_OF_RANGE");
    world.revive();
    model.tick();
    world.die();
    world.offerResurrect(0x52n, false, false);
    model.tick();
    assert.deepEqual(visible(boot), ["RESURRECT_NO_TIMER|Утер хочет вас воскресить.|Принять|on|Отказаться"],
      "RESURRECT_* cancels DEATH (StaticPopup.lua:1211), which the same frame's PLAYER_DEAD had shown");
    click(boot, "RESURRECT_NO_TIMER", 1);
    assert.deepEqual(world.calls.at(-1), { kind: "resurrect", accept: true });
    lua(boot, "AcceptResurrect() DeclineResurrect()", 0);
    assert.equal(world.calls.filter((call) => call.kind === "resurrect").length, 1, "answered once");
    // A spirit-healer-grade resurrection names its sickness and waits for the reclaim delay.
    world.revive();
    model.tick();
    world.die();
    world.corpseReclaimDelay = 5_000;
    world.corpseReclaimReportedAt = clock.now;
    world.offerResurrect(0x52n, true, true);
    model.tick();
    advance(boot, clock, model, 1);
    assert.deepEqual(visible(boot), ["RESURRECT|Утер хочет вас воскресить и сможет это сделать через 4 с. Вы будете испытывать временную слабость.|Принять|off|Отказаться"]);
    advance(boot, clock, model, 5);
    assert.deepEqual(visible(boot), ["RESURRECT|Утер хочет вас воскресить. Вы будете испытывать временную слабость.|Принять|on|Отказаться"]);
    click(boot, "RESURRECT", 2);
    assert.deepEqual(world.calls.at(-1), { kind: "resurrect", accept: false });
    assert.equal(boot.errorCount, 0);
  } finally {
    boot.close();
  }
});

test("CONFIRM_SUMMON counts the packet's timeout and names summoner and zone; combat disables Accept", withClient, async () => {
  const { boot, world, model, clock } = await published();
  try {
    world.summon(0x51n, 1519, 120_000);
    model.tick();
    advance(boot, clock, model, 1);
    assert.deepEqual(visible(boot), [
      "CONFIRM_SUMMON|Джайна предлагает перенести вас в зону \"Штормград\". Время до окончания действия заклинания: 2 мин..|Принять|on|Отмена",
    ]);
    world.inCombat = true;
    advance(boot, clock, model, 70);
    assert.deepEqual(visible(boot), [
      "CONFIRM_SUMMON|Джайна предлагает перенести вас в зону \"Штормград\". Время до окончания действия заклинания: 49 с.|Принять|off|Отмена",
    ]);
    world.inCombat = false;
    advance(boot, clock, model, 1);
    click(boot, "CONFIRM_SUMMON", 1);
    assert.deepEqual(world.calls, [{ kind: "summon", accept: true }]);
    assert.equal(boot.errorCount, 0);
  } finally {
    boot.close();
  }
});

test("GUILD_INVITE, ARENA_TEAM_INVITE and TRADE answer through AcceptGuild/DeclineArenaTeam/BeginTrade/CancelTrade", withClient, async () => {
  const { boot, world, model } = await published();
  try {
    world.guild();
    world.arena();
    world.tradeRequest(0x51n);
    model.tick();
    assert.deepEqual(visible(boot).sort(), [
      "ARENA_TEAM_INVITE|Тралл приглашает вас в команду арены \"Орда навсегда\".|Принять|on|Отказаться",
      "GUILD_INVITE|Утер приглашает вас вступить в гильдию \"Серебряная длань\".|Принять|on|Отказаться",
      // |3-2(…) is the ruRU dative marker; GetText keeps it, FrameXmlText.ts declines it on screen.
      "TRADE|Предложить обмен |3-2(Джайна)?|Да|on|Нет",
    ]);
    click(boot, "GUILD_INVITE", 1);
    click(boot, "ARENA_TEAM_INVITE", 2);
    click(boot, "TRADE", 1);
    assert.deepEqual(world.calls, [
      { kind: "guild", accept: true }, { kind: "arena", accept: false }, { kind: "beginTrade" },
    ]);
    lua(boot, "BeginTrade()", 0);
    assert.equal(world.calls.length, 3, "CMSG_BEGIN_TRADE once per request");
    world.cancelTrade();
    world.calls.length = 0;
    world.tradeRequest(0x52n);
    model.tick();
    click(boot, "TRADE", 2);
    assert.deepEqual(world.calls, [{ kind: "cancelTrade" }]);
    assert.equal(boot.errorCount, 0);
  } finally {
    boot.close();
  }
});

test("CAMP counts the server's twenty seconds from the grant and cancels through CancelLogout", withClient, async () => {
  const { boot, world, model, clock } = await published();
  // The world mount's CancelLogout is GameMenu.cancelLogoutRequest: one CMSG_LOGOUT_CANCEL per
  // pending logout however often stock asks (logoutCancelRequested). Mirrored here.
  let asked = 0;
  let sent = 0;
  let requested = false;
  boot.vm.registerGlobal("CancelLogout", () => {
    asked += 1;
    if (world.logout && !requested) { requested = true; sent += 1; }
    return [];
  });
  try {
    world.camp(true);
    model.tick();
    assert.deepEqual(visible(boot), [], "an instant logout (resting) has no countdown");
    world.cancelCamp();
    model.tick();
    world.camp();
    model.tick();
    advance(boot, clock, model, 1);
    assert.deepEqual(visible(boot), ["CAMP|До выхода в меню выбора персонажа: 19 с.|Отмена|on|-"]);
    click(boot, "CAMP", 1);
    // Stock asks twice — button1's OnAccept and OnHide while timeleft > 0 (StaticPopup.lua:1480-1491).
    assert.deepEqual([asked, sent], [2, 1], "one cancel reaches the server");
    world.cancelCamp(); // SMSG_LOGOUT_CANCEL_ACK
    requested = false;
    model.tick();
    assert.deepEqual(visible(boot), []);
    // A popup owner published mid-countdown resumes at what is left of the server's clock.
    model.popupsOwned = false;
    world.camp();
    model.tick();
    clock.now += 12_000;
    model.popupsOwned = true;
    boot.bridge.tick(0.01);
    assert.deepEqual(visible(boot), ["CAMP|До выхода в меню выбора персонажа: 8 с.|Отмена|on|-"]);
    world.cancelCamp(); // a cancel acknowledged from elsewhere (the native menu, a slash command)
    model.tick();
    assert.deepEqual(visible(boot), [], "LOGOUT_CANCEL hides it");
    assert.equal(sent, 1, "its OnHide asks again, but nothing is pending any more");
    assert.equal(boot.errorCount, 0);
  } finally {
    boot.close();
  }
});

test("QUIT: Quit() counts the same twenty seconds; «Выйти сейчас» is ForceQuit, «Отмена» CancelLogout", withClient, async () => {
  const { boot, world, model, clock } = await published();
  let asked = 0;
  boot.vm.registerGlobal("CancelLogout", () => { asked += 1; return []; });
  try {
    world.quit();
    model.tick();
    advance(boot, clock, model, 1);
    const [row] = visible(boot);
    assert.equal(visible(boot).length, 1);
    assert.equal(row, lua(boot, `return table.concat({ "QUIT", format(QUIT_TIMER, 19, SECONDS),
      QUIT_NOW, "on", CANCEL }, "|")`)[0], "stock QUIT, 19 s left");
    assert.match(row, /^QUIT\|.*19.*\|/);
    click(boot, "QUIT", 1);
    assert.deepEqual(world.calls, [{ kind: "forceQuit" }]);
    assert.equal(asked, 0, "OnAccept zeroes timeleft: its OnHide does not cancel the logout it quits through");
    assert.deepEqual(visible(boot), []);
    world.cancelCamp();
    model.tick();
    world.quit();
    model.tick();
    click(boot, "QUIT", 2);
    assert.equal(asked, 1, "Отмена: QUIT's OnHide asks CancelLogout (StaticPopup.lua:1504)");
    assert.equal(world.calls.length, 1);
    world.cancelCamp();
    model.tick();
    // A popup owner published mid-countdown resumes QUIT at what is left of the server's clock.
    model.popupsOwned = false;
    world.quit();
    model.tick();
    clock.now += 12_000;
    model.popupsOwned = true;
    boot.bridge.tick(0.01);
    assert.deepEqual(visible(boot), [lua(boot, `return table.concat({ "QUIT", format(QUIT_TIMER, 8, SECONDS),
      QUIT_NOW, "on", CANCEL }, "|")`)[0]], "8 s, not the dialog's own 20");
    assert.equal(boot.errorCount, 0);
  } finally {
    boot.close();
  }
});

test("DELETE_ITEM and DELETE_GOOD_ITEM ask for the stock cursor's item; Yes is DeleteCursorItem, No ClearCursor", withClient, async () => {
  const { boot, world, model } = await published();
  try {
    assert.equal(model.destroyItem(255, 23), true);
    const [row] = visible(boot);
    assert.equal(visible(boot).length, 1);
    assert.match(row, /^DELETE_ITEM\|.*Льняная ткань.*\|Да\|on\|Нет$/);
    boot.bridge.tick(0.1);
    assert.equal(visible(boot).length, 1, "the item is still on the cursor: its OnUpdate keeps it up");
    click(boot, "DELETE_ITEM", 1);
    assert.deepEqual(world.calls, [{ kind: "destroyItem", bag: 255, slot: 23 }]);
    assert.equal(world.cursor, undefined);
    assert.deepEqual(visible(boot), []);
    // The epic asks for the typed word (DELETE_ITEM_CONFIRM_STRING) before Yes is enabled.
    world.pickupItem(255, 24);
    assert.equal(model.confirmDeleteCursorItem(), true);
    assert.match(visible(boot)[0], /^DELETE_GOOD_ITEM\|[^|]*Тесак Арканита[^|]*\|Да\|off\|Нет$/);
    click(boot, "DELETE_GOOD_ITEM", 2);
    assert.equal(world.cursor, undefined, "No: ClearCursor puts the item back");
    assert.equal(world.calls.length, 1);
    world.pickupItem(255, 24);
    model.confirmDeleteCursorItem();
    lua(boot, `
      for i = 1, STATICPOPUP_NUMDIALOGS do
        local dialog = _G["StaticPopup" .. i]
        if dialog:IsShown() and dialog.which == "DELETE_GOOD_ITEM" then
          dialog.editBox:SetText(DELETE_ITEM_CONFIRM_STRING)
          if dialog.button1:IsEnabled() ~= 1 then dialog.editBox:GetScript("OnTextChanged")(dialog.editBox, true) end
        end
      end
    `, 0);
    assert.match(visible(boot)[0], /^DELETE_GOOD_ITEM\|[^|]*\|Да\|on\|Нет$/, "the word typed: Yes");
    click(boot, "DELETE_GOOD_ITEM", 1);
    assert.deepEqual(world.calls.at(-1), { kind: "destroyItem", bag: 255, slot: 24 });
    // An item that leaves the cursor another way closes the question by itself.
    world.bag.set("255:25", { name: "Льняная ткань", quality: 1 });
    world.pickupItem(255, 25);
    model.confirmDeleteCursorItem();
    world.clearCursor();
    boot.bridge.tick(0.1);
    assert.deepEqual(visible(boot), [], "DELETE_ITEM's OnUpdate: no cursor item, no question");
    assert.equal(world.calls.length, 2);
    assert.equal(boot.errorCount, 0);
  } finally {
    boot.close();
  }
});

test("the gate proves the dialogs, not the moment: a running ready check, a dead player, a cinematic", withClient, async () => {
  const scripted = scriptedSeam();
  const { boot } = await load(scripted.seam);
  try {
    installFrameXmlPopupsAdapters(boot);
    const { world, model, seam } = scripted;
    world.startReadyCheck(0x42n, 0x42n);
    assert.ok(frameXmlPopupsGate(seam, boot, renderer()), "the player started the running check");
    world.startReadyCheck(0x51n, 0x51n);
    markFrameXmlPopupAnswered(world.readyCheck, true);
    assert.ok(frameXmlPopupsGate(seam, boot, renderer()), "the player already answered it");
    lua(boot, `
      WebClientTestDead = function(unit) return unit == "player" and 1 or nil end
      WebClientTestCinematic = function() return 1 end
      UnitIsDeadOrGhost, InCinematic = WebClientTestDead, WebClientTestCinematic
      WebClientTestRaw = { rawget(_G, "WebClientReadyCheckRole"), rawget(_G, "WebClientReadyCheckUnit") }
    `, 0);
    const gate = frameXmlPopupsGate(seam, boot, renderer());
    assert.ok(gate, "a dead player in a cinematic: CONFIRM_SUMMON has neither whileDead nor a live cinematic in the probe");
    assert.equal(lua(boot, `return UnitIsDeadOrGhost == WebClientTestDead and InCinematic == WebClientTestCinematic
      and rawget(_G, "WebClientReadyCheckRole") == WebClientTestRaw[1]
      and rawget(_G, "WebClientReadyCheckUnit") == WebClientTestRaw[2]`)[0], true,
    "every predicate is restored as it was, raw or not");
    assert.deepEqual(visible(boot), []);
    assert.deepEqual(world.calls, []);
    assert.equal(boot.errorCount, 0);
    // The battleground entry is its own capability, asked live: BattlefieldFrame listening, or the
    // native row stays — the PvP gate unregisters every BattlefieldFrame event after this gate ran.
    assert.equal(gate.battlefieldEntry, true);
    const owner = createFrameXmlPopupsOwner(boot, model);
    assert.equal(owner.battlefieldEntry(), true);
    lua(boot, "BattlefieldFrame:UnregisterEvent('UPDATE_BATTLEFIELD_STATUS')", 0);
    assert.equal(owner.battlefieldEntry(), false, "the published owner sees the unregistration");
    const without = frameXmlPopupsGate(seam, boot, renderer());
    assert.ok(without, "the other dialogs still pass");
    assert.equal(without.battlefieldEntry, false);
    lua(boot, "BattlefieldFrame:RegisterEvent('UPDATE_BATTLEFIELD_STATUS')", 0);
    assert.equal(owner.battlefieldEntry(), true, "and a frame listening again hands the entry back to stock");
  } finally {
    boot.close();
  }
});

test("READY_CHECK shows the stock frame, answers once across both surfaces, and the initiator ends it at 35 s", withClient, async () => {
  const { boot, world, model, clock } = await published();
  try {
    world.startReadyCheck(0x51n, 0x51n);
    model.tick();
    const listener = boot.bridge.getFrame("ReadyCheckListenerFrame");
    assert.equal(boot.bridge.isVisible(listener), true);
    assert.equal(lua(boot, "return ReadyCheckFrameText:GetText()")[0], "Джайна проверяет готовность.\n|cffffffffВы готовы?|r");
    assert.equal(lua(boot, "return GetReadyCheckTimeLeft()")[0], 35);
    assert.equal(lua(boot, "return GetReadyCheckStatus('player')")[0], "waiting");
    assert.equal(lua(boot, "return GetReadyCheckStatus('party1')")[0], "ready", "the initiator counts as ready");
    assert.equal(lua(boot, "return GetReadyCheckStatus('party2')")[0], undefined, "a member hears no one else's answer");
    boot.bridge.Click(boot.bridge.getFrame("ReadyCheckFrameYesButton"), "LeftButton", false);
    assert.deepEqual(world.calls, [{ kind: "readyCheck", accept: true }]);
    assert.equal(boot.bridge.isVisible(listener), false);
    assert.equal(lua(boot, "return GetReadyCheckStatus('player')")[0], "ready", "the own answer is remembered");
    assert.equal(lua(boot, "return PlayerFrameReadyCheck.state")[0], "ready", "PlayerFrame shows the answer just given");
    lua(boot, "ConfirmReadyCheck(nil)", 0);
    lua(boot, "ReadyCheckFrame_OnEvent(ReadyCheckFrame, 'READY_CHECK', 'Джайна', 30)", 0);
    assert.equal(boot.bridge.isVisible(listener), false, "an answered check is not asked again");
    assert.equal(world.calls.length, 1);
    world.endReadyCheck();
    model.tick();
    assert.equal(boot.bridge.getFrame("ReadyCheckFrame").visible, false);
    // The player starts one: no listener, the others' answers arrive, and 35 s later it is finished.
    world.calls.length = 0;
    world.startReadyCheck(0x42n, 0x42n);
    model.tick();
    assert.equal(boot.bridge.isVisible(listener), false, "the initiator is not asked");
    world.confirmReady(0x52n, false);
    model.tick();
    assert.equal(lua(boot, "return GetReadyCheckStatus('party2')")[0], "notready");
    assert.equal(lua(boot, "return GetReadyCheckStatus('party3')")[0], "waiting", "the leader sees who is missing");
    advance(boot, clock, model, 35);
    assert.deepEqual(world.calls, [{ kind: "finishReadyCheck" }], "MSG_RAID_READY_CHECK_FINISHED once");
    advance(boot, clock, model, 1);
    assert.equal(world.calls.length, 1);
    assert.equal(boot.errorCount, 0);
  } finally {
    boot.close();
  }
});

test("CONFIRM_BATTLEFIELD_ENTRY opens for the invited queue and enters through AcceptBattlefieldPort", withClient, async () => {
  const { boot, world, model, seam } = await published();
  try {
    seam.battlefieldStatus = (index) => index === 1 && world.battlefieldQueues.get(0)?.status === 2
      ? ["confirm", "Альтеракская долина", 0, 51, 60, 0, false] : ["none", undefined, 0, 0, 0, 0, false];
    world.battlefieldInvite(0);
    model.tick();
    const rows = visible(boot);
    assert.equal(rows.length, 1);
    assert.match(rows[0], /^CONFIRM_BATTLEFIELD_ENTRY\|Вы можете войти на поле боя: Альтеракская долина\. Ваше решение:\|Начать бой\|on\|Выйти из очереди$/);
    assert.equal(lua(boot, "return GetBattlefieldPortExpiration(1)")[0], 120);
    model.tick();
    assert.equal(visible(boot).length, 1, "once per entry into STATUS_WAIT_JOIN");
    click(boot, "CONFIRM_BATTLEFIELD_ENTRY", 1);
    assert.deepEqual(world.calls, [{ kind: "battlefield", slot: 0, enter: true }]);
    assert.equal(boot.errorCount, 0);
  } finally {
    boot.close();
  }
});

test("the spirit healer's XP_LOSS asks twice, as stock does, and activates the healer that asked", withClient, async () => {
  const { boot, world, model } = await published();
  try {
    world.die();
    model.tick();
    world.release();
    model.tick();
    world.spiritHealer();
    const [row] = visible(boot);
    assert.match(row, /^XP_LOSS\|Отыскав свое тело, вы воскреснете без потерь\. .*10 мин\. испытывать временную слабость\.\|Принять\|on\|Отмена$/);
    click(boot, "XP_LOSS", 1);
    assert.deepEqual(world.calls, [], "the first Accept only asks again (CONFIRM_XP_LOSS_AGAIN)");
    assert.match(visible(boot)[0], /^XP_LOSS\|Отыскав свое тело, вы сможете воскреснуть без потерь/);
    click(boot, "XP_LOSS", 1);
    assert.deepEqual(world.calls, [{ kind: "spiritHealer", guid: FRAMEXML_CANNED_SPIRIT_HEALER_GUID }]);
    world.spiritHealer();
    world.healerInRange = false;
    boot.bridge.tick(0.1);
    assert.deepEqual(visible(boot), [], "CheckSpiritHealerDist: walking away closes it");
    assert.equal(boot.errorCount, 0);
  } finally {
    boot.close();
  }
});

/** The visible dialog showing `which`, by name, or undefined. */
function dialogName(boot, which) {
  return lua(boot, `
    for i = 1, STATICPOPUP_NUMDIALOGS do
      local dialog = _G["StaticPopup" .. i]
      if dialog:IsShown() and dialog.which == "${which}" then return dialog:GetName() end
    end
  `)[0];
}

test("CONFIRM_BINDER names the place, binds once, sends nothing on Cancel and closes out of the innkeeper's reach", withClient, async () => {
  const { boot, world, model } = await published();
  try {
    world.binder();
    model.tick();
    assert.deepEqual(visible(boot), ["CONFIRM_BINDER|Златоземье станет вашим новым домом. Согласны?|Принять|on|Отмена"]);
    click(boot, "CONFIRM_BINDER", 1);
    lua(boot, "ConfirmBinder()", 0);
    assert.deepEqual(world.calls, [{ kind: "binder", guid: FRAMEXML_CANNED_INNKEEPER_GUID }], "CMSG_BINDER_ACTIVATE once");
    assert.deepEqual(visible(boot), []);
    world.binder();
    model.tick();
    click(boot, "CONFIRM_BINDER", 2);
    assert.deepEqual(visible(boot), []);
    assert.equal(world.calls.length, 1, "Отмена sends nothing: the old home stays");
    world.binder();
    model.tick();
    world.npcInRange = false;
    boot.bridge.tick(0.1);
    assert.deepEqual(visible(boot), [], "CheckBinderDist: walking away closes it");
    assert.equal(world.calls.length, 1);
    world.npcInRange = true;
    model.popupsOwned = false;
    model.popupsOwned = true;
    boot.bridge.tick(0.1);
    assert.deepEqual(visible(boot), [], "a /reload does not ask again: 3.3.5 fires CONFIRM_BINDER on the packet only");
    assert.equal(lua(boot, "return GetBindLocation()")[0], undefined, "no bind point reported yet");
    world.bound(87);
    assert.equal(lua(boot, "return GetBindLocation()")[0], "Златоземье");
    assert.equal(boot.errorCount, 0);
  } finally {
    boot.close();
  }
});

test("CONFIRM_TALENT_WIPE shows the quote in its money frame and opens the loaded talent tree; Accept answers once", withClient, async () => {
  const { boot, world, model } = await published();
  // Blizzard_TalentUI as the lazy talent owner leaves it once loaded: LoadAddOn answers loaded, so
  // UIParent's TalentFrame_LoadUI is quiet, and PlayerTalentFrame_Open exists.
  boot.vm.registerGlobal("LoadAddOn", (args) => (args[0] === "Blizzard_TalentUI" ? [true] : [false, "MISSING"]));
  lua(boot, `
    WebClientTestTalentOpen = {}
    PlayerTalentFrame_Open = function(pet, group)
      WebClientTestTalentOpen[#WebClientTestTalentOpen + 1] = tostring(pet) .. ":" .. tostring(group)
    end
  `, 0);
  try {
    world.talentUiState = "ready";
    world.talentWipe(50_000);
    model.tick();
    const rows = visible(boot);
    assert.equal(rows.length, 1);
    assert.match(rows[0], /^CONFIRM_TALENT_WIPE\|Вы уверены, что хотите отказаться от всех своих талантов\?.*\|Принять\|on\|Отмена$/);
    const name = dialogName(boot, "CONFIRM_TALENT_WIPE");
    assert.deepEqual(lua(boot, `local money = _G["${name}MoneyFrame"] return money:IsShown() and 1 or 0, money.staticMoney`, 2),
      [1, 50_000], "MoneyFrame_Update(…MoneyFrame, arg1): the quote in copper");
    assert.match(String(lua(boot, "return table.concat(WebClientTestTalentOpen, ',')")[0]), /^false:\d+$/,
      "the talent tree opens beside the question, as the client does");
    click(boot, "CONFIRM_TALENT_WIPE", 1);
    lua(boot, "ConfirmTalentWipe()", 0);
    assert.deepEqual(world.calls, [{ kind: "talentWipe", guid: FRAMEXML_CANNED_TRAINER_GUID }]);
    assert.deepEqual(visible(boot), []);
    world.talentWipe(50_000);
    model.tick();
    world.npcInRange = false;
    boot.bridge.tick(0.1);
    assert.deepEqual(visible(boot), [], "CheckTalentMasterDist: walking away closes it");
    assert.equal(world.calls.length, 1);
    assert.equal(boot.errorCount, 0);
  } finally {
    boot.close();
  }
});

test("CONFIRM_TALENT_WIPE is never fired while Blizzard_TalentUI is not loaded: no Lua error, no message(), the native prompt keeps it", withClient, async () => {
  const { boot, world, model, clock } = await published();
  // message() writes only into a hidden BasicScriptErrors (BasicControls.xml:48-53).
  const loadError = () => {
    const [shown, text] = lua(boot, "return BasicScriptErrors:IsShown() and 1 or 0, BasicScriptErrorsText:GetText()", 2);
    return Number(shown) === 1 ? String(text ?? "") : "";
  };
  lua(boot, "BasicScriptErrors:Hide()", 0);
  try {
    const before = boot.errorCount;
    world.talentUiState = "loading";
    world.talentWipe(50_000);
    model.tick();
    advance(boot, clock, model, 2);
    assert.deepEqual(visible(boot), []);
    assert.equal(frameXmlPopupsLeftToNative(world.talentWipeConfirm), true);
    assert.equal(loadError(), "", "no «Ошибка загрузки (Blizzard_TalentUI)»");
    assert.equal(boot.errorCount, before);
    assert.deepEqual(world.calls, []);
    // The hazard itself, through the same path: a host claiming the add-on is loaded when it is not.
    world.talentUiState = "ready";
    world.talentWipe(50_000);
    model.tick();
    assert.match(loadError(), /Blizzard_TalentUI/, "TalentFrame_LoadUI → UIParentLoadAddOn → message(): why the model waits");
  } finally {
    boot.close();
  }
});

test("INSTANCE_LOCK counts what is left of the server's minute, names the dungeon and its bosses; Leave and Accept answer once", withClient, async () => {
  const { boot, world, model, clock, seam } = await published();
  // LiveWorldSeam answers GetInstanceInfo from the map inside an instance; the canned seam has no map.
  Object.defineProperty(seam, "instanceInfo", { value: () => ["Крепость Утгард", "party", 1, "", 5, 0, false], configurable: true });
  try {
    world.lockWarning(60_000, 0b101, 574, 0);
    model.tick();
    advance(boot, clock, model, 1);
    const [row] = visible(boot);
    assert.equal(visible(boot).length, 1);
    assert.match(row, /^INSTANCE_LOCK\|Вы вошли в подземелье, в котором уже шли сражения\..*Крепость Утгард.*59.*Убито боссов: 2\/3\|Принять\|on\|Покинуть подземелье$/s);
    assert.deepEqual(lua(boot, "return GetInstanceLockTimeRemainingEncounter(2)", 3), ["Скарвальд и Далронн", "", false]);
    advance(boot, clock, model, 20);
    assert.match(visible(boot)[0], /Крепость Утгард.*39/s, "its own lockTimeleft keeps counting down");
    click(boot, "INSTANCE_LOCK", 2);
    lua(boot, "RespondInstanceLock(true)", 0);
    assert.deepEqual(world.calls, [{ kind: "instanceLock", accept: false }], "«Покинуть подземелье»: one CMSG_INSTANCE_LOCK_RESPONSE 0");
    model.tick();
    assert.deepEqual(visible(boot), []);
    world.lockWarning(60_000, 0b1, 574, 0);
    model.tick();
    advance(boot, clock, model, 1);
    click(boot, "INSTANCE_LOCK", 1);
    assert.deepEqual(world.calls.at(-1), { kind: "instanceLock", accept: true });
    // Nobody answers: the dialog closes at the deadline and the core binds by itself.
    world.lockWarning(60_000, 0b1, 574, 0);
    model.tick();
    advance(boot, clock, model, 30);
    assert.equal(visible(boot).length, 1);
    advance(boot, clock, model, 31);
    assert.deepEqual(visible(boot), []);
    assert.equal(world.calls.length, 2, "a timeout answers nothing (OnCancel's \"timeout\")");
    // A /reload mid-question: re-published, it resumes at what is left, not a fresh minute.
    world.lockWarning(60_000, 0b1, 574, 0);
    model.tick();
    clock.now += 45_000;
    model.popupsOwned = false;
    model.popupsOwned = true;
    boot.bridge.tick(0.01);
    assert.match(visible(boot)[0], /Крепость Утгард.*1[45]/s, "15 s left, not 60");
    assert.equal(boot.errorCount, 0);
  } finally {
    boot.close();
  }
});

test("Escape runs stock StaticPopup_EscapePressed: escapable dialogs cancel themselves, DEATH stays", withClient, async () => {
  const { boot, world, model } = await published();
  try {
    const owner = createFrameXmlPopupsOwner(boot);
    assert.equal(owner.isOpen(), false);
    world.die();
    model.tick();
    assert.equal(owner.isOpen(), false, "DEATH has no hideOnEscape");
    world.revive();
    model.tick();
    world.invite("Джайна");
    world.summon();
    model.tick();
    assert.equal(owner.isOpen(), true);
    owner.close();
    assert.deepEqual(world.calls, [{ kind: "group", accept: false }, { kind: "summon", accept: false }]);
    assert.deepEqual(visible(boot), []);
    assert.equal(owner.isOpen(), false);
    assert.equal(boot.errorCount, 0);
  } finally {
    boot.close();
  }
});

test("a dialog is resized as its wrapped text gets a height (stock sized it from a 0-high text)", withClient, async () => {
  const { boot, world, model } = await published();
  try {
    // What the bridge answered at Show on the rich route before its text was measured: 0.
    lua(boot, "StaticPopup1Text.GetHeight = function() return 0 end", 0);
    world.guild();
    model.tick();
    assert.equal(lua(boot, "return StaticPopup1:GetHeight()")[0], 61, "32 + 0 + 8 + 21: stock sized it from an unmeasured text");
    // What the renderer reports a frame later for this two-line text (measured on the rich route).
    lua(boot, "StaticPopup1Text.GetHeight = function() return 24 end", 0);
    boot.bridge.tick(0.02);
    assert.equal(lua(boot, "return StaticPopup1:GetHeight()")[0], 85, "32 + 24 + 8 + 21 (StaticPopup.lua:2922)");
    // Text OnUpdate fills in later (CONFIRM_SUMMON, DEATH, CAMP start as " ") grows it, as stock would.
    lua(boot, "StaticPopup1Text.GetHeight = function() return 36 end", 0);
    boot.bridge.tick(0.02);
    assert.equal(lua(boot, "return StaticPopup1:GetHeight()")[0], 97, "32 + 36 + 8 + 21");
    lua(boot, "StaticPopup1Text.GetHeight = function() return 12 end", 0);
    boot.bridge.tick(0.02);
    assert.equal(lua(boot, "return StaticPopup1:GetHeight()")[0], 97, "stock's maxHeightSoFar never shrinks a dialog while shown");
    assert.equal(boot.errorCount, 0);
  } finally {
    boot.close();
  }
});

test("measured cost: adapters, gate and the per-frame comparison (no file, byte or widget is added)", withClient, async () => {
  const scripted = scriptedSeam();
  const { boot, inventory } = await load(scripted.seam);
  try {
    assert.equal(inventory.lua.errorsRaised, 0);
    const started = performance.now();
    installFrameXmlPopupsAdapters(boot);
    const gate = frameXmlPopupsGate(scripted.seam, boot, renderer());
    const gateMs = performance.now() - started;
    assert.ok(gate);
    scripted.model.popupsOwned = true;
    // An idle frame: nothing pending, which is every frame of an ordinary session.
    const idleStarted = performance.now();
    for (let frame = 0; frame < 10_000; frame += 1) scripted.model.tick();
    const idleUs = ((performance.now() - idleStarted) / 10_000) * 1000;
    scripted.world.invite("Джайна");
    scripted.world.summon();
    scripted.world.guild();
    scripted.model.tick();
    const busyStarted = performance.now();
    for (let frame = 0; frame < 10_000; frame += 1) scripted.model.tick();
    const busyUs = ((performance.now() - busyStarted) / 10_000) * 1000;
    assert.equal(visible(boot).length, 3);
    assert.ok(idleUs < 50 && busyUs < 50, `a tick stays in microseconds (${idleUs.toFixed(2)} / ${busyUs.toFixed(2)} µs)`);
    console.log(`[popups] adapters+gate ${gateMs.toFixed(1)} ms · tick idle ${idleUs.toFixed(2)} µs, three pending ${
      busyUs.toFixed(2)} µs · vertical ${inventory.files.total} files ${inventory.files.bytes} B ${inventory.widgets.total} widgets`);
  } finally {
    boot.close();
  }
});
