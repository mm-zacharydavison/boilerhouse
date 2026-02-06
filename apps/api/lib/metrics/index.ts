/**
 * Prometheus Metrics Module
 *
 * Central registry and exports for all Boilerhouse metrics.
 * Follows Prometheus naming conventions with boilerhouse_ prefix.
 */

// Registry and system metrics
export { registry, startTime, systemInfo } from './registry'

// Re-export all metric modules
export * from './pool'
export * from './container'
export * from './sync'
export * from './http'
