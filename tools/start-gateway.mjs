import "./env.mjs";

import { assertBuiltClientDataImplementations } from "./client-data.mjs";
import { assertGatewayConfiguration } from "./check-config.mjs";

assertGatewayConfiguration();
assertBuiltClientDataImplementations();
await import("../dist/code/gateway/main.js");
