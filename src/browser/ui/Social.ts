import { formatMoney, unknownLabel } from "./Format.js";
import { itemTooltipFor } from "./ItemTooltip.js";
import { AuctionEntry, nextBid } from "../../world/AuctionProtocol.js";
import { player } from "../../world/Fields.js";
import { LFG_ROLE_DAMAGE, LFG_ROLE_HEALER, LFG_ROLE_TANK, rolesText } from "../../world/LfgProtocol.js";
import { isMailRead } from "../../world/MailProtocol.js";
import { WorldClient } from "../../world/WorldClient.js";
import { game } from "../game/Context.js";
import { showUnitFrames } from "./UnitFrames.js";
import { attachTooltip, confirmPanel } from "./Widgets.js";

import { systemLine } from "./Chat.js";
import {
  auctionList, auctionMessage, auctionWindow, duelText, duelWindow, groupAccept, groupInviteText,
  groupInviteWindow,
  lfgDamage, lfgHealer, lfgMessage, lfgProposalBox, lfgProposalText, lfgQueue, lfgTank, lfgWindow,
  mailList, mailMessage, mailWindow, status, tradeMessage, tradeMine, tradeTheirTitle,
  tradeTheirs, tradeTitle, tradeWindow,
} from "./Dom.js";

/** Group, mail, trade, auction, dungeon finder and duels. The guild has its own module now. */

export function showGroup(): void {
  const world = game.world;
  const invite = world?.groupInvite;

  groupInviteWindow.hidden = !invite;
  if (invite) {
    groupInviteText.textContent = invite.canAccept
      ? `${invite.inviterName} приглашает вас в группу.`
      : `${invite.inviterName} приглашает вас в группу, но принять сейчас нельзя.`;
    groupAccept.disabled = !invite.canAccept;
  }

  if (world?.groupMessage) systemLine(world.groupMessage.text);
  if (world) world.groupMessage = undefined;

  // The frames themselves belong to slice I2 and are painted by `showUnitFrames`: a party frame
  // and a raid slot are the same widget as the boss, focus and arena frames, and drawing one of
  // them here by hand was how this file ended up with its own idea of what a health bar is.
  showUnitFrames();
}

export function tradeItemList(target: HTMLElement, offer: { money: number; items: Array<{ slot: number; itemId: number; count: number }> } | undefined): void {
  if (!offer) {
    target.replaceChildren();
    return;
  }
  const rows: HTMLElement[] = offer.items.map((item) => {
    const row = document.createElement("div");
    // A trade offer never ordered a row of its own, so what the other side is offering read as
    // «Предмет 4306» unless the player happened to own one already.
    const template = game.world?.itemTemplate(item.itemId);
    const metadata = game.itemMetadata?.get(item.itemId);
    row.className = `trade-item quality-${template?.quality ?? metadata?.quality ?? 0}`;
    const name = template?.name || metadata?.name || unknownLabel("предмет", item.itemId);
    row.textContent = item.count > 1 ? `${name} ×${item.count}` : name;
    attachTooltip(row, () => itemTooltipFor(item.itemId, { count: item.count, footer: ["В обмене"] }));
    return row;
  });
  if (offer.money > 0) {
    const money = document.createElement("div");
    money.className = "trade-item";
    money.textContent = formatMoney(offer.money);
    rows.push(money);
  }
  if (rows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "Пусто";
    rows.push(empty);
  }
  target.replaceChildren(...rows);
}

export function selectedLfgRoles(): number {
  return (lfgTank.checked ? LFG_ROLE_TANK : 0) | (lfgHealer.checked ? LFG_ROLE_HEALER : 0) | (lfgDamage.checked ? LFG_ROLE_DAMAGE : 0);
}

