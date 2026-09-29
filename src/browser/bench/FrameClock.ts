/** Wait for a new RAF timestamp before rendering or recording a measurement. */
export async function nextBenchmarkFrame(
  previous: number,
  nextFrame: () => Promise<number>,
): Promise<{ timestamp: number; repeatedCallbacks: number }> {
  let repeatedCallbacks = 0;
  for (;;) {
    const timestamp = await nextFrame();
    if (!Number.isFinite(timestamp) || timestamp < previous) {
      throw new Error("Benchmark RAF timestamp is invalid or moved backwards");
    }
    if (timestamp > previous) return { timestamp, repeatedCallbacks };
    // A repeated timestamp is still the same browser frame. Do not render twice or record a
    // zero-duration interval. This does not discard any rendered or already recorded sample.
    repeatedCallbacks++;
  }
}
