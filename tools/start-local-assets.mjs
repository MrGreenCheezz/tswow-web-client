// stdout is a framed binary protocol; startup and generator diagnostics go to stderr.
console.log = console.info = console.warn = (...values) => console.error(...values);
process.env.WEBCLIENT_SKIP_ENV = "1";
process.env.MODULE_UI_WRITE = "0";

// A standalone launch must fail closed instead of discovering a developer installation.
for (const name of ["CLIENT_PACK_DIR", "TSWOW_DATASET", "DBC_DIR", "MAPS_DIR", "VMAPS_DIR", "MODULE_DIRS",
  "CREATURE_METADATA_FILE", "ITEM_METADATA_FILE", "VISUAL_DBC_DIR", "TEMP", "TMP"]) {
  if (!process.env[name]) throw new Error(`Local asset provider requires ${name}`);
}
const { assertBuiltClientDataImplementations } = await import("./client-data.mjs");
const { verifyClientPack } = await import("./client-pack.mjs");
const pack = await verifyClientPack(process.env.CLIENT_PACK_DIR, { hashes: false });
if (!pack.ok) throw new Error("Installed client pack is incomplete or modified");
assertBuiltClientDataImplementations();
const { prepareLocalPatches } = await import("./prepare-local-patches.mjs");
const patches = await prepareLocalPatches();

const { createGatewayConfiguration } = await import("../dist/code/gateway/GatewayConfiguration.js");
const { createGatewayAssetHandler } = await import("../dist/code/gateway/Gateway.js");
const { LOCAL_ASSET_ORIGIN, serveLocalAssets } = await import("../dist/code/gateway/LocalAssetStdio.js");
// This worker reads one immutable RuntimeBundle version. Archive writes still make the next
// request poll through fs.watch, while a longer fallback avoids a full archive walk directly
// after a slow local decode has finished.
const LOCAL_ASSET_FALLBACK_POLL_MS = 10_000;
let configuration;
try {
  configuration = await createGatewayConfiguration();
  const assets = await createGatewayAssetHandler({ ...configuration.options,
    allowedOrigins: [LOCAL_ASSET_ORIGIN], moduleWrite: false, datasetPollMs: LOCAL_ASSET_FALLBACK_POLL_MS,
    ...(patches ? { clientAddons: patches.addons } : {}) });
  await serveLocalAssets(process.stdin, process.stdout, assets,
    { activeDbcDirectory: process.env.DBC_DIR });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  configuration?.close();
}
// EOF means the owner left. Do not retain watcher/generator handles after that point.
process.exit(process.exitCode ?? 0);
