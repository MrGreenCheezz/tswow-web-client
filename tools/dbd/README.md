# Vendored DBC definitions

The `.dbd` files in this directory are **not** part of this project. They come from
[WoWDBDefs](https://github.com/wowdev/WoWDBDefs) and describe the on-disk layout of World of
Warcraft's client databases for every build, including 3.3.5.12340.

**Licence: [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).** The WoWDBDefs
repository licenses its *code* under BSD-3-Clause but its *definitions* — these files and
anything derived from them — under CC BY-SA 4.0. That is a share-alike obligation, which is why
they are kept in their own directory rather than mixed into `src/`, and why they are copied
verbatim rather than rewritten into source.

Attribution: definitions by the WoWDev community, https://github.com/wowdev/WoWDBDefs

## Why they are here

Field offsets used to be integer literals spread across eleven hand-rolled parsers —
`value(spells, row, 144)`, with nothing in the tree saying what 144 was. The numbers were right;
they had no provenance and no way to check them. `tools/dbd.mjs` reads these definitions,
`tools/dbc.mjs` reads a table through the resulting layout, and `tests/dbc.test.mjs` asserts that
every definition agrees with the real `.dbc` header in the dataset. 3.3.5 is a fixed target, so
that check is decisive: a definition either matches the bytes on disk or it is wrong.

## Updating

```
node tools/fetch-dbd.mjs
```

Reads the list in `tools/dbd-tables.mjs` and refreshes this directory. Nothing in the build or
the test suite touches the network. Add a table to that list before fetching it — every file
here is one more thing to carry and to attribute.

Two tables worth knowing about: `CharComponentTextureSections` and `CharComponentTextureLayouts`
exist upstream but start at build 3.4.1, the Classic re-release. In original 3.3.5 the character
texture atlas rectangles are fixed in the client, so there is no table to read them from.

## Local addition: EmotesTextData

`EmotesTextData.dbd` here is **not** a copy of anything: it was written in this repository, from
the file's own WDBC header, because fetching the upstream definition needs the network and the
emote sentences were wanted offline. The table is as small as a table gets — an id and one
localised string — and `tests/dbc.test.mjs` checks it against the real file, which for a fixed
build is decisive: 18 fields of 72 bytes is `int ID` plus one `locstring`, and nothing else fits.

`node tools/fetch-dbd.mjs` will replace it with the upstream version, which is the same two
columns. Nothing here depends on which of the two is on disk.

## Local addition: EmotesTextSound

`EmotesTextSound.dbd` is the fixed WotLK client-media overlay used by the web client. It is kept
separate from the dataset-owned `EmotesText` and `EmotesTextData`: the extractor reads this table
from the active client archive chain so a visual/audio patch can add source race/sex variants
without changing gameplay metadata. Its WDBC header is five 32-bit fields — `ID`, `EmotesTextID`,
`RaceID`, `SexID` and `SoundID` — and `tests/dbc.test.mjs` validates that exact layout against the
real file. The definition follows the WoWDBDefs field names and the TrinityCore 3.3.5 schema; it
is vendored locally so extraction and tests remain offline.

## Local addition: SpellVisualKitModelAttach

`SpellVisualKitModelAttach.dbd` is the 3.3.5 client-visual table used to attach an effect model to
a spell-visual kit with an attachment point and authored transform. It is a local fixed-build
definition, written from the active WDBC header and the TrinityCore/WotLK field contract rather
than silently treating this visual table as gameplay metadata. The header is exactly ten
32-bit values (40 bytes): `ID`, `ParentSpellVisualKitID`, `SpellVisualEffectNameID`, `AttachmentID`,
three offsets and `Yaw`/`Pitch`/`Roll`. `tests/dbc.test.mjs` validates the live header and
`tests/spell-visual.test.mjs` exercises the parent/effect/transform mapping.

## Local addition: SpellCategory

`SpellCategory.dbd` is a two-field fixed-layout definition written here for the WotLK dataset:
`int ID` and `int Flags`, 262 rows of 8-byte records. The category flag bit `0x04` is part of the
server's `IsCooldownStartedOnEvent` rule, alongside the spell attribute bit; the gateway reads it
so action-bar cooldowns wait for the authoritative `SMSG_COOLDOWN_EVENT` when the category carries
that behavior. The fixed-build WDBC header establishes this two-word layout, and the spell
metadata fixture covers the boolean formula alongside the attribute source. This is a local
addition because the gateway only needs this small side table and fetching the upstream definition
would require network access.

## Local addition: SpellVisualEffectName

Written here for the same reason as `EmotesTextData`: fetching the upstream definition needs the
network, and slice R2 needs the table offline. It is the row that turns a spell visual into a
model path, and the header settles it — 7 fields of 28 bytes, of which two are string offsets that
resolve to readable text. Nothing else fits: `int ID`, `string Name`, `string FileName`, and four
floats.

Read through it, row 1 is `SeedOfCorruption_State` pointing at `Spells\SeedOfCorruption_State.mdx`
with scale 1 and an allowed range of 0.01 to 100. 3,844 of the 3,965 rows name a `.mdx` file; the
extension is the client's, and the file on disk is `.m2` — `Spells\SeedOfCorruption_State.mdx` is
absent from the archives and `Spells\SeedOfCorruption_State.m2` is 5,440 bytes of MD20. The
remaining 110 are `.mdl` rows named `zzOLD__`, and none of those files exists at all.

`node tools/fetch-dbd.mjs` will replace it with the upstream version, which is the same seven
columns. `tests/dbc.test.mjs` checks it against the real file either way.

## Local addition: GroundEffectTexture and GroundEffectDoodad

Written here for the same reason as the two above: the ground-cover slice needs both offline and
fetching them needs the network. They are the pair that says what grows on a patch of ground — an
ADT texture layer carries a `GroundEffectTexture` id, and the row names up to four
`GroundEffectDoodad` models with the weights they are drawn in, how many of them a detail cell
gets, and the `TerrainType` a footstep on that ground plays.

The headers settle both. `GroundEffectTexture` is 11 fields of 44 bytes, which is `int ID` plus
four doodad ids, four weights, a density and a sound — nothing else fits eleven words, and read
that way the four ids resolve to 496 of `GroundEffectDoodad`'s 580 rows with **0 dangling
references**, while the last field's histogram is exactly `0..11`, which is `TerrainType`'s twelve
ids. `GroundEffectDoodad` is 3 fields of 12 bytes: an id, a string offset that resolves to a bare
model name — 0 of its 567 distinct names carries a directory separator — and a small flag word,
`0` on 550 rows and `1` on 30.

`node tools/fetch-dbd.mjs` will replace both with the upstream versions, which name the same
columns. `tests/dbc.test.mjs` checks either against the real file.

## Local correction: LightParams

Upstream's 3.0.1–3.3.5 block for `LightParams` omits `CloudTypeID` and ends with a `Flags` that
this build does not have. Both errors are the same error: every float in the row is read one word
early, so `Glow` comes back as whatever `CloudTypeID` holds — zero on every row — and the four
water alphas each take their neighbour's value.

Measured on the live dataset: `LightParams` is 9 words of 36 bytes, and row 12 reads
`12, 1, 0, 0, 0.65, 0.50, 1.00, 0.75, 1.00`. Those last five are Glow and the four alphas, which
only line up once `CloudTypeID` is inserted after `LightSkyboxID` and the trailing `Flags` is gone.

`node tools/fetch-dbd.mjs` will silently put the upstream version back. `tests/dbc.test.mjs`
asserts the five values above, so if that happens the suite says so instead of the sky quietly
losing its glow.

## Local additions: the six tables combat and ambient sound are read from

`SoundAmbience`, `WeaponImpactSounds`, `WeaponSwingSounds2`, `ItemSubClass`, `Item` and
`UISoundLookups` were written here for the same reason as `EmotesTextData`: fetching them needs the
network, and slice Н1а needs them offline. Every one is checked against the real header by
`tests/dbc.test.mjs`, and for a fixed build that is decisive — measured on this dataset,
`SoundAmbience` is 3 fields of 12 bytes, `WeaponImpactSounds` 23 of 92, `WeaponSwingSounds2` 4 of
16, `ItemSubClass` 44 of 176, `Item` 8 of 32 and `UISoundLookups` 3 of 12.

**The column names are upstream's, on purpose.** `node tools/fetch-dbd.mjs` will replace all six,
and a replacement that renames a column the gateway reads would turn a working route into a startup
error. They were taken from tswow's own generated table classes
(`source/tswow-scripts/wotlk/dbc/*.ts` in a TSWoW checkout), which are generated from WoWDBDefs and agree
name for name with the definitions already vendored here — `CreatureSoundData`'s thirty-eight
getters match `CreatureSoundData.dbd` exactly, and the only systematic difference is that tswow
drops the `_lang` suffix upstream puts on a localised string.

Two names are worth stating because neither is what it looks like:

* `WeaponImpactSounds.ParrySoundType` is upstream's name for field 2, and the name undersells it.
  Measured over all thirty rows it is the **weapon's own material** — 0 wood, 1 metal — and it
  selects the whole row, not only its parry slots: subclass 4 with a 0 gives `Mace1H_*` and with a 1
  gives `Mace1HMetal_*`. Matched against `Item.Material == 1` it agrees on 5,756 of the 6,020 melee
  weapons that have a row at all; the 264 that disagree are all in the four subclasses that ship a
  single row (Bow, Gun, Exotic, Exotic2). The gateway therefore publishes it as `metal`, and the
  name of the column it came out of is here rather than in the payload.
* `ItemSubClass` has no `$id$` at all. Its key is the pair `ClassID, SubClassID` — tswow's class
  marks both as key cells — so `Dbc.id()` and `Dbc.rowOf()` do not work on it and nothing calls
  them; it is read by walking the rows.

## Local addition: CharStartOutfit

`CharStartOutfit.dbd` was written here for the same reason as the tables above: fetching it needs
the network, and the character-creation slice needs it offline. It says what a newly created
character of a given race, class and sex is wearing, which is what the creation screen's 3D preview
puts on the figure.

The header settles the layout and admits no other reading. Measured on this dataset — and on
`F:/CircleClean`, where the table resolves out of tswow's own `patch-ruRU-A.MPQ` to the same 37,317
bytes — it is **126 records, 77 fields, 296 bytes a record**. `int ID` plus four `u8` keys plus
three `int[24]` arrays is `4 + 4 + 96 + 96 + 96 = 296` bytes and `1 + 4 + 72 = 77` fields; nothing
else fits both numbers. The values agree with known reality: the dwarf rogue (row 288) reads Worn
Dagger `2092`/display `6442` at INVTYPE_WEAPON, a second at INVTYPE_WEAPONOFFHAND, shirt, trousers
and boots at 4/7/8, throwing axes at INVTYPE_THROWN and a Hearthstone at inventory type 0, which is
the stock 3.3.5 kit slot for slot.

**The keys are `u8` and not `<8>`.** Upstream spells `CharBaseInfo`'s pair as signed bytes and this
repository already has to mask them (`CharacterCreation.ts` does `& 0xff`), because tswow allocates
race ids upwards from 22 and a dataset can reach past 127. Read unsigned here, such a row is
addressable without a mask anywhere.

`node tools/fetch-dbd.mjs` will replace this with the upstream version, which names the same
columns; `tests/dbc.test.mjs` checks either against the real header.

## Local addition: SkillLineCategory

`SkillLineCategory.dbd` is a fixed-build definition written here because this table is not among
the vendored WoWDBDefs files. It is the source for the stock skills-window headings: `SkillLine`
stores a `CategoryID`, while this table supplies the localized `Name_lang` and the explicit
`SortIndex` used by the 3.3.5 client. The active WDBC header is 8 records of 19 fields and 76-byte
records, which is exactly `int ID`, one 17-slot localized string, and `int SortIndex`; the sort
field is read from the DBC rather than inferred from category ids or a web-client order.

The shipped Russian rows are ids 5–12 (`Характеристики`, `Оружейные навыки`, `Классовые навыки`,
`Доспехи`, `Вспомогательные навыки`, `Языки`, `Профессии`, `Не отображается`) with sort indices
1–8. `Not Displayed` is intentionally delivered as metadata too: the stock UI decides whether to
hide it, while consumers must not silently reinterpret it as a visible category. The gateway
publishes these rows alongside `skillLines`, and `TalentClient` exposes a monotonic revision so a
window can repaint when the initially unavailable snapshot arrives.

## Local additions: TaxiNodes and TaxiPath

These two fixed WotLK definitions let the native flight-master window use the same authored graph
as the client and server. `SMSG_SHOWTAXINODES` only carries the current node plus a discovered-node
bitmask: it does not say that every discovered destination is one direct flight away. `TaxiPath`
provides those directed edges and their costs, while `TaxiNodes` supplies localized names.

The active WDBC headers are decisive: `TaxiNodes` is 24 fields/96 bytes (`ID`, `ContinentID`, three
position floats, one 17-slot localized name and two mount-creature ids); `TaxiPath` is four
32-bit fields/16 bytes (`ID`, from, to and cost). `tests/dbc.test.mjs` checks both layouts against
the live 3.3.5 dataset.

## Local addition: LockType

Written here for the same reason as the tables above (05.10, plan item 5.17): the hover cursor over a
locked game object is the CursorName of the lock's first LockType (Wow.exe 0x0070F9B0), and a
dataset may add lock types of its own, so the gateway's `/dbc/locks` carries the column. The header
settles it: 22 records of 53 fields and 212 bytes, which is `int ID`, three 17-slot localised
strings and one string — nothing else fits 53 words. Read that way, the first string is the type's
name («Взлом замков», «Травничество», «Горное дело» …) and the last is a cursor file name: `PickLock`
for 1, `GatherHerbs` for 2, `Mine` for 3, `FishingCursor` for 19, `Mine` for the dataset's own
1000, empty for the rest. TrinityCore does not load this table. Column names follow WoWDBDefs'
spelling as far as this repository knows it; `tests/dbc.test.mjs` checks the layout against the
real file, and `node tools/fetch-dbd.mjs` may replace it with the upstream version.

## Local addition: LiquidMaterial

Written here (05.10, plan item 7.09, marker 05.10-A7b-5) because the gateway's `/dbc/liquid-types?v=2`
names each liquid's vertex format. The dataset's file is 57 bytes: 3 records of 3 fields and 12
bytes, a one-byte string block — `int ID` and two integers. Read in WoWDBDefs' order (`LVF`, then
`Flags`), row 1 is format 0 with flag 1, row 2 format 1 with flag 0 and row 3 format 0 with flag 1;
`LiquidType` points Water/Ocean at 1, Magma/Slime at 2 (whose map chunks carry height and UV,
format 1) and «Basic Procedural Water» at 3, which agrees. TrinityCore does not load this table.
`tests/dbc.test.mjs` checks the layout against the real file, and `node tools/fetch-dbd.mjs` may
replace it with the upstream version.
