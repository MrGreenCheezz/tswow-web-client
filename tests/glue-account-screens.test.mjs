// 10.30 (15.11) — «Новая запись» / «Смена пароля» on the stock login screen (GlueAccountScreens.ts): loaded into
// the real GlueXML of the client on this machine, opened by the stock «Учетная запись» button, reporting through
// the stock GlueDialog. The account client is a stand-in; the gateway side is account-self-service.test.mjs.
import assert from "node:assert/strict";
import test from "node:test";

import { AuthProtocolError } from "../dist/code/auth/AuthProtocol.js";
import { GLUE_ACCOUNT_TEXT } from "../dist/code/browser/glue/GlueAccountScreens.js";

let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine" };
// One archive chain per process (tools/mpq.mjs): closed once, after every test.
test.after(async () => {
  if (clientDirectory) (await (await import("../tools/mpq.mjs")).clientArchives(clientDirectory)).close();
});

function fakeAccounts(available) {
  const calls = [];
  const answers = { register: { ok: true, username: "HERO" }, change: { ok: true, username: "HERO" } };
  return {
    calls,
    answers,
    available: async () => available,
    register: async (name, password) => { calls.push(["register", name, password]); return answers.register; },
    changePassword: async (name, oldPassword, password) => {
      calls.push(["change", name, oldPassword, password]);
      return answers.change;
    },
  };
}

async function loginScreen(accounts) {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const chain = await clientArchives(clientDirectory);
  const { GlueRuntime } = await import("../dist/code/browser/glue/GlueRuntime.js");
  const launched = [];
  const luaErrors = [];
  const runtime = new GlueRuntime({
    provider: {
      async read(path) {
        const data = await chain.read(path.replaceAll("/", "\\"));
        return data ? new TextDecoder("utf-8").decode(data) : undefined;
      },
    },
    lua: { onError: (message) => { luaErrors.push(message); } },
    api: { locale: "ruRU", screenWidth: 1024, screenHeight: 768, onLaunchUrl: (url) => launched.push(url) },
    accounts,
  });
  await runtime.load();
  assert.equal(runtime.api.setGlueScreen("login"), true);
  await runtime.accountScreens.ready;
  const lua = (source) => {
    runtime.vm.setGlobal("__result", undefined);
    const outcome = runtime.vm.execute(`__result = (function() ${source} end)()`, "@glue-account-probe");
    assert.equal(outcome.ok, true, `${source}: ${outcome.error ?? ""}`);
    return runtime.vm.getGlobal("__result");
  };
  const shown = (name) => runtime.bridge.isVisible(runtime.bridge.getFrame(name));
  return { runtime, chain, lua, shown, launched, luaErrors };
}

