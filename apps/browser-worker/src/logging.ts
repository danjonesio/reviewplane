/**
 * Structured logging.
 *
 * `docs/ARCHITECTURE.md` section 15 requires structured logs with correlation
 * identifiers, and `docs/SECURITY.md` section 18 forbids cookies,
 * authorisation headers, raw credentials, full request bodies and browser
 * storage from appearing in them. Fields are therefore a fixed map of short
 * strings rather than arbitrary objects: there is no path by which a page's
 * content or a credential can be handed to a logger by accident, because a
 * caller has to name and bound each field.
 */

export type LogFields = Readonly<Record<string, string>>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

const MAX_FIELD_LENGTH = 200;

function bound(value: string): string {
  return value.length <= MAX_FIELD_LENGTH ? value : `${value.slice(0, MAX_FIELD_LENGTH - 1)}…`;
}

export interface LoggerOptions {
  readonly service: string;
  readonly write?: (line: string) => void;
}

export function createLogger(options: LoggerOptions): Logger {
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const emit = (level: string, message: string, fields: LogFields): void => {
    const record: Record<string, string> = {
      time: new Date().toISOString(),
      level,
      service: options.service,
      message: bound(message),
    };
    for (const [key, value] of Object.entries(fields)) record[key] = bound(value);
    write(JSON.stringify(record));
  };
  return {
    debug: (message, fields = {}) => {
      emit("debug", message, fields);
    },
    info: (message, fields = {}) => {
      emit("info", message, fields);
    },
    warn: (message, fields = {}) => {
      emit("warn", message, fields);
    },
    error: (message, fields = {}) => {
      emit("error", message, fields);
    },
  };
}

/** A logger that records lines, for tests that assert on what was logged. */
export function createRecordingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    logger: createLogger({
      service: "browser-worker",
      write: (line) => {
        lines.push(line);
      },
    }),
  };
}
