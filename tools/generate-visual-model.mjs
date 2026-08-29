// Publishes one model as WVM9, keyed on its path alone.
//
// The artifact carries no appearance: texture slots are declared by type and resolved in the
// browser, so every skin and hair combination of a character shares one file. Textures are
// published separately, keyed on their own path, so a BLP used by fifty models is one download.
//
// Two files come out of one read: `<hash>.bin` is the model with its locomotion clips, and
// `<hash>.anim.bin` is everything else it can play. Splitting them at publish time rather than at
// request time means the external .anim files are opened once, and the browser pays for a cast
// pose when something casts rather than when a wolf walks into view.

import { writeSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { m2Animations, parseM2, parseM2Skeleton, TEXTURE_TYPE_OWN } from "./m2.mjs";
import { encodeWvaAnimations, encodeWvm9 } from "./wvm.mjs";
import { readGlobalSequences, readParticleEmitters, readRibbonEmitters } from "./m2-particles.mjs";
import { baseAnimationIds, loadAnimationCatalog } from "./animations.mjs";
import { parseWmoVisual, wmoDependencies, wmoGroupMeshes } from "./wmo-visual.mjs";
import { WWM_TRIANGLE_BUDGET, encodeWwm, encodeWwmGroup } from "./wwm.mjs";
import { writeBlpAsPng } from "./blp-png.mjs";
import { publishTexture, SOURCE_MISSING_EXIT } from "./generate-texture.mjs";
import { clientArchives } from "./mpq.mjs";
import { clientDirectory } from "./paths.mjs";
import { sourceStamp, writeSourceStamp } from "./source-stamp.mjs";
// Out of the build, not copied: see the note over the same import in `generate-texture.mjs`.
import { validAssetPath } from "../dist/code/gateway/AssetPath.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const modelPath = (process.argv[2] ?? "").replaceAll("/", "\\");
const hash = process.argv[3] ?? "";
// The route's own validator, for the same reason `generate-texture.mjs` now calls it: a class
// written out here is a class that drifts from the one the request already passed. This one was
// ASCII-only where `validAssetPath` is Unicode — measured, that separates none of the client's
// 33,512 model paths, and every module path written in the author's own alphabet, which is
// precisely the case Д6 widened the route to accept.
if (!validAssetPath(modelPath, { extensions: ["m2", "wmo"] }) || !/^[0-9a-f]{40}$/.test(hash)) {
  throw new Error("Usage: node tools/generate-visual-model.mjs <m2-or-wmo-path> <sha1>");
}

const destination = resolve(root, process.env.VISUAL_MODEL_DIR ?? "data/visual-models");
const archives = await clientArchives(clientDirectory());

// Every path this run read, in the order it read them: the stamp beside each published file names
// all of them, so a module that replaces a skin, an .anim or one of a building's group files makes
// this artifact stale even though the model's own path did not change.
const read = [];

async function require(path, label) {
  const data = await archives.read(path);
  if (!data) sourceMissing(`${label} ${path} is not in the client`);
  read.push(path);
  return data;
}

/**
 * Ends the run with the one exit code that means «the archives do not hold this», and no other.
 *
 * Т6 taught `/texture` to tell a missing file from a dead generator and gave the browser a retry
 * ladder for the second; the model route was left answering 404 for both, and `EnvironmentClient`
 * then wrote the model off for the life of the tab. A whole city stood as an empty placement — a
 * grey box, before this same slice — because of one 500 the browser was told to read as 404. This
 * is the end of the agreement that chooses: `sourceMissing()` in `src/gateway/Gateway.ts` reads
 * the code back off the child, and `npm test` pins the two numbers together.
 *
 * `writeSync` and `process.exit` rather than the `try`/`catch` its two sibling generators use,
 * because this file is a script and not a module with a main guard: its body is a hundred lines of
 * top-level `await`, a rejection out of one of those is fatal *before* any handler runs — measured,
 * `process.exitCode = 3` then a throw still exits 1 — and wrapping the lot to carry one status code
 * would be a hundred-line re-indent. The write has to be synchronous: stderr here is a pipe the
 * gateway is reading, a pipe write on Windows is asynchronous, and `process.exit` behind an
 * asynchronous write drops the very sentence the gateway relays.
 */
function sourceMissing(message) {
  writeSync(2, `${message}\n`);
  archives.close();
  process.exit(SOURCE_MISSING_EXIT);
}

await mkdir(destination, { recursive: true });
const unresolved = [];

if (modelPath.toLowerCase().endsWith(".m2")) {
  const m2Data = await require(modelPath, "Model");
  const skinData = await require(`${modelPath.slice(0, -3)}00.skin`, "Skin");
  const model = parseM2(m2Data, skinData);

  // Every animation the model has, and the keyframes of all of them: the ones inside the .m2 and
  // the ones in the `Model####-##.anim` files beside it, which used to be skipped and are mostly
  // movement — 18 % of the sequences in this client, including every emote a character plays.
  // The emitters, the ribbons and the global sequences their tracks run on. Header slots 0x14,
  // 0x120 and 0x128 — the last two were counted and dropped on the floor until slice R1.
  const effects = {
    globalSequences: readGlobalSequences(m2Data, headerArray(m2Data, 0x14)),
    particleEmitters: readParticleEmitters(m2Data, headerArray(m2Data, 0x128)),
    ribbonEmitters: readRibbonEmitters(m2Data, headerArray(m2Data, 0x120)),
  };

  const animations = m2Animations(m2Data);
  const external = new Map();
  for (const animation of animations) {
    if (!animation.external || external.has(animation.external)) continue;
    const animationPath = `${modelPath.slice(0, -3)}${animation.external}.anim`;
    const animationData = await archives.read(animationPath);
    if (animationData) read.push(animationPath);
    external.set(animation.external, animationData);
  }

  let skeleton;
  try {
    skeleton = parseM2Skeleton(m2Data, { animations: external });
  } catch (error) {
    console.warn(`Skeleton unavailable for ${modelPath}: ${error instanceof Error ? error.message : error}`);
  }

  // Which clips travel with the model. Names, not numbers: see tools/animations.mjs.
  const base = baseAnimationIds(await loadAnimationCatalog());
  const shipped = skeleton ? skeleton.clips.filter((clip) => base.has(clip.animationId)) : [];
  const rest = skeleton ? skeleton.clips.filter((clip) => !base.has(clip.animationId)) : [];

  // Only the model's own textures can be published here; the rest are per-appearance and the
  // browser asks for them by path once it knows which appearance it is drawing.
  for (const texture of model.textures) {
    if (texture.type !== TEXTURE_TYPE_OWN || !texture.filename) continue;
    try {
      await publishTexture(texture.filename, archives);
    } catch (error) {
      unresolved.push(`${texture.filename} (${error instanceof Error ? error.message : error})`);
    }
  }

  const shippedSkeleton = skeleton ? { ...skeleton, clips: shipped } : undefined;
  await writeFile(join(destination, `${hash}.bin`),
    encodeWvm9(model, shippedSkeleton, animations.map((animation) => animation.animationId), effects));
  // Always written, even empty: a model with nothing held back still has to answer the request
  // rather than send the browser back for it on every frame.
  if (skeleton) await writeFile(join(destination, `${hash}.anim.bin`), encodeWvaAnimations(skeleton.bones.length, rest));
  const stamp = await sourceStamp(archives, { paths: read });
  await writeSourceStamp(join(destination, `${hash}.bin`), stamp);
  if (skeleton) await writeSourceStamp(join(destination, `${hash}.anim.bin`), stamp);

  const rig = skeleton
    ? `, ${skeleton.bones.length} bones, ${shipped.length} of ${animations.length} animations shipped`
      + `${external.size > 0 ? `, ${external.size} external` : ""}`
      + `${skeleton.missingAnimations > 0 ? `, ${skeleton.missingAnimations} without data` : ""}`
    : "";
  const slots = model.textures.map((texture) => texture.type).join("/");
  console.log(`Generated M2 ${modelPath}: ${model.positions.length / 3} vertices, ${model.indices.length / 3} triangles, `
    + `${model.submeshes.length} submeshes, ${model.batches.length} batches, texture slots ${slots}${rig}`);
} else {
  // A WMO publishes as WWM1/WWM2: its groups, each one able to travel on its own. They have no geosets
  // and no skeleton, and what they do have instead is a hundred rooms nobody can see at once.
  const rootWmo = await require(modelPath, "WMO");
  const dependencies = wmoDependencies(rootWmo, modelPath);
  const groups = [];
  for (const path of dependencies.groups) groups.push(await require(path, "WMO group"));
  const parsed = wmoGroupMeshes(parseWmoVisual(rootWmo, groups, modelPath));

  const textureUrls = new Array(parsed.textures.length).fill("");
  for (let index = 0; index < parsed.textures.length; index++) {
    const path = parsed.textures[index];
    if (!path) continue;
    const written = await writeBlpAsPng(await archives.read(path), join(destination, `${hash}-${index}.png`));
    if (written.ok) {
      textureUrls[index] = `/visual/texture/${hash}-${index}.png`;
      // A building's textures have no route that could regenerate them on their own, so they are
      // named among this artifact's sources: replacing one makes the whole model stale, and
      // rebuilding it rewrites the pictures beside it.
      read.push(path);
    } else unresolved.push(`${path} (${written.reason})`);
  }

  const triangles = parsed.groups.reduce((total, group) => total + group.indices.length / 3, 0);
  // Over the budget the header travels alone and each group is written beside it, so a request for
  // one room reads one file. Written at publish time rather than sliced per request: the gateway
  // has no WMO parser and should not grow one to answer a fetch.
  const split = triangles > WWM_TRIANGLE_BUDGET;
  await writeFile(join(destination, `${hash}.bin`), encodeWwm(parsed, textureUrls, split ? new Set() : undefined));
  const stamp = await sourceStamp(archives, { paths: read });
  await writeSourceStamp(join(destination, `${hash}.bin`), stamp);
  if (split) {
    for (const [index, group] of parsed.groups.entries()) {
      const file = join(destination, `${hash}.g${String(index).padStart(3, "0")}.bin`);
      await writeFile(file, encodeWwmGroup(group, index));
      // Each room is asked for under its own URL, so each one carries the stamp.
      await writeSourceStamp(file, stamp);
    }
  }
  const vertices = parsed.groups.reduce((total, group) => total + group.positions.length / 3, 0);
  console.log(`Generated WMO ${modelPath}: ${vertices} vertices, ${triangles} triangles, ${parsed.groups.length} groups`
    + `${split ? ", published one group at a time" : ""}`);
}

// A model that ships without one of its textures renders as flat colour, so say which and why
// instead of leaving it to be discovered in game.
if (unresolved.length > 0) console.warn(`  ${unresolved.length} texture(s) unresolved: ${unresolved.join("; ")}`);

archives.close();

/** An `M2Array` out of the MD20 header: a count and a file offset, eight bytes. */
function headerArray(buffer, at) {
  return { count: buffer.readUInt32LE(at), offset: buffer.readUInt32LE(at + 4) };
}
