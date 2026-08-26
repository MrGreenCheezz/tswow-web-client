import type { PacketsView } from "./PacketsModel.js";

/**
 * The «Пакеты» tab's four boxes, filled from a {@link PacketsView}.
 *
 * The hosts are arguments rather than imports from `Dom.ts` on purpose: `Dom.ts` resolves 193
 * elements the moment it is loaded, so anything that imports it can only run inside the real page.
 * Handed its boxes, this runs against the small fake document the widget tests use, which is the
 * difference between the tab being tested and being hoped for — the same reason `usePanelHost`
 * exists in `Widgets.ts`.
 */
export interface PacketsTabHosts {
  readonly status: HTMLElement;
  /** One line per loaded schema file, and one per load problem. */
  readonly modules: HTMLElement;
  readonly list: HTMLElement;
  readonly warnings: HTMLElement;
}

function line(className: string, text: string): HTMLElement {
  const node = document.createElement("p");
  node.className = className;
  node.textContent = text;
  return node;
}

export function drawPacketsTab(hosts: PacketsTabHosts, view: PacketsView): void {
  hosts.status.className = view.statusKind === "muted" ? "muted" : view.statusKind;
  hosts.status.textContent = view.status;
  hosts.modules.replaceChildren(...view.modules.map((text) => line("muted", text)));
  hosts.list.replaceChildren(...view.rows.map((row) => {
    const node = document.createElement("div");
    node.className = `custom-packet custom-packet-${row.kind}`;
    node.dataset["opcode"] = String(row.opcode);
    // Three lines rather than one: the title is what a module author looks for, the counts are
    // what tells them whether anything arrived at all, and the body is the answer to "arrived as
    // what" — and the body is the one that is long enough to wrap.
    node.append(line("custom-packet-title", row.title), line("muted", row.counts), line("custom-packet-body", row.body));
    return node;
  }));
  hosts.warnings.replaceChildren(...view.warnings.map((text) => line("error", text)));
}
