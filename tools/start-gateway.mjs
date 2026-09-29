import "./env.mjs";

import { assertBuiltClientDataImplementations } from "./client-data.mjs";
import { verifyClientPack } from "./client-pack.mjs";
import { assertGatewayConfiguration } from "./check-config.mjs";

if (process.env.CLIENT_PACK_DIR) {
  const pack = await verifyClientPack(process.env.CLIENT_PACK_DIR, { hashes: false });
  if (!pack.ok) {
    throw new Error(
      `CLIENT_PACK_DIR is incomplete:\n`
        + `${pack.missing.map((path) => `- missing: ${path}`).join("\n")}`
        + `${pack.modified.map((path) => `\n- modified: ${path}`).join("")}`
        + `${pack.unexpected.map((path) => `\n- unexpected: ${path}`).join("")}`,
    );
  }
  console.log(`Client pack: ${pack.manifest.contentDigest} (${pack.manifest.fileCount} files)`);
}

assertGatewayConfiguration();
assertBuiltClientDataImplementations();
if (process.env.GATEWAY_RESTART_ON_PATCH === "1") {
  // Opt-in (.env.example): this process stays as a thin supervisor and forks the gateway, restarting
  // it after a settled TSWoW build when nobody is connected. See tools/gateway-supervisor.mjs.
  const { runGatewaySupervisor } = await import("./gateway-supervisor.mjs");
  await runGatewaySupervisor({ entry: new URL("../dist/code/gateway/main.js", import.meta.url) });
} else {
  await import("../dist/code/gateway/main.js");
}
