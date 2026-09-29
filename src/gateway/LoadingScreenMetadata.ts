import { openDbcFile } from "./Dbc.js";

/** The art one map's world-entry curtain shows, as `LoadingScreens.dbc` names it. */
export interface LoadingScreenArt {
  /** The 4:3 picture, an archive path (`Interface\Glues\LoadingScreens\LoadScreenKalimdor.blp`). */
  readonly file: string;
  /**
   * The widescreen twin, when the row's `HasWideScreen` says one ships: the same path with `Wide`
   * before the extension. Measured on this client: `LoadScreenKalimdorWide.blp` exists, and the
   * rows with the flag clear (every instance, `LoadScreenDeadmines` for one) have no twin at all.
   */
  readonly wide?: string;
}

/**
 * The `Wide` twin of a loading-screen path, the spelling the 3.3.5a client derives it with.
 *
 * Case is kept from the row (`LOADSCREENULDUARRAID.BLP` stays upper case); the archives are
 * case-insensitive, and the gateway's texture route lower-cases the path for its cache key anyway.
 */
export function wideLoadingScreenPath(file: string): string {
  const dot = file.lastIndexOf(".");
  return dot > file.lastIndexOf("\\") ? `${file.slice(0, dot)}Wide${file.slice(dot)}` : `${file}Wide`;
}

/**
 * Every map's curtain art, by `Map.dbc` id.
 *
 * `Map.LoadingScreenID` names a `LoadingScreens` row; 35 of the 135 maps in this dataset name none
 * (test maps, transports) and are left out, so the browser falls back to its plain curtain there
 * rather than inventing a picture. A TSWoW module that adds a map or a screen is picked up by the
 * next dataset build, the way every other `/dbc/` answer is.
 */
export async function loadLoadingScreens(dbcDirectory: string): Promise<Record<number, LoadingScreenArt>> {
  const [maps, screens] = await Promise.all([
    openDbcFile(dbcDirectory, "Map"),
    openDbcFile(dbcDirectory, "LoadingScreens"),
  ]);
  const art: Record<number, LoadingScreenArt> = {};
  for (const row of maps.rows()) {
    const screen = screens.rowOf(maps.int(row, "LoadingScreenID"));
    if (screen === undefined) continue;
    const file = screens.string(screen, "FileName").trim().replaceAll("/", "\\");
    if (!file) continue;
    art[maps.id(row)] = screens.int(screen, "HasWideScreen") !== 0
      ? { file, wide: wideLoadingScreenPath(file) }
      : { file };
  }
  return art;
}
