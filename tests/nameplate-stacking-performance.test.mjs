import assert from 'node:assert/strict';
import test from 'node:test';
import { stackPlates } from '../dist/code/browser/NamePlate.js';

function plate(x, y, depth, width = 144, height = 32) {
  return { depth, box: { x, y, width, height, scale: 1 } };
}

function intersects(left, right) {
  return left.x + left.width > right.x && right.x + right.width > left.x
    && left.y + left.height > right.y && right.y + right.height > left.y;
}

test('a dense vertical crowd is resolved with quadratic rather than cubic box visits', () => {
  const count = 120;
  const plates = Array.from({ length: count }, (_, index) => plate(400, index * 34, index));
  for (let index = 0; index < count; index++) {
    plates.push(plate(400, (count - 1) * 34, count + index));
  }
  let reads = 0;
  for (const { box } of plates) {
    const x = box.x;
    Object.defineProperty(box, 'x', { get() { reads++; return x; } });
  }
  const identity = [...plates];
  assert.equal(stackPlates(plates), plates);
  assert.deepEqual(plates, identity, 'the caller keeps painter and picking order');
  assert.ok(reads < plates.length ** 2 * 3,
    `a crowd must not repeatedly scan every settled plate after each shove (${reads} x reads)`);
  for (let index = 0; index < count; index++) {
    assert.equal(plates[index].box.y, index * 34, 'nonoverlapping nearer anchors remain in place');
    assert.equal(plates[count + index].box.y, -(index + 1) * 34, 'each far plate clears the chain');
  }
});

test('mixed widths, cast heights, depth ties and negative anchors keep every plate reachable', () => {
  let seed = 0x5eed;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let attempt = 0; attempt < 100; attempt++) {
    const plates = Array.from({ length: 80 }, () => plate(
      random() * 1000 - 200, random() * 800 - 200, Math.floor(random() * 20),
      100 + random() * 70, 20 + random() * 50,
    ));
    const before = plates.map(({ box }) => ({ ...box }));
    const nearest = plates.reduce((best, next) => next.depth < best.depth ? next : best);
    const nearestY = nearest.box.y;
    const identity = [...plates];
    stackPlates(plates);
    assert.equal(nearest.box.y, nearestY, 'nearest plate wins its original anchor, including ties');
    for (let index = 0; index < plates.length; index++) {
      const box = plates[index].box;
      assert.equal(plates[index], identity[index]);
      assert.ok(box.y <= before[index].y, 'collision resolution only raises a plate');
      assert.deepEqual({ ...box, y: before[index].y }, before[index], 'size and horizontal anchor are preserved');
      for (let other = 0; other < index; other++) {
        assert.equal(intersects(box, plates[other].box), false, 'plates and their click targets never overlap');
      }
    }
    const settled = plates.map(({ box }) => ({ ...box }));
    stackPlates(plates);
    assert.deepEqual(plates.map(({ box }) => box), settled, 'settled placement is stable');
  }
});

test('plates touching horizontally or vertically are not needlessly displaced', () => {
  const plates = [plate(0, 0, 1), plate(144, 0, 2), plate(0, 32, 3), plate(0, -32, 4)];
  const before = structuredClone(plates);
  stackPlates(plates);
  assert.deepEqual(plates, before);
  assert.deepEqual(stackPlates([]), []);
});
