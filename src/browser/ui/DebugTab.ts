import { game } from "../game/Context.js";
import {
  DEBUG_WEATHER_CHOICES, debugTime, debugWeather, lastDebugLight, parseDebugHour,
} from "../game/DebugOverrides.js";
import { formatGameTime } from "../../world/GameTimeProtocol.js";
import { weatherKind } from "../../world/WorldMessageProtocol.js";
import { renderSwitches, resetRenderSwitches, setRenderSwitches, type RenderSwitches } from "../RenderSwitches.js";
import { terrainGrid } from "../Terrain.js";
import { currentAreaId } from "./Minimap.js";
import { diagnosticsDebug, diagnosticsWindow } from "./Dom.js";
import type { ResolvedColour } from "../LightTypes.js";

/**
 * The diagnostics window's «Отладка» pane: the time of day and the weather forced on the picture,
 * what light the frame was resolved to, where the character stands, and the render switches.
 *
 * Everything here is local to the page (game/DebugOverrides.ts): the server is never told, and
 * «Как на сервере» gives the frame back to it. The same controls are in the console as
 * `webclientDebug`, for a harness or for a key a person would rather type.
 */

/** Game minutes per real second for each pace offered, with what a day takes at it. */
const SPEEDS: ReadonlyArray<{ speed: number; label: string }> = [
  { speed: 0, label: "Стоп" },
  { speed: 1, label: "Сутки за 24 мин" },
  { speed: 10, label: "за 2,4 мин" },
  { speed: 60, label: "за 24 с" },
];

/** The hours worth one press: where `Light.dbc` bands usually turn. */
const PRESETS: ReadonlyArray<{ hour: number; label: string }> = [
  { hour: 0, label: "Полночь" },
  { hour: 5.5, label: "Рассвет" },
  { hour: 9, label: "Утро" },
  { hour: 12, label: "Полдень" },
  { hour: 18, label: "Вечер" },
  { hour: 21, label: "Закат" },
];

const SWITCH_LABELS: Record<keyof RenderSwitches, string> = {
  m2AlphaDepthWrite: "M2: запись глубины у прозрачных батчей",
  particleTwinkle: "Частицы: мерцание (twinkle)",
  m2Lights: "M2: собственные источники света (M2Light)",
  wmoRoomFogOnScene: "WMO: туман комнаты на всю сцену",
  terrainSpecular: "Земля: блик по _s-маскам",
};

function paragraph(className = ""): HTMLParagraphElement {
  const element = document.createElement("p");
  if (className) element.className = className;
  return element;
}

function heading(text: string): HTMLHeadingElement {
  const element = document.createElement("h4");
  element.className = "debug-heading";
  element.textContent = text;
  return element;
}

function button(label: string, run: () => void): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = label;
  element.addEventListener("click", run);
  return element;
}

function row(...children: HTMLElement[]): HTMLParagraphElement {
  const element = paragraph("debug-row");
  element.append(...children);
  return element;
}

function hex(colour: ResolvedColour): string {
  const channel = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 255).toString(16).padStart(2, "0");
  return `#${channel(colour.r)}${channel(colour.g)}${channel(colour.b)}`;
}

/** How long a game day takes at `speed` game minutes per real second, in words. */
function dayLength(speed: number): string {
  const seconds = 1440 / speed;
  return seconds < 120 ? `${Math.round(seconds)} с` : `${(seconds / 60).toFixed(1).replace(".0", "").replace(".", ",")} мин`;
}

function minuteText(minute: number): string {
  return formatGameTime({ minuteOfDay: minute, minutesPerSecond: 0, weekday: 0 });
}

/* --- time ------------------------------------------------------------------------------------- */

const timeLine = paragraph("muted");
const timeSlider = document.createElement("input");
timeSlider.type = "range";
timeSlider.min = "0";
timeSlider.max = "1439";
timeSlider.step = "5";
timeSlider.className = "debug-slider";
timeSlider.setAttribute("aria-label", "Время суток");
timeSlider.addEventListener("input", () => {
  debugTime.setMinute(Number(timeSlider.value), performance.now());
  drawDebugTab();
});

