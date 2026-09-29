import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  AUDIO_DBC_FILES, CLIENT_MEDIA_PROFILE_FILE, VISUAL_DBC_FILES, selectClientMediaOverlay,
} from "../dist/code/gateway/ClientMediaOverlay.js";
import {
  CLIENT_MEDIA_DBC_TABLES, PLAYABLE_CHARACTER_PROFILES, extractClientMediaDbcs,
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
    await writeFile(join(patch, definition.skinPath), skinBytes(
      profile(definition) === "coordinated" ? [0, ...definition.requiredGeosets] : [0],
    ));
  }
}

test("automatic media generations follow coordinated and classic client switches", async () => {
  const root = await mkdtemp(join(tmpdir(), "webclient-media-overlay-switch-"));
  const client = join(root, "client");
  const output = join(root, "visual-dbc");
  try {
    await writePack(client, "patch-ruRU-G.MPQ", "HD", () => "coordinated");
    const hdGeneration = await extractClientMediaDbcs({ clientDirectory: client, outputDirectory: output });
    const selected = await selectClientMediaOverlay({
      candidate: hdGeneration,
      explicit: false,
      clientDirectory: client,
    });
    assert.equal(selected.visualDbcDirectory, hdGeneration);
    assert.equal(selected.audioDbcDirectory, hdGeneration);
    assert.equal(selected.coordinatedVisuals, true,
      "structural profile enables the policy under a localized arbitrary letter");

    await rm(join(client, "Data", "patch-ruRU-G.MPQ"), { recursive: true, force: true });
    await writePack(client, "patch-3.MPQ", "CLASSIC");
    const reports = [];
    assert.deepEqual(await selectClientMediaOverlay({
      candidate: hdGeneration,
      explicit: false,
      clientDirectory: client,
      report: (message) => reports.push(message),
    }), {});
    assert.ok(reports.some((message) => /stale visual DBCs or media profile/i.test(message)));
    assert.equal(await readFile(join(hdGeneration, "CreatureModelData.dbc"), "utf8"),
      "HD:CreatureModelData", "selection leaves the old immutable generation intact");

    const explicit = await selectClientMediaOverlay({ candidate: hdGeneration, explicit: true });
    assert.equal(explicit.coordinatedVisuals, true,
      "an explicit pre-extracted deployment trusts its schema-2 structural profile");

    const classicGeneration = await extractClientMediaDbcs({ clientDirectory: client, outputDirectory: output });
    const classic = await selectClientMediaOverlay({
      candidate: classicGeneration,
      explicit: false,
      clientDirectory: client,
    });
    assert.equal(classic.visualDbcDirectory, classicGeneration);
    assert.equal(classic.audioDbcDirectory, classicGeneration);
    assert.equal(classic.coordinatedVisuals, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("classic generation is rejected after a coordinated pack becomes active", async () => {
  const root = await mkdtemp(join(tmpdir(), "webclient-media-classic-to-hd-"));
  const client = join(root, "client");
  const output = join(root, "visual-dbc");
  try {
    await writePack(client, "patch-3.MPQ", "CLASSIC");
    const classicGeneration = await extractClientMediaDbcs({ clientDirectory: client, outputDirectory: output });
    await writePack(client, "patch-F.MPQ", "HD", () => "coordinated");
    await assert.rejects(
      selectClientMediaOverlay({
        candidate: classicGeneration,
        explicit: false,
        clientDirectory: client,
      }),
      /coordinated extended-geoset visual profile.*does not match/is,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("coordinated pack without an extracted generation fails closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "webclient-media-missing-"));
  const client = join(root, "client");
  try {
    await writePack(client, "patch-A.MPQ", "HD", () => "coordinated");
    await assert.rejects(
      selectClientMediaOverlay({
        candidate: join(root, "missing-overlay"),
        explicit: false,
        clientDirectory: client,
      }),
      /coordinated extended-geoset visual profile.*structural profile/is,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mixed playable model profiles are rejected before overlay selection", async () => {
  for (const [name, profile] of [
    ["one", (definition) => definition.name === "HumanMale" ? "coordinated" : "classic"],
    ["two", (definition) => ["HumanMale", "HumanFemale"].includes(definition.name)
      ? "coordinated" : "classic"],
    ["classic-inside-hd", (definition) => definition.name === "NightElfMale"
      ? "classic" : "coordinated"],
  ]) {
    const root = await mkdtemp(join(tmpdir(), `webclient-media-mixed-${name}-`));
    try {
      const client = join(root, "client");
      await writePack(client, "patch-Z.MPQ", name, profile);
      await assert.rejects(
        selectClientMediaOverlay({
          candidate: join(root, "missing-overlay"),
          explicit: false,
          clientDirectory: client,
        }),
        /mix incompatible classic and extended playable model profiles/i,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("model-only publish makes the profile stale even when all nine DBCs are unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "webclient-media-profile-stale-"));
  const client = join(root, "client");
  const output = join(root, "visual-dbc");
  try {
    await writePack(client, "patch-D.MPQ", "CLASSIC");
    const generation = await extractClientMediaDbcs({ clientDirectory: client, outputDirectory: output });
    const human = PLAYABLE_CHARACTER_PROFILES[0];
    await writeFile(join(client, "Data", "patch-D.MPQ", human.modelPath), modelBytes("NEW-MODEL"));
    const reports = [];
    const selected = await selectClientMediaOverlay({
      candidate: generation,
      explicit: false,
      clientDirectory: client,
      report: (message) => reports.push(message),
    });
    assert.equal(selected.visualDbcDirectory, undefined);
    assert.equal(selected.audioDbcDirectory, generation,
      "a model-only change does not stale the independently stamped audio lookup");
    assert.ok(reports.some((message) => /media profile/i.test(message)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("automatic selection fails closed on malformed DBC and profile provenance", async () => {
  const root = await mkdtemp(join(tmpdir(), "webclient-media-malformed-"));
  const client = join(root, "client");
  const overlay = join(root, "overlay");
  try {
    await writePack(client, "patch-3.MPQ", "CLASSIC");
    await mkdir(overlay, { recursive: true });
    for (const file of [...VISUAL_DBC_FILES, ...AUDIO_DBC_FILES]) {
      await writeFile(join(overlay, file), file);
      await writeFile(`${join(overlay, file)}.src`, JSON.stringify({
        chain: "malformed", sources: [null], files: [],
      }));
    }
    await writeFile(join(overlay, CLIENT_MEDIA_PROFILE_FILE), JSON.stringify({
      schema: 2, compatibility: "classic", coordinatedVisuals: false,
    }));
    await writeFile(`${join(overlay, CLIENT_MEDIA_PROFILE_FILE)}.src`, "not-json");
    assert.deepEqual(await selectClientMediaOverlay({
      candidate: overlay,
      explicit: false,
      clientDirectory: client,
    }), {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
