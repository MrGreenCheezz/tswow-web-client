// 24.10 (7.50): a small city published as `tools/wwm.mjs` publishes Stormwind — a root carrying one group, the others
// files of their own — for the lamp-table tests (tests/wmo-lamp-table*.test.mjs, tests/prelit-lights.test.mjs).
import { encodeWwm, encodeWwmGroup } from "../../tools/wwm.mjs";

/** Four panes facing out from `centre` along `headings` (degrees): with SIDN, a lantern. */
export function lanternPanes(centre, offset = 0.3, headings = [0, 90, 180, 270]) {
  const positions = [];
  const indices = [];
  for (const degrees of headings) {
    const nx = Math.cos(degrees * Math.PI / 180), ny = Math.sin(degrees * Math.PI / 180);
    const base = positions.length / 3;
    for (const [s, u] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      positions.push(centre[0] + nx * offset - ny * 0.2 * s, centre[1] + ny * offset + nx * 0.2 * s, centre[2] + 0.3 * u);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { positions, indices };
}

/** A group for `encodeWwm`: pieces of [panes, materialFlags], one run each. */
function group(flags, pieces) {
  const positions = [];
  const indices = [];
  const runs = [];
  for (const [{ positions: p, indices: i }, materialFlags] of pieces) {
    const base = positions.length / 3;
    runs.push({ start: indices.length, count: i.length, material: 0, blendMode: 0, materialFlags, lighting: 0 });
    positions.push(...p);
    indices.push(...i.map((index) => index + base));
  }
  const vertexCount = positions.length / 3;
  return { flags, positions, indices, runs, uvs: new Array(vertexCount * 2).fill(0), colours: new Array(vertexCount * 4).fill(255),
    min: [-100, -100, -100], max: [100, 100, 100] };
}

export const buffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

/**
 * Four groups: a street flagged indoor (MOGP 0x2A41) with a lantern at (10, 20, 5) and a window; a shop (0x2A05) with
 * a lantern; a canal (0x1809) with lantern-shaped panes that have no night glow; an outdoor porch of one triangle.
 * `root` carries the shop's block only; `files` holds the other three by group index.
 */
export function syntheticCity() {
  const porch = group(0x0008, []);
  Object.assign(porch, { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], uvs: new Array(6).fill(0), colours: new Array(12).fill(255), indices: [0, 1, 2] });
  const groups = [
    group(0x2a41, [[lanternPanes([10, 20, 5]), 0xd0], [lanternPanes([40, 0, 5], 0.3, [0]), 0x10]]),
    group(0x2a05, [[lanternPanes([50, 2, 3]), 0xd0]]),
    group(0x1809, [[lanternPanes([-7, 8, 9]), 0x00]]),
    porch,
  ];
  const model = { groups, textures: [], lights: [] };
  const root = encodeWwm(model, [], new Set([1]));
  const files = new Map([0, 2, 3].map((index) => [index, encodeWwmGroup(groups[index], index)]));
  return { model, root, files };
}
