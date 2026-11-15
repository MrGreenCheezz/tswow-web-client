/**
 * 10.30 (15.11): «Новая запись» and «Смена пароля» on the login screen, built the way the stock login screen
 * builds its own panels (owner's rule of 15.11: an addition looks and behaves as the original's interface
 * would). Wow.exe 3.3.5a has no account form of its own: its login screen's «Учетная запись» button
 * (`AccountLoginManageAccountButton`, `AccountLogin_ManageAccount` → `LaunchURL(AUTH_NO_TIME_URL)`) opens the
 * account site, which is where an account was made and a password changed. Here, when the gateway has the forms
 * switched on (`GATEWAY_ACCOUNTS=1`), that same button opens them instead; otherwise it does what it always did.
 *
 * The panel is GlueXML in GlueXML's own widgets, loaded after the stock TOC into the same VM: the dimmed screen
 * and `UI-DialogBox` backdrop of `TokenEnterDialog` (AccountLogin.xml), the login screen's own edit boxes (its
 * backdrop, `GlueEditBoxFont`, label above, `password="1"`), `GlueButtonTemplateBlue` buttons, and the stock
 * GlueDialog for progress and results. Labels use the corpus' strings where it has them (CREATE_ACCOUNT,
 * ACCOUNT_NAME, PASSWORD, ACCOUNT_CREATE_*, LOGIN_ENTER_PASSWORD, CHAR_CREATE_NAME_IN_USE, LOGIN_TOO_FAST,
 * SERVER_DOWN); the rest are this file's own, in Russian.
 *
 * The work is GlueAccountClient.ts; the Lua only shows the panel and hands the typed text to
 * `WebClientAccount_Submit`, which checks it, opens the progress dialog and reports in a dialog.
 */

import { accountNameProblem, passwordProblem } from "../../auth/AccountWire.js";
import type { FrameXmlUiBridge } from "../ui/framexml_compat/FrameXmlRuntime.js";
import type { GlueAccountClient, GlueAccountOutcome } from "./GlueAccountClient.js";
import type { GlueApi } from "./GlueApi.js";
import { GlueLoader, normalizeGluePath, type GlueLoadResult } from "./GlueLoader.js";
import type { GlueLuaVm } from "./GlueLua.js";
import { describeFailure, openStatusDialog } from "./GlueMessages.js";

const DIRECTORY = "interface/webclient/";
export const GLUE_ACCOUNT_TOC = `${DIRECTORY}webclientaccount.toc`;

/** This file's own texts: what the corpus has no string for. */
export const GLUE_ACCOUNT_TEXT = Object.freeze({
  changeTitle: "Смена пароля",
  oldPassword: "Старый пароль",
  newPassword: "Новый пароль",
  repeatPassword: "Повторите пароль",
  enterName: "Введите имя учетной записи.",
  nameRule: "Имя учетной записи: до 16 латинских букв и цифр.",
  passwordRule: "Пароль: до 16 латинских букв, цифр и знаков.",
  mismatch: "Пароли не совпадают.",
  changing: "Смена пароля...",
  changed: "Пароль изменен.",
  disabled: "Этот сервер не принимает новые учетные записи.",
  notProven: "Не удалось подтвердить учетную запись. Повторите попытку.",
  maybeCreated: "Сервер не ответил вовремя: учетная запись, возможно, создана. Попробуйте войти.",
  maybeChanged: "Сервер не ответил вовремя: пароль, возможно, изменен. Попробуйте войти с новым паролем.",
});

