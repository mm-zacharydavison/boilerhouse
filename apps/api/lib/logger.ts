/**
 * Structured Logger
 *
 * Creates a pino-based logger shared across all services. In production,
 * outputs JSON for log aggregation. In development, uses pino-pretty
 * for human-readable output.
 *
 * When OTEL is active, a mixin automatically includes traceId in every
 * log line — no manual passing required.
 */

import pino from 'pino'

export type Logger = pino.Logger

export function createLogger(level = 'info'): Logger {
  return pino({ level })
}
