import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
  /** True only when all playable model/skin profiles satisfy the extended-geoset contract. */
  coordinatedVisuals?: true;
}

export interface ClientMediaOverlayOptions {
  candidate: string;
  /** An explicit VISUAL_DBC_DIR is an operator override and may be used without a local client. */
  explicit: boolean;
  clientDirectory?: string;
  report?: (message: string) => void;
}

export const CLIENT_MEDIA_PROFILE_FILE = "client-media-profile.json";

interface ClientMediaProfile {
  schema: 2;
  compatibility: "classic" | "coordinated" | "unsupported";
  coordinatedVisuals: boolean;
  problems?: string[];
}

interface ClientMediaProfileModule {
  inspectClientMediaProfile(clientDirectory: string): Promise<ClientMediaProfile>;
}

async function activeClientMediaProfile(
  clientDirectory: string,
  report: (message: string) => void,
): Promise<ClientMediaProfile | undefined> {
  try {
    const module = await import(pathToFileURL(resolve(
      process.cwd(), "tools", "extract-visual-dbc-overlay.mjs",
    )).href) as ClientMediaProfileModule;
    return await module.inspectClientMediaProfile(clientDirectory);
  } catch (error) {
    report(
      `Could not inspect the active client visual profile: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

function coordinatedOverlayRequired(candidate: string, reason: string): Error {
  return new Error(
    "Active client archives use a coordinated extended-geoset visual profile, but "
    + `${candidate} ${reason}. Refusing to pair patched character models with dataset visual DBCs. `
    + "Run npm run assets:visual-dbc for the active CLIENT_DIR before starting the gateway",
  );
}

function unsupportedClientProfile(profile: ClientMediaProfile): Error {
  return new Error(
    "Active client archives mix incompatible classic and extended playable model profiles: "
    + `${profile.problems?.join("; ") ?? "the structural profile is unsupported"}. `
    + "Use one complete character model/skin pack before starting the gateway",
  );
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

async function usesCoordinatedVisualProfile(directory: string): Promise<boolean> {
  try {
    const profile = JSON.parse(
      await readFile(join(directory, CLIENT_MEDIA_PROFILE_FILE), "utf8"),
    ) as unknown;
    if (typeof profile === "object" && profile !== null
      && "schema" in profile && profile.schema === 2
      && "compatibility" in profile && profile.compatibility === "coordinated"
      && "coordinatedVisuals" in profile
      && typeof profile.coordinatedVisuals === "boolean") {
      return profile.coordinatedVisuals;
    }
  } catch {
    // A missing or malformed profile cannot opt into model-specific geoset corrections.
  }
  return false;
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
  const activeProfile = !options.explicit && options.clientDirectory !== undefined
    ? await activeClientMediaProfile(options.clientDirectory, report)
    : undefined;
  if (activeProfile?.compatibility === "unsupported") {
    throw unsupportedClientProfile(activeProfile);
  }
  const activeCoordinated = activeProfile?.coordinatedVisuals === true;
  const visualPresent = await present(options.candidate, VISUAL_DBC_FILES);
  const audioPresent = await present(options.candidate, AUDIO_DBC_FILES);
  const profilePresent = await present(options.candidate, [CLIENT_MEDIA_PROFILE_FILE]);
  if (activeCoordinated && (!visualPresent || !profilePresent)) {
    throw coordinatedOverlayRequired(
      options.candidate,
      "has no complete visual DBC overlay and structural profile",
    );
  }
  if (!visualPresent && !audioPresent) {
    if (options.explicit) report(`Not using VISUAL_DBC_DIR: ${options.candidate} has no complete client-media DBC set`);
    return {};
  }

  if (options.explicit) {
    const coordinatedVisuals = visualPresent && profilePresent
      && await usesCoordinatedVisualProfile(options.candidate);
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
  const [visualDbcsCurrent, audioCurrent, profileCurrent] = await Promise.all([
    visualPresent ? current(fingerprint, options.candidate, VISUAL_DBC_FILES) : false,
    audioPresent ? current(fingerprint, options.candidate, AUDIO_DBC_FILES) : false,
    profilePresent
      ? fingerprint.isCurrent(join(options.candidate, CLIENT_MEDIA_PROFILE_FILE), { requireStamp: true })
      : false,
  ]);
  const visualCurrent = visualDbcsCurrent && profileCurrent;
  if (visualPresent && !visualCurrent) {
    report(
      `Not using stale visual DBCs or media profile from ${options.candidate}; run npm run assets:visual-dbc `
      + "for the active client pack",
    );
  }
  if (audioPresent && !audioCurrent) {
    report(
      `Not using stale audio DBCs from ${options.candidate}; run npm run assets:visual-dbc `
      + "for the active client pack",
    );
  }
  if (activeCoordinated && !visualCurrent) {
    throw coordinatedOverlayRequired(options.candidate, "does not match the active client archive chain");
  }
  const coordinatedVisuals = visualCurrent && await usesCoordinatedVisualProfile(options.candidate);
  return {
    ...(visualCurrent ? { visualDbcDirectory: options.candidate } : {}),
    ...(audioCurrent ? { audioDbcDirectory: options.candidate } : {}),
    ...(coordinatedVisuals ? { coordinatedVisuals: true as const } : {}),
  };
}
