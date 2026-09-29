/** One item retained by the bounded admission heap; the displaced worst entry is reused. */
interface AdmissionEntry<T> {
  item: T;
  score: number;
  ordinal: number;
}

function compareAdmissionEntries<T>(left: AdmissionEntry<T>, right: AdmissionEntry<T>): number {
  if (left.score < right.score) return -1;
  if (left.score > right.score) return 1;
  if (left.ordinal < right.ordinal) return -1;
  if (left.ordinal > right.ordinal) return 1;
  return 0;
}

/** Whether `left` is the worse candidate and therefore belongs above `right` in a max-heap. */
function isWorse<T>(left: AdmissionEntry<T>, right: AdmissionEntry<T>): boolean {
  return compareAdmissionEntries(left, right) > 0;
}

function siftUp<T>(heap: AdmissionEntry<T>[], start: number): void {
  let index = start;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    const entry = heap[index]!;
    const parentEntry = heap[parent]!;
    if (!isWorse(entry, parentEntry)) break;
    heap[index] = parentEntry;
    heap[parent] = entry;
    index = parent;
  }
}

function siftDown<T>(heap: AdmissionEntry<T>[], start: number): void {
  let index = start;
  while (true) {
    const left = index * 2 + 1;
    if (left >= heap.length) return;
    const right = left + 1;
    let worseChild = left;
    if (right < heap.length && isWorse(heap[right]!, heap[left]!)) worseChild = right;
    if (!isWorse(heap[worseChild]!, heap[index]!)) return;
    const entry = heap[index]!;
    heap[index] = heap[worseChild]!;
    heap[worseChild] = entry;
    index = worseChild;
  }
}

/**
 * Retains the exact stable lowest-scoring K items in one pass with O(K) storage.
 *
 * Equal scores are ordered by their original iterable ordinal. Invalid scores fail fast because
 * neither NaN nor an infinity has a well-defined place in the admission order.
 */
export function stableBoundedTopK<T>(
  items: Iterable<T>,
  k: number,
  scoreOf: (item: T) => number,
): T[] {
  checkAdmissionK(k);
  if (k === 0) return [];
  const heap: AdmissionEntry<T>[] = [];
  let ordinal = 0;
  for (const item of items) ordinal = admit(heap, k, item, scoreOf(item), ordinal);
  return retained(heap);
}

/**
 * `stableBoundedTopK` over the items of `items` that `accept` keeps, offered in order. Every
 * frame's admission passes call it over thousands of candidates: a predicate instead of a generator
 * spares one iterator result per candidate.
 */
export function stableBoundedTopKWhere<T>(
  items: readonly T[],
  accept: (item: T) => boolean,
  k: number,
  scoreOf: (item: T) => number,
): T[] {
  checkAdmissionK(k);
  if (k === 0) return [];
  const heap: AdmissionEntry<T>[] = [];
  let ordinal = 0;
  for (let index = 0; index < items.length; index++) {
    const item = items[index]!;
    if (accept(item)) ordinal = admit(heap, k, item, scoreOf(item), ordinal);
  }
  return retained(heap);
}

function checkAdmissionK(k: number): void {
  if (!Number.isSafeInteger(k) || k < 0) {
    throw new RangeError("stableBoundedTopK K must be a non-negative safe integer");
  }
}

/** Offers one scored item to the bounded heap; returns the next ordinal. */
function admit<T>(heap: AdmissionEntry<T>[], k: number, item: T, score: number, ordinal: number): number {
  if (!Number.isFinite(score)) {
    throw new RangeError("stableBoundedTopK scores must be finite");
  }
  if (heap.length < k) {
    heap.push({ item, score, ordinal });
    siftUp(heap, heap.length - 1);
  } else if (score < heap[0]!.score) {
    // Every retained entry came earlier, so an equal score never displaces the worst one. Its
    // object takes the newcomer: no entry is allocated for a candidate that is not kept.
    const worst = heap[0]!;
    worst.item = item;
    worst.score = score;
    worst.ordinal = ordinal;
    siftDown(heap, 0);
  }
  return ordinal + 1;
}

function retained<T>(heap: AdmissionEntry<T>[]): T[] {
  heap.sort(compareAdmissionEntries);
  return heap.map(({ item }) => item);
}

/** One in-range unit, classified before the shared draw budget is applied. */
export interface UnitAdmissionCandidate<T> {
  readonly value: T;
  readonly distance: number;
  readonly pinned: boolean;
  readonly visible: boolean;
}

function selectVisibleAdmission<T>(
  candidates: readonly UnitAdmissionCandidate<T>[],
  budget: number,
): { readonly admitted: UnitAdmissionCandidate<T>[]; readonly dropped: number } {
  let eligible = 0;
  for (const candidate of candidates) {
    if (candidate.pinned || candidate.visible) eligible++;
  }
  const admitted = stableBoundedTopKWhere(
    candidates,
    (candidate) => candidate.pinned || candidate.visible,
    budget,
    ({ distance, pinned }) => pinned ? -1 : distance,
  );
  return { admitted, dropped: Math.max(0, eligible - admitted.length) };
}

/** Visibility-gated, pinned-first unit admission without a full candidate sort. */
export function selectUnitAdmission<T>(
  candidates: readonly UnitAdmissionCandidate<T>[],
  budget: number,
): { readonly admitted: UnitAdmissionCandidate<T>[]; readonly dropped: number } {
  return selectVisibleAdmission(candidates, budget);
}

/** Visibility-gated, pinned-first game-object admission without a full candidate sort. */
export function selectGameObjectAdmission<T>(
  candidates: readonly UnitAdmissionCandidate<T>[],
  budget: number,
): { readonly admitted: UnitAdmissionCandidate<T>[]; readonly dropped: number } {
  return selectVisibleAdmission(candidates, budget);
}
