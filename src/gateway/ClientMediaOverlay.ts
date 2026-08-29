import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatasetFingerprint } from "./DatasetFingerprint.js";

export const VISUAL_DBC_FILES = Object.freeze([
  "CharSections.dbc",
  "CharHairGeosets.dbc",
  "CharacterFacialHairStyles.dbc",
  "CreatureDisplayInfoExtra.dbc",
  "CreatureDisplayInfo.dbc",
  "CreatureModelData.dbc",
  "HelmetGeosetVisData.dbc",
  "SpellVisualKitModelAttach.dbc",
]);

export const AUDIO_DBC_FILES = Object.freeze([
  "EmotesTextSound.dbc",
]);

export interface ClientMediaOverlaySelection {
  visualDbcDirectory?: string;
  audioDbcDirectory?: string;
  /** True only when the selected visual tables were extracted from patch-W/X/Y/Z. */
  coordinatedVisuals?: true;
}

export interface ClientMediaOverlayOptions {
  candidate: string;
  /** An explicit VISUAL_DBC_DIR is an operator override and may be used without a local client. */
  explicit: boolean;
  clientDirectory?: string;
  report?: (message: string) => void;
}

async function present(directory: string, files: readonly string[]): Promise<boolean> {
  const found = await Promise.all(files.map((file) => access(join(directory, file)).then(
    () => true,
    () => false,
  )));
  return found.every(Boolean);
}

async function current(
  fingerprint: DatasetFingerprint,
  directory: string,
  files: readonly string[],
): Promise<boolean> {
  const states = await Promise.all(files.map((file) =>
    fingerprint.isCurrent(join(directory, file), { requireStamp: true })));
  return states.every(Boolean);
}

async function usesCoordinatedVisualPatch(directory: string): Promise<boolean> {
  try {
    const stamp = JSON.parse(await readFile(join(directory, "CreatureModelData.dbc.src"), "utf8")) as unknown;
    if (typeof stamp !== "object" || stamp === null || !("sources" in stamp)
      || !Array.isArray(stamp.sources)) return false;
    return stamp.sources.some((source) => {
      if (typeof source !== "object" || source === null || !("name" in source)) return false;
      return typeof source.name === "string" && /^patch-[w-z]\.mpq$/i.test(source.name);
    });
  } catch {
    // A legacy/manual directory may still be explicitly selected, but patch-specific geoset
    // corrections need positive provenance rather than guessing from the directory being separate.
    return false;
  }
}

/**
 * Selects client-media DBCs without ever pairing a stale HD overlay with classic model archives.
 *
 * The default ignored directory is automatic convenience, so it fails closed unless every file
 * carries a source stamp matching the active CLIENT_DIR. An explicit VISUAL_DBC_DIR remains the
 * escape hatch for a machine that intentionally serves a pre-extracted pack without local MPQs.
 */
export async function selectClientMediaOverlay(
  options: ClientMediaOverlayOptions,
): Promise<ClientMediaOverlaySelection> {
  const report = options.report ?? (() => undefined);
  const visualPresent = await present(options.candidate, VISUAL_DBC_FILES);
  const audioPresent = await present(options.candidate, AUDIO_DBC_FILES);
  if (!visualPresent && !audioPresent) {
    if (options.explicit) report(`Not using VISUAL_DBC_DIR: ${options.candidate} has no complete client-media DBC set`);
    return {};
  }

  if (options.explicit) {
    const coordinatedVisuals = visualPresent && await usesCoordinatedVisualPatch(options.candidate);
    return {
      ...(visualPresent ? { visualDbcDirectory: options.candidate } : {}),
      ...(audioPresent ? { audioDbcDirectory: options.candidate } : {}),
      ...(coordinatedVisuals ? { coordinatedVisuals: true as const } : {}),
    };
  }

  if (!options.clientDirectory) {
    report(
      `Not using automatic client-media DBCs from ${options.candidate}: no CLIENT_DIR is available `
      + "to verify their source stamps; set VISUAL_DBC_DIR explicitly to trust this directory",
    );
    return {};
  }

  const fingerprint = new DatasetFingerprint({
    clientDirectory: options.clientDirectory,
    intervalMs: 0,
    onProblem: report,
  });
  await fingerprint.poll();
  const [visualCurrent, audioCurrent] = await Promise.all([
    visualPresent ? current(fingerprint, options.candidate, VISUAL_DBC_FILES) : false,
    audioPresent ? current(fingerprint, options.candidate, AUDIO_DBC_FILES) : false,
  ]);
  const coordinatedVisuals = visualCurrent && await usesCoordinatedVisualPatch(options.candidate);
  if (visualPresent && !visualCurrent) {
    report(
      `Not using stale visual DBCs from ${options.candidate}; run npm run assets:visual-dbc `
      + "for the active client pack",
    );
  }
  if (audioPresent && !audioCurrent) {
    report(
      `Not using stale audio DBCs from ${options.candidate}; run npm run assets:visual-dbc `
      + "for the active client pack",
    );
  }
  return {
    ...(visualCurrent ? { visualDbcDirectory: options.candidate } : {}),
    ...(audioCurrent ? { audioDbcDirectory: options.candidate } : {}),
    ...(coordinatedVisuals ? { coordinatedVisuals: true as const } : {}),
  };
}