const LUA = String.raw`
WEBCLIENT_ACCOUNT_CHANGE_TITLE = WEBCLIENT_ACCOUNT_CHANGE_TITLE or "Change password";
WEBCLIENT_ACCOUNT_OLD_PASSWORD = WEBCLIENT_ACCOUNT_OLD_PASSWORD or "Old password";
WEBCLIENT_ACCOUNT_NEW_PASSWORD = WEBCLIENT_ACCOUNT_NEW_PASSWORD or "New password";
WEBCLIENT_ACCOUNT_REPEAT_PASSWORD = WEBCLIENT_ACCOUNT_REPEAT_PASSWORD or "Repeat password";

GlueDialogTypes["WEBCLIENT_ACCOUNT_WAIT"] = {
	text = "",
	button1 = CANCEL,
	button2 = nil,
	OnAccept = function()
		WebClientAccount_Cancel();
	end,
	OnCancel = function()
	end,
}

GlueDialogTypes["WEBCLIENT_ACCOUNT_OKAY"] = {
	text = "",
	button1 = OKAY,
	button2 = nil,
}

local stockManageAccount = AccountLogin_ManageAccount;
function AccountLogin_ManageAccount()
	if ( WebClientAccount_IsAvailable() ) then
		PlaySound("gsLoginNewAccount");
		WebClientAccountFrame_Open("create");
	elseif ( stockManageAccount ) then
		stockManageAccount();
	end
end

function WebClientAccountFrame_Open(mode)
	WebClientAccountFrame.mode = mode;
	WebClientAccountFrame_Layout();
	if ( WebClientAccountFrame:IsShown() ) then
		WebClientAccountFrame_OnShow(WebClientAccountFrame);
	else
		WebClientAccountFrame:Show();
	end
end

function WebClientAccountFrame_Layout()
	local change = (WebClientAccountFrame.mode == "change");
	if ( change ) then
		WebClientAccountFrameBackgroundTitle:SetText(WEBCLIENT_ACCOUNT_CHANGE_TITLE);
		WebClientAccountFrameSwitchButton:SetText(CREATE_ACCOUNT);
		WebClientAccountFramePasswordLabel:SetText(WEBCLIENT_ACCOUNT_NEW_PASSWORD);
		WebClientAccountFrameOldPassword:Show();
	else
		WebClientAccountFrameBackgroundTitle:SetText(CREATE_ACCOUNT);
		WebClientAccountFrameSwitchButton:SetText(WEBCLIENT_ACCOUNT_CHANGE_TITLE);
		WebClientAccountFramePasswordLabel:SetText(PASSWORD);
		WebClientAccountFrameOldPassword:Hide();
	end
	WebClientAccountFrameNameLabel:SetText(ACCOUNT_NAME);
	WebClientAccountFrameOldPasswordLabel:SetText(WEBCLIENT_ACCOUNT_OLD_PASSWORD);
	WebClientAccountFrameRepeatLabel:SetText(WEBCLIENT_ACCOUNT_REPEAT_PASSWORD);
	local fields = { WebClientAccountFrameName };
	if ( change ) then
		table.insert(fields, WebClientAccountFrameOldPassword);
	end
	table.insert(fields, WebClientAccountFramePassword);
	table.insert(fields, WebClientAccountFrameRepeat);
	for index, edit in ipairs(fields) do
		edit:ClearAllPoints();
		edit:SetPoint("TOP", WebClientAccountFrameBackground, "TOP", 0, -78 - (index - 1) * 62);
	end
	WebClientAccountFrame.fields = fields;
end

function WebClientAccountFrame_ClearPasswords()
	WebClientAccountFrameOldPassword:SetText("");
	WebClientAccountFramePassword:SetText("");
	WebClientAccountFrameRepeat:SetText("");
end

-- The stock login's own edit-box colours (AccountLogin_OnLoad, DEFAULT_TOOLTIP_COLOR).
function WebClientAccountEdit_OnLoad(self)
	local color = DEFAULT_TOOLTIP_COLOR or { 0.8, 0.8, 0.8, 0.09, 0.09, 0.09 };
	self:SetBackdropBorderColor(color[1], color[2], color[3]);
	self:SetBackdropColor(color[4], color[5], color[6]);
end

function WebClientAccountFrame_OnShow(self)
	-- As the stock screen does while another full panel is up (AccountLogin_ShowUserAgreements hides AccountLoginUI
	-- under TOSFrame): the login form must not show through the translucent box.
	AccountLoginUI:Hide();
	WebClientAccountFrameSwitchButton:ClearAllPoints();
	WebClientAccountFrameSwitchButton:SetPoint("BOTTOM", WebClientAccountFrameBackground, "BOTTOM", 0,
		20 + WebClientAccountFrameBackgroundOkayButton:GetHeight());
	WebClientAccountFrame_ClearPasswords();
	if ( WebClientAccountFrameName:GetText() == "" ) then
		WebClientAccountFrameName:SetText(AccountLoginAccountEdit:GetText());
	end
	if ( WebClientAccountFrameName:GetText() == "" ) then
		WebClientAccountFrameName:SetFocus();
	else
		self.fields[2]:SetFocus();
	end
end

function WebClientAccountFrame_OnHide(self)
	WebClientAccountFrame_ClearPasswords();
	AccountLoginUI:Show();
end

function WebClientAccountFrame_Tab(self)
	local fields = WebClientAccountFrame.fields;
	for index, edit in ipairs(fields) do
		if ( edit == self ) then
			fields[(index % #fields) + 1]:SetFocus();
			return;
		end
	end
	fields[1]:SetFocus();
end

function WebClientAccountFrame_Okay()
	local change = (WebClientAccountFrame.mode == "change");
	local oldPassword = "";
	if ( change ) then
		oldPassword = WebClientAccountFrameOldPassword:GetText();
	end
	WebClientAccount_Submit(WebClientAccountFrame.mode, WebClientAccountFrameName:GetText(), oldPassword,
		WebClientAccountFramePassword:GetText(), WebClientAccountFrameRepeat:GetText());
	WebClientAccountFrame_ClearPasswords();
end

function WebClientAccountFrame_Cancel()
	PlaySound("gsTitleOptionExit");
	WebClientAccountFrame:Hide();
end

function WebClientAccountFrame_Switch()
	PlaySound("gsLoginNewAccount");
	if ( WebClientAccountFrame.mode == "change" ) then
		WebClientAccountFrame_Open("create");
	else
		WebClientAccountFrame_Open("change");
	end
end

function WebClientAccountFrame_OnKeyDown(key)
	if ( key == "ESCAPE" ) then
		WebClientAccountFrame_Cancel();
	elseif ( key == "ENTER" ) then
		WebClientAccountFrame_Okay();
	end
end

function WebClientAccountFrame_OnDone(mode, name)
	WebClientAccountFrame:Hide();
	AccountLoginAccountEdit:SetText(name);
	AccountLoginPasswordEdit:SetText("");
	AccountLoginPasswordEdit:SetFocus();
end
`;

