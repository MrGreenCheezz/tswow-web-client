/**
 * A scripted barber chair for the canned seam, the offline preview and the tests: a level-80 tauren
 * male, the one race whose skin the barber changes (four selectors, BarberShop_ToFourAttributeFormat).
 *
 * Every table value is this dataset's (measured through the gateway: `/dbc/barber-styles?v=1` for the
 * tauren male rows, `/dbc/character-options?v=6&race=6&sex=0` for the hair colours,
 * `/dbc/character-creation?v=3` for HORNS/NORMAL, and gtBarberShopCostBase.dbc row 80: 111173
 * copper). The skin rows carry no name in the DBC. The current look is the fixture's own.
 */
import { FrameXmlBarberModel, type FrameXmlBarberLook, type FrameXmlBarberStyle } from "./FrameXmlBarber.js";

export const FRAMEXML_CANNED_BARBER_HAIR: readonly FrameXmlBarberStyle[] = Object.freeze([
  { id: 743, data: 0, name: "Чемпионские" }, { id: 744, data: 1, name: "Бык" }, { id: 745, data: 2, name: "Пробивные" },
  { id: 746, data: 3, name: "Притупленные" }, { id: 747, data: 4, name: "Сломанный рог" }, { id: 748, data: 5, name: "Маленькие" },
  { id: 749, data: 6, name: "Буффало" }, { id: 750, data: 7, name: "Кровавое празднество" }, { id: 1088, data: 8, name: "С наконечниками" },
  { id: 1089, data: 9, name: "Закругленные" }, { id: 1090, data: 10, name: "Безопасные" }, { id: 1091, data: 11, name: "Лировидные" },
  { id: 1092, data: 12, name: "Вытянутые" },
]);

export const FRAMEXML_CANNED_BARBER_FACIAL: readonly FrameXmlBarberStyle[] = Object.freeze([
  { id: 754, data: 0, name: "Без бороды и усов" }, { id: 755, data: 1, name: "Три косички" }, { id: 756, data: 2, name: "Кольцо в носу" },
  { id: 757, data: 3, name: "Коса" }, { id: 758, data: 4, name: "Бородач" }, { id: 759, data: 5, name: "Две косички" },
  { id: 760, data: 6, name: "Кольца и косички" },
]);

export const FRAMEXML_CANNED_BARBER_SKIN: readonly FrameXmlBarberStyle[] = Object.freeze(
  Array.from({ length: 19 }, (_, data) => ({ id: 1120 + data, data, name: "" })),
);

/** gtBarberShopCostBase.dbc row 80 (level 80), in copper. */
export const FRAMEXML_CANNED_BARBER_COST = 111_173;

export class CannedFrameXmlBarberWorld {
  enabled = false;
  seated = false;
  look: FrameXmlBarberLook = { hairStyle: 1, hairColor: 0, facialHair: 2, skin: 3 };
  readonly applied: (readonly [number, number, number, number])[] = [];
  standUps = 0;
  model: FrameXmlBarberModel | undefined;

  reset(): void {
    this.enabled = false;
    this.seated = false;
    this.look = { hairStyle: 1, hairColor: 0, facialHair: 2, skin: 3 };
    this.applied.length = 0;
    this.standUps = 0;
  }

  /** The character sits: SMSG_ENABLE_BARBER_SHOP, then the stand state. */
  sit(): void {
    this.enabled = true;
    this.seated = true;
    this.model?.opened();
  }

  /** The server's answer to the last CMSG_ALTER_APPEARANCE: success writes the look and stands up. */
  answer(result: number): void {
    const last = this.applied.at(-1);
    this.model?.result(result);
    if (result !== 0 || !last) return;
    const [hairId, hairColor, facialId, skinId] = last;
    this.look = {
      hairStyle: FRAMEXML_CANNED_BARBER_HAIR.find((row) => row.id === hairId)?.data ?? this.look.hairStyle,
      hairColor,
      facialHair: FRAMEXML_CANNED_BARBER_FACIAL.find((row) => row.id === facialId)?.data ?? this.look.facialHair,
      skin: FRAMEXML_CANNED_BARBER_SKIN.find((row) => row.id === skinId)?.data ?? this.look.skin,
    };
    this.enabled = false;
    this.seated = false;
  }
}

export function createCannedFrameXmlBarber(): { readonly model: FrameXmlBarberModel; readonly world: CannedFrameXmlBarberWorld } {
  const world = new CannedFrameXmlBarberWorld();
  const model = new FrameXmlBarberModel({
    enabled: () => world.enabled,
    seated: () => world.seated,
    look: () => world.look,
    appearance: () => world.look.skin + world.look.hairStyle * 256 + world.look.hairColor * 65_536 + world.look.facialHair * 16_777_216,
    styles: (type) => type === 0 ? FRAMEXML_CANNED_BARBER_HAIR : type === 2 ? FRAMEXML_CANNED_BARBER_FACIAL
      : type === 3 ? FRAMEXML_CANNED_BARBER_SKIN : [],
    hairColors: () => [0, 1, 2],
    hairCustomization: () => "HORNS",
    facialHairCustomization: () => "NORMAL",
    costBase: () => FRAMEXML_CANNED_BARBER_COST,
    apply: (hair, color, facial, skin) => { world.applied.push([hair, color, facial, skin]); },
    standUp: () => {
      world.standUps += 1;
      world.seated = false;
    },
    resultText: (result) => (result === 1 || result === 3 ? "Недостаточно денег." : "Сядьте в кресло парикмахера."),
  });
  world.model = model;
  return { model, world };
}
