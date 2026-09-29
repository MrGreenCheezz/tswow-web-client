// Which client patch generation this gateway serves, and whether a TSWoW build has moved past it.
//
// A `build addon` / `build data` rewrites `patch-<loc>-A.MPQ` under a running gateway, and the
// fingerprint latches the client-media routes into 409 `client_patch_chain_changed` until the
// process is restarted (Gateway.ts, `isClientVisualProfileRoute`). The latch is right — only a
// restart selects one atomic archive/profile generation — but on its own it only says "no". This
// file is the part that says *what*: a generation hash the page can compare against the one it
// booted with, when the chain moved, and (from a child, because the gateway never opens an MPQ)
// which lettered patches, TSAddon blocks, TSWoW build and native publication are on disk now.
//
// Nothing here reloads anything. `/client/patch-status` is read-only for the reason
// `DatasetFingerprint.ts` gives at its top: a network-reachable "reload" is a denial of service.

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";

export interface PatchStatusAddon {
  readonly name: string;
  readonly loadOnDemand: boolean;
}

/** What `onClientPatchChange` is told, once per fingerprint walk that saw the archives move. */
export interface ClientPatchChange {
  /** When this process noticed it, ISO. */
  readonly at: string;
  /** The first change after startup is the one that latched the client-media routes. */
  readonly first: boolean;
  readonly epoch: number;
  /** Archive changes seen since startup, this one included. */
  readonly changes: number;
}

/** The cheap half of `/client/patch-status`: everything this process knows without a child. */
export interface PatchStatusSummary {
  readonly schema: 1;
  /** The generation this process selected at startup; fixed for its whole life. */
  readonly generation: string;
  readonly startedAt: string;
  /** The latch: a TSWoW build moved the archive chain after startup. */
  readonly stale: boolean;
  /** The first archive change after startup (the latch), or null. */
  readonly changedAt: string | null;
  /** The latest archive change; a build is still writing while this keeps moving. */
  readonly lastChangeAt: string | null;
  readonly changes: number;
  /** Started by `tools/start-gateway.mjs` with GATEWAY_RESTART_ON_PATCH=1: it restarts itself. */
  readonly supervised: boolean;
  /** The root Interface/AddOns list `/client/addons` serves, frozen at startup. */
  readonly rootAddons: readonly PatchStatusAddon[];
}

/** The whole answer: the summary plus `tools/patch-status.mjs --json` for the disk as it is now. */
export interface PatchStatus extends PatchStatusSummary {
  /** The child's report, or null when there is no reader or it failed (`clientError` says why). */
  readonly client: unknown;
  readonly clientError?: string;
}

/**
 * The patch generation of one archive walk plus the root add-on list served beside it.
 *
 * `tools/patch-status.mjs` computes the same value offline so that `npm run patches:status` can say
 * whether the running gateway still serves the disk; `tests/patch-status.test.mjs` pins the two
 * formulas together, the way `ARCHIVE_ORDER` is pinned between `mpq.mjs` and the fingerprint.
 * The add-on list is part of it because `WTF/AddOns.txt` can change what the page boots without
 * any archive changing.
 */
export function patchGeneration(input: {
  readonly archivesHash: string | undefined;
  readonly chain: string | undefined;
  readonly addons: readonly PatchStatusAddon[];
}): string {
  const addons = input.addons
    .map((addon) => `addon:${addon.name.toLowerCase()}:${addon.loadOnDemand ? 1 : 0}`)
    .sort();
  return createHash("sha1").update([
    "patch-generation-1",
    `archives:${input.archivesHash ?? "none"}`,
    `chain:${input.chain ?? "none"}`,
    ...addons,
  ].join("\n")).digest("hex");
}

export interface PatchStatusTrackerOptions {
  readonly archivesHash: string | undefined;
  readonly chain: string | undefined;
  readonly addons: readonly PatchStatusAddon[];
  readonly supervised?: boolean;
  /** Runs `tools/patch-status.mjs --json --no-gateway` in a child. Absent: `client` is null. */
  readonly readDetails?: () => Promise<unknown>;
  readonly onChange?: (change: ClientPatchChange) => void;
  /** For tests. */
  readonly now?: () => number;
  /**
   * How long one child report answers for. Keyed on the fingerprint epoch as well, so a patch
   * write is seen at once; the TTL covers what the fingerprint does not watch — the TSWoW build
   * marker and the publisher's publication.json — and bounds a Diagnostics window left open to one
   * child every half minute instead of one per refresh.
   */
  readonly detailsTtlMs?: number;
}