test("the stock «Учетная запись» button opens «Новая запись», which registers and hands the name to the login form", withClient, async () => {
  const accounts = fakeAccounts(true);
  const { runtime, chain, lua, shown, launched, luaErrors } = await loginScreen(accounts);
  try {
    assert.deepEqual(runtime.accountScreens.load.diagnostics, [], "the panel loads without a diagnostic");
    assert.equal(shown("WebClientAccountFrame"), false);
    lua("AccountLoginManageAccountButton:Click(); return 1");
    assert.equal(shown("WebClientAccountFrame"), true);
    assert.deepEqual(launched, [], "not the account site");
    assert.equal(lua("return WebClientAccountFrameBackgroundTitle:GetText()"), lua("return CREATE_ACCOUNT"));
    assert.equal(shown("WebClientAccountFrameOldPassword"), false);
    assert.equal(lua("return WebClientAccountFrameNameLabel:GetText()"), lua("return ACCOUNT_NAME"));

    lua('WebClientAccountFrameName:SetText("Hero"); WebClientAccountFramePassword:SetText("a"); WebClientAccountFrameRepeat:SetText("b"); return 1');
    lua("WebClientAccountFrameBackgroundOkayButton:Click(); return 1");
    assert.equal(accounts.calls.length, 0, "a mismatch is not sent");
    assert.equal(shown("GlueDialog"), true);
    assert.equal(lua("return GlueDialogText:GetText()"), GLUE_ACCOUNT_TEXT.mismatch);
    assert.equal(shown("AccountLoginUI"), false, "a GlueDialog over the panel does not bring the login form back");
    assert.equal(lua("return WebClientAccountFramePassword:GetText()"), "", "typed passwords are cleared after a submit");
    lua("GlueDialogButton1:Click(); return 1");

    lua('WebClientAccountFramePassword:SetText("pw"); WebClientAccountFrameRepeat:SetText("pw"); return 1');
    lua("WebClientAccountFrameBackgroundOkayButton:Click(); return 1");
    assert.equal(lua("return GlueDialogText:GetText()"), lua("return ACCOUNT_CREATE_IN_PROGRESS"));
    await runtime.accountScreens.idle();
    assert.deepEqual(accounts.calls, [["register", "Hero", "pw"]]);
    assert.equal(lua("return GlueDialogText:GetText()"), lua("return ACCOUNT_CREATE_SUCCESS"));
    assert.equal(shown("WebClientAccountFrame"), false);
    assert.equal(shown("AccountLoginUI"), true, "success restores the login form");
    assert.equal(lua("return AccountLoginAccountEdit:GetText()"), "HERO");

    accounts.answers.register = { ok: false, error: "taken" };
    lua("AccountLogin_ManageAccount(); return 1");
    lua('WebClientAccountFramePassword:SetText("pw"); WebClientAccountFrameRepeat:SetText("pw"); WebClientAccountFrame_Okay(); return 1');
    await runtime.accountScreens.idle();
    assert.equal(lua("return GlueDialogText:GetText()"), lua("return CHAR_CREATE_NAME_IN_USE"));
    assert.equal(shown("WebClientAccountFrame"), true, "the form stays for another name");
    assert.deepEqual(luaErrors, []);
  } finally {
    runtime.close();
    void chain;
  }
});

test("«Смена пароля» asks for the old password and shows the login's own refusal", withClient, async () => {
  const accounts = fakeAccounts(true);
  const { runtime, chain, lua, shown, luaErrors } = await loginScreen(accounts);
  try {
    lua('AccountLoginAccountEdit:SetText("hero"); AccountLogin_ManageAccount(); WebClientAccountFrameSwitchButton:Click(); return 1');
    assert.equal(lua("return WebClientAccountFrameBackgroundTitle:GetText()"), GLUE_ACCOUNT_TEXT.changeTitle);
    assert.equal(shown("WebClientAccountFrameOldPassword"), true);
    assert.equal(lua("return WebClientAccountFrameName:GetText()"), "hero", "the login form's name is taken over");

    lua('WebClientAccountFramePassword:SetText("new"); WebClientAccountFrameRepeat:SetText("new"); WebClientAccountFrame_Okay(); return 1');
    assert.equal(lua("return GlueDialogText:GetText()"), lua("return LOGIN_ENTER_PASSWORD"), "no old password");
    assert.equal(accounts.calls.length, 0);

    accounts.answers.change = { ok: false, error: "auth", cause: new AuthProtocolError("refused", 4) };
    lua('WebClientAccountFrameOldPassword:SetText("old"); WebClientAccountFramePassword:SetText("new"); WebClientAccountFrameRepeat:SetText("new"); WebClientAccountFrame_Okay(); return 1');
    await runtime.accountScreens.idle();
    assert.deepEqual(accounts.calls, [["change", "hero", "old", "new"]]);
    assert.equal(shown("GlueDialog"), true);
    assert.notEqual(lua("return GlueDialog.which"), "WEBCLIENT_ACCOUNT_WAIT", "the progress dialog is gone");

    accounts.answers.change = { ok: true, username: "HERO" };
    lua('WebClientAccountFrameOldPassword:SetText("old2"); WebClientAccountFramePassword:SetText("new"); WebClientAccountFrameRepeat:SetText("new"); WebClientAccountFrame_Okay(); return 1');
    await runtime.accountScreens.idle();
    assert.equal(lua("return GlueDialogText:GetText()"), GLUE_ACCOUNT_TEXT.changed);
    assert.equal(shown("WebClientAccountFrame"), false);
    assert.deepEqual(luaErrors, []);
  } finally {
    runtime.close();
    void chain;
  }
});

