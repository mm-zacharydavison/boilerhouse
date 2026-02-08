import { describe, expect, mock, test } from 'bun:test'
import { DockerRuntime } from './docker-runtime'

function createRuntimeWithMockDocker() {
  const runtime = new DockerRuntime()

  const mockContainer = {
    restart: mock(async () => {}),
    start: mock(async () => {}),
  }

  // Replace the internal docker client with a mock
  ;(runtime as unknown as { docker: { getContainer: () => typeof mockContainer } }).docker = {
    getContainer: () => mockContainer,
  }

  return { runtime, mockContainer }
}

describe('DockerRuntime', () => {
  describe('restartContainer', () => {
    test('calls restart on the container', async () => {
      const { runtime, mockContainer } = createRuntimeWithMockDocker()

      await runtime.restartContainer('test-container')

      expect(mockContainer.restart).toHaveBeenCalledTimes(1)
      expect(mockContainer.start).not.toHaveBeenCalled()
    })

    test('falls back to start when container is already stopped (304)', async () => {
      const { runtime, mockContainer } = createRuntimeWithMockDocker()

      const error = Object.assign(new Error('container already stopped'), { statusCode: 304 })
      mockContainer.restart = mock(async () => {
        throw error
      })

      await runtime.restartContainer('test-container')

      expect(mockContainer.restart).toHaveBeenCalledTimes(1)
      expect(mockContainer.start).toHaveBeenCalledTimes(1)
    })

    test('rethrows non-304 errors', async () => {
      const { runtime, mockContainer } = createRuntimeWithMockDocker()

      const error = Object.assign(new Error('container not found'), { statusCode: 404 })
      mockContainer.restart = mock(async () => {
        throw error
      })

      expect(runtime.restartContainer('test-container')).rejects.toThrow('container not found')
      expect(mockContainer.start).not.toHaveBeenCalled()
    })

    test('passes timeout to restart', async () => {
      const { runtime, mockContainer } = createRuntimeWithMockDocker()

      await runtime.restartContainer('test-container', 5)

      expect(mockContainer.restart).toHaveBeenCalledWith({ t: 5 })
    })
  })
})
