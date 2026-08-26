import type {
  CreatureSounds, ItemSoundInfo, SoundKit, WeaponSoundTables, ZoneMusicTracks,
} from "../gateway/SoundMetadata.js";

export type { CreatureSounds, ItemSoundInfo, SoundKit, WeaponSoundTables, ZoneMusicTracks };

/** What `/dbc/sounds` answers: the kits asked for, plus the rows that name more of them. */
export interface SoundReply {
  kits: SoundKit[];
  music: Array<{ id: number } & ZoneMusicTracks>;
  intro: Array<{ id: number; sound: number }>;
  ambience: Array<{ id: number; day: number; night: number }>;
  creatures: CreatureSounds[];
  named: Array<{ name: string; id: number }>;
}

/** How many ids may ride in one request. The gateway refuses more. */
const BATCH_LIMIT = 200;

/**
 * The cache-buster on the two sound routes, the way `AreaClient` and `SpellVisualClient` carry one.
 *
 * Both replies are held for an hour and both are asked for by the same URL from one session to the
 * next — `/dbc/sounds?creatures=49` is the same request every time a human male comes into view —
 * so a reply whose *shape* changes without its URL changing is served out of the browser's own
 * cache in the old shape for that hour. Version 2 added ambience and the widened creature row;
 * version 3 carries `ZoneMusic`'s silence range beside each day/night kit. Without this bump a
 * browser can keep answering `{ day: 2523, night: 2523 }` to code expecting the nested programme
 * for an hour. The weapon route has its own version because its payload changes independently.
 */
const SOUND_ROUTE_VERSION = "3";
const WEAPON_ROUTE_VERSION = "1";

/**
 * What the client knows about sound kits, gathered a batch at a time.
 *
 * The same arrangement `SpellMetadata` uses, and for the same reason. `SoundEntries` is 12,941
 * rows naming 20,642 files — about a megabyte and a half of JSON — and a session plays a few dozen
 * of them. Ids are collected as the packets ask for them and go out on the next frame in one
 * request, so a pull of six mobs is one round trip rather than six.
 */
export class SoundClient {
  readonly #baseUrl: string;
  readonly #kits = new Map<number, SoundKit | null>();
  readonly #music = new Map<number, ZoneMusicTracks | null>();
  readonly #intro = new Map<number, number | null>();
  readonly #wantedKits = new Set<number>();
  readonly #wantedMusic = new Set<number>();
  readonly #wantedIntro = new Set<number>();
  readonly #creatures = new Map<number, CreatureSounds | null>();
  readonly #named = new Map<string, number | null>();
  readonly #wantedCreatures = new Set<number>();
  readonly #wantedNames = new Set<string>();
  readonly #ambience = new Map<number, { day: number; night: number } | null>();
  readonly #wantedAmbience = new Set<number>();
  #pending: Promise<void> | undefined;
  #spellKits: Map<number, number> | undefined;
  #spellKitsPending: Promise<void> | undefined;
  #weapons: WeaponSoundTables | undefined;
  #weaponsPending: Promise<void> | undefined;
  readonly #items = new Map<number, ItemSoundInfo | null>();
  readonly #wantedItems = new Set<number>();
  #itemsPending: Promise<void> | undefined;
  onStatus: ((message: string, error: boolean) => void) | undefined;
  /** Called whenever a batch lands, so whoever was waiting on an id can look again. */
  onLoaded: (() => void) | undefined;

