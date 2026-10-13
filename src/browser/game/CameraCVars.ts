/**
 * 3.11: the camera CVars Wow.exe 3.3.5a (12340) keeps in the account's config cache (flag 0x10, registered by
 * 0x005fd910; read-only notes .runtime/re-2026-10-11/glue-1110/cam2.txt, cv311-a…f.txt) that this client keeps
 * per account beside the views (CameraViews.ts): the names, the default strings and the validators' ranges.
 *
 * - The views: "camera" + Distance|Pitch|Yaw + "", A–E, "Com", "Barber Shop" (0xad1b54, 0xad1b74), defaults the
 *   strings at 0xad1ba8 ("5.55", "10.0", "0.0"…), validators 0x005fd680 (0–50 yards), 0x005fd6d0 (±1.5533 rad in
 *   degrees, ±89°), 0x005fd7b0 (0–360). `cameraView` (default "2", 0x005fd630: 0–7) and `cameraViewBlendStyle`
 *   ("1", no validator).
 * - The follow (CameraFollow.ts, 0x00602760): `cameraSmoothPitch` and `cameraSmoothYaw` ("1"), `cameraCustomViewSmoothing`
 *   ("0"), `cameraPitchSmoothMin`/`Max` ("0.0"/"30.0", 0x005fd6d0), `cameraYawSmoothMin`/`Max` ("0.0"/"0.0",
 *   0x005fd7b0), `cameraSmoothTimeMin`/`Max` ("0.1"/"2.0", 0x005fd750: 0.001–300), and the two tables without a
 *   validator: `cameraSmooth` + style + state + Delay|Factor (5 × 7 × 2, defaults 0x00ad1c30) and
 *   `cameraSmoothViewData` + style + Distance|Pitch|Yaw + Delay|Factor (5 × 3 × 2, 0x00ad1d48). The styles are
 *   Never, Smart, Always, Spline, Smarter (0x00ad1b94 — the values of `cameraSmoothStyle`, 0–4), the states Idle,
 *   Stop, Track, Move, Strafe, Turn, Fear (0x00ad1c10), the pair Delay, Factor (0x00ad1c08); the strings were read
 *   from the image's bytes.
 *
 * `cameraSmoothStyle` itself is the settings model's (FrameXmlSettingsCVar.ts), as before. A CVar's number is
 * atof of its string, as the client keeps it (+0x2c).
 */

export const CAMERA_SMOOTH_STYLES = Object.freeze(["Never", "Smart", "Always", "Spline", "Smarter"] as const);
export const CAMERA_FOLLOW_STATES = Object.freeze(["Idle", "Stop", "Track", "Move", "Strafe", "Turn", "Fear"] as const);
export const CAMERA_VIEW_AXES = Object.freeze(["Distance", "Pitch", "Yaw"] as const);
/** The view suffixes (0xad1b54): view 0 has none. */
export const CAMERA_VIEW_SUFFIXES = Object.freeze(["", "A", "B", "C", "D", "E", "Com", "Barber Shop"] as const);

/** The views' default strings (0xad1ba8): yards, then pitch and yaw in degrees. */
const VIEW_DEFAULTS: readonly (readonly [string, string, string])[] = [
  ["0.0", "0.0", "0.0"], ["0.0", "0.0", "0.0"], ["5.55", "10.0", "0.0"], ["5.55", "20.0", "0.0"],
  ["13.88", "30.0", "0.0"], ["13.88", "10.0", "0.0"], ["0.0", "0.0", "0.0"], ["5.0", "10.0", "0.0"],
];

