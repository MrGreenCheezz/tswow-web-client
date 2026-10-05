// What a weapon draws: swing, stance and parry, by the client's own tables (6.06 / 6.04, line A7a
// slice D, A7-M3; 05.10).
//
// The data is `/dbc/weapon-anims` (gateway/WeaponAnimMetadata.ts): the class-2 rows of
// `ItemSubClass` (`WeaponParrySeq/ReadySeq/AttackSeq/SwingSize`), the swing variants of
// `AttackAnimKits` per subclass and hand, and the names of `AttackAnimTypes`. The seq columns are
// small enums, decoded by cross-checking the subclasses (line-A7a A7-M3):
//   ready  0 2H, 1 2HL, 2 1H, 3 bow, 4 rifle/crossbow, 5 thrown
//   attack 0 2H, 1 2HL, 2 bow, 3 1H, 4 rifle/crossbow, 5 thrown
//   parry  0 2H, 1 2HL, 2 1H, 3 unarmed
// The seven AttackAnimTypes names are the AnimationData rows Attack1H 17, Attack1HPierce 85,
// Attack2HLoosePierce 86, Attack2HL 19, Attack2H 18, AttackOff 87, AttackOffPierce 88.
//
// Until the route answers — an older gateway answers 404 until the owner restarts it — the table is a
// stand-in of this dataset's ItemSubClass columns written into the code (no kits, so no swing
// variants): the stance (UnitStandingPose.ts), the parry and the 2HL swing of polearms and staves
// already follow the data. Everything is built once; the per-frame callers get shared arrays.
//
// 05.10-A7a-D-review: the auto-attack swing does not read the kits or `WeaponAttackSeq` — Wow.exe
// `0x755130` picks it by subclass (game/CombatAnimations.ts `swingLadder`). `attackLadders` and
// `attackSeqLadder` stay for whatever does read AttackAnimKits (not found yet: 0x7385c0 unread).

import { ANIMATION_IDS } from "../generated/animations.js";
import { RetryingCatalogClient, type CatalogState, type RetryingCatalogOptions } from "./CatalogClient.js";

/** gateway/WeaponAnimMetadata.ts `WEAPON_ANIMS_VERSION`; tests/combat-animations.test.mjs pins the two together. */
export const WEAPON_ANIMS_ROUTE_VERSION = 1;
export const WEAPON_ANIMS_ROUTE_PATH = `/dbc/weapon-anims?v=${WEAPON_ANIMS_ROUTE_VERSION}`;

/** One class-2 `ItemSubClass` row's animation columns. */
export interface WeaponSubclassAnims {
  readonly parry: number;
  readonly ready: number;
  readonly attack: number;
  readonly swing: number;
}

export type WeaponHand = "main" | "off";

function ladder(...names: readonly string[]): readonly number[] {
  const out: number[] = [];
  for (const name of names) {
    const id = ANIMATION_IDS[name];
    if (typeof id === "number" && !out.includes(id)) out.push(id);
  }
  return Object.freeze(out);
}

/** `WeaponAttackSeq` → the swing, best first (the DBC fallback chain walks from each start too). */
const ATTACK_SEQ_LADDERS: readonly (readonly number[])[] = [
  ladder("Attack2H", "Attack1H", "AttackUnarmed"),
  ladder("Attack2HL", "Attack2H", "Attack1H", "AttackUnarmed"),
  ladder("AttackBow", "AttackUnarmed"),
  ladder("Attack1H", "AttackUnarmed"),
  ladder("AttackRifle", "AttackBow", "AttackUnarmed"),
  ladder("AttackThrown", "AttackUnarmed"),
];
/** `WeaponParrySeq` → the parry. One start each: AnimationData's own chain takes it from there. */
const PARRY_SEQ_LADDERS: readonly (readonly number[])[] = [
  ladder("Parry2H"), ladder("Parry2HL"), ladder("Parry1H"), ladder("ParryUnarmed"),
];
export const PARRY_UNARMED: readonly number[] = PARRY_SEQ_LADDERS[3]!;
const OFFHAND_TAIL = ladder("AttackOff", "AttackUnarmed");

