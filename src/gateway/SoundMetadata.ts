import { openDbcFile, type Dbc } from "./Dbc.js";

/**
 * What `SoundEntries` says about one sound, in the terms a `PannerNode` wants.
 *
 * The table is 12,941 rows and 20,642 file paths, so it is served by id rather than whole: a
 * session plays a few dozen of them and downloading a megabyte and a half of JSON to find five
 * footsteps would cost more than the footsteps do.
 */
export interface SoundKit {
  id: number;
  /** `SoundType`: 1 is a spell, 3 a footstep, 28 zone music, and so on down the table. */
  type: number;
  name: string;
  /**
   * Every variant, `DirectoryBase` already joined on.
   *
   * `DirectoryBase` begins with `Sound\` of its own. Prefixing it again misses all 20,642 paths,
   * which looks like an empty client rather than like a mistake.
   */
  files: string[];
  /** 0.01 to 1.0 across the table. */
  volume: number;
  /** `PannerNode.refDistance`: inside this the sound is at full volume. Usually 8 yards. */
  minDistance: number;
  /** `PannerNode.maxDistance`: past this it is not attenuated further. Usually 45 yards. */
  maxDistance: number;
  flags: number;
}

/** One half of a `ZoneMusic` row: the kit to draw from and the silence after one track. */
export interface ZoneMusicTrack {
  /** A `SoundEntries` id whose files are alternative tracks, not pieces of one looping track. */
  kit: number;
  /** Milliseconds of silence after a track ends, inclusive lower bound. */
  silenceMin: number;
  /** Milliseconds of silence after a track ends, inclusive upper bound. */
  silenceMax: number;
}

/** The daylight and night-time programmes authored by one `ZoneMusic` row. */
export interface ZoneMusicTracks {
  day: ZoneMusicTrack;
  night: ZoneMusicTrack;
}

/**
 * One spelling for a path that `SoundEntries` writes several ways.
 *
 * Deliberately the same rule as `tools/generate-sound.mjs`, and deliberately written twice: the
 * generator is a standalone `.mjs` the gateway spawns rather than imports, exactly as
 * `textureId` is duplicated between `Gateway.ts` and `generate-texture.mjs`. 45 of the slots join
 * their directory to their filename with a doubled separator and 26 carry a leading one; left
 * alone those are 163 paths the archives do not have, normalised the misses are the 124 that
 * genuinely are not in the client.
 */
export function normaliseSoundPath(value: string): string {
  return value.replaceAll("/", "\\").replace(/\\+/g, "\\").replace(/^\\/, "");
}

function kitOf(entries: Dbc<"SoundEntries">, row: number): SoundKit {
  const base = entries.string(row, "DirectoryBase");
  const files: string[] = [];
  for (let variant = 0; variant < 10; variant++) {
    const file = entries.string(row, "File", variant);
    if (file) files.push(normaliseSoundPath(`${base}\\${file}`));
  }
  return {
    id: entries.id(row),
    type: entries.int(row, "SoundType"),
    name: entries.string(row, "Name"),
    files,
    volume: entries.float(row, "VolumeFloat"),
    minDistance: entries.float(row, "MinDistance"),
    maxDistance: entries.float(row, "DistanceCutoff"),
    flags: entries.int(row, "Flags"),
  };
}

/**
 * The noises a creature makes that a player notices, as `SoundEntries` ids.
 *
 * Zero where the table has nothing — a creature that does not scream when hit is a real answer and
 * not a missing one.
 *
 * `CreatureSoundData` is 38 columns and this used to read four of them. Populated rows on this
 * dataset, out of 1,306: injury 836, exertion 818, injuryCritical 818, death 659, aggro 575,
 * alert 470, loop 141, fidget[0] 89, exertionCritical 56, jumpStart 26, jumpEnd 23, birth 18,
 * impactType 2. `injuryCritical` alone doubles what a player hears in a fight and costs four bytes
 * on the wire, which is why the widening is here rather than in the slice that plays them.
 */
