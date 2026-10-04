// "The archives do not hold this", said the one way every generator says it (10.20, М-A10-1).
//
// A generator run as its own process says it with an exit code, a generator run inside the
// persistent worker (`tools/asset-worker.mjs`) with `missing: true` in its answer; either way the
// gateway turns it into the one failure it answers 404 instead of 500 (`sourceMissing` in
// `src/gateway/GenerationLane.ts`, whose `SOURCE_MISSING_EXIT` the tests pin to this one). Before
// this file `generate-texture.mjs` and `generate-client-file.mjs` each declared their own class, so a
// worker running both could only recognise one of them with `instanceof`.

/** What a generator exits with when the client simply does not hold what it was asked for. */
export const SOURCE_MISSING_EXIT = 3;

/** The failure that earns that exit code: the request is well formed and the chain has no such file. */
export class SourceMissing extends Error {}
