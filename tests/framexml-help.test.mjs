// 3.24 (12.10): the GM ticket window — stock HelpFrame/KnowledgeBaseFrame (TOC 115-116) over the ticket opcodes
// (FrameXmlHelp.ts after Wow.exe 0x005ad080..0x005ad1c0, 0x005ac8f0, 0x005ad240, 0x006e2e90), gated as the world
// mount does (FrameXmlHelpOwner.ts).
import assert from "node:assert/strict";
import test from "node:test";

let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}

const { FrameXmlHelpModel, FRAMEXML_HELP_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlHelp.js");
const { FrameXmlCannedHelpWorld, FRAMEXML_CANNED_TICKET, FRAMEXML_CANNED_RESPONSE } = await import(
  "../dist/code/browser/framexml/FrameXmlHelpCanned.js",
);

function scene() {
  const world = new FrameXmlCannedHelpWorld();
  const errors = [];
  const help = new FrameXmlHelpModel({ world: () => world, uiError: (key) => errors.push(key), now: () => 90_000 });
  const fired = [];
  help.attach({ fire(event, ...args) { fired.push([event, ...args]); return 1; } });
  const api = (name, ...args) => [...FRAMEXML_HELP_BINDINGS[name]({ help }, args)];
  return { world, help, fired, errors, api };
}

test("the ticket answers raise Wow.exe's events (0x005ad240, 0x006e2e90)", () => {
  const { world, fired, errors } = scene();
  world.answerTicket();
  const ticket = FRAMEXML_CANNED_TICKET;
  assert.deepEqual(fired.at(-1), ["UPDATE_TICKET", 0, ticket.message, ticket.ageDays, ticket.oldestTicketAgeDays,
    ticket.lastUpdatedDays, 0, 0], "category (the need-more-help byte), text, three ages in days, escalation, opened");
  world.answerTicket(null);
  assert.deepEqual(fired.at(-1), ["UPDATE_TICKET"], "no ticket: no arguments");
  assert.deepEqual(errors, []);
  // The answers to the three requests, the queue status and a GM's response.
  const zero = { world };
  const errorsZero = errors;
  const firedZero = fired;
  const model = { detach() {} };
  zero.world.answerResult("create", 2);
  assert.deepEqual(zero.world.calls.at(-1), { kind: "get" }, "a created ticket is asked for again");
  const asked = zero.world.calls.length;
  zero.world.answerResult("update", 4);
  assert.deepEqual(zero.world.calls.slice(asked), [{ kind: "get" }], "so is an updated one");
  zero.world.answerResult("create", 1);
  zero.world.answerResult("create", 3);
  zero.world.answerResult("update", 5);
  zero.world.answerResult("delete", 2);
  assert.deepEqual(errorsZero, ["ERR_TICKET_ALREADY_EXISTS", "ERR_TICKET_CREATE_ERROR", "ERR_TICKET_UPDATE_ERROR", "ERR_TICKET_DB_ERROR"]);
  zero.world.answerResult("delete", 9);
  assert.deepEqual(firedZero.at(-1), ["UPDATE_TICKET"], "a deleted ticket is gone");
  zero.world.answerStatus(0);
  assert.deepEqual(firedZero.at(-1), ["UPDATE_GM_STATUS", 0], "the word as sent");
  zero.world.answerResponse();
  assert.deepEqual(firedZero.at(-1), ["GMRESPONSE_RECEIVED", FRAMEXML_CANNED_RESPONSE.message, FRAMEXML_CANNED_RESPONSE.response]);
  model.detach();
});

test("the ticket commands follow 0x005ac8f0, 0x005acb50, 0x005acc60 and 0x005acce0", () => {
  const { world, errors, api } = scene();
  api("GetGMTicket");
  api("GetGMStatus");
  assert.deepEqual(world.calls.map((call) => call.kind), ["get", "status"]);
  world.calls.length = 0;
  api("NewGMTicket", "x".repeat(501), 1);
  api("NewGMTicket", "   ", 1);
  assert.deepEqual(errors, ["ERR_TICKET_TEXT_TOO_LONG", "ERR_TICKET_NO_TEXT"]);
  api("NewGMTicket", "Помогите", 1);
  const created = world.calls.at(-1);
  assert.equal(created.kind, "create");
  assert.deepEqual({ ...created.request, chatLog: undefined }, {
    mapId: 0, x: -9460, y: 62, z: 56, message: "Помогите", needResponse: true, needMoreHelp: false,
    chatTimes: [90], chatLog: undefined,
  }, "the map, the position, and each chat line's age in seconds");
  api("UpdateGMTicket", "Ещё");
  api("DeleteGMTicket");
  api("GMResponseResolve");
  api("GMResponseNeedMoreHelp", "Не помогло");
  assert.equal(world.calls.length, 1, "no ticket: no update or delete; no response: no resolve or follow-up");
  world.gmTicket = FRAMEXML_CANNED_TICKET;
  api("NewGMTicket", "Второй", 0);
  assert.equal(world.calls.length, 1, "an open ticket takes no second one");
  api("UpdateGMTicket", "Ещё");
  api("DeleteGMTicket");
  assert.deepEqual(world.calls.slice(1), [{ kind: "update", message: "Ещё" }, { kind: "delete" }]);
  world.gmResponse = FRAMEXML_CANNED_RESPONSE;
  api("UpdateGMTicket", "Поздно");
  assert.equal(world.calls.length, 3, "with a GM response the ticket is not edited");
  api("GMResponseNeedMoreHelp", "Не помогло");
  assert.equal(world.calls.at(-1).request.needMoreHelp, true);
  assert.equal(world.calls.at(-1).request.needResponse, true);
  api("GMResponseResolve");
  assert.deepEqual(world.calls.at(-1), { kind: "resolve" });
});

test("the knowledge base is never reached: its load fails a moment later", async () => {
  const { fired, api } = scene();
  api("KBSetup_BeginLoading", 20, 1);
  assert.deepEqual(fired, [], "not inside the call");
  await Promise.resolve();
  assert.deepEqual(fired, [["KNOWLEDGE_BASE_SETUP_LOAD_FAILURE"]]);
  assert.deepEqual(api("KBSetup_IsLoaded"), [false]);
  assert.deepEqual(api("KBSystem_GetMOTD"), [undefined]);
});

test("stock HelpFrame passes its gate, opens the knowledge base and edits the open ticket", {
  skip: clientDirectory ? false : "no 3.3.5a client on this machine",
}, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
  const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
  const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
  const { frameXmlHelpGate, createFrameXmlHelpOwner } = await import("../dist/code/browser/framexml/FrameXmlHelpOwner.js");
  const chain = await clientArchives(clientDirectory);
  const decoder = new TextDecoder("utf-8");
  const seam = new CannedWorldSeam();
  const boot = new FrameXmlBoot({
    provider: { async read(path) { const data = await chain.read(path); return data ? decoder.decode(data) : undefined; } },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, exercise: false, screen: () => ({ width: 1024, height: 768 }),
  });
  try {
    const inventory = await boot.load();
    assert.equal(inventory.lua.failed, 0, "HelpFrame.xml and KnowledgeBaseFrame.xml load without a Lua error");
    const elements = new Map();
    for (const current of boot.bridge.frames) {
      elements.set(current, {
        parentElement: current.parent ? elements.get(current.parent) : undefined,
        getAttribute(attribute) {
          if (attribute === "data-framexml-name") return current.name;
          if (attribute === "data-framexml-type") return current.type;
          return null;
        },
      });
    }
    const renderer = { elementFor(frame) { return elements.get(frame); } };
    const lua = (code) => {
      const fn = boot.vm.compileFunction(code, "help-test", []);
      try { return boot.vm.call(fn, [], 1)[0]; } finally { boot.vm.release(fn); }
    };
    const world = seam.helpWorld;
    world.calls.length = 0;
    const gate = frameXmlHelpGate(seam, boot, renderer);
    assert.ok(gate, "HelpFrame passes its gate");
    assert.deepEqual(world.calls, [], "the gate asks the server nothing");
    const owner = createFrameXmlHelpOwner(boot, gate.frame);
    const errors = boot.errors.length + boot.vm.errors.length;
    owner.toggle();
    assert.equal(owner.isOpen(), true);
    assert.equal(lua("return KnowledgeBaseFrame:IsShown() and 1 or 0"), 1, "the start page is the knowledge base");
    assert.deepEqual(world.calls.map((call) => call.kind), ["status", "status", "get"],
    "it asks the queue (HelpFrame_OnShow and KnowledgeBaseFrame_OnShow both) and the ticket");
    await Promise.resolve();
    assert.equal(lua("return KnowledgeBaseErrorFrame:IsShown() and 1 or 0"), 1, "the knowledge base's load failure is shown");
    // The server's ticket: the edit/abandon buttons and the status box.
    world.answerTicket();
    assert.equal(lua("return KnowledgeBaseFrameEditTicket:IsShown() and 1 or 0"), 1);
    assert.equal(lua("return TicketStatusFrame:IsShown() and 1 or 0"), 1, "TicketStatusFrame shows the open ticket");
    lua("HelpFrame_ShowFrame('OpenTicket')");
    assert.equal(lua("return HelpFrameOpenTicketEditBox:GetText()"), FRAMEXML_CANNED_TICKET.message);
    lua("HelpFrameOpenTicketEditBox:SetText('Всё ещё застрял')");
    assert.equal(boot.bridge.Click(boot.bridge.getFrame("HelpFrameOpenTicketSubmit")), true);
    assert.deepEqual(world.calls.at(-1), { kind: "update", message: "Всё ещё застрял" });
    assert.equal(owner.isOpen(), false, "Submit closes the window (HelpFrame.lua:319-330)");
    // A GM's answer: the response page and its two buttons.
    world.answerResponse();
    owner.toggle();
    lua("HelpFrame_ShowFrame('GMResponse')");
    assert.match(lua("return HelpFrameViewResponseMessageBody:GetText()"), /переместили вашего персонажа/);
    owner.close();
    assert.equal(owner.isOpen(), false);
    assert.equal(boot.errors.length + boot.vm.errors.length, errors, JSON.stringify(boot.errors.slice(-2)));
  } finally {
    boot.close();
    chain.close();
  }
});