export function auctionEntryBox(entry: AuctionEntry, own: boolean, world: WorldClient): HTMLElement {
  const box = document.createElement("div");
  box.className = "auction-entry";
  const name = document.createElement("strong");
  const template = world.itemTemplate(entry.itemId);
  const metadata = game.itemMetadata?.get(entry.itemId);
  const label = template?.name || metadata?.name || unknownLabel("предмет", entry.itemId);
  name.textContent = entry.count > 1 ? `${label} ×${entry.count}` : label;
  attachTooltip(name, () => itemTooltipFor(entry.itemId, { count: entry.count, footer: ["Лот аукциона"] }));
  box.append(name);

  const meta = document.createElement("span");
  meta.className = "auction-meta";
  const price = entry.bid > 0 ? `ставка ${formatMoney(entry.bid)}` : `старт ${formatMoney(entry.startBid)}`;
  const buyout = entry.buyout > 0 ? ` · выкуп ${formatMoney(entry.buyout)}` : "";
  // The server sends the remaining time in milliseconds.
  meta.textContent = `${price}${buyout} · осталось ${Math.max(0, Math.round(entry.timeLeft / 60000))} мин.`;
  box.append(meta);

  if (own) {
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Снять с продажи";
    cancel.addEventListener("click", () => confirmPanel(cancel, {
      title: "Снять лот с продажи?",
      lines: ["Депозит не возвращается, а предмет придёт почтой."],
      confirm: "Снять",
      danger: true,
      onConfirm: () => world.cancelAuction(entry.auctionId),
    }));
    box.append(cancel);
    return box;
  }

  const next = nextBid(entry);
  const bidButton = document.createElement("button");
  bidButton.type = "button";
  bidButton.textContent = `Ставка ${formatMoney(next)}`;
  bidButton.addEventListener("click", () => world.bidOnAuction(entry.auctionId, next));
  box.append(bidButton);
  if (entry.buyout > 0) {
    const buyoutButton = document.createElement("button");
    buyoutButton.type = "button";
    buyoutButton.textContent = `Выкуп ${formatMoney(entry.buyout)}`;
    buyoutButton.addEventListener("click", () => world.bidOnAuction(entry.auctionId, entry.buyout));
    box.append(buyoutButton);
  }
  return box;
}

export function showAuctions(): void {
  const world = game.world;
  if (!world || world.auctioneerGuid === 0n) {
    auctionWindow.hidden = true;
    return;
  }
  auctionWindow.hidden = false;
  const message = world.auctionMessage;
  auctionMessage.className = message ? (message.error ? "error" : "success") : "muted";
  auctionMessage.textContent = message?.text ?? "";

  const own = world.ownAuctions;
  const list = own ?? world.auctions;
  const entries = list?.entries ?? [];
  if (entries.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    // The window opens before anything has been asked for, and «Ничего не найдено» over an empty
    // list the player has not searched yet reads as an answer to a question nobody put.
    empty.textContent = list ? "Ничего не найдено" : "Задайте условия и нажмите «Искать».";
    auctionList.replaceChildren(empty);
    return;
  }
  auctionList.replaceChildren(...entries.map((entry) => auctionEntryBox(entry, own !== undefined, world)));
}

export function showLfg(): void {
  const world = game.world;
  const proposal = world?.lfgProposal;
  const status = world?.lfgStatus;
  // The window only earns its place once something LFG related has actually happened.
  if (!world || (!proposal && !status && !world.lfgQueue && !world.lfgMessage)) {
    lfgWindow.hidden = true;
    return;
  }
  lfgWindow.hidden = false;
  lfgMessage.textContent = world.lfgMessage ?? "";

  const queue = world.lfgQueue;
  if (queue) {
    const wait = queue.waitTime < 0 ? "неизвестно" : `${Math.round(queue.waitTime / 60000)} мин`;
    lfgQueue.textContent = `В очереди ${Math.round(queue.queuedSeconds / 60)} мин · ожидание ${wait} · нужно: танков ${queue.tanksNeeded}, лекарей ${queue.healersNeeded}, бойцов ${queue.damageNeeded}`;
  } else {
    lfgQueue.textContent = status?.joined ? "В очереди" : "";
  }

  lfgProposalBox.hidden = !proposal;
  if (proposal) {
    const answered = proposal.players.filter((player) => player.answered).length;
    const mine = proposal.players.find((player) => player.self)?.roles ?? 0;
    lfgProposalText.textContent = `Найдена группа: ${proposal.players.length} чел., согласились ${answered}. Ваша роль: ${rolesText(mine)}.`;
  }
}

