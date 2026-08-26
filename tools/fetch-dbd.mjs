// Refreshes the vendored WoWDBDefs definitions under tools/dbd/.
//
// Run by hand when a table is added to tools/dbd-tables.mjs or when upstream corrects a layout.
// Nothing in the build touches the network.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DBD_TABLES } from "./dbd-tables.mjs";

const BASE = "https://raw.githubusercontent.com/wowdev/WoWDBDefs/master/definitions";
const target = resolve(dirname(fileURLToPath(import.meta.url)), "dbd");
await mkdir(target, { recursive: true });

let written = 0;
const missing = [];
for (const table of DBD_TABLES) {
  const response = await fetch(`${BASE}/${table}.dbd`);
  if (!response.ok) {
    missing.push(`${table} (HTTP ${response.status})`);
    continue;
  }
  const text = await response.text();
  // Definitions carry Windows line endings upstream; normalise so the parser sees one shape.
  await writeFile(join(target, `${table}.dbd`), text.replaceAll("\r\n", "\n"));
  written++;
}

console.log(`Fetched ${written} of ${DBD_TABLES.length} definitions into tools/dbd`);
if (missing.length > 0) {
  console.warn(`Not found upstream: ${missing.join(", ")}`);
  process.exitCode = 1;
}
