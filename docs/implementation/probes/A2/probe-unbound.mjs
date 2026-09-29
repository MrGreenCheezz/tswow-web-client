// A2 (read-only): for each stock file a line will add to the vertical TOC, which global functions
// it calls that (a) no stock file defines and (b) src/browser never mentions -> certainly unbound;
// and which are only mentioned (manual check). Usage: node probe-unbound.mjs File1.lua File2.xml ...
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const stock = "C:/Users/ADMINI~1/AppData/Local/Temp/claude/F--tswowRoot-WebClient/8691de39-2c7d-46b9-bb55-f8d1b969e99a/scratchpad/impl/stock";
const srcDirs = ["F:/tswowRoot/WebClient/src/browser/framexml", "F:/tswowRoot/WebClient/src/browser/ui/framexml_compat", "F:/tswowRoot/WebClient/src/browser/glue"];

const LUA = new Set(("and break do else elseif end false for function if in local nil not or repeat return then true until while "
  + "print type tostring tonumber pairs ipairs next select unpack rawget rawset rawequal setmetatable getmetatable pcall xpcall error assert "
  + "string table math os bit tinsert tremove wipe format strlen strsub strfind strmatch gsub gmatch strupper strlower strrep strbyte strchar "
  + "strsplit strjoin strtrim strconcat min max abs floor ceil sqrt sin cos atan atan2 random mod date time getn sort concat "
  + "hooksecurefunc securecall issecure geterrorhandler seterrorhandler CreateFrame GetTime tContains").split(" "));

const defined = new Set();
for (const file of readdirSync(stock)) {
  if (!/\.(lua)$/i.test(file)) continue;
  const text = readFileSync(join(stock, file), "utf8");
  for (const m of text.matchAll(/^\s*function\s+([A-Za-z_][\w]*)/gm)) defined.add(m[1]);
  for (const m of text.matchAll(/^\s*([A-Za-z_][\w]*)\s*=/gm)) defined.add(m[1]);
  for (const m of text.matchAll(/_G\.([A-Za-z_]\w*)\s*=/g)) defined.add(m[1]);
  for (const m of text.matchAll(/_G\[\s*"([^"]+)"\s*\]\s*=/g)) defined.add(m[1]);
}
let src = "";
for (const dir of srcDirs) for (const file of readdirSync(dir)) if (/\.ts$/.test(file)) src += `\n${readFileSync(join(dir, file), "utf8")}`;

for (const name of process.argv.slice(2)) {
  const path = join(stock, name);
  if (!existsSync(path)) { console.log(`== ${name}: NOT DOWNLOADED`); continue; }
  const text = readFileSync(path, "utf8");
  const local = new Set();
  for (const m of text.matchAll(/^\s*(?:local\s+)?function\s+([A-Za-z_]\w*)/gm)) local.add(m[1]);
  for (const m of text.matchAll(/^\s*local\s+([A-Za-z_][\w, ]*)\s*=/gm)) for (const n of m[1].split(",")) local.add(n.trim());
  const called = new Map();
  for (const m of text.matchAll(/(?<![.:\w"'])([A-Za-z_]\w*)\s*\(/g)) {
    const n = m[1];
    if (LUA.has(n) || local.has(n)) continue;
    called.set(n, (called.get(n) ?? 0) + 1);
  }
  const absent = [];
  const mentioned = [];
  for (const [n, count] of [...called].sort()) {
    if (defined.has(n) && !text.includes(`function ${n}`) && !new RegExp(`^\\s*${n}\\s*=`, "m").test(text)) continue; // some other stock file defines it
    if (new RegExp(`\\b${n}\\b`).test(src)) mentioned.push(`${n}x${count}`);
    else absent.push(`${n}x${count}`);
  }
  console.log(`== ${name}`);
  console.log(`  ABSENT from src (${absent.length}): ${absent.join(" ")}`);
  console.log(`  mentioned in src (${mentioned.length}): ${mentioned.join(" ")}`);
}
