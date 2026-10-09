import "./env.mjs";

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const coreDir = resolve(
  process.env.TRINITYCORE_DIR ?? join(projectRoot, "..", "tswow", "cores", "TrinityCore"),
);
const checkOnly = process.argv.includes("--check");
// These tables are derived from TrinityCore GPL sources. Keep the implementations local and
// ignored; the small modules in src/generated are stable facades only.
const generatedDir = join(projectRoot, "src", "generated", "protocol-data");

const opcodePath = join(coreDir, "src", "server", "game", "Server", "Protocol", "Opcodes.h");
const handlerPath = join(coreDir, "src", "server", "game", "Server", "Protocol", "Opcodes.cpp");
const serverDir = join(coreDir, "src", "server");
const updateFieldPath = join(
  coreDir,
  "src",
  "server",
  "game",
  "Entities",
  "Object",
  "Updates",
  "UpdateFields.h",
);
const responseCodePath = join(coreDir, "src", "server", "shared", "SharedDefines.h");
const authResultPath = join(coreDir, "src", "server", "authserver", "Authentication", "AuthCodes.h");

// Read by `main()`. The generators below hash them into the headers of the files they write.
let opcodeSource;
let handlerSource;
let updateFieldSource;

function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
}

function extractEnumBody(source, declaration) {
  const declarationOffset = source.indexOf(declaration);
  if (declarationOffset < 0) throw new Error(`Missing ${declaration}`);

  const open = source.indexOf("{", declarationOffset);
  const close = source.indexOf("};", open);
  if (open < 0 || close < 0) throw new Error(`Malformed ${declaration}`);
  return source.slice(open + 1, close);
}

function parseOpcodes(source) {
  const body = extractEnumBody(source, "enum Opcodes : uint16");
  const entries = [];

  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(0x[\dA-F]+|\d+)\s*,?/i);
    if (match) entries.push({ name: match[1], value: Number.parseInt(match[2], 0) });
  }

  if (entries.length < 1000) throw new Error(`Parsed only ${entries.length} opcodes`);
  if (entries.find((entry) => entry.name === "CMSG_CUSTOM")?.value !== 0x51f) {
    throw new Error("Expected TSWoW CMSG_CUSTOM opcode 0x51F");
  }
  return entries;
}

function evaluateOffset(expression, values) {
  return expression
    .replace(/[()]/g, "")
    .split("+")
    .map((term) => term.trim())
    .reduce((total, term) => {
      if (/^(?:0x[\dA-F]+|\d+)$/i.test(term)) return total + Number.parseInt(term, 0);
      const value = values.get(term);
      if (value === undefined) throw new Error(`Unknown update-field expression term: ${term}`);
      return total + value;
    }, 0);
}

function parseUpdateFields(source) {
  const values = new Map();
  const entries = [];
  let group;

  for (const line of source.split(/\r?\n/)) {
    const groupMatch = line.match(/^enum\s+(E[A-Za-z0-9_]+Fields)\s*$/);
    if (groupMatch) {
      group = groupMatch[1];
      continue;
    }
    if (group && line.trim() === "};") {
      group = undefined;
      continue;
    }
    if (!group) continue;

    const [code, comment = ""] = line.split("//", 2);
    const entryMatch = code.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.+?)\s*,?\s*$/);
    if (!entryMatch) continue;

    const [, name, expression] = entryMatch;
    const offset = evaluateOffset(expression, values);
    values.set(name, offset);

    const metadata = comment.match(/Size:\s*(\d+),\s*Type:\s*([A-Z0-9_]+),\s*Flags:\s*(.*)\s*$/);
    entries.push({
      name,
      group,
      offset,
      size: metadata ? Number.parseInt(metadata[1], 10) : null,
      type: metadata?.[2] ?? null,
      flags: metadata?.[3] ? metadata[3].split(/\s*,\s*|\s*\|\s*/).filter(Boolean) : [],
    });
  }

  if (entries.length < 350) throw new Error(`Parsed only ${entries.length} update fields`);
  return entries;
}

