import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mysqlBinary, worldserverConf } from "./paths.mjs";

/**
 * The GM console's three world-DB lists that no other dump carries: quests, `game_tele` and
 * game object templates (`data/gm-catalog.json`, read by `src/gateway/GmSearch.ts`).
 *
 * Items and creatures already have their dumps (`generate-item-metadata.mjs`,
 * `generate-creature-metadata.mjs`) and spells are Spell.dbc; these three only the console needs,
 * so they live in one file and one script. SELECT only, the same connection and locale rule as the
 * two dumps beside it.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = worldserverConf();
const mysql = mysqlBinary();
const output = resolve(root, "data/gm-catalog.json");
const locale = process.env.CLIENT_LOCALE ?? "ruRU";

const config = await readFile(configPath, "utf8");
const match = config.match(/^WorldDatabaseInfo\s*=\s*"([^"]+)"/m);
if (!match) throw new Error(`WorldDatabaseInfo is missing in ${configPath}`);
const [host, port, user, password, database] = match[1].split(";");
if (!host || !port || !user || password === undefined || !database) throw new Error("WorldDatabaseInfo is invalid");

/** Tab-separated rows of one query; text columns come back as HEX so a tab or newline in a name survives. */
function query(sql) {
  const result = spawnSync(mysql, [
    `--host=${host}`,
    `--port=${port}`,
    `--user=${user}`,
    `--database=${database}`,
    "--default-character-set=utf8",
    "--batch",
    "--raw",
    "--skip-column-names",
    `--execute=${sql}`,
  ], {
    encoding: "utf8",
    env: { ...process.env, MYSQL_PWD: password },
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(result.stderr || "mysql gm catalog query failed");
  return result.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => line.split("\t"));
}

const text = (hex) => Buffer.from(hex ?? "", "hex").toString("utf8");

const quests = query("SELECT q.ID,"
  + "HEX(COALESCE(NULLIF(l.Title,''),q.LogTitle)),"
  + "q.QuestLevel,q.MinLevel"
  + " FROM quest_template q"
  + ` LEFT JOIN quest_template_locale l ON l.ID=q.ID AND l.locale='${locale}'`
  + " ORDER BY q.ID")
  .map(([id, name, level, minLevel]) => [Number(id), text(name), Number(level), Number(minLevel)]);

// `game_tele` has no locale table: its names are what `.tele` takes, so they stay as stored.
const teleports = query("SELECT id,HEX(name),map,position_x,position_y,position_z FROM game_tele ORDER BY id")
  .map(([id, name, map, x, y, z]) => [Number(id), text(name), Number(map), Number(x), Number(y), Number(z)]);

const gameobjects = query("SELECT g.entry,"
  + "HEX(COALESCE(NULLIF(l.name,''),g.name)),"
  + "g.type,g.displayId"
  + " FROM gameobject_template g"
  + ` LEFT JOIN gameobject_template_locale l ON l.entry=g.entry AND l.locale='${locale}'`
  + " ORDER BY g.entry")
  .map(([entry, name, type, displayId]) => [Number(entry), text(name), Number(type), Number(displayId)]);

await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify({ version: 1, locale, quests, teleports, gameobjects }));
console.log(`Generated the GM catalog in ${output} (locale ${locale}): `
  + `${quests.length} quests, ${teleports.length} teleports, ${gameobjects.length} game objects`);
