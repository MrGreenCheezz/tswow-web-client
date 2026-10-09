import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { blpToPng } from "./blp-png.mjs";
import { openDbcFile } from "./dbc.mjs";
import { memoByFile } from "./dbc-memo.mjs";
import { clientArchives } from "./mpq.mjs";
import { clientDirectory, dbcDirectory } from "./paths.mjs";
import { SourceMissing } from "./source-missing.mjs";
import { sourceStamp, stampSidecar, writeFileAtomic, writeSourceStamp } from "./source-stamp.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** Where display icons are published; read on every call, so a long-lived worker follows the env. */
export function itemIconDirectory() {
  return resolve(root, process.env.ITEM_ICON_DIR ?? "data/item-icons");
}

/** `ItemDisplayInfo.InventoryIcon` by display id. */
async function readItemIcons() {
  const displayInfo = await openDbcFile(dbcDirectory(), "ItemDisplayInfo");
  const icons = new Map();
  for (const row of displayInfo.rows()) {
    const icon = displayInfo.string(row, "InventoryIcon", 0).replaceAll("/", "\\");
    if (icon) icons.set(displayInfo.id(row), icon);
  }
  return icons;
}

/** The archive path of a display's icon, as the bulk pass below spells it. */
function iconSource(icon) {
  let source = icon.includes("\\") ? icon : `Interface\\Icons\\${icon}`;
  if (!source.toLowerCase().endsWith(".blp")) source += ".blp";
  return source;
}

/**
 * Publishes one display id's icon out of an open chain — what the gateway's `/item-icon` miss asks
 * the persistent worker for (10.20). Same picture, same stamp as the command line's named run; the
 * table is read once per version of its file (`memoByFile`), not once per icon. A display with no
 * icon, or an icon the client does not hold, is `SourceMissing`: the lane then remembers it for
 * five minutes instead of asking again on the next request.
 */
export async function publishItemIcon(displayId, archives) {
  if (!Number.isInteger(displayId) || displayId <= 0) throw new Error(`${displayId} is not a display id`);
  const directory = itemIconDirectory();
  const file = join(directory, `${displayId}.png`);
  try {
    await access(file);
    await access(stampSidecar(file));
    return { file, cached: true };
  } catch {
    // Not published yet, or published before it carried a stamp.
  }
  const table = join(dbcDirectory(), "ItemDisplayInfo.dbc");
  const icon = (await memoByFile(table, readItemIcons)).get(displayId);
  if (!icon) throw new SourceMissing(`No icon found for display ID ${displayId}`);
  const source = iconSource(icon);
  const blp = await archives.read(source);
  if (!blp) throw new SourceMissing(`${source} is not in the client`);
  const png = blpToPng(blp);
  const stamp = await sourceStamp(archives, { paths: [source], files: [table] });
  await mkdir(dirname(file), { recursive: true });
  await writeFileAtomic(file, png);
  await writeSourceStamp(file, stamp);
  return { file, cached: false, bytes: png.length };
}

// Run directly: node tools/generate-item-icon.mjs <display-id...> | --all
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const arguments_ = process.argv.slice(2);
  const all = arguments_.length === 1 && arguments_[0] === "--all";
  if (!all && arguments_.length === 0) throw new Error("Usage: node tools/generate-item-icon.mjs <display-id...> | --all");

  const destination = itemIconDirectory();

  const requested = all
    ? JSON.parse(await readFile(resolve(root, "data/items.json"), "utf8")).map((row) => row[2])
    : arguments_.map(Number);
  if (!requested.every((id) => Number.isInteger(id) && id > 0)) throw new Error("Every display ID must be a positive integer");

  const icons = await readItemIcons();

  await mkdir(destination, { recursive: true });
  // A single-id run is what the gateway calls on a cache miss, and listing this directory means
  // reading 20k-odd entries just to answer one question, so ask about the one file instead.
  //
  // Cached here means the picture *and* its stamp: all 21,071 icons on this machine were written
  // before stamps existed, and an icon the gateway never regenerates is an icon that never gets one
  // — `npm run assets:item-icons -- --all` would have printed "already cached" and written nothing.
  const wanted = [...new Set(requested)];
  const cached = new Set();
  if (wanted.length > 8) {
    const names = new Set(await readdir(destination));
    for (const name of names) {
      if (name.toLowerCase().endsWith(".png") && names.has(stampSidecar(name))) cached.add(Number.parseInt(name, 10));
    }
  } else {
    for (const id of wanted) {
      try {
        await access(join(destination, `${id}.png`));
        await access(stampSidecar(join(destination, `${id}.png`)));
        cached.add(id);
      } catch {
        // Not published yet, or published before it carried a stamp.
      }
    }
  }

  const pending = wanted.filter((id) => !cached.has(id));
  // Many display ids share one icon file, so decode each file once and write it out under each id.
  const byIcon = new Map();
  for (const displayId of pending) {
    const icon = icons.get(displayId);
    if (!icon) continue;
    let source = icon.includes("\\") ? icon : `Interface\\Icons\\${icon}`;
    if (!source.toLowerCase().endsWith(".blp")) source += ".blp";
    const key = source.toLowerCase();
    const group = byIcon.get(key) ?? { source, displayIds: [] };
    group.displayIds.push(displayId);
    byIcon.set(key, group);
  }

  const groups = [...byIcon.values()];
  if (groups.length === 0) {
    console.log("All requested item icons are already cached");
  } else {
    const archives = await clientArchives(clientDirectory());
    let written = 0;
    let absent = 0;
    let undecodable = 0;
    const unresolved = [];
    for (const { source, displayIds } of groups) {
      const blp = await archives.read(source);
      if (!blp) {
        absent++;
        unresolved.push(...displayIds);
        continue;
      }
      let png;
      try {
        png = blpToPng(blp);
      } catch (error) {
        undecodable++;
        unresolved.push(...displayIds);
        if (undecodable <= 5) console.warn(`  ${source}: ${error instanceof Error ? error.message : error}`);
        continue;
      }
      // Two inputs, not one: the BLP this was decoded from, and the table that said it was the icon
      // for these display ids. A module that repoints ItemDisplayInfo at another picture changes
      // neither the display id nor the file name, so without the table's own stamp the old icon
      // would go on being served.
      const stamp = await sourceStamp(archives, {
        paths: [source],
        files: [join(dbcDirectory(), "ItemDisplayInfo.dbc")],
      });
      for (const displayId of displayIds) {
        const file = join(destination, `${displayId}.png`);
        await writeFile(file, png);
        await writeSourceStamp(file, stamp);
        written++;
      }
    }
    if (absent > 0) console.warn(`${absent} of ${groups.length} icon files are not in the client`);
    if (undecodable > 0) console.warn(`${undecodable} of ${groups.length} icon files could not be decoded`);
    console.log(`Generated ${written} item display icons from ${groups.length - absent - undecodable} unique BLP files`);
    archives.close();
    // A named request that produced nothing is an error; a bulk run reports and carries on.
    if (!all && unresolved.length > 0) throw new Error(`No icon found for display ID ${unresolved.join(", ")}`);
  }
}
