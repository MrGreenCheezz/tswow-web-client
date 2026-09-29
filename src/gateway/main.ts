import { startGateway } from "./Gateway.js";
import { createGatewayConfiguration } from "./GatewayConfiguration.js";
import { formatPatchStatusLine, type ClientPatchChange } from "./PatchStatus.js";
import { createShutdown, installProcessGuard } from "./ProcessGuard.js";
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
// One way out for every caller: the close runs once, and the process leaves with the highest code
// asked for, so a defect's 1 is not undone by the 0 of a Ctrl+C that was already closing.
const shutdown = createShutdown({
  close: async () => {
    configuration.close();
    await gateway.close();
  },
});
// Socket noise that escaped a listener is logged and survived; anything else is logged whole and
// closes the gateway with 1, within five seconds (ProcessGuard.ts). Not before `startGateway`: a
// gateway that cannot start has to fail the ordinary way, with the non-zero exit the supervisor
// watches for.
installProcessGuard({ shutdown: (code) => shutdown(code, 5_000) });
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => shutdown(0));
}

if (supervisor) superviseGateway(gateway, supervisor, { shutdown: (code) => shutdown(code) });
