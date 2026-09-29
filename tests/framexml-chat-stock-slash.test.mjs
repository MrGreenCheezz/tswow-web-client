import assert from "node:assert/strict";
import test from "node:test";

// MPQ-backed on purpose: what is asserted is that the *real* ChatEdit_ParseText, SlashCmdList and
// EMOTE*_CMD tables of this client's ruRU corpus reach the bindings of FrameXmlChatApi.ts. Without
// the client there is nothing truthful to parse, so the test skips.
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
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { installFrameXmlStockChat } = await import("../dist/code/browser/framexml/FrameXmlChatApi.js");
const { openChatInput, insertChatLink, chatInputReplaced } =
  await import("../dist/code/browser/ui/ChatInputOwner.js");
const { plainFrameXmlText } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlText.js");

const decoder = new TextDecoder("utf-8");

function recordingWorld() {
  const calls = [];
  const target = {
    emotes: { emotes: [
      { id: 34, command: "dance", emoteId: 10, text: {} },
      { id: 101, command: "wave", emoteId: 3, text: {} },
      { id: 86, command: "sit", emoteId: 13, text: {} },
      // In EmotesText.dbc but spelled by no EMOTE*_CMD of the ruRU corpus.
      { id: 400, command: "fail", emoteId: 0, text: {} },
      // Also a DBC emote without an EMOTE*_CMD, but `/stopattack` is a secure command (the table
      // is a local of ChatFrame.lua; only IsSecureCmd can tell).
      { id: 402, command: "stopattack", emoteId: 0, text: {} },
    ] },
    targetGuid: 0x42n,
    state: { selfGuid: 1n, objects: new Map([[1n, { typeId: 4 }], [0x42n, { typeId: 4 }]]) },
    channels: new Map([["Общий - Элвиннский лес", { flags: 0x18, count: 1, members: [] }],
      ["test", { flags: 0x01, count: 1, members: [] }]]),
    group: { members: [] },
    contacts: { flags: 7, contacts: [] },
    raidTargets: new Map(),
    playedTime: undefined,
    events: { on() { return () => {}; } },
    displayName: (guid) => (guid === 0x42n ? "Цель" : "Я"),
    challengeDuelToSelection() { calls.push(["challengeDuelToSelection"]); return true; },
  };
  const world = new Proxy(target, {
    get(object, key) {
      if (key in object) return object[key];
      if (typeof key === "symbol" || key === "then") return undefined;
      return (...args) => { calls.push([String(key), ...args]); };
    },
  });
  return { world, calls };
}

const NATIVE = [
  { name: "whois", aliases: ["whois"], usage: "/whois Имя", help: "подробности об игроке" },
  { name: "vehicle", aliases: ["vehicle", "veh"], usage: "/vehicle enter|leave|next|prev|eject",
    help: "транспорт" },
  { name: "chanlist", aliases: ["chanlist", "channellist"], usage: "/chanlist Канал", help: "список участников канала" },
  { name: "join", aliases: ["join", "j"], usage: "/join Канал", help: "войти в канал" },
  { name: "who", aliases: ["who"], usage: "/who Имя", help: "поиск игроков" },
  { name: "invite", aliases: ["invite", "inv"], usage: "/invite Имя", help: "пригласить в группу" },
  { name: "cast", aliases: ["cast"], usage: "/cast ID", help: "применить заклинание" },
  { name: "boom", aliases: ["boom"], usage: "/boom", help: "бросает исключение" },
];