/** `AttackAnimTypes.Name` → AnimationData name. A name not listed here is a type this client cannot draw. */
const ATTACK_TYPE_ANIMATIONS: Readonly<Record<string, string>> = {
  "1H_Main_Swing": "Attack1H",
  "1H_Main_Pierce": "Attack1HPierce",
  "2HL_Pierce": "Attack2HLoosePierce",
  "2HL_Swing": "Attack2HL",
  "2HT_Swing": "Attack2H",
  "OffH_Swing": "AttackOff",
  "OffH_Pierce": "AttackOffPierce",
};

export class WeaponAnimTable {
  /** True for the gateway's answer, false for the stand-in. */
  readonly fromRoute: boolean;
  readonly #subclasses: ReadonlyMap<number, WeaponSubclassAnims>;
  readonly #mainKits: ReadonlyMap<number, readonly (readonly number[])[]>;
  readonly #offKits: ReadonlyMap<number, readonly (readonly number[])[]>;

  constructor(
    fromRoute: boolean,
    subclasses: ReadonlyMap<number, WeaponSubclassAnims>,
    kits: readonly { subClass: number; animation: number; offhand: boolean }[],
  ) {
    this.fromRoute = fromRoute;
    this.#subclasses = subclasses;
    const main = new Map<number, (readonly number[])[]>();
    const off = new Map<number, (readonly number[])[]>();
    for (const kit of kits) {
      // The variant first; behind it what the hand would swing without kits, so a rig lacking the
      // variant still swings with the same family the table names.
      const tail = kit.offhand ? OFFHAND_TAIL : this.attackSeqLadder(kit.subClass) ?? [];
      const variant = Object.freeze([kit.animation, ...tail.filter((id) => id !== kit.animation)]);
      const into = kit.offhand ? off : main;
      const list = into.get(kit.subClass);
      if (list) list.push(variant);
      else into.set(kit.subClass, [variant]);
    }
    this.#mainKits = main;
    this.#offKits = off;
  }

  /** The row of a class-2 subclass, or undefined for one the table does not have. */
  subclass(subClass: number): WeaponSubclassAnims | undefined {
    return this.#subclasses.get(subClass);
  }

