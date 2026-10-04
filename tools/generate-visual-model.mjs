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
//
// `publishVisualModel` is the whole of it and takes an archive chain that is already open, so
// `tools/asset-worker.mjs` can publish model after model out of one chain: measured on this
// machine, a doodad costs 9–25 ms with the chain held and ~450 ms as a process of its own, of
// which ~190 ms is opening the thirty sources again. Run directly, this file is still the one-shot
// generator it always was.

import { randomUUID } from "node:crypto";
import { writeSync } from "node:fs";
import { copyFile, link, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { m2Animations, parseM2, parseM2Skeleton, TEXTURE_TYPE_OWN } from "./m2.mjs";
import { encodeWvaAnimations, encodeWvm9 } from "./wvm.mjs";
import { readGlobalSequences, readParticleEmitters, readRibbonEmitters } from "./m2-particles.mjs";
import { baseAnimationIds, loadAnimationCatalog } from "./animations.mjs";
import { parseWmoVisual, wmoDependencies, wmoGroupMeshes } from "./wmo-visual.mjs";
import { WWM_TRIANGLE_BUDGET, encodeWwm, encodeWwmGroup } from "./wwm.mjs";
import { writeBlpAsPng } from "./blp-png.mjs";
import { publishTexture, SourceMissing, SOURCE_MISSING_EXIT, validTexturePath } from "./generate-texture.mjs";
import { clientArchives } from "./mpq.mjs";
import { clientDirectory } from "./paths.mjs";
import { sourceStamp, stampIsCurrent, writeFileAtomic, writeSourceStamp } from "./source-stamp.mjs";
// Out of the build, not copied: see the note over the same import in `generate-texture.mjs`.
import { validAssetPath } from "../dist/code/gateway/AssetPath.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Where the artifacts go: read per call, so a test or a worker's environment decides. */
export function visualModelDirectory() {
  return resolve(root, process.env.VISUAL_MODEL_DIR ?? "data/visual-models");
}

/**
 * Publishes one model out of an open chain.
 *
 * Throws `SourceMissing` — the one failure the gateway answers 404 — when the archives hold no
 * model, skin or WMO group it needs; every other throw is a failure of this run.
 *
 * The route's own validator, for the same reason `generate-texture.mjs` calls it: a class written
 * out here is a class that drifts from the one the request already passed. This one was
 * ASCII-only where `validAssetPath` is Unicode — measured, that separates none of the client's
 * 33,512 model paths, and every module path written in the author's own alphabet, which is
 * precisely the case Д6 widened the route to accept.
 */
export async function publishVisualModel(requestedPath, hash, archives) {
  const modelPath = requestedPath.replaceAll("/", "\\");
  if (!validAssetPath(modelPath, { extensions: ["m2", "wmo"] }) || !/^[0-9a-f]{40}$/.test(hash)) {
    throw new Error("Usage: node tools/generate-visual-model.mjs <m2-or-wmo-path> <sha1>");
  }
  const destination = visualModelDirectory();

  // Every path this run read, in the order it read them: the stamp beside each published file names
  // all of them, so a module that replaces a skin, an .anim or one of a building's group files makes
  // this artifact stale even though the model's own path did not change.
  const read = [];

  async function require(path, label) {
    const data = await archives.read(path);
    if (!data) throw new SourceMissing(`${label} ${path} is not in the client`);
    read.push(path);
    return data;
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
    await writeFileAtomic(join(destination, `${hash}.bin`),
      encodeWvm9(model, shippedSkeleton, animations.map((animation) => animation.animationId), effects));
    // Always written, even empty: a model with nothing held back still has to answer the request
    // rather than send the browser back for it on every frame.
    if (skeleton) await writeFileAtomic(join(destination, `${hash}.anim.bin`), encodeWvaAnimations(skeleton.bones.length, rest));
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
      const written = await publishWmoTexture(path, join(destination, `${hash}-${index}.png`), archives);
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
    await writeFileAtomic(join(destination, `${hash}.bin`), encodeWwm(parsed, textureUrls, split ? new Set() : undefined));
    const stamp = await sourceStamp(archives, { paths: read });
    await writeSourceStamp(join(destination, `${hash}.bin`), stamp);
    if (split) {
      for (const [index, group] of parsed.groups.entries()) {
        const file = join(destination, `${hash}.g${String(index).padStart(3, "0")}.bin`);
        await writeFileAtomic(file, encodeWwmGroup(group, index));
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
}

/**
 * One WMO texture beside its artifact, through the shared texture cache (10.20 slice 3).
 *
 * The WMO route keeps its own URL (`/visual/texture/<hash>-<n>.png`, which `WmoModel.ts` tells
 * apart by its prefix), but the picture is the one `publishTexture` publishes for the same path —
 * the same `blpToPng`, so the same bytes — and that one is decoded once for every building that
 * uses it. Measured over the client's 1,985 root WMOs: 24,202 texture references to 4,853 distinct
 * paths, so four decodes in five were repeats. The file is then hard-linked (or, where a link is
 * refused, copied) into place under a temporary name and renamed, so a reader never sees half of it.
 *
 * A shared picture is used only when its stamp is current for this chain: `publishTexture` skips
 * any file that has a stamp at all, and the gateway's `/texture` route is what retires stale ones —
 * a WMO published from a stale picture would carry a stamp naming the new source and never be
 * rebuilt. A path outside the texture class, a stale or missing shared picture, or any failure on
 * the way falls back to decoding into place as before, with the same reasons.
 */
export async function publishWmoTexture(path, target, archives) {
  if (validTexturePath(path)) {
    try {
      const shared = await publishTexture(path, archives);
      if (!shared.cached || await stampIsCurrent(shared.destination, archives, { paths: [path] })) {
        await linkOrCopy(shared.destination, target);
        return { ok: true, shared: true };
      }
    } catch {
      // Not in the client, undecodable, or the link and the copy both refused: the old way says why.
    }
  }
  return writeBlpAsPng(await archives.read(path), target);
}

/** `target` becomes the same bytes as `source`: a hard link where allowed, a copy otherwise. */
async function linkOrCopy(source, target) {
  try {
    const [from, to] = await Promise.all([stat(source, { bigint: true }), stat(target, { bigint: true })]);
    if (from.ino !== 0n && from.ino === to.ino && from.dev === to.dev) return;
  } catch {
    // No target yet.
  }
  const temporary = `${target}.${process.pid}-${randomUUID()}.tmp`;
  try {
    try {
      await link(source, temporary);
    } catch {
      // Another volume (EXDEV), a file system without links, or a refusal (EPERM): copy instead.
      await copyFile(source, temporary);
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(temporary, target);
        return;
      } catch (error) {
        const code = /** @type {NodeJS.ErrnoException} */ (error).code;
        if (attempt >= 5 || (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY")) throw error;
        await new Promise((done) => setTimeout(done, 15 * (attempt + 1)));
      }
    }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** An `M2Array` out of the MD20 header: a count and a file offset, eight bytes. */
function headerArray(buffer, at) {
  return { count: buffer.readUInt32LE(at), offset: buffer.readUInt32LE(at + 4) };
}

// Run directly: node tools/generate-visual-model.mjs "World\Generic\...\Thing.m2" <sha1>
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const archives = await clientArchives(clientDirectory());
  try {
    await publishVisualModel(process.argv[2] ?? "", process.argv[3] ?? "", archives);
  } catch (error) {
    // The one failure the caller can do something with, said in the only way that survives the
    // process boundary: Т6 taught `/texture` to tell a missing file from a dead generator, and
    // `sourceMissing()` in `src/gateway/Gateway.ts` reads this code back off the child — a 404 the
    // browser takes as final, where anything else is a 500 it retries. `npm test` pins the two
    // numbers together. The write is synchronous because stderr is a pipe the gateway reads and a
    // pipe write on Windows is asynchronous; everything else keeps its stack and node's exit code.
    if (!(error instanceof SourceMissing)) throw error;
    writeSync(2, `${error.message}\n`);
    process.exitCode = SOURCE_MISSING_EXIT;
  } finally {
    archives.close();
  }
}
