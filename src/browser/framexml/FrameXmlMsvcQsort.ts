/**
 * 3.29 (13.10): the C runtime's `qsort` Wow.exe 3.3.5a 12340 links (0x0040be50, Ghidra's library match
 * «Visual Studio 2005 Release»; notes .runtime/re-2026-10-11/glue-1110/1013-q1.txt), step for step, so a
 * list sorted with a comparator that answers 0 for unlike elements comes out in the client's order. The
 * trainer window is the case (0x00594ba0 → 0x005947d0/0x005949a0): every hidden row compares equal to every
 * other, and where they land after the visible ones is this algorithm's doing.
 *
 * - Fewer than 2 elements: nothing. A range of at most 8 goes to `shortsort` (selection of the maximum
 *   into the last place, from the left: the first of equal maxima stays put).
 * - Otherwise the median of lo, the middle (lo + size/2) and hi, each pair swapped when the comparator
 *   answers > 0; then the partition walk of the VS2005 source (loguy past the pivot, higuy back to it, the
 *   pivot following a swap), the run of elements equal to the pivot skipped on both sides, and the smaller
 *   part sorted first with the larger one kept on an explicit stack.
 *
 * Sorts `items` in place; `compare` is called with elements, as the C one is with pointers to them.
 */
export function frameXmlMsvcQsort<T>(items: T[], compare: (a: T, b: T) => number): void {
  const count = items.length;
  if (count < 2) return;
  const swap = (a: number, b: number): void => {
    if (a === b) return;
    const kept = items[a]!;
    items[a] = items[b]!;
    items[b] = kept;
  };
  const shortsort = (low: number, high: number): void => {
    while (high > low) {
      let max = low;
      for (let at = low + 1; at <= high; at += 1) if (compare(items[at]!, items[max]!) > 0) max = at;
      swap(max, high);
      high -= 1;
    }
  };
  const lows: number[] = [];
  const highs: number[] = [];
  let low = 0;
  let high = count - 1;
  for (;;) {
    const size = high - low + 1;
    let pending = false;
    if (size <= 8) {
      shortsort(low, high);
    } else {
      let mid = low + (size >>> 1);
      if (compare(items[low]!, items[mid]!) > 0) swap(low, mid);
      if (compare(items[low]!, items[high]!) > 0) swap(low, high);
      if (compare(items[mid]!, items[high]!) > 0) swap(mid, high);
      let loguy = low;
      let higuy = high;
      for (;;) {
        if (mid > loguy) {
          do loguy += 1; while (loguy < mid && compare(items[loguy]!, items[mid]!) <= 0);
        }
        if (mid <= loguy) {
          do loguy += 1; while (loguy <= high && compare(items[loguy]!, items[mid]!) <= 0);
        }
        do higuy -= 1; while (higuy > mid && compare(items[higuy]!, items[mid]!) > 0);
        if (higuy < loguy) break;
        swap(loguy, higuy);
        if (mid === higuy) mid = loguy;
      }
      higuy += 1;
      if (mid < higuy) {
        do higuy -= 1; while (higuy > mid && compare(items[higuy]!, items[mid]!) === 0);
      }
      if (mid >= higuy) {
        do higuy -= 1; while (higuy > low && compare(items[higuy]!, items[mid]!) === 0);
      }
      if (higuy - low >= high - loguy) {
        if (low < higuy) { lows.push(low); highs.push(higuy); }
        if (loguy < high) { low = loguy; pending = true; }
      } else {
        if (loguy < high) { lows.push(loguy); highs.push(high); }
        if (low < higuy) { high = higuy; pending = true; }
      }
    }
    if (pending) continue;
    if (lows.length === 0) return;
    low = lows.pop()!;
    high = highs.pop()!;
  }
}