  /** The swing variants `AttackAnimKits` lists for this subclass in this hand; undefined when none. */
  attackLadders(subClass: number, hand: WeaponHand): readonly (readonly number[])[] | undefined {
    return (hand === "off" ? this.#offKits : this.#mainKits).get(subClass);
  }

  /** The swing `WeaponAttackSeq` names for this subclass. */
  attackSeqLadder(subClass: number): readonly number[] | undefined {
    const row = this.#subclasses.get(subClass);
    return row === undefined ? undefined : ATTACK_SEQ_LADDERS[row.attack];
  }

  /** The parry `WeaponParrySeq` names for this subclass. */
  parryLadder(subClass: number): readonly number[] | undefined {
    const row = this.#subclasses.get(subClass);
    return row === undefined ? undefined : PARRY_SEQ_LADDERS[row.parry];
  }
}

function isInt(value: unknown): value is number {
  return Number.isSafeInteger(value);
}

/** Validate a route answer; undefined when its shape is not the route's. */
export function weaponAnimTableFrom(data: unknown, version = WEAPON_ANIMS_ROUTE_VERSION): WeaponAnimTable | undefined {
  if (!data || typeof data !== "object") return undefined;
  const value = data as { version?: unknown; subclasses?: unknown; kits?: unknown; types?: unknown };
  if (value.version !== version || !Array.isArray(value.subclasses) || !Array.isArray(value.kits)
    || !Array.isArray(value.types)) return undefined;
  const subclasses = new Map<number, WeaponSubclassAnims>();
  for (const row of value.subclasses as unknown[]) {
    if (!Array.isArray(row) || row.length !== 5 || !row.every(isInt)) return undefined;
    const [sub, parry, ready, attack, swing] = row as number[];
    subclasses.set(sub!, Object.freeze({ parry: parry!, ready: ready!, attack: attack!, swing: swing! }));
  }
  const typeAnimations = new Map<number, number>();
  for (const row of value.types as unknown[]) {
    if (!Array.isArray(row) || row.length !== 2 || !isInt(row[0]) || typeof row[1] !== "string") return undefined;
    const name = ATTACK_TYPE_ANIMATIONS[row[1]];
    const animation = name === undefined ? undefined : ANIMATION_IDS[name];
    if (typeof animation === "number") typeAnimations.set(row[0], animation);
  }
  const kits: { subClass: number; animation: number; offhand: boolean }[] = [];
  for (const row of value.kits as unknown[]) {
    if (!Array.isArray(row) || row.length !== 5 || !row.every(isInt)) return undefined;
    const [, subClass, type, , offhand] = row as number[];
    const animation = typeAnimations.get(type!);
    if (animation !== undefined) kits.push({ subClass: subClass!, animation, offhand: offhand !== 0 });
  }
  return new WeaponAnimTable(true, subclasses, kits);
}

/**
 * `ItemSubClass.dbc` class 2 of this dataset — parry, ready, attack, swing per subclass 0..20 (read
 * 05.10, `.runtime/re-2026-10-05/A7a-D/probe.mjs`). Used only until the route answers.
 */
const STAND_IN_ROWS: readonly (readonly [number, number, number, number])[] = [
  /* 0 axe */ [2, 2, 3, 1], /* 1 axe2 */ [0, 0, 0, 2], /* 2 bow */ [3, 3, 2, 1], /* 3 gun */ [3, 4, 4, 1],
  /* 4 mace */ [2, 2, 3, 1], /* 5 mace2 */ [0, 0, 0, 2], /* 6 polearm */ [1, 1, 1, 2], /* 7 sword */ [2, 2, 3, 1],
  /* 8 sword2 */ [0, 0, 0, 2], /* 9 obsolete */ [3, 2, 3, 1], /* 10 staff */ [1, 1, 1, 2],
  /* 11 exotic */ [3, 2, 3, 1], /* 12 exotic2 */ [3, 2, 3, 2], /* 13 fist */ [3, 2, 3, 0], /* 14 misc */ [3, 2, 3, 1],
  /* 15 dagger */ [2, 2, 3, 0], /* 16 thrown */ [3, 5, 5, 1], /* 17 spear */ [1, 1, 1, 2],
  /* 18 crossbow */ [3, 4, 4, 1], /* 19 wand */ [3, 2, 3, 1], /* 20 fishing pole */ [1, 1, 1, 2],
];

export const STAND_IN_WEAPON_ANIMS = new WeaponAnimTable(false,
  new Map(STAND_IN_ROWS.map(([parry, ready, attack, swing], sub) => [sub, Object.freeze({ parry, ready, attack, swing })])),
  []);

let current: WeaponAnimTable | undefined;

/** The route's table once it has landed, the stand-in before. */
export function weaponAnimTable(): WeaponAnimTable {
  return current ?? STAND_IN_WEAPON_ANIMS;
}

/** Installs a table (the client does on load; tests do directly); undefined goes back to the stand-in. */
export function setWeaponAnimTable(table: WeaponAnimTable | undefined): void {
  current = table;
}

export class WeaponAnimClient {
  readonly origin: string;
  readonly #catalog: RetryingCatalogClient<WeaponAnimTable>;

  constructor(gatewayOrigin: string, options: RetryingCatalogOptions = {}) {
    this.origin = gatewayOrigin;
    this.#catalog = new RetryingCatalogClient(gatewayOrigin, WEAPON_ANIMS_ROUTE_PATH, (data) => weaponAnimTableFrom(data), options);
    this.#catalog.onLoaded = (table) => setWeaponAnimTable(table);
  }

  get state(): CatalogState {
    return this.#catalog.state;
  }

  /** Starts the first cycle, or a new one after the last gave up (a world mount); never a second request. */
  load(): void {
    void (this.#catalog.state === "failed" ? this.#catalog.retry() : this.#catalog.load());
  }
}

let client: WeaponAnimClient | undefined;

/** The page's one weapon-animation table for this gateway origin. */
export function weaponAnimClient(gatewayOrigin: string | undefined): WeaponAnimClient | undefined {
  if (!gatewayOrigin) return undefined;
  if (client?.origin !== gatewayOrigin) {
    // Another gateway: its own tables, the stand-in until they land.
    setWeaponAnimTable(undefined);
    client = new WeaponAnimClient(gatewayOrigin);
  }
  return client;
}
