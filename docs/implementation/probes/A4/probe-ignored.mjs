// Read-only probe for 5.29: find `if (packet.opcode === OPCODES.NAME)` branches in WorldClient.ts whose
// body has no observable effect (only `return true`, or a bare parse call and `return true`).
// Usage: node probe-ignored.mjs  (from anywhere; reads the source by absolute path)
import { readFileSync } from "node:fs";

const source = readFileSync("F:/tswowRoot/WebClient/src/world/WorldClient.ts", "utf8");
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const results = [];
const opener = /if \(packet\.opcode === OPCODES\.([A-Z0-9_]+)((?:\s*\|\|\s*packet\.opcode === OPCODES\.[A-Z0-9_]+)*)\)\s*\{/g;
let match;
while ((match = opener.exec(source)) !== null) {
  const names = [match[1], ...[...match[2].matchAll(/OPCODES\.([A-Z0-9_]+)/g)].map((entry) => entry[1])];
  let depth = 1;
  let index = opener.lastIndex;
  while (depth > 0 && index < source.length) {
    const ch = source[index++];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
  }
  const body = stripComments(source.slice(opener.lastIndex, index - 1)).replace(/\s+/g, " ").trim();
  const line = source.slice(0, match.index).split("\n").length;
  results.push({ names, body, line });
}

const bare = results.filter((entry) => /^(return true;?|(const [a-zA-Z]+ = )?parse[A-Za-z]+\([^;]*\);? return true;?)$/.test(entry.body));
console.log(`branches scanned: ${results.length}; bare (no effect): ${bare.length}`);
for (const entry of bare) console.log(`${entry.line}\t${entry.names.join(",")}\t${entry.body.slice(0, 90)}`);