export interface CreatureSounds {
  id: number;
  aggro: number;
  injury: number;
  /** What it screams when the blow was a critical one. */
  injuryCritical: number;
  death: number;
  exertion: number;
  exertionCritical: number;
  /** The noise it makes on noticing something it does not attack. */
  alert: number;
  /** A sound that runs for as long as the creature is there — a wisp's hum, a fire elemental. */
  loop: number;
  /**
   * Its idle noises, only the ones it has.
   *
   * The column is five wide and 89 of the 1,306 rows fill the first; carrying the zeros would be
   * five numbers per creature on the wire to say nothing, and a fidget is drawn at random from
   * whichever ones exist anyway.
   */
  fidget: number[];
  jumpStart: number;
  jumpEnd: number;
  birth: number;
  /**
   * `CreatureImpactType`: which body slot of `WeaponImpactSounds` this creature is made of.
   *
   * 1,304 of 1,306 rows are 0 — flesh — which is the default a client should assume anyway, so
   * this is here to be right about the two rather than to be interesting.
   */
  impactType: number;
}

/**
 * One row of `WeaponImpactSounds`: what a weapon of this subclass and material lands like.
 *
 * The ten slots are, in order: flesh, chain, plate, metal shield, wood shield, metal weapon,
 * wood weapon, wood, stone, ethereal. Slots 3 and 4 are a block, 5 and 6 a parry, 0 to 2 the
 * defender's body — decoded from the bytes, and readable in the names the ids resolve to: row
 * `subclass 0, metal` is `Axe1H_ArmorFlesh`, `_ArmorChain`, `_ArmorPlate`, `Shield Metal Impact`,
 * `ShieldWoodImpact`, `1hParryMetalHitMetal`, `1hParryMetalHitWood`, `Axe1H_HitWood`,
 * `_HitStone`, `Ethereal_1H`.
 */
export interface WeaponImpactRow {
  /** `Item.SubclassID` of class 2, or `Sound_Override_Subclassid` where the item has one. */
  subClass: number;
  /**
   * 1 where the weapon is metal, 0 where it is wood.
   *
   * Upstream calls this column `ParrySoundType`, which undersells it: it selects the whole row and
   * not only its parry slots. See the note in `tools/dbd/README.md` for the measurement.
   */
  metal: number;
  normal: number[];
  critical: number[];
}

/** One row of `WeaponSwingSounds2`: the whoosh a weapon of this size makes on the way in. */
export interface WeaponSwingRow {
  /** `ItemSubClass.WeaponSwingSize`: 0 light (dagger, fist), 1 one-handed, 2 two-handed. */
  size: number;
  critical: boolean;
  soundId: number;
}

/**
 * Everything the client needs to pick a combat sound, except which items the two fighters hold.
 *
 * Small enough to fetch once and hold for the session — measured at 4,671 bytes of JSON on this
 * dataset, 30 impact rows, 6 swings and 21 weapon subclasses — which is what a swing needs: the
 * noise belongs to the moment, not to the round trip after it.
 */
export interface WeaponSoundTables {
  impacts: WeaponImpactRow[];
  swings: WeaponSwingRow[];
  /** `[weapon subclass, WeaponSwingSize]` for every subclass of item class 2. */
  swingSizes: Array<[number, number]>;
  /**
   * `SoundEntries` 7080 and 7081, «(DONOTRENAME)Combat Miss 1H/2H».
   *
   * Not in either weapon table: a miss is the only combat outcome whose sound is a bare id. They
   * are two of the eight rows of `SoundType` 6 — the other six are the swings above — and they
   * ride here because `/dbc/sounds?names=` refuses a name with brackets and spaces in it
   * (`/^[A-Za-z0-9_]{1,64}$/`), so the client cannot ask for them the way it asks for `LEVELUP`.
   */
  miss: { oneHanded: number; twoHanded: number };
}