/**
 * `Opcodes.cpp` is the table the server dispatches on: which opcodes it declares as its own to
 * send, and which it accepts from a client. `Opcodes.h` only says that the numbers exist.
 */
function parseHandlers(source) {
  const server = [];
  const client = [];

  for (const line of source.split(/\r?\n/)) {
    const sent = line.match(/DEFINE_SERVER_OPCODE_HANDLER\(\s*([A-Z][A-Z0-9_]*)/);
    if (sent) {
      server.push(sent[1]);
      continue;
    }
    const received = line.match(
      /DEFINE_HANDLER\(\s*([A-Z][A-Z0-9_]*)\s*,\s*(STATUS_[A-Z_]+)\s*,\s*PROCESS_[A-Z_]+\s*,\s*&WorldSession::(\w+)/,
    );
    if (received) client.push({ name: received[1], status: received[2], handler: received[3] });
  }

  if (server.length < 500) throw new Error(`Parsed only ${server.length} server opcode handlers`);
  if (client.length < 700) throw new Error(`Parsed only ${client.length} client opcode handlers`);
  return { server, client };
}

/**
 * A handler the server will actually run; `Handle_NULL` is the placeholder for an opcode it
 * refuses. The status is not part of this test: `CMSG_AUTH_SESSION`, `CMSG_PING` and
 * `CMSG_KEEP_ALIVE` are declared `STATUS_NEVER` because the socket takes them before a session
 * exists to have a status, and reading the status as a refusal would call the login handshake
 * itself illegal.
 */
const accepts = (entry) => entry.handler !== "Handle_NULL";

/**
 * Every opcode name the core mentions outside its own opcode tables. A name that appears only in
 * `Opcodes.h` and `Opcodes.cpp` is declared and never used again: nothing in this build constructs
 * it, so the client needs no handler for it. Headers are scanned alongside implementation files
 * because 3.3.5 builds some packets in class declarations — `SMSG_EMOTE` is constructed only in a
 * header — and latin1 keeps a stray non-UTF-8 byte in a copyright line from failing the scan.
 */
async function scanCoreReferences(directory) {
  const names = new Set();
  let files = 0;

  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!/\.(?:cpp|h)$/.test(entry.name)) continue;
      if (entry.name === "Opcodes.cpp" || entry.name === "Opcodes.h") continue;
      files++;
      for (const match of (await readFile(path, "latin1")).matchAll(/\b(?:SMSG|MSG)_[A-Z0-9_]+\b/g)) {
        names.add(match[0]);
      }
    }
  };

  await walk(directory);
  if (files < 500) throw new Error(`Scanned only ${files} core sources under ${directory}`);
  return { names, files };
}

/**
 * Splits the protocol into the lists the completion plan is measured against: what the client can
 * receive and this build really sends, what it can receive but this build never sends, and what
 * the server accepts back.
 */
function classifyOpcodes({ server, client }, references, declared) {
  const inbound = new Map();
  for (const name of server) inbound.set(name, references.has(name) ? "live" : "dead");
  // MSG_ is two-way by construction: the server mirrors a movement opcode back to everyone in
  // range through the variable it arrived in rather than by name, so no name scan can see it, and
  // only 2 of the 103 are declared server-side. A wrong "live" here costs one backlog line; a
  // wrong "dead" costs a player frozen in place on everyone else's screen.
  //
  // Refusing an opcode from a client says nothing about whether the server sends it. Twenty-two
  // MSG_ opcodes are declared `Handle_NULL` — a client may not send them — and are built by the
  // core anyway: the answers to a ready check, and the whole family that tells everyone else in
  // the zone that somebody was rooted, teleported or had their speed changed. Reading refusal as
  // absence hid all of them from the report, which is the one thing this report exists to stop.
  for (const entry of client) {
    if (!entry.name.startsWith("MSG_")) continue;
    if (accepts(entry) || references.has(entry.name)) inbound.set(entry.name, "live");
  }

  const outbound = client.filter(accepts).map((entry) => entry.name);
  for (const name of [...inbound.keys(), ...outbound]) {
    if (!declared.has(name)) throw new Error(`${name} is dispatched but not declared in Opcodes.h`);
  }
  return { inbound, outbound };
}

