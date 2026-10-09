import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { interfaceDirectory } from "./paths.mjs";
import { clientDataImplementationPath, ensureClientDataDirectory } from "./client-data.mjs";

/**
 * Emits the ignored local `src/generated/client-data/classIcons.ts` implementation from the
 * user's configured `Interface/FrameXML/Constants.lua`. The tracked module is a data-free facade.
 *
 * The class portrait in the player frame picked its cell out of a table written by hand: four
 * columns of 64 pixels over a 256x256 sheet, ten cells, in an order transcribed from the original
 * FrameXML. Both halves of that are exactly what tswow rewrites the moment any module gives a
 * class an icon. `ClassIcon.ts:33-40` redraws all three class sheets as 512x512, `:71-72` places
 * cell N at `((N%8)*64, floor(N/8)*64)`, and `setIcon` (`ClassUISettings.ts:196-202`) writes the
 * new fractions back into `CLASS_ICON_TCOORDS` — for the stock ten as well, in 0.125 steps.
 *
 * So the cells are read rather than transcribed, and read from the *patched* FrameXML, which is
 * the copy that agrees with the *patched* sheet. The values are fractions of the image, which is
 * why nothing here needs to know how big the sheet is: the browser multiplies them by the size of
 * the picture it actually decoded.
 *
 * The key is `ChrClasses.Filename` — `WARRIOR`, `DEATHKNIGHT` — because that is what tswow writes
 * (`` `["${this.owner.Filename}"] = …` ``) and what the original file already used. Turning a
 * class id into that token is the gateway's job, through `/dbc/character-creation`; a table of ids
 * would be wrong here, since a custom class has an id this dataset does not know yet.
 *
 * The Lua is read as text rather than executed, the same way `generate-global-strings.mjs` reads
 * `GlobalStrings.lua` beside it.
 *
 * 9.05: the same file's `RAID_CLASS_COLORS` and `CLASS_SORT_ORDER` too. 3.3.5 has no DBC column for
 * a class colour — the client's colour is that Lua literal — and tswow writes its classes into it
 * (`["HERO"] = { r = 0.85 , g = 0.64 , b = 0.25 },` on this dataset), so a frame drawn outside the
 * Lua gets the colour the Lua frames get. `#rrggbb` by `Math.round(v * 255)`, which reproduces the
 * compiled table of the stock ten exactly.
 */

/** `["HERO"] = { r = 0.85 , g = 0.64 , b = 0.25 },` — spaces before commas included. */
const COLOR_ENTRY = /\["([A-Z0-9_]+)"\]\s*=\s*\{\s*r\s*=\s*([0-9.]+)\s*,\s*g\s*=\s*([0-9.]+)\s*,\s*b\s*=\s*([0-9.]+)\s*,?\s*\}/g;

/** The `{ … }` block that follows `NAME = `, or undefined. */
function block(source, name) {
  const match = new RegExp(`^\\s*${name}\\s*=\\s*\\{`, "m").exec(source);
  if (!match) return undefined;
  // Both tables end with "};"; their entries end with "}," or a bare string, never "};".
  const close = source.indexOf("};", match.index);
  return close < 0 ? undefined : source.slice(match.index, close);
}

const hex = (value) => Math.round(Math.min(1, Math.max(0, value)) * 255).toString(16).padStart(2, "0");

/** `RAID_CLASS_COLORS` as `#rrggbb` by token, and `CLASS_SORT_ORDER`, read from Constants.lua text. */
export function parseClassColors(source) {
  const colors = new Map();
  const colorBlock = block(source, "RAID_CLASS_COLORS");
  if (colorBlock) {
    for (const match of colorBlock.matchAll(COLOR_ENTRY)) {
      const [, token, r, g, b] = match;
      if (!colors.has(token)) colors.set(token, `#${hex(Number(r))}${hex(Number(g))}${hex(Number(b))}`);
    }
  }
  const order = [];
  const orderBlock = block(source, "CLASS_SORT_ORDER");
  if (orderBlock) for (const match of orderBlock.matchAll(/"([A-Z0-9_]+)"/g)) order.push(match[1]);
  return { colors, order };
}