const XML = String.raw`<Ui xmlns="http://www.blizzard.com/wow/ui/">
	<Script file="WebClientAccount.lua"/>
	<EditBox name="WebClientAccountEditTemplate" letters="16" virtual="true">
		<Size x="200" y="37"/>
		<Layers>
			<Layer level="BACKGROUND">
				<FontString name="$parentLabel" inherits="GlueFontNormal" justifyH="CENTER">
					<Size>
						<AbsDimension x="256" y="64"/>
					</Size>
					<Anchors>
						<Anchor point="BOTTOM" relativePoint="TOP">
							<Offset>
								<AbsDimension x="0" y="-23"/>
							</Offset>
						</Anchor>
					</Anchors>
				</FontString>
			</Layer>
		</Layers>
		<Backdrop bgFile="Interface\Tooltips\UI-Tooltip-Background" edgeFile="Interface\Glues\Common\Glue-Tooltip-Border" tile="true">
			<BackgroundInsets>
				<AbsInset left="10" right="5" top="4" bottom="9"/>
			</BackgroundInsets>
			<TileSize>
				<AbsValue val="16"/>
			</TileSize>
			<EdgeSize>
				<AbsValue val="16"/>
			</EdgeSize>
		</Backdrop>
		<Scripts>
			<OnLoad>
				WebClientAccountEdit_OnLoad(self);
			</OnLoad>
			<OnTabPressed>
				WebClientAccountFrame_Tab(self);
			</OnTabPressed>
			<OnEscapePressed>
				WebClientAccountFrame_Cancel();
			</OnEscapePressed>
			<OnEnterPressed>
				WebClientAccountFrame_Okay();
			</OnEnterPressed>
			<OnEditFocusLost>
				self:HighlightText(0, 0);
			</OnEditFocusLost>
			<OnEditFocusGained>
				self:HighlightText();
			</OnEditFocusGained>
		</Scripts>
		<FontString inherits="GlueEditBoxFont"/>
		<TextInsets>
			<AbsInset left="12" right="5" bottom="5"/>
		</TextInsets>
	</EditBox>
	<Frame name="WebClientAccountFrame" parent="AccountLogin" toplevel="true" setAllPoints="true" hidden="true" enableMouse="true" enableKeyboard="true" frameStrata="DIALOG">
		<Layers>
			<Layer level="BACKGROUND">
				<Texture setAllPoints="true">
					<Color a="0.75" r="0" g="0" b="0"/>
				</Texture>
			</Layer>
		</Layers>
		<Frames>
			<Frame name="$parentBackground">
				<Size>
					<AbsDimension x="372" y="430"/>
				</Size>
				<Anchors>
					<Anchor point="CENTER">
						<Offset>
							<AbsDimension x="0" y="-20"/>
						</Offset>
					</Anchor>
				</Anchors>
				<Backdrop bgFile="Interface\DialogFrame\UI-DialogBox-Background" edgeFile="Interface\DialogFrame\UI-DialogBox-Border" tile="true">
					<BackgroundInsets>
						<AbsInset left="11" right="12" top="12" bottom="11"/>
					</BackgroundInsets>
					<TileSize>
						<AbsValue val="32"/>
					</TileSize>
					<EdgeSize>
						<AbsValue val="32"/>
					</EdgeSize>
				</Backdrop>
				<Layers>
					<Layer level="ARTWORK">
						<FontString name="$parentTitle" inherits="GlueFontNormal" text="CREATE_ACCOUNT">
							<Anchors>
								<Anchor point="TOP">
									<Offset>
										<AbsDimension x="0" y="-26"/>
									</Offset>
								</Anchor>
							</Anchors>
						</FontString>
					</Layer>
				</Layers>
				<Frames>
					<EditBox name="WebClientAccountFrameName" inherits="WebClientAccountEditTemplate">
						<Anchors>
							<Anchor point="TOP">
								<Offset>
									<AbsDimension x="0" y="-78"/>
								</Offset>
							</Anchor>
						</Anchors>
					</EditBox>
					<EditBox name="WebClientAccountFrameOldPassword" inherits="WebClientAccountEditTemplate" password="1">
						<Anchors>
							<Anchor point="TOP">
								<Offset>
									<AbsDimension x="0" y="-140"/>
								</Offset>
							</Anchor>
						</Anchors>
					</EditBox>
					<EditBox name="WebClientAccountFramePassword" inherits="WebClientAccountEditTemplate" password="1">
						<Anchors>
							<Anchor point="TOP">
								<Offset>
									<AbsDimension x="0" y="-202"/>
								</Offset>
							</Anchor>
						</Anchors>
					</EditBox>
					<EditBox name="WebClientAccountFrameRepeat" inherits="WebClientAccountEditTemplate" password="1">
						<Anchors>
							<Anchor point="TOP">
								<Offset>
									<AbsDimension x="0" y="-264"/>
								</Offset>
							</Anchor>
						</Anchors>
					</EditBox>
					<Button name="$parentOkayButton" inherits="GlueButtonTemplateBlue" text="ACCEPT">
						<Anchors>
							<Anchor point="BOTTOMLEFT" relativePoint="BOTTOMLEFT">
								<Offset>
									<AbsDimension x="20" y="16"/>
								</Offset>
							</Anchor>
						</Anchors>
						<Scripts>
							<OnClick>
								WebClientAccountFrame_Okay();
							</OnClick>
						</Scripts>
					</Button>
					<Button name="$parentCancelButton" inherits="GlueButtonTemplateBlue" text="CANCEL">
						<Anchors>
							<Anchor point="LEFT" relativeTo="$parentOkayButton" relativePoint="RIGHT">
								<Offset>
									<AbsDimension x="0" y="0"/>
								</Offset>
							</Anchor>
						</Anchors>
						<Scripts>
							<OnClick>
								WebClientAccountFrame_Cancel();
							</OnClick>
						</Scripts>
					</Button>
					<Button name="WebClientAccountFrameSwitchButton" inherits="GlueButtonSmallTemplateBlue">
						<Anchors>
							<Anchor point="BOTTOM" relativeTo="WebClientAccountFrameBackground" relativePoint="BOTTOM">
								<Offset>
									<AbsDimension x="0" y="60"/>
								</Offset>
							</Anchor>
						</Anchors>
						<Scripts>
							<OnClick>
								WebClientAccountFrame_Switch();
							</OnClick>
						</Scripts>
					</Button>
				</Frames>
			</Frame>
		</Frames>
		<Scripts>
			<OnLoad>
				self.mode = "create";
				WebClientAccountFrame_Layout();
			</OnLoad>
			<OnShow>
				WebClientAccountFrame_OnShow(self);
			</OnShow>
			<OnHide>
				WebClientAccountFrame_OnHide(self);
			</OnHide>
			<OnKeyDown>
				WebClientAccountFrame_OnKeyDown(key);
			</OnKeyDown>
		</Scripts>
	</Frame>
</Ui>
`;

