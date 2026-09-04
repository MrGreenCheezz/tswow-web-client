// Extracts the client-side media tables that must stay paired with replacement M2/BLP/audio
// assets.
//
// The gateway deliberately keeps gameplay metadata on the TSWoW dataset. Visual tables are
// different: a model patch redirects stable display ids, changes character geosets and names baked
// textures that only exist in that patch. They live in a separate ignored directory so installing
// an art/audio pack never mutates the server's DBC build. EmotesTextSound is a client media lookup,
// not a gameplay allowlist: EmotesText and EmotesTextData remain dataset-owned.
//
// **The source is the live archive chain and not the dataset, and after the owner's ruling of
// 2026-08-30 that is not merely convenient but required.** The ruling: patch-W.MPQ is legitimate
// and must never be suggested for removal — «каждый следующий патч заменяет предыдущие», a later
// patch replaces the earlier ones, which is the design. `clientArchives` ranks the chain the way
// the game loads it and `read` takes the winner, so these nine tables come out of patch-W here
// exactly as the game reads them. Measured against F:/Circle on 2026-08-30: all nine resolve to
// patch-W.MPQ, and the three the character pipeline reads grow from the dataset's 8,958 / 339 /
// 222 rows (CharSections / CharHairGeosets / CharacterFacialHairStyles) to 10,060 / 370 / 272.
// Preferring the dataset copy for these would pair classic appearance rows with HD geometry, which
// is the whole of the HD-1 defect.

import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openClientArchives } from "./mpq.mjs";
import { parseM2 } from "./m2.mjs";
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

/** Structural profile written beside the extracted DBCs; independent of the patch's letter. */
export const CLIENT_MEDIA_PROFILE_FILE = "client-media-profile.json";

/**
 * Geometry variants selected by CharacterAppearance's coordinated policy.
 *
 * This contract is structural: a source may be patch-A, patch-ruRU-G, or any other ranked name.
 * Family 20 is the positive signal because stock 3.3.5 keeps the foot in the base mesh, while the
 * coordinated replacement moves it into these authored variants. Once that signal exists in one
 * playable profile, every profile must carry the geometry the global policy selects.
 */
export const PLAYABLE_CHARACTER_PROFILES = Object.freeze([
  ["Human", "Human", "Male", [1801, 2001]],
  ["Human", "Human", "Female", [1802, 2001]],
  ["Orc", "Orc", "Male", [1802, 2001]],
  ["Orc", "Orc", "Female", [1801, 2001]],
  ["Dwarf", "Dwarf", "Male", [1802, 2002]],
  ["Dwarf", "Dwarf", "Female", [1801, 2001]],
  ["NightElf", "NightElf", "Male", [1801]],
  ["NightElf", "NightElf", "Female", [1802, 2001]],
  ["Scourge", "Scourge", "Male", [1801]],
  ["Scourge", "Scourge", "Female", [1802]],
  ["Tauren", "Tauren", "Male", [1801]],
  ["Tauren", "Tauren", "Female", [1802]],
  ["Gnome", "Gnome", "Male", [2001]],
  ["Gnome", "Gnome", "Female", [1802]],
  ["Troll", "Troll", "Male", [1801]],
  ["Troll", "Troll", "Female", [1801]],
  ["BloodElf", "BloodElf", "Male", [1802, 2001]],
  ["BloodElf", "BloodElf", "Female", [1801, 2001]],
  ["Draenei", "Draenei", "Male", [1801]],
  ["Draenei", "Draenei", "Female", [1801]],
].map(([directory, file, sex, requiredGeosets]) => Object.freeze({
  name: `${directory}${sex}`,
  modelPath: `Character\\${directory}\\${sex}\\${file}${sex}.m2`,
  skinPath: `Character\\${directory}\\${sex}\\${file}${sex}00.skin`,
  requiredGeosets: Object.freeze(requiredGeosets),
})));

export const CLIENT_MEDIA_PROFILE_PATHS = Object.freeze([
  ...PLAYABLE_CHARACTER_PROFILES.flatMap(({ modelPath, skinPath }) => [modelPath, skinPath]),
  ...CLIENT_MEDIA_DBC_TABLES.map((table) => `DBFilesClient\\${table}.dbc`),
]);

