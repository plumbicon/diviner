import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Tiny JSON-file persistence for software SL/TP across process restarts.
 *
 * The T-Invest sandbox has no exchange stop orders, so SL/TP are enforced in
 * software by the engine on each candle close (see core/stops.js). Those levels
 * live only in memory, so a restart — e.g. the stall watchdog exiting for a
 * fresh connection — would lose them: the position is re-synced from the account
 * (which carries no SL/TP) and left unprotected. This store survives restarts —
 * levels are written on open and restored when reconciling with the account.
 *
 * One file per account+instrument (the bot runs one process per ticker).
 */
export class PositionStore {
    /**
     * @param {string} filePath - Absolute path to the JSON state file.
     * @param {{verbose?: boolean}} [options] - Options.
     */
    constructor(filePath, { verbose = false } = {}) {
        this.filePath = filePath;
        this.verbose = Boolean(verbose);
    }

    /**
     * Read the persisted record, or null if absent/unreadable.
     * @returns {object|null} Stored record.
     */
    load() {
        try {
            return JSON.parse(readFileSync(this.filePath, "utf8"));
        } catch {
            return null;
        }
    }

    /**
     * Persist a record (best-effort; failures are swallowed).
     * @param {object} record - Record to store.
     */
    save(record) {
        try {
            mkdirSync(dirname(this.filePath), { recursive: true });
            writeFileSync(this.filePath, JSON.stringify(record));
        } catch (error) {
            if (this.verbose) {
                console.warn(`[PositionStore] save failed: ${error.message}`);
            }
        }
    }

    /**
     * Remove the persisted record (best-effort).
     */
    clear() {
        try {
            rmSync(this.filePath, { force: true });
        } catch (error) {
            if (this.verbose) {
                console.warn(`[PositionStore] clear failed: ${error.message}`);
            }
        }
    }
}
