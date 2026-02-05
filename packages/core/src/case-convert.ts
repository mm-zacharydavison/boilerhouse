/**
 * Case conversion utilities for YAML (snake_case) ↔ TypeScript (camelCase)
 *
 * YAML files use snake_case for docker-compose compatibility.
 * TypeScript code uses camelCase per JS conventions.
 */

import type { CamelCasedPropertiesDeep, SnakeCasedPropertiesDeep } from 'type-fest'

/**
 * Convert a string from snake_case to camelCase
 */
export function snakeToCamel(str: string): string {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())
}

/**
 * Convert a string from camelCase to snake_case
 */
export function camelToSnake(str: string): string {
  return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
}

/**
 * Recursively convert object keys from snake_case to camelCase
 */
export function snakeToCamelDeep<T>(obj: T): CamelCasedPropertiesDeep<T> {
  if (obj === null || obj === undefined) {
    return obj as CamelCasedPropertiesDeep<T>
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => snakeToCamelDeep(item)) as CamelCasedPropertiesDeep<T>
  }

  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj)) {
      const camelKey = snakeToCamel(key)
      result[camelKey] = snakeToCamelDeep(value)
    }
    return result as CamelCasedPropertiesDeep<T>
  }

  return obj as CamelCasedPropertiesDeep<T>
}

/**
 * Recursively convert object keys from camelCase to snake_case
 */
export function camelToSnakeDeep<T>(obj: T): SnakeCasedPropertiesDeep<T> {
  if (obj === null || obj === undefined) {
    return obj as SnakeCasedPropertiesDeep<T>
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => camelToSnakeDeep(item)) as SnakeCasedPropertiesDeep<T>
  }

  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj)) {
      const snakeKey = camelToSnake(key)
      result[snakeKey] = camelToSnakeDeep(value)
    }
    return result as SnakeCasedPropertiesDeep<T>
  }

  return obj as SnakeCasedPropertiesDeep<T>
}

// Re-export type-fest types for convenience
export type { CamelCasedPropertiesDeep, SnakeCasedPropertiesDeep }
