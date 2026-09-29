import { startGateway } from "./Gateway.js";
import { createGatewayConfiguration } from "./GatewayConfiguration.js";
import { formatPatchStatusLine, type ClientPatchChange } from "./PatchStatus.js";
import { patchChangeMessage, processSupervisorChannel, superviseGateway } from "./SupervisedGateway.js";

const configuration = await createGatewayConfiguration();
// `tools/start-gateway.mjs` forks this file with an IPC channel when GATEWAY_RESTART_ON_PATCH=1.
// Everything that talks to it (SupervisedGateway.ts) is inert in an ordinary `npm run gateway`.
const supervisor = configuration.options.supervised && typeof process.send === "function"
  ? processSupervisorChannel()
  : undefined;
const gateway = await startGateway({
  ...configuration.options,
  ...(supervisor ? { onClientPatchChange: (change: ClientPatchChange) => supervisor.send(patchChangeMessage(change)) } : {}),
});
console.log(`WebClient gateway listening on ws://${gateway.host}:${gateway.port}/auth and /world`);
// Which patch generation this process serves, in one line, once the child has read the disk. Not
// awaited: the port is already open and the line is news, not a precondition.
void gateway.patchStatus().then(
  (status) => console.log(formatPatchStatusLine(status)),
  (error: unknown) => console.warn(`Patch status unavailable: ${error instanceof Error ? error.message : String(error)}`),
);
let closing = false;
async function shutdown(code: number): Promise<void> {
  if (closing) return;
  closing = true;
  configuration.close();
  await gateway.close();
  process.exit(code);
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => { void shutdown(0); });
}

if (supervisor) superviseGateway(gateway, supervisor, { shutdown: (code) => { void shutdown(code); } });
