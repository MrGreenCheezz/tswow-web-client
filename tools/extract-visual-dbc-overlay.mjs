// Extracts the client-side media tables that must stay paired with replacement M2/BLP/audio
// assets.
//
// The gateway deliberately keeps gameplay metadata on the TSWoW dataset. Visual tables are
// different: a model patch redirects stable display ids, changes character geosets and names baked
// textures that only exist in that patch. They live in a separate ignored directory so installing
// an art/audio pack never mutates the server's DBC build. EmotesTextSound is a client media lookup,
// not a gameplay allowlist: EmotesText and EmotesTextData remain dataset-owned.

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { clientArchives } from "./mpq.mjs";
import { clientDirectory, repositoryRoot } from "./paths.mjs";
import { sourceStamp, writeSourceStamp } from "./source-stamp.mjs";

export const VISUAL_DBC_TABLES = Object.freeze([
  "CharSections",
  "CharHairGeosets",
  "CharacterFacialHairStyles",
  "CreatureDisplayInfoExtra",
  "CreatureDisplayInfo",
  "CreatureModelData",
  "HelmetGeosetVisData",
  "SpellVisualKitModelAttach",
]);

/** Client-only audio lookups, kept explicit so they cannot be mistaken for server gameplay data. */
export const AUDIO_DBC_TABLES = Object.freeze([
  "EmotesTextSound",
]);

/** The ignored client-media directory carries both categories from one active archive winner. */
export const CLIENT_MEDIA_DBC_TABLES = Object.freeze([
  ...VISUAL_DBC_TABLES,
  ...AUDIO_DBC_TABLES,
]);

const outputDirectory = resolve(process.argv[2] ?? resolve(repositoryRoot, "data/visual-dbc"));
await mkdir(outputDirectory, { recursive: true });

const archives = await clientArchives(clientDirectory());
try {
  for (const table of CLIENT_MEDIA_DBC_TABLES) {
    const internal = `DBFilesClient\\${table}.dbc`;
    const payload = await archives.read(internal);
    if (!payload) throw new Error(`${internal} is missing from the client archive chain`);
    const destination = resolve(outputDirectory, `${table}.dbc`);
    await writeFile(destination, payload);
    await writeSourceStamp(destination, await sourceStamp(archives, { paths: [internal] }));
  }
} finally {
  archives.close();
}

console.log(
  `Extracted ${VISUAL_DBC_TABLES.length} visual + ${AUDIO_DBC_TABLES.length} audio client-media DBCs ` +
  `to ${outputDirectory}`);
