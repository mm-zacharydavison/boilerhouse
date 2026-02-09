import { describe, expect, test } from 'bun:test'
import type { SyncResult } from './rclone'
import {
  isSourceDirectoryNotFound,
  parseRcloneError,
} from './rclone-errors'

function failedResult(...errors: string[]): SyncResult {
  return { success: false, errors, duration: 100 }
}

function successResult(): SyncResult {
  return { success: true, duration: 50 }
}

describe('isSourceDirectoryNotFound', () => {
  test('matches rclone S3 source directory not found error', () => {
    const result = failedResult(
      'S3 bucket oddjob-boilerhouse path tenants/telegram:1310459686/workspace: error reading source root directory: directory not found',
    )
    expect(isSourceDirectoryNotFound(result)).toBe(true)
  })

  test('matches when error is among multiple errors', () => {
    const result = failedResult(
      'some other warning',
      'S3 bucket my-bucket path some/prefix: error reading source root directory: directory not found',
    )
    expect(isSourceDirectoryNotFound(result)).toBe(true)
  })

  test('does not match generic "directory not found" without the rclone source root prefix', () => {
    const result = failedResult('directory not found')
    expect(isSourceDirectoryNotFound(result)).toBe(false)
  })

  test('does not match successful results', () => {
    expect(isSourceDirectoryNotFound(successResult())).toBe(false)
  })

  test('does not match unrelated errors', () => {
    const result = failedResult('rclone: permission denied')
    expect(isSourceDirectoryNotFound(result)).toBe(false)
  })
})

describe('parseRcloneError', () => {
  test('parses source_directory_not_found with bucket and path', () => {
    const result = failedResult(
      'S3 bucket oddjob-boilerhouse path tenants/telegram:123/agents: error reading source root directory: directory not found',
    )
    const error = parseRcloneError(result)
    expect(error).toEqual({
      type: 'source_directory_not_found',
      bucket: 'oddjob-boilerhouse',
      path: 'tenants/telegram:123/agents',
    })
  })

  test('returns undefined for successful results', () => {
    expect(parseRcloneError(successResult())).toBeUndefined()
  })

  test('returns undefined for unrecognized errors', () => {
    const result = failedResult('rclone exited with code 1')
    expect(parseRcloneError(result)).toBeUndefined()
  })
})