/** `cameraSmooth<style><state>` Delay and Factor (0x00ad1c30), style by style. */
const STATE_DEFAULTS: readonly (readonly (readonly [string, string])[])[] = [
  [["0.0", "0.0"], ["0.0", "0.0"], ["0.0", "0.0"], ["0.0", "0.0"], ["0.0", "0.0"], ["0.0", "0.0"], ["0.0", "0.0"]],
  [["0.0", "0.0"], ["0.0", "0.0"], ["0.4", "10.0"], ["0.0", "1.0"], ["0.0", "1.0"], ["0.0", "1.0"], ["0.4", "10.0"]],
  [["0.0", "1.0"], ["0.0", "1.0"], ["0.0", "1.0"], ["0.0", "1.0"], ["0.0", "1.0"], ["0.0", "1.0"], ["0.0", "1.0"]],
  [["0.0", "4.0"], ["0.0", "4.0"], ["0.0", "4.0"], ["0.0", "1.0"], ["0.0", "1.0"], ["0.0", "1.0"], ["0.0", "4.0"]],
  [["0.0", "0.0"], ["0.0", "0.0"], ["0.4", "10.0"], ["0.0", "1.0"], ["0.0", "1.0"], ["0.0", "1.0"], ["0.4", "10.0"]],
];

/** `cameraSmoothViewData<style><axis>` Delay and Factor (0x00ad1d48). */
const VIEW_DATA_DEFAULTS: readonly (readonly (readonly [string, string])[])[] = [
  [["0.0", "0.0"], ["0.0", "0.0"], ["0.0", "0.0"]],
  [["0.0", "0.0"], ["0.0", "0.0"], ["0.0", "1.0"]],
  [["0.0", "0.0"], ["0.0", "1.0"], ["0.0", "1.0"]],
  [["0.0", "0.0"], ["0.0", "1.0"], ["0.0", "1.0"]],
  [["0.0", "0.0"], ["0.0", "1.0"], ["0.0", "1.0"]],
];

/** The validators' ranges: 0x005fd680, 0x005fd6d0 (1.5533430576324463 rad × 57.295780181884766), 0x005fd7b0, 0x005fd750. */
export const CAMERA_CVAR_DISTANCE_MAX = 50;
export const CAMERA_CVAR_PITCH_MAX = 1.5533430576324463 * 57.295780181884766;
export const CAMERA_CVAR_YAW_MAX = 360;
const TIME_RANGE: readonly [number, number] = [0.001, 300];

export interface CameraCVarDefinition {
  /** The registered spelling. */
  readonly name: string;
  readonly defaultValue: string;
  /** The validator's inclusive range; none for a CVar registered without one. */
  readonly range?: readonly [low: number, high: number];
}

/** A view CVar's name: `cameraViewCVar("Distance", 1)` is `cameraDistanceA`. */
export function cameraViewCVar(axis: "Distance" | "Pitch" | "Yaw", view: number): string {
  return `camera${axis}${CAMERA_VIEW_SUFFIXES[view] ?? ""}`;
}

/** `cameraSmooth<style><state><Delay|Factor>`, style 0–4, state 0–6. */
export function cameraSmoothCVar(style: number, state: number, factor: boolean): string {
  return `cameraSmooth${CAMERA_SMOOTH_STYLES[style] ?? ""}${CAMERA_FOLLOW_STATES[state] ?? ""}${factor ? "Factor" : "Delay"}`;
}

/** `cameraSmoothViewData<style><axis><Delay|Factor>`, axis 0 distance, 1 pitch, 2 yaw. */
export function cameraSmoothViewDataCVar(style: number, axis: number, factor: boolean): string {
  return `cameraSmoothViewData${CAMERA_SMOOTH_STYLES[style] ?? ""}${CAMERA_VIEW_AXES[axis] ?? ""}${factor ? "Factor" : "Delay"}`;
}

