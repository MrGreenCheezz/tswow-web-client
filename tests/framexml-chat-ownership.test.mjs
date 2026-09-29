import assert from "node:assert/strict";
import test from "node:test";

function fakeNode(tag) {
  const attributes = new Map();
  const classes = new Set();
  const context = {
    setTransform() {}, clearRect() {}, save() {}, beginPath() {}, arc() {}, clip() {},
    fillRect() {}, restore() {}, translate() {}, rotate() {}, moveTo() {}, lineTo() {},
    closePath() {}, drawImage() {}, stroke() {}, fill() {},
  };
  const node = {
    tagName: tag.toUpperCase(), children: [], parentNode: undefined, ownerDocument: undefined,
    get parentElement() { return node.parentNode; },
    get firstChild() { return node.children[0] ?? null; },
    get nextSibling() {
      if (!node.parentNode) return null;
      const index = node.parentNode.children.indexOf(node);
      return index >= 0 ? node.parentNode.children[index + 1] ?? null : null;
    },
    style: { display: "", setProperty() {}, removeProperty() {} },
    clientWidth: 1024, clientHeight: 768, scrollTop: 0, scrollHeight: 0,
    textContent: "", value: "", hidden: false, width: 0, height: 0, offsetWidth: 0, offsetHeight: 0,
    dataset: {}, className: "", id: "", selectionStart: 0, selectionEnd: 0,
    selectionDirection: "none",
    classList: {
      add(...names) { for (const name of names) classes.add(name); },
      remove(...names) { for (const name of names) classes.delete(name); },
      toggle(name, force) {
        const active = force === undefined ? !classes.has(name) : force;
        if (active) classes.add(name); else classes.delete(name);
        return active;
      },
      contains(name) { return classes.has(name); },
    },
    append(...children) {
      for (const child of children) {
        child.remove?.(); child.parentNode = node; node.children.push(child);
      }
    },
    insertBefore(child, reference) {
      child.remove?.(); child.parentNode = node;
      const index = reference == null ? -1 : node.children.indexOf(reference);
      if (index < 0) node.children.push(child); else node.children.splice(index, 0, child);
    },
    replaceChildren(...children) {
      for (const old of node.children) old.parentNode = undefined;
      for (const child of children) child.parentNode = node;
      node.children = [...children];
    },
    remove() {
      if (!node.parentNode) return;
      node.parentNode.children = node.parentNode.children.filter((child) => child !== node);
      node.parentNode = undefined;
    },
    setAttribute(name, value) {
      const stringValue = String(value);
      attributes.set(name, stringValue);
      if (name.startsWith("data-")) {
        const key = name.slice(5).replace(/-([a-z])/g, (_match, character) => character.toUpperCase());
        node.dataset[key] = stringValue;
      }
    },
    getAttribute(name) { return attributes.get(name) ?? null; },
    removeAttribute(name) { attributes.delete(name); },
    addEventListener() {}, removeEventListener() {},
    focus() { if (node.ownerDocument) node.ownerDocument.activeElement = node; },
    setSelectionRange(start, end, direction = "none") {
      node.selectionStart = start; node.selectionEnd = end; node.selectionDirection = direction;
    },
    getContext() { return context; },
    querySelector(selector) {
      return node.querySelectorAll(selector)[0] ?? null;
    },
    querySelectorAll(selector) {
      const found = [];
      const visit = (candidate) => {
        for (const child of candidate.children) {
          if (matches(child, selector)) found.push(child);
          visit(child);
        }
      };
      visit(node);
      return found;
    },
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
  };
  return node;
}

function matches(node, selector) {
  if (selector === 'button[type="submit"]') return node.tagName === "BUTTON" && node.getAttribute("type") === "submit";
  const data = selector.match(/^\[([^=]+)="([^"]+)"\]$/);
  if (data) return node.getAttribute(data[1]) === data[2];
  const taggedData = selector.match(/^([a-z]+)\[([^=]+)="([^"]+)"\]$/);
  if (taggedData) return node.tagName === taggedData[1].toUpperCase() && node.getAttribute(taggedData[2]) === taggedData[3];
  const canvas = selector.match(/^canvas\[data-portrait-slot="([^"]+)"\]$/);
  if (canvas) return node.tagName === "CANVAS" && node.dataset.portraitSlot === canvas[1];
  return selector.startsWith(".") && node.classList.contains(selector.slice(1));
}

const document = {
  activeElement: null,
  head: fakeNode("head"),
  body: fakeNode("body"),
  createElement(tag) { const node = fakeNode(tag); node.ownerDocument = document; return node; },
  getElementById(id) { return ids.get(id) ?? fakeNode("div"); },
  querySelectorAll() { return []; },
};
document.head.ownerDocument = document;
document.body.ownerDocument = document;
globalThis.document = document;

