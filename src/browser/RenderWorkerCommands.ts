/**
 * 22.10 ARC-2 S6b: a page command applied to the worker's renderer — the call the page made on RenderWorkerClient.ts,
 * made here with the cloned arguments. Only the methods RenderWorkerClientProtocol.ts lists are called; the ground
 * cover's client is the worker's own (the page sends whether it had one).
 */

import type { ClientRendererCommand } from "./ClientRenderer.js";
import type { GroundCoverClient } from "./GroundCover.js";
import { RENDER_WORKER_COMMANDS, type RenderCommand } from "./RenderWorkerClientProtocol.js";
import type { WorldRenderer3D } from "./WorldRenderer3D.js";

export type RenderCommandRenderer = Pick<WorldRenderer3D, ClientRendererCommand>;

export function isRendererCommand(method: string): method is ClientRendererCommand {
  return Object.hasOwn(RENDER_WORKER_COMMANDS, method);
}

export function applyRenderCommand(renderer: RenderCommandRenderer, command: RenderCommand,
  groundCover: (present: boolean) => GroundCoverClient | undefined): void {
  const method = command.method;
  if (!isRendererCommand(method)) throw new Error(`render worker: unknown command ${method}`);
  const args = command.args;
  if (method === "setGroundCover") {
    renderer.setGroundCover(groundCover(args[0] === true), args[1] as number | undefined, args[2] as boolean | undefined,
      args[3] as number | undefined);
    return;
  }
  (renderer[method] as (...values: unknown[]) => unknown).apply(renderer, args as unknown[]);
}
