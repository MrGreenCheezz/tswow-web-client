import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDbcFile } from "./dbc.mjs";
import { dbcDirectory, mysqlBinary, worldserverConf } from "./paths.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataset = dbcDirectory();
const configPath = worldserverConf();
const mysql = mysqlBinary();
const output = resolve(root, "data/items.json");

const displayIcons = await dbcStrings("ItemDisplayInfo", "InventoryIcon");
const spellIcons = await dbcStrings("SpellIcon", "TextureFilename");
const iconIds = new Map([...spellIcons].map(([id, path]) => [path.slice(path.lastIndexOf("\\") + 1).toLowerCase(), id]));

/**
 * The realm's locale, and the same decision `generate-creature-metadata.mjs` makes.
 *
 * One rule for both tables on purpose: they are dumped by two scripts, read by two gateway modules
 * and shown by two dozen surfaces, and two different habits here would be two different answers to
 * "why is this name in English" for the rest of the project.
 */
const locale = process.env.CLIENT_LOCALE ?? "ruRU";

const config = await readFile(configPath, "utf8");
const match = config.match(/^WorldDatabaseInfo\s*=\s*"([^"]+)"/m);
if (!match) throw new Error(`WorldDatabaseInfo is missing in ${configPath}`);
const [host, port, user, password, database] = match[1].split(";");
if (!host || !port || !user || password === undefined || !database) throw new Error("WorldDatabaseInfo is invalid");

const result = spawnSync(mysql, [
  `--host=${host}`,
  `--port=${port}`,
  `--user=${user}`,
  `--database=${database}`,
  "--default-character-set=utf8",
  "--batch",
  "--raw",
  "--skip-column-names",
  // 38,412 of the dump's 38,609 items carry a ruRU row; `NULLIF` covers the ones whose row is
  // there but empty, which would otherwise be a nameless item rather than an English one.
  "--execute=SELECT it.entry,"
    + "HEX(COALESCE(NULLIF(l.Name,''),it.name)),"
    + "it.displayid,it.Quality,it.InventoryType,it.stackable"
    + " FROM item_template it"
    + ` LEFT JOIN item_template_locale l ON l.ID=it.entry AND l.locale='${locale}'`
    + " ORDER BY it.entry",
], {
  encoding: "utf8",
  env: { ...process.env, MYSQL_PWD: password },
  maxBuffer: 128 * 1024 * 1024,
});
if (result.status !== 0) throw new Error(result.stderr || "mysql item metadata query failed");

const rows = result.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => {
  const [entry, name, displayId, quality, inventoryType, stackable] = line.split("\t");
  const display = Number(displayId);
  const iconName = displayIcons.get(display)?.toLowerCase() ?? "";
  return [
    Number(entry),
    Buffer.from(name ?? "", "hex").toString("utf8"),
    display,
    Number(quality),
    Number(inventoryType),
    Number(stackable),
    iconIds.get(iconName) ?? 0,
  ];
});
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(rows));
console.log(`Generated metadata for ${rows.length} item templates in ${output} (locale ${locale})`);

/** id -> string, for the two tables that only contribute an icon path. */
async function dbcStrings(table, field) {
  const dbc = await openDbcFile(dataset, table);
  const result = new Map();
  for (const row of dbc.rows()) {
    const value = dbc.string(row, field, 0).replaceAll("/", "\\");
    if (value) result.set(dbc.id(row), value);
  }
  return result;
}