const speedButtons = SPEEDS.map(({ speed, label }) => {
  const element = button(label, () => {
    debugTime.setSpeed(speed, performance.now(), game.world?.currentGameTime());
    drawDebugTab();
  });
  element.dataset.speed = String(speed);
  return element;
});

/* --- weather ---------------------------------------------------------------------------------- */

const weatherSelect = document.createElement("select");
weatherSelect.setAttribute("aria-label", "Погода");
// createElement, not `new Option`: the module runs at import, and the Node tests' fake documents have no Option.
const weatherOption = (label: string, value: string): HTMLOptionElement => {
  const option = document.createElement("option");
  option.textContent = label;
  option.value = value;
  return option;
};
weatherSelect.append(weatherOption("Как на сервере", ""));
for (const choice of DEBUG_WEATHER_CHOICES) weatherSelect.append(weatherOption(choice.label, String(choice.state)));
const intensitySlider = document.createElement("input");
intensitySlider.type = "range";
intensitySlider.min = "0";
intensitySlider.max = "1";
intensitySlider.step = "0.05";
intensitySlider.value = "0.7";
intensitySlider.className = "debug-slider";
intensitySlider.setAttribute("aria-label", "Сила погоды");
const weatherLine = paragraph("muted");

function applyWeatherControls(): void {
  if (weatherSelect.value === "") debugWeather.clear();
  else debugWeather.set(Number(weatherSelect.value), Number(intensitySlider.value));
  drawDebugTab();
}
weatherSelect.addEventListener("change", applyWeatherControls);
intensitySlider.addEventListener("input", applyWeatherControls);

/* --- light, position, switches ---------------------------------------------------------------- */

const lightLine = paragraph("muted");
const lightSwatches = paragraph("debug-swatches");
const positionLine = paragraph("muted");
const copyStatus = paragraph("muted");

function goCommand(): string | undefined {
  const world = game.world;
  const self = world?.state.selfGuid === undefined ? undefined : world.state.objects.get(world.state.selfGuid);
  const position = self?.position;
  if (!world || !position || world.mapId === undefined) return undefined;
  return `.go xyz ${position.x.toFixed(2)} ${position.y.toFixed(2)} ${position.z.toFixed(2)} ${world.mapId} ${position.orientation.toFixed(2)}`;
}

async function copyGoCommand(): Promise<void> {
  const command = goCommand();
  if (!command) {
    copyStatus.textContent = "Позиция ещё не получена.";
    return;
  }
  try {
    await navigator.clipboard.writeText(command);
    copyStatus.textContent = `Скопировано: ${command}`;
  } catch {
    // No clipboard (an insecure origin, a denied permission): a field, because the app shell
    // allows selecting text only in inputs (NativeAppShell.ts).
    const field = document.createElement("input");
    field.readOnly = true;
    field.value = command;
    field.className = "debug-slider";
    copyStatus.replaceChildren(field);
    field.select();
  }
}

const switchBoxes = (Object.keys(SWITCH_LABELS) as Array<keyof RenderSwitches>).map((key) => {
  const box = document.createElement("input");
  box.type = "checkbox";
  box.addEventListener("change", () => {
    setRenderSwitches({ [key]: box.checked });
    drawDebugTab();
  });
  const label = document.createElement("label");
  label.className = "debug-switch";
  // An element, not a string child: the module runs at import, and the Node tests' fake nodes take elements only.
  const text = document.createElement("span");
  text.textContent = ` ${SWITCH_LABELS[key]}`;
  label.append(box, text);
  return { key, box, label };
});

diagnosticsDebug.replaceChildren(
  heading("Время суток"),
  timeLine,
  row(timeSlider),
  row(...PRESETS.map(({ hour, label }) => button(label, () => {
    debugTime.setMinute(hour * 60, performance.now());
    drawDebugTab();
  }))),
  row(...speedButtons, button("Как на сервере", () => {
    debugTime.clear();
    drawDebugTab();
  })),
  heading("Погода"),
  row(weatherSelect, intensitySlider),
  weatherLine,
  heading("Свет кадра"),
  lightLine,
  lightSwatches,
  heading("Позиция"),
  positionLine,
  row(button("Копировать .go xyz", () => { void copyGoCommand(); })),
  copyStatus,
  heading("Переключатели рендера"),
  ...switchBoxes.map(({ label }) => row(label)),
  row(button("Сбросить переключатели", () => {
    resetRenderSwitches();
    drawDebugTab();
  })),
  debugNote(),
);

