import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repositoryRoot } from "./paths.mjs";

/**
 * Generated implementations that are derived from a user's local WoW/TSWoW data.
 *
 * The public modules in `src/generated/` are stable, data-free facades. Their implementations
 * live below this ignored directory so a checkout can compile without redistributing client data.
 */
export const clientDataDirectory = join(repositoryRoot, "src", "generated", "client-data");
export const builtClientDataDirectory = join(
  repositoryRoot,
  "dist",
  "code",
  "generated",
  "client-data",
);

// These are API fixture names already referenced by handwritten source and tests, not values read
// from a client file. Unique ids outside the client table's range keep data-independent animation
// algorithms testable in a clean checkout without retaining any real row ids.
const NEUTRAL_ANIMATION_NAMES = [
  "Stand", "Walk", "Run", "Walkbackwards", "ShuffleLeft", "ShuffleRight", "RunLeft", "RunRight",
  "JumpStart", "Jump", "JumpEnd", "Fall", "Swim", "SwimIdle", "SwimLeft", "SwimRight",
  "SwimBackwards", "Fly", "Hover", "Mount", "Death", "Dead", "SitGround", "SitGroundDown",
  "SitGroundUp", "KneelLoop", "SitChairLow", "SitChairMed", "SitChairHigh", "Sleep", "SleepDown",
  "AttackUnarmed", "Attack1H", "Attack2H", "Attack2HL", "AttackBow", "AttackRifle",
  "AttackThrown", "AttackOff", "ReadyUnarmed", "Ready1H", "Ready2H", "ReadyBow", "ReadyRifle",
  "ReadyThrown", "ReadySpellOmni", "SpellCastOmni", "ChannelCastOmni", "Loot", "Close", "Closed",
  "Open", "Opened", "Destroy", "Destroyed", "Custom0", "Custom1", "Custom2", "Custom3",
  "EmoteBow", "EmoteDance", "EmoteTalk", "EmoteUseStanding", "EmoteWave", "UseStandingLoop",
];

const NEUTRAL_BASE_ANIMATION_NAMES = [
  "Stand", "Walk", "Run", "Walkbackwards", "ShuffleLeft", "ShuffleRight", "RunLeft", "RunRight",
  "JumpStart", "Jump", "JumpEnd", "Fall", "Swim", "SwimIdle", "SwimLeft", "SwimRight",
  "SwimBackwards", "Fly", "Hover", "Death", "Dead",
];

const neutralAnimationIds = new Map(NEUTRAL_ANIMATION_NAMES.map((name, index) => [
  name,
  10_000 + index,
]));

function neutralAnimationId(name) {
  const id = neutralAnimationIds.get(name);
  if (id === undefined) throw new Error(`Neutral animation fixture has no ${name}`);
  return id;
}

function typescriptRecord(entries, indent = "  ") {
  return entries.map(([key, value]) => `${indent}${JSON.stringify(key)}: ${value},`).join("\n");
}

const neutralAnimationStub = `// Neutral fallback created by tools/prepare-client-data.mjs.\n`
  + `// Synthetic ids exercise code paths but are not client data and are not valid for gameplay.\n`
  + `// Run \`npm run animations:generate\` with a user-supplied dataset to replace it locally.\n`
  + `export const ANIMATION_DATA_AVAILABLE = false as const;\n`
  + `export const ANIMATION_IDS: Readonly<Record<string, number>> = {\n`
  + `${typescriptRecord([...neutralAnimationIds])}\n};\n`
  + `export const ANIMATION_NAMES: Readonly<Record<number, string>> = {};\n`
  + `export const ANIMATION_FALLBACK: Readonly<Record<number, number>> = {\n`
  + `${typescriptRecord([
    [neutralAnimationId("Attack2HL"), neutralAnimationId("Attack2H")],
    [neutralAnimationId("Attack2H"), neutralAnimationId("Attack1H")],
    [neutralAnimationId("Attack1H"), neutralAnimationId("AttackUnarmed")],
    [neutralAnimationId("Swim"), neutralAnimationId("Walk")],
  ])}\n};\n`
  + `export const BASE_ANIMATIONS: readonly number[] = [`
  + `${NEUTRAL_BASE_ANIMATION_NAMES.map(neutralAnimationId).join(", ")}];\n`
  + `export const EMOTE_ANIMATIONS: Readonly<Record<number, { animation: number; state: boolean }>> = {};\n`;

