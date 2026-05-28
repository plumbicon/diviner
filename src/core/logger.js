import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { format } from "node:util";

/**
 * Small timestamped logger with optional file mirroring.
 */
export class Logger {
    constructor({ logPath = null, timestamp = true } = {}) {
        this.timestamp = timestamp;
        this.logPath = logPath ? resolve(logPath) : null;

        if (this.logPath) {
            mkdirSync(dirname(this.logPath), { recursive: true });
        }
    }

    /**
     * Write an informational message.
     * @param {...unknown} args - Message parts.
     */
    log(...args) {
        this.info(...args);
    }

    /**
     * Write an informational message.
     * @param {...unknown} args - Message parts.
     */
    info(...args) {
        this.write(process.stdout, args);
    }

    /**
     * Write a warning message.
     * @param {...unknown} args - Message parts.
     */
    warn(...args) {
        this.write(process.stderr, args);
    }

    /**
     * Write an error message.
     * @param {...unknown} args - Message parts.
     */
    error(...args) {
        this.write(process.stderr, args);
    }

    /**
     * Install this logger as the process console sink.
     * @returns {Function} Restore function.
     */
    installConsole() {
        const original = {
            log: console.log,
            warn: console.warn,
            error: console.error,
        };

        console.log = (...args) => this.info(...args);
        console.warn = (...args) => this.warn(...args);
        console.error = (...args) => this.error(...args);

        return () => {
            console.log = original.log;
            console.warn = original.warn;
            console.error = original.error;
        };
    }

    write(stream, args) {
        const message = format(...args);
        const output = this.formatMessage(message);
        stream.write(output);

        if (this.logPath) {
            appendFileSync(this.logPath, output);
        }
    }

    formatMessage(message) {
        const lines = String(message).split("\n");
        const prefix = this.timestamp ? `[${new Date().toISOString()}] ` : "";
        const formatted = lines
            .map((line, index) => {
                if (line === "" && index === lines.length - 1) {
                    return "";
                }
                return `${prefix}${line}`;
            })
            .join("\n");

        return formatted.endsWith("\n") ? formatted : `${formatted}\n`;
    }
}

/**
 * Create a Logger instance.
 * @param {object} options - Logger options.
 * @returns {Logger} Logger.
 */
export function createLogger(options = {}) {
    return new Logger(options);
}
