/**
 * The options this client actually honours, and how they travel.
 *
 * Deliberately short. An option that nothing reads is worse than no option: it teaches the player
 * that the settings window does not work. Every entry below is wired to something on screen, and
 * the list grows when a feature grows, not before.
 *
 * The blob is JSON. The original client's config cache is a `.wtf` file whose exact layout is not
 * discoverable from anything in this repo — no FrameXML writer, no packet, no reference client —
 * so interoperating with a retail client on the same account was never on the table. What is on
 * the table is the settings following the *account* rather than the browser profile, which is what
 * the eight slots are for.
 *
 * DOM-free: this is the part with the defaults and the clamping in it.
 */

export type SettingKind = "boolean" | "number";

export interface SettingDefinition {
  id: string;
  label: string;
  hint?: string | undefined;
  kind: SettingKind;
  fallback: boolean | number;
  /** Numbers only. */
  min?: number | undefined;
  max?: number | undefined;
  step?: number | undefined;
  /** Which group the window draws it under. */
  group: string;
  /**
   * Drawn by the window it belongs to rather than by the settings window.
   *
   * Stored, clamped and carried on the account blob exactly like the rest — only the control is
   * somewhere else, because that is where the original client puts it. The alternative is two
   * checkboxes for one value on two screens, which is how a settings window stops being believed.
   */
  ownWindow?: boolean | undefined;
}

export const SETTING_GROUPS = ["Мир", "Звук", "Интерфейс", "Чат"] as const;

