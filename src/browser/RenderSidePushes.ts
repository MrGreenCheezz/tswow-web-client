/**
 * 22.10 ARC-2 S4b: the renderer's half of the page state pushed in RenderInputs.ts — the render switches and the
 * gateway cache generation onto this realm's module state (read by ModelBuild, the particles, the local lights,
 * the terrain splat, ground cover, horizon and terrain clients), and the frame-budget flag onto a sensor of the
 * renderer's own. Each is applied when its revision moves. In the page the module state is the page's own, so an
 * apply writes back the values already there, and the page host has no sensor of its own.
 */

import type { FrameBudgetProbe } from "./FrameBudgetProbe.js";
import { applyGatewayGenerationPush } from "./GatewayGeneration.js";
import type { RenderInputs } from "./RenderInputs.js";
import { applyRenderSwitchesPush } from "./RenderSwitches.js";

export class RenderSidePushes {
  #switchesRevision = -1;
  #generationRevision = -1;

  apply(inputs: RenderInputs, ownProbe: FrameBudgetProbe | undefined): void {
    const switches = inputs.switches;
    if (switches !== undefined && switches.revision !== this.#switchesRevision) {
      this.#switchesRevision = switches.revision;
      applyRenderSwitchesPush(switches);
    }
    const generation = inputs.gatewayGeneration;
    if (generation !== undefined && generation.revision !== this.#generationRevision) {
      this.#generationRevision = generation.revision;
      applyGatewayGenerationPush(generation);
    }
    // `setEnabled` resets, so only a change of the flag reaches it.
    if (ownProbe !== undefined && ownProbe.enabled !== inputs.frameBudgetProbe) ownProbe.setEnabled(inputs.frameBudgetProbe);
  }
}
