/**
 * Running a macro: its lines, in order, through the one macro runner (macro/MacroRunner.ts). With the
 * stock chat installed and able to evaluate conditions the lines go through stock `ChatEdit_ParseText`
 * (FrameXmlChatApi.ts); otherwise through this client's chat. No page: the macro window is Macros.ts.
 */

import {
  installMacroLineExecutor, macroBodyLines, macroLineExecutor, runMacroLines, stopMacro,
} from "../macro/MacroRunner.js";
import { submitChat } from "./Chat.js";
import { nativeMacroContext } from "./CombatCommands.js";
import { evaluateMacroOptions, installMacroOptionErrorSink, macroOptions, macroProblems } from "./MacroModel.js";
import { macroAt } from "./MacroStore.js";
import { runNativeTargetCommand } from "./NativeTargetCommands.js"; // 1.10 (12.10)
import { notice } from "./Notices.js";

/** `/stopmacro [options]` (ChatFrame.lua:1398-1402); the ruRU client spells it only this way. */
const STOP_MACRO = /^\/stopmacro(?:\s+([\s\S]*))?$/i;

/**
 * One macro line through this client's own chat. `/stopmacro` is the runner's: its options are
 * evaluated here, as stock `SecureCmdList.STOPMACRO` does. `/cast` and `/use` evaluate their own
 * (CombatCommands.ts); any other line is what the player could have typed.
 */
function runNativeMacroLine(line: string): void {
  const stop = STOP_MACRO.exec(line);
  if (!stop) {
    // 1.10 (12.10): /targetenemy and the rest of the stock secure targeting commands (NativeTargetCommands.ts).
    if (runNativeTargetCommand(line)) return;
    submitChat(line);
    return;
  }
  const options = macroOptions((stop[1] ?? "").trim());
  if (options.error !== undefined) notice(`/stopmacro: ${options.error}.`);
  else if (evaluateMacroOptions(options, nativeMacroContext())) stopMacro();
}

// This client's chat is the floor: a stock chat that can evaluate conditions installs its own over it,
// and its UI error line over this notice for an unknown condition word (ERR_UNKNOWN_MACRO_OPTION_S).
installMacroLineExecutor(runNativeMacroLine);
installMacroOptionErrorSink((word) => notice(`Неизвестный параметр макроса: ${word}`));

/**
 * Runs one macro: its lines, in order, through the macro runner, until the end or `/stopmacro`.
 * `button` is the mouse button that started it, which `[btn:N]` reads; without one — a key, a chat
 * line — the client reads `LeftButton` (0x5ef0d0).
 *
 * `#showtooltip`/`#show` and `-` lines are skipped; a line without `/` is said. Conditions are
 * evaluated as each line runs; `macroProblems` refuses only what cannot be read.
 */
export function runMacro(index: number, button?: string): void {
  const macro = macroAt(index);
  if (!macro) {
    notice(`Макрос ${index} пуст`);
    return;
  }
  const problems = macroProblems(macro.name, macro.body);
  if (problems.length > 0) {
    notice(problems.join(" "));
    return;
  }
  const lines = macroBodyLines(macro.body);
  if (lines.length === 0) {
    notice(`Макрос «${macro.name}» ничего не содержит`);
    return;
  }
  runMacroLines(lines, macroLineExecutor() ?? runNativeMacroLine, button);
}