/**
 * What `Item.dbc` says about one entry, in the terms a combat sound wants.
 *
 * By entry and in batches, not whole: `Item.dbc` is 46,098 rows and serving it entire is 796 KB of
 * JSON even flattened to bare numbers, against 18.2 KB for the 200 the route will answer at once.
 * A session needs the handful of items the player and whatever they are hitting have on.
 */
export interface ItemSoundInfo {
  entry: number;
  /** 2 is a weapon, 4 armour. Everything else has no combat sound of its own. */
  classId: number;
  subClass: number;
  /** `Sound_Override_Subclassid`: −1 on all but 1,976 rows, and it replaces `subClass` when set. */
  soundOverrideSubclass: number;
  /** `Material`: 1 metal, 2 wood, 3 liquid, 4 jewellery, 5 chain, 6 plate, 7 cloth, 8 leather. */
  material: number;
  sheathe: number;
}

/**
 * The two miss whooshes, by id.
 *
 * Written here rather than looked up: `SoundType` 6 holds exactly eight rows on this dataset and
 * these are the two that are not swings, but «the row whose name contains Miss» is a string match
 * where a constant is honest about being one.
 */
const MISS_ONE_HANDED = 7080;
const MISS_TWO_HANDED = 7081;

/** `ItemSubClass` rows are keyed on a class and a subclass; weapons are class 2. */
const WEAPON_CLASS = 2;
/** `CreatureSoundData.SoundFidget` is five wide, and 89 of the 1,306 rows fill the first slot. */
const CREATURE_FIDGETS = 5;
/** `WeaponImpactSounds` and `WeaponSwingSounds2` both hold ten-slot arrays of `SoundEntries` ids. */
const IMPACT_SLOTS = 10;

/**
 * The four tables a weapon's noise is decided from, held open for the life of the process.
 *
 * Separate from `SoundIndex` because of `Item.dbc`: 46,098 rows nothing else needs, and a route
 * asking about a creature's scream should not pay to open it.
 */
export class WeaponSoundIndex {
  readonly #tables: WeaponSoundTables;
  readonly #items: Dbc<"Item">;

  private constructor(
    impacts: Dbc<"WeaponImpactSounds">,
    swings: Dbc<"WeaponSwingSounds2">,
    subClasses: Dbc<"ItemSubClass">,
    items: Dbc<"Item">,
  ) {
    this.#items = items;
    const impactRows: WeaponImpactRow[] = [];
    for (const row of impacts.rows()) {
      const normal: number[] = [];
      const critical: number[] = [];
      for (let slot = 0; slot < IMPACT_SLOTS; slot++) {
        normal.push(impacts.int(row, "ImpactSoundID", slot));
        critical.push(impacts.int(row, "CritImpactSoundID", slot));
      }
      impactRows.push({
        subClass: impacts.int(row, "WeaponSubClassID"),
        metal: impacts.int(row, "ParrySoundType"),
        normal,
        critical,
      });
    }
    const swingRows: WeaponSwingRow[] = [];
    for (const row of swings.rows()) {
      swingRows.push({
        size: swings.int(row, "SwingType"),
        critical: swings.int(row, "Crit") === 1,
        soundId: swings.int(row, "SoundID"),
      });
    }
    const swingSizes: Array<[number, number]> = [];
    for (const row of subClasses.rows()) {
      // `ItemSubClass` covers every item class; only weapons swing. 21 of its 119 rows are class 2.
      if (subClasses.int(row, "ClassID") !== WEAPON_CLASS) continue;
      swingSizes.push([subClasses.int(row, "SubClassID"), subClasses.int(row, "WeaponSwingSize")]);
    }
    this.#tables = {
      impacts: impactRows,
      swings: swingRows,
      swingSizes,
      miss: { oneHanded: MISS_ONE_HANDED, twoHanded: MISS_TWO_HANDED },
    };
  }

  /** The whole of what is fetched once and held for the session. */
  tables(): WeaponSoundTables {
    return this.#tables;
  }

  /** What one item entry is made of, or nothing for an entry `Item.dbc` does not carry. */
  item(entry: number): ItemSoundInfo | undefined {
    const row = this.#items.rowOf(entry);
    if (row === undefined) return undefined;
    return {
      entry,
      classId: this.#items.int(row, "ClassID"),
      subClass: this.#items.int(row, "SubclassID"),
      soundOverrideSubclass: this.#items.int(row, "Sound_Override_Subclassid"),
      material: this.#items.int(row, "Material"),
      sheathe: this.#items.int(row, "SheatheType"),
    };
  }

  /** Every `SoundEntries` id the tables name, so a caller can check they all resolve. */
  soundIds(): number[] {
    const ids = new Set<number>([MISS_ONE_HANDED, MISS_TWO_HANDED]);
    for (const row of this.#tables.impacts) {
      for (const id of [...row.normal, ...row.critical]) if (id > 0) ids.add(id);
    }
    for (const row of this.#tables.swings) if (row.soundId > 0) ids.add(row.soundId);
    return [...ids];
  }

  static async load(directory: string): Promise<WeaponSoundIndex> {
    const [impacts, swings, subClasses, items] = await Promise.all([
      openDbcFile(directory, "WeaponImpactSounds"),
      openDbcFile(directory, "WeaponSwingSounds2"),
      openDbcFile(directory, "ItemSubClass"),
      openDbcFile(directory, "Item"),
    ]);
    return new WeaponSoundIndex(impacts, swings, subClasses, items);
  }
}

