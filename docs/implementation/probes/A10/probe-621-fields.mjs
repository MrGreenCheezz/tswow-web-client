// A10 / 6.21 (read-only): field names of the tables the animation questions need.
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const repo = process.cwd();
const { openDbcFile } = await import(pathToFileURL(resolve(repo, "tools/dbc.mjs")).href);
const { dbcDirectory } = await import(pathToFileURL(resolve(repo, "tools/paths.mjs")).href);
const directory = dbcDirectory();
console.log("dbc dir:", directory);
for (const table of ["AnimationData", "SpellVisual", "SpellVisualKit", "Spell", "Emotes"]) {
  const dbc = await openDbcFile(directory, table);
  console.log(`\n== ${table}: ${dbc.records} rows, ${dbc.fields} fields, recordSize ${dbc.recordSize}`);
  const names = dbc.fieldNames;
  const shown = table === "Spell"
    ? names.filter((name) => /SpellVisual|Attributes|ChannelInterrupt|Category|^ID$|Name_lang|Effect$|CastingTime|Duration/i.test(name))
    : names;
  console.log(shown.join(", "));
}
