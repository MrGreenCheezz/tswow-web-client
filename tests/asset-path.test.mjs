import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { MAX_ASSET_PATH, validAssetPath } from "../dist/code/gateway/AssetPath.js";
import { validTexturePath } from "../tools/generate-texture.mjs";
import { repositoryRoot } from "../tools/paths.mjs";

test("one validator accepts what the client ships, in any script", () => {
  // Every character that is in this client's own filenames and was in one of the six classes but
  // not in the others: the ampersand of `WEAPONS&ARMOR`, the apostrophe of the Ghoul voice set,
  // the parentheses of the five PvP shoulder textures, and the space that is everywhere.
  assert.equal(validAssetPath("World\\Generic\\PASSIVE DOODADS\\FOOD&UTENSILS\\Plate_01.m2", { extensions: ["m2", "wmo"] }), true);
  assert.equal(validAssetPath("Sound\\Creature\\Ghoul\\mGhoulDeathA.wav", { extensions: ["wav", "mp3"] }), true);
  assert.equal(validAssetPath("Item\\TextureComponents\\Shoulder_Plate_B_01Gold(Left).blp", { extensions: ["blp"] }), true);
  assert.equal(validAssetPath("Interface\\Icons\\Achievement_Dungeon_Drak'Tharon_Normal.blp", { extensions: ["blp"] }), true);
  // Forward slashes, which only the model route used to allow: a caller that has not normalised
  // yet must not be told its path is malformed.
  assert.equal(validAssetPath("World/Generic/Tree.m2", { extensions: ["m2"] }), true);

  // The new half. tswow does not stop a module author from naming a file in their own language,
  // and it is their own patch directory the gateway reads it out of.
  assert.equal(validAssetPath("Модуль\\Иконки\\Огненный шар.blp", { extensions: ["blp"] }), true);
  assert.equal(validAssetPath("模组\\图标\\火球.blp", { extensions: ["blp"] }), true);
  // A combining mark is part of the letter in front of it, not a character of its own.
  assert.equal(validAssetPath("Module\\Ic\u0301ons\\Fire.blp", { extensions: ["blp"] }), true);
});

test("one validator still refuses everything the six refused", () => {
  // The traversal, which is the reason any of this exists. A patch directory is a real directory
  // on disk and `join` would happily walk out of it.
  assert.equal(validAssetPath("Interface\\..\\..\\..\\Windows\\System32\\config\\SAM", { extensions: ["blp"] }), false);
  assert.equal(validAssetPath("..\\secret.blp", { extensions: ["blp"] }), false);
  // A drive letter, and with it every other use of `:` — an NTFS stream name included.
  assert.equal(validAssetPath("C:\\Windows\\win.ini", {}), false);
  assert.equal(validAssetPath("Interface\\Icons\\Fire.blp:$DATA", { extensions: ["blp"] }), false);
  // An absolute path and a UNC host, which `:` alone does not catch.
  assert.equal(validAssetPath("\\Windows\\win.ini", {}), false);
  assert.equal(validAssetPath("\\\\server\\share\\Fire.blp", { extensions: ["blp"] }), false);
  assert.equal(validAssetPath("/etc/passwd", {}), false);
  // Control characters, including the ones that would truncate a path in a C API.
  assert.equal(validAssetPath("Interface\\Icons\\Fire\u0000.blp", { extensions: ["blp"] }), false);
  assert.equal(validAssetPath("Interface\\Icons\\Fire\n.blp", { extensions: ["blp"] }), false);
  // A Unicode format character is not a letter: an override that makes a name read backwards on
  // screen has no business in a path.
  assert.equal(validAssetPath("Interface\\Icons\\Fire\u202e.blp", { extensions: ["blp"] }), false);
  // The length cap.
  assert.equal(validAssetPath(`${"a".repeat(MAX_ASSET_PATH - 4)}.blp`, { extensions: ["blp"] }), true);
  assert.equal(validAssetPath(`${"a".repeat(MAX_ASSET_PATH - 3)}.blp`, { extensions: ["blp"] }), false);
  assert.equal(validAssetPath("", { extensions: ["blp"] }), false);
});