/**
 * The sound tables, held open for the life of the process and asked by id.
 *
 * `ZoneMusic`, `ZoneIntroMusicTable` and `SoundAmbience` ride along because they answer *in*
 * `SoundEntries` ids and a caller that has one without the other has half an answer.
 */
export class SoundIndex {
  readonly #byId = new Map<number, SoundKit>();
  readonly #byName = new Map<string, number>();
  readonly #creatures = new Map<number, CreatureSounds>();
  readonly #zoneMusic = new Map<number, ZoneMusicTracks>();
  readonly #zoneIntro = new Map<number, number>();
  readonly #ambience = new Map<number, { day: number; night: number }>();
  readonly #spellKits: Array<[number, number]> = [];

  private constructor(
    entries: Dbc<"SoundEntries">,
    music: Dbc<"ZoneMusic">,
    intro: Dbc<"ZoneIntroMusicTable">,
    spellKits: Dbc<"SpellVisualKit">,
    display: Dbc<"CreatureDisplayInfo">,
    models: Dbc<"CreatureModelData">,
    creatures: Dbc<"CreatureSoundData">,
    ambience: Dbc<"SoundAmbience">,
    uiSounds: Dbc<"UISoundLookups">,
  ) {
    for (let row = 0; row < entries.records; row++) {
      const kit = kitOf(entries, row);
      // 19 of the 12,941 rows name no file at all. They are ids nothing can play, and keeping
      // them would make "the kit is not in the table" and "the kit has no sound" the same answer.
      if (kit.files.length > 0) this.#byId.set(kit.id, kit);
    }
    for (let row = 0; row < music.records; row++) {
      const day = music.int(row, "Sounds", 0);
      const slot = (at: number, kit: number): ZoneMusicTrack => {
        // The data is almost uniformly min <= max, but row 225 has its night values reversed
        // (1,800,000 then 300,000). Treating the column names as arithmetic without normalising
        // would create a negative random range and schedule the track in the past.
        const first = Math.max(0, music.int(row, "SilenceIntervalMin", at));
        const second = Math.max(0, music.int(row, "SilenceIntervalMax", at));
        return {
          kit,
          silenceMin: Math.min(first, second),
          silenceMax: Math.max(first, second),
        };
      };
      this.#zoneMusic.set(music.id(row), {
        day: slot(0, day),
        night: slot(1, music.int(row, "Sounds", 1) || day),
      });
    }
    for (let row = 0; row < intro.records; row++) {
      this.#zoneIntro.set(intro.id(row), intro.int(row, "SoundID"));
    }
    // The same shape as `ZoneMusic`, down to answering with the day kit twice where a row carries
    // only one — though on this dataset all 206 rows fill both slots and 159 fill them alike.
    for (let row = 0; row < ambience.records; row++) {
      const day = ambience.int(row, "AmbienceID", 0);
      const night = ambience.int(row, "AmbienceID", 1);
      this.#ambience.set(ambience.id(row), { day, night: night || day });
    }
    for (let row = 0; row < spellKits.records; row++) {
      const sound = spellKits.int(row, "SoundID");
      if (sound > 0) this.#spellKits.push([spellKits.id(row), sound]);
    }

    // The interface's own noises are addressed by name — `LEVELUP`, `igBackPackOpen` — because a
    // number would be a magic number in the browser and the name is what the client's own Lua
    // calls them.
    for (let row = 0; row < entries.records; row++) {
      const name = entries.string(row, "Name");
      if (name && !this.#byName.has(name)) this.#byName.set(name, entries.id(row));
    }
    // And the client's own list of them, for the names `SoundEntries` does not spell the same way.
    // `GameSounds.ts` records four names one would reach for first — `InterfaceError`, `igMapOpen`,
    // `PickUpGold`, `PutDownGold` — that are absent from `SoundEntries.Name`; three of them are
    // here under another name (`GAMEERRORINVALIDTARGET`, `CURSORGRABOBJECT`, `CURSORDROPOBJECT`),
    // and two of those three become askable. `SoundEntries` wins where both have a name, and a
    // lookup pointing at a kit that cannot be played is not registered at all — a name that
    // answers with an id nothing can play is worse than no name. Measured: of the 129 rows 18
    // duplicate a `SoundEntries.Name` and 111 are new, 101 of which register; the ten that do not
    // name `SoundEntries` ids this build has no row for at all, `GAMEERRORINVALIDTARGET`'s 887
    // among them, which is why that one is still missing after this.
    for (const row of uiSounds.rows()) {
      const name = uiSounds.string(row, "Name");
      const id = uiSounds.int(row, "SoundID");
      if (!name || this.#byName.has(name) || !this.#byId.has(id)) continue;
      this.#byName.set(name, id);
    }

    // A creature names its sounds twice over, and only the second one is worth anything.
    // `CreatureDisplayInfo.SoundID` is an override and is set on 1,205 of 24,262 rows; the usual
    // answer is on the *model* it points at, and `CreatureModelData.SoundID` is set on 1,277 of
    // 1,331. Following both takes coverage from 5% of displays to **24,220 of 24,262** — which is
    // the difference between a handful of audible creatures and effectively all of them. It read
    // 24,224 when it was first written down and 24,220 counted again on the dataset this machine
    // holds today; which build moved it was not established, so the number is the one measured.
    const modelSound = new Map<number, number>();
    for (let row = 0; row < models.records; row++) modelSound.set(models.id(row), models.int(row, "SoundID"));
    for (let row = 0; row < display.records; row++) {
      const soundId = display.int(row, "SoundID") || modelSound.get(display.int(row, "ModelID")) || 0;
      if (soundId <= 0) continue;
      const source = creatures.rowOf(soundId);
      if (source === undefined) continue;
      // An id nothing can play is reported as no sound at all. `CreatureSoundData` names three
      // that are not in `SoundEntries` on this dataset — 12,794 as an alert on four displays,
      // 14,957 as a death on one and 12,966 as a loop on thirteen — and handing those to a client
      // is handing it a request that can only fail, once per swing, for the whole session.
      const playable = (column: Parameters<typeof creatures.int>[1], element = 0): number => {
        const id = creatures.int(source, column, element);
        return id > 0 && this.#byId.has(id) ? id : 0;
      };
      const fidget: number[] = [];
      for (let slot = 0; slot < CREATURE_FIDGETS; slot++) {
        const id = playable("SoundFidget", slot);
        if (id > 0) fidget.push(id);
      }
      this.#creatures.set(display.id(row), {
        id: display.id(row),
        aggro: playable("SoundAggroID"),
        injury: playable("SoundInjuryID"),
        injuryCritical: playable("SoundInjuryCriticalID"),
        death: playable("SoundDeathID"),
        exertion: playable("SoundExertionID"),
        exertionCritical: playable("SoundExertionCriticalID"),
        alert: playable("SoundAlertID"),
        loop: playable("LoopSoundID"),
        fidget,
        jumpStart: playable("SoundJumpStartID"),
        jumpEnd: playable("SoundJumpEndID"),
        birth: playable("BirthSoundID"),
        impactType: creatures.int(source, "CreatureImpactType"),
      });
    }
  }

  /** Every `SoundEntries` id one creature's row names, for a route that resolves them to kits. */
  static creatureSoundIds(sounds: CreatureSounds): number[] {
    return [
      sounds.aggro, sounds.injury, sounds.injuryCritical, sounds.death, sounds.exertion,
      sounds.exertionCritical, sounds.alert, sounds.loop, ...sounds.fidget,
      sounds.jumpStart, sounds.jumpEnd, sounds.birth,
    ].filter((id) => id > 0);
  }

  /** The `SoundEntries` row with this `Name`, which is how the interface asks for its own noises. */
  named(name: string): number | undefined {
    return this.#byName.get(name);
  }

  /** What a creature display sounds like when it notices you, is hit, or dies. */
  creature(displayId: number): CreatureSounds | undefined {
    return this.#creatures.get(displayId);
  }

  static async load(directory: string): Promise<SoundIndex> {
    const [entries, music, intro, spellKits, display, models, creatures, ambience, uiSounds] =
      await Promise.all([
        openDbcFile(directory, "SoundEntries"),
        openDbcFile(directory, "ZoneMusic"),
        openDbcFile(directory, "ZoneIntroMusicTable"),
        openDbcFile(directory, "SpellVisualKit"),
        openDbcFile(directory, "CreatureDisplayInfo"),
        openDbcFile(directory, "CreatureModelData"),
        openDbcFile(directory, "CreatureSoundData"),
        openDbcFile(directory, "SoundAmbience"),
        openDbcFile(directory, "UISoundLookups"),
      ]);
    return new SoundIndex(entries, music, intro, spellKits, display, models, creatures, ambience,
      uiSounds);
  }

  /**
   * Every `SpellVisualKit` that names a sound, as `[kitId, soundId]`.
   *
   * Served whole and held for the session, which is what `SMSG_PLAY_SPELL_VISUAL_KIT` needs: the
   * packet names a kit and the sound has to start now, not after a round trip. 4,680 of the 8,663
   * kits carry one and the pairs are 58 KB of JSON — less than a single spell icon.
   */
  spellKitSounds(): ReadonlyArray<readonly [number, number]> {
    return this.#spellKits;
  }

  kit(id: number): SoundKit | undefined {
    return this.#byId.get(id);
  }

  /**
   * The day and night programmes of a `ZoneMusic` row: kit plus authored post-track silence.
   *
   * A row with only a day track answers with the same kit twice rather than with a zero, so a
   * caller never has to know which half of the clock it is looking at. The two silence ranges stay
   * separate even in that case because they are authored independently.
   */
  zoneMusic(id: number): ZoneMusicTracks | undefined {
    return this.#zoneMusic.get(id);
  }

  /** The one-off sting a zone plays on entry, as a `SoundEntries` id. */
  zoneIntro(id: number): number | undefined {
    return this.#zoneIntro.get(id);
  }

  /**
   * The wind, the crickets and the surf of one `AreaTable.AmbienceID`, day and night.
   *
   * 445 of the 2,307 areas carry one, between them naming 86 distinct rows, and none of the 86 is
   * missing from `SoundAmbience` — so an area that has an id has a sound, always.
   */
  ambience(id: number): { day: number; night: number } | undefined {
    return this.#ambience.get(id);
  }
}