const SLICES = [
  {
    name: "animations",
    label: "animation and emote tables",
    marker: "ANIMATION_DATA_AVAILABLE",
    stub: neutralAnimationStub,
  },
  {
    name: "globalStrings",
    label: "localized GlobalStrings and core enum joins",
    marker: "GLOBAL_STRING_DATA_AVAILABLE",
    stub: `// Neutral fallback created by tools/prepare-client-data.mjs.\n`
      + `// Run \`npm run strings:generate\` with user-supplied client/core sources to replace it locally.\n`
      + `export const GLOBAL_STRING_DATA_AVAILABLE = false as const;\n`
      + `export const GLOBAL_STRINGS: Readonly<Record<string, string>> = {};\n`
      + `export const SPELL_CAST_RESULT_NAMES: Readonly<Record<number, string>> = {};\n`
      + `export const ITEM_MOD_NAMES: Readonly<Record<number, string>> = {};\n`,
  },
  {
    name: "classIcons",
    label: "class icon coordinates",
    marker: "CLASS_ICON_DATA_AVAILABLE",
    stub: `// Neutral fallback created by tools/prepare-client-data.mjs.\n`
      + `// Run \`npm run classicons:generate\` with a user-supplied dataset to replace it locally.\n`
      + `export const CLASS_ICON_DATA_AVAILABLE = false as const;\n`
      + `export const CLASS_ICON_TCOORDS: Readonly<Record<string, {\n`
      + `  left: number; right: number; top: number; bottom: number;\n`
      + `}>> = {};\n`,
  },
];

export function clientDataImplementationPath(name) {
  const slice = SLICES.find((candidate) => candidate.name === name);
  if (!slice) throw new Error(`Unknown client-data slice: ${name}`);
  return join(clientDataDirectory, `${name}.ts`);
}

export function ensureClientDataDirectory() {
  mkdirSync(clientDataDirectory, { recursive: true });
}

/** Create build-only neutral implementations without replacing locally generated real data. */
export function ensureClientDataStubs() {
  ensureClientDataDirectory();
  const created = [];
  for (const slice of SLICES) {
    const path = clientDataImplementationPath(slice.name);
    if (existsSync(path)) continue;
    writeFileSync(path, slice.stub, { encoding: "utf8", flag: "wx" });
    created.push(slice.name);
  }
  return created;
}

/**
 * Reports whether each ignored implementation was generated from local source data.
 * Reading a tiny explicit marker keeps the gateway independent from TypeScript module loading.
 */
export function inspectClientDataDirectory(directory, extension = ".ts") {
  return SLICES.map((slice) => {
    const path = join(directory, `${slice.name}${extension}`);
    let source;
    try {
      source = readFileSync(path, "utf8");
    } catch {
      return { ...slice, path, available: false, reason: "implementation is missing" };
    }
    const available = new RegExp(`export\\s+const\\s+${slice.marker}\\s*=\\s*true\\b`).test(source);
    return {
      ...slice,
      path,
      available,
      reason: available ? "generated from local source data" : "neutral stub is active",
    };
  });
}

export function inspectClientDataImplementations() {
  return inspectClientDataDirectory(clientDataDirectory);
}

/** Inspect the JavaScript copied into dist; gateway startup must validate what it will execute. */
export function inspectBuiltClientDataImplementations() {
  return inspectClientDataDirectory(builtClientDataDirectory, ".js");
}

/** Reject a missing or neutral dist even when real source tables were generated after the build. */
export function assertBuiltClientDataImplementations() {
  const unavailable = inspectBuiltClientDataImplementations().filter((entry) => !entry.available);
  if (unavailable.length > 0) {
    throw new Error(
      `Built client data is not ready (${unavailable.map((entry) => entry.name).join(", ")}). `
      + "Run `npm run build` after `npm run client-data:generate` before starting the gateway.",
    );
  }
}
