import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import { unit } from "../../world/Fields.js";
import { BARBER_TYPE_FACIAL, BARBER_TYPE_HAIR, BARBER_TYPE_SKIN } from "../../world/BarberRules.js";
import type { BarberStyle } from "../../gateway/BarberMetadata.js";
import { game } from "../game/Context.js";
import { Panel } from "./Widgets.js";
import { frameXmlBarberOwnsShop } from "../framexml/FrameXmlBarberController.js";

/**
 * The barber shop: hair, colour, facial hair and (tauren) skin, paid for at the chair.
 *
 * The window opens only on the server's `SMSG_ENABLE_BARBER_SHOP`, which the core sends when
 * the character is seated on a barber chair — sitting is what arms it, and standing or a
 * successful cut is what closes it. `CMSG_ALTER_APPEARANCE` carries `BarberShopStyle.dbc` row
 * ids, not style values, and a row of the wrong race, sex or type is answered with silence;
 * every stepper below lists only rows the server takes for this character. The hair colour is
 * the one raw value on the wire and is validated by `Player::ValidateAppearance` on the realm.
 * The price is the server's (`GetBarberShopCost`) and arrives back in words, not numbers.
 */

function byteOf(fields: Map<number, number>, field: string, index: number): number | undefined {
  const offset = (UPDATE_FIELDS as Record<string, { offset: number }>)[field]?.offset;
  if (offset === undefined) return undefined;
  const value = fields.get(offset);
  if (value === undefined) return undefined;
  return (value >>> (index * 8)) & 0xff;
}

interface BarberSelection {
  hair: BarberStyle[];
  hairIndex: number;
  hairColor: number;
  facial: BarberStyle[];
  facialIndex: number;
  skin: BarberStyle[];
  skinIndex: number;
}

let parts: { panel: Panel; body: HTMLElement; status: HTMLElement } | undefined;
let selection: BarberSelection | undefined;

function build(): { panel: Panel; body: HTMLElement; status: HTMLElement } {
  const panel = new Panel({ id: "barber-window", title: "Парикмахерская", className: "barber-window" });
  const status = document.createElement("p");
  status.className = "muted";
  status.setAttribute("role", "status");
  const body = document.createElement("div");
  body.className = "barber-rows";
  panel.body.append(status, body);
  return { panel, body, status };
}

function stepper(label: string, value: string, previous: () => void, next: () => void): HTMLElement {
  const row = document.createElement("div");
  row.className = "barber-row";
  const name = document.createElement("span");
  name.textContent = label;
  const back = document.createElement("button");
  back.type = "button";
  back.textContent = "◀";
  back.setAttribute("aria-label", `${label}: предыдущий`);
  back.addEventListener("click", previous);
  const current = document.createElement("strong");
  current.textContent = value;
  const forward = document.createElement("button");
  forward.type = "button";
  forward.textContent = "▶";
  forward.setAttribute("aria-label", `${label}: следующий`);
  forward.addEventListener("click", next);
  row.append(name, back, current, forward);
  return row;
}

/** Hair colours in 3.3.5 run 0-9; the realm still validates the combination. */
const MAX_HAIR_COLOR = 9;

function currentSelection(): BarberSelection | undefined {
  const world = game.world;
  const client = game.barberStyles;
  const selfGuid = world?.state.selfGuid;
  const self = selfGuid === undefined ? undefined : world?.state.objects.get(selfGuid);
  if (!world || !client || !client.ready || !self) return undefined;
  const race = unit.race(self) ?? 0;
  // The DBC's Sex follows the core's Gender enum: 0 male, 1 female.
  const sex = (unit.gender(self) ?? 0) === 1 ? 1 : 0;
  const hair = client.stylesFor(BARBER_TYPE_HAIR, race, sex);
  const facial = client.stylesFor(BARBER_TYPE_FACIAL, race, sex);
  const skin = client.stylesFor(BARBER_TYPE_SKIN, race, sex);
  if (hair.length === 0 || facial.length === 0) return undefined;
  const hairByte = byteOf(self.fields, "PLAYER_BYTES", 2) ?? 0;
  const colorByte = byteOf(self.fields, "PLAYER_BYTES", 3) ?? 0;
  const facialByte = byteOf(self.fields, "PLAYER_BYTES_2", 0) ?? 0;
  const skinByte = byteOf(self.fields, "PLAYER_BYTES", 0) ?? 0;
  const atData = (rows: BarberStyle[], data: number): number => {
    const index = rows.findIndex((row) => row.data === data);
    return index >= 0 ? index : 0;
  };
  return {
    hair, hairIndex: atData(hair, hairByte),
    hairColor: Math.max(0, Math.min(MAX_HAIR_COLOR, colorByte)),
    facial, facialIndex: atData(facial, facialByte),
    skin, skinIndex: atData(skin, skinByte),
  };
}

