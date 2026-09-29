import type { FrameXmlWorldMapOwner } from "./FrameXmlWorldMapController.js";

let owner: FrameXmlWorldMapOwner | undefined;

function closeAndFail(current: FrameXmlWorldMapOwner): void {
  try { current.close(); } catch { /* the old VM may already be tearing down */ }
  try { current.onFailure?.(); } catch { /* fallback restoration is best-effort */ }
}

function invoke(current: FrameXmlWorldMapOwner, action: () => void): boolean {
  try {
    action();
    return true;
  } catch {
    if (owner === current) owner = undefined;
    closeAndFail(current);
    return false;
  }
}

/** A structural gate is the only publisher; cleanup cannot revoke a newer mount. */
export function publishFrameXmlWorldMap(next: FrameXmlWorldMapOwner): () => void {
  const previous = owner;
  if (previous && previous !== next) {
    try { previous.close(); } catch { /* the previous mount is being replaced */ }
  }
  owner = next;
  let cleaned = false;
  return (): void => {
    if (cleaned) return;
    cleaned = true;
    if (owner !== next) return;
    try { next.close(); } catch { /* mount teardown continues */ }
    owner = undefined;
  };
}

export function frameXmlWorldMapPublished(): boolean {
  return owner !== undefined;
}

export function frameXmlWorldMapOpen(): boolean {
  const current = owner;
  if (!current) return false;
  let open = false;
  return invoke(current, () => { open = current.isOpen(); }) && open;
}

export function openFrameXmlWorldMap(): boolean {
  const current = owner;
  return current ? invoke(current, () => current.open()) : false;
}

export function toggleFrameXmlWorldMap(): boolean {
  const current = owner;
  return current ? invoke(current, () => current.toggle()) : false;
}

export function closeFrameXmlWorldMap(): boolean {
  const current = owner;
  return current ? invoke(current, () => current.close()) : false;
}
