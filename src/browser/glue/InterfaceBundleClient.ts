/**
 * 25.10 (serve S3): interface files out of the gateway's bundle first, one file a request only for the rest.
 *
 * The glue screens and the world UI used to read every Lua/XML/TOC through `/client/file`, one request a
 * file — 59 for the login screens and ≈450 for the world UI with its add-ons on this client, part of them a
 * waterfall (an XML file's `Include`s are known only once it is parsed), and every later session revalidated
 * all of them again. `/client/interface-bundle` (src/gateway/InterfaceBundle.ts) answers a set's whole TOC
 * closure in one compressed, revalidated response.
 *
 * `createBundledFileProvider` is a `GlueFileProvider` like `createHttpFileProvider`, and answers exactly what
 * that one would: a path in the bundle's `files` is that file's text (what `/client/file` serves for it), a
 * path in its `absent` list is the route's 404 (`undefined`), and anything else — an add-on loaded later, a
 * path the bundle walk did not reach, a file whose read failed on the gateway — goes to `/client/file` as
 * before, with its retries and its patch-chain 409. If the bundle cannot be had at all (an older gateway's
 * 404, a 409, a network failure, a malformed answer) every read takes the old route: nothing is worse than
 * before. Module UI and data/ui drafts do not travel through this route (`/modules/*`), so they are unchanged.
 *
 * One bundle request per origin, set and add-on lists for the life of the page; the page's HTTP cache keeps
 * the body and revalidates it with its tag (`max-age=0`), so a later session costs a 304.
 */

import { createHttpFileProvider, normalizeGluePath, type GlueFileProvider, type GlueHttpProviderOptions } from "./GlueLoader.js";

export interface InterfaceBundleRequest {
  readonly set: "glue" | "world";
  /** Add-ons whose whole TOC closure the bundle should carry (world only). */
  readonly addons?: readonly string[];
  /** Add-ons whose TOC alone it should carry (their metadata is read before they load). */
  readonly tocs?: readonly string[];
}

export interface InterfaceBundle {
  readonly files: ReadonlyMap<string, string>;
  readonly absent: ReadonlySet<string>;
}

const SCHEMA = "interface-bundle-1";
const ADDON_NAME = /^[!A-Za-z0-9_][!A-Za-z0-9_-]{0,63}$/;
const loaded = new Map<string, Promise<InterfaceBundle | undefined>>();

/** The bundle's URL: the add-on lists sorted and deduplicated, so equal requests share one cache entry. */
export function interfaceBundleUrl(gatewayOrigin: string, request: InterfaceBundleRequest): string {
  const url = new URL("/client/interface-bundle", gatewayOrigin.replace(/\/+$/, ""));
  url.searchParams.set("v", "1");
  url.searchParams.set("set", request.set);
  const list = (names: readonly string[] | undefined): string =>
    [...new Set((names ?? []).filter((name) => ADDON_NAME.test(name)).map((name) => name.toLowerCase()))].sort().join(",");
  if (request.set === "world") {
    const addons = list(request.addons);
    const tocs = list(request.tocs);
    if (addons) url.searchParams.set("addons", addons);
    if (tocs) url.searchParams.set("tocs", tocs);
  }
  return url.href;
}

/** Reads one bundle answer; `undefined` for anything that is not a well-formed bundle of this schema. */
export function parseInterfaceBundle(value: unknown): InterfaceBundle | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as { schema?: unknown; files?: unknown; absent?: unknown };
  if (record.schema !== SCHEMA || typeof record.files !== "object" || record.files === null
    || !Array.isArray(record.absent)) return undefined;
  const files = new Map<string, string>();
  for (const [path, text] of Object.entries(record.files as Record<string, unknown>)) {
    if (typeof text !== "string") return undefined;
    files.set(normalizeGluePath(path), text);
  }
  const absent = new Set<string>();
  for (const path of record.absent) {
    if (typeof path !== "string") return undefined;
    absent.add(normalizeGluePath(path));
  }
  return { files, absent };
}

/** The bundle for this request, fetched once per page; `undefined` when it cannot be had (see the file comment). */
export function loadInterfaceBundle(
  gatewayOrigin: string, request: InterfaceBundleRequest, doFetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
): Promise<InterfaceBundle | undefined> {
  const url = interfaceBundleUrl(gatewayOrigin, request);
  let pending = loaded.get(url);
  if (!pending) {
    pending = (async () => {
      try {
        const response = await doFetch(url, { headers: { accept: "application/json" } });
        if (!response.ok) return undefined;
        return parseInterfaceBundle(await response.json());
      } catch {
        return undefined;
      }
    })();
    loaded.set(url, pending);
  }
  return pending;
}

/** Tests: forget the page's bundles. */
export function resetInterfaceBundles(): void {
  loaded.clear();
}

export interface BundledFileProviderOptions extends GlueHttpProviderOptions {
  readonly bundle: InterfaceBundleRequest;
}

/** A `GlueFileProvider` that reads the bundle first and `/client/file` for whatever it does not settle. */
export function createBundledFileProvider(options: BundledFileProviderOptions): GlueFileProvider {
  const fallback = createHttpFileProvider(options);
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  return {
    async read(path: string): Promise<string | undefined> {
      const bundle = await loadInterfaceBundle(options.gatewayOrigin, options.bundle, doFetch);
      if (bundle) {
        const key = normalizeGluePath(path);
        const text = bundle.files.get(key);
        if (text !== undefined) return text;
        if (bundle.absent.has(key)) return undefined;
      }
      return fallback.read(path);
    },
  };
}
