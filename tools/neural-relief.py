"""
25.10 (7.47, neural maps): height maps for the ground textures from a neural network instead of their brightness.

Run by `tools/neural-relief.mjs`, which finds the Python environment and the model in `.runtime/tools/deepbump/`
(DeepBump v8 `deepbump256.onnx`, GPL-3, never copied into this repository: only this script, which loads it, is ours).

DeepBump predicts a tangent-space normal map from a texture's grey image: it was trained on pairs of photographed
materials and their scanned normals, so it tells a dark stone from a dark joint where brightness cannot. The normals
are integrated into a height (Frankot–Chellappa on the torus: a ground texture repeats), high-passed at the radius
the brightness relief uses (TerrainReliefDerive.ts `TERRAIN_RELIEF_LARGE_RADIUS`), and written in texels of the
layer — a physical scale, not normalised per texture, so sand stays flat and cobbles stay deep. The browser turns
the height into the relief map (TerrainReliefNeural.ts).

Input: every ground layer PNG `/terrain-layer/<id>.png` serves (`data/terrain-layers/<id>.png`, with its `.src`
stamp naming the BLP); the `_s` specular masks beside them are skipped. Output: `<out>/<id>.bin` and
`<out>/manifest.json`. A layer whose PNG and model are unchanged since its entry is not computed again.

`.bin`: "NRH1", u16 width, u16 height (little-endian), then width·height int16, row 0 the PNG's top row, in
1/256 of a layer texel.
"""

import hashlib
import json
import os
import struct
import sys
import time

import numpy as np
import onnxruntime as ort
from PIL import Image

MAGIC = b"NRH1"
UNITS_PER_TEXEL = 256
TILE = 256
STRIDE = 128
# TerrainReliefDerive.ts: three box passes of radius 12/128 of the relief side (half the layer's) —
# a Gaussian of sigma sqrt(((2r+1)^2 - 1) / 4) relief texels, as a fraction of the side.
HIGH_PASS_SIGMA = ((25 ** 2 - 1) / 4) ** 0.5 / 128


def sha1_of(path):
    with open(path, "rb") as handle:
        return hashlib.sha1(handle.read()).hexdigest()


