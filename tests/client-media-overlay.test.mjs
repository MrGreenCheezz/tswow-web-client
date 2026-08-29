import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AUDIO_DBC_FILES, VISUAL_DBC_FILES, selectClientMediaOverlay,
} from "../dist/code/gateway/ClientMediaOverlay.js";
import { openClientArchives } from "../tools/mpq.mjs";
import { sourceStamp, writeSourceStamp } from "../tools/source-stamp.mjs";

const ALL_DBC_FILES = [...VISUAL_DBC_FILES, ...AUDIO_DBC_FILES];

async function writePack(client, name, generation) {
  const directory = join(client, "Data", name, "DBFilesClient");
  await mkdir(directory, { recursive: true });
  for (const file of ALL_DBC_FILES) await writeFile(join(directory, file), `${generation}:${file}`);
}

async function extractStamped(client, destination) {
  await mkdir(destination, { recursive: true });
  const chain = await openClientArchives(client);
  try {
    for (const file of ALL_DBC_FILES) {
      const path = `DBFilesClient\\${file}`;
      const payload = await chain.read(path);
      assert.ok(payload, `${path} exists in the synthetic visual pack`);
      const output = join(destination, file);
      await writeFile(output, payload);
      await writeSourceStamp(output, await sourceStamp(chain, { paths: [path] }));
    }
  } finally {
    chain.close();
  }
}

test("automatic client-media DBCs fail closed after an HD to classic switch", async () => {
  const client = await mkdtemp(join(tmpdir(), "webclient-media-client-"));
  const overlay = await mkdtemp(join(tmpdir(), "webclient-media-overlay-"));
  try {
    await writePack(client, "patch-W.MPQ", "HD");
    await extractStamped(client, overlay);

    const selected = await selectClientMediaOverlay({
      candidate: overlay,
      explicit: false,
      clientDirectory: client,
    });
    assert.equal(selected.visualDbcDirectory, overlay);
    assert.equal(selected.audioDbcDirectory, overlay);
    assert.equal(selected.coordinatedVisuals, true,
      "patch-W provenance opts into the matching model-specific geoset policy");

    // The operator removes the HD pack but deliberately leaves the ignored extracted directory.
    // Classic tables now win the same paths from the ordinary numeric patch chain.
    await rm(join(client, "Data", "patch-W.MPQ"), { recursive: true, force: true });
    await writePack(client, "patch-3.MPQ", "CLASSIC");
    const reports = [];
    const fallback = await selectClientMediaOverlay({
      candidate: overlay,
      explicit: false,
      clientDirectory: client,
      report: (message) => reports.push(message),
    });
    assert.deepEqual(fallback, {}, "stale HD rows must not be paired with classic model archives");
    assert.ok(reports.some((message) => /stale visual DBCs/i.test(message)));
    assert.equal(await readFile(join(overlay, "CreatureModelData.dbc"), "utf8"),
      "HD:CreatureModelData.dbc", "selection is fail-closed and does not destroy the extracted pack");

    // Explicit configuration remains available for a pre-extracted deployment without CLIENT_DIR.
    const explicit = await selectClientMediaOverlay({ candidate: overlay, explicit: true });
    assert.equal(explicit.visualDbcDirectory, overlay);
    assert.equal(explicit.audioDbcDirectory, overlay);
    assert.equal(explicit.coordinatedVisuals, true,
      "the explicit stale HD override retains its positively stamped profile");

    await extractStamped(client, overlay);
    const classic = await selectClientMediaOverlay({
      candidate: overlay,
      explicit: false,
      clientDirectory: client,
    });
    assert.equal(classic.visualDbcDirectory, overlay);
    assert.equal(classic.audioDbcDirectory, overlay);
    assert.equal(classic.coordinatedVisuals, undefined,
      "a freshly extracted classic overlay remains free of patch-W-only geoset policy");
  } finally {
    await rm(client, { recursive: true, force: true });
    await rm(overlay, { recursive: true, force: true });
  }
});

test("automatic client-media DBCs fail closed when the client archive chain cannot be read", async () => {
  const root = await mkdtemp(join(tmpdir(), "webclient-overlay-unreadable-"));
  const overlay = join(root, "visual-dbc");
  const missingClient = join(root, "missing-client");
  await mkdir(overlay, { recursive: true });
  for (const file of [...VISUAL_DBC_FILES, ...AUDIO_DBC_FILES]) {
    await writeFile(join(overlay, file), file);
    await writeFile(`${join(overlay, file)}.src`, JSON.stringify({
      chain: "unverifiable",
      sources: [],
      files: [],
    }));
  }

  const warnings = [];
  try {
    assert.deepEqual(await selectClientMediaOverlay({
      candidate: overlay,
      explicit: false,
      clientDirectory: missingClient,
      report: (message) => warnings.push(message),
    }), {});
    assert.ok(warnings.some((message) => message.includes("nothing is being watched")));
    assert.ok(warnings.some((message) => message.includes("Not using stale visual DBCs")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("automatic client-media DBCs fail closed on malformed provenance records", async () => {
  const root = await mkdtemp(join(tmpdir(), "webclient-overlay-malformed-"));
  const client = join(root, "client");
  const overlay = join(root, "visual-dbc");
  await writePack(client, "patch-W.MPQ", "HD");
  await mkdir(overlay, { recursive: true });
  for (const file of ALL_DBC_FILES) {
    await writeFile(join(overlay, file), file);
    await writeFile(`${join(overlay, file)}.src`, JSON.stringify({
      chain: "syntactically-present",
      sources: [null],
      files: [],
    }));
  }

  try {
    await assert.doesNotReject(async () => {
      assert.deepEqual(await selectClientMediaOverlay({
        candidate: overlay,
        explicit: false,
        clientDirectory: client,
      }), {});
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
