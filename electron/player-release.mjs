// 10.17 — the signing side of the player app's updates, used by build.mjs --player only (it is not
// packed into the app). The app side, and the manifest format, are in player-update.cjs.
//
// The key: an Ed25519 pair in .runtime/player-update-key/ (git-ignored, like all of .runtime),
// created by the first player build: private.pem never leaves this machine; the public half goes
// into every packed app as resources/app/update.json. Apps accept only manifests signed by the key
// they were built with, so losing the folder means every player reinstalls by hand once.
//
// The version: electron/package.json's "major.minor.patch" plus a fourth number, the build counter
// kept in the same folder (release.json), raised by one on every player build. Compared as numbers
// part by part, so 0.1.0.10 is newer than 0.1.0.9. Nobody edits it by hand; raising package.json's
// version is optional, lowering it is refused.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const {
  MANIFEST_FILE, SIGNATURE_FILE, isNewerVersion, manifestBytes, parseManifest, parseVersion,
} = createRequire(import.meta.url)("./player-update.cjs");

const PRIVATE_KEY_FILE = "private.pem";
const PUBLIC_KEY_FILE = "public.pem";
const RELEASE_FILE = "release.json";

/**
 * The signing key in `dir`, created when absent: `{ privateKey, publicKeyDer, fingerprint, created }`.
 * `fingerprint` is the first 16 hex digits of the public key's SHA-256, to tell keys apart in logs.
 */
export function loadOrCreateSigningKey(dir) {
  const privateFile = join(dir, PRIVATE_KEY_FILE);
  let created = false;
  let privateKey;
  if (existsSync(privateFile)) {
    privateKey = createPrivateKey(readFileSync(privateFile, "utf8"));
    if (privateKey.asymmetricKeyType !== "ed25519") throw new Error(`${privateFile} is not an Ed25519 key.`);
  } else {
    mkdirSync(dir, { recursive: true });
    const pair = generateKeyPairSync("ed25519");
    privateKey = pair.privateKey;
    // `wx`: never overwrite a key another build may have written meanwhile.
    writeFileSync(privateFile, privateKey.export({ format: "pem", type: "pkcs8" }), { flag: "wx", mode: 0o600 });
    writeFileSync(join(dir, PUBLIC_KEY_FILE), pair.publicKey.export({ format: "pem", type: "spki" }));
    created = true;
  }
  const publicKeyDer = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  return { privateKey, publicKeyDer, fingerprint: createHash("sha256").update(publicKeyDer).digest("hex").slice(0, 16), created };
}

/** The build counter's last state (`{ build, version }`), or undefined before the first build. */
export function readReleaseState(dir) {
  const file = join(dir, RELEASE_FILE);
  if (!existsSync(file)) return undefined;
  const state = JSON.parse(readFileSync(file, "utf8"));
  if (!Number.isSafeInteger(state?.build) || state.build < 0 || parseVersion(state.version) === undefined) {
    throw new Error(`${file} is damaged; it holds the last player build number ({ "build": N, "version": "…" }).`);
  }
  return { build: state.build, version: state.version };
}

export function writeReleaseState(dir, { build, version }) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, RELEASE_FILE), `${JSON.stringify({ build, version, built: new Date().toISOString() }, null, 2)}\n`);
}

/** The version in a published latest.json in `folder` (dist/player), or undefined. */
export function readPublishedVersion(folder) {
  try {
    const verdict = parseManifest(readFileSync(join(folder, MANIFEST_FILE)));
    return verdict.ok ? verdict.manifest.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The next release: `{ build, version }` with build = the last counter (release.json, or the
 * published manifest's fourth number when higher) + 1. Throws when package.json's version is not
 * major.minor.patch, or when the result would not be newer than what players may already have.
 */
export function nextRelease({ baseVersion, state, publishedVersion }) {
  if (typeof baseVersion !== "string" || !/^\d{1,9}\.\d{1,9}\.\d{1,9}$/.test(baseVersion)) {
    throw new Error(`electron/package.json version must be major.minor.patch (numbers only), not ${JSON.stringify(baseVersion)}.`);
  }
  const publishedBuild = parseVersion(publishedVersion)?.[3] ?? 0;
  const build = Math.max(state?.build ?? 0, publishedBuild) + 1;
  const version = `${baseVersion}.${build}`;
  for (const previous of [state?.version, publishedVersion]) {
    if (previous !== undefined && !isNewerVersion(version, previous)) {
      throw new Error(`The player app would be ${version}, not newer than ${previous} that players may have: `
        + "electron/package.json's version was lowered. Raise it again instead.");
    }
  }
  return { build, version };
}

/** update.json for the packed player app: its version and the public key, base64 SPKI DER. */
export function updateConfig({ version, publicKeyDer }) {
  return { version, publicKey: Buffer.from(publicKeyDer).toString("base64") };
}

/** SHA-256 (hex) and size of a file, streamed. */
export async function hashFile(file) {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { sha256: hash.digest("hex"), size };
}

/** The base64 Ed25519 signature of `bytes`, as latest.json.sig holds it. */
export function signManifest(bytes, privateKey) {
  return sign(null, bytes, privateKey).toString("base64");
}

/** Removes a published manifest and signature, so nobody is offered a zip that is being rewritten. */
export function removePublishedManifest(folder) {
  for (const name of [MANIFEST_FILE, SIGNATURE_FILE]) rmSync(join(folder, name), { force: true });
}

/**
 * Writes latest.json for `zip` and its detached signature latest.json.sig into `folder`; the
 * signature first, so a manifest is never served without it. Returns `{ manifest, manifestFile,
 * signatureFile }`.
 */
export async function writeSignedManifest({ folder, zip, file, version, privateKey }) {
  const { sha256, size } = await hashFile(zip);
  const manifest = { version, sha256, size, file };
  const bytes = manifestBytes(manifest);
  if (!parseManifest(bytes).ok) throw new Error(`Refusing to publish an unreadable manifest: ${parseManifest(bytes).reason}`);
  const manifestFile = join(folder, MANIFEST_FILE);
  const signatureFile = join(folder, SIGNATURE_FILE);
  writeFileSync(signatureFile, `${signManifest(bytes, privateKey)}\n`);
  writeFileSync(manifestFile, bytes);
  return { manifest, manifestFile, signatureFile };
}