function generateCoverage({ inbound, outbound }, files) {
  const reach = [...inbound]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, kind]) => `  ["${name}", "${kind}"],`)
    .join("\n");
  const sent = [...outbound]
    .sort((left, right) => left.localeCompare(right))
    .map((name) => `  "${name}",`)
    .join("\n");

  return `// Generated by tools/generate-protocol.mjs. Do not edit.
// Source SHA-256: ${sha256(handlerSource)}
// Reference scan: ${files} core sources outside Opcodes.h and Opcodes.cpp

import type { OpcodeName } from "./opcodes.js";

/**
 * \`live\` — the core names this opcode somewhere outside its own tables, so this build can send it
 * and the client needs a handler for it. \`dead\` — declared and never used again by this core.
 */
export type OpcodeReach = "live" | "dead";

/** What the client can receive: every opcode the core declares server-side, plus the two-way MSG_ family. */
export const INBOUND_OPCODES = new Map<OpcodeName, OpcodeReach>([
${reach}
]);

/** What the server accepts back: a real handler, and a status other than STATUS_NEVER. */
export const OUTBOUND_OPCODES = new Set<OpcodeName>([
${sent}
]);
`;
}

function generateOpcodes(entries) {
  const lines = entries.map(({ name, value }) => `  ${name}: 0x${value.toString(16).toUpperCase().padStart(3, "0")},`);
  return `// Generated by tools/generate-protocol.mjs. Do not edit.\n// Source SHA-256: ${sha256(opcodeSource)}\n\nexport const OPCODES = {\n${lines.join("\n")}\n} as const;\n\nexport type OpcodeName = keyof typeof OPCODES;\n\nexport const OPCODE_NAMES = new Map<number, OpcodeName>(\n  Object.entries(OPCODES).map(([name, value]) => [value, name as OpcodeName]),\n);\n`;
}

function generateUpdateFields(entries) {
  const version = updateFieldSource.match(/Auto generated for version\s+([^\r\n]+)/)?.[1]?.trim();
  if (version !== "3, 3, 5, 12340") throw new Error(`Unexpected update-field version: ${version}`);

  const records = Object.fromEntries(
    entries.map(({ name, ...metadata }) => [name, metadata]),
  );
  return `// Generated by tools/generate-protocol.mjs. Do not edit.\n// Protocol version: ${version}\n// Source SHA-256: ${sha256(updateFieldSource)}\n\nexport const UPDATE_FIELDS = ${JSON.stringify(records, null, 2)} as const;\n\nexport type UpdateFieldName = keyof typeof UPDATE_FIELDS;\n`;
}

/**
 * The members of an enum that names every value, in declaration order.
 *
 * Strict on purpose: a member without `= value` is an error rather than a skipped line, because
 * skipping it would silently shift the meaning of every code after it, and two names on one value
 * are an error because the reverse map (`*_NAMES`) could keep only one of them.
 */
export function parseValueEnum(source, declaration) {
  const entries = [];
  for (const raw of extractEnumBody(source, declaration).split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (!line) continue;
    const match = line.match(/^([A-Z][A-Z0-9_]*)\s*=\s*(0x[\dA-F]+|\d+)\s*,?$/i);
    if (!match) throw new Error(`${declaration}: "${line}" does not name its value`);
    entries.push({ name: match[1], value: Number.parseInt(match[2], 0) });
  }
  const byValue = new Map();
  const names = new Set();
  for (const { name, value } of entries) {
    if (names.has(name)) throw new Error(`${declaration}: ${name} is declared twice`);
    if (byValue.has(value)) throw new Error(`${declaration}: ${byValue.get(value)} and ${name} are both ${value}`);
    names.add(name);
    byValue.set(value, name);
  }
  return entries;
}

