/**
 * An opt-in listener for diagnostic timings from code that must not depend on the browser's frame
 * capture: the world packet loop here, the FrameXML step in the browser.
 *
 * Nothing listens unless a local recording (`O` → «Записать фризы») is running, so every probe on a
 * hot path is one module-variable check. The listener owns bounding and filtering; a probe only
 * says what happened and when (`performance.now()` terms).
 */
export type CaptureProbeListener = (kind: string, at: number, details: Readonly<Record<string, unknown>>) => void;

let listener: CaptureProbeListener | undefined;

/** Installs (or with `undefined` removes) the single listener; the recording that installs it removes it. */
export function setCaptureProbe(next: CaptureProbeListener | undefined): void {
  listener = next;
}

/** Whether a probe site should bother reading clocks at all. */
export function captureProbeActive(): boolean {
  return listener !== undefined;
}

export function captureProbe(kind: string, at: number, details: Readonly<Record<string, unknown>>): void {
  listener?.(kind, at, details);
}