const main = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (main) await generate();

async function generate() {
const outputPath = clientDataImplementationPath("classIcons");
const checkOnly = process.argv.includes("--check");

/** `["WARRIOR"] = {0, 0.25, 0, 0.25},` — left, right, top, bottom, as fractions of the sheet. */
const ENTRY = /^\["([A-Z0-9_]+)"\]\s*=\s*\{\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*\}/;

const source = await readFile(join(interfaceDirectory(), "FrameXML", "Constants.lua"), "utf8");

const start = source.indexOf("CLASS_ICON_TCOORDS");
if (start < 0) throw new Error("Constants.lua has no CLASS_ICON_TCOORDS table");
const end = source.indexOf("};", start);
if (end < 0) throw new Error("CLASS_ICON_TCOORDS is not closed");

const cells = new Map();
for (const line of source.slice(start, end).split("\n")) {
  const match = ENTRY.exec(line.trim());
  if (!match) continue;
  const [, token, left, right, top, bottom] = match;
  // The first assignment wins, as it would in Lua load order.
  if (!cells.has(token)) cells.set(token, [Number(left), Number(right), Number(top), Number(bottom)]);
}

if (cells.size === 0) throw new Error("CLASS_ICON_TCOORDS yielded no classes — the format changed");
const { colors, order } = parseClassColors(source);
if (colors.size === 0) console.warn("Constants.lua: RAID_CLASS_COLORS yielded no colours; classColor keeps its compiled table");

const lines = [];
lines.push("// Generated by tools/generate-class-icons.mjs from the dataset's own");
lines.push("// Interface/FrameXML/Constants.lua. Do not edit by hand; run");
lines.push("// `npm run classicons:generate`. This local implementation is ignored by Git.");
lines.push("//");
lines.push("// Where each class's icon sits on the three class sheets, as fractions of the sheet — the");
lines.push("// same numbers the original client's own frames read, and the ones tswow rewrites when a");
lines.push("// module stitches an icon for a class of its own.");
lines.push("");
lines.push("export const CLASS_ICON_DATA_AVAILABLE = true as const;");
lines.push("");
lines.push(`// ${cells.size} classes, keyed by ChrClasses.Filename.`);
lines.push("export const CLASS_ICON_TCOORDS: Readonly<Record<string, {");
lines.push("  left: number; right: number; top: number; bottom: number;");
lines.push("}>> = {");
for (const [token, [left, right, top, bottom]] of cells) {
  lines.push(`  ${JSON.stringify(token)}: { left: ${left}, right: ${right}, top: ${top}, bottom: ${bottom} },`);
}
lines.push("};");
lines.push("");
lines.push(`// RAID_CLASS_COLORS, ${colors.size} classes: #rrggbb by ChrClasses.Filename, Math.round(v * 255).`);
lines.push("export const CLASS_COLOR_DATA: Readonly<Record<string, string>> = {");
for (const [token, color] of colors) lines.push(`  ${JSON.stringify(token)}: ${JSON.stringify(color)},`);
lines.push("};");
lines.push("");
lines.push("// CLASS_SORT_ORDER, as the dataset's FrameXML lists it (MAX_CLASSES is its length).");
lines.push(`export const CLASS_SORT_ORDER_DATA: readonly string[] = ${JSON.stringify(order)};`);
lines.push("");

const text = lines.join("\n");
const existing = await readFile(outputPath, "utf8").catch(() => "");
if (checkOnly) {
  if (existing !== text) {
    console.error("The ignored class-icons implementation is out of date; run `npm run classicons:generate`");
    process.exit(1);
  }
  console.log(`The ignored class-icons implementation is up to date: ${cells.size} class icon cells`);
} else {
  ensureClientDataDirectory();
  await writeFile(outputPath, text, "utf8");
  console.log(`Generated ignored client-data/classIcons.ts: ${cells.size} class icon cells, ${colors.size} class colours`);
}
}
