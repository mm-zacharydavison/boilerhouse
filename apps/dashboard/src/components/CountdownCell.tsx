import type { ContainerStatus } from '@boilerhouse/core'
import { useEffect, useState } from 'react'

function getRemainingMs(expiresAt: string): number {
  return new Date(expiresAt).getTime() - Date.now()
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return 'expired'
  const totalSeconds = Math.ceil(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

/**
 * Picks the relevant TTL timestamp based on container status:
 * - idle → idleExpiresAt (pool idle timeout)
 * - claimed → idleExpiresAt (file idle TTL, if configured)
 * - stopping → no TTL
 */
function getRelevantExpiry(status: ContainerStatus, idleExpiresAt: string | null): string | null {
  if (status === 'idle' || status === 'claimed') return idleExpiresAt
  return null
}

export function CountdownCell({
  status,
  idleExpiresAt,
}: {
  status: ContainerStatus
  idleExpiresAt: string | null
}) {
  const expiresAt = getRelevantExpiry(status, idleExpiresAt)
  const [remaining, setRemaining] = useState(() => (expiresAt ? getRemainingMs(expiresAt) : null))

  useEffect(() => {
    if (!expiresAt) {
      setRemaining(null)
      return
    }

    setRemaining(getRemainingMs(expiresAt))
    const interval = setInterval(() => {
      setRemaining(getRemainingMs(expiresAt))
    }, 1000)
    return () => clearInterval(interval)
  }, [expiresAt])

  if (remaining === null) {
    return <span className="text-muted-foreground">-</span>
  }

  const isExpired = remaining <= 0
  const isWarning = !isExpired && remaining < 30_000

  return (
    <span
      className={
        isExpired
          ? 'text-destructive font-medium'
          : isWarning
            ? 'text-orange-500 font-medium'
            : 'font-mono text-sm'
      }
    >
      {formatCountdown(remaining)}
    </span>
  )
}
