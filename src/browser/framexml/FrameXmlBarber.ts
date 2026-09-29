/**
 * The stock BarberShopFrame's C API (Blizzard_BarbershopUI) over this client's barber chair: the four
 * selectors, the price, the haircut and the chair's own open/close.
 *
 * * `SMSG_ENABLE_BARBER_SHOP` (the core sends it once the character sits in a barber chair) opens
 *   the shop: BARBER_SHOP_OPEN, whose UIParent handler loads the add-on and shows the frame.
 * * The selectors walk `BarberShopStyle.dbc` rows of the character's race and sex (hair style,
 *   facial hair, and — tauren only — skin), and the hair colours `CharSections` offers the race, sex
 *   and class (`/dbc/character-options`). `CMSG_ALTER_APPEARANCE` carries the three row ids and the raw
 *   colour; the realm validates them (CharacterHandler.cpp HandleAlterAppearance).
 * * The price is `Player::GetBarberShopCost`'s own formula over `gtBarberShopCostBase` (the
 *   `/dbc/barber-cost` route): a new style costs the base, a new colour alone half of it, facial hair
 *   and skin three quarters each, in the core's float arithmetic, truncated to copper.
 * * `SMSG_BARBER_SHOP_RESULT` success raises BARBER_SHOP_SUCCESS; the new appearance bytes raise
 *   BARBER_SHOP_APPEARANCE_APPLIED; standing up (the core stands the character after a haircut, and
 *   `CancelBarberShop` stands it) raises BARBER_SHOP_CLOSE.
 */

/** `BarberShopStyle.Type` rows the four selectors walk; the colour selector (2) walks colours. */
export const FRAMEXML_BARBER_HAIR = 0;
export const FRAMEXML_BARBER_FACIAL = 2;
export const FRAMEXML_BARBER_SKIN = 3;

export interface FrameXmlBarberStyle {
  /** `BarberShopStyle.dbc` row id: what `CMSG_ALTER_APPEARANCE` carries. */
  readonly id: number;
  /** The style value the row selects (`Data`). */
  readonly data: number;
  /** `DisplayName_lang`; empty for the rows the DBC leaves unnamed (tauren fur colours). */
  readonly name: string;
}

/** The character's appearance bytes as the update fields hold them now. */
export interface FrameXmlBarberLook {
  readonly hairStyle: number;
  readonly hairColor: number;
  readonly facialHair: number;
  readonly skin: number;
}

export interface FrameXmlBarberHost {
  /** `SMSG_ENABLE_BARBER_SHOP` has come and no successful haircut has ended it (`barberShopOpen`). */
  enabled(): boolean;
  /**
   * The stand state is a barber chair seat (`UNIT_STAND_STATE_SIT_LOW_CHAIR` + chair height, 4..6).
   * The core sends the enable packet at once and the stand state with the next object update, so
   * the seat can arrive after the shop opened; leaving it afterwards is what closes the shop.
   */
  seated(): boolean;
  look(): FrameXmlBarberLook | undefined;
  /** The appearance bytes as one number (`PLAYER_BYTES` and the facial byte), for the per-frame compare. */
  appearance(): number | undefined;
  styles(type: number): readonly FrameXmlBarberStyle[];
  /** The hair colours the race, sex and class may choose; undefined while unknown. */
  hairColors(): readonly number[] | undefined;
  /** `ChrRaces.HairCustomization` and the sex's `FacialHairCustomization`. */
  hairCustomization(): string | undefined;
  facialHairCustomization(): string | undefined;
  /** `gtBarberShopCostBase` at the character's level (capped at 100); undefined while unknown. */
  costBase(): number | undefined;
  /** `CMSG_ALTER_APPEARANCE`. */
  apply(hairStyleId: number, hairColor: number, facialHairId: number, skinId: number): void;
  /** `CMSG_STANDSTATECHANGE` to standing: `CancelBarberShop`. */
  standUp(): void;
  /** The native wording of a refused haircut (`barberShopResultText`). */
  resultText?(result: number): string;
  subscribe?(model: FrameXmlBarberModel): () => void;
}