export const SETTING_DEFINITIONS: readonly SettingDefinition[] = [
  {
    id: "chatBubbles", label: "Пузыри над головами", group: "Мир", kind: "boolean", fallback: true,
    hint: "Что говорят рядом — над головой говорящего, а не только в чате.",
  },
  {
    id: "floatingCombatText", label: "Всплывающий урон", group: "Мир", kind: "boolean", fallback: true,
    hint: "Числа урона и лечения поднимаются над тем, кто их получил.",
  },
  {
    id: "combatOverlay", label: "Боевой лог над миром", group: "Мир", kind: "boolean", fallback: true,
    hint: "Восемь последних строк боя слева. Полная история — во вкладке «Бой».",
  },
  {
    id: "plateEnemies", label: "Таблички над врагами", group: "Мир", kind: "boolean", fallback: true,
    hint: "Имя, уровень, здоровье и полоса каста над всем, что можно ударить.",
  },
  {
    id: "plateFriends", label: "Таблички над союзниками", group: "Мир", kind: "boolean", fallback: false,
    hint: "В городе это табличка над каждым стражником и каждым прохожим, поэтому выключено.",
  },
  {
    id: "renderScale", label: "Масштаб отрисовки, %", group: "Мир", kind: "number", fallback: 100,
    min: 50, max: 100, step: 5,
    hint: "Мир рисуется в этой доле от размера окна и растягивается. Ниже 100 — быстрее и мягче.",
  },
  {
    id: "lightingQuality", label: "Качество освещения", group: "Мир", kind: "number", fallback: 1,
    min: 0, max: 2, step: 1,
    hint: "0 — без теней, 1 — сбалансированные тени, 2 — более чёткие тени.",
  },
  {
    id: "wmoOcclusion", label: "Скрывать невидимые помещения", group: "Мир", kind: "boolean", fallback: true,
    hint: "Порталы зданий не рисуют комнаты за стенами. Выключить — оставить только отсечение по дальности.",
  },
  {
    id: "characterAtlasAnisotropy", label: "Эксперимент: фильтрация атласов персонажей", group: "Мир", kind: "boolean", fallback: false,
    hint: "A/B-кандидат: максимум фильтрации видеокарты делает тело чётче под углом, но может расходовать больше bandwidth. Выключено до телеметрии R1.",
  },
  {
    id: "experimentalAerialHeightFog", label: "Эксперимент: faithful-plus высотный туман", group: "Мир", kind: "boolean", fallback: false,
    hint: "Экспериментальный профиль aerial/height fog пока заблокирован и ничего не меняет; оставлено для будущего безопасного среза.",
  },
  {
    id: "experimentalTerrainMicroNormals", label: "Faithful-plus: микрорельеф земли", group: "Мир", kind: "boolean", fallback: true,
    hint: "Добавляет небольшой микрорельеф splat-текстурам в авторском свете. Вдали и у границ чанков эффект затухает; выключение возвращает baseline shader.",
  },
  {
    id: "experimentalWaterFresnel", label: "Faithful-plus: Fresnel воды", group: "Мир", kind: "boolean", fallback: true,
    hint: "Мягко усиливает отражённый край воды и океана. Включено по умолчанию; выключение возвращает исходный shader.",
  },
  {
    id: "experimentalWaterMicroWaves", label: "Faithful-plus: микроволны воды", group: "Мир", kind: "boolean", fallback: true,
    hint: "Добавляет мелкую анимацию normal и цвета воды. Включено по умолчанию и не меняет геометрию поверхности.",
  },
  {
    id: "experimentalWaterSunSparkle", label: "Faithful-plus: солнечные блики воды", group: "Мир", kind: "boolean", fallback: true,
    hint: "Добавляет направленные солнечные блики над поверхностью; под водой эффект подавляется. Выключение возвращает baseline.",
  },
  {
    id: "experimentalFantasyGlow", label: "Faithful-plus: фэнтезийное свечение", group: "Мир", kind: "boolean", fallback: true,
    hint: "Усиливает только авторские additive-эффекты заклинаний и собственное свечение магмы/слизи. Без bloom, новых источников света и дополнительных проходов.",
  },
  {
    // The original client's own «Ground Clutter Radius»: ground cover gets a ceiling of its own
    // rather than a share of the doodad range, which is what the reference client does and says
    // why — "grass stops between 70 and 140 yards in the original client while doodads run to the
    // horizon" (`wowee/include/rendering/m2_renderer.hpp:566-575`). The default sits below that
    // range deliberately: 50 yards is 3,525 tufts in the densest window of the Goldshire ring,
    // 14,100 triangles and 0.33 ms to scatter and compose, and what a field of alpha-tested quads
    // at knee height costs in overdraw is the one thing no offline measurement produces. Zero
    // turns the field off outright.
    id: "grassRadius", label: "Дальность травы", group: "Мир", kind: "number", fallback: 50,
    min: 0, max: 140, step: 10,
    hint: "В ярдах. Трава и кустики рисуются только внутри этого круга; 0 — не рисовать вовсе.",
  },
  {
    // The density unit, which nothing offline settles: `GroundEffectTexture.Density` is either
    // doodads per 4.17-yard detail cell or per 33.3-yard chunk, and the two differ by 64 times.
    // The whole argument is on `ScatterOptions.perCell` in GroundCover.ts; thirty seconds in
    // Elwynn settles it, which is why the other reading is a switch and not a deleted branch.
    id: "grassDense", label: "Густая трава", group: "Мир", kind: "boolean", fallback: true,
    hint: "Плотность из таблицы — на клетку 4,17 ярда. Выключить: та же плотность на чанк, в 64 раза реже.",
  },
  {
    // The original client's `cameraDistanceMaxFactor` (`InterfaceOptionsPanels.lua:1440`), which is
    // a multiplier from 1 to 2 in steps of a tenth. In yards here rather than in multiples, for a
    // reason that lives in the code above: `coerceSetting` rounds every number setting to a whole
    // one, so a factor slider would collapse to 1 or 2 with nothing in between. Yards is also the
    // unit the wheel already speaks, and 55 is where it has always stopped.
    id: "cameraMaxDistance", label: "Максимальная дистанция камеры", group: "Мир", kind: "number", fallback: 55,
    min: 15, max: 55, step: 5,
    hint: "В ярдах. Как далеко колесо отпускает камеру: меньше — ближе к персонажу и меньше мира в кадре.",
  },
  {
    id: "actionBarBottomLeft", label: "Нижняя левая панель команд", group: "Интерфейс", kind: "boolean", fallback: false,
    hint: "Слоты 73-84 из тех 144, что держит сервер. Клавиши для них назначаются в окне привязок.",
  },
  {
    id: "actionBarBottomRight", label: "Нижняя правая панель команд", group: "Интерфейс", kind: "boolean", fallback: false,
    hint: "Слоты 85-96.",
  },
  {
    id: "actionBarRight", label: "Правая панель команд", group: "Интерфейс", kind: "boolean", fallback: false,
    hint: "Слоты 97-108.",
  },
  {
    id: "actionBarRight2", label: "Вторая правая панель команд", group: "Интерфейс", kind: "boolean", fallback: false,
    hint: "Слоты 109-120.",
  },
  {
    id: "minimapRotate", label: "Поворачивать миникарту", group: "Интерфейс", kind: "boolean", fallback: false,
  },
  {
    id: "notices", label: "Показывать отказы сервера", group: "Интерфейс", kind: "boolean", fallback: true,
    hint: "«Вне зоны действия», «нет места» и прочее — посреди экрана.",
  },
  {
    // The original client's `ShowAllSpellRanksCheckBox`, inverted so that the default is the tidy
    // book: on by default because the server has already thrown away the lower ranks of everything
    // that is not stackable, and what it leaves behind is where the pile comes from — a mage's
    // book holds 351 spells on this dataset and 132 of them are the top of their chain.
    // Blizzard hides this switch for warriors and rogues, and the numbers say why: their spells
    // cost rage and energy, `SpellInfo::IsStackableWithRanks` returns false for those, and the
    // server sends one rank of each already.
    id: "spellbookHideLowerRanks", label: "Только высшие ранги", group: "Интерфейс", kind: "boolean",
    fallback: true, ownWindow: true,
    hint: "Книга показывает только старший ранг каждого заклинания. Галочка — в шапке книги.",
  },
  {
    id: "volumeMaster", label: "Общая громкость, %", group: "Звук", kind: "number", fallback: 70,
    min: 0, max: 100, step: 5,
    hint: "Ноль — тишина, а не пауза: звуки идут своим чередом, их просто не слышно.",
  },
  {
    id: "volumeEffects", label: "Звуки мира, %", group: "Звук", kind: "number", fallback: 100,
    min: 0, max: 100, step: 5,
    hint: "То, что звучит из точки в мире: заклинания, двери, существа. Слышно с той стороны, где оно стоит.",
  },
  {
    id: "volumeMusic", label: "Музыка, %", group: "Звук", kind: "number", fallback: 60,
    min: 0, max: 100, step: 5,
    hint: "Тема зоны и то, что сервер ставит вместо неё.",
  },
  {
    id: "volumeInterface", label: "Звуки интерфейса, %", group: "Звук", kind: "number", fallback: 100,
    min: 0, max: 100, step: 5,
  },
  {
    id: "chatLogHeight", label: "Высота окна чата", group: "Чат", kind: "number", fallback: 190,
    min: 90, max: 420, step: 10, hint: "В пикселях. От неё считается всё, что стоит на нижнем краю.",
  },
  {
    id: "chatTimestamps", label: "Время у строк чата", group: "Чат", kind: "boolean", fallback: false,
  },
];

