// Read-only probe: for each C API name of line A1, say which layer answers it today.
// Run from F:\tswowRoot\WebClient:
//   NODE_OPTIONS=--max-old-space-size=4096 F:/tswowRoot/WebClient/.runtime/node/node.exe --import ./tools/register-test-sources.mjs <this file>
const base = "file:///F:/tswowRoot/WebClient/dist/code/browser/framexml/";
const seamMod = await import(base + "FrameXmlWorldSeam.js");
const neutralMod = await import(base + "FrameXmlNeutralApi.js");
const { FRAMEXML_SEAM_BINDINGS } = seamMod;
const { FRAMEXML_NEUTRAL_API } = neutralMod;
const neutral = new Map(FRAMEXML_NEUTRAL_API.map((row) => [row.name, row]));

const names = process.argv.slice(2).length ? process.argv.slice(2) : (await import("node:fs")).readFileSync(
  new URL("./names.txt", import.meta.url), "utf8").split(/\s+/).filter(Boolean);

for (const name of names) {
  const seam = Object.prototype.hasOwnProperty.call(FRAMEXML_SEAM_BINDINGS, name);
  const row = neutral.get(name);
  const neutralText = row
    ? `neutral(${row.group}:${row.values === undefined ? "lua" : JSON.stringify(row.values)})`
    : "";
  console.log(`${name.padEnd(34)} ${seam ? "SEAM " : "     "} ${neutralText}`);
}
console.log(`total seam names: ${Object.keys(FRAMEXML_SEAM_BINDINGS).length}; neutral rows: ${FRAMEXML_NEUTRAL_API.length}`);
