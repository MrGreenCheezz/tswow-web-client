// A10 / 6.21 (read-only): printable strings in the 3.3.5a client binary that touch animation data,
// spell visual kits and upper-body / lower-body blending. Nothing is run; the file is only read.
import { readFile } from "node:fs/promises";

const exe = await readFile("F:/Circle/Wow.exe.clean");
console.log(`Wow.exe.clean ${exe.length} bytes`);
const text = exe.toString("latin1");
const keywords = [
  /AnimationData/i, /BodyFlags/i, /WeaponFlags/i, /StartAnim/i, /SpellVisualKit/i, /SpellVisuals/i,
  /UpperBody|LowerBody|upper body|lower body/i, /SpellCast\b|SpellCastOmni|ChannelCast/i,
  /anim.*blend|blend.*anim/i, /Animation.*(fallback|behavior)/i, /\bAnimTier\b|BehaviorTier|BehaviorID/i,
  /\.\\Spell\w*\.cpp|\.\\CGUnit\w*\.cpp|\.\\M2\w*\.cpp|\.\\CM2\w*\.cpp|Animation\w*\.cpp|Anim\w*\.cpp/i,
];
const seen = new Map();
for (const match of text.matchAll(/[ -~]{5,200}/g)) {
  const value = match[0];
  if (!keywords.some((keyword) => keyword.test(value))) continue;
  if (!seen.has(value)) seen.set(value, match.index);
}
for (const [value, at] of [...seen].sort((a, b) => a[1] - b[1])) console.log(`${at.toString(16).padStart(8, "0")}  ${value}`);
console.log(`\n${seen.size} distinct strings`);