export type SettingValues = Record<string, boolean | number>;

export function settingDefinition(id: string): SettingDefinition | undefined {
  return SETTING_DEFINITIONS.find((definition) => definition.id === id);
}

export function defaultSettings(): SettingValues {
  const values: SettingValues = {};
  for (const definition of SETTING_DEFINITIONS) values[definition.id] = definition.fallback;
  return values;
}

/** Clamps a number into its declared range and keeps a boolean a boolean. */
export function coerceSetting(definition: SettingDefinition, value: unknown): boolean | number {
  if (definition.kind === "boolean") return value === true;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return definition.fallback;
  const min = definition.min ?? Number.NEGATIVE_INFINITY;
  const max = definition.max ?? Number.POSITIVE_INFINITY;
  return Math.min(max, Math.max(min, Math.round(number)));
}

export function settingBoolean(values: SettingValues, id: string): boolean {
  const value = values[id];
  return typeof value === "boolean" ? value : settingDefinition(id)?.fallback === true;
}

export function settingNumber(values: SettingValues, id: string): number {
  const value = values[id];
  const definition = settingDefinition(id);
  if (typeof value === "number") return value;
  return typeof definition?.fallback === "number" ? definition.fallback : 0;
}

/**
 * Reads a stored blob.
 *
 * Anything unrecognised is dropped rather than kept: the slot is shared with whatever version of
 * this client wrote it last, and a setting that no longer exists must not survive as a value
 * nothing clamps.
 */
export function parseSettings(text: string): SettingValues | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const values = defaultSettings();
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const definition = settingDefinition(id);
    if (definition) values[id] = coerceSetting(definition, value);
  }
  return values;
}

/** Only what differs from the defaults, so the blob does not grow with every option added. */
export function serialiseSettings(values: SettingValues): string {
  const changed: SettingValues = {};
  for (const definition of SETTING_DEFINITIONS) {
    const value = values[definition.id];
    if (value !== undefined && value !== definition.fallback) changed[definition.id] = value;
  }
  return JSON.stringify(changed);
}
