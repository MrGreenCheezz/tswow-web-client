import { rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import { removeStampsUnder } from "./tools/source-stamp.mjs";

/**
 * Keeps local client-derived caches and source stamps out of the production web directory.
 *
 * Vite copies `public/` verbatim. The ignored icon and optional portrait directories may contain
 * files extracted from the user's own client, while `.src` sidecars also name local disks. None of
 * those belong in a distributable output, so production builds drop the cache trees completely.
 * The runtime obtains spell and creature icons from the loopback gateway instead.
 */
function keepBuildLocalOnly() {
  let outDirectory;
  return {
    name: "webclient:local-only-output",
    configResolved(config) {
      outDirectory = resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      // Development uses the local public cache, but its provenance sidecars are never HTTP files.
      server.middlewares.use((request, response, next) => {
        if (!isLocalProvenanceRequest(request.url)) return next();
        response.statusCode = 404;
        response.end();
      });
    },
    // `closeBundle`, because Vite copies `public/` after the bundle itself is written.
    async closeBundle() {
      const removed = await removeStampsUnder(outDirectory);
      for (const name of ["icons", "creature-icons", "portraits"]) {
        await rm(resolve(outDirectory, name), { recursive: true, force: true });
      }
      await writeFile(
        resolve(outDirectory, "LOCAL_ONLY-NOT-FOR-REDISTRIBUTION.txt"),
        "LOCAL-ONLY EDUCATIONAL BUILD\n\n"
          + "This directory may contain code generated from the builder's own original client "
          + "and server data. Do not redistribute, publish or publicly host it. Share only the "
          + "tracked source repository, subject to NOTICE.md and LICENSES/.\n",
        "utf8",
      );
      if (removed > 0) console.log(`dropped ${removed} local source stamp(s) from ${outDirectory}`);
    },
  };
}

/**
 * Whether a development-server URL could resolve to a local `.src` provenance sidecar.
 *
 * URL.pathname deliberately keeps percent escapes. Decode it once before checking the filename,
 * just as the static-file layer will, and fail closed when an invalid escape makes the requested
 * path ambiguous. The filesystem comparison is case-insensitive on the supported Windows host,
 * so the boundary has to be case-insensitive too.
 */
export function isLocalProvenanceRequest(requestUrl) {
  try {
    const encodedPath = new URL(requestUrl ?? "/", "http://127.0.0.1").pathname;
    return decodeURIComponent(encodedPath).toLowerCase().endsWith(".src");
  } catch {
    return true;
  }
}

function port(value, fallback) {
  const parsed = Number.parseInt(value || String(fallback), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error(`Invalid web port: ${value}`);
  return parsed;
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const allowedHosts = (env.WEB_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
  return {
    server: {
      host: env.WEB_HOST || "127.0.0.1",
      port: port(env.WEB_PORT, 5173),
      strictPort: true,
      ...(allowedHosts.length > 0 ? { allowedHosts } : {}),
    },
    plugins: [keepBuildLocalOnly()],
    build: {
      outDir: "dist/web",
      emptyOutDir: true,
      rollupOptions: {
        // Two pages, not one. `character-lab.html` draws a character out of the same modules the
        // client draws one with, without a login or a world server; naming the inputs explicitly is
        // what makes `vite build` — and so `npm test` — compile the lab as well as the client.
        input: {
          main: fileURLToPath(new URL("./index.html", import.meta.url)),
          lab: fileURLToPath(new URL("./character-lab.html", import.meta.url)),
        },
      },
    },
  };
});
