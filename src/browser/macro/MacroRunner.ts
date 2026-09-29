/**
 * Running a macro: its lines in order, one executor call each, until the end or `StopMacro`.
 *
 * One runner for both interfaces. The stock one runs a line the way the original client does — the
 * `EXECUTE_CHAT_LINE` event to stock `MacroEditBox`, which hands it to `ChatEdit_ParseText`
 * (ChatFrame.lua:2461-2482) — and the stock chat install puts that executor here
 * (FrameXmlChatApi.ts). The native interface's own executor (ui/Macros.ts) is the floor beneath it.
 * The last executor installed is the one lines go to.
 *
 * Every line runs except those the client skips (Wow.exe 0x564db0): blank ones, the `#` directives
 * (`#showtooltip`, `#show`) and comments starting with `-`. A line without `/` is said in SAY, as
 * the original client says it: the stock route sends it itself (FrameXmlChatApi.ts), the native one
 * through this client's chat input.
 *
 * `RunMacro(macro, button)` and `RunMacroText(text, button)` (SecureTemplates.lua:366-381) carry the
 * mouse button that clicked the secure button; while the macro runs, `[btn:N]` reads it
 * ({@link macroRunButton}). A macro can start another (a `/click` of a macro button): the inner one
 * runs inside the outer with its own button, `/stopmacro` ends the innermost running macro only
 * [hyp.: not checked on the 12340 client], and nesting deeper than {@link MACRO_RUN_DEPTH} is
 * refused, so a macro that clicks its own button ends instead of recursing.
 *
 * `/click` needs a frame by name, and only the stock interface has frames: the stock chat install
 * also puts a resolver here ({@link installMacroClickFrames}), which `GetClickFrame` asks.
 */

export type MacroLineExecutor = (line: string) => void;

/** A frame `/click` may click; the resolver answers what the bridge holds under that name. */
export type MacroClickFrameResolver = (name: string) => object | undefined;

/** How deep one macro may start another. */
export const MACRO_RUN_DEPTH = 8;

interface MacroRun {
  readonly button: string | undefined;
  stopped: boolean;
}

const runs: MacroRun[] = [];
const executors: MacroLineExecutor[] = [];
const clickFrames: MacroClickFrameResolver[] = [];

/** The lines of a body that run: trimmed, without blank lines, `#` directives and `-` comments. */
export function macroBodyLines(body: string): string[] {
  const lines: string[] = [];
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line.length > 0 && !line.startsWith("#") && !line.startsWith("-")) lines.push(line);
  }
  return lines;
}

/**
 * Run `lines` in order through `execute`, started with `button` (undefined from a key or a chat
 * line). Stops after a line during which `StopMacro` was called. A line that throws is reported on
 * the console and the macro goes on, as the client's error handler lets it. Answers how many ran.
 */
export function runMacroLines(lines: readonly string[], execute: MacroLineExecutor, button?: string): number {
  if (runs.length >= MACRO_RUN_DEPTH) return 0;
  const run: MacroRun = { button, stopped: false };
  runs.push(run);
  let count = 0;
  try {
    for (const line of lines) {
      count += 1;
      try {
        execute(line);
      } catch (error) {
        console.error(`[macro] «${line}» failed`, error);
      }
      if (run.stopped) break;
    }
  } finally {
    runs.pop();
  }
  return count;
}

/** `StopMacro()`: the running macro ends after its current line; outside a macro, nothing. */
export function stopMacro(): void {
  const run = runs[runs.length - 1];
  if (run) run.stopped = true;
}

/** The mouse button the innermost running macro was started with. */
export function macroRunButton(): string | undefined {
  return runs[runs.length - 1]?.button;
}

/** Put an executor over the current one until the returned function takes it off. */
export function installMacroLineExecutor(executor: MacroLineExecutor): () => void {
  executors.push(executor);
  return () => {
    const index = executors.lastIndexOf(executor);
    if (index >= 0) executors.splice(index, 1);
  };
}

/** Where a macro's lines go now; undefined when nothing has installed one. */
export function macroLineExecutor(): MacroLineExecutor | undefined {
  return executors[executors.length - 1];
}

/** Publish the frames `/click` may reach, until the returned function withdraws them. */
export function installMacroClickFrames(resolver: MacroClickFrameResolver): () => void {
  clickFrames.push(resolver);
  return () => {
    const index = clickFrames.lastIndexOf(resolver);
    if (index >= 0) clickFrames.splice(index, 1);
  };
}

/** The frame named `name` in the published interface, if any. */
export function macroClickFrame(name: string): object | undefined {
  return clickFrames[clickFrames.length - 1]?.(name);
}