async function visualProfile(archives) {
  const models = [];
  const problems = [];
  for (const definition of PLAYABLE_CHARACTER_PROFILES) {
    const [model, skin, modelSource, skinSource] = await Promise.all([
      archives.read(definition.modelPath), archives.read(definition.skinPath),
      archives.locate(definition.modelPath), archives.locate(definition.skinPath),
    ]);
    if (!model || !skin) {
      const missing = [!model ? definition.modelPath : undefined, !skin ? definition.skinPath : undefined]
        .filter(Boolean);
      problems.push(`${definition.name} is missing ${missing.join(" and ")}`);
      models.push({
        ...definition, modelSource, skinSource, families: [], policyGeosets: [],
        supportsCoordinatedPolicy: false,
      });
      continue;
    }
    try {
      const active = parseM2(model, skin).submeshes.filter((submesh) => submesh.indexCount > 0);
      const families = [...new Set(active.map((submesh) => Math.floor(submesh.geosetId / 100)))]
        .sort((left, right) => left - right);
      const policyGeosets = [...new Set(active
        .map((submesh) => submesh.geosetId)
        .filter((geoset) => [18, 20].includes(Math.floor(geoset / 100))))]
        .sort((left, right) => left - right);
      models.push({
        ...definition, modelSource, skinSource, families, policyGeosets,
        supportsCoordinatedPolicy: definition.requiredGeosets.every((geoset) =>
          policyGeosets.includes(geoset)),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      problems.push(`${definition.name} model/skin pair is incompatible: ${message}`);
      models.push({
        ...definition, modelSource, skinSource, families: [], policyGeosets: [],
        supportsCoordinatedPolicy: false, error: message,
      });
    }
  }

  const tables = [];
  for (const table of CLIENT_MEDIA_DBC_TABLES) {
    const path = `DBFilesClient\\${table}.dbc`;
    const source = await archives.locate(path);
    if (!source) problems.push(`${path} is missing`);
    tables.push({ table, path, source });
  }

  const footProfiles = models.filter(({ requiredGeosets }) =>
    requiredGeosets.some((geoset) => Math.floor(geoset / 100) === 20));
  const observedFootProfiles = models.filter(({ policyGeosets }) =>
    policyGeosets.some((geoset) => Math.floor(geoset / 100) === 20)).length;
  const matchedFootProfiles = footProfiles.filter(({ requiredGeosets, policyGeosets }) =>
    requiredGeosets.filter((geoset) => Math.floor(geoset / 100) === 20)
      .every((geoset) => policyGeosets.includes(geoset))).length;
  // The renderer has one policy switch, not one per race. Zero extended feet is a classic/custom
  // profile; observing family 20 anywhere is positive extended evidence and then all ten authored
  // variants are required. Checking observation separately from a variant match prevents an
  // unknown 2099, for example, from being mistaken for classic geometry.
  const coordinatedEvidence = observedFootProfiles > 0;
  if (coordinatedEvidence && observedFootProfiles < footProfiles.length) {
    problems.push(
      `extended-foot geometry is mixed (${observedFootProfiles}/${footProfiles.length} profiles)`,
    );
  }
  const unsupportedProfiles = coordinatedEvidence
    ? models.filter(({ supportsCoordinatedPolicy }) => !supportsCoordinatedPolicy)
      .map(({ name }) => name)
    : [];
  if (unsupportedProfiles.length > 0) {
    problems.push(`extended character geometry is incomplete for ${unsupportedProfiles.join(", ")}`);
  }
  const coordinatedVisuals = coordinatedEvidence && matchedFootProfiles === footProfiles.length
    && unsupportedProfiles.length === 0 && problems.length === 0;
  const compatibility = problems.length > 0
    ? "unsupported" : coordinatedVisuals ? "coordinated" : "classic";

  // Exact proof boundary: these paths are parsed and stamped together. The neighbouring creature
  // and baked-texture archives currently called X/Y/Z carry no common generation marker. Requiring
  // their letters or an arbitrary sentinel would reject valid TSWoW layouts without proving that
  // those independent resources belong to one release.
  return {
    schema: 2,
    integrityScope: "playable-character-model-skin+client-media-dbc",
    compatibility,
    coordinatedVisuals,
    coordinatedEvidence: {
      observedExtendedFootProfiles: observedFootProfiles,
      matchedExtendedFootProfiles: matchedFootProfiles,
      totalExtendedFootProfiles: footProfiles.length,
    },
    models,
    tables,
    ...(problems.length > 0 ? { problems } : {}),
  };
}

/** Inspect the active client without publishing an immutable generation. */
export async function inspectClientMediaProfile(client) {
  const archives = await openClientArchives(client);
  try {
    return await visualProfile(archives);
  } finally {
    archives.close();
  }
}

/**
 * Publish the client-media tables from one complete active archive chain.
 *
 * This is exported because the gateway performs the same small sync before it selects the
 * overlay. A TSWoW build can replace the client's lettered patch directories between launches;
 * reading all nine winners in one opened chain keeps model geometry and its visual DBCs on one
 * generation instead of asking an operator to remember a separate extraction step.
 */
export async function extractClientMediaDbcs(options = {}) {
  const sourceClient = options.clientDirectory ?? clientDirectory();
  const outputDirectory = resolve(
    options.outputDirectory ?? resolve(repositoryRoot, "data/visual-dbc"),
  );
  const generationsDirectory = resolve(outputDirectory, ".generations");
  await mkdir(generationsDirectory, { recursive: true });

  // A fresh chain is intentional: the same process may resync after a TSWoW build changes which
  // lettered patch wins. The shared `clientArchives()` helper memoises its first composition and is
  // therefore correct for one generator run, but not for this reusable lifecycle operation.
  const archives = await openClientArchives(sourceClient);
  try {
    const tables = [];
    for (const table of CLIENT_MEDIA_DBC_TABLES) {
      const internal = `DBFilesClient\\${table}.dbc`;
      const payload = await archives.read(internal);
      if (!payload) throw new Error(`${internal} is missing from the client archive chain`);
      const stamp = await sourceStamp(archives, { paths: [internal] });
      tables.push({ table, payload, stamp });
    }
    const profile = await visualProfile(archives);
    if (profile.compatibility === "unsupported") {
      throw new Error(`Unsupported client media profile: ${profile.problems.join("; ")}`);
    }
    // The profile decides how the renderer interprets model geosets, so its provenance is the
    // model and skin themselves rather than the DBCs beside it. Without this sidecar, a model-only
    // publish between extraction and gateway baseline could make the old policy look current.
    const profileStamp = await sourceStamp(archives, { paths: CLIENT_MEDIA_PROFILE_PATHS });

    // Never publish the nine files into the directory the gateway is reading one at a time. A
    // killed extractor (or two gateways starting together) used to leave a half-HD/half-classic
    // overlay behind. The identity includes both bytes and provenance, so an unchanged startup
    // reuses its immutable generation while a different winner gets a different directory.
    const identity = createHash("sha256");
    for (const { table, payload, stamp } of tables) {
      identity.update(`${table}\0`);
      identity.update(payload);
      identity.update(`\0${JSON.stringify(stamp)}\0`);
    }
    identity.update(JSON.stringify(profile));
    identity.update(JSON.stringify(profileStamp));
    const generation = identity.digest("hex");
    const published = resolve(generationsDirectory, generation);
    try {
      await access(published);
      return published;
    } catch {
      // A missing generation is the ordinary first-publish path.
    }

    const staging = await mkdtemp(resolve(generationsDirectory, ".staging-"));
    try {
      for (const { table, payload, stamp } of tables) {
        const destination = resolve(staging, `${table}.dbc`);
        await writeFile(destination, payload);
        await writeSourceStamp(destination, stamp);
      }
      const profileFile = resolve(staging, CLIENT_MEDIA_PROFILE_FILE);
      await writeFile(
        profileFile,
        `${JSON.stringify(profile, null, 2)}\n`,
      );
      await writeSourceStamp(profileFile, profileStamp);
      try {
        // A directory rename is the only publication step. Readers can observe either the old
        // complete generation or this complete one, never the staging directory between them.
        await rename(staging, published);
      } catch (error) {
        // A concurrent startup may have published the byte-identical generation first. Its
        // content-addressed name proves it is the same result, so discard only our private stage.
        try {
          await access(published);
        } catch {
          throw error;
        }
        await rm(staging, { recursive: true, force: true });
      }
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
    return published;
  } finally {
    archives.close();
  }
}

// Behind the same guard `character-textures.mjs` uses, and for the same reason as HD-1: the three
// lists above are the definition of what a coordinated client-media overlay contains, and the
// watchdog in `tests/mpq.test.mjs` has to read them without a bare import extracting a fresh copy
// over `data/visual-dbc` as a side effect of naming them.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const outputDirectory = resolve(process.argv[2] ?? resolve(repositoryRoot, "data/visual-dbc"));
  const generationDirectory = await extractClientMediaDbcs({ outputDirectory });

  console.log(
    `Extracted ${VISUAL_DBC_TABLES.length} visual + ${AUDIO_DBC_TABLES.length} audio client-media DBCs ` +
    `to atomic generation ${generationDirectory}`);
}
