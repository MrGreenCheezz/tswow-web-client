// A5 probe: stock Bindings.xml commands that FrameXmlBinding.ts does not map to a WebClient action,
// grouped by header, with the runOnUp/hidden/debug/platform flags and the Lua body's first line.
// Reads only: impl/stock/Bindings.xml and src/browser/framexml/FrameXmlBinding.ts.
import { readFileSync } from "node:fs";

const xml = readFileSync("C:/Users/ADMINI~1/AppData/Local/Temp/claude/F--tswowRoot-WebClient/8691de39-2c7d-46b9-bb55-f8d1b969e99a/scratchpad/impl/stock/Bindings.xml", "utf8");
const source = readFileSync("F:/tswowRoot/WebClient/src/browser/framexml/FrameXmlBinding.ts", "utf8");

const rows = [];
let header = "";
const re = /<Binding\s+([^>]*)>([\s\S]*?)<\/Binding>/g;
for (const match of xml.matchAll(re)) {
  const attrs = Object.fromEntries([...match[1].matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  if (attrs.header) header = attrs.header;
  const line = xml.slice(0, match.index).split("\n").length;
  const body = match[2].trim().split("\n").map((s) => s.trim()).filter(Boolean);
  rows.push({
    name: attrs.name, header, line, hidden: attrs.hidden === "true", debug: attrs.debug === "true",
    platform: attrs.platform ?? "", runOnUp: attrs.runOnUp === "true", first: body[0] ?? "", body: body.join(" ").slice(0, 110),
  });
}

const mapped = new Set([...source.matchAll(/\["([A-Z0-9_]+)",\s*"[a-zA-Z0-9]+"\]/g)].map((m) => m[1]));
for (const m of source.matchAll(/numbered\("([A-Z0-9_]+)",\s*"[a-zA-Z0-9]+",\s*(\d+)\)/g)) {
  for (let i = 1; i <= Number(m[2]); i++) mapped.add(`${m[1]}${i}`);
}
mapped.add("TOGGLEGAMEMENU");

const missing = rows.filter((row) => !mapped.has(row.name));
console.log(`stock rows: ${rows.length}; mapped: ${rows.length - missing.length}; missing: ${missing.length}`);
const byHeader = new Map();
for (const row of missing) {
  if (!byHeader.has(row.header)) byHeader.set(row.header, []);
  byHeader.get(row.header).push(row);
}
for (const [key, list] of byHeader) {
  console.log(`\n[${key}] ${list.length}`);
  for (const r of list) {
    console.log(`  ${r.name}${r.runOnUp ? " (runOnUp)" : ""}${r.hidden ? " (hidden)" : ""}${r.debug ? " (debug)" : ""}${r.platform ? ` (${r.platform})` : ""} @${r.line}: ${r.body}`);
  }
}