interface DetailsEntry {
  readonly epoch: number;
  readonly at: number;
  ttl: number;
  readonly value: Promise<{ client: unknown; clientError?: string }>;
}

const DEFAULT_DETAILS_TTL_MS = 30_000;
/** A failed child is remembered for less time: the usual cause is a build still writing. */
const FAILED_DETAILS_TTL_MS = 5_000;

export class PatchStatusTracker {
  readonly generation: string;
  readonly #startedAt: number;
  readonly #addons: readonly PatchStatusAddon[];
  readonly #supervised: boolean;
  readonly #readDetails: (() => Promise<unknown>) | undefined;
  readonly #onChange: ((change: ClientPatchChange) => void) | undefined;
  readonly #now: () => number;
  readonly #ttlMs: number;
  #changedAt: number | undefined;
  #lastChangeAt: number | undefined;
  #changes = 0;
  /** The last fingerprint epoch counted; every request waiting on one walk reports the same one. */
  #lastEpoch = Number.NEGATIVE_INFINITY;
  #details: DetailsEntry | undefined;

  constructor(options: PatchStatusTrackerOptions) {
    this.#now = options.now ?? Date.now;
    this.#startedAt = this.#now();
    this.#addons = options.addons.map((addon) => ({ name: addon.name, loadOnDemand: addon.loadOnDemand }));
    this.generation = patchGeneration({ archivesHash: options.archivesHash, chain: options.chain, addons: this.#addons });
    this.#supervised = options.supervised ?? false;
    this.#readDetails = options.readDetails;
    this.#onChange = options.onChange;
    this.#ttlMs = options.detailsTtlMs ?? DEFAULT_DETAILS_TTL_MS;
  }

  get stale(): boolean {
    return this.#changedAt !== undefined;
  }

  /**
   * Called by the gateway for every walk whose archive half changed. Concurrent requests share one
   * fingerprint walk and each hears its answer, so one change arrives once per waiting request:
   * counted, and told to the supervisor, once per epoch.
   */
  noteArchivesChanged(epoch: number): void {
    if (epoch <= this.#lastEpoch) return;
    this.#lastEpoch = epoch;
    const now = this.#now();
    const first = this.#changedAt === undefined;
    if (first) this.#changedAt = now;
    this.#lastChangeAt = now;
    this.#changes++;
    try {
      this.#onChange?.({ at: new Date(now).toISOString(), first, epoch, changes: this.#changes });
    } catch (error) {
      // A hook is a notification; a broken IPC channel must not fail the request that noticed it.
      console.warn(`Patch change hook failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  summary(): PatchStatusSummary {
    const iso = (value: number | undefined): string | null => value === undefined ? null : new Date(value).toISOString();
    return {
      schema: 1,
      generation: this.generation,
      startedAt: new Date(this.#startedAt).toISOString(),
      stale: this.stale,
      changedAt: iso(this.#changedAt),
      lastChangeAt: iso(this.#lastChangeAt),
      changes: this.#changes,
      supervised: this.#supervised,
      rootAddons: this.#addons,
    };
  }

  /** The summary plus the child's report, shared by concurrent callers and memoised per epoch. */
  async details(epoch: number): Promise<PatchStatus> {
    const now = this.#now();
    const cached = this.#details;
    if (!cached || cached.epoch !== epoch || now - cached.at >= cached.ttl) {
      const read = this.#readDetails;
      const entry: DetailsEntry = {
        epoch, at: now, ttl: this.#ttlMs,
        value: read === undefined
          ? Promise.resolve({ client: null, clientError: "no patch reader is configured" })
          : read().then((client) => ({ client }), (error: unknown) => {
            entry.ttl = FAILED_DETAILS_TTL_MS;
            return { client: null, clientError: error instanceof Error ? error.message : String(error) };
          }),
      };
      this.#details = entry;
    }
    const { client, clientError } = await this.#details!.value;
    return { ...this.summary(), client, ...(clientError === undefined ? {} : { clientError }) };
  }
}

/** StormLib's own lines; they say nothing about why a report is missing. */
const STORMLIB_CHATTER = /^(?:Initialized StormLib|Heap resize)/;
/**
 * Report fields that hold absolute paths on this machine. A linked letter's `target` leaves as the
 * child's `targetInInstall` (`modules/<name>/assets`), which says which module it is without where.
 */
const MACHINE_PATH_FIELDS = new Set(["clientDirectory", "file", "target", "buildFile"]);
/**
 * An absolute path inside free text — an fs error's quoted operand (spaces allowed), or a bare
 * drive or UNC path up to the next space. Not a URL's `http://`: a drive letter stands alone.
 */
const QUOTED_MACHINE_PATH = /'(?:[A-Za-z]:[\\/]|\\\\|\/)[^']*'/g;
const BARE_MACHINE_PATH = /(?<![A-Za-z0-9])(?:[A-Za-z]:[\\/]|\\\\[^\\\s'"]+\\)[^\s'"]*/g;

/**
 * The report without this machine's absolute paths.
 *
 * The route is origin-checked, and Origin is a header the caller chooses (README), so what leaves
 * this process is what a patch author needs — letters, kinds, counts, times, module names — and not
 * where the client, the modules and the publisher live on disk. `npm run patches:status` prints them
 * locally. Path-valued fields are dropped; error texts keep their words with each path replaced.
 */
export function redactPatchReport(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(QUOTED_MACHINE_PATH, "'<path>'").replace(BARE_MACHINE_PATH, "<path>");
  }
  if (Array.isArray(value)) return value.map(redactPatchReport);
  if (typeof value !== "object" || value === null) return value;
  const copy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!MACHINE_PATH_FIELDS.has(key)) copy[key] = redactPatchReport(entry);
  }
  return copy;
}

/**
 * `tools/patch-status.mjs --json --no-gateway` in a child, resolved with its report.
 *
 * The protocol is one JSON document with `schema: 1` on stdout; the tool silences StormLib's banner
 * and heap lines there while the chain is open. The exit code is a verdict (players behind, and so
 * on), not a failure, so the document decides success; without one the rejection carries the last
 * lines of stderr. Bounded like every other child the gateway starts: a client on a drive that
 * stopped answering must not hold a Diagnostics request open forever.
 */
export function readPatchStatusChild(options: {
  readonly script: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly track?: (child: ChildProcess) => ChildProcess;
  readonly timeoutMs?: number;
}): Promise<unknown> {
  return new Promise((resolveJob, rejectJob) => {
    let answer = "";
    let errors = "";
    const started = spawn(process.execPath, [options.script, "--json", "--no-gateway"], {
      cwd: options.cwd, env: options.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    const child = options.track ? options.track(started) : started;
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 30_000);
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (data: string) => { answer = (answer + data).slice(-1_048_576); });
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (data: string) => { errors = (errors + data).slice(-65536); });
    child.once("error", (error) => { clearTimeout(timer); rejectJob(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      try {
        const report = JSON.parse(answer) as { schema?: unknown };
        if (report.schema === 1) {
          resolveJob(redactPatchReport(report));
          return;
        }
      } catch {
        // Reported below with the child's own words.
      }
      const lines = errors.trim().split(/\r?\n/).filter((line) => line && !STORMLIB_CHATTER.test(line));
      rejectJob(new Error(lines.slice(-3).join(" ") || `patch-status.mjs exited with ${String(code)}`));
    });
  });
}

/**
 * The one line printed at startup: this process's generation, then the child's own summary line.
 *
 * The child writes `summaryLine` itself (tools/patch-status.mjs), so the gateway, the CLI and the
 * Diagnostics window say the same thing in the same words.
 */
export function formatPatchStatusLine(status: PatchStatus): string {
  const head = `Patches: generation ${status.generation.slice(0, 12)}`;
  const client = status.client as { summaryLine?: unknown } | null;
  if (client && typeof client.summaryLine === "string" && client.summaryLine) return `${head} · ${client.summaryLine}`;
  return `${head} · details unavailable: ${status.clientError ?? "no report"}`;
}