interface BarberPump {
  fire(event: string, ...args: readonly unknown[]): number;
}

interface Selection {
  hair: number;
  color: number;
  facial: number;
  skin: number;
}

const NOTHING: readonly [] = Object.freeze([]);

function wrap(index: number, length: number): number {
  return length > 0 ? ((index % length) + length) % length : 0;
}

/** One owner of the barber shop's C API and of the BARBER_SHOP_* events. */
export class FrameXmlBarberModel {
  readonly #host: FrameXmlBarberHost;
  #pump: BarberPump | undefined;
  #unsubscribe: (() => void) | undefined;
  #owned = false;
  #open = false;
  /** The seat has been seen since the shop opened; leaving it now closes the shop. */
  #sawSeat = false;
  #selection: Selection | undefined;
  /** The appearance last seen while open, compared (not rebuilt) every tick. */
  #seen: number | undefined;
  /** Set by the lazy stock owner: the shop opened, load and gate on the first one. */
  onOpenRequest: (() => void) | undefined;

  constructor(host: FrameXmlBarberHost) {
    this.#host = host;
  }

  attach(pump: BarberPump): void {
    this.detach();
    this.#pump = pump;
    this.#unsubscribe = this.#host.subscribe?.(this);
  }

  detach(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#pump = undefined;
    this.#open = false;
    this.#selection = undefined;
  }