test("the extension is what one caller wants and another does not", () => {
  assert.equal(validAssetPath("World\\Tree.m2", { extensions: ["m2", "wmo"] }), true);
  assert.equal(validAssetPath("World\\Hut.wmo", { extensions: ["m2", "wmo"] }), true);
  assert.equal(validAssetPath("World\\Hut.wmo", { extensions: ["m2"] }), false);
  assert.equal(validAssetPath("Interface\\Icons\\Fire.blp", { extensions: ["m2", "wmo"] }), false);
  // A texture slot value carries no extension at all — slots 11 to 13 take a bare name resolved
  // beside the model — so no list means no gate.
  assert.equal(validAssetPath("Creature\\Rat\\RatSkinBrown", {}), true);
  assert.equal(validAssetPath("Creature\\Rat\\RatSkinBrown", { extensions: ["blp"] }), false);
  // An extension with nothing in front of it is not a filename, and all six classes required at
  // least one character there.
  assert.equal(validAssetPath(".blp", { extensions: ["blp"] }), false);
  assert.equal(validAssetPath("Interface\\Icons\\.blp", { extensions: ["blp"] }), true);
});

test("a component field carries one name, not a path", () => {
  // `CreatureDisplayInfo.TextureVariation` and `ItemDisplayInfo`'s three component fields hold a
  // bare name that the reader resolves beside something else, and `ModelBuild.resolveSlot` reads a
  // value with a separator in it as a full path instead — two different meanings, and only one of
  // them belongs in those fields. Measured: of 11,685 creature skins, 80,988 component textures,
  // 24,337 item model names and 25,482 model textures, not one holds a separator.
  assert.equal(validAssetPath("RatSkinBrown", { maxLength: 120, bareName: true }), true);
  assert.equal(validAssetPath("Creature\\Rat\\RatSkinBrown", { maxLength: 120, bareName: true }), false);
  assert.equal(validAssetPath("Creature/Rat/RatSkinBrown", { maxLength: 120, bareName: true }), false);
  // The three the client's own tables need, and the apostrophe is the one the ASCII class that
  // used to stand at `CreatureModelMetadata.ts:82` refused: `Creature\KelThuzad\Kel'Thuzad.blp` is
  // 350,724 bytes in `common.MPQ`, and there is no apostrophe-less copy of it anywhere.
  assert.equal(validAssetPath("Kel'Thuzad", { maxLength: 120, bareName: true }), true);
  assert.equal(validAssetPath("Shoulder_Plate_PVPAlliance_B_01Gold(Left) ", { maxLength: 120, bareName: true }), true);
  assert.equal(validAssetPath("Огненный_Волк", { maxLength: 120, bareName: true }), true);
  // And a bare name is still a name: no walking, no drive letter.
  assert.equal(validAssetPath("..", { maxLength: 120, bareName: true }), false);
  assert.equal(validAssetPath("C:Fire", { maxLength: 120, bareName: true }), false);
});