const FILES: Readonly<Record<string, string>> = Object.freeze({
  [GLUE_ACCOUNT_TOC]: "WebClientAccount.xml\n",
  [`${DIRECTORY}webclientaccount.xml`]: XML,
  [`${DIRECTORY}webclientaccount.lua`]: LUA,
});

/** The parts of a glue runtime the panel needs. */
export interface GlueAccountScreensHost {
  readonly vm: GlueLuaVm;
  readonly bridge: FrameXmlUiBridge;
  readonly api: GlueApi;
}

/** Why the typed form cannot be sent, as the text to show; undefined when it can. */
export function accountFormProblem(
  mode: "create" | "change", name: string, oldPassword: string, password: string, repeat: string,
  glueString: (key: string) => string | undefined,
): string | undefined {
  const stock = (key: string, fallback: string): string => glueString(key) || fallback;
  const nameProblem = accountNameProblem(name);
  if (nameProblem === "empty") return GLUE_ACCOUNT_TEXT.enterName;
  if (nameProblem !== undefined) return GLUE_ACCOUNT_TEXT.nameRule;
  if (mode === "change" && oldPassword.length === 0) return stock("LOGIN_ENTER_PASSWORD", "Введите пароль.");
  const problem = passwordProblem(password);
  if (problem === "empty") return stock("LOGIN_ENTER_PASSWORD", "Введите пароль.");
  if (problem !== undefined) return GLUE_ACCOUNT_TEXT.passwordRule;
  if (password !== repeat) return GLUE_ACCOUNT_TEXT.mismatch;
  return undefined;
}

