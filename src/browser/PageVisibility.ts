/**
 * 22.10 ARC-2 S6b: whether the page is hidden, wherever the asking code runs. The page answers `document.hidden`;
 * a render worker has no document and answers what the page last pushed (RenderWorkerProtocol.ts `pageHidden`).
 */

let pushedHidden = false;

/** The worker's side: the page's `document.hidden`, as pushed with the host values. */
export function setPushedPageHidden(hidden: boolean | undefined): void {
  pushedHidden = hidden === true;
}

export function pageHidden(): boolean {
  return typeof document !== "undefined" ? document.hidden : pushedHidden;
}