const viewport = fakeNode("div");
viewport.ownerDocument = document;
const chatTabs = fakeNode("div");
const chatLog = fakeNode("div");
chatLog.clientHeight = 20; chatLog.scrollHeight = 100; chatLog.scrollTop = 10;
const chatInput = fakeNode("input");
chatInput.value = "keep this"; chatInput.selectionStart = 2; chatInput.selectionEnd = 6;
const chatWindow = fakeNode("div");
const rightRail = fakeNode("div");
const playerIconParent = fakeNode("div");
const targetIconParent = fakeNode("div");
const playerIcon = fakeNode("img");
const targetIcon = fakeNode("img");
playerIconParent.append(playerIcon); targetIconParent.append(targetIcon);
const ids = new Map([
  ["login-form", (() => { const form = fakeNode("form"); const submit = fakeNode("button"); submit.setAttribute("type", "submit"); form.append(submit); return form; })()],
  ["create-form", (() => { const form = fakeNode("form"); const submit = fakeNode("button"); submit.setAttribute("type", "submit"); form.append(submit); return form; })()],
  ["world-viewport", viewport], ["chat-tabs", chatTabs], ["chat-log", chatLog],
  ["chat-input", chatInput], ["chat-window", chatWindow], ["right-rail", rightRail],
  ["player-icon", playerIcon], ["target-icon", targetIcon],
]);
for (const node of ids.values()) node.ownerDocument = document;