/** The text a refused request is shown with. */
export function accountRefusalText(
  mode: "create" | "change", outcome: Exclude<GlueAccountOutcome, { ok: true } | { error: "auth" }>,
  glueString: (key: string) => string | undefined,
): string {
  const stock = (key: string, fallback: string): string => glueString(key) || fallback;
  switch (outcome.error) {
    case "taken": return stock("CHAR_CREATE_NAME_IN_USE", "Имя недоступно");
    case "bad-name": return GLUE_ACCOUNT_TEXT.nameRule;
    case "too-many": return stock("LOGIN_TOO_FAST", "Слишком много попыток. Попробуйте еще раз через несколько минут.");
    case "disabled": return GLUE_ACCOUNT_TEXT.disabled;
    case "not-proven": return GLUE_ACCOUNT_TEXT.notProven;
    case "uncertain": return mode === "create" ? GLUE_ACCOUNT_TEXT.maybeCreated : GLUE_ACCOUNT_TEXT.maybeChanged;
    case "network": case "unavailable": case "busy": case "unsupported-schema": return stock("SERVER_DOWN", "Сервер недоступен");
    default: return mode === "create" ? stock("ACCOUNT_CREATE_FAILED", "Ошибка создания учетной записи") : GLUE_ACCOUNT_TEXT.notProven;
  }
}

