import assert from "node:assert/strict";
import test from "node:test";
import { FrameXmlUiBridge } from "../dist/code/browser/ui/framexml_compat/FrameXmlRuntime.js";
import { FrameXmlAccessibility } from "../dist/code/browser/ui/framexml_compat/FrameXmlAccessibility.js";

function fakeDocument(lang = "ru") {
  const listeners = new Map();
  const doc = {
    documentElement: { lang },
    activeElement: null,
    addEventListener(type, listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    removeEventListener(type, listener) {
      listeners.set(type, (listeners.get(type) ?? []).filter((current) => current !== listener));
    },
    fire(type, event) {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
    listenerCount(type) { return (listeners.get(type) ?? []).length; },
    createElement(tag) { return node(tag); },
  };
  function node(tag) {
    const attributes = new Map();
    return {
      ownerDocument: doc,
      tagName: tag.toUpperCase(),
      parentElement: null,
      children: [],
      style: {},
      hidden: false,
      inert: false,
      disabled: false,
      isConnected: true,
      attributeWrites: 0,
      setAttribute(name, value) { this.attributeWrites += 1; attributes.set(name, String(value)); },
      getAttribute(name) { return attributes.get(name) ?? null; },
      hasAttribute(name) { return attributes.has(name); },
      removeAttribute(name) { attributes.delete(name); },
      append(...items) {
        for (const item of items) { item.parentElement = this; this.children.push(item); }
      },
      focus() {
        doc.activeElement = this;
        doc.fire("focusin", { target: this });
      },
    };
  }
  doc.body = node("body");
  return doc;
}

function mapped(map, frame, element, extra = {}) {
  map.set(frame, { frame, element, effectiveHidden: element.hidden, ...extra });
  return element;
}

test("stock controls use authored captions, localized peers and live race/class names", () => {
  const doc = fakeDocument();
  const stage = doc.createElement("section");
  doc.body.append(stage);
  const bridge = new FrameXmlUiBridge();
  const ui = bridge.CreateFrame("Frame", "AccountLoginUI");
  const account = bridge.CreateFrame("EditBox", "AccountLoginAccountEdit", ui);
  const accountFill = bridge.CreateFrame("FontString", "AccountLoginAccountEditFill", account);
  const password = bridge.CreateFrame("EditBox", "AccountLoginPasswordEdit", ui);
  const passwordFill = bridge.CreateFrame("FontString", "AccountLoginPasswordEditFill", password);
  const remember = bridge.CreateFrame("CheckButton", "AccountLoginSaveAccountName", ui);
  const rememberLabelWrap = bridge.CreateFrame("Frame", "__framexml_271", ui);
  const rememberLabel = bridge.CreateFrame("FontString", "AccountLoginSaveAccountNameText", rememberLabelWrap);
  bridge.SetText(accountFill, "|cffB5AF80Account Name");
  bridge.SetText(passwordFill, "|cffB5AF80Password");
  bridge.SetText(rememberLabel, "Запомнить логин и пароль");
  bridge.SetText(account, "PLAYER_NAME");
  bridge.SetText(password, "Secret!123");
  bridge.update(remember, (frame) => { frame.checked = true; });

  const character = bridge.CreateFrame("Frame", "CharacterCreate");
  const config = bridge.CreateFrame("Frame", "CharacterCreateConfigurationFrame", character);
  const race = bridge.CreateFrame("CheckButton", "CharacterCreateRaceButton1", config);
  const female = bridge.CreateFrame("CheckButton", "CharacterCreateGenderButtonFemale", config);
  const customization = bridge.CreateFrame("Frame", "CharacterCustomizationButtonFrame1", config);
  const customizationLabel = bridge.CreateFrame("FontString", "CharacterCustomizationButtonFrame1Text", customization);
  const nextAppearance = bridge.CreateFrame("Button", "CharacterCustomizationButtonFrame1RightButton", customization);
  const menu = bridge.CreateFrame("Button", "MainMenuMicroButton", character);
  bridge.SetText(customizationLabel, "Цвет кожи");

  const elements = new Map();
  for (const [frame, tag] of [[account, "div"], [password, "div"], [remember, "button"],
    [race, "button"], [female, "button"], [nextAppearance, "button"], [menu, "button"]]) {
    mapped(elements, frame, doc.createElement(tag));
  }
  const accountInput = doc.createElement("input");
  const passwordInput = doc.createElement("input");
  elements.get(account).input = accountInput;
  elements.get(password).input = passwordInput;
  elements.get(account).element.append(accountInput);
  elements.get(password).element.append(passwordInput);
  const helper = new FrameXmlAccessibility(stage, {
    nameForFrame: (frame) => frame === race ? "Человек" : undefined,
  });
  helper.sync(elements);

  assert.equal(accountInput.getAttribute("aria-label"), "Account Name");
  assert.equal(passwordInput.getAttribute("aria-label"), "Password", "the entered password never becomes its accessible name");
  assert.equal(accountInput.getAttribute("autocomplete"), "username");
  assert.equal(passwordInput.getAttribute("autocomplete"), "current-password");
  assert.equal(elements.get(remember).element.getAttribute("role"), "checkbox");
  assert.equal(elements.get(remember).element.getAttribute("aria-checked"), "true");
  assert.equal(elements.get(remember).element.getAttribute("aria-label"), "Запомнить логин и пароль");
  assert.equal(elements.get(race).element.getAttribute("aria-label"), "Человек");
  assert.equal(elements.get(female).element.getAttribute("aria-label"), "Женский пол");
  assert.equal(elements.get(nextAppearance).element.getAttribute("aria-label"), "Цвет кожи: следующий вариант");
  assert.equal(elements.get(menu).element.getAttribute("aria-label"), "Главное меню");

  const writes = elements.get(remember).element.attributeWrites;
  helper.sync(elements);
  assert.equal(elements.get(remember).element.attributeWrites, writes,
    "an unchanged bridge pass does not rewrite accessibility attributes");

  bridge.SetText(account, "A DIFFERENT USER");
  bridge.SetText(password, "AnotherSecret!");
  bridge.update(remember, (frame) => { frame.checked = false; });
  helper.sync(elements);
  assert.equal(accountInput.getAttribute("aria-label"), "Account Name");
  assert.equal(passwordInput.getAttribute("aria-label"), "Password");
  assert.equal(elements.get(remember).element.getAttribute("aria-checked"), "false");
  helper.destroy();
});

test("controls under a hidden FrameXML ancestor receive current semantics when revealed", () => {
  const doc = fakeDocument();
  const stage = doc.createElement("section");
  const bridge = new FrameXmlUiBridge();
  const frame = bridge.CreateFrame("CheckButton", "LazyCheck");
  const caption = bridge.CreateFrame("FontString", "LazyCheckText", frame);
  bridge.SetText(caption, "Сохранить выбор");
  const button = doc.createElement("button");
  button.hidden = true;
  stage.append(button);
  const nodes = new Map();
  mapped(nodes, frame, button, { effectiveHidden: true });
  const helper = new FrameXmlAccessibility(stage);
  helper.sync(nodes);
  assert.equal(button.getAttribute("role"), null);
  bridge.update(frame, (mutable) => { mutable.checked = true; });
  nodes.get(frame).effectiveHidden = false;
  button.hidden = false;
  button.textContent = "Сохранить выбор";
  helper.sync(nodes);
  assert.equal(button.getAttribute("role"), "checkbox");
  assert.equal(button.getAttribute("aria-checked"), "true");
  assert.equal(button.getAttribute("aria-label"), null, "the visible caption supplies the checkbox name");
  assert.equal(button.textContent, "Сохранить выбор");
  helper.destroy();
});

test("character buttons keep the browser's full name, class and zone aggregate", () => {
  const doc = fakeDocument();
  const stage = doc.createElement("section");
  const bridge = new FrameXmlUiBridge();
  const character = bridge.CreateFrame("Button", "CharacterSelectCharacterButton1");
  const button = doc.createElement("button");
  button.textContent = "";
  stage.append(button);
  const nodes = new Map();
  mapped(nodes, character, button);
  const helper = new FrameXmlAccessibility(stage);
  helper.sync(nodes);
  assert.equal(button.getAttribute("aria-label"), "Кнопка 1", "an icon starts with a fallback name");

  const identity = bridge.CreateFrame("Frame", "CharacterSelectCharacterButton1Identity", character);
  const name = bridge.CreateFrame("FontString", "CharacterName", identity);
  const classLevel = bridge.CreateFrame("FontString", "CharacterClassLevel", identity);
  const zone = bridge.CreateFrame("FontString", "CharacterZone", identity);
  bridge.SetText(name, "Аларин");
  bridge.SetText(classLevel, "Воин 12-го уровня");
  bridge.SetText(zone, "Элвиннский лес");
  button.textContent = "Аларин Воин 12-го уровня Элвиннский лес";
  helper.sync(nodes);
  assert.equal(button.getAttribute("aria-label"), null,
    "a helper label must not replace the native aggregate with only the first caption");
  assert.equal(button.textContent, "Аларин Воин 12-го уровня Элвиннский лес");
  helper.destroy();
});

test("a stock error dialog traps focus, makes background inert and restores focus on close", () => {
  const doc = fakeDocument();
  const stage = doc.createElement("section");
  const news = doc.createElement("button");
  doc.body.append(stage, news);
  const glueRootElement = doc.createElement("div");
  stage.append(glueRootElement);
  const loginElement = doc.createElement("button");
  const dialogElement = doc.createElement("div");
  glueRootElement.append(loginElement, dialogElement);
  const messageElement = doc.createElement("span");
  const okayElement = doc.createElement("button");
  const hiddenCancelElement = doc.createElement("button");
  hiddenCancelElement.hidden = true;
  dialogElement.append(messageElement, okayElement, hiddenCancelElement);

  const bridge = new FrameXmlUiBridge();
  const glueRoot = bridge.CreateFrame("Frame", "GlueParent");
  const login = bridge.CreateFrame("Button", "AccountLoginLoginButton", glueRoot);
  const dialog = bridge.CreateFrame("Frame", "GlueDialog", glueRoot);
  const background = bridge.CreateFrame("Frame", "GlueDialogBackground", dialog);
  const message = bridge.CreateFrame("FontString", "GlueDialogText", background);
  const okay = bridge.CreateFrame("Button", "GlueDialogButton1", background);
  const hiddenCancel = bridge.CreateFrame("Button", "GlueDialogButton2", background);
  bridge.SetText(message, "Неверное имя учётной записи");
  bridge.SetText(okay, "Хорошо");
  const nodes = new Map();
  mapped(nodes, glueRoot, glueRootElement);
  mapped(nodes, login, loginElement);
  mapped(nodes, dialog, dialogElement);
  mapped(nodes, background, doc.createElement("div"));
  mapped(nodes, message, messageElement);
  mapped(nodes, okay, okayElement);
  mapped(nodes, hiddenCancel, hiddenCancelElement, { effectiveHidden: true });

  loginElement.focus();
  const helper = new FrameXmlAccessibility(stage);
  helper.sync(nodes);
  assert.equal(dialogElement.getAttribute("role"), "alertdialog");
  assert.equal(dialogElement.getAttribute("aria-modal"), "true");
  assert.equal(dialogElement.getAttribute("aria-labelledby"), messageElement.getAttribute("id"));
  assert.equal(doc.activeElement, okayElement);
  assert.equal(loginElement.inert, true);
  assert.equal(news.inert, true);
  assert.equal(doc.listenerCount("keydown"), 1);
  let prevented = false;
  doc.fire("keydown", { key: "Tab", shiftKey: false, preventDefault() { prevented = true; } });
  assert.equal(prevented, true, "Tab wraps at the last dialog control");
  assert.equal(doc.activeElement, okayElement);
  news.focus();
  assert.equal(doc.activeElement, okayElement, "focus cannot escape to the background");

  nodes.get(dialog).effectiveHidden = true;
  dialogElement.hidden = true;
  helper.sync(nodes);
  assert.equal(dialogElement.getAttribute("role"), null);
  assert.equal(dialogElement.getAttribute("aria-modal"), null);
  assert.equal(loginElement.inert, false);
  assert.equal(news.inert, false);
  assert.equal(doc.activeElement, loginElement);
  assert.equal(doc.listenerCount("keydown"), 0);

  nodes.get(dialog).effectiveHidden = false;
  dialogElement.hidden = false;
  helper.sync(nodes);
  helper.destroy();
  assert.equal(news.inert, false, "destroy releases background inertness");
  assert.equal(doc.activeElement, loginElement, "destroy returns to the original control");
  assert.equal(doc.listenerCount("focusin"), 0);
});

test("a world dialog is modeless: the world, the native HUD and other windows keep their input, focus stays where it was", () => {
  const doc = fakeDocument();
  // index.html: the FrameXML host sits beside #world-canvas and the native HUD under #world-viewport.
  const worldCanvas = doc.createElement("canvas");
  const chatInput = doc.createElement("input");
  const host = doc.createElement("div");
  const stage = doc.createElement("section");
  doc.body.append(worldCanvas, chatInput, host);
  host.append(stage);
  const uiParentElement = doc.createElement("div");
  stage.append(uiParentElement);
  const moduleWindowElement = doc.createElement("div");
  const moduleButtonElement = doc.createElement("button");
  moduleWindowElement.append(moduleButtonElement);
  const dialogElement = doc.createElement("div");
  const textElement = doc.createElement("span");
  const acceptElement = doc.createElement("button");
  dialogElement.append(textElement, acceptElement);
  uiParentElement.append(moduleWindowElement, dialogElement);

  const bridge = new FrameXmlUiBridge();
  const uiParent = bridge.CreateFrame("Frame", "UIParent");
  const moduleWindow = bridge.CreateFrame("Frame", "ShopMainFrame", uiParent);
  const moduleButton = bridge.CreateFrame("Button", "ShopMainFrameBuyButton", moduleWindow);
  const dialog = bridge.CreateFrame("Frame", "StaticPopup1", uiParent);
  const text = bridge.CreateFrame("FontString", "StaticPopup1Text", dialog);
  const accept = bridge.CreateFrame("Button", "StaticPopup1Button1", dialog);
  bridge.SetText(text, "Подтвердить покупку?");
  bridge.SetText(accept, "Да");
  bridge.SetText(moduleButton, "Купить");
  const nodes = new Map();
  mapped(nodes, uiParent, uiParentElement);
  mapped(nodes, moduleWindow, moduleWindowElement);
  mapped(nodes, moduleButton, moduleButtonElement);
  mapped(nodes, dialog, dialogElement);
  mapped(nodes, text, textElement);
  mapped(nodes, accept, acceptElement);

  chatInput.focus();
  const helper = new FrameXmlAccessibility(stage, { dialogs: "modeless" });
  helper.sync(nodes);
  assert.equal(dialogElement.getAttribute("role"), "dialog", "still announced as a dialog");
  assert.equal(dialogElement.getAttribute("aria-labelledby"), textElement.getAttribute("id"));
  assert.equal(dialogElement.getAttribute("aria-modal"), null, "but not as a modal one");
  for (const [name, element] of [["the world canvas", worldCanvas], ["the native chat box", chatInput],
    ["the FrameXML host", host], ["the module's own window", moduleWindowElement]]) {
    assert.equal(element.inert, false, `${name} keeps its input`);
  }
  assert.equal(doc.activeElement === chatInput, true, "the dialog does not take the keyboard");
  assert.equal(doc.listenerCount("keydown") + doc.listenerCount("focusin"), 0, "no focus trap");
  worldCanvas.focus();
  helper.sync(nodes);
  assert.equal(doc.activeElement === worldCanvas, true, "focus may leave for the world");
  moduleButtonElement.focus();
  helper.sync(nodes);
  assert.equal(doc.activeElement === moduleButtonElement, true, "and for another window");

  nodes.get(dialog).effectiveHidden = true;
  dialogElement.hidden = true;
  helper.sync(nodes);
  assert.equal(dialogElement.getAttribute("role"), null);
  assert.equal(doc.activeElement === moduleButtonElement, true, "closing it moves nothing");
  helper.destroy();
  assert.equal(worldCanvas.inert, false);
});
