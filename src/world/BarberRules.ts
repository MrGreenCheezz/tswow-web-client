// Which kind of look a barber row changes.
//
// Kept away from the table that feeds it because both ends need this: the gateway reads
// `BarberShopStyle.dbc` off disk, and the browser filters the served rows by race, sex and kind.
// A module that reads files cannot be bundled into a page, so the rule lives here and the
// reading lives beside the other DBC loaders — the same split as `LockRules.ts`.

/** `BarberShopStyle.Type`: hair, facial hair, skin. The core checks nothing else. */
export const BARBER_TYPE_HAIR = 0;
export const BARBER_TYPE_FACIAL = 2;
export const BARBER_TYPE_SKIN = 3;
