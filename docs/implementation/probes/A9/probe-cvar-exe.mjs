// A9 (read-only): printable strings around camera/mouse CVar names in the 3.3.5a client binary.
// The goal is the compiled-in default of each CVar; MSVC lays the name, help text and default
// literal of one Register call close together, so the neighbourhood is printed rather than guessed.
import { readFile } from "node:fs/promises";

const exe = await readFile("F:/Circle/Wow.exe.clean").catch(() => readFile("F:/Circle/Wow.exe"));
const names = [
  "cameraDistanceMax", "cameraDistanceMaxFactor", "cameraDistance", "cameraSmoothStyle",
  "cameraSmoothTrackingStyle", "cameraSmoothPitchStyle", "cameraPitchSmoothSpeed", "cameraYawSmoothSpeed",
  "cameraPitchMoveSpeed", "cameraYawMoveSpeed", "cameraTerrainTilt", "cameraBobbing", "cameraWaterCollision",
  "cameraPivot", "cameraHeightIgnoreStandState", "mouseSpeed", "InvertMouse", "deselectOnClick",
  "autoInteract", "stopAutoAttackOnTargetChange", "autoDismountFlying", "cameraSavedDistance",
  "cameraFov", "cameraViewBlendStyle",
];
for (const name of names) {
  const needle = Buffer.from(`${name}\0`, "latin1");
  let from = 0;
  let shown = 0;
  console.log(`== ${name}`);
  for (;;) {
    const at = exe.indexOf(needle, from);
    if (at < 0) break;
    from = at + 1;
    // Only a whole-word start: the byte before must not be a name character.
    const before = at === 0 ? 0 : exe[at - 1];
    if ((before >= 0x30 && before <= 0x39) || (before >= 0x41 && before <= 0x5a) || (before >= 0x61 && before <= 0x7a) || before === 0x5f) continue;
    const slice = exe.subarray(Math.max(0, at - 160), at + 420).toString("latin1");
    const strings = [...slice.matchAll(/[ -~]{1,200}/g)].map((m) => m[0]).filter((s) => s.length >= 1);
    console.log(`  @${at}: ${strings.join(" | ")}`);
    if (++shown >= 2) break;
  }
  if (shown === 0) console.log("  (not found)");
}
