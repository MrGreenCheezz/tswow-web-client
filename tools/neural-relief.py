"""
25.10 (7.47, neural maps): height maps for the game's textures from a neural network instead of their brightness.

Run by `tools/neural-relief.mjs`, which finds the Python environment and the model in `.runtime/tools/deepbump/`
(DeepBump v8 `deepbump256.onnx`, GPL-3, never copied into this repository: only this script, which loads it, is ours)
and hands over the list of textures to compute.

DeepBump predicts a tangent-space normal map from a texture's grey image: it was trained on pairs of photographed
materials and their scanned normals, so it tells a dark stone from a dark joint where brightness cannot. The normals
are integrated into a height (Frankot–Chellappa), high-passed at the radius the brightness relief uses
(TerrainReliefDerive.ts `TERRAIN_RELIEF_LARGE_RADIUS`), and written in texels of the texture — a physical scale, not
normalised per texture, so sand stays flat and cobbles stay deep. The browser turns the height into the relief map
(TerrainReliefNeural.ts, WmoReliefNeural.ts).

A repeating texture (`wrap`: the ground, the buildings) is read as a torus. A doodad's atlas is not: its islands are
read mirrored at the edges, and the height integrated over the mirrored copy, so an edge never pulls in the opposite
one. A texture under 256 texels on its longer side is enlarged (by a power of two, at most 8×) before the network
reads it — it was trained on materials about that size — and its height is given back in the texture's own texels.

Jobs: a JSON list of `{"png", "out", "wrap"}`. `.bin`: "NRH1", u16 width, u16 height (little-endian), then
width·height int16, row 0 the PNG's top row, in 1/256 of a texel of the texture.
"""

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
STRIDE = 192
NETWORK_SIDE = 256
MAX_ENLARGE = 8
# TerrainReliefDerive.ts: three box passes of radius 12/128 of the relief side (half the layer's) —
# a Gaussian of sigma sqrt(((2r+1)^2 - 1) / 4) relief texels, as a fraction of the side.
HIGH_PASS_SIGMA = ((25 ** 2 - 1) / 4) ** 0.5 / 128


def window():
    ramp = np.sin(np.pi * (np.arange(TILE) + 0.5) / TILE) ** 2
    return np.outer(ramp, ramp)


BLEND = window()


def predict_normals(session, grey, wrap):
    """Unit normals: 256² tiles at a 192 stride (a quarter overlap: half the tiles of a half overlap) over a padded
    copy (wrapped or mirrored), blended by a sin² window."""
    rows, columns = grey.shape
    pad = TILE - STRIDE
    extra_y, extra_x = (-rows) % STRIDE, (-columns) % STRIDE
    big = np.pad(grey, ((pad, pad + extra_y), (pad, pad + extra_x)), mode="wrap" if wrap else "symmetric")
    total = np.zeros((3,) + big.shape)
    weight = np.zeros(big.shape)
    for y in range(0, big.shape[0] - TILE + 1, STRIDE):
        for x in range(0, big.shape[1] - TILE + 1, STRIDE):
            tile = big[y:y + TILE, x:x + TILE][None, None].astype(np.float32)
            total[:, y:y + TILE, x:x + TILE] += session.run(None, {"input": tile})[0][0] * BLEND
            weight[y:y + TILE, x:x + TILE] += BLEND
    normals = (total / np.maximum(weight, 1e-6))[:, pad:pad + rows, pad:pad + columns] - 0.5
    return normals / np.sqrt(np.sum(normals * normals, axis=0, keepdims=True))


def integrate(normals, wrap, sigma):
    """Height in texels from unit normals. DeepBump's R is -dh/dx, its G +dh/d(row) (y up, rows down)."""
    nx, ny, nz = normals
    nz = np.maximum(nz, 0.2)
    gx = -nx / nz
    gy = ny / nz
    rows, columns = gx.shape
    if not wrap:
        # The mirrored copy (DeepBump's own way for a texture that does not repeat): even in x for gy, odd for gx.
        gx = np.vstack([np.hstack([gx, -gx[:, ::-1]]), np.hstack([gx[::-1, :], -gx[::-1, ::-1]])])
        gy = np.vstack([np.hstack([gy, gy[:, ::-1]]), np.hstack([-gy[::-1, :], -gy[::-1, ::-1]])])
    height, width = gx.shape
    u, v = np.meshgrid(np.fft.fftfreq(width), np.fft.fftfreq(height))
    du, dv = 2j * np.pi * u, 2j * np.pi * v
    denominator = np.abs(du) ** 2 + np.abs(dv) ** 2
    denominator[0, 0] = 1
    spectrum = (np.conj(du) * np.fft.fft2(gx) + np.conj(dv) * np.fft.fft2(gy)) / denominator
    spectrum[0, 0] = 0
    # The high-pass: what is wider than the brightness relief's large radius is shading, not height.
    low = np.exp(-2 * np.pi ** 2 * sigma ** 2 * (u ** 2 + v ** 2))
    result = np.real(np.fft.ifft2(spectrum * (1 - low)))
    return result[:rows, :columns]


def height_of(session, png, wrap):
    image = Image.open(png).convert("RGB")
    width, height = image.size
    enlarge = 1
    while max(width, height) * enlarge < NETWORK_SIDE and enlarge < MAX_ENLARGE:
        enlarge *= 2
    if enlarge > 1:
        image = image.resize((width * enlarge, height * enlarge), Image.BICUBIC)
    grey = np.asarray(image, dtype=np.float64).mean(axis=2) / 255
    sigma = HIGH_PASS_SIGMA * max(grey.shape)
    field = integrate(predict_normals(session, grey, wrap), wrap, sigma)
    if enlarge > 1:
        # Back to the texture's own texels: the mean of each enlarged block, in its units.
        field = field.reshape(height, enlarge, width, enlarge).mean(axis=(1, 3)) / enlarge
    return field


def write_height(path, height):
    rows, columns = height.shape
    values = np.clip(np.round(height * UNITS_PER_TEXEL), -32768, 32767).astype("<i2")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temporary = path + ".tmp"
    with open(temporary, "wb") as handle:
        handle.write(MAGIC + struct.pack("<HH", columns, rows) + values.tobytes())
    os.replace(temporary, path)


def main():
    model, jobs_file = sys.argv[1:3]
    with open(jobs_file, "r", encoding="utf-8") as handle:
        jobs = json.load(handle)
    ort.disable_telemetry_events()
    session = ort.InferenceSession(model, providers=["CPUExecutionProvider"])
    made, failed = 0, 0
    started = time.time()
    for job in jobs:
        try:
            write_height(job["out"], height_of(session, job["png"], bool(job["wrap"])))
            made += 1
        except Exception as error:  # one bad texture costs only its own map
            print(f"{job['png']}: {error}", file=sys.stderr)
            failed += 1
        if (made + failed) % 100 == 0:
            print(f"{made + failed}/{len(jobs)}, {time.time() - started:.0f} s", flush=True)
    print(f"neural relief: {made} made, {failed} failed, {time.time() - started:.1f} s")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
