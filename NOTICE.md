# Third-party notices

The root [MIT license](LICENSE) covers only original TSWoW WebClient source unless a file,
generated artifact or directory says otherwise. It does not grant rights in third-party inputs or
their protected expression.

This repository is published for education and interoperability research. That purpose does not
grant permission to redistribute third-party game files, so client-derived inputs and outputs are
kept outside the tracked source tree.

## Locally generated interoperability data

The tracked modules `src/generated/animations.ts`, `src/generated/classIcons.ts` and
`src/generated/globalStrings.ts` are data-free facades. Their implementations are generated from a
user-supplied World of Warcraft 3.3.5a client or TSWoW dataset, plus matching TrinityCore sources,
into the Git-ignored directory `src/generated/client-data/`:

- animation and emote data from `AnimationData.dbc` and `Emotes.dbc`;
- class-icon coordinates from `Interface/FrameXML/Constants.lua`;
- localized UI text from `Interface/FrameXML/GlobalStrings.lua`.

The tracked modules `src/generated/opcodes.ts`, `src/generated/updateFields.ts` and
`src/generated/opcodeCoverage.ts` are also data-free facades. `tools/generate-protocol.mjs` creates
their implementations from the user's matching TSWoW/TrinityCore checkout in the Git-ignored
directory `src/generated/protocol-data/`.

A configured build regenerates protocol metadata from `TRINITYCORE_DIR`. When client-derived tables
are missing, it creates neutral build-only stubs containing no generated client tables or localized
content. Those stubs let CI compile the source but are rejected by the gateway for gameplay.
Operators must create the real ignored implementations from their own configured files with
`npm run client-data:generate`.

Neither the original inputs nor the locally generated implementations may be committed to this
repository. All rights in World of Warcraft content remain with their respective owners. This notice
is not a claim of ownership or a grant of rights in World of Warcraft content.

## Distribution boundary

Only the tracked source tree is prepared for redistribution, with each component retaining the
terms identified here. A data-equipped local build can bundle locally generated client tables into
`dist/web`; other generated caches may also contain transformed client assets. `dist/` is therefore
ignored, marked as local-only during the build and is not a distributable or publicly hostable
artifact of this educational release. Do not publish it without independently obtaining and
reconciling every applicable right and license.

## Locally generated TrinityCore protocol metadata

No TrinityCore source file or generated protocol table is tracked in this repository. The original
MIT-licensed generator reads the user's configured TSWoW/TrinityCore protocol headers and writes the
ignored local implementations described above. Source hashes are embedded so the output can be
checked against that exact checkout.

The referenced 3.3.5 branch is licensed under GNU GPL version 2 or later. To the extent a user's
locally generated output is derivative rather than uncopyrightable interface facts, it retains the
applicable upstream terms and is outside this source release's MIT grant and distribution boundary.

- Upstream project: https://github.com/TrinityCore/TrinityCore
- Upstream license text for reference: [`LICENSES/TRINITYCORE-GPL-2.0.txt`](LICENSES/TRINITYCORE-GPL-2.0.txt)
- License reference: https://www.gnu.org/licenses/old-licenses/gpl-2.0.html

## WoWDBDefs definitions

The `.dbd` definitions under `tools/dbd/` originate from
[WoWDBDefs](https://github.com/wowdev/WoWDBDefs), maintained by the WoWDev community.

- Definitions: Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0).
- Upstream project: https://github.com/wowdev/WoWDBDefs
- License: https://creativecommons.org/licenses/by-sa/4.0/

Local corrections and additions are documented in `tools/dbd/README.md`. Generated layout data in
`src/generated/dbcLayouts.ts` is derived from these definitions and should be treated under the
same CC BY-SA 4.0 terms where the definition content is reproduced.

## Wowee reference implementation

Parts of the rendering and interaction behavior were studied against, or adapted from, the Wowee
reference client. For a conservative educational release, the Wowee-influenced portions of the
following files are excluded from this project's root MIT grant and retain the applicable upstream
notice, including its restriction on use in a commercial game product:

- `src/browser/AnimatedModel.ts`, `Attachment.ts`, `GroundCover.ts`, `LightingQuality.ts`,
  `ModelBuild.ts`, `WorldLighting.ts`;
- `src/browser/game/CameraRig.ts`;
- `src/browser/ui/ItemTooltip.ts`, `Minimap.ts`, `SettingsModel.ts`, `Widgets.ts`, and the related
  declarations in `src/browser/style.css`;
- tests that directly encode the corresponding Wowee-derived behavior.

- Upstream project: https://github.com/Kelsidavis/WoWee
- Audited reference revision: `b09556c6b61a17b87b010d2b927deeb345278da8`
- That audited revision postdates and is subject to the included restricted license.
- Upstream license change introducing the commercial-game restriction:
  https://github.com/Kelsidavis/WoWee/commit/146196decbee417bdc2cf540b222ca17f10d4a23
- Included license text: [`LICENSES/WOWEE.txt`](LICENSES/WOWEE.txt)

No Wowee music, audio or other binary asset is included in this repository.

## Runtime dependencies

Third-party npm packages retain their own licenses. Their versions and license metadata are listed
by `package-lock.json` and the packages installed by `npm ci`.

## Game data and trademarks

This repository does not include World of Warcraft client files, MPQ archives, DBC or SQL dumps,
FrameXML or generated localized-string tables, extracted binary textures/models/sounds, locally
generated client or TrinityCore protocol tables, or runtime caches. Users must supply their own
legally obtained original client files and matching development inputs.

World of Warcraft and Blizzard Entertainment are trademarks of Blizzard Entertainment, Inc. This
project is not affiliated with or endorsed by Blizzard Entertainment, TrinityCore or TSWoW.
