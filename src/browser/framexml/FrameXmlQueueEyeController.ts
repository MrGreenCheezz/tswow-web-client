/**
 * 3.24 (12.10): whether the stock queue eye — MiniMapBattlefieldFrame, its tooltip and MiniMapBattlefieldDropDown
 * (BattlefieldFrame.lua:204-360, 586-774; Minimap.xml:165-273) — holds the queues, published by the world
 * mount once its gate passed (FrameXmlQueueEyeOwner.ts). While it does, the native «Приглашения и очередь»
 * panel (InteractionPrompts.ts) drops its battleground queue and match rows — stock's dropdown leaves a
 * queue, enters a battle and leaves a battleground — and, with the stock popups published too, its
 * Wintergrasp rows, which stock's BFMGR_* StaticPopups and dropdown rows answer.
 */

let owner: object | undefined;

/** Publish the gated eye and return an identity-safe cleanup. */
export function publishFrameXmlQueueEye(): () => void {
  const token = {};
  owner = token;
  return (): void => {
    if (owner === token) owner = undefined;
  };
}

export function frameXmlQueueEyePublished(): boolean {
  return owner !== undefined;
}
