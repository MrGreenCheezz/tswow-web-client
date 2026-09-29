import "../tools/env.mjs";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, rmdirSync, symlinkSync, unlinkSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// The checkout `npm run protocol:generate` reads: TRINITYCORE_DIR (from the caller or `.env`, which
// the import above has loaded), else the sibling `tswow/cores/TrinityCore`.
const coreDir = process.env.TRINITYCORE_DIR
  ?? fileURLToPath(new URL("../../tswow/cores/TrinityCore", import.meta.url));
const HEADERS = {
  responseCodes: ["src", "server", "shared", "SharedDefines.h"],
  authResults: ["src", "server", "authserver", "Authentication", "AuthCodes.h"],
};

/**
 * The generator, imported the only safe way.
 *
 * It is a script as well as a module: importing it must define its functions and nothing else. The
 * import happens with TRINITYCORE_DIR pointing at a directory that does not exist, so a generator
 * that ever ran itself on import would fail right here on the missing headers — instead of quietly
 * rewriting the ignored `protocol-data/` tables that every other test file is reading.
 */
async function importGenerator() {
  const saved = process.env.TRINITYCORE_DIR;
  process.env.TRINITYCORE_DIR = join(tmpdir(), "webclient-protocol-generator-no-core");
  try {
    return await import("../tools/generate-protocol.mjs");
  } finally {
    if (saved === undefined) delete process.env.TRINITYCORE_DIR;
    else process.env.TRINITYCORE_DIR = saved;
  }
}
const generator = await importGenerator();

/** Temporary copies of the two headers, so a test can also break one on purpose. */
const headerDirectory = await mkdtemp(join(tmpdir(), "webclient-protocol-headers-"));
test.after(async () => {
  // Removed whether or not the copies below succeeded: a machine without the core still made it.
  await rm(headerDirectory, { recursive: true, force: true });
});
let copies;
try {
  copies = { directory: headerDirectory };
  for (const [name, parts] of Object.entries(HEADERS)) {
    copies[name] = join(headerDirectory, parts.at(-1));
    await copyFile(join(coreDir, ...parts), copies[name]);
  }
} catch {
  copies = undefined;
}
const withCore = { skip: copies ? false : "no TrinityCore checkout on this machine" };

test("importing the generator defines it and runs nothing", () => {
  // Reaching this line is the assertion: see `importGenerator`.
  assert.equal(typeof generator.parseResponseCodes, "function");
  assert.equal(typeof generator.parseAuthResults, "function");
  assert.equal(typeof generator.generateResponseCodes, "function");
  assert.equal(typeof generator.generateAuthResults, "function");
});

