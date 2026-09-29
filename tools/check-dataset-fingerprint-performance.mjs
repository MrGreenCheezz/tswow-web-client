import assert from "node:assert/strict";
import { fingerprintArchives, fingerprintDbc } from "../dist/code/gateway/DatasetFingerprint.js";
import { clientDirectory, dbcDirectory } from "./paths.mjs";

// Run separately from the parallel correctness suite: the disk's other users are not a
// fingerprint regression. Missing local inputs fail explicitly instead of claiming a pass.
const dataset = dbcDirectory();
const client = clientDirectory();
let bestMs = Infinity;
let dbc;
let archives;
for (let attempt = 0; attempt < 5; attempt++) {
  const start = performance.now();
  dbc = await fingerprintDbc(dataset);
  archives = await fingerprintArchives(client);
  bestMs = Math.min(bestMs, performance.now() - start);
}
assert.ok(dbc.files > 100 && archives.files > 100, "requires the complete local dataset and client");
assert.ok(dbc.files + archives.files < 2_000, "the watched input set must stay bounded");
console.log(JSON.stringify({ bestMs, budgetMs: 200, datasetFiles: dbc.files, clientFiles: archives.files }));
assert.ok(bestMs < 200, `fingerprint ${bestMs.toFixed(1)} ms exceeds the isolated 200 ms budget`);