function debugNote(): HTMLParagraphElement {
  const note = paragraph("muted debug-note");
  note.textContent =
    "Переключатели M2 и земли читаются при сборке материала и загрузке тайла: уже загруженное "
    + "меняется после перезахода в зону. Время и погода меняются только в этом клиенте — сервер и FrameXML "
    + "(GetGameTime) живут по серверным часам. В консоли: webclientDebug.help().";
  return note;
}

/* --- drawing ---------------------------------------------------------------------------------- */

function swatch(name: string, colour: ResolvedColour): HTMLSpanElement {
  const element = document.createElement("span");
  element.className = "debug-swatch";
  const chip = document.createElement("i");
  chip.style.background = hex(colour);
  element.append(chip, `${name} ${hex(colour)}`);
  return element;
}

/** Redraws the pane; cheap enough for the loop's half-second tick, and only while it is on screen. */
export function drawDebugTab(): void {
  if (diagnosticsWindow.hidden || diagnosticsDebug.hidden) return;
  const now = performance.now();
  const world = game.world;
  const server = world?.currentGameTime(now);
  const forced = debugTime.minuteAt(now);
  const serverText = server ? formatGameTime(server) : "нет данных";
  if (forced === undefined) {
    timeLine.textContent = `Сервер: ${serverText} · отладка выключена`;
    if (server && document.activeElement !== timeSlider) timeSlider.value = String(Math.floor(server.minuteOfDay));
  } else {
    const pace = debugTime.speed ? `идёт, сутки за ${dayLength(debugTime.speed)}` : "стоит";
    timeLine.textContent = `Показано: ${minuteText(forced)} (отладка, ${pace}) · сервер: ${serverText}`;
    if (document.activeElement !== timeSlider) timeSlider.value = String(Math.floor(forced));
  }
  for (const element of speedButtons) {
    element.setAttribute("aria-pressed", String(debugTime.active && debugTime.speed === Number(element.dataset.speed)));
  }

  const serverWeather = world?.weather;
  const serverWeatherText = serverWeather
    ? `${weatherKind(serverWeather.state)} (${serverWeather.state}) ${serverWeather.intensity.toFixed(2)}`
    : "нет пакета";
  const storm = game.renderer?.weatherStorm ?? 0;
  weatherLine.textContent = debugWeather.active
    ? `Отладка: ${weatherKind(debugWeather.state ?? 0)} ${(debugWeather.intensity ?? 0).toFixed(2)} · сервер: ${serverWeatherText} · штормовое небо ${storm.toFixed(2)}`
    : `Сервер: ${serverWeatherText} · штормовое небо ${storm.toFixed(2)}`;
  if (debugWeather.active !== (weatherSelect.value !== "")) weatherSelect.value = debugWeather.active ? String(debugWeather.state) : "";

  const light = lastDebugLight();
  if (!light) {
    lightLine.textContent = "Свет: таблица Light.dbc для карты ещё не загружена.";
    lightSwatches.replaceChildren();
  } else {
    const sky = light.skyboxPath ? ` · небо ${light.skyboxPath}` : "";
    lightLine.textContent = `Туман ${light.fogStart.toFixed(0)}–${light.fogEnd.toFixed(0)} ярд · glow ${light.glow.toFixed(2)}`
      + `${light.liquidLight ? " · свет жидкости" : ""}${sky}`;
    lightSwatches.replaceChildren(
      swatch("diffuse", light.colours.diffuse),
      swatch("ambient", light.colours.ambient),
      swatch("fog", light.colours.fog),
      swatch("sky top", light.colours.skyTop),
      swatch("horizon", light.colours.skyHorizon),
    );
  }

  const self = world?.state.selfGuid === undefined ? undefined : world.state.objects.get(world.state.selfGuid);
  const position = self?.position;
  if (!world || !position) {
    positionLine.textContent = "Позиция персонажа ещё не получена.";
  } else {
    const grid = terrainGrid(position.x, position.y);
    // ADT files are named by the grid column first: `<map>_<from y>_<from x>.adt`.
    const tile = grid ? ` · ADT ${grid.y}_${grid.x}` : "";
    const areaId = currentAreaId();
    const areaName = areaId ? game.areas?.area(areaId)?.name : undefined;
    positionLine.textContent = `Карта ${world.mapId} · ${position.x.toFixed(2)}, ${position.y.toFixed(2)}, ${position.z.toFixed(2)}`
      + `${tile} · зона ${areaId}${areaName ? ` «${areaName}»` : ""}`;
  }

  for (const { key, box } of switchBoxes) box.checked = renderSwitches[key];
}

