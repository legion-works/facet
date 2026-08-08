/**
 * Structured JSON logger.
 *
 * Diagnostics go to STDERR, ONE JSON object per line. STDOUT is reserved
 * for CLI envelopes — never pollute it from here. Every payload is piped
 * through `redact()` before serialization so a token accidentally logged
 * inside a `details` block is scrubbed at the source.
 *
 * Required fields: level, event, component, timestamp, pid.
 * Optional fields: requestId, artifactId, revisionSha, durationMs, errorCode.
 */

import { redact } from "./redact";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LoggerFields {
  readonly requestId?: string;
  readonly artifactId?: string;
  readonly revisionSha?: string;
  readonly durationMs?: number;
  readonly errorCode?: string;
  readonly [key: string]: unknown;
}

export interface FacetLoggerOptions {
  readonly component: string;
  readonly baseFields?: LoggerFields;
}

export interface FacetLogger {
  debug(event: string, fields?: LoggerFields): void;
  info(event: string, fields?: LoggerFields): void;
  warn(event: string, fields?: LoggerFields): void;
  error(event: string, fields?: LoggerFields): void;
  child(component: string): FacetLogger;
}

class FacetLoggerImpl implements FacetLogger {
  constructor(
    private readonly component: string,
    private readonly baseFields: LoggerFields = {},
  ) {}

  child(component: string): FacetLogger {
    return new FacetLoggerImpl(component, this.baseFields);
  }

  debug(event: string, fields: LoggerFields = {}): void {
    this.emit("debug", event, fields);
  }
  info(event: string, fields: LoggerFields = {}): void {
    this.emit("info", event, fields);
  }
  warn(event: string, fields: LoggerFields = {}): void {
    this.emit("warn", event, fields);
  }
  error(event: string, fields: LoggerFields = {}): void {
    this.emit("error", event, fields);
  }

  private emit(level: LogLevel, event: string, fields: LoggerFields): void {
    const merged: Record<string, unknown> = {
      level,
      event,
      component: this.component,
      timestamp: new Date().toISOString(),
      pid: process.pid,
      ...this.baseFields,
      ...fields,
    };
    // drop undefined keys so JSON.stringify never emits "key":undefined
    for (const [k, v] of Object.entries(merged)) {
      if (v === undefined) delete merged[k];
    }
    const scrubbed = redact(merged);
    process.stderr.write(`${JSON.stringify(scrubbed)}\n`);
  }
}

export function createLogger(options: FacetLoggerOptions): FacetLogger {
  return new FacetLoggerImpl(options.component, options.baseFields ?? {});
}
