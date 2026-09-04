import { MAIL_AUCTION, MAIL_CALENDAR, MAIL_OK, MAIL_SEND, isMailRead, type MailEntry } from "../../world/MailProtocol.js";
import type { WorldClient } from "../../world/WorldClient.js";
import { game } from "../game/Context.js";
import { entryOf, playerInventory, stackCount } from "../Inventory.js";
import { element, mailBody, mailList, mailMessage, mailMoney, mailSend, mailSubject, mailTo, mailWindow } from "./Dom.js";
import { formatMoney } from "./Format.js";
import { setIconSource } from "./IconImage.js";
import { itemTooltipFor } from "./ItemTooltip.js";
import { nativeUiTextureUrl } from "./NativeUiSkin.js";
import { Panel, attachTooltip, confirmPanel } from "./Widgets.js";

const PAGE_SIZE = 7;
let owner: WorldClient | undefined;
let mailbox = 0n;
let page = 0;
let selected: number | undefined;
let composing = false;
let wired = false;
let reader: Panel | undefined;
let attachments: bigint[] = [];
let sending = false;
let submittedResult: WorldClient["mailResult"];
const read = new Set<number>();

function button(text: string, run: () => void): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button";
  node.textContent = text;
  node.addEventListener("click", run);
  return node;
}

export function mailReadOpen(): boolean { return reader?.visible ?? false; }
export function closeMailRead(): void { selected = undefined; reader?.hide(); }
export function mailOpen(): boolean { return !mailWindow.hidden; }
export function closeMail(): void {
  game.world?.closeMailbox();
  mailWindow.hidden = true;
  closeMailRead();
}

function resetDraft(): void {
  mailTo.value = "";
  mailSubject.value = "";
  mailBody.value = "";
  for (const id of ["mail-money", "mail-silver", "mail-copper"]) element<HTMLInputElement>(id).value = "0";
  attachments = [];
}

function setTab(compose: boolean): void {
  composing = compose;
  closeMailRead();
  showMail();
}

function wireMail(): void {
  if (wired) return;
  wired = true;
  element("mail-inbox-tab").addEventListener("click", () => setTab(false));
  element("mail-compose-tab").addEventListener("click", () => setTab(true));
  element("mail-previous").addEventListener("click", () => { page = Math.max(0, page - 1); showMail(); });
  element("mail-next").addEventListener("click", () => { page++; showMail(); });
  element<HTMLSelectElement>("mail-attachment-picker").addEventListener("change", (event) => {
    const picker = event.currentTarget as HTMLSelectElement;
    if (picker.value && attachments.length < 12 && !sending) attachments.push(BigInt(picker.value));
    showMail();
  });
  mailSend.addEventListener("click", sendDraft);
}

function sendDraft(): void {
  const world = game.world;
  if (!world || world.mailboxGuid === 0n || sending) return;
  const gold = Number(mailMoney.value);
  const silver = Number(element<HTMLInputElement>("mail-silver").value);
  const copper = Number(element<HTMLInputElement>("mail-copper").value);
  const money = gold * 10000 + silver * 100 + copper;
  if (!mailTo.value.trim() || !mailSubject.value.trim()) {
    mailMessage.className = "error";
    mailMessage.textContent = "Укажите получателя и тему письма.";
    return;
  }
  if (![gold, silver, copper].every((value) => Number.isSafeInteger(value) && value >= 0)
    || silver > 99 || copper > 99 || money > 2147483647) {
    mailMessage.className = "error";
    mailMessage.textContent = "Проверьте сумму: серебро и медь — от 0 до 99.";
    return;
  }
  submittedResult = world.mailResult;
  sending = true;
  world.sendMail({ target: mailTo.value.trim(), subject: mailSubject.value.trim(), body: mailBody.value,
    money, attachments: [...attachments] });
  showMail();
}

