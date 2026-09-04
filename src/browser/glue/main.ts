import { startGlue } from "./Bootstrap.js";
import { frontDoorGatewayOrigin } from "./FrontDoor.js";

/**
 * `glue.html` — the standalone dev entry for the GlueXML screens.
 *
 * Everything this file used to do lives in `Bootstrap.ts` now: since G6 the same screens are the
 * front door of `index.html`, and the only way the two pages cannot drift is for both to call the
 * one function. What is left here is the page's own contract — three elements and three query
 * parameters — plus the one thing this page cannot do, which is put the player into a world: there
 * is no renderer, no HUD and no `game` context behind it, so the enter-world button says so.
 */

const host = document.getElementById("glue-host");
const stage = document.getElementById("glue-stage");
const status = document.getElementById("glue-status");

if (host && stage) {
  const parameters = new URL(window.location.href).searchParams;
  const origin = frontDoorGatewayOrigin(window.location.search);
  void startGlue({
    host,
    stage,
    status,
    screen: parameters.get("screen"),
    fake: parameters.get("fake"),
    ...(origin ? { gatewayOrigin: origin } : {}),
  }).catch((error: unknown) => {
    console.error("[glue] интерфейс не загрузился", error);
  });
}
