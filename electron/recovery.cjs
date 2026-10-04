"use strict";

/**
 * 1.29 — decisions the shell makes when something under it breaks, kept free of `electron` so
 * `node --test` can require them (tests/electron-shell.test.mjs). main.cjs only wires them.
 */

/**
 * The CPU policy script's stdout (`cpu-policy.ps1`): `{"applied":[pid,…]}`. PowerShell can print
 * a warning or nothing at all (execution policy, a profile), and a bare `JSON.parse` on that threw
 * inside an `execFile` callback — an uncaught exception in the main process. Never throws.
 */
function parsePolicyOutput(text) {
  try {
    const parsed = JSON.parse(String(text ?? ""));
    const applied = parsed && Array.isArray(parsed.applied)
      ? parsed.applied.filter((pid) => Number.isInteger(pid))
      : undefined;
    return applied === undefined ? { applied: [], ok: false } : { applied, ok: true };
  } catch {
    return { applied: [], ok: false };
  }
}

/** Electron's `render-process-gone` reasons that are not a failure. */
const NOT_A_CRASH = new Set(["clean-exit"]);

/**
 * What to do when the page's renderer is gone: reload after a short pause while it happens rarely,
 * stay on the message once it keeps happening (`maxReloads` within `windowMs`), so a page that
 * crashes on load does not spin the machine in a reload loop.
 */
function createRenderRecovery({ now = Date.now, maxReloads = 3, windowMs = 60_000, delayMs = 1500 } = {}) {
  const crashes = [];
  return {
    onGone(reason) {
      if (NOT_A_CRASH.has(reason)) return { action: "ignore" };
      const at = now();
      crashes.push(at);
      while (crashes.length > 0 && at - crashes[0] > windowMs) crashes.shift();
      if (crashes.length <= maxReloads) {
        return {
          action: "reload",
          delayMs,
          text: `Причина: ${reason}. Перезагрузка страницы…`,
        };
      }
      return {
        action: "stay",
        text: `Причина: ${reason}. Окно игры остановилось ${crashes.length} раз за ${Math.round(windowMs / 1000)} с. `
          + "Закройте окно и запустите игру заново; Ctrl+R — попробовать ещё раз.",
      };
    },
  };
}

module.exports = { createRenderRecovery, parsePolicyOutput };
