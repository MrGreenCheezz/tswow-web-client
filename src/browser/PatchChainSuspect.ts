/**
 * 22.10 ARC-2 S4b: where a load that cannot read its own 409 (an image decoded by TextureLoad.ts) reports the URL
 * that failed. One sink per JS realm: the page's is PatchChainChanged.ts `suspectPatchChainChange`, installed with
 * the watch (`installPatchChainWatch`); a renderer realm's queues the URL in RenderResults.ts `patchChainSuspects`
 * (RendererReports.ts `patchChainSuspectQueue`), which the page drains into that same function. Without a sink
 * (a page that never installed the watch) a report does nothing, which is what the unwatched function did.
 */

export type PatchChainSuspectSink = (url: string) => void;

let sink: PatchChainSuspectSink | undefined;

export function setPatchChainSuspectSink(next: PatchChainSuspectSink | undefined): void {
  sink = next;
}

export function reportPatchChainSuspect(url: string): void {
  sink?.(url);
}
