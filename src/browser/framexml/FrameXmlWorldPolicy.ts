/**
 * Whether the production world route should mount the FrameXML HUD.
 *
 * The native DOM interface hosts TSWoW addon widgets on the ordinary route. Replacing the stock
 * HUD with FrameXML remains an explicit diagnostic choice (`framexml=1`).
 */
export function frameXmlFlagEnabled(search: string): boolean {
  return new URLSearchParams(search).get("framexml") === "1";
}