  /** Stock BarberShopFrame holds the chair; the edge opens a shop already enabled. */
  get owned(): boolean { return this.#owned; }
  set owned(value: boolean) {
    if (value === this.#owned) return;
    this.#owned = value;
    if (value && this.#host.enabled() && this.#host.seated()) this.opened();
    if (!value) this.#open = false;
  }

  /** Whether the shop is open for the stock frame. */
  get open(): boolean { return this.#open; }

  /** `SMSG_ENABLE_BARBER_SHOP`: the chair is ready. */
  opened(): void {
    if (!this.#host.enabled()) return;
    if (!this.#owned) {
      this.onOpenRequest?.();
      return;
    }
    this.#open = true;
    this.#sawSeat = this.#host.seated();
    this.#reset();
    this.#pump?.fire("BARBER_SHOP_OPEN");
  }

  /**
   * A chair already occupied when the mount publishes (a /reload in the chair): `opened` only while
   * seated. WorldClient's `barberShopOpen` outlives a stand-up without a haircut, so the flag alone
   * would load the add-on at every later boot of the session.
   */
  resume(): void {
    if (this.#host.enabled() && this.#host.seated()) this.opened();
  }

  /** `SMSG_BARBER_SHOP_RESULT`: success is BARBER_SHOP_SUCCESS, a refusal its UI error. */
  result(result: number): void {
    if (!this.#open) return;
    if (result === 0) this.#pump?.fire("BARBER_SHOP_SUCCESS");
    else this.#pump?.fire("UI_ERROR_MESSAGE", this.#host.resultText?.(result) ?? "");
  }

  /** Per rendered frame, allocation-free: standing up closes, new appearance bytes are applied. */
  tick(): void {
    if (!this.#open) return;
    const seated = this.#host.seated();
    if (seated) this.#sawSeat = true;
    if (!this.#host.enabled() || (this.#sawSeat && !seated)) {
      this.#close();
      return;
    }
    const appearance = this.#host.appearance();
    if (appearance !== undefined && this.#seen !== undefined && appearance !== this.#seen) {
      this.#reset();
      this.#pump?.fire("BARBER_SHOP_APPEARANCE_APPLIED");
    }
  }

  // ---- the C API ---------------------------------------------------------------------------

  /** `GetBarberShopStyleInfo(category)`: the name (none for a colour) and whether it is the current look. */
  styleInfo(category: number): readonly unknown[] {
    const look = this.#host.look();
    const selection = this.#selection;
    if (!look || !selection) return NOTHING;
    if (category === 2) {
      const colors = this.#colors(look);
      const color = colors[selection.color] ?? look.hairColor;
      return [undefined, undefined, undefined, color === look.hairColor];
    }
    const style = this.#style(category, selection);
    if (!style) return NOTHING;
    const current = category === 1 ? look.hairStyle : category === 3 ? look.facialHair : look.skin;
    return [style.name, undefined, undefined, style.data === current];
  }

  /** `SetNextBarberShopStyle(category, reverse)`. */
  next(category: number, reverse: boolean): void {
    const look = this.#host.look();
    const selection = this.#selection;
    if (!look || !selection) return;
    const step = reverse ? -1 : 1;
    if (category === 1) selection.hair = wrap(selection.hair + step, this.#host.styles(FRAMEXML_BARBER_HAIR).length);
    else if (category === 2) selection.color = wrap(selection.color + step, this.#colors(look).length);
    else if (category === 3) selection.facial = wrap(selection.facial + step, this.#host.styles(FRAMEXML_BARBER_FACIAL).length);
    else if (category === 4) selection.skin = wrap(selection.skin + step, this.#host.styles(FRAMEXML_BARBER_SKIN).length);
  }

  /** `GetBarberShopTotalCost()`: `Player::GetBarberShopCost` in float arithmetic, truncated. */
  totalCost(): number {
    const look = this.#host.look();
    const base = this.#host.costBase();
    const pick = this.#picked(look);
    if (!look || base === undefined || !pick) return 0;
    const f = Math.fround;
    const data = f(base);
    let cost = f(0);
    if (pick.hair !== look.hairStyle) cost = f(cost + data);
    if (pick.color !== look.hairColor && pick.hair === look.hairStyle) cost = f(cost + f(data * 0.5));
    if (pick.facial !== look.facialHair) cost = f(cost + f(data * 0.75));
    if (pick.skin !== undefined && pick.skin !== look.skin) cost = f(cost + f(data * 0.75));
    return Math.trunc(cost);
  }

  /** `ApplyBarberShopStyle()`: `CMSG_ALTER_APPEARANCE` with the selected rows and colour. */
  apply(): void {
    const look = this.#host.look();
    const selection = this.#selection;
    if (!this.#open || !look || !selection) return;
    const hair = this.#host.styles(FRAMEXML_BARBER_HAIR)[selection.hair];
    const facial = this.#host.styles(FRAMEXML_BARBER_FACIAL)[selection.facial];
    const skin = this.#host.styles(FRAMEXML_BARBER_SKIN)[selection.skin];
    if (!hair || !facial) return;
    const color = this.#colors(look)[selection.color] ?? look.hairColor;
    this.#host.apply(hair.id, color, facial.id, skin?.id ?? 0);
  }

  /** `CancelBarberShop()`: the character stands up, which closes the shop. */
  cancel(): void {
    if (this.#open) this.#host.standUp();
  }

  /** `BarberShopReset()`: every selector back to the current look. */
  reset(): void {
    this.#reset();
  }

  canAlterSkin(): boolean {
    return this.#host.styles(FRAMEXML_BARBER_SKIN).length > 0;
  }

  hairCustomization(): string {
    return this.#host.hairCustomization() || "NORMAL";
  }

  facialHairCustomization(): string {
    return this.#host.facialHairCustomization() || "NORMAL";
  }

  /** Whether everything the stock frame reads has arrived: the owner's gate waits for it. */
  ready(): boolean {
    return this.#host.styles(FRAMEXML_BARBER_HAIR).length > 0 && this.#host.styles(FRAMEXML_BARBER_FACIAL).length > 0
      && this.#host.hairColors() !== undefined && this.#host.costBase() !== undefined
      && this.#host.hairCustomization() !== undefined && this.#host.facialHairCustomization() !== undefined;
  }

  // ---- internals ---------------------------------------------------------------------------

  #close(): void {
    this.#open = false;
    this.#selection = undefined;
    this.#seen = undefined;
    this.#pump?.fire("BARBER_SHOP_CLOSE");
  }

  #reset(): void {
    const look = this.#host.look();
    this.#seen = this.#host.appearance();
    if (!look) {
      this.#selection = undefined;
      return;
    }
    const at = (type: number, data: number): number => {
      const index = this.#host.styles(type).findIndex((style) => style.data === data);
      return index >= 0 ? index : 0;
    };
    const colors = this.#colors(look);
    const color = colors.indexOf(look.hairColor);
    this.#selection = {
      hair: at(FRAMEXML_BARBER_HAIR, look.hairStyle),
      color: color >= 0 ? color : 0,
      facial: at(FRAMEXML_BARBER_FACIAL, look.facialHair),
      skin: at(FRAMEXML_BARBER_SKIN, look.skin),
    };
  }

  /** The colours to walk: the race's, with the current one kept even when the list lacks it. */
  #colors(look: FrameXmlBarberLook): readonly number[] {
    const colors = this.#host.hairColors() ?? [];
    return colors.includes(look.hairColor) ? colors : [look.hairColor, ...colors];
  }

  #style(category: number, selection: Selection): FrameXmlBarberStyle | undefined {
    if (category === 1) return this.#host.styles(FRAMEXML_BARBER_HAIR)[selection.hair];
    if (category === 3) return this.#host.styles(FRAMEXML_BARBER_FACIAL)[selection.facial];
    if (category === 4) return this.#host.styles(FRAMEXML_BARBER_SKIN)[selection.skin];
    return undefined;
  }

  #picked(look: FrameXmlBarberLook | undefined): { hair: number; color: number; facial: number; skin: number | undefined } | undefined {
    const selection = this.#selection;
    if (!look || !selection) return undefined;
    const hair = this.#host.styles(FRAMEXML_BARBER_HAIR)[selection.hair];
    const facial = this.#host.styles(FRAMEXML_BARBER_FACIAL)[selection.facial];
    const skin = this.#host.styles(FRAMEXML_BARBER_SKIN)[selection.skin];
    return {
      hair: hair?.data ?? look.hairStyle,
      color: this.#colors(look)[selection.color] ?? look.hairColor,
      facial: facial?.data ?? look.facialHair,
      skin: skin?.data,
    };
  }
}

/** The part of the world seam the bindings read. */
export interface FrameXmlBarberSeam {
  readonly barber?: FrameXmlBarberModel | undefined;
}

export type FrameXmlBarberBinding = (host: FrameXmlBarberSeam, args: readonly unknown[]) => readonly unknown[];

const withBarber = (answer: (barber: FrameXmlBarberModel, args: readonly unknown[]) => readonly unknown[],
  fallback: readonly unknown[] = NOTHING): FrameXmlBarberBinding =>
  (host, args) => host.barber ? answer(host.barber, args) : fallback;

function truthy(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false;
}

/**
 * The flat C API. GetHairCustomization/GetFacialHairCustomization/CanAlterSkin are read by
 * BarberShop_OnLoad while the add-on loads, so they answer from the first call.
 */
export const FRAMEXML_BARBER_BINDINGS: Readonly<Record<string, FrameXmlBarberBinding>> = Object.freeze({
  GetBarberShopStyleInfo: withBarber((barber, args) => barber.styleInfo(Number(args[0]))),
  SetNextBarberShopStyle: withBarber((barber, args) => { barber.next(Number(args[0]), truthy(args[1])); return NOTHING; }),
  GetBarberShopTotalCost: withBarber((barber) => [barber.totalCost()], [0]),
  ApplyBarberShopStyle: withBarber((barber) => { barber.apply(); return NOTHING; }),
  CancelBarberShop: withBarber((barber) => { barber.cancel(); return NOTHING; }),
  BarberShopReset: withBarber((barber) => { barber.reset(); return NOTHING; }),
  CanAlterSkin: withBarber((barber) => [barber.canAlterSkin()], [false]),
  GetHairCustomization: withBarber((barber) => [barber.hairCustomization()], ["NORMAL"]),
  GetFacialHairCustomization: withBarber((barber) => [barber.facialHairCustomization()], ["NORMAL"]),
});
