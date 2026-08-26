import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mysqlBinary, worldserverConf } from "./paths.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = worldserverConf();
const mysql = mysqlBinary();
const output = resolve(root, "data/creatures.json");
const config = await readFile(configPath, "utf8");
const match = config.match(/^WorldDatabaseInfo\s*=\s*"([^"]+)"/m);
if (!match) throw new Error(`WorldDatabaseInfo is missing in ${configPath}`);
const [host, port, user, password, database] = match[1].split(";");
if (!host || !port || !user || password === undefined || !database) throw new Error("WorldDatabaseInfo is invalid");

/**
 * The realm's locale, which is the one the browser logs in with.
 *
 * `Login.ts` sends `ruRU` on the logon challenge, the authserver writes it to `account.locale` and
 * the worldserver reads it back and answers every quest query in it. Creature and item names take
 * the same path on the server — `QueryHandler.cpp` localises both — and this client never asked,
 * so it has been reading the English column out of `creature_template` while its quests arrived in
 * Russian. Pinned at generation time rather than per session, because these two tables are dumped
 * to a file rather than queried live; `CLIENT_LOCALE` moves both of them together.
 */
const locale = process.env.CLIENT_LOCALE ?? "ruRU";

// `LEFT JOIN`, and `NULLIF` on top of `COALESCE`: 27,252 of the dump's 29,925 creatures have a
// ruRU row, and a handful of those rows carry an empty string rather than no row at all. Either
// one has to fall back to the English column, or a boar with a blank localisation becomes a
// nameless boar.
const query = "SELECT ct.entry,"
  + "HEX(COALESCE(NULLIF(l.Name,''),ct.name)),"
  + "HEX(COALESCE(NULLIF(l.Title,''),ct.subname)),"
  + "ct.type,ct.family,ct.rank"
  + " FROM creature_template ct"
  + ` LEFT JOIN creature_template_locale l ON l.entry=ct.entry AND l.locale='${locale}'`
  + " ORDER BY ct.entry";
const result = spawnSync(mysql, [
  `--host=${host}`,
  `--port=${port}`,
  `--user=${user}`,
  `--database=${database}`,
  "--default-character-set=utf8",
  "--batch",
  "--raw",
  "--skip-column-names",
  `--execute=${query}`,
], {
  encoding: "utf8",
  env: { ...process.env, MYSQL_PWD: password },
  maxBuffer: 128 * 1024 * 1024,
});
if (result.status !== 0) throw new Error(result.stderr || "mysql creature metadata query failed");

const rows = result.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => {
  const [entry, name, subname, type, family, rank] = line.split("\t");
  return [
    Number(entry),
    Buffer.from(name ?? "", "hex").toString("utf8"),
    Buffer.from(subname ?? "", "hex").toString("utf8"),
    Number(type),
    Number(family),
    Number(rank),
  ];
});
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(rows));
console.log(`Generated metadata for ${rows.length} creature templates in ${output} (locale ${locale})`);