export function barberOpen(): boolean {
  return parts?.panel.visible ?? false;
}

/** Reopens the chair window while seated, or says why there is nothing to open. */
export function toggleBarberShop(): void {
  if (barberOpen()) {
    closeBarberShop();
    return;
  }
  const world = game.world;
  if (!world?.barberShopOpen) {
    world?.onSpellStatus?.("Сядьте в кресло парикмахера, чтобы открыть окно", true);
    return;
  }
  showBarberShop();
}

export function closeBarberShop(): void {
  parts?.panel.hide();
  selection = undefined;
}

export function resetBarberShop(): void {
  closeBarberShop();
}

/**
 * Opens the window when the server says the chair is ready, and redraws it when the style
 * table lands. Refuses with a reason otherwise: without the flag the realm would take the
 * chair check to fail, and without the table every click would be a silent abort.
 */
export function showBarberShop(): void {
  const world = game.world;
  // The stock BarberShopFrame owns the chair once its gate passed (FrameXmlBarberController.ts).
  if (!world || !world.barberShopOpen || frameXmlBarberOwnsShop()) {
    closeBarberShop();
    return;
  }
  parts ??= build();
  const { panel, body, status } = parts;
  selection = currentSelection();
  if (!game.barberStyles?.ready) {
    status.textContent = "Загружаем стили стрижек…";
    body.replaceChildren();
    panel.show();
    return;
  }
  if (!selection) {
    status.textContent = "Нет стилей для этой расы и пола — сообщите в обращение.";
    body.replaceChildren();
    panel.show();
    return;
  }
  const state = selection;
  const draw = (): void => {
    const hair = state.hair[state.hairIndex]!;
    const facial = state.facial[state.facialIndex]!;
    const rows: HTMLElement[] = [
      stepper(`Причёска · ${hair.name}`, `${hair.data}`, () => {
        state.hairIndex = (state.hairIndex + state.hair.length - 1) % state.hair.length;
        draw();
      }, () => {
        state.hairIndex = (state.hairIndex + 1) % state.hair.length;
        draw();
      }),
      stepper("Цвет волос", String(state.hairColor), () => {
        state.hairColor = (state.hairColor + MAX_HAIR_COLOR) % (MAX_HAIR_COLOR + 1);
        draw();
      }, () => {
        state.hairColor = (state.hairColor + 1) % (MAX_HAIR_COLOR + 1);
        draw();
      }),
      stepper(`Растительность · ${facial.name}`, `${facial.data}`, () => {
        state.facialIndex = (state.facialIndex + state.facial.length - 1) % state.facial.length;
        draw();
      }, () => {
        state.facialIndex = (state.facialIndex + 1) % state.facial.length;
        draw();
      }),
    ];
    if (state.skin.length > 0) {
      const skin = state.skin[state.skinIndex]!;
      rows.push(stepper(`Цвет кожи · ${skin.name}`, `${skin.data}`, () => {
        state.skinIndex = (state.skinIndex + state.skin.length - 1) % state.skin.length;
        draw();
      }, () => {
        state.skinIndex = (state.skinIndex + 1) % state.skin.length;
        draw();
      }));
    }
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.textContent = "Подтвердить стрижку";
    confirm.title = "Цену спишет сервер; при нехватке золота он откажет словами";
    confirm.addEventListener("click", () => {
      const picked = selection;
      const target = game.world;
      if (!picked || !target || !target.barberShopOpen) return;
      target.alterAppearance(
        picked.hair[picked.hairIndex]!.id,
        picked.hairColor,
        picked.facial[picked.facialIndex]!.id,
        picked.skin.length > 0 ? picked.skin[picked.skinIndex]!.id : 0,
      );
    });
    const note = document.createElement("p");
    note.className = "muted";
    note.textContent = "Оплата — золотом, цену называет сервер. Встаньте с кресла, чтобы закрыть.";
    rows.push(confirm, note);
    body.replaceChildren(...rows);
  };
  status.textContent = world.serviceMessage?.text ?? "";
  status.className = world.serviceMessage?.error ? "error" : "muted";
  draw();
  panel.show();
}
