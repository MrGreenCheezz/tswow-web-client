// The DBC tables this client reads, or is about to.
//
// Definitions come from WoWDBDefs and are vendored under tools/dbd/ so the build needs no
// network. `node tools/fetch-dbd.mjs` refreshes them. Keep the list to tables that are actually
// used: every entry is a file we carry and a licence obligation (see tools/dbd/README.md).

export const DBD_TABLES = [
  // Already read by the gateway and the generators.
  "AnimationData",
  "CharSections",
  "CreatureDisplayInfo",
  "CreatureDisplayInfoExtra",
  "CreatureFamily",
  "CreatureModelData",
  "GameObjectDisplayInfo",
  "ItemDisplayInfo",
  "Map",
  "Spell",
  "SpellIcon",

  // Character appearance: geoset selection and the 512x512 skin atlas. Note that
  // CharComponentTextureSections is Cataclysm-era; in 3.3.5 the atlas rectangles are fixed in
  // the client, so there is no table to read them from.
  "CharBaseInfo",
  "CharHairGeosets",
  "CharacterFacialHairStyles",
  "ChrClasses",
  "ChrRaces",
  "HelmetGeosetVisData",
  "ItemVisuals",
  "ItemVisualEffects",

  // Sound.
  "SoundEntries",
  "SoundEntriesAdvanced",
  "CreatureSoundData",
  "ZoneMusic",
  "ZoneIntroMusicTable",
  "FootstepTerrainLookup",
  "TerrainType",
  // The wind and the crickets: `AreaTable.AmbienceID` names a row here and that row names two
  // `SoundEntries` kits, day and night. Written in this repository — see tools/dbd/README.md.
  "SoundAmbience",
  // What a weapon sounds like when it lands, misses, is parried or is blocked. `WeaponImpactSounds`
  // is keyed on the weapon's subclass and its own material, `WeaponSwingSounds2` on the swing size
  // `ItemSubClass` gives that subclass, and `Item` says which subclass and material an entry is.
  "WeaponImpactSounds",
  "WeaponSwingSounds2",
  "ItemSubClass",
  "Item",
  // The interface's own noises under the names the client's own Lua calls them, for the ones
  // `SoundEntries.Name` does not spell the same way.
  "UISoundLookups",

  // World: zones, sky, water.
  "AreaTable",
  "AreaPOI",
  "Light",
  "LightParams",
  "LightIntBand",
  "LightFloatBand",
  "LightSkybox",
  "LiquidType",
  // What grows on the ground. An ADT texture layer carries a `GroundEffectTexture` id; the row
  // names up to four `GroundEffectDoodad` models with their weights, how many of them a detail
  // cell gets, and the `TerrainType` a footstep on it plays. Both definitions were written in this
  // repository — see tools/dbd/README.md.
  "GroundEffectTexture",
  "GroundEffectDoodad",
  "WorldMapArea",
  "WorldMapContinent",
  "WorldMapOverlay",

  // Spells and talents.
  "SpellCastTimes",
  "SpellCategory",
  "SpellDuration",
  "SpellRadius",
  "SpellRange",
  "SpellDescriptionVariables",
  "SpellVisual",
  "SpellVisualEffectName",
  "SpellVisualKit",
  "Talent",
  "TalentTab",
  "SkillLine",
  "SkillLineAbility",

  // What it takes to open a chest, an ore vein, a herb or a locked door. The server computes the
  // spell itself and accepts it even from a player who does not know it, but only if the client
  // sends exactly that one — so the client has to work it out the same way, from here.
  "Lock",

  // Items, factions, emotes.
  "Faction",
  "FactionTemplate",
  "GemProperties",
  "ItemSet",
  "Emotes",
  "EmotesText",
  // EmotesTextData holds the sentences themselves; EmotesText only holds row ids into it. See
  // the local-addition note in tools/dbd/README.md.
  "EmotesTextData",
  "LFGDungeons",

  // Lifts and trams. The server never moves a GAMEOBJECT_TYPE_TRANSPORT — its relocation code is
  // commented out — so the path is the client's to walk, and these two tables are the path.
  "TransportAnimation",
  "TransportRotation",
];