export function showMail(): void {
  const world = game.world;
  if (!world || world.mailboxGuid === 0n) {
    mailWindow.hidden = true;
    return;
  }
  mailWindow.hidden = false;
  const message = world.mailMessage;
  mailMessage.className = message ? (message.error ? "error" : "success") : "muted";
  mailMessage.textContent = message?.text ?? "";

  const mails = world.mail?.mails ?? [];
  if (mails.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "Почтовый ящик пуст";
    mailList.replaceChildren(empty);
    return;
  }

  mailList.replaceChildren(...mails.map((entry) => {
    const box = document.createElement("div");
    box.className = isMailRead(entry) ? "mail-entry" : "mail-entry unread";

    const subject = document.createElement("strong");
    subject.textContent = entry.subject || "(без темы)";
    box.append(subject);

    const from = entry.senderGuid !== 0n ? world.displayName(entry.senderGuid) : `отправитель ${entry.altSenderId}`;
    const meta = document.createElement("div");
    meta.className = "mail-meta";
    meta.textContent = `От: ${from} · осталось дней: ${Math.max(0, Math.floor(entry.daysLeft))}`;
    box.append(meta);

    if (entry.body) {
      const body = document.createElement("div");
      body.textContent = entry.body;
      box.append(body);
    }

    if (entry.money > 0) {
      const money = document.createElement("button");
      money.type = "button";
      money.textContent = `Забрать ${formatMoney(entry.money)}`;
      money.addEventListener("click", () => world.takeMailMoney(entry.mailId));
      box.append(money);
    }
    for (const attachment of entry.attachments) {
      const take = document.createElement("button");
      take.type = "button";
      const name = world.itemTemplate(attachment.itemId)?.name
        || game.itemMetadata?.get(attachment.itemId)?.name
        || unknownLabel("предмет", attachment.itemId);
      take.textContent = attachment.count > 1 ? `Забрать ${name} ×${attachment.count}` : `Забрать ${name}`;
      attachTooltip(take, () => itemTooltipFor(attachment.itemId, {
        count: attachment.count,
        footer: ["Нажмите, чтобы забрать из письма"],
      }));
      take.addEventListener("click", () => world.takeMailItem(entry.mailId, attachment.attachId));
      box.append(take);
    }
    if (entry.cod > 0) {
      const cod = document.createElement("div");
      cod.className = "mail-meta";
      cod.textContent = `Наложенный платёж: ${formatMoney(entry.cod)}`;
      box.append(cod);
    }

    if (!isMailRead(entry)) {
      const read = document.createElement("button");
      read.type = "button";
      read.textContent = "Прочитано";
      read.addEventListener("click", () => world.markMailRead(entry.mailId));
      box.append(read);
    }
    if (entry.senderGuid !== 0n) {
      const back = document.createElement("button");
      back.type = "button";
      back.textContent = "Вернуть";
      back.addEventListener("click", () => world.returnMail(entry.mailId, entry.senderGuid));
      box.append(back);
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Удалить";
    remove.className = "danger";
    remove.addEventListener("click", () => confirmPanel(remove, {
      title: "Удалить письмо?",
      lines: entry.money > 0 || entry.attachments.length > 0
        ? ["Во вложении ещё что-то есть — оно пропадёт вместе с письмом."]
        : undefined,
      confirm: "Удалить",
      danger: true,
      onConfirm: () => world.deleteMail(entry.mailId),
    }));
    box.append(remove);
    return box;
  }));
}

export function showTrade(): void {
  const world = game.world;
  if (!world || !world.tradeOpen) {
    tradeWindow.hidden = true;
    return;
  }
  tradeWindow.hidden = false;
  const partner = world.tradePartnerGuid === 0n ? "" : world.displayName(world.tradePartnerGuid);
  tradeTitle.textContent = partner ? `Обмен · ${partner}` : "Обмен";
  tradeMessage.textContent = world.tradeMessage ?? "";
  tradeTheirTitle.textContent = world.tradePartnerAccepted ? "Вам предлагают · партнёр согласен" : "Вам предлагают";
  tradeTheirTitle.className = world.tradePartnerAccepted ? "trade-accepted" : "";
  tradeItemList(tradeMine, world.myOffer);
  tradeItemList(tradeTheirs, world.theirOffer);
}

export function showDuel(): void {
  const world = game.world;
  const request = world?.duelRequest;
  duelWindow.hidden = !request;
  if (!world || !request) return;
  duelText.textContent = `${world.displayName(request.challengerGuid)} вызывает вас на дуэль.`;
}