let nextFrame = 1;
globalThis.window = {
  innerWidth: 1024, innerHeight: 768, devicePixelRatio: 1,
  location: { protocol: "http:", hostname: "localhost" },
  addEventListener() {}, removeEventListener() {},
  requestAnimationFrame() { return nextFrame++; }, cancelAnimationFrame() {},
};
globalThis.location = globalThis.window.location;
globalThis.localStorage = { getItem() { return null; }, setItem() {} };

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { FrameXmlDomRenderer } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlDomRenderer.js");
const { game } = await import("../dist/code/browser/game/Context.js");
const { updateMinimap } = await import("../dist/code/browser/ui/Minimap.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { mountFrameXmlVertical, unmountFrameXmlVertical } =
  await import("../dist/code/browser/framexml/FrameXmlWorldMount.js");
const { runAction } = await import("../dist/code/browser/input/Actions.js");

game.world = {
  mapId: 0,
  state: { selfGuid: 1n, objects: new Map([[1n, {
    position: { x: 0, y: 0, orientation: 0 }, fields: new Map(), typeId: 4,
  }]]) },
  targetGuid: undefined, group: { members: [] }, chatLog: [], questPoi: new Map(), aurasFor: () => [],
  currentGameTime() { return undefined; },
};
updateMinimap(0);

const fullChatTypes = [
  "SYSTEM", "SAY", "YELL", "PARTY", "RAID", "GUILD", "OFFICER", "WHISPER", "EMOTE", "CHANNEL",
];
const fullChatEvents = [
  "CHAT_MSG_SYSTEM", "CHAT_MSG_SAY", "CHAT_MSG_YELL", "CHAT_MSG_PARTY", "CHAT_MSG_RAID",
  "CHAT_MSG_GUILD", "CHAT_MSG_OFFICER", "CHAT_MSG_WHISPER", "CHAT_MSG_WHISPER_INFORM",
  "CHAT_MSG_EMOTE", "CHAT_MSG_TEXT_EMOTE", "CHAT_MSG_CHANNEL",
];
const inventory = {
  files: { total: 0, bytes: 0 }, widgets: { total: 0 }, lua: { errorsRaised: 0 }, errors: [],
  timings: { scanMs: 0, planMs: 0, loadMs: 0, totalMs: 0 },
};
let includeChat = true;
let registerChatEvents = true;
/** The stock edit box and the ChatFrame.lua functions its keyboard owner calls, recorded in Lua. */
let includeStockEditBox = false;
const seams = [];
const boots = [];
FrameXmlBoot.prototype.load = async function loadStub() {
  boots.push(this);
  this.bridge.CreateFrame("Frame", "BuffFrame");
  const target = this.bridge.CreateFrame("Button", "TargetFrame");
  this.bridge.createChild(target, "Texture", "TargetFramePortrait");
  const cluster = this.bridge.CreateFrame("Frame", "MinimapCluster");
  this.bridge.CreateFrame("Minimap", "Minimap", cluster);
  if (includeChat) {
    const chat = this.bridge.CreateFrame("ScrollingMessageFrame", "ChatFrame1");
    if (registerChatEvents) {
      for (const event of fullChatEvents) this.bridge.RegisterEvent(chat, event);
    }
  }
  if (includeStockEditBox) {
    const box = this.bridge.CreateFrame("EditBox", "ChatFrame1EditBox");
    this.bridge.Hide(box);
    const loaded = this.vm.execute(`
      __opened = {}
      SlashCmdList, hash_SlashCmdList = {}, {}
      function ChatFrame_OpenChat(text)
        __opened[#__opened + 1] = text
        ChatFrame1EditBox:Show()
        ChatFrame1EditBox:SetFocus()
        return ChatFrame1EditBox
      end
      function ChatEdit_GetActiveWindow() return ChatFrame1EditBox:IsShown() and ChatFrame1EditBox or nil end
      function ChatEdit_InsertLink(text) return false end
      function ChatFrame_ReplyTell() end
      function ChatEdit_ParseText() end
    `, "@test/chatframe");
    assert.equal(loaded.ok, true, loaded.error);
  }
  const seam = this.seam;
  seams.push(seam);
  seam?.attach(this.pump);
  return inventory;
};

const rendered = new Map();
function renderedFrame(name, type) {
  const frame = fakeNode("div");
  frame.ownerDocument = document;
  frame.setAttribute("data-framexml-name", name);
  frame.setAttribute("data-framexml-type", type);
  return frame;
}
rendered.set("BuffFrame", renderedFrame("BuffFrame", "Frame"));
const targetRendered = renderedFrame("TargetFrame", "Button");
targetRendered.style.width = "232px"; targetRendered.style.height = "100px";
const targetPortrait = renderedFrame("TargetFramePortrait", "Texture");
targetPortrait.style.width = "64px"; targetPortrait.style.height = "64px";
targetRendered.append(targetPortrait); rendered.set("TargetFrame", targetRendered);
rendered.set("TargetFramePortrait", targetPortrait);
const clusterRendered = renderedFrame("MinimapCluster", "Frame");
clusterRendered.style.width = "192px"; clusterRendered.style.height = "192px";
const minimapRendered = renderedFrame("Minimap", "Minimap");
minimapRendered.style.width = "140px"; minimapRendered.style.height = "140px";
clusterRendered.append(minimapRendered); rendered.set("MinimapCluster", clusterRendered);
rendered.set("Minimap", minimapRendered);
const chatRendered = renderedFrame("ChatFrame1", "ScrollingMessageFrame");
const messageLayer = fakeNode("div"); messageLayer.setAttribute("data-framexml-message-layer", "true");
chatRendered.append(messageLayer); rendered.set("ChatFrame1", chatRendered);
const editBoxRendered = renderedFrame("ChatFrame1EditBox", "EditBox");
const stockInput = fakeNode("input"); stockInput.ownerDocument = document;
stockInput.setAttribute("data-framexml-input", "true");
editBoxRendered.append(stockInput); rendered.set("ChatFrame1EditBox", editBoxRendered);

FrameXmlDomRenderer.prototype.mount = function mountStub() {};
FrameXmlDomRenderer.prototype.elementFor = function elementForStub(frame) {
  return frame.name === "ChatFrame1" && !includeChat ? undefined : rendered.get(frame.name);
};
FrameXmlDomRenderer.prototype.registerFonts = function registerFontsStub() {};
FrameXmlDomRenderer.prototype.tickCooldowns = function tickCooldownsStub() {};
FrameXmlDomRenderer.prototype.destroy = function destroyStub() {};

function seam(name, chatTypes = fullChatTypes) {
  return {
    name, attached: false,
    attach() { this.attached = true; }, detach() { this.attached = false; }, tick() {},
    chatWindowMessages() { return chatTypes; },
  };
}

test("chat display ownership is gated, scoped, and restores the native log", async () => {
  includeChat = true;
  document.activeElement = chatInput;
  const result = await mountFrameXmlVertical({ viewport, seam: seam("success") });
  assert.equal(result.ok, true);
  assert.equal(document.body.classList.contains("framexml-world-replaces-chat"), true);
  assert.equal(chatInput.value, "keep this", "native input is not adopted or rewritten");
  const style = document.head.children.find((node) => node.textContent.includes("framexml-world-replaces-chat"));
  assert.ok(style);
  assert.match(style.textContent, /#chat-tabs[\s\S]*#chat-log/);
  assert.doesNotMatch(style.textContent, /framexml-world-replaces-chat #chat-window/);
  assert.doesNotMatch(style.textContent, /framexml-world-replaces-chat #chat-input/);
  // The form is hidden only under the second class, which only a stock input owner adds; this
  // fixture has no ChatFrame1EditBox, so the native form stays the chat input.
  assert.match(style.textContent,
    /body\.framexml-world-replaces-chat\.framexml-world-owns-chat-input #chat-window/);
  assert.equal(document.body.classList.contains("framexml-world-owns-chat-input"), false);
  // The page-wide `input` rules of style.css must not reach an EditBox's field: it fills the box and
  // draws nothing (measured in the browser: 188x22 pill before, 527x38 = the box after).
  const reset = /#framexml-world-stage \[data-framexml-type="EditBox"\] input\[data-framexml-input="true"\] \{([^}]*)\}/
    .exec(style.textContent)?.[1] ?? "";
  for (const rule of ["position: absolute;", "inset: 0;", "min-height: 0;", "padding: 0;", "border: 0;",
    "border-radius: 0;", "background: none;", "outline: none;"]) {
    assert.ok(reset.includes(rule), `the EditBox input reset sets ${rule}`);
  }

  chatLog.scrollTop = 40;
  chatInput.value = "changed while mounted";
  unmountFrameXmlVertical();
  assert.equal(document.body.classList.contains("framexml-world-replaces-chat"), false);
  assert.equal(chatInput.value, "changed while mounted", "native input remains untouched");
  assert.equal(chatLog.scrollTop, 10, "exact native scroll offset is restored");
  assert.equal(document.activeElement, chatInput, "native focus is not stolen");
  unmountFrameXmlVertical();
  assert.equal(document.body.classList.contains("framexml-world-replaces-chat"), false);
});

test("the stock edit box owns the chat keys and the whole native chat window only while mounted", async () => {
  includeChat = true;
  includeStockEditBox = true;
  try {
    const result = await mountFrameXmlVertical({ viewport, seam: seam("stock-input") });
    assert.equal(result.ok, true);
    const boot = boots.at(-1);
    assert.equal(document.body.classList.contains("framexml-world-replaces-chat"), true);
    assert.equal(document.body.classList.contains("framexml-world-owns-chat-input"), true,
      "the stock owner installed, so #chat-window (form and input) is hidden");

    document.activeElement = null;
    assert.equal(runAction("openChat"), true);
    assert.equal(runAction("openChatSlash"), true);
    const opened = boot.vm.getGlobal("__opened");
    assert.deepEqual([boot.vm.call(boot.vm.compileFunction("return __opened[1], __opened[2]", "t", []), [], 2)],
      [["", "/"]], "Enter and `/` ran ChatFrame_OpenChat with the stock OPENCHAT/OPENCHATSLASH text");
    boot.vm.release(opened);
    assert.equal(document.activeElement, stockInput, "the rendered stock input has the keyboard");
    assert.notEqual(document.activeElement, chatInput);

    unmountFrameXmlVertical();
    assert.equal(document.body.classList.contains("framexml-world-owns-chat-input"), false);
    assert.equal(document.body.classList.contains("framexml-world-replaces-chat"), false);
    document.activeElement = null;
    assert.equal(runAction("openChat"), true);
    assert.equal(document.activeElement, chatInput, "after unmount Enter reaches the native input again");
  } finally {
    includeStockEditBox = false;
    unmountFrameXmlVertical();
  }
});

test("chat gate failure keeps native display and fallback action", async () => {
  includeChat = false;
  const before = chatInput.value;
  const result = await mountFrameXmlVertical({ viewport, seam: seam("missing") });
  assert.equal(result.ok, true, "chat is optional to the main vertical");
  assert.equal(document.body.classList.contains("framexml-world-replaces-chat"), false);
  chatInput.value = before;
  document.activeElement = null;
  assert.equal(runAction("openChat"), true);
  assert.equal(document.activeElement, chatInput, "native openChat focus remains the fallback");
  unmountFrameXmlVertical();

  includeChat = true;
  const incomplete = await mountFrameXmlVertical({
    viewport,
    seam: seam("incomplete-types", ["SYSTEM", "SAY"]),
  });
  assert.equal(incomplete.ok, true, "an incomplete chat type group must not break the vertical");
  assert.equal(document.body.classList.contains("framexml-world-replaces-chat"), false);
  unmountFrameXmlVertical();

  registerChatEvents = false;
  const unregistered = await mountFrameXmlVertical({ viewport, seam: seam("unregistered") });
  assert.equal(unregistered.ok, true, "missing event registration must not break the vertical");
  assert.equal(document.body.classList.contains("framexml-world-replaces-chat"), false);
  unmountFrameXmlVertical();
  registerChatEvents = true;
});

test("a canned seam never reaches the real world's send path", () => {
  let sent = 0;
  game.world.sendChat = () => { sent += 1; };
  const canned = new CannedWorldSeam();
  canned.sendChatMessage("hello", "SAY", undefined, "");
  assert.equal(sent, 0);
});
