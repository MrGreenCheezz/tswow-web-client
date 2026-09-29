import {
  onPerformanceCaptureChanged, performanceCaptureActive, performanceCaptureFinishing, performanceCaptureReady,
  performanceCaptureReport, startPerformanceCapture, stopPerformanceCapture,
} from "../game/PerformanceCapture.js";
import { element } from "./Dom.js";

/** Hands the finished report to the browser's download, named by its time. */
function saveReport(): void {
  const report = performanceCaptureReport();
  if (!report) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(report)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `webclient-performance-${new Date().toISOString().replaceAll(":", "-").slice(0, 19)}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/** One recording at a time, kept locally until the user downloads or replaces it. */
export function wirePerformanceCapture(): void {
  const toggle = element<HTMLButtonElement>("performance-capture-toggle");
  const save = element<HTMLButtonElement>("performance-capture-save");
  const status = element<HTMLParagraphElement>("performance-capture-status");
  /** Set by the console command: the file is saved by itself as soon as the report is ready. */
  let saveWhenReady = false;
  const update = () => {
    if (saveWhenReady && performanceCaptureReady()) {
      saveWhenReady = false;
      saveReport();
    }
    const active = performanceCaptureActive();
    toggle.textContent = active ? "Остановить запись" : "Записать фризы (60 с)";
    toggle.setAttribute("aria-pressed", String(active));
    save.disabled = !performanceCaptureReady();
    status.textContent = active
      ? "Идёт запись. Закройте это окно клавишей O и пройдите проблемный маршрут дважды. Запись остановится через 60 секунд."
      : performanceCaptureFinishing()
        ? "Запись остановлена, собираю профиль…"
        : performanceCaptureReady()
        ? "Запись готова. Скачайте отчёт и приложите его к сообщению."
        : "Запись поможет определить причину фризов. Отчёт сохраняется только в этом браузере до обновления страницы.";
  };
  onPerformanceCaptureChanged(update);
  toggle.addEventListener("click", () => {
    if (performanceCaptureActive()) stopPerformanceCapture();
    else if (!startPerformanceCapture()) status.textContent = "Начните запись после входа в мир, вне теста производительности.";
  });
  save.addEventListener("click", saveReport);
  // The same recording from the DevTools console, for an interface whose `O` belongs to something
  // else (the stock FrameXML HUD binds it to the social frame): it runs its 60 seconds, or until
  // called again, and saves its file by itself.
  (globalThis as unknown as { webclientRecordFreezes: () => string }).webclientRecordFreezes = () => {
    if (performanceCaptureActive()) {
      saveWhenReady = true;
      stopPerformanceCapture();
      return "Запись остановлена, файл сохранится, как только будет готов.";
    }
    if (!startPerformanceCapture()) return "Запись начинается только в мире: после входа, вне теста производительности.";
    saveWhenReady = true;
    return "Идёт запись фризов (60 с). Закройте консоль и играйте; файл сохранится сам.";
  };
  update();
}