test("Ж0 the generators behind the routes accept exactly what the routes accept", async () => {
  // The validator Д6 never counted. Its review found "eight, not six" and looked only under
  // `src/`; `tools/generate-texture.mjs` held a ninth — `/^[A-Za-z0-9_ .&()\\-]{1,240}\.blp$/i`,
  // ASCII, no apostrophe, no forward slash, capped twenty characters short of the route's — and
  // `tools/generate-visual-model.mjs` a tenth on its own argv.
  //
  // The damage was not a 400. Д6 deliberately put the apostrophe *into* the route's class, so the
  // route accepted these paths, handed them to a generator that threw a plain `Error`, and a plain
  // error is exit 1, which is «the generator died», which is a 500 — and Т6's browser-side ladder
  // then retried each one three times. Measured against the archives on this machine: of 111,800
  // `.blp` paths, 111,767 pass both classes, 12 fail both, **0 pass the generator alone**, and 21
  // pass the route and were refused here — every one for an apostrophe. Eight boss skins, six
  // achievement icons, and seven world-map tiles for Eversong Woods, Ghostlands and Hellfire,
  // which `WorldMap.ts` fetches for a shipped feature. Live, before the fix:
  // `creature\KelThuzad\Kel'Thuzad.blp` answered 500 in 0.547 s; after, 200 with 308,941 bytes.
  const seeded = [
    "creature\\KelThuzad\\Kel'Thuzad.blp",
    "creature\\MalGanis\\Mal'GanisHair.blp",
    "creature\\Tigon\\Sha'keerSkinTan.blp",
    "Interface\\Icons\\Achievement_Boss_Kael'thasSunstrider_01.blp",
    "Interface\\Icons\\Achievement_Dungeon_Drak'Tharon_Heroic.blp",
    "Interface\\WorldMap\\Ghostlands\\Zeb'Nowa1.blp",
    "Interface\\WorldMap\\EversongWoods\\Tor'Watha2.blp",
    "Interface\\WorldMap\\Hellfire\\Mag'harPost1.blp",
    // Not an apostrophe: the two that only ever differed by the length cap and the alphabet.
    `Interface\\Icons\\${"A".repeat(240)}.blp`,
    "Модуль\\Иконки\\Огненный_шар.blp",
  ];
  for (const path of seeded) {
    assert.equal(validAssetPath(path, { extensions: ["blp"] }), true, `the route refuses ${path}`);
    assert.equal(validTexturePath(path), true, `the texture generator refuses ${path}`);
  }
  // And it is still a validator: the generator has to refuse what the route refuses, or a path
  // that never reached the route — `publishTexture` is called directly by three other tools — could
  // walk out of the published directory.
  for (const bad of ["..\\secret.blp", "C:\\Windows\\win.ini", "\\\\host\\share\\Fire.blp", "Interface\\Icons\\Fire.tga", ".blp"]) {
    assert.equal(validAssetPath(bad, { extensions: ["blp"] }), false, `the route accepts ${bad}`);
    assert.equal(validTexturePath(bad), false, `the texture generator accepts ${bad}`);
  }

  // Neither generator may grow a class of its own again. Both are spawned by the gateway with a
  // path the route has already validated, so a second opinion here can only ever be a narrower one.
  for (const name of ["generate-texture.mjs", "generate-visual-model.mjs"]) {
    const source = await readFile(join(repositoryRoot, "tools", name), "utf8");
    const offenders = source.split("\n")
      .map((line, index) => [line, index + 1])
      .filter(([line]) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .flatMap(([line, number]) => [...line.matchAll(/\[([^\]\n]*)\]/g)]
        .filter(([, characterClass]) => /A-Za-z|a-z|A-Z|\\p\{L\}/.test(characterClass))
        .map(([, characterClass]) => `${name}:${number}: [${characterClass}]`));
    assert.deepEqual(offenders, [],
      `these decide for themselves what a name may look like:\n  ${offenders.join("\n  ")}`);
  }
});

test("nothing under src/gateway decides for itself what a filename may look like", async () => {
  // The six had drifted apart character by character precisely because nothing could see them all
  // at once. This is what sees them — and the first shape of it, which asked only for a class with
  // a path separator in it, was too narrow to see the ninth: `CreatureDisplayInfo.TextureVariation`
  // was filtered by `[A-Za-z0-9_ .-]{1,120}` written out at `CreatureModelMetadata.ts:82`, which
  // holds no separator, is ASCII, and emptied slot 11 on the three displays that wear `Kel'Thuzad`
  // while the test that was meant to catch it passed.
  //
  // So the question is not "does this class hold a separator" but "did somebody widen this class
  // because they met a real filename": a space, an ampersand, a parenthesis or an apostrophe next
  // to a letter range is that and nothing else. `-`, `_` and `.` are left out on purpose — they
  // are in every identifier and in the `<hash>.wvm` names the environment routes match, and
  // flagging those would teach the next reader to widen the exception list instead of the caller.
  const directory = join(repositoryRoot, "src/gateway");
  const offenders = [];
  for (const name of await readdir(directory)) {
    if (!name.endsWith(".ts") || name === "AssetPath.ts") continue;
    const source = await readFile(join(directory, name), "utf8");
    const lines = source.split("\n");
    for (let index = 0; index < lines.length; index++) {
      // Prose quoting a class is prose: the comment above line 82 names the class it replaced.
      if (/^\s*(\*|\/\/|\/\*)/.test(lines[index])) continue;
      for (const [, characterClass] of lines[index].matchAll(/\[([^\]\n]*)\]/g)) {
        if (!/A-Za-z|a-z|A-Z|\\p\{L\}/.test(characterClass)) continue;
        // `\\` in the source is one backslash in the class, i.e. a path separator.
        if (!/\\\\|\\\/| |&|\(|'/.test(characterClass)) continue;
        offenders.push(`${name}:${index + 1}: [${characterClass}]`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    `these still decide for themselves what a name may look like:\n  ${offenders.join("\n  ")}`);
});
