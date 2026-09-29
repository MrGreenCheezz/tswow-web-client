/**
 * The ownership seam between the stock BarberShopFrame (load-on-demand Blizzard_BarbershopUI) and the
 * native `#barber-window` (ui/BarberShop.ts).
 *
 * The chair is server-driven: `SMSG_ENABLE_BARBER_SHOP` opens it for both windows. The native window
 * steps aside only while the stock frame owns the chair (`frameXmlBarberOwnsShop`); while the add-on
 * loads, after a failure and before the mount it keeps the chair. Every answer is false while nothing
 * is published.
 */

export interface FrameXmlBarberRoute {
  ownsShop(): boolean;
  isOpen(): boolean;
}

let route: FrameXmlBarberRoute | undefined;

/** Publish the one stock barber route and return an identity-safe cleanup. */
export function publishFrameXmlBarber(next: FrameXmlBarberRoute): () => void {
  route = next;
  let cleaned = false;
  return (): void => {
    if (cleaned) return;
    cleaned = true;
    if (route === next) route = undefined;
  };
}

/** Whether stock BarberShopFrame owns the chair now; ui/BarberShop.ts then steps aside. */
export function frameXmlBarberOwnsShop(): boolean {
  const current = route;
  if (!current) return false;
  try { return current.ownsShop(); } catch { return false; }
}

export function frameXmlBarberOpen(): boolean {
  const current = route;
  if (!current) return false;
  try { return current.isOpen(); } catch { return false; }
}