/** SHA-256 of one enum's body, line endings normalised, for the header of the file made from it. */
export function enumDigest(source, declaration) {
  return sha256(extractEnumBody(source, declaration).replace(/\r\n/g, "\n"));
}

/**
 * `enum ResponseCodes` (shared/SharedDefines.h): every result byte of SMSG_AUTH_RESPONSE,
 * SMSG_CHAR_CREATE/DELETE/RENAME/CUSTOMIZE/FACTION_CHANGE and SMSG_CHARACTER_LOGIN_FAILED.
 * Wow.exe 12340 indexes its own table of GlueStrings keys by these values — 104 of them, named
 * exactly as here (docs/implementation/probes/A6/exe-response-table.out.txt) — so the anchors below
 * are that table's, and a core that disagrees with it is refused.
 */
export function parseResponseCodes(source) {
  const declaration = "enum ResponseCodes";
  const entries = parseValueEnum(source, declaration);
  const value = (name) => entries.find((entry) => entry.name === name)?.value;
  if (entries.length < 104) throw new Error(`${declaration}: parsed only ${entries.length} codes`);
  const anchors = {
    AUTH_OK: 12,
    ACCOUNT_CREATE_FAILED: 42,
    CHAR_CREATE_SUCCESS: 47,
    CHAR_DELETE_SUCCESS: 71,
    CHAR_NAME_DECLENSION_DOESNT_MATCH_BASE_NAME: 103,
  };
  for (const [name, expected] of Object.entries(anchors)) {
    if (value(name) !== expected) {
      throw new Error(`${declaration}: ${name} is ${value(name)}, the 3.3.5a 12340 client's table has ${expected}`);
    }
  }
  return entries;
}

/**
 * `enum AuthResult` (authserver/Authentication/AuthCodes.h): the result byte of the authserver's
 * logon challenge and proof. The `LoginResult` enum beside it in the same header is not read.
 */
export function parseAuthResults(source) {
  const declaration = "enum AuthResult";
  const entries = parseValueEnum(source, declaration);
  const value = (name) => entries.find((entry) => entry.name === name)?.value;
  if (entries.length < 20) throw new Error(`${declaration}: parsed only ${entries.length} results`);
  const anchors = { WOW_SUCCESS: 0x00, WOW_FAIL_INCORRECT_PASSWORD: 0x05, WOW_FAIL_UNLOCKABLE_LOCK: 0x19 };
  for (const [name, expected] of Object.entries(anchors)) {
    if (value(name) !== expected) throw new Error(`${declaration}: ${name} is ${value(name)}, expected ${expected}`);
  }
  return entries;
}

export function generateResponseCodes(entries, digest) {
  const lines = entries.map(({ name, value }) => `  ${name}: ${value},`);
  return `// Generated by tools/generate-protocol.mjs. Do not edit.
// Source: src/server/shared/SharedDefines.h, enum ResponseCodes (SHA-256 ${digest})

export const RESPONSE_CODES = {
${lines.join("\n")}
} as const;

export type ResponseCodeName = keyof typeof RESPONSE_CODES;

export const RESPONSE_CODE_NAMES = new Map<number, ResponseCodeName>(
  Object.entries(RESPONSE_CODES).map(([name, value]) => [value, name as ResponseCodeName]),
);
`;
}

export function generateAuthResults(entries, digest) {
  const lines = entries.map(({ name, value }) => `  ${name}: 0x${value.toString(16).toUpperCase().padStart(2, "0")},`);
  return `// Generated by tools/generate-protocol.mjs. Do not edit.
// Source: src/server/authserver/Authentication/AuthCodes.h, enum AuthResult (SHA-256 ${digest})

export const AUTH_RESULTS = {
${lines.join("\n")}
} as const;

export type AuthResultName = keyof typeof AUTH_RESULTS;

export const AUTH_RESULT_NAMES = new Map<number, AuthResultName>(
  Object.entries(AUTH_RESULTS).map(([name, value]) => [value, name as AuthResultName]),
);
`;
}