/* --- console ---------------------------------------------------------------------------------- */

function applyHour(value: number | string): string {
  const minute = parseDebugHour(value);
  if (minute === undefined) return `Не понял время: ${String(value)}. Пример: 13.5 или "13:30".`;
  debugTime.setMinute(minute, performance.now());
  drawDebugTab();
  return `Время: ${minuteText(minute)}`;
}

function weatherState(value: number | string): number | undefined {
  if (typeof value === "number") return value;
  const text = value.trim().toLowerCase();
  const byKind: Record<string, number> = { fine: 0, clear: 0, fog: 1, rain: 4, storm: 86, snow: 7, sand: 41 };
  if (text in byKind) return byKind[text];
  return DEBUG_WEATHER_CHOICES.find((choice) => choice.label.toLowerCase() === text)?.state;
}

const debugConsole = Object.freeze({
  /** `time(6)`, `time("21:30")`; no argument — what is showing. */
  time(value?: number | string): string {
    if (value === undefined) {
      const forced = debugTime.minuteAt(performance.now());
      const server = game.world?.currentGameTime();
      return forced === undefined
        ? `Сервер: ${server ? formatGameTime(server) : "нет данных"}`
        : `Отладка: ${minuteText(forced)}`;
    }
    return applyHour(value);
  },
  /** Game minutes per real second: 0 holds, 1 is a day in 24 minutes, 60 a day in 24 seconds. */
  timeSpeed(speed: number): string {
    debugTime.setSpeed(speed, performance.now(), game.world?.currentGameTime());
    drawDebugTab();
    return debugTime.active ? `Скорость: ${debugTime.speed ?? 0} мин/с` : "Скорость не принята";
  },
  /** `weather("rain", 0.8)`, `weather(86)`; `weather()` hands it back to the server. */
  weather(state?: number | string, intensity = 0.7): string {
    if (state === undefined) {
      debugWeather.clear();
      drawDebugTab();
      return "Погода: как на сервере";
    }
    const resolved = weatherState(state);
    if (resolved === undefined) return `Не знаю погоду ${String(state)}: fine, fog, rain, storm, snow, sand или номер WeatherState.`;
    debugWeather.set(resolved, intensity);
    drawDebugTab();
    return `Погода: ${weatherKind(resolved)} (${resolved}) ${intensity}`;
  },
  /** The light the last frame was resolved to (a live object; do not edit it). */
  light: () => lastDebugLight(),
  /** The `.go xyz` line for where the character stands. */
  go: () => goCommand(),
  switches: (patch?: Partial<RenderSwitches>) => (patch ? setRenderSwitches(patch) : renderSwitches),
  /** Every override back to the server and the defaults. */
  reset(): string {
    debugTime.clear();
    debugWeather.clear();
    resetRenderSwitches();
    drawDebugTab();
    return "Отладка сброшена";
  },
  help: () => [
    "webclientDebug.time(6) / time(\"21:30\") / time() — время суток кадра",
    "webclientDebug.timeSpeed(10) — 10 игровых минут в секунду (0 — стоп)",
    "webclientDebug.weather(\"rain\", 0.8) / weather(86) / weather() — погода",
    "webclientDebug.light() — свет последнего кадра",
    "webclientDebug.go() — команда .go xyz для текущей точки",
    "webclientDebug.switches({ terrainSpecular: true }) — переключатели рендера",
    "webclientDebug.reset() — всё как на сервере",
  ].join("\n"),
});

(globalThis as unknown as { webclientDebug: typeof debugConsole }).webclientDebug = debugConsole;
