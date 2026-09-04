import type { RealmInfo } from "../../auth/AuthProtocol.js";
import type { AuthSessionResult } from "../../auth/login.js";
import type { CharacterEquipment, CharacterSummary } from "../../world/CharacterProtocol.js";
import type { GlueWorldConnection } from "./GlueSession.js";

/**
 * A canned session, for looking at the screens without a server.
 *
 * The owner's authserver and worldserver are not running while this slice is being built, and
 * `?fake=charselect` is how the character-select screen — its list, its realm name, its racial
 * backdrop and the 3D figure standing in it — can be seen and screenshotted at all. It reaches the
 * screens through exactly the same seam the live path uses: a `GlueWorldConnector` handed to
 * `GlueSession`. Nothing downstream of the session can tell the difference, which is what makes the
 * screenshot evidence about the real code.
 *
 * Deliberately in `src/` and not in a test: it is a dev entry on a dev page, it costs nothing when
 * the query parameter is absent, and a copy of it under `tests/` could drift from the shapes the
 * page actually builds.
 */

export type FakeGlueSessionName = "charselect" | "charcreate";

/** The names a `?fake=` parameter may carry, so the page can validate one without a cast. */
export const FAKE_GLUE_SESSIONS: readonly FakeGlueSessionName[] = ["charselect", "charcreate"];

export function isFakeGlueSessionName(value: string | null): value is FakeGlueSessionName {
  return value !== null && (FAKE_GLUE_SESSIONS as readonly string[]).includes(value);
}

/** Twenty-three empty slots: what `SMSG_CHAR_ENUM` sends for a character wearing nothing. */
function bareEquipment(): CharacterEquipment[] {
  return Array.from({ length: 23 }, () => ({ displayId: 0, inventoryType: 0, enchantVisual: 0 }));
}

function character(
  guid: number,
  name: string,
  race: number,
  gender: number,
  classId: number,
  level: number,
  zone: number,
  look: { skin: number; face: number; hairStyle: number; hairColor: number; facialHair: number },
): CharacterSummary {
  return {
    guid: BigInt(guid),
    name,
    race,
    classId,
    gender,
    skin: look.skin,
    face: look.face,
    hairStyle: look.hairStyle,
    hairColor: look.hairColor,
    facialHair: look.facialHair,
    level,
    zone,
    map: 0,
    x: 0,
    y: 0,
    z: 0,
    guildId: 0,
    flags: 0,
    customizeFlags: 0,
    firstLogin: false,
    petDisplayId: 0,
    petLevel: 0,
    petFamily: 0,
    equipment: bareEquipment(),
  };
}

/**
 * Three characters over three different racial backdrops.
 *
 * Human picks `UI_Human`, night elf `UI_NightElf`, and the death knight `UI_DeathKnight` whatever
 * race she is — which is the one rule in `glueBackgroundModelFor` that is about the class and not
 * the race, so the fake covers it. The zones are real ids from this dataset: 12 «Элвиннский лес»,
 * 141 «Тельдрассил», 4298 «Чумные земли: Анклав Алого ордена».
 *
 * Nobody is wearing anything: `SMSG_CHAR_ENUM`'s equipment is 23 display ids and inventing them
 * would put invented armour on the acceptance screenshot. A bare character is what a freshly
 * created one looks like, and the worn path is the same `visibleEquipmentFor` spelling the world
 * renderer uses — exercised there rather than faked here.
 */
const FAKE_CHARACTERS: readonly CharacterSummary[] = [
  character(0x1001, "Аларин", 1, 0, 1, 12, 12,
    { skin: 3, face: 2, hairStyle: 4, hairColor: 1, facialHair: 3 }),
  character(0x1002, "Лиэрель", 4, 1, 11, 34, 141,
    { skin: 4, face: 1, hairStyle: 3, hairColor: 2, facialHair: 0 }),
  character(0x1003, "Морран", 5, 0, 6, 58, 4298,
    { skin: 2, face: 4, hairStyle: 5, hairColor: 3, facialHair: 1 }),
];

const FAKE_REALMS: readonly RealmInfo[] = [
  {
    type: 1, locked: false, flags: 0x20, name: "Круг Теней", address: "127.0.0.1:8085",
    population: 0, characters: 3, timezone: 1, id: 1, build: undefined,
  },
  {
    type: 0, locked: false, flags: 0, name: "Пробный мир", address: "127.0.0.1:8086",
    population: 1.5, characters: 0, timezone: 1, id: 2, build: undefined,
  },
];

export interface FakeGlueSession {
  readonly auth: AuthSessionResult;
  readonly realm: RealmInfo;
  /** Which glue screen the page should open once the canned session is in place. */
  readonly screen: string;
  connect(): Promise<GlueWorldConnection>;
}

/**
 * `?fake=charselect` and `?fake=charcreate`.
 *
 * They differ only in the screen the page opens afterwards and in what the world connection can do.
 * The creation screen needs no session at all for its **preview** — `/dbc/character-options`,
 * `/dbc/char-start-outfit` and `/dbc/character-appearance` are unauthenticated GETs — so the fake's
 * whole job there is to stand in for `CMSG_CHAR_CREATE`, which is the one thing on the screen that
 * genuinely needs a world.
 */
export function fakeGlueSession(name: FakeGlueSessionName): FakeGlueSession | undefined {
  if (!isFakeGlueSessionName(name)) return undefined;
  let characters = [...FAKE_CHARACTERS];
  let nextGuid = 0x2000;
  return {
    auth: { username: "TESTER", sessionKey: new Uint8Array(40), realms: [...FAKE_REALMS] },
    realm: FAKE_REALMS[0]!,
    screen: name === "charcreate" ? "charcreate" : "charselect",
    connect: async () => ({
      characters: async () => characters.map((entry) => ({ ...entry })),
      // The delete flow is real down to its result code: 71 is `CHAR_DELETE_SUCCESS`, and the list
      // this returns afterwards is one shorter, so the screen's refresh is exercised too.
      deleteCharacter: async (guid: bigint) => {
        characters = characters.filter((entry) => entry.guid !== guid);
        return 71;
      },
      /**
       * 47 is `CHAR_CREATE_SUCCESS`, and the new character really joins the list.
       *
       * `50` — `CHAR_CREATE_NAME_IN_USE` — for a name already taken, because that is the one
       * failure path the screen has to show without a server and the only way to see the dialog
       * the corpus draws for it. Everything the wire would carry is kept, so switching back to the
       * select screen shows the figure that was just built.
       */
      createCharacter: async (request) => {
        if (characters.some((entry) => entry.name.toLowerCase() === request.name.toLowerCase())) {
          return 50;
        }
        characters = [...characters, character(
          nextGuid++, request.name, request.race, request.gender, request.classId, 1, 12,
          {
            skin: request.skin, face: request.face, hairStyle: request.hairStyle,
            hairColor: request.hairColor, facialHair: request.facialHair,
          })];
        return 47;
      },
      close: () => { characters = [...FAKE_CHARACTERS]; },
    }),
  };
}