/**
 * Writes one generated table into `directory`, and only when its text changed (10.11): a rewrite
 * with the same bytes still moved the file's mtime, and `tools/gateway-build-stale.mjs` compares
 * mtimes, so every `predev`/`prebuild` made the gateway build look stale and forced a rebuild for
 * nothing. With `check`, nothing is written and a difference is an error. Returns whether it wrote.
 */
export async function emitGenerated(directory, filename, content, { check = false } = {}) {
  const outputPath = join(directory, filename);
  const current = await readFile(outputPath, "utf8").catch(() => undefined);
  if (check) {
    if (current !== content) {
      throw new Error(`The ignored protocol-data/${filename} implementation is stale; run npm run protocol:generate`);
    }
    return false;
  }
  if (current === content) return false;
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, content, "utf8");
  return true;
}

function emit(filename, content) {
  return emitGenerated(generatedDir, filename, content, { check: checkOnly });
}

async function main() {
  const paths = [opcodePath, handlerPath, updateFieldPath, responseCodePath, authResultPath];
  await Promise.all(paths.map((path) => access(path))).catch(() => {
    throw new Error(
      `TrinityCore protocol headers were not found under ${coreDir}. `
      + "Set TRINITYCORE_DIR to a compatible TSWoW/TrinityCore checkout before build, typecheck or dev.",
    );
  });

  let responseCodeSource;
  let authResultSource;
  [opcodeSource, handlerSource, updateFieldSource, responseCodeSource, authResultSource] = await Promise.all(
    paths.map((path) => readFile(path, "utf8")),
  );

  const opcodes = parseOpcodes(opcodeSource);
  const updateFields = parseUpdateFields(updateFieldSource);
  const responseCodes = parseResponseCodes(responseCodeSource);
  const authResults = parseAuthResults(authResultSource);
  const { names: references, files } = await scanCoreReferences(serverDir);
  const { inbound, outbound } = classifyOpcodes(
    parseHandlers(handlerSource),
    references,
    new Set(opcodes.map((entry) => entry.name)),
  );
  await Promise.all([
    emit("opcodes.ts", generateOpcodes(opcodes)),
    emit("updateFields.ts", generateUpdateFields(updateFields)),
    emit("opcodeCoverage.ts", generateCoverage({ inbound, outbound }, files)),
    emit("responseCodes.ts", generateResponseCodes(
      responseCodes, enumDigest(responseCodeSource, "enum ResponseCodes"))),
    emit("authResults.ts", generateAuthResults(authResults, enumDigest(authResultSource, "enum AuthResult"))),
  ]);

  const live = [...inbound.values()].filter((kind) => kind === "live").length;
  console.log(`${checkOnly ? "Checked" : "Generated"} ${opcodes.length} opcodes and ${updateFields.length} update fields.`);
  console.log(`Response codes: ${responseCodes.length} (ResponseCodes). Auth results: ${authResults.length} (AuthResult).`);
  console.log(`Protocol implementations: ${generatedDir} (ignored by Git).`);
  console.log(`Inbound: ${live} live of ${inbound.size} declared. Outbound: ${outbound.length} accepted by the server.`);
}

/**
 * A script and a module: `node tools/generate-protocol.mjs` generates, an import (the generator's
 * own test) only gets the functions above. Real paths on both sides: started through a junction or
 * a symlink, argv[1] names the link while import.meta.url names its target, and comparing the two
 * as written skipped main() and exited 0 — a `protocol:check` that passed without checking.
 */
function startedAsScript() {
  if (!process.argv[1]) return false;
  const real = (path) => realpathSync.native(path);
  const same = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
  try {
    return same(real(process.argv[1]), real(fileURLToPath(import.meta.url)));
  } catch {
    return false;
  }
}
if (startedAsScript()) await main();
