/**
 * The ownership seam between the stock StaticPopup dialogs / ReadyCheckFrame and the native
 * confirmation panels.
 *
 * The world mount publishes an owner only after the stock dialogs passed their gate. While one is
 * published, every native surface that used to ask one of these questions steps aside at its own
 * show function — the group, guild and arena invites, the duel, the death window with its release,
 * reclaim, resurrect and spirit-healer answers, the trade request, the summon, the battleground
 * entry, the ready check and the logout countdown — because two prompts for one server question
 * would let the player answer it twice. Every function here answers false while nothing is
 * published, so the natives stay the fallback.
 */

export interface FrameXmlPopupsOwner {
  /** Whether a dialog Escape may dismiss is up (`hideOnEscape`). */
  isOpen(): boolean;
  /** Stock `StaticPopup_EscapePressed`: each escapable dialog runs its own cancel. */
  close(): void;
  /**
   * Whether BattlefieldFrame — the only stock frame that shows CONFIRM_BATTLEFIELD_ENTRY (its
   * UPDATE_BATTLEFIELD_STATUS handler, BattlefieldFrame.lua:21/289) — is listening now. Without it
   * the native «Войти в бой» row keeps the invitation even while the other dialogs are stock's.
   */
  battlefieldEntry?(): boolean;
  /** The native «Разрушить»: the item onto the stock cursor, then DELETE_ITEM/DELETE_GOOD_ITEM asks. */
  destroyItem?(bag: number, slot: number): boolean;
  /** An item on the stock cursor dropped outside every frame: DELETE_ITEM_CONFIRM, as the client. */
  dropCursorItem?(): boolean;
}

let owner: FrameXmlPopupsOwner | undefined;
/** Whether Blizzard_TalentUI is loaded in the published owner's VM (CONFIRM_TALENT_WIPE's precondition). */
let talentUiLoaded: (() => boolean) | undefined;

/**
 * Publish the one gated stock popup owner and return an identity-safe cleanup. The cleanup only
 * unpublishes: dismissing a dialog runs its OnCancel/OnHide (DeclineGroup, CancelLogout …), and a
 * teardown must hand the pending questions back to the native panels, not answer them.
 *
 * `talentUi` answers whether Blizzard_TalentUI is loaded in that VM: UIParent's CONFIRM_TALENT_WIPE
 * branch calls TalentFrame_LoadUI, which raises the add-on load error while it is not.
 */
export function publishFrameXmlPopups(next: FrameXmlPopupsOwner, talentUi?: () => boolean): () => void {
  owner = next;
  talentUiLoaded = talentUi;
  let cleaned = false;
  return (): void => {
    if (cleaned) return;
    cleaned = true;
    if (owner !== next) return;
    owner = undefined;
    talentUiLoaded = undefined;
  };
}

/** Whether the stock dialogs own the server's confirmations; the native prompts step aside then. */
export function frameXmlPopupsPublished(): boolean {
  return owner !== undefined;
}

/** Blizzard_TalentUI loaded in the published VM; undefined while nothing is published or no host answers. */
export function frameXmlPopupsTalentUiLoaded(): boolean | undefined {
  const loaded = owner ? talentUiLoaded : undefined;
  if (!loaded) return undefined;
  try { return loaded(); } catch { return undefined; }
}

/**
 * Server questions the stock dialogs cannot ask honestly — CONFIRM_TALENT_WIPE while Blizzard_TalentUI
 * could not be loaded for UIParent's TalentFrame_LoadUI, INSTANCE_LOCK while the DungeonEncounter table
 * is unknown (its «Убито боссов: %d/%d» would be invented) — which the native prompts therefore keep
 * even while the stock owner is published. Keyed by the world's request object: a /reload or a remount
 * does not move a question between owners, and a new packet is a new question.
 */
const leftToNative = new WeakSet<object>();

export function markFrameXmlPopupLeftToNative(request: object): void {
  leftToNative.add(request);
}

/** Whether the stock model left this question to the native prompt (InteractionPrompts.ts). */
export function frameXmlPopupsLeftToNative(request: object | undefined): boolean {
  return request !== undefined && leftToNative.has(request);
}

export function frameXmlPopupsOpen(): boolean {
  const current = owner;
  if (!current) return false;
  try { return current.isOpen(); } catch { return false; }
}

/** Escape: stock dismissal of the escapable dialogs. False when unpublished. */
export function closeFrameXmlPopups(): boolean {
  const current = owner;
  if (!current) return false;
  try { current.close(); } catch { /* teardown owns the final cleanup */ }
  return true;
}

/** Whether stock CONFIRM_BATTLEFIELD_ENTRY asks to enter a battleground; the native row steps aside then. */
export function frameXmlPopupsOwnBattlefieldEntry(): boolean {
  const current = owner;
  if (!current?.battlefieldEntry) return false;
  try { return current.battlefieldEntry(); } catch { return false; }
}

/**
 * The native item menu's «Разрушить» asks here first: true when stock took it (the item is on the
 * stock cursor and DELETE_ITEM/DELETE_GOOD_ITEM is up), false to keep the native confirmation.
 */
export function frameXmlPopupsDestroyItem(bag: number, slot: number): boolean {
  const current = owner;
  if (!current?.destroyItem) return false;
  try { return current.destroyItem(bag, slot); } catch { return false; }
}

/**
 * A click on the world while the stock bag cursor holds an item: true when stock asked
 * DELETE_ITEM_CONFIRM (the caller then skips its own handling), false otherwise.
 */
export function frameXmlPopupsDropCursorItem(): boolean {
  const current = owner;
  if (!current?.dropCursorItem) return false;
  try { return current.dropCursorItem(); } catch { return false; }
}

/**
 * The Quit intent GameMenu.ts keeps (`Quit()` leaves for the login screen once the server completes
 * the logout), registered here so the popup model reaches it without importing the native UI into
 * the world seam: PLAYER_QUITING instead of PLAYER_CAMPING, and QUIT's ForceQuit.
 */
export interface FrameXmlQuitIntent {
  /** The logout the server is counting was asked for by Quit(). */
  quitting(): boolean;
  /** «Выйти сейчас»: leave for the login screen now. */
  forceQuit(): void;
}

let quitIntent: FrameXmlQuitIntent | undefined;

export function registerFrameXmlQuitIntent(intent: FrameXmlQuitIntent): void {
  quitIntent = intent;
}

export function frameXmlQuitIntent(): FrameXmlQuitIntent | undefined {
  return quitIntent;
}
