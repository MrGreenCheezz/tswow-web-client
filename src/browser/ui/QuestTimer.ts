/** A timed quest's log field is an absolute Unix expiry in the realm's clock. */
export interface QuestTimerDisplay {
  text: string;
  urgent: boolean;
}

/** Keep the clock's absence honest; a local wall clock may differ from the realm's. */
export function questTimerDisplay(expiresAt: number, serverNow: number | undefined): QuestTimerDisplay {
  if (serverNow === undefined || !Number.isFinite(serverNow)) {
    return { text: "Сверяем время…", urgent: false };
  }

  const seconds = Math.max(0, Math.ceil(expiresAt - serverNow));
  if (seconds === 0) {
    // Only the server can change the quest's failed state. An elapsed client clock is a warning.
    return { text: "Время истекло", urgent: true };
  }
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  const clock = hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
  return { text: `Осталось ${clock}`, urgent: seconds <= 60 };
}
