import { poseEngineAvailability, poseEngineStatus, type PoseEngineAvailability } from "../PoseEngine.js";

/**
 * 10.18 (L10): where crowd poses run, in the diagnostics window ("Состояние клиента", O) under the
 * CPU full-frame line it explains, and in a freeze capture's metadata.
 *
 * A player on plain http at a public address gets no crowd pose worker: cross-origin isolation
 * exists only in a secure context, so the page's COOP/COEP headers are ignored there and the poses
 * run on the main thread (the plan measured −17…21 % FPS in a crowd on the owner's bench).
 * PoseEngine already decides and logs it once; this puts the answer where frame times are read.
 */

type NotOn = Exclude<PoseEngineAvailability["state"], "on">;

const WHY: Readonly<Record<NotOn, string>> = {
  off: "страница не изолирована (http не с 127.0.0.1: нужен https или приложение игрока)",
  "no-worker": "нет Web Workers",
  "no-sab": "нет SharedArrayBuffer/Atomics",
  query: "выключено параметром ?poseworker=0",
  failed: "воркер не создался",
};

/** The line for a state; `predicted` before any crowd asked for the engine (what it will decide). */
export function poseWorkerStatusLine(status: PoseEngineAvailability, predicted = false): string {
  const where = status.state === "on" ? "в воркере" : `в основном потоке — ${WHY[status.state]}`;
  return `Позы толпы: ${predicted ? "будут " : ""}${where}`;
}

/** The page's decision, or — until the first crowd — the same pure decision made from its globals now. */
function currentStatus(): { readonly status: PoseEngineAvailability; readonly predicted: boolean } {
  const status = poseEngineStatus();
  if (status !== undefined) return { status, predicted: false };
  return { status: poseEngineAvailability(globalThis as Parameters<typeof poseEngineAvailability>[0]), predicted: true };
}

/** For a freeze capture's metadata: the state, its reason when not "on", and whether it is a prediction. */
export function poseWorkerReport(): { readonly state: string; readonly reason?: string; readonly predicted: boolean } {
  const { status, predicted } = currentStatus();
  return status.state === "on" ? { state: status.state, predicted } : { state: status.state, reason: status.reason, predicted };
}

let line: HTMLParagraphElement | undefined;
let shown = "";

/**
 * Writes the line right after `anchor` (the CPU full-frame line), creating it on first use. Called
 * on the diagnostics window's half-second tick; the text is written only when it changes.
 */
export function showPoseWorkerStatus(anchor: HTMLElement): void {
  const { status, predicted } = currentStatus();
  const text = poseWorkerStatusLine(status, predicted);
  if (line === undefined) {
    line = document.createElement("p");
    line.id = "pose-worker-status";
    anchor.after(line);
  }
  if (text === shown) return;
  shown = text;
  line.className = status.state === "on" ? "muted" : "error";
  line.textContent = text;
}
