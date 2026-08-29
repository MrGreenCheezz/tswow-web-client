/**
 * Coordinates the one formal render benchmark that may own the live renderer.
 *
 * This module deliberately has no renderer or loop dependency. The returned
 * token is checked by identity, so a structurally similar object cannot claim
 * ownership.
 */

export interface FormalRenderBenchmarkExclusiveLease {
  readonly id: number;
  readonly release: () => void;
}

let activeLease: Readonly<FormalRenderBenchmarkExclusiveLease> | undefined;
let nextFormalRenderBenchmarkExclusiveLeaseId = 1;

function allocateLeaseId(): number {
  if (!Number.isSafeInteger(nextFormalRenderBenchmarkExclusiveLeaseId)
    || nextFormalRenderBenchmarkExclusiveLeaseId >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError("formal render benchmark lease id exhausted");
  }
  const id = nextFormalRenderBenchmarkExclusiveLeaseId;
  nextFormalRenderBenchmarkExclusiveLeaseId++;
  return id;
}

/** Claims the renderer exclusively for one formal benchmark owner. */
export function acquireFormalRenderBenchmarkExclusiveLease(): Readonly<FormalRenderBenchmarkExclusiveLease> {
  if (activeLease !== undefined) {
    throw new Error("formal render benchmark lease is already active");
  }
  const id = allocateLeaseId();
  let released = false;
  const token = {} as FormalRenderBenchmarkExclusiveLease;
  const release = (): void => {
    if (released) return;
    released = true;
    if (activeLease === token) activeLease = undefined;
  };
  Object.assign(token, { id, release });
  Object.freeze(token);
  activeLease = token;
  return token;
}

/** Read-only gate for the live RAF path. */
export function formalRenderBenchmarkExclusiveActive(): boolean {
  return activeLease !== undefined;
}

/** Proves that a caller holds the currently active, non-forgeable lease. */
export function assertFormalRenderBenchmarkExclusiveLease(
  value: unknown,
): asserts value is Readonly<FormalRenderBenchmarkExclusiveLease> {
  if (activeLease === undefined || value !== activeLease) {
    throw new Error("formal render benchmark lease is not active");
  }
}
