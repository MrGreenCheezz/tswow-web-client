/**
 * Stock MailFrame as the mailbox: the gate and the published owner. The C API is FrameXmlMail.ts,
 * the tab-template dependency FrameXmlMailCorpus.ts.
 *
 * MailFrame.xml loads after ColorPickerFrame.xml (stock TOC 119) and declares three UIParent
 * children, all hidden: MailFrame (InboxFrame + SendMailFrame tabs), OpenMailFrame (one letter) and
 * StationeryPopupFrame. None is a parentless root, so no visible-root admission is needed.
 */
import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import type { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";
import type { FrameXmlMailModel } from "./FrameXmlMail.js";
import type { FrameXmlMailOwner } from "./FrameXmlMailController.js";
import { frameXmlSilentProbe } from "./FrameXmlGameMenuOwner.js";

/** `INBOXITEMS_TO_DISPLAY`, `ATTACHMENTS_MAX_SEND`, `ATTACHMENTS_MAX_RECEIVE` (MailFrame.lua:1-9). */
const INBOX_ROWS = 7;
const SEND_SLOTS = 12;
const RECEIVE_SLOTS = 16;

/** Named stock frames the mailbox needs, with their widget type and the scripts they must carry. */
const MAIL_FRAMES: readonly (readonly [name: string, type: string, scripts: readonly string[]])[] = [
  ["MailFrame", "Frame", ["OnLoad", "OnEvent", "OnHide"]],
  ["InboxFrame", "Frame", []],
  ["SendMailFrame", "Frame", ["OnShow"]],
  ["OpenMailFrame", "Frame", ["OnShow", "OnHide"]],
  ["MailFrameTab1", "Button", ["OnClick"]],
  ["MailFrameTab2", "Button", ["OnClick"]],
  ["InboxCloseButton", "Button", ["OnClick"]],
  ["InboxPrevPageButton", "Button", ["OnClick"]],
  ["InboxNextPageButton", "Button", ["OnClick"]],
  ["SendMailNameEditBox", "EditBox", []],
  ["SendMailSubjectEditBox", "EditBox", []],
  ["SendMailBodyEditBox", "EditBox", []],
  ["SendMailMoney", "Frame", []],
  ["SendMailSendMoneyButton", "CheckButton", ["OnClick"]],
  ["SendMailCODButton", "CheckButton", ["OnClick"]],
  ["SendMailMailButton", "Button", ["OnClick"]],
  ["SendMailCancelButton", "Button", ["OnClick"]],
  ["SendMailCostMoneyFrame", "Frame", []],
  ["OpenMailLetterButton", "Button", ["OnClick"]],
  ["OpenMailMoneyButton", "Button", ["OnClick"]],
  ["OpenMailReplyButton", "Button", ["OnClick"]],
  ["OpenMailDeleteButton", "Button", ["OnClick"]],
  ["OpenMailCancelButton", "Button", ["OnClick"]],
  ["OpenMailCloseButton", "Button", ["OnClick"]],
];

/** MailFrame_OnLoad's registrations (MailFrame.lua:28-37) that the model fires. */
const MAIL_EVENTS: readonly string[] = [
  "MAIL_SHOW", "MAIL_INBOX_UPDATE", "MAIL_CLOSED", "MAIL_SEND_INFO_UPDATE", "MAIL_SEND_SUCCESS",
  "MAIL_FAILED", "MAIL_SUCCESS",
];

function frameDescendsFrom(frame: FrameXmlFrame, ancestor: FrameXmlFrame): boolean {
  let current: FrameXmlFrame | undefined = frame;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function dataAttribute(element: HTMLElement, name: string): string | null {
  const value = element.getAttribute(name);
  if (value !== null) return value;
  const key = name.slice(5).replace(/-([a-z])/g, (_match, character: string) => character.toUpperCase());
  return element.dataset?.[key] ?? null;
}

function renderedFrameElement(element: HTMLElement | undefined, frame: FrameXmlFrame): element is HTMLElement {
  return !!element && dataAttribute(element, "data-framexml-name") === frame.name
    && dataAttribute(element, "data-framexml-type") === frame.type;
}

export interface FrameXmlMailGateResult {
  readonly frame: FrameXmlFrame;
  readonly open: FrameXmlFrame;
}

/**
 * Structural, rendered and transactional proof that stock MailFrame can own the mailbox.
 *
 * The probe shows MailFrame, repaints the inbox, switches to the send tab (SendMailFrame_Update's
 * layout pass, the stationery setup and the name box focus, cleared again), back to the inbox, and
 * hides it — silently (no PlaySound) and without a packet: the model is muted, so MailFrame's OnHide
 * CloseMail() does not close a mailbox the player may have open. Any new Lua error or bridge
 * diagnostic, or a tab that did not switch, fails the gate and leaves the native window.
 */
export function frameXmlMailGate(
  seam: { readonly mail?: FrameXmlMailModel | undefined },
  boot: Pick<FrameXmlBoot, "vm" | "bridge" | "errorCount">,
  renderer: Pick<FrameXmlDomRenderer, "elementFor">,
): FrameXmlMailGateResult | undefined {
  try {
    const mail = seam.mail;
    if (!mail) return undefined;
    const frames = new Map<string, FrameXmlFrame>();
    for (const [name, type, scripts] of MAIL_FRAMES) {
      const frame = boot.bridge.getFrame(name);
      if (!frame || frame.type !== type || !scripts.every((script) => boot.bridge.hasScript(frame, script))) {
        return undefined;
      }
      frames.set(name, frame);
    }
    const root = frames.get("MailFrame")!;
    const open = frames.get("OpenMailFrame")!;
    if (root.parent?.name !== "UIParent" || open.parent?.name !== "UIParent" || root.visible || open.visible) {
      return undefined;
    }
    for (const name of ["InboxFrame", "SendMailFrame", "MailFrameTab1", "MailFrameTab2", "SendMailMailButton"]) {
      if (!frameDescendsFrom(frames.get(name)!, root)) return undefined;
    }
    const numbered: (readonly [prefix: string, count: number, type: string, ancestor: FrameXmlFrame])[] = [
      ["MailItem%Button", INBOX_ROWS, "CheckButton", root],
      ["SendMailAttachment%", SEND_SLOTS, "Button", root],
      ["OpenMailAttachmentButton%", RECEIVE_SLOTS, "Button", open],
    ];
    for (const [pattern, count, type, ancestor] of numbered) {
      for (let index = 1; index <= count; index += 1) {
        const button = boot.bridge.getFrame(pattern.replace("%", String(index)));
        if (!button || button.type !== type || !frameDescendsFrom(button, ancestor)
          || !boot.bridge.hasScript(button, "OnClick")) return undefined;
      }
    }
    for (const frame of [root, open]) {
      if (!renderedFrameElement(renderer.elementFor(frame), frame)) return undefined;
    }
    if (!MAIL_EVENTS.every((event) => root.registeredEvents.has(event))) return undefined;
    const errors = boot.errorCount;
    const diagnostics = boot.bridge.diagnostics.length;
    const probe = mail.muted(() => frameXmlSilentProbe(boot, "webclient/mail-gate", `
      ShowUIPanel(MailFrame)
      local shown = MailFrame:IsShown() and 1 or 0
      InboxFrame_Update()
      MailFrameTab_OnClick(nil, 2)
      local send = (SendMailFrame:IsShown() and not InboxFrame:IsShown()) and 1 or 0
      SendMailNameEditBox:ClearFocus()
      MailFrameTab_OnClick(nil, 1)
      local inbox = (InboxFrame:IsShown() and not SendMailFrame:IsShown()) and 1 or 0
      HideUIPanel(MailFrame)
      return shown, send, inbox, (MailFrame:IsShown() or OpenMailFrame:IsShown()) and 1 or 0
    `, 4));
    if (!probe) return undefined;
    const [shown, send, inbox, stillShown] = probe.map((value) => Number(value));
    if (shown !== 1 || send !== 1 || inbox !== 1 || stillShown !== 0 || root.visible
      || boot.errorCount !== errors || boot.bridge.diagnostics.length !== diagnostics) return undefined;
    return { frame: root, open };
  } catch {
    return undefined;
  }
}

/**
 * The published owner. It never opens the window itself — MAIL_SHOW does, from the model — and its
 * `hide` is stock's close (HideUIPanel, whose OnHide calls CloseMail), for Escape and teardown.
 */
export function createFrameXmlMailOwner(
  boot: Pick<FrameXmlBoot, "vm" | "bridge">,
  gate: FrameXmlMailGateResult,
): FrameXmlMailOwner {
  return {
    isOpen: () => boot.bridge.isVisible(gate.frame) || boot.bridge.isVisible(gate.open),
    hide: () => {
      if (boot.bridge.isVisible(gate.open)) boot.vm.executeReported("HideUIPanel(OpenMailFrame)", "@webclient/mail-hide");
      if (boot.bridge.isVisible(gate.frame)) boot.vm.executeReported("HideUIPanel(MailFrame)", "@webclient/mail-hide");
    },
  };
}