def sha256_of(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def layer_path(stamp_file):
    """The BLP a layer PNG was made from, or None for a specular mask (its stamp names the `_s` file too)."""
    try:
        with open(stamp_file, "r", encoding="utf-8") as handle:
            stamp = json.load(handle)
    except (OSError, ValueError):
        return None
    paths = [source.get("path", "") for source in stamp.get("sources", []) if isinstance(source, dict)]
    if not paths or any(path.lower().endswith("_s.blp") for path in paths):
        return None
    return paths[0]


def window():
    ramp = np.sin(np.pi * (np.arange(TILE) + 0.5) / TILE) ** 2
    return np.outer(ramp, ramp)


def predict_normals(session, grey):
    """Normals of a repeating image: 256² tiles at a 128 stride over a wrap-padded copy, blended by a sin² window."""
    side_y, side_x = grey.shape
    pad = TILE - STRIDE
    big = np.pad(grey, pad, mode="wrap")
    total = np.zeros((3,) + big.shape)
    weight = np.zeros(big.shape)
    blend = window()
    for y in range(0, side_y + 2 * pad - TILE + 1, STRIDE):
        for x in range(0, side_x + 2 * pad - TILE + 1, STRIDE):
            tile = big[y:y + TILE, x:x + TILE][None, None].astype(np.float32)
            total[:, y:y + TILE, x:x + TILE] += session.run(None, {"input": tile})[0][0] * blend
            weight[y:y + TILE, x:x + TILE] += blend
    normals = (total / np.maximum(weight, 1e-6))[:, pad:pad + side_y, pad:pad + side_x] - 0.5
    return normals / np.sqrt(np.sum(normals * normals, axis=0, keepdims=True))


def integrate(normals):
    """Height in texels from unit normals. DeepBump's R is -dh/dx, its G +dh/d(row) (y up, rows down)."""
    nx, ny, nz = normals
    nz = np.maximum(nz, 0.2)
    gx = -nx / nz
    gy = ny / nz
    side_y, side_x = gx.shape
    u, v = np.meshgrid(np.fft.fftfreq(side_x), np.fft.fftfreq(side_y))
    du, dv = 2j * np.pi * u, 2j * np.pi * v
    denominator = np.abs(du) ** 2 + np.abs(dv) ** 2
    denominator[0, 0] = 1
    spectrum = (np.conj(du) * np.fft.fft2(gx) + np.conj(dv) * np.fft.fft2(gy)) / denominator
    spectrum[0, 0] = 0
    # The high-pass: what is wider than the brightness relief's large radius is shading, not height.
    sigma_x, sigma_y = HIGH_PASS_SIGMA * side_x, HIGH_PASS_SIGMA * side_y
    low = np.exp(-2 * np.pi ** 2 * ((sigma_x * u) ** 2 + (sigma_y * v) ** 2))
    return np.real(np.fft.ifft2(spectrum * (1 - low)))


def write_height(path, height):
    side_y, side_x = height.shape
    values = np.clip(np.round(height * UNITS_PER_TEXEL), -32768, 32767).astype("<i2")
    temporary = path + ".tmp"
    with open(temporary, "wb") as handle:
        handle.write(MAGIC + struct.pack("<HH", side_x, side_y) + values.tobytes())
    os.replace(temporary, path)


def write_manifest(path, model_sha, entries):
    temporary = path + ".tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump({"version": 1, "model": model_sha, "entries": entries}, handle, indent=1, sort_keys=True)
    os.replace(temporary, path)


def main():
    model, layers, out = sys.argv[1:4]
    os.makedirs(out, exist_ok=True)
    manifest_file = os.path.join(out, "manifest.json")
    model_sha = sha256_of(model)
    try:
        with open(manifest_file, "r", encoding="utf-8") as handle:
            manifest = json.load(handle)
    except (OSError, ValueError):
        manifest = {}
    previous = manifest.get("entries", {}) if manifest.get("model") == model_sha else {}
    ort.disable_telemetry_events()
    session = ort.InferenceSession(model, providers=["CPUExecutionProvider"])
    entries, made, kept, failed = {}, 0, 0, 0
    started = time.time()
    for name in sorted(os.listdir(layers)):
        if not name.endswith(".png") or len(name) != 44:
            continue
        layer_id = name[:-4]
        png = os.path.join(layers, name)
        texture = layer_path(png + ".src")
        if texture is None:
            continue
        png_sha = sha1_of(png)
        target = os.path.join(out, layer_id + ".bin")
        known = previous.get(layer_id)
        if known and known.get("png") == png_sha and os.path.exists(target):
            entries[layer_id] = known
            kept += 1
            continue
        try:
            rgb = np.asarray(Image.open(png).convert("RGB"), dtype=np.float64) / 255
            height = integrate(predict_normals(session, rgb.mean(axis=2)))
            write_height(target, height)
        except Exception as error:  # one bad layer costs only its own map
            print(f"{texture}: {error}", file=sys.stderr)
            failed += 1
            continue
        entries[layer_id] = {"path": texture, "png": png_sha, "side": int(height.shape[1]),
                             "deviation": round(float(height.std()), 4)}
        made += 1
        if made % 50 == 0:
            # An interrupted run keeps what it made: the next one finds these entries unchanged.
            write_manifest(manifest_file, model_sha, {**previous, **entries})
            print(f"{made} made, {time.time() - started:.0f} s", flush=True)
    write_manifest(manifest_file, model_sha, entries)
    print(f"neural relief: {made} made, {kept} unchanged, {failed} failed, {time.time() - started:.1f} s")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
