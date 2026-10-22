/**
 * 22.10 (12.14): where the page's warm-up sends a model (AssetWarmup.ts `SessionAssetWarmup`, the spell-visual warm in
 * EnterWorld.ts). With the in-page renderer the page's environment client draws, so that is where a warmed model goes.
 * In worker mode it goes to the worker's client (RenderWorkerModelWarmup.ts): each path once, again only with a higher
 * priority, and nothing comes back here — the page neither downloads nor decodes it. The renderer is read per call, so
 * a fallback to the in-page renderer sends the next asks to the page's client again.
 */

import type { ClientRenderer } from "../ClientRenderer.js";
import type { EnvironmentClient, EnvironmentModel, ModelLoadPriority } from "../Terrain.js";

const RANK: Readonly<Record<ModelLoadPriority, number>> = { background: 0, normal: 1, critical: 2 };

export type WarmModelTarget = Pick<EnvironmentClient, "model" | "baseUrl">;

export function warmModelTarget(
  environment: Pick<EnvironmentClient, "model" | "baseUrl">,
  renderer: () => ClientRenderer | undefined,
): WarmModelTarget {
  const forwarded = new Map<string, ModelLoadPriority>();
  return {
    get baseUrl(): string { return environment.baseUrl; },
    model(name: string, priority: ModelLoadPriority = "normal"): EnvironmentModel | undefined {
      const worker = renderer()?.renderWorker;
      if (worker === undefined) return environment.model(name, priority);
      const sent = forwarded.get(name);
      if (sent === undefined || RANK[priority] > RANK[sent]) {
        forwarded.set(name, priority);
        worker.warmModel(name, priority);
      }
      return undefined;
    },
  };
}