/** The mailbox keeps a compact inbox; only the selected letter opens its parchment reader. */
export function showMail(): void {
  const world = game.world;
  if (!world || world.mailboxGuid === 0n) {
    mailWindow.hidden = true;
    closeMailRead();
    owner = undefined;
    sending = false;
    return;
  }
  wireMail();
  if (world !== owner || world.mailboxGuid !== mailbox) {
    owner = world;
    mailbox = world.mailboxGuid;
    page = 0;
    composing = false;
    sending = false;
    read.clear();
    closeMailRead();
    resetDraft();
  }
  if (sending && world.mailResult && world.mailResult !== submittedResult && world.mailResult.command === MAIL_SEND) {
    sending = false;
    if (world.mailResult.error === MAIL_OK) resetDraft();
  }
  mailWindow.hidden = false;
  mailMessage.className = world.mailMessage?.error ? "error" : "muted";
  mailMessage.textContent = sending ? "Отправка письма…" : world.mailMessage?.text ?? "";
  element("mail-inbox").hidden = composing;
  element("mail-compose").hidden = !composing;
  element("mail-inbox-tab").setAttribute("aria-selected", String(!composing));
  element("mail-compose-tab").setAttribute("aria-selected", String(composing));
  mailSend.disabled = sending;
  for (const input of element("mail-compose").querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")) input.disabled = sending;
  if (composing) showComposer(world);
  else showInbox(world);
  const entry = world.mail?.mails.find((mail) => mail.mailId === selected);
  if (entry) showLetter(world, entry);
  else closeMailRead();
}

function sender(world: WorldClient, entry: MailEntry): string {
  if (entry.senderGuid !== 0n) return senderName(world, entry) ?? "Получение имени…";
  if (entry.senderType === MAIL_AUCTION) return "Аукцион";
  if (entry.senderType === MAIL_CALENDAR) return "Календарь";
  return "Почтовая служба";
}

function senderName(world: WorldClient, entry: MailEntry): string | undefined {
  return world.names.get(entry.senderGuid)
    ?? (entry.senderGuid === world.state.selfGuid ? world.selfName : undefined);
}

function showInbox(world: WorldClient): void {
  const mails = world.mail?.mails ?? [];
  const pages = Math.max(1, Math.ceil(mails.length / PAGE_SIZE));
  page = Math.max(0, Math.min(page, pages - 1));
  element("mail-page").textContent = `${page + 1} / ${pages}`;
  element<HTMLButtonElement>("mail-previous").disabled = page === 0;
  element<HTMLButtonElement>("mail-next").disabled = page === pages - 1;
  if (mails.length === 0) {
    const empty = document.createElement("p");
    empty.className = "mail-empty";
    empty.textContent = world.mail ? "Нет писем" : "Получение почты…";
    mailList.replaceChildren(empty);
    return;
  }
  mailList.replaceChildren(...mails.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((entry) => {
    const unread = !isMailRead(entry) && !read.has(entry.mailId);
    const row = button("", () => {
      selected = entry.mailId;
      if (unread) { read.add(entry.mailId); world.markMailRead(entry.mailId); }
      showMail();
    });
    row.className = `mail-entry${unread ? " unread" : ""}`;
    row.setAttribute("aria-label", `${unread ? "Непрочитанное. " : ""}${entry.subject || "Без темы"}. От: ${sender(world, entry)}`);
    const icon = document.createElement("img");
    icon.alt = "";
    setIconSource(icon, nativeUiTextureUrl(game.gatewayOrigin, "Interface\\MailFrame\\Mail-Icon.blp"));
    const words = document.createElement("span");
    words.className = "mail-entry-text";
    const title = document.createElement("strong");
    title.textContent = entry.subject || "(без темы)";
    const from = document.createElement("span");
    from.textContent = sender(world, entry);
    words.append(title, from);
    const meta = document.createElement("span");
    meta.className = "mail-entry-status";
    meta.textContent = `${Math.max(1, Math.ceil(entry.daysLeft))} д.${entry.attachments.length ? " · вложение" : entry.money ? " · деньги" : ""}`;
    row.title = `${entry.subject}\nОт: ${sender(world, entry)}${entry.cod ? `\nНаложенный платёж: ${formatMoney(entry.cod)}` : ""}`;
    row.append(icon, words, meta);
    return row;
  }));
}

function showLetter(world: WorldClient, entry: MailEntry): void {
  reader ??= new Panel({ id: "mail-read-window", title: "Письмо", className: "mail-read-window", onClose: closeMailRead });
  const body = document.createElement("div");
  body.className = "mail-letter";
  const title = document.createElement("h3");
  title.textContent = entry.subject || "(без темы)";
  const from = document.createElement("p");
  from.className = "mail-letter-sender";
  from.textContent = `От: ${sender(world, entry)}`;
  const text = document.createElement("div");
  text.className = "mail-letter-text";
  text.textContent = entry.body || "";
  body.append(title, from, text);
  const items = document.createElement("div");
  items.className = "mail-letter-items";
  for (const attachment of entry.attachments) {
    const name = world.itemTemplate(attachment.itemId)?.name || game.itemMetadata?.get(attachment.itemId)?.name || "Предмет";
    const take = button("", () => {
      const takeItem = (): void => world.takeMailItem(entry.mailId, attachment.attachId);
      if (entry.cod > 0) confirmPanel(take, { title: "Забрать вложение?", lines: [`Наложенный платёж: ${formatMoney(entry.cod)}`], confirm: "Оплатить и забрать", onConfirm: takeItem });
      else takeItem();
    });
    take.className = "mail-attachment";
    const metadata = game.itemMetadata?.get(attachment.itemId);
    if (metadata && game.itemMetadata) {
      const icon = document.createElement("img"); icon.alt = "";
      setIconSource(icon, game.itemMetadata.iconUrl(metadata)); take.append(icon);
    }
    const label = document.createElement("span");
    label.textContent = `${name}${attachment.count > 1 ? ` ×${attachment.count}` : ""}`;
    take.append(label);
    attachTooltip(take, () => itemTooltipFor(attachment.itemId, { count: attachment.count, footer: ["Нажмите, чтобы забрать"] }));
    items.append(take);
  }
  body.append(items);
  if (entry.cod > 0) { const cod = document.createElement("p"); cod.textContent = `Наложенный платёж: ${formatMoney(entry.cod)}`; body.append(cod); }
  const actions = document.createElement("div");
  actions.className = "mail-letter-actions";
  if (entry.money > 0) actions.append(button(`Забрать ${formatMoney(entry.money)}`, () => world.takeMailMoney(entry.mailId)));
  if (entry.senderGuid !== 0n) {
    const reply = button("Ответить", () => {
      const name = senderName(world, entry);
      if (!name) return;
      setTab(true);
      mailTo.value = name;
      mailSubject.value = `Re: ${entry.subject}`.slice(0, 64);
      mailBody.focus();
    });
    reply.disabled = !senderName(world, entry);
    if (reply.disabled) reply.title = "Ожидание имени отправителя";
    actions.append(reply);
  }
  if (entry.senderGuid !== 0n) actions.append(button("Вернуть", () => confirmPanel(actions, { title: "Вернуть письмо отправителю?", confirm: "Вернуть", onConfirm: () => world.returnMail(entry.mailId, entry.senderGuid) })));
  const remove = button("Удалить", () => confirmPanel(actions, { title: "Удалить письмо?", confirm: "Удалить", danger: true, onConfirm: () => world.deleteMail(entry.mailId) }));
  remove.disabled = entry.money > 0 || entry.attachments.length > 0;
  if (remove.disabled) remove.title = "Сначала заберите деньги и вложения или верните письмо отправителю";
  actions.append(remove);
  body.append(actions);
  reader.body.replaceChildren(body);
  reader.show();
}

function showComposer(world: WorldClient): void {
  const inventory = playerInventory(world.state);
  const slots = [...inventory?.backpack ?? [], ...inventory?.bags.flatMap((bag) => bag.slots) ?? []].filter((slot) => slot.guid !== 0n && slot.item);
  attachments = attachments.filter((guid) => slots.some((slot) => slot.guid === guid));
  const picker = element<HTMLSelectElement>("mail-attachment-picker");
  const placeholder = document.createElement("option"); placeholder.value = ""; placeholder.textContent = "Выберите предмет из сумок";
  picker.replaceChildren(placeholder);
  for (const slot of slots) {
    if (attachments.includes(slot.guid)) continue;
    const option = document.createElement("option"); option.value = String(slot.guid);
    option.textContent = `${world.itemTemplate(entryOf(slot.item))?.name || game.itemMetadata?.get(entryOf(slot.item))?.name || "Предмет"} ×${stackCount(slot)}`;
    picker.append(option);
  }
  picker.disabled = sending || attachments.length >= 12;
  element("mail-attachments").replaceChildren(...attachments.map((guid) => {
    const slot = slots.find((item) => item.guid === guid)!;
    const metadata = game.itemMetadata?.get(entryOf(slot.item));
    const remove = button("", () => { attachments = attachments.filter((item) => item !== guid); showMail(); });
    remove.disabled = sending;
    remove.title = `Убрать вложение: ${metadata?.name ?? "Предмет"}`;
    const icon = document.createElement("img"); icon.alt = metadata?.name ?? "Предмет";
    if (metadata && game.itemMetadata) setIconSource(icon, game.itemMetadata.iconUrl(metadata));
    remove.append(icon);
    return remove;
  }));
  element("mail-postage").textContent = `Вложений: ${attachments.length}/12`;
}
