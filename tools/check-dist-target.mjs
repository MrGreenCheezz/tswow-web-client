// Checks a production build for class members that esbuild lowered below ES2022 (MEM-1,
// docs/implementation/line-P-P1.ru.md P1-01): the `#private` helpers (`__privateGet/Set/Add/Method`,
// recognised by their error texts — the "Cannot " prefix is joined inside the helper at run time, so
// the literal "Cannot read from private field" never appears) and the `__publicField` helper of class
// fields. A build made with `build.target: "es2022"` (vite.config.mjs) has none of them.
//
//   node tools/check-dist-target.mjs [dir ...]      default: dist/web of this repository
//
// Prints every .js file with a finding and the number of matches; exit code 1 when anything is found,
// 2 when a directory cannot be read (a missing build must not pass as a clean one), 0 otherwise.
// After `npm run build` and in the G-P1/G-P2 gates:
//   node tools/check-dist-target.mjs dist/web dist/electron/resources/app/web
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Texts of esbuild's private-member helpers, as they stay in minified and unminified output alike. */
export const LOWERED_MEMBER_NEEDLES = Object.freeze([
  "read from private field",
  "write to private field",
  "Cannot add the same private member more than once",
  "access private method",
]);

/**
 * esbuild's `__publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value)`,
 * minified (`(e,t,n)=>X(e,typeof t!="symbol"?t+"":t,n)`) or not. It carries no text of its own.
 */
export const PUBLIC_FIELD_HELPER = Object.freeze({
  name: "public class field helper",
  pattern: /\(\s*([\w$]+)\s*,\s*([\w$]+)\s*,\s*([\w$]+)\s*\)\s*=>\s*[\w$]+\(\s*\1\s*,\s*typeof\s+\2\s*!==?\s*"symbol"\s*\?\s*\2\s*\+\s*""\s*:\s*\2\s*,\s*\3\s*\)/g,
});

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function javaScriptFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".js")) files.push(join(entry.parentPath ?? entry.path, entry.name));
  }
  return files.sort();
}

function occurrences(text, needle) {
  let count = 0;
  for (let index = text.indexOf(needle); index >= 0; index = text.indexOf(needle, index + needle.length)) count++;
  return count;
}

/** Matches per helper in one file's text; only helpers that occur are listed. */
export function loweredMembersIn(text) {
  const matches = {};
  for (const needle of LOWERED_MEMBER_NEEDLES) {
    const count = occurrences(text, needle);
    if (count > 0) matches[needle] = count;
  }
  const publicFields = [...text.matchAll(PUBLIC_FIELD_HELPER.pattern)].length;
  if (publicFields > 0) matches[PUBLIC_FIELD_HELPER.name] = publicFields;
  return matches;
}

/**
 * Every .js file under the directories (recursively) that contains lowered class-member helpers:
 * `[{ file, count, matches: { helper: count } }]`, sorted by path. A directory that cannot be read throws.
 */
export async function findLoweredPrivateMembers(...directories) {
  const found = [];
  for (const directory of directories) {
    for (const file of await javaScriptFiles(directory)) {
      const matches = loweredMembersIn(await readFile(file, "utf8"));
      const count = Object.values(matches).reduce((sum, value) => sum + value, 0);
      if (count > 0) found.push({ file, count, matches });
    }
  }
  return found;
}

async function main(argv) {
  const directories = argv.length ? argv.map((directory) => resolve(directory)) : [join(repository, "dist", "web")];
  let findings = 0;
  for (const directory of directories) {
    try {
      if (!(await stat(directory)).isDirectory()) throw new Error("not a directory");
    } catch (error) {
      console.error(`check-dist-target: cannot read ${directory}: ${error instanceof Error ? error.message : error}`);
      return 2;
    }
    const files = await javaScriptFiles(directory);
    const found = await findLoweredPrivateMembers(directory);
    const total = found.reduce((sum, entry) => sum + entry.count, 0);
    console.log(`${directory}: lowered class members in ${found.length} of ${files.length} JS files (${total} matches)`);
    for (const entry of found) {
      const detail = Object.entries(entry.matches).map(([needle, count]) => `${needle} ${count}`).join(", ");
      console.log(`  ${relative(directory, entry.file)}: ${entry.count} (${detail})`);
    }
    findings += found.length;
  }
  if (findings > 0) console.log("build.target is below ES2022 for these files: see vite.config.mjs BUILD_TARGET (MEM-1)");
  return findings > 0 ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
