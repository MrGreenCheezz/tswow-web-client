import type { FrameXmlSettingsCVarAdapter } from "./FrameXmlSettingsCVar.js";

/**
 * 3.11 (13.10): GetCVar, GetCVarDefault and SetCVar of the camera's own CVars reach the camera — the views
 * (cameraView, cameraViewBlendStyle, cameraDistance/Pitch/Yaw with "", A–E, "Com", "Barber Shop"), the follow's tunables
 * (game/CameraCVars.ts) and the character's cameraSavedDistance/cameraSavedPitch (game/CameraSaved.ts) — instead of the
 * neutral map, where SaveView's writes were never seen and a written view never reached the camera. As in Wow.exe
 * (validators 0x005fd630/0x005fd680/0x005fd6d0/0x005fd7b0/0x005fd750, no callbacks): a value out of a validator's range
 * is refused, and a written view reaches the camera at its next creation (0x005fe510). The settings-backed names
 * (cameraSmoothStyle, cameraYawSmoothSpeed…, FrameXmlSettingsCVar.ts) go on as before; GetCVarMin/Max are theirs.
 */

/** A camera store's CVar side: CameraViews and CameraSaved answer undefined for a name not theirs. */
export interface FrameXmlCameraCVarSource {
  cvar(name: string): string | undefined;
  cvarDefault(name: string): string | undefined;
  setCVar(name: string, value: unknown): boolean | undefined;
}

/** `settings` with the camera's names answered first by `sources`, in order. */
export function withCameraCVars(
  settings: FrameXmlSettingsCVarAdapter, sources: readonly FrameXmlCameraCVarSource[],
): FrameXmlSettingsCVarAdapter {
  return Object.freeze({
    get(name: string): string | undefined {
      for (const source of sources) {
        const value = source.cvar(name);
        if (value !== undefined) return value;
      }
      return settings.get(name);
    },
    getDefault(name: string): string | undefined {
      for (const source of sources) {
        const value = source.cvarDefault(name);
        if (value !== undefined) return value;
      }
      return settings.getDefault(name);
    },
    set(name: string, value: unknown): boolean {
      for (const source of sources) {
        const written = source.setCVar(name, value);
        // A camera name refused by its validator is still a supported name: the write simply did not take.
        if (written !== undefined) return true;
      }
      return settings.set(name, value);
    },
    range: settings.range,
  });
}