export interface GlueAccountScreens {
  /** What loading the panel reported (diagnostics, files). */
  readonly load: GlueLoadResult;
  /** Settles when the gateway has said whether the forms are on. */
  readonly ready: Promise<void>;
  /** Settles when the request the last submit started has been answered (tests). */
  idle(): Promise<void>;
}

/** Registers the panel's C functions and loads it; call after the stock TOC. */
export function installGlueAccountScreens(host: GlueAccountScreensHost, client: GlueAccountClient): GlueAccountScreens {
  const { vm, api } = host;
  const glueString = (key: string): string | undefined => vm.globalString(key);
  const say = (text: string): void => {
    openStatusDialog((event, ...args) => { api.fireEvent(event, ...args); }, "WEBCLIENT_ACCOUNT_OKAY", text);
  };
  let available = false;
  let generation = 0;
  let pending: Promise<void> = Promise.resolve();
  const ready = client.available().then((on) => { available = on; }, () => { available = false; });

  // Own strings into the corpus' table of globals, before the Lua that reads them runs.
  vm.setGlobal("WEBCLIENT_ACCOUNT_CHANGE_TITLE", GLUE_ACCOUNT_TEXT.changeTitle);
  vm.setGlobal("WEBCLIENT_ACCOUNT_OLD_PASSWORD", GLUE_ACCOUNT_TEXT.oldPassword);
  vm.setGlobal("WEBCLIENT_ACCOUNT_NEW_PASSWORD", GLUE_ACCOUNT_TEXT.newPassword);
  vm.setGlobal("WEBCLIENT_ACCOUNT_REPEAT_PASSWORD", GLUE_ACCOUNT_TEXT.repeatPassword);
  vm.registerGlobal("WebClientAccount_IsAvailable", () => [available]);
  vm.registerGlobal("WebClientAccount_Cancel", () => {
    generation++;
    return [];
  });
  vm.registerGlobal("WebClientAccount_Submit", (args) => {
    const mode = args[0] === "change" ? "change" : "create";
    const [name, oldPassword, password, repeat] = [args[1], args[2], args[3], args[4]].map((value) => typeof value === "string" ? value : "");
    const problem = accountFormProblem(mode, name!, oldPassword!, password!, repeat!, glueString);
    if (problem !== undefined) {
      say(problem);
      return [];
    }
    const mine = ++generation;
    openStatusDialog((event, ...rest) => { api.fireEvent(event, ...rest); }, "WEBCLIENT_ACCOUNT_WAIT", mode === "create"
      ? glueString("ACCOUNT_CREATE_IN_PROGRESS") || "Создание учетной записи"
      : GLUE_ACCOUNT_TEXT.changing);
    const work = mode === "create" ? client.register(name!, password!) : client.changePassword(name!, oldPassword!, password!);
    pending = work.then((outcome) => {
      if (mine !== generation) return; // cancelled from the progress dialog
      api.fireEvent("CLOSE_STATUS_DIALOG");
      if (outcome.ok) {
        say(mode === "create" ? glueString("ACCOUNT_CREATE_SUCCESS") || "Учетная запись создана" : GLUE_ACCOUNT_TEXT.changed);
        const done = vm.globalFunction("WebClientAccountFrame_OnDone");
        if (done) {
          try {
            vm.call(done, [mode, outcome.username]);
          } finally {
            vm.release(done);
          }
        }
        return;
      }
      if (outcome.error === "auth") {
        // The old password's login failed: the login's own refusal, in its own dialog.
        api.showMessage(describeFailure(outcome.cause, "auth"));
        return;
      }
      say(accountRefusalText(mode, outcome, glueString));
    }, () => {
      if (mine !== generation) return;
      api.fireEvent("CLOSE_STATUS_DIALOG");
      say(glueString("SERVER_DOWN") || "Сервер недоступен");
    });
    return [];
  });

  const loader = new GlueLoader({ vm, bridge: host.bridge, provider: { read: async () => undefined } });
  const load = loader.loadSync(GLUE_ACCOUNT_TOC, { read: (path) => FILES[normalizeGluePath(path)] });
  return { load, ready, idle: async () => { await pending; } };
}