test("the panel's look: the login form hidden under it and back on every way out, stock edit colours, switch inside the box", withClient, async () => {
  const { runtime, chain, lua, shown, luaErrors } = await loginScreen(fakeAccounts(true));
  try {
    assert.equal(shown("AccountLoginUI"), true);
    for (const [how, close] of [["Отмена", "WebClientAccountFrameBackgroundCancelButton:Click()"],
      ["Escape", 'WebClientAccountFrame_OnKeyDown("ESCAPE")'], ["Escape in a field", "WebClientAccountFrameName:GetScript(\"OnEscapePressed\")(WebClientAccountFrameName)"]]) {
      lua("AccountLogin_ManageAccount(); return 1");
      assert.equal(shown("AccountLoginUI"), false, `${how}: hidden while the panel is up`);
      lua(`${close}; return 1`);
      assert.equal(shown("WebClientAccountFrame"), false, how);
      assert.equal(shown("AccountLoginUI"), true, `${how}: restored`);
    }

    const colors = (name) => lua(`local r, g, b = ${name}:GetBackdropBorderColor(); local r2, g2, b2 = ${name}:GetBackdropColor();
      return string.format("%.3f %.3f %.3f / %.3f %.3f %.3f", r, g, b, r2, g2, b2)`);
    const stock = colors("AccountLoginAccountEdit");
    assert.equal(stock, "0.800 0.800 0.800 / 0.090 0.090 0.090");
    for (const name of ["WebClientAccountFrameName", "WebClientAccountFrameOldPassword", "WebClientAccountFramePassword", "WebClientAccountFrameRepeat"]) {
      assert.equal(colors(name), stock, name);
    }

    const inside = (name) => lua(`local box, f = WebClientAccountFrameBackground, ${name};
      return f:GetLeft() >= box:GetLeft() and f:GetRight() <= box:GetRight() and f:GetBottom() >= box:GetBottom() and f:GetTop() <= box:GetTop()`);
    const below = (upper, lower) => lua(`return ${upper}:GetBottom() >= ${lower}:GetTop()`);
    for (const mode of ["create", "change"]) {
      lua(`WebClientAccountFrame_Open("${mode}"); return 1`);
      assert.equal(inside("WebClientAccountFrameSwitchButton"), true, `${mode}: switch inside the box`);
      assert.equal(below("WebClientAccountFrameSwitchButton", "WebClientAccountFrameBackgroundOkayButton"), true, `${mode}: above the buttons`);
      assert.equal(below("WebClientAccountFrameRepeat", "WebClientAccountFrameSwitchButton"), true, `${mode}: under the last field`);
      for (const field of ["WebClientAccountFrameName", "WebClientAccountFramePassword", "WebClientAccountFrameRepeat"]) {
        assert.equal(inside(field), true, `${mode}: ${field} inside the box`);
      }
      assert.equal(lua("return WebClientAccountFrameBackground:GetBottom() >= 0 and WebClientAccountFrameBackground:GetTop() <= 768"), true,
        `${mode}: the box fits the 768-high screen`);
    }
    lua("WebClientAccountFrame_Cancel(); return 1");
    assert.deepEqual(luaErrors, []);
  } finally {
    runtime.close();
    void chain;
  }
});

test("with the forms off on the gateway the button does what it always did", withClient, async () => {
  const { runtime, chain, lua, shown, launched } = await loginScreen(fakeAccounts(false));
  try {
    lua("AccountLoginManageAccountButton:Click(); return 1");
    assert.equal(shown("WebClientAccountFrame"), false);
    assert.deepEqual(launched, [lua("return AUTH_NO_TIME_URL")]);
  } finally {
    runtime.close();
    void chain;
  }
});
