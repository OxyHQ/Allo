/**
 * WHETHER THE PHASE 2 SCREENS START WITH SAMPLE DATA.
 *
 * Calls, status updates and presence have no transport behind them, so their
 * stores ship a `DEMO_*` constant that makes the screens worth looking at. That
 * is a development aid, not something to draw at somebody who signed in: in a
 * release build the entries would name accounts the people layer cannot
 * resolve, and a call log of strangers is exactly the invented data this app
 * does not show. So the seeds are DEV ONLY — a release opens those screens
 * empty, with the same notice saying nothing is connected yet.
 *
 * A transport deletes the constants and this file with them.
 */
export const SEED_DEMO_DATA = __DEV__;
