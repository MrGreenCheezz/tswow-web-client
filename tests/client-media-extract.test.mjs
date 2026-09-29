import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  CLIENT_MEDIA_DBC_TABLES, CLIENT_MEDIA_PROFILE_FILE, CLIENT_MEDIA_PROFILE_PATHS,
  PLAYABLE_CHARACTER_PROFILES, extractClientMediaDbcs,
} from "../tools/extract-visual-dbc-overlay.mjs";

function modelBytes(marker = "") {
  const model = Buffer.alloc(0x140);
  model.write("MD20", 0, "ascii");
  model.writeUInt32LE(264, 4);
  model.write(marker.slice(0, 16), 0x130, "ascii");
  return model;
}

function skinBytes(geosets) {
  const skin = Buffer.alloc(48 + geosets.length * 48);
  skin.write("SKIN", 0, "ascii");
  skin.writeUInt32LE(geosets.length, 0x1c);
  skin.writeUInt32LE(48, 0x20);
  for (const [index, geoset] of geosets.entries()) {
    const at = 48 + index * 48;
    skin.writeUInt16LE(geoset, at);
    skin.writeUInt16LE(3, at + 10);
  }
  return skin;
}

async function writePack(client, name, generation, profile = () => "classic") {
  const patch = join(client, "Data", name);
  const dbcDirectory = join(patch, "DBFilesClient");
  await mkdir(dbcDirectory, { recursive: true });
  for (const table of CLIENT_MEDIA_DBC_TABLES) {
    await writeFile(join(dbcDirectory, `${table}.dbc`), `${generation}:${table}`);
  }
  for (const definition of PLAYABLE_CHARACTER_PROFILES) {
    await mkdir(dirname(join(patch, definition.modelPath)), { recursive: true });
    await writeFile(join(patch, definition.modelPath), modelBytes(generation));
    const mode = profile(definition);
    const geosets = mode === "coordinated"
      ? [0, ...definition.requiredGeosets]
      : mode === "wrong-foot-variant"
        ? [0, ...definition.requiredGeosets.filter((geoset) => Math.floor(geoset / 100) !== 20), 2099]
        : [0];
    await writeFile(
      join(patch, definition.skinPath),
      skinBytes(geosets),
    );
  }
}

test("client-media sync follows complete classic and arbitrary-letter coordinated generations", async () => {
  const root = await mkdtemp(join(tmpdir(), "webclient-media-sync-"));
  const client = join(root, "client");
  const output = join(root, "visual-dbc");
  try {
    await writePack(client, "patch-3.MPQ", "CLASSIC");
    const classic = await extractClientMediaDbcs({ clientDirectory: client, outputDirectory: output });
    const classicProfile = JSON.parse(await readFile(join(classic, CLIENT_MEDIA_PROFILE_FILE), "utf8"));
    assert.equal(classicProfile.schema, 2);
    assert.equal(classicProfile.integrityScope, "playable-character-model-skin+client-media-dbc");
    assert.equal(classicProfile.compatibility, "classic");
    assert.equal(classicProfile.coordinatedVisuals, false);
    assert.equal(classicProfile.models.length, 20);
    assert.equal(classicProfile.tables.length, 9);
    const profileStamp = JSON.parse(
      await readFile(`${join(classic, CLIENT_MEDIA_PROFILE_FILE)}.src`, "utf8"),
    );
    assert.equal(profileStamp.sources.length, CLIENT_MEDIA_PROFILE_PATHS.length,
      "the profile sidecar covers all 40 model/skin and nine DBC winners");

    await writePack(client, "patch-ruRU-G.MPQ", "HD", () => "coordinated");
    const hd = await extractClientMediaDbcs({ clientDirectory: client, outputDirectory: output });
    assert.notEqual(hd, classic, "a different archive generation gets a new immutable directory");
    const hdProfile = JSON.parse(await readFile(join(hd, CLIENT_MEDIA_PROFILE_FILE), "utf8"));
    assert.equal(hdProfile.compatibility, "coordinated");
    assert.equal(hdProfile.coordinatedVisuals, true);
    assert.deepEqual(hdProfile.coordinatedEvidence, {
      observedExtendedFootProfiles: 10,
      matchedExtendedFootProfiles: 10,
      totalExtendedFootProfiles: 10,
    });
    assert.ok(hdProfile.models.every(({ modelSource, skinSource }) =>
      /^patch-ruru-g\.mpq$/i.test(modelSource) && /^patch-ruru-g\.mpq$/i.test(skinSource)),
    "locale patch provenance is recorded without assigning meaning to its letter");

    await rm(join(client, "Data", "patch-ruRU-G.MPQ"), { recursive: true, force: true });
    const classicAgain = await extractClientMediaDbcs({ clientDirectory: client, outputDirectory: output });
    assert.equal(classicAgain, classic, "returning to the unchanged chain reuses its generation");
    assert.equal(await readFile(join(classicAgain, "CharSections.dbc"), "utf8"),
      "CLASSIC:CharSections");

    await rm(join(client, "Data", "patch-3.MPQ", "DBFilesClient", "EmotesTextSound.dbc"));
    await assert.rejects(
      extractClientMediaDbcs({ clientDirectory: client, outputDirectory: output }),
      /EmotesTextSound\.dbc is missing/,
    );
    assert.equal(await readFile(join(classicAgain, "CharSections.dbc"), "utf8"),
      "CLASSIC:CharSections", "a failed extraction cannot alter a published generation");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("model-only changes participate in the immutable generation identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "webclient-media-model-stamp-"));
  const client = join(root, "client");
  const output = join(root, "visual-dbc");
  try {
    await writePack(client, "patch-C.MPQ", "CLASSIC");
    const before = await extractClientMediaDbcs({ clientDirectory: client, outputDirectory: output });
    const human = PLAYABLE_CHARACTER_PROFILES[0];
    await writeFile(join(client, "Data", "patch-C.MPQ", human.modelPath), modelBytes("MODEL-CHANGED"));
    const after = await extractClientMediaDbcs({ clientDirectory: client, outputDirectory: output });
    assert.notEqual(after, before,
      "unchanged DBC bytes cannot reuse a profile generated from different model bytes");
    assert.equal(await readFile(join(before, "CharSections.dbc"), "utf8"), "CLASSIC:CharSections");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one or two extended profiles inside classic and one classic inside HD fail closed", async () => {
  for (const [name, profile] of [
    ["one-extended", (definition) => definition.name === "HumanMale" ? "coordinated" : "classic"],
    ["two-extended", (definition) => ["HumanMale", "HumanFemale"].includes(definition.name)
      ? "coordinated" : "classic"],
    ["wrong-variant", (definition) => definition.name === "HumanMale"
      ? "wrong-foot-variant" : "classic"],
    ["one-classic", (definition) => definition.name === "NightElfMale" ? "classic" : "coordinated"],
  ]) {
    const root = await mkdtemp(join(tmpdir(), `webclient-media-${name}-`));
    try {
      const client = join(root, "client");
      await writePack(client, "patch-Q.MPQ", name, profile);
      await assert.rejects(
        extractClientMediaDbcs({ clientDirectory: client, outputDirectory: join(root, "out") }),
        /Unsupported client media profile:.*(?:extended-foot geometry is mixed|extended character geometry is incomplete)/i,
        `${name} must not silently select a global classic or extended policy`,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
