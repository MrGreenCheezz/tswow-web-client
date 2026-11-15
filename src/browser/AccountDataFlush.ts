/**
 * widgets9 (15.11, plan item 5.37): Lua `UploadSettings()` and `DownloadSettings()` as Wow.exe 3.3.5a (12340) runs
 * them (read-only Ghidra, .runtime/re-2026-11-15/cvar7/upload.c, upload2.c, widgets9/d1.c, d8.c; behaviour
 * described, no code copied).
 *
 * - Both start with 0x006b9b90: every account-data entry with a pending save timer has the timer cancelled and is
 *   saved now (0x006b9340 "SaveTimerHandler": the entry's text is uploaded unless its hash equals the one the
 *   server holds, in which case it is only marked clean).
 * - `UploadSettings` (0x00511f90 → 0x006b9c60) then uploads (0x006b9100, CMSG_UPDATE_ACCOUNT_DATA) every entry
 *   still marked changed (+0x34) or whose local time differs from the server's (+0x38 ≠ +0x3c); an upload marks it
 *   clean (0x006b8f50).
 * - `DownloadSettings` (0x00511fa0 → 0x006b9ca0) then asks (0x006b92c0, CMSG_REQUEST_ACCOUNT_DATA) for every entry
 *   in that state that has no request in flight (+0x15).
 * - Neither answers anything to Lua.
 *
 * This client's stores send each change after a short delay and take the server's copy when they attach, so once
 * the pending writes are out nothing is left marked: both functions come down to sending the pending writes now.
 * Slot 6 is left out: Wow.exe's entry 6 (`layout-local.txt`) is sent by UploadSettings when the layout changed,
 * but this client keeps its own window layout and settings there (`input/InputAccount.ts`), which is not what
 * Wow.exe would find in it — its pending write goes out on its own timer.
 *
 * The stores register here (ui/Settings.ts, ui/MacroStore.ts, input/InputAccountWiring.ts); the module imports
 * nothing so the Lua binding can call it without pulling the stores in.
 */

type AccountDataFlush = () => void;

const flushes = new Set<AccountDataFlush>();

/** A store's "send the pending writes now, slot 6 aside"; returns the unregistration. */
export function registerAccountDataFlush(flush: AccountDataFlush): () => void {
  flushes.add(flush);
  return () => { flushes.delete(flush); };
}

/** `UploadSettings()` / `DownloadSettings()`: every registered store sends its pending writes, slot 6 aside. */
export function flushAccountDataForLua(): void {
  for (const flush of [...flushes]) {
    try {
      flush();
    } catch {
      // One store's failure must not keep the others' writes back.
    }
  }
}