test("stock ChatEdit_ParseText reaches the world API, the native commands and a stock /help tail", withClient, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const chain = await clientArchives(clientDirectory);
  const provider = { async read(path) { const data = await chain.read(path); return data ? decoder.decode(data) : undefined; } };
  const sent = [];
  // The canned backpack's first slot holds a Hearthstone with the link a live bag slot answers.
  const { CANNED_CONTAINERS } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
  const hearthstone = {
    entry: 6948, name: "Камень возвращения", texture: "Interface\\Icons\\INV_Misc_Rune_01", count: 1, quality: 1,
    link: "|cffffffff|Hitem:6948:0:0:0:0:0:0:0:80|h[Камень возвращения]|h|r",
  };
  const containers = CANNED_CONTAINERS.map((container) => (container.id === 0
    ? { ...container, slots: [hearthstone, ...container.slots.slice(1)] } : container));
  const cannedSeam = new CannedWorldSeam(undefined, (...args) => sent.push(args), containers);
  const runner = await import("../dist/code/browser/macro/MacroRunner.js");
  const { frameXmlChatTypeCode } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
  const boot = new FrameXmlBoot({
    provider, locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC,
    seam: cannedSeam,
    screen: () => ({ width: 1024, height: 768 }),
  });
  await boot.load();
  const { world, calls } = recordingWorld();
  const native = [];
  const notices = [];
  let commands = [...NATIVE];
  const listeners = new Set();
  const input = {
    value: "", focused: 0, ownerDocument: { activeElement: null },
    focus() { this.focused += 1; this.ownerDocument.activeElement = this; },
    setSelectionRange() {},
  };
  const scheduled = [];
  let failures = 0;
  // The macro conditions' answers (3.10): a context the test steers, as the world mount passes the
  // seam's own (`macroContext`).
  const held = { shift: false, focus: false };
  const macroContext = {
    modifier: (key) => held.shift && (key === undefined || key === "shift"),
    exists: (unit) => unit === "focus" && held.focus,
  };
  const release = installFrameXmlStockChat({
    vm: boot.vm, bridge: boot.bridge, inputFor: () => input, schedule: (callback) => scheduled.push(callback),
  }, {
    world: () => world,
    notice: (text) => notices.push(text),
    cast: (argument) => calls.push(["cast", argument]),
    use: (argument) => calls.push(["use", argument]),
    unitGuid: (unit) => (unit === "target" ? 0x42n : unit === "player" ? 1n : undefined),
    commands: () => commands,
    emotes: () => world.emotes,
    run: (name, rest) => {
      if (name === "boom") throw new Error("kaboom");
      native.push([name, rest]);
      return true;
    },
    onCommandsChanged: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    macroContext: () => macroContext,
  }, () => { failures += 1; });
  try {
    assert.equal(typeof release, "function", "the real corpus passes the stock chat gate");
    assert.equal(chatInputReplaced(), true);
    const errorsAtInstall = boot.errorCount;
    const editBox = boot.bridge.getFrame("ChatFrame1EditBox");
    const chat = boot.bridge.getFrame("ChatFrame1");
    const type = (line) => {
      calls.length = 0;
      native.length = 0;
      boot.bridge.SetText(editBox, line);
      boot.bridge.Show(editBox);
      assert.equal(boot.bridge.fireScript(editBox, "OnEnterPressed"), true, line);
      return { calls: [...calls], native: [...native] };
    };

    // Emotes: GlobalStrings' EMOTE*_CMD spelling -> stock token -> EmotesText id; the target is the
    // current selection, and a DBC emote no stock spelling covers is the native fallback.
    assert.deepEqual(type("/dance").calls, [["sendTextEmote", 34, 0x42n]]);
    assert.deepEqual(type("/wave").calls, [["sendTextEmote", 101, 0x42n]]);
    assert.deepEqual(type("/fail").native, [["fail", ""]]);
    // Stock slash bodies calling the world API.
    assert.deepEqual(type("/roll").calls, [["rollDice", 1, 100]]);
    assert.deepEqual(type("/join x").calls, [["joinChannel", "x", ""]]);
    assert.deepEqual(type("/leave 2").calls, [["leaveChannel", "test"]]);
    assert.deepEqual(type("/invite Foo").calls, [["inviteToGroup", "Foo"]]);
    assert.deepEqual(type("/leavevehicle").calls, [["leaveVehicle"]]);
    assert.deepEqual(type("/trade").calls, [["startTrade", 0x42n]]);
    // Secure commands (SecureCmdList is a local of ChatFrame.lua; these reach StartAttack/StopAttack).
    assert.deepEqual(type("/startattack").calls, [["startAttack"]]);
    assert.deepEqual(type("/stopattack").calls, [["stopAttack"]]);
    // Macro conditions (3.10): stock SecureCmdList["CAST"] asks SecureCmdOptionParse, which now
    // evaluates every clause against the host's context; CastSpellByName records what was chosen.
    assert.deepEqual(type("/cast [mod:shift] Огненный шар; Ледяная стрела").calls, [["cast", "Ледяная стрела"]]);
    held.shift = true;
    assert.deepEqual(type("/cast [mod:shift] Огненный шар; Ледяная стрела").calls, [["cast", "Огненный шар"]]);
    held.shift = false;
    // The group that holds names the target; CastSpellByName hands it on as `[@unit]`.
    assert.deepEqual(type("/cast [@focus,exists][] Превращение").calls, [["cast", "Превращение"]]);
    held.focus = true;
    assert.deepEqual(type("/cast [@focus,exists][] Превращение").calls, [["cast", "[@focus] Превращение"]]);
    held.focus = false;
    assert.deepEqual(type("/stopattack [mod:shift]").calls, [], "a condition that fails stops nothing");
    // RunMacroText runs each line as the client does: EXECUTE_CHAT_LINE to stock MacroEditBox
    // (ChatFrame.lua:2461-2482), and /stopmacro ends the macro after its own line.
    calls.length = 0;
    boot.vm.execute('RunMacroText("/cast [mod:shift] Огненный шар; Ледяная стрела\\n/stopmacro [nomod]\\n/cast Кольцо льда")',
      "@test/macro");
    assert.deepEqual(calls, [["cast", "Ледяная стрела"]], "the third line never ran");
    calls.length = 0;
    held.shift = true;
    const sentBeforeMacro = sent.length;
    // The chat box's sticky type is GUILD: a macro's line without / is said all the same.
    boot.vm.execute('ChatFrame1EditBox:SetAttribute("chatType", "GUILD") ChatFrame1EditBox:SetAttribute("stickyType", "GUILD")',
      "@test/sticky");
    boot.vm.execute('RunMacroText("/cast [nomod] Огненный шар\\n/stopmacro [nomod]\\nнаписано в чат\\n#show Огненный шар\\n-- заметка\\n/cast Кольцо льда")',
      "@test/macro");
    held.shift = false;
    boot.vm.execute('ChatFrame1EditBox:SetAttribute("chatType", "SAY") ChatFrame1EditBox:SetAttribute("stickyType", "SAY")',
      "@test/sticky");
    assert.deepEqual(calls, [["cast", "Кольцо льда"]], "a failed /stopmacro goes on");
    // A line without / is said in SAY, as the client's MacroEditBox says it; # and - lines are comments.
    assert.deepEqual(sent.slice(sentBeforeMacro).map((args) => [args[0], args[1]]),
      [["написано в чат", frameXmlChatTypeCode("SAY")]]);
    // Stock /cast and /use (one body, ChatFrame.lua:1029-1040) keep this client's IDs: a bare number past
    // the equipment slots is an ID, which GetItemInfo tells apart — an item the client knows is used
    // (UseItemByName), anything else cast (CastSpellByName) — and both reach this client's own commands.
    assert.deepEqual(type("/cast 133").calls, [["cast", "133"]]);
    assert.deepEqual(type("/use 6948").calls, [["use", "6948"]], "the Hearthstone in the backpack, by its ID");
    assert.deepEqual(type("/cast [mod:shift] 116; 133").calls, [["cast", "133"]]);
    assert.deepEqual(type("/use 13").calls, [], "an equipment slot stays the slot, as in the client: UseInventoryItem(13)");
    boot.vm.execute('__webclientParsed = table.concat({ tostring(SecureCmdItemParse("0 1") ~= nil), tostring(select(3, SecureCmdItemParse("13"))) }, " ")',
      "@test/item");
    assert.equal(boot.vm.getGlobal("__webclientParsed"), "true 13", "a bag slot and an equipment slot parse as stock");
    assert.deepEqual(type("/use Камень возвращения").calls, [["use", "Камень возвращения"]],
      "GetItemInfo(name) knows the Hearthstone in the backpack, so it is used and not cast");
    assert.deepEqual(type("/use Огненный шар").calls, [["cast", "Огненный шар"]], "a spell by /use is cast");
    boot.vm.execute('__webclientItemName = GetItemInfo("камень возвращения")', "@test/item");
    assert.equal(boot.vm.getGlobal("__webclientItemName"), "Камень возвращения");
    // [btn:N] without a click: the client reads «LeftButton» (Wow.exe 0x5ef0d0).
    assert.deepEqual(type("/cast [btn:1] Огненный шар; Ледяная стрела").calls, [["cast", "Огненный шар"]]);
    // A word the client does not know holds and is reported once, in the UI error line.
    boot.vm.execute(`
      __webclientErrors = {}
      local listener = CreateFrame("Frame")
      listener:RegisterEvent("UI_ERROR_MESSAGE")
      listener:SetScript("OnEvent", function(_, _, message) __webclientErrors[#__webclientErrors + 1] = message end)`,
    "@test/errors");
    calls.length = 0;
    boot.vm.execute('RunMacroText("/cast [bogus] Огненный шар") RunMacroText("/cast [bogus] Огненный шар")', "@test/macro");
    assert.deepEqual(calls, [["cast", "Огненный шар"], ["cast", "Огненный шар"]]);
    boot.vm.execute("__webclientErrorCount = #__webclientErrors; __webclientError = __webclientErrors[1]", "@test/errors");
    assert.equal(boot.vm.getGlobal("__webclientErrorCount"), 1);
    assert.equal(boot.vm.getGlobal("__webclientError"), "Неизвестный параметр макроса: bogus");
    // /click: GetClickFrame names a Button only, and the stock body clicks it with the button given.
    boot.vm.execute(`
      __webclientClicked = nil
      local probe = CreateFrame("Button", "WebClientClickProbe", UIParent)
      probe:SetScript("OnClick", function(self, button) __webclientClicked = button end)
      local plain = CreateFrame("Frame", "WebClientClickPlain", UIParent)
      plain:SetScript("OnMouseUp", function() __webclientClicked = "plain" end)`, "@test/click");
    type("/click WebClientClickProbe RightButton");
    assert.equal(boot.vm.getGlobal("__webclientClicked"), "RightButton");
    boot.vm.execute("__webclientClicked = nil", "@test/click");
    type("/click WebClientClickPlain");
    assert.equal(boot.vm.getGlobal("__webclientClicked"), undefined, "the stock body clicks only a Button");
    // GetClickFrame answers any frame of that name (Wow.exe 0x564130); ChatFrame.lua:1412 checks the kind.
    boot.vm.execute('__webclientClickFrame = GetClickFrame("WebClientClickPlain"):GetName()', "@test/click");
    assert.equal(boot.vm.getGlobal("__webclientClickFrame"), "WebClientClickPlain");
    // A CheckButton IS a Button, as in the client's widget hierarchy — and so are the action buttons.
    boot.vm.execute(`
      local check = CreateFrame("CheckButton", "WebClientCheckProbe", UIParent)
      check:SetScript("OnClick", function(self, button) __webclientClicked = "check " .. tostring(button) end)
      local texture = UIParent:CreateTexture("WebClientTextureProbe")
      __webclientKinds = table.concat({
        tostring(check:IsObjectType("Button")), tostring(check:IsObjectType("Frame")), tostring(check:IsObjectType("Region")),
        tostring(check:IsObjectType("UIObject")), tostring(check:IsObjectType("EditBox")),
        tostring(texture:IsObjectType("LayeredRegion")), tostring(texture:IsObjectType("Frame")),
        tostring(ActionButton1:IsObjectType("Button")),
      }, " ")`, "@test/kinds");
    assert.equal(boot.vm.getGlobal("__webclientKinds"), "true true true true false true false true");
    type("/click WebClientCheckProbe");
    assert.equal(boot.vm.getGlobal("__webclientClicked"), "check LeftButton");
    const cooldownBefore = cannedSeam.actionCooldown(1);
    type("/click ActionButton1");
    assert.deepEqual(cooldownBefore, [0, 0, 0]);
    assert.ok(cannedSeam.actionCooldown(1)[1] > 0, "/click ActionButton1 pressed the button: UseAction(1) started its cooldown");
    // `/who` is stock's while FriendsFrame.xml's WhoFrameEditBox exists (chatframe.lua:1944-1951):
    // the box takes the query and SendWho sends it; a bare /who asks for the default query and
    // opens the who tab through ShowWhoPanel.
    boot.vm.execute(`__webclientWhoPanels = 0
      __webclientShowWhoPanel = ShowWhoPanel
      ShowWhoPanel = function() __webclientWhoPanels = __webclientWhoPanels + 1 end`, "@test/who");
    assert.deepEqual(type("/who Bob"), { calls: [["requestWho", { name: "Bob" }]], native: [] });
    assert.equal(boot.bridge.getFrame("WhoFrameEditBox").text, "Bob");
    // WhoFrame_GetDefaultWhoCommand (FriendsFrame.lua:1496-1504): ruRU's zone tag `з-` around
    // GetRealZoneText(), and the player's level ±3.
    boot.vm.execute('__webclientWhoLevel = UnitLevel("player")', "@test/who");
    const level = Number(boot.vm.getGlobal("__webclientWhoLevel"));
    assert.ok(level > 0, `the canned player has a level: ${level}`);
    const bare = type("/who");
    assert.deepEqual(bare, { calls: [["requestWho", {
      levelMin: Math.max(1, level - 3), levelMax: level + 3, words: ["Элвиннский лес"],
    }]], native: [] }, "the localised zone tag is a zone word, not two broken ones");
    assert.equal(boot.bridge.getFrame("WhoFrameEditBox").text, `з-"Элвиннский лес" ${Math.max(1, level - 3)}-${level + 3}`);
    assert.equal(boot.vm.getGlobal("__webclientWhoPanels"), 1, "a bare /who opens the who tab");
    // A TOC without the who tab has no box, and the stock body raised on every /who
    // (chatframe.lua:1949): there the native panel answers, and stock comes back with the box.
    boot.vm.execute("__webclientWhoBox = WhoFrameEditBox; WhoFrameEditBox = nil", "@test/who");
    for (const listener of listeners) listener();
    assert.deepEqual(type("/who Bob"), { calls: [], native: [["who", "Bob"]] });
    boot.vm.execute("WhoFrameEditBox = __webclientWhoBox; ShowWhoPanel = __webclientShowWhoPanel", "@test/who");
    for (const listener of listeners) listener();
    assert.deepEqual(type("/who Bob"), { calls: [["requestWho", { name: "Bob" }]], native: [] });
    // Native commands whose spelling stock does not claim.
    assert.deepEqual(type("/chanlist test").native, [["chanlist", "test"]]);
    assert.deepEqual(type("/vehicle leave").native, [["vehicle", "leave"]]);
    assert.deepEqual(type("/veh next").native, [["vehicle", "next"]]);
    assert.deepEqual(type("/whois Foo").native, [["whois", "Foo"]]);
    // A spelling stock owns is never shadowed: /join and /invite above went to stock; only the
    // unclaimed /j alias of the native join is mirrored.
    assert.deepEqual(type("/j y").native, [["join", "y"]]);
    // A numbered channel resolves through GetChannelName and sends on the channel.
    const sentBefore = sent.length;
    type("/1 привет");
    assert.equal(sent.length, sentBefore + 1);
    assert.equal(sent.at(-1)[0], "привет");
    assert.equal(boot.errorCount, errorsAtInstall, "none of these raised a Lua error");

    // A native command that throws is reported as a line, and the stock parser still closes the box
    // (a raised error used to leave the line in an open box that every following Enter re-sent).
    const quiet = console.error;
    console.error = () => {};
    try {
      type("/boom now");
    } finally {
      console.error = quiet;
    }
    assert.equal(notices.at(-1), "Команда /boom не выполнена: kaboom");
    assert.equal(boot.bridge.isVisible(editBox), false);
    assert.equal(editBox.text, "");
    assert.equal(boot.errorCount, errorsAtInstall);

    // /run and /script run in this VM through stock SLASH_SCRIPT -> RunScript, as the original
    // client does; a failing script is one handled error, not a dead parser.
    type("/run __webclientRunProbe = 41 + 1");
    assert.equal(boot.vm.getGlobal("__webclientRunProbe"), 42);
    type("/script error('lane D probe')");
    assert.equal(boot.errorCount, errorsAtInstall + 1, "the script error reached the corpus handler once");
    assert.equal(boot.bridge.isVisible(editBox), false);
    // Stock /reload is `ConsoleExec("reloadui")`; it reaches ReloadUI (the world mount's remount),
    // and so does `/console reloadui`. Any other console command is answered with a line.
    boot.vm.execute("__webclientReloads = 0; ReloadUI = function() __webclientReloads = __webclientReloads + 1 end",
      "@test/reload");
    const noticesBeforeReload = notices.length;
    type("/reload");
    assert.equal(boot.vm.getGlobal("__webclientReloads"), 1, "/reload ran ReloadUI");
    type("/console  ReloadUI ");
    assert.equal(boot.vm.getGlobal("__webclientReloads"), 2);
    assert.equal(notices.length, noticesBeforeReload, "a reload is not «console unavailable»");
    type("/console foo");
    assert.match(notices.at(-1), /Консоль клиента недоступна.*«foo»/);
    assert.equal(boot.vm.getGlobal("__webclientReloads"), 2);

    // /help: Blizzard's lines, then one line per mirrored native command, pipes written as `||`.
    const before = chat.messageFrame.messages.length;
    type("/help");
    const added = chat.messageFrame.messages.slice(before).map(({ text }) => text);
    const header = added.indexOf("Команды WebClient:");
    assert.ok(header > 0, "native lines follow the stock help text");
    const nativeLines = added.slice(header + 1);
    assert.ok(nativeLines.includes("/vehicle enter||leave||next||prev||eject — транспорт"), nativeLines.join("\n"));
    assert.equal(plainFrameXmlText("/vehicle enter||leave||next||prev||eject — транспорт"),
      "/vehicle enter|leave|next|prev|eject — транспорт", "the stock text parser shows one pipe and no line break");
    assert.ok(nativeLines.includes("Эмоции сервера: /fail"), "a secure command is not an emote fallback");
    for (const line of nativeLines) {
      assert.doesNotMatch(line, /\/invite|\/who |\/cast/, "stock-owned commands are not listed twice");
    }

    // A module command added later is mirrored before the next send.
    commands = [...NATIVE, { name: "mycmd", aliases: ["mycmd"], usage: "/mycmd", help: "модуль" }];
    for (const listener of listeners) listener();
    assert.deepEqual(type("/mycmd go").native, [["mycmd", "go"]]);
    commands = [...NATIVE];
    for (const listener of listeners) listener();
    const gone = chat.messageFrame.messages.length;
    assert.deepEqual(type("/mycmd go").native, [], "a removed module command is removed from stock too");
    assert.ok(chat.messageFrame.messages.length > gone, "and stock answers it with HELP_TEXT_SIMPLE");

    // The keyboard owner: Enter opens and focuses the stock edit box; `/` arrives on the next tick.
    assert.equal(boot.bridge.isVisible(editBox), false);
    assert.equal(openChatInput("/"), true);
    assert.equal(boot.bridge.isVisible(editBox), true);
    assert.ok(input.focused > 0, "the rendered input is focused at once");
    boot.bridge.tick(0.016);
    assert.equal(editBox.text, "/", "ChatEdit_OnUpdate applied OPENCHATSLASH's text");
    // ChatEdit_UpdateHeader's own SetTextInsets(15 + header:GetWidth(), 13, 0, 0) reaches the model
    // the renderer pads the input with, and the EditBox is left-justified: stock alone, no hook.
    boot.vm.execute("__webclientHeaderWidth = ChatFrame1EditBoxHeader:GetWidth()", "@test/header");
    const headerWidth = boot.vm.getGlobal("__webclientHeaderWidth");
    assert.equal(typeof headerWidth, "number");
    assert.deepEqual(editBox.textInsets, { left: 15 + headerWidth, right: 13, top: 0, bottom: 0 });
    assert.equal(editBox.justifyH, "LEFT");
    for (const callback of scheduled.splice(0)) callback();
    boot.bridge.fireScript(editBox, "OnEscapePressed");
    assert.equal(boot.bridge.isVisible(editBox), false, "Escape closes it");
    // A link with the box closed opens it with the link; with it open, the link is inserted.
    insertChatLink("|cff1eff00|Hitem:2589:0:0:0:0:0:0:0:80|h[Льняная ткань]|h|r");
    boot.bridge.tick(0.016);
    assert.match(editBox.text, /\|Hitem:2589/);
    insertChatLink("[x]");
    assert.match(editBox.text, /\|r \[x\]$/, "ChatEdit_InsertLink appends with a space");
    boot.bridge.fireScript(editBox, "OnEscapePressed");
    assert.equal(failures, 0);
    // With the chat box closed and the Auction House search shown, stock ChatEdit_InsertLink puts the
    // item's name there (ChatFrame.lua:3496-3505). That is a handled link: the stock owner stays and
    // no chat box opens.
    boot.vm.execute(`
      __webclientBrowse = nil
      BrowseName = { IsVisible = function() return true end, SetText = function(_, text) __webclientBrowse = text end }
      GetItemInfo = function() return "Льняная ткань" end
    `, "@test/browse");
    const focusedBefore = input.focused;
    assert.equal(insertChatLink("|cff1eff00|Hitem:2589:0:0:0:0:0:0:0:80|h[Льняная ткань]|h|r"), true);
    assert.equal(boot.vm.getGlobal("__webclientBrowse"), "Льняная ткань");
    assert.equal(failures, 0, "the native form is not brought back");
    assert.equal(chatInputReplaced(), true, "the stock owner keeps the chat keys");
    assert.equal(boot.bridge.isVisible(editBox), false, "no chat box was opened as well");
    assert.equal(input.focused, focusedBefore);
    boot.vm.execute("BrowseName = nil", "@test/browse");
    assert.equal(boot.errorCount, errorsAtInstall + 1, "only the deliberate /script error");
  } finally {
    const installedExecutor = runner.macroLineExecutor();
    release?.();
    assert.equal(chatInputReplaced(), false, "the cleanup returns the keys to the native input");
    // The macro executor and the /click frames leave with the stock chat.
    assert.equal(typeof installedExecutor, "function");
    assert.equal(runner.macroLineExecutor(), undefined);
    assert.equal(runner.macroClickFrame("WebClientClickProbe"), undefined);
    // So does the ID reading of stock SecureCmdItemParse: a bare number is an inventory slot again.
    boot.vm.execute('__webclientParsed = tostring(select(3, SecureCmdItemParse("133")))', "@test/item");
    assert.equal(boot.vm.getGlobal("__webclientParsed"), "133");
    boot.close();
  }
});
