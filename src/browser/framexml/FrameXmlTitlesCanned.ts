/**
 * The offline title fixture for the canned world: measured rows of this dataset's CharTitles.dbc
 * (the `/dbc/char-titles` catalog, read through gateway/CharTitleMetadata.ts), three of them known
 * and «Рядовой» worn, over a realm stand-in that answers CMSG_SET_TITLE with the core's own rule
 * (MiscHandler.cpp HandleSetTitleOpcode: a known mask is worn, anything else clears), so the stock
 * picker can be driven with no server.
 */
import type { CharTitleRow } from "../CharTitleClient.js";
import { FRAMEXML_KNOWN_TITLE_WORDS, FrameXmlTitleModel, frameXmlTitleCatalog } from "./FrameXmlTitles.js";

/** Measured rows (ids 1, 15, 53, 63; masks 1, 15, 36, 38) with their declined female forms. */
export const CANNED_TITLE_ROWS: readonly CharTitleRow[] = Object.freeze([
  Object.freeze({ id: 1, maskId: 1, name: "Рядовой %s", nameFemale: "Рядовой %s" }),
  Object.freeze({ id: 15, maskId: 15, name: "Разведчик %s", nameFemale: "Разведчица %s" }),
  Object.freeze({ id: 53, maskId: 36, name: "%s, защитник Наару", nameFemale: "%s, защитница Наару" }),
  Object.freeze({ id: 63, maskId: 38, name: "%s из Расколотого Солнца", nameFemale: "%s из Расколотого Солнца" }),
]);

/** The masks the canned character has earned: «Рядовой», «Разведчик», «защитник Наару». */
export const CANNED_KNOWN_TITLES: readonly number[] = Object.freeze([1, 15, 36]);
/** The one worn at boot. */
export const CANNED_CHOSEN_TITLE = 1;

export interface CannedFrameXmlTitleWorld {
  /** Every CMSG_SET_TITLE, in order. */
  readonly sent: readonly number[];
  /** `PLAYER_CHOSEN_TITLE` as the stand-in realm holds it. */
  chosen(): number;
  /** An SMSG_TITLE_EARNED: the mask's bit set (or cleared). */
  earn(maskId: number, earned?: boolean): void;
}

export interface CannedFrameXmlTitles {
  readonly model: FrameXmlTitleModel;
  readonly world: CannedFrameXmlTitleWorld;
}

export function createCannedFrameXmlTitles(female: () => boolean | undefined): CannedFrameXmlTitles {
  const catalog = frameXmlTitleCatalog(CANNED_TITLE_ROWS);
  const words = new Array<number>(FRAMEXML_KNOWN_TITLE_WORDS).fill(0);
  const setBit = (maskId: number, earned: boolean): void => {
    const word = Math.floor(maskId / 32);
    if (word < 0 || word >= words.length) return;
    const bit = 1 << (maskId % 32);
    words[word] = earned ? ((words[word]! | bit) >>> 0) : ((words[word]! & ~bit) >>> 0);
  };
  for (const mask of CANNED_KNOWN_TITLES) setBit(mask, true);
  let chosen = CANNED_CHOSEN_TITLE;
  const sent: number[] = [];
  const model = new FrameXmlTitleModel({
    catalog: () => catalog,
    knownWords: () => [...words],
    wearer: () => ({ chosen, female: female() }),
    setTitle: (index) => {
      sent.push(index);
      // HandleSetTitleOpcode: a known mask below MAX_TITLE_INDEX is worn; -1 and the rest clear.
      chosen = index > 0 && model.isKnown(index) ? index : 0;
    },
  });
  return {
    model,
    world: {
      sent,
      chosen: () => chosen,
      earn: (maskId, earned = true) => {
        setBit(maskId, earned);
        if (!earned && chosen === maskId) chosen = 0;
      },
    },
  };
}
