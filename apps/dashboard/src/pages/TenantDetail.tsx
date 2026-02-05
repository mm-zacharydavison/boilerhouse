import { Layout } from '@/components/layout'
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from '@/components/ui'
import { formatRelativeTime } from '@/lib/utils'
import { mockTenants } from '@/mocks/data'
import { ArrowLeft, Cloud, HardDrive, Play, Square } from 'lucide-react'
import { Link, useParams } from 'react-router-dom'

function TenantStatusBadge({ status }: { status: string }) {
  switch (status) {
    case 'active':
      return <Badge variant="success">Active</Badge>
    case 'pending':
      return <Badge variant="warning">Pending</Badge>
    case 'releasing':
      return <Badge variant="secondary">Releasing</Badge>
    case 'idle':
      return <Badge variant="outline">Idle</Badge>
    default:
      return <Badge variant="outline">{status}</Badge>
  }
}

function SyncStatusBadge({ state }: { state: string }) {
  switch (state) {
    case 'idle':
      return <Badge variant="secondary">Idle</Badge>
    case 'syncing':
      return <Badge variant="default">Syncing</Badge>
    case 'error':
      return <Badge variant="destructive">Error</Badge>
    default:
      return <Badge variant="outline">{state}</Badge>
  }
}

export function TenantDetailPage() {
  const { tenantId } = useParams<{ tenantId: string }>()
  const tenant = mockTenants.find((t) => t.id === tenantId)

  if (!tenant) {
    return (
      <Layout title="Tenant Not Found">
        <div className="flex flex-col items-center justify-center py-12">
          <p className="text-muted-foreground">Tenant "{tenantId}" not found</p>
          <Link to="/tenants" className="mt-4 text-primary hover:underline">
            Back to tenants
          </Link>
        </div>
      </Layout>
    )
  }

  return (
    <Layout title={`Tenant: ${tenant.id}`}>
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Link to="/tenants">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div className="flex-1">
            <div className="flex items-center gap-3">
              <h2 className="text-2xl font-bold">{tenant.id}</h2>
              <TenantStatusBadge status={tenant.status} />
            </div>
          </div>
          {tenant.status === 'active' && (
            <Button variant="destructive">
              <Square className="mr-2 h-4 w-4" />
              Release
            </Button>
          )}
        </div>

        <div className="grid gap-6 md:grid-cols-2">
          {/* Container Info */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <HardDrive className="h-5 w-5" />
                Container
              </CardTitle>
            </CardHeader>
            <CardContent>
              {tenant.containerId ? (
                <div className="space-y-4">
                  <div>
                    <p className="text-sm text-muted-foreground">Container ID</p>
                    <p className="font-mono">{tenant.containerId}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Pool</p>
                    <Link to={`/pools/${tenant.poolId}`} className="text-primary hover:underline">
                      {tenant.poolId}
                    </Link>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Assigned</p>
                    <p>{tenant.assignedAt ? formatRelativeTime(tenant.assignedAt) : '-'}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Last Activity</p>
                    <p>{tenant.lastActivityAt ? formatRelativeTime(tenant.lastActivityAt) : '-'}</p>
                  </div>
                </div>
              ) : (
                <div className="text-center py-8 text-muted-foreground">
                  <HardDrive className="mx-auto h-12 w-12 mb-4 opacity-50" />
                  <p>No container assigned</p>
                  <Button className="mt-4">
                    <Play className="mr-2 h-4 w-4" />
                    Claim Container
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Sync Status */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Cloud className="h-5 w-5" />
                Sync Status
              </CardTitle>
            </CardHeader>
            <CardContent>
              {tenant.syncStatus ? (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">Status</span>
                    <SyncStatusBadge state={tenant.syncStatus.state} />
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Last Sync</p>
                    <p>
                      {tenant.syncStatus.lastSyncAt
                        ? formatRelativeTime(tenant.syncStatus.lastSyncAt)
                        : 'Never'}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Pending Operations</p>
                    <p>{tenant.syncStatus.pendingCount}</p>
                  </div>
                  {tenant.syncStatus.errors.length > 0 && (
                    <div>
                      <p className="text-sm text-muted-foreground">Recent Errors</p>
                      <div className="mt-2 space-y-2">
                        {tenant.syncStatus.errors.map((error) => (
                          <div
                            key={`${error.timestamp.toISOString()}-${error.message}`}
                            className="rounded bg-destructive/10 p-2 text-sm text-destructive"
                          >
                            {error.message}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="pt-4 flex gap-2">
                    <Button variant="outline" size="sm">
                      <Cloud className="mr-2 h-4 w-4" />
                      Sync Now
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="text-center py-8 text-muted-foreground">
                  <Cloud className="mx-auto h-12 w-12 mb-4 opacity-50" />
                  <p>No sync configuration</p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </Layout>
  )
}