test("ResponseCodes: every one of the 104 values the client's own table is indexed by", withCore, async () => {
  const source = await readFile(copies.responseCodes, "utf8");
  const entries = generator.parseResponseCodes(source);
  const byValue = new Map(entries.map(({ name, value }) => [value, name]));

  // Wow.exe 12340 keeps a 104-pointer table of GlueStrings keys indexed by this enum
  // (docs/implementation/probes/A6/exe-response-table.out.txt): 0..103, no gaps.
  assert.equal(entries.length, 104);
  assert.deepEqual(entries.map(({ value }) => value), [...Array(104).keys()]);
  assert.equal(byValue.get(0), "RESPONSE_SUCCESS");
  // The three the old hand-written creation table called «invalid name».
  assert.equal(byValue.get(42), "ACCOUNT_CREATE_FAILED");
  assert.equal(byValue.get(43), "CHAR_LIST_RETRIEVING");
  assert.equal(byValue.get(44), "CHAR_LIST_RETRIEVED");
  assert.equal(byValue.get(47), "CHAR_CREATE_SUCCESS");
  assert.equal(byValue.get(62), "CHAR_CREATE_RESTRICTED_RACECLASS");
  assert.equal(byValue.get(74), "CHAR_DELETE_FAILED_GUILD_LEADER");
  assert.equal(byValue.get(100), "CHAR_NAME_CONSECUTIVE_SPACES");

  const digest = generator.enumDigest(source, "enum ResponseCodes");
  const module = generator.generateResponseCodes(entries, digest);
  assert.match(module, /^  CHAR_NAME_DECLENSION_DOESNT_MATCH_BASE_NAME: 103,$/m);
  assert.match(module, /^  RESPONSE_SUCCESS: 0,$/m);
  assert.match(module, /^export const RESPONSE_CODE_NAMES = new Map<number, ResponseCodeName>\(/m);
  assert.ok(module.includes(digest), "the header names the enum it was generated from");
});

test("AuthResult: the wire codes of AuthCodes.h, and not the LoginResult enum beside them", withCore, async () => {
  const source = await readFile(copies.authResults, "utf8");
  const entries = generator.parseAuthResults(source);
  const byName = new Map(entries.map(({ name, value }) => [name, value]));

  assert.equal(byName.get("WOW_SUCCESS"), 0x00);
  assert.equal(byName.get("WOW_FAIL_INCORRECT_PASSWORD"), 0x05);
  assert.equal(byName.get("WOW_FAIL_TRIAL_ENDED"), 0x11);
  assert.equal(byName.get("WOW_FAIL_UNLOCKABLE_LOCK"), 0x19);
  assert.equal(byName.get("WOW_FAIL_CONVERSION_REQUIRED"), 0x20);
  assert.equal(byName.get("WOW_FAIL_DISCONNECTED"), 0xff);
  assert.ok(entries.every(({ name }) => name.startsWith("WOW_")), "LoginResult (LOGIN_*) is not mixed in");

  const module = generator.generateAuthResults(entries, generator.enumDigest(source, "enum AuthResult"));
  assert.match(module, /^  WOW_FAIL_UNLOCKABLE_LOCK: 0x19,$/m);
  assert.match(module, /^  WOW_FAIL_DISCONNECTED: 0xFF,$/m);
  assert.match(module, /^export const AUTH_RESULT_NAMES = new Map<number, AuthResultName>\(/m);
});

test("a member that does not name its value stops the generator instead of renumbering the rest", withCore, async () => {
  const source = await readFile(copies.responseCodes, "utf8");
  const broken = join(copies.directory, "SharedDefines.implicit.h");
  const implicit = source.replace(/(CHAR_CREATE_RESTRICTED_RACECLASS)\s*=\s*62\s*,/, "$1,");
  assert.notEqual(implicit, source, "the fixture edit applied");
  await writeFile(broken, implicit, "utf8");
  const reread = await readFile(broken, "utf8");
  assert.throws(() => generator.parseResponseCodes(reread), /CHAR_CREATE_RESTRICTED_RACECLASS/);

  // Two names on one number would make RESPONSE_CODE_NAMES drop one of them.
  const duplicate = source.replace(/(CHAR_CREATE_RESTRICTED_RACECLASS\s*=\s*)62/, "$161");
  assert.throws(() => generator.parseResponseCodes(duplicate), /61/);

  // And a header without the enum is not an empty table.
  assert.throws(() => generator.parseAuthResults("enum LoginResult\n{\n    LOGIN_OK = 0x00\n};\n"), /AuthResult/);
});

test("the ignored tables on disk are what this checkout generates (npm run protocol:check)", withCore, async () => {
  const generated = new URL("../src/generated/protocol-data/", import.meta.url);
  const [responseSource, authSource] = await Promise.all([
    readFile(join(coreDir, ...HEADERS.responseCodes), "utf8"),
    readFile(join(coreDir, ...HEADERS.authResults), "utf8"),
  ]);
  const expected = {
    "responseCodes.ts": generator.generateResponseCodes(
      generator.parseResponseCodes(responseSource), generator.enumDigest(responseSource, "enum ResponseCodes")),
    "authResults.ts": generator.generateAuthResults(
      generator.parseAuthResults(authSource), generator.enumDigest(authSource, "enum AuthResult")),
  };
  for (const [file, content] of Object.entries(expected)) {
    const current = await readFile(new URL(file, generated), "utf8").catch(() => "");
    assert.ok(current === content, `the ignored protocol-data/${file} is stale; run npm run protocol:generate`);
  }
});

test("started through a junction the script still runs, so --check cannot pass by doing nothing", withCore, () => {
  // `node <link>/generate-protocol.mjs` hands the script its own path through the link while
  // import.meta.url is the real one. A guard comparing the two as strings skipped main() and exited
  // 0 — which made `npm run protocol:check` from a junctioned checkout pass without checking.
  // `--check` only reads, so this runs the real script against the real checkout.
  const scratch = mkdtempSync(join(tmpdir(), "webclient-protocol-junction-"));
  const link = join(scratch, "tools");
  symlinkSync(fileURLToPath(new URL("../tools", import.meta.url)), link, process.platform === "win32" ? "junction" : "dir");
  try {
    const run = spawnSync(process.execPath, [join(link, "generate-protocol.mjs"), "--check"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      encoding: "utf8",
      timeout: 180_000,
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /^Checked \d+ opcodes and \d+ update fields\.$/m);
    assert.match(run.stdout, /^Response codes: 104 \(ResponseCodes\)\. Auth results: \d+ \(AuthResult\)\.$/m);
  } finally {
    // The link only: unlink removes a junction itself and never what it points at.
    if (existsSync(link) && lstatSync(link).isSymbolicLink()) unlinkSync(link);
    rmdirSync(scratch);
  }
});
