/**
 * 22.10 (12.14): the «Terrain: …» and «Environment: …» lines and their error notices, written for the resource clients
 * that draw. With the in-page renderer those are the page's (EnterWorld.ts); in worker mode they are the worker's,
 * whose messages arrive with its results (RenderWorkerSession.ts → `RenderWorkerResultSteps.acceptStatuses`), and the
 * page's own clients — which keep only what physics and the windows need — stay off the lines, so the lines never
 * flip between two sets of clients and an error is not noticed twice.
 */

import type { ClientRenderer } from "../ClientRenderer.js";
import type { RenderWorkerStatus, ResourceStatusLine } from "../RenderWorkerLoading.js";

export interface StatusLineElement {
  className: string;
  textContent: string | null;
}

export interface ResourceStatusTargets {
  readonly terrain: StatusLineElement;
  readonly environment: StatusLineElement;
  readonly notice: (message: string) => void;
}

const PREFIX: Readonly<Record<ResourceStatusLine, string>> = { terrain: "Terrain", environment: "Environment" };

function write(targets: ResourceStatusTargets, line: ResourceStatusLine, message: string, error: boolean): void {
  if (error) targets.notice(message);
  const element = targets[line];
  element.className = error ? "error" : "success";
  element.textContent = `${PREFIX[line]}: ${message}`;
}

/** A page client's message: written unless a worker draws the world (`renderer` is read per message). */
export function showPageResourceStatus(
  targets: ResourceStatusTargets, renderer: ClientRenderer | undefined, line: ResourceStatusLine,
  message: string, error: boolean,
): void {
  if (renderer?.renderWorker !== undefined) return;
  write(targets, line, message, error);
}

/** The worker's messages, in order. */
export function showWorkerResourceStatuses(targets: ResourceStatusTargets, statuses: readonly RenderWorkerStatus[]): void {
  for (const status of statuses) write(targets, status.line, status.message, status.error);
}
