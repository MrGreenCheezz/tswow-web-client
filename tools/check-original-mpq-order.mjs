// Explicit diagnostic for differences between the WebClient resource chain and the
// startup patch order recovered from the local 3.3.5a build 12340 executable.
// It never changes the archive chain or generated data.
//
// node tools/check-original-mpq-order.mjs --path 'DBFilesClient\CharSections.dbc'
// node tools/check-original-mpq-order.mjs --shadowed-dbc [--client F:\Circle]

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compareOriginalPatchWinner } from "./original-mpq-order.mjs";
import { openClientArchives } from "./mpq.mjs";
import { clientDirectory } from "./paths.mjs";

function usage() {
  return "Usage: node tools/check-original-mpq-order.mjs "
    + "[--client DIR] [--locale LOCALE] (--path VIRTUAL_PATH ... | --shadowed-dbc)";
}

function optionsFrom(argv) {
  const options = { paths: [], shadowedDbc: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--path" || arg === "--client" || arg === "--locale") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      if (arg === "--path") options.paths.push(value);
      else options[arg.slice(2)] = value;
    } else if (arg === "--shadowed-dbc") options.shadowedDbc = true;
    else if (arg === "--help") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.help && options.paths.length === 0 && !options.shadowedDbc) {
    throw new Error("Supply --path or --shadowed-dbc");
  }
  return options;
}

export async function checkOriginalMpqOrder(argv = process.argv.slice(2)) {
  const options = optionsFrom(argv);
  if (options.help) {
    console.log(usage());
    return;
  }
  const locale = options.locale ?? process.env.CLIENT_LOCALE ?? "ruRU";
  const directory = options.client ?? clientDirectory();
  const chain = await openClientArchives(directory);
  try {
    const paths = new Map(options.paths.map((path) => [path.replaceAll("/", "\\").toLowerCase(), path]));
    if (options.shadowedDbc) {
      // This only covers names in a loose overlay that a higher WebClient source
      // shadows. Use --path for other names, including archive-only conflicts.
      for (const shadow of await chain.shadowedOverlayFiles("DBFilesClient\\")) {
        paths.set(shadow.path.replaceAll("/", "\\").toLowerCase(), shadow.path);
      }
    }
    const results = [];
    for (const path of paths.values()) {
      const copies = await chain.copies(path);
      const comparison = compareOriginalPatchWinner(copies, locale);
      results.push({
        path,
        status: comparison.status,
        webClientWinner: comparison.webClientWinner?.name ?? null,
        originalStartupPatchWinner: comparison.originalPatchWinner?.name ?? null,
      });
    }
    for (const result of results) {
      console.log(`${result.status.toUpperCase()} ${result.path}: WebClient=${result.webClientWinner ?? "absent"}, `
        + `original startup patch=${result.originalStartupPatchWinner ?? "undetermined"}`);
    }
    console.log(`${results.length} path(s), ${results.filter((result) => result.status === "different").length} difference(s).`);
    console.log("Scope: recognized startup patches in this Data directory; custom sources and other search roots are not modeled.");
    console.log("INDETERMINATE means the WebClient winner is outside that modeled patch chain.");
    console.log("Differences are informational: TSWoW media patches such as patch-W may intentionally win in WebClient.");
  } finally {
    chain.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  checkOriginalMpqOrder().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage());
    process.exitCode = 1;
  });
}