  constructor(gatewayWebSocketUrl: string) {
    const url = new URL(gatewayWebSocketUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    this.#baseUrl = url.origin;
  }

  /**
   * A kit, if it has arrived — and a request for it if it has not.
   *
   * `null` in the map is «asked, and the table does not have it», which is a real answer: 19 of
   * the rows name no file and a realm can invent ids of its own. Without it every unknown id
   * would be asked for again on every packet that named it.
   */
  kit(id: number): SoundKit | undefined {
    if (id <= 0) return undefined;
    const held = this.#kits.get(id);
    if (held !== undefined) return held ?? undefined;
    this.#wantedKits.add(id);
    this.#schedule();
    return undefined;
  }

  /** Whether a kit request has landed, including the definite answer that no such kit exists. */
  kitAnswered(id: number): boolean {
    return id <= 0 || this.#kits.has(id);
  }

  /** The two programmes of a `ZoneMusic` row, including their authored silence intervals. */
  zoneMusic(id: number): ZoneMusicTracks | undefined {
    if (id <= 0) return undefined;
    const held = this.#music.get(id);
    if (held !== undefined) return held ?? undefined;
    this.#wantedMusic.add(id);
    this.#schedule();
    return undefined;
  }

  /**
   * What a creature display sounds like: notice, hurt, die, swing.
   *
   * By display id, because that is the number the unit's own fields carry — and because 24,220 of
   * the 24,262 displays have an answer, so this is worth asking for every creature that comes
   * into view rather than for the handful that happen to be special.
   */
  creatureSounds(displayId: number): CreatureSounds | undefined {
    if (displayId <= 0) return undefined;
    const held = this.#creatures.get(displayId);
    if (held !== undefined) return held ?? undefined;
    this.#wantedCreatures.add(displayId);
    this.#schedule();
    return undefined;
  }

  /** A `SoundEntries` row by its `Name`, which is how the interface's own noises are addressed. */
  named(name: string): number | undefined {
    const held = this.#named.get(name);
    if (held !== undefined) return held ?? undefined;
    this.#wantedNames.add(name);
    this.#schedule();
    return undefined;
  }

  /**
   * The two ambience kits of a `SoundAmbience` row, day and night.
   *
   * The same shape as `zoneMusic`, and asked for the same way: an area names a row, the row names
   * two `SoundEntries` kits, and the kits ride back in the same reply.
   */
  ambience(id: number): { day: number; night: number } | undefined {
    if (id <= 0) return undefined;
    const held = this.#ambience.get(id);
    if (held !== undefined) return held ?? undefined;
    this.#wantedAmbience.add(id);
    this.#schedule();
    return undefined;
  }

  /** The sting a zone plays on entry, as a kit id. */
  zoneIntro(id: number): number | undefined {
    if (id <= 0) return undefined;
    const held = this.#intro.get(id);
    if (held !== undefined) return held ?? undefined;
    this.#wantedIntro.add(id);
    this.#schedule();
    return undefined;
  }

  /** Whether a zone-intro lookup has landed, including a definite missing row. */
  zoneIntroAnswered(id: number): boolean {
    return id <= 0 || this.#intro.has(id);
  }

  /**
   * The `SpellVisualKit` to `SoundEntries` table, fetched whole on entering a world.
   *
   * Whole and not per id, because `SMSG_PLAY_SPELL_VISUAL_KIT` is a scripted event — a ward, a
   * trap arming, a boss's gesture — and the sound belongs to the moment it lands. A round trip
   * there is a noise that arrives after the thing that made it.
   */
  loadSpellKits(): void {
    if (this.#spellKits || this.#spellKitsPending) return;
    this.#spellKitsPending = (async () => {
      try {
        const response = await fetch(`${this.#baseUrl}/dbc/spell-kit-sounds`);
        if (!response.ok) throw new Error(`sound gateway returned ${response.status}`);
        const reply = await response.json() as { kits: Array<[number, number]> };
        if (!Array.isArray(reply.kits)) throw new Error("malformed kit sound data");
        this.#spellKits = new Map(reply.kits);
        this.onLoaded?.();
      } catch (error) {
        this.onStatus?.(`звуки заклинаний: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    })();
  }

  /** The `SoundEntries` id a `SpellVisualKit` names, or nothing while the table is in flight. */
  spellKitSound(kitId: number): number | undefined {
    return this.#spellKits?.get(kitId);
  }

  /**
   * The weapon-sound tables, fetched whole on entering a world and held for the session.
   *
   * Whole and not per swing, for the reason `loadSpellKits` is: the noise of a blow belongs to the
   * blow, and a round trip puts it after. All of it is 4,671 bytes — 30 impact rows, 6 swing
   * whooshes, the swing size of 21 weapon subclasses and the two miss ids.
   */
  loadWeaponSounds(): void {
    if (this.#weapons || this.#weaponsPending) return;
    this.#weaponsPending = (async () => {
      try {
        const response = await fetch(`${this.#baseUrl}/dbc/weapon-sounds?v=${WEAPON_ROUTE_VERSION}`);
        if (!response.ok) throw new Error(`sound gateway returned ${response.status}`);
        const reply = await response.json() as WeaponSoundTables;
        if (!Array.isArray(reply.impacts) || !Array.isArray(reply.swings)) {
          throw new Error("malformed weapon sound data");
        }
        this.#weapons = reply;
        this.onLoaded?.();
      } catch (error) {
        this.onStatus?.(`звуки оружия: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    })();
  }

  /** The weapon tables, or nothing while they are in flight. */
  weaponSounds(): WeaponSoundTables | undefined {
    return this.#weapons;
  }

  /**
   * What `Item.dbc` says one entry is made of, gathered a batch at a time.
   *
   * Batched rather than fetched whole because `Item.dbc` is 46,098 rows: what a session needs is
   * the weapon in the attacker's hand and the breastplate on whatever it is hitting, which are
   * known from the unit's own fields well before the first swing lands.
   */
  itemSound(entry: number): ItemSoundInfo | undefined {
    if (entry <= 0) return undefined;
    const held = this.#items.get(entry);
    if (held !== undefined) return held ?? undefined;
    this.#wantedItems.add(entry);
    this.#scheduleItems();
    return undefined;
  }

  /**
   * Whether this entry has been answered for at all — with a row, or with a definite «no row».
   *
   * `itemSound` cannot say: it answers `undefined` both for an entry still in flight and for one
   * `Item.dbc` does not carry, and a swing has to tell those apart. Waiting for the first is the
   * difference between the session's opening blow sounding like the sword that made it and sounding
   * like a bare fist; waiting for the second would be a held-back sound on every swing for ever.
   * Zero is «nothing in that hand», which is an answer and needs no waiting.
   */
  itemAnswered(entry: number): boolean {
    return entry <= 0 || this.#items.has(entry);
  }

  #scheduleItems(): void {
    if (this.#itemsPending) return;
    this.#itemsPending = Promise.resolve().then(() => this.#flushItems());
  }

  async #flushItems(): Promise<void> {
    const entries = [...this.#wantedItems].slice(0, BATCH_LIMIT);
    for (const entry of entries) this.#wantedItems.delete(entry);
    this.#itemsPending = undefined;
    if (entries.length === 0) return;
    try {
      const response = await fetch(
        `${this.#baseUrl}/dbc/weapon-sounds?v=${WEAPON_ROUTE_VERSION}&items=${entries.join(",")}`);
      if (!response.ok) throw new Error(`sound gateway returned ${response.status}`);
      const reply = await response.json() as { items: ItemSoundInfo[] };
      if (!Array.isArray(reply.items)) throw new Error("malformed item sound data");
      for (const item of reply.items) this.#items.set(item.entry, item);
      // An entry the reply did not carry is not in `Item.dbc` — a server's own item, most likely.
      // Recorded as such, or it is asked for again on every swing for the rest of the session.
      for (const entry of entries) if (!this.#items.has(entry)) this.#items.set(entry, null);
      this.onLoaded?.();
    } catch (error) {
      this.onStatus?.(`звуки оружия: ${error instanceof Error ? error.message : String(error)}`, true);
    }
    if (this.#wantedItems.size > 0) this.#scheduleItems();
  }

  #schedule(): void {
    if (this.#pending) return;
    // A microtask rather than a timer: everything that asks in one frame asks before the frame
    // ends, and the request goes out on the turn after it.
    this.#pending = Promise.resolve().then(() => this.#flush());
  }

  async #flush(): Promise<void> {
    const ids = [...this.#wantedKits].slice(0, BATCH_LIMIT);
    const music = [...this.#wantedMusic].slice(0, BATCH_LIMIT);
    const intro = [...this.#wantedIntro].slice(0, BATCH_LIMIT);
    const creatures = [...this.#wantedCreatures].slice(0, BATCH_LIMIT);
    const names = [...this.#wantedNames].slice(0, BATCH_LIMIT);
    const ambience = [...this.#wantedAmbience].slice(0, BATCH_LIMIT);
    for (const id of ids) this.#wantedKits.delete(id);
    for (const id of music) this.#wantedMusic.delete(id);
    for (const id of intro) this.#wantedIntro.delete(id);
    for (const id of creatures) this.#wantedCreatures.delete(id);
    for (const name of names) this.#wantedNames.delete(name);
    for (const id of ambience) this.#wantedAmbience.delete(id);
    this.#pending = undefined;
    if (ids.length + music.length + intro.length + creatures.length + names.length
      + ambience.length === 0) return;

    const query = new URLSearchParams();
    query.set("v", SOUND_ROUTE_VERSION);
    if (ids.length) query.set("ids", ids.join(","));
    if (music.length) query.set("music", music.join(","));
    if (intro.length) query.set("intro", intro.join(","));
    if (creatures.length) query.set("creatures", creatures.join(","));
    if (names.length) query.set("names", names.join(","));
    if (ambience.length) query.set("ambience", ambience.join(","));
    try {
      const response = await fetch(`${this.#baseUrl}/dbc/sounds?${query.toString()}`);
      if (!response.ok) throw new Error(`sound gateway returned ${response.status}`);
      const reply = await response.json() as SoundReply;
      if (!Array.isArray(reply.kits)) throw new Error("malformed sound data");
      for (const kit of reply.kits) this.#kits.set(kit.id, kit);
      for (const row of reply.music ?? []) {
        this.#music.set(row.id, { day: row.day, night: row.night });
      }
      for (const row of reply.intro ?? []) this.#intro.set(row.id, row.sound);
      for (const row of reply.creatures ?? []) this.#creatures.set(row.id, row);
      for (const row of reply.named ?? []) this.#named.set(row.name, row.id);
      for (const row of reply.ambience ?? []) this.#ambience.set(row.id, { day: row.day, night: row.night });
      // Whatever the reply did not carry does not exist. Recorded, or it is asked for for ever.
      for (const id of ids) if (!this.#kits.has(id)) this.#kits.set(id, null);
      for (const id of music) if (!this.#music.has(id)) this.#music.set(id, null);
      for (const id of intro) if (!this.#intro.has(id)) this.#intro.set(id, null);
      for (const id of creatures) if (!this.#creatures.has(id)) this.#creatures.set(id, null);
      for (const name of names) if (!this.#named.has(name)) this.#named.set(name, null);
      for (const id of ambience) if (!this.#ambience.has(id)) this.#ambience.set(id, null);
      this.onLoaded?.();
    } catch (error) {
      // Not remembered as a failure: a batch can fail because the gateway blinked, and a sound is
      // asked for again the next time the server plays one. What must not happen is a retry loop,
      // and there is none — nothing here re-queues.
      this.onStatus?.(`звуки: ${error instanceof Error ? error.message : String(error)}`, true);
    }
    // Anything that arrived while this batch was in flight goes out on the next one.
    if (this.#wantedKits.size + this.#wantedMusic.size + this.#wantedIntro.size
      + this.#wantedCreatures.size + this.#wantedNames.size
      + this.#wantedAmbience.size > 0) this.#schedule();
  }
}
