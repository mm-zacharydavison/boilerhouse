import { Layout } from '@/components/layout'
import { Badge, Card, CardContent, CardHeader, CardTitle } from '@/components/ui'
import { useActivity } from '@/hooks/useApi'
import { formatRelativeTime } from '@/lib/utils'
import { mockActivity } from '@/mocks/data'
import { Activity, AlertTriangle, Box, Cloud, HardDrive, Loader2 } from 'lucide-react'
import { Link } from 'react-router-dom'

function ActivityIcon({ type }: { type: string }) {
  const className = 'h-5 w-5'
  switch (type) {
    case 'container.created':
    case 'container.claimed':
      return <HardDrive className={`${className} text-green-500`} />
    case 'container.released':
    case 'container.destroyed':
      return <HardDrive className={`${className} text-muted-foreground`} />
    case 'container.unhealthy':
      return <AlertTriangle className={`${className} text-red-500`} />
    case 'sync.started':
    case 'sync.completed':
      return <Cloud className={`${className} text-blue-500`} />
    case 'sync.failed':
      return <Cloud className={`${className} text-red-500`} />
    case 'pool.scaled':
      return <Box className={`${className} text-purple-500`} />
    case 'pool.warning':
      return <AlertTriangle className={`${className} text-yellow-500`} />
    default:
      return <Activity className={`${className} text-muted-foreground`} />
  }
}

function EventTypeBadge({ type }: { type: string }) {
  const variant =
    type.includes('failed') || type.includes('unhealthy') || type.includes('error')
      ? 'destructive'
      : type.includes('warning')
        ? 'warning'
        : type.includes('created') || type.includes('claimed') || type.includes('completed')
          ? 'success'
          : 'secondary'

  const label = type.replace('.', ' ').replace(/^\w/, (c) => c.toUpperCase())

  return <Badge variant={variant}>{label}</Badge>
}

export function ActivityPage() {
  const { data: activityData, isLoading } = useActivity(50)
  const activity = activityData ?? mockActivity

  if (isLoading && !activityData) {
    return (
      <Layout title="Activity">
        <div className="flex items-center justify-center h-64">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </Layout>
    )
  }

  return (
    <Layout title="Activity">
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Recent Activity</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-6">
              {activity.map((event) => (
                <div key={event.id} className="flex gap-4">
                  <div className="mt-1">
                    <ActivityIcon type={event.type} />
                  </div>
                  <div className="flex-1 space-y-2">
                    <div className="flex items-start justify-between">
                      <div className="space-y-1">
                        <p className="font-medium">{event.message}</p>
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <EventTypeBadge type={event.type} />
                          {event.poolId && (
                            <>
                              <span>•</span>
                              <Link to={`/pools/${event.poolId}`} className="hover:underline">
                                {event.poolId}
                              </Link>
                            </>
                          )}
                          {event.tenantId && (
                            <>
                              <span>•</span>
                              <Link to={`/tenants/${event.tenantId}`} className="hover:underline">
                                {event.tenantId}
                              </Link>
                            </>
                          )}
                          {event.containerId && (
                            <>
                              <span>•</span>
                              <span className="font-mono">{event.containerId}</span>
                            </>
                          )}
                        </div>
                      </div>
                      <span className="text-sm text-muted-foreground whitespace-nowrap">
                        {formatRelativeTime(event.timestamp)}
                      </span>
                    </div>
                    {event.metadata && Object.keys(event.metadata).length > 0 && (
                      <div className="rounded bg-muted/50 p-2 text-xs">
                        <pre className="text-muted-foreground">
                          {JSON.stringify(event.metadata, null, 2)}
                        </pre>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </Layout>
  )
}