function build(): readonly CameraCVarDefinition[] {
  const rows: CameraCVarDefinition[] = [];
  for (let view = 0; view < VIEW_DEFAULTS.length; view += 1) {
    const [distance, pitch, yaw] = VIEW_DEFAULTS[view]!;
    rows.push({ name: cameraViewCVar("Distance", view), defaultValue: distance, range: [0, CAMERA_CVAR_DISTANCE_MAX] });
    rows.push({ name: cameraViewCVar("Pitch", view), defaultValue: pitch, range: [-CAMERA_CVAR_PITCH_MAX, CAMERA_CVAR_PITCH_MAX] });
    rows.push({ name: cameraViewCVar("Yaw", view), defaultValue: yaw, range: [0, CAMERA_CVAR_YAW_MAX] });
  }
  rows.push({ name: "cameraView", defaultValue: "2", range: [0, 7] });
  rows.push({ name: "cameraViewBlendStyle", defaultValue: "1" });
  rows.push({ name: "cameraSmoothPitch", defaultValue: "1" });
  rows.push({ name: "cameraSmoothYaw", defaultValue: "1" });
  rows.push({ name: "cameraCustomViewSmoothing", defaultValue: "0" });
  rows.push({ name: "cameraPitchSmoothMin", defaultValue: "0.0", range: [-CAMERA_CVAR_PITCH_MAX, CAMERA_CVAR_PITCH_MAX] });
  rows.push({ name: "cameraPitchSmoothMax", defaultValue: "30.0", range: [-CAMERA_CVAR_PITCH_MAX, CAMERA_CVAR_PITCH_MAX] });
  rows.push({ name: "cameraYawSmoothMin", defaultValue: "0.0", range: [0, CAMERA_CVAR_YAW_MAX] });
  rows.push({ name: "cameraYawSmoothMax", defaultValue: "0.0", range: [0, CAMERA_CVAR_YAW_MAX] });
  rows.push({ name: "cameraSmoothTimeMin", defaultValue: "0.1", range: TIME_RANGE });
  rows.push({ name: "cameraSmoothTimeMax", defaultValue: "2.0", range: TIME_RANGE });
  for (let style = 0; style < CAMERA_SMOOTH_STYLES.length; style += 1) {
    for (let state = 0; state < CAMERA_FOLLOW_STATES.length; state += 1) {
      const [delay, factor] = STATE_DEFAULTS[style]![state]!;
      rows.push({ name: cameraSmoothCVar(style, state, false), defaultValue: delay });
      rows.push({ name: cameraSmoothCVar(style, state, true), defaultValue: factor });
    }
    for (let axis = 0; axis < CAMERA_VIEW_AXES.length; axis += 1) {
      const [delay, factor] = VIEW_DATA_DEFAULTS[style]![axis]!;
      rows.push({ name: cameraSmoothViewDataCVar(style, axis, false), defaultValue: delay });
      rows.push({ name: cameraSmoothViewDataCVar(style, axis, true), defaultValue: factor });
    }
  }
  return Object.freeze(rows.map((row) => Object.freeze(row)));
}

/** Every camera CVar kept here, in registration order. */
export const CAMERA_ACCOUNT_CVARS: readonly CameraCVarDefinition[] = build();

const BY_NAME = new Map(CAMERA_ACCOUNT_CVARS.map((row) => [row.name.toLowerCase(), row]));

/** A camera CVar by any spelling (CVar names are case-blind), or undefined. */
export function cameraCVarDefinition(name: string): CameraCVarDefinition | undefined {
  return typeof name === "string" ? BY_NAME.get(name.toLowerCase()) : undefined;
}

/** atof: the leading number of a CVar string, 0 for none (the client's +0x2c float). */
export function cameraCVarFloat(text: string | undefined): number {
  if (text === undefined) return 0;
  const value = Number.parseFloat(text);
  return Number.isFinite(value) ? value : 0;
}

/** A value inside a validator's range: the client refuses ("Value out of range") anything else. */
export function cameraCVarAccepts(definition: CameraCVarDefinition, text: string): boolean {
  const range = definition.range;
  if (!range) return true;
  const value = cameraCVarFloat(text);
  return value >= range[0] && value <= range[1];
}
