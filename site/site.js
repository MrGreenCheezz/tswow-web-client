// The players' site (site/index.html): the download card from the app's update manifest, and the
// registration form, which sends only the SRP6 salt and verifier (site/srp.js), never the password.
import { PASSWORD_PATTERN, USERNAME_PATTERN, registrationData } from "/site/srp.js";

const ERRORS = {
  "bad-username": "Логин: латиница и цифры, от 3 до 16 символов.",
  "bad-request": "Сервер не принял данные. Обновите страницу и попробуйте ещё раз.",
  taken: "Такой логин уже занят.",
  "too-many": "Слишком много попыток. Попробуйте позже.",
  closed: "Регистрация сейчас закрыта.",
  unavailable: "База учётных записей недоступна. Попробуйте позже.",
};

async function showDownload() {
  const link = document.getElementById("download-link");
  const info = document.getElementById("download-info");
  try {
    const response = await fetch("/player/latest.json", { cache: "no-cache" });
    if (!response.ok) throw new Error(String(response.status));
    const { version, size, file } = await response.json();
    link.href = `/player/${encodeURIComponent(file)}`;
    info.textContent = `Версия ${version} · ${(size / 1024 / 1024).toFixed(0)} МБ`;
  } catch {
    link.setAttribute("aria-disabled", "true");
    link.removeAttribute("href");
    info.textContent = "Приложение пока не выложено — играйте в браузере.";
  }
}

function setStatus(text, kind) {
  const status = document.getElementById("register-status");
  status.textContent = text;
  status.className = `status ${kind ?? ""}`;
}

async function register(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const username = form.username.value.trim();
  const password = form.password.value;
  if (!USERNAME_PATTERN.test(username)) return setStatus(ERRORS["bad-username"], "error");
  if (!PASSWORD_PATTERN.test(password)) return setStatus("Пароль: от 6 до 16 символов, латиница, цифры и знаки, без пробелов.", "error");
  if (password !== form.repeat.value) return setStatus("Пароли не совпадают.", "error");
  const button = form.querySelector("button");
  button.disabled = true;
  setStatus("Создаём учётную запись…");
  try {
    const response = await fetch("/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registrationData(username, password)),
    });
    const result = await response.json().catch(() => ({}));
    if (response.ok && result.ok) {
      form.reset();
      setStatus(`Готово! Учётная запись ${result.username} создана — входите в игру.`, "ok");
    } else {
      setStatus(ERRORS[result.error] ?? `Не получилось (код ${response.status}).`, "error");
    }
  } catch {
    setStatus("Нет связи с сервером.", "error");
  } finally {
    button.disabled = false;
  }
}

async function showRegistration() {
  try {
    const { registration } = await (await fetch("/api/site", { cache: "no-store" })).json();
    if (!registration) {
      document.querySelector("#register-form button").disabled = true;
      setStatus(ERRORS.closed, "error");
    }
  } catch {
    // The form still says what went wrong when it is sent.
  }
}

document.getElementById("register-form").addEventListener("submit", register);
void showDownload();
void showRegistration();
