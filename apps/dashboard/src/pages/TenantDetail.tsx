import { Layout } from '@/components/layout'
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from '@/components/ui'
import { useReleaseContainer, useSyncHistory, useTenant, useTriggerSync } from '@/hooks'
import { formatRelativeTime } from '@/lib/utils'
import { TenantId } from '@boilerhouse/core'
import { ArrowLeft, Cloud, HardDrive, Loader2, Play, RefreshCw, Square } from 'lucide-react'
import { Link, useNavigate, useParams } from 'react-router-dom'

function TenantStatusBadge({ status }: { status: string }) {
  switch (status) {
    case 'active':
      return <Badge variant="success">Active</Badge>
    case 'warm':
      return <Badge variant="success">Warm</Badge>
    case 'pending':
      return <Badge variant="warning">Pending</Badge>
    case 'provisioning':
      return <Badge variant="warning">Provisioning</Badge>
    case 'releasing':
      return <Badge variant="secondary">Releasing</Badge>
    case 'idle':
      return <Badge variant="outline">Idle</Badge>
    case 'cold':
      return <Badge variant="outline">Cold</Badge>
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
    case 'pending':
      return <Badge variant="warning">Pending</Badge>
    case 'completed':
      return <Badge variant="success">Completed</Badge>
    case 'error':
    case 'failed':
      return <Badge variant="destructive">Error</Badge>
    default:
      return <Badge variant="outline">{state}</Badge>
  }
}

export function TenantDetailPage() {
  const { tenantId: rawTenantId } = useParams<{ tenantId: string }>()
  const tenantId = rawTenantId ? TenantId(rawTenantId) : undefined
  const navigate = useNavigate()
  const { data: tenant, isLoading, error } = useTenant(tenantId ?? TenantId(''))
  const { data: syncHistory } = useSyncHistory(tenantId, 10)
  const releaseContainer = useReleaseContainer()
  const triggerSync = useTriggerSync()

  const handleRelease = async () => {
    if (!tenantId) return
    await releaseContainer.mutateAsync({ tenantId, sync: true })
    navigate('/tenants')
  }

  const handleSync = async (direction: 'upload' | 'download' | 'both') => {
    if (!tenantId) return
    await triggerSync.mutateAsync({ tenantId, direction })
  }

  if (isLoading) {
    return (
      <Layout title="Tenant">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </Layout>
    )
  }

  if (error || !tenant) {
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
          {(tenant.status === 'active' || tenant.status === 'warm') && (
            <Button
              variant="destructive"
              onClick={handleRelease}
              disabled={releaseContainer.isPending}
            >
              {releaseContainer.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Square className="mr-2 h-4 w-4" />
              )}
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
                    <p className="font-mono text-sm">{tenant.containerId}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Pool</p>
                    <Link to={`/pools/${tenant.poolId}`} className="text-primary hover:underline">
                      {tenant.poolId}
                    </Link>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Claimed</p>
                    <p>{tenant.claimedAt ? formatRelativeTime(tenant.claimedAt) : '-'}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Last Activity</p>
                    <p>{tenant.lastActivityAt ? formatRelativeTime(tenant.lastActivityAt) : '-'}</p>
                  </div>
                </div>
              ) : (
                <div className="text-center py-8 text-muted-foreground">
                  <HardDrive className="mx-auto h-12 w-12 mb-4 opacity-50" />
                  <p>No container claimed</p>
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
                    <SyncStatusBadge
                      state={
                        tenant.syncStatus.pendingCount > 0
                          ? 'syncing'
                          : tenant.syncStatus.errors?.length > 0
                            ? 'error'
                            : 'idle'
                      }
                    />
                  </div>
                  {tenant.syncStatus.lastSyncAt && (
                    <div>
                      <p className="text-sm text-muted-foreground">Last Sync</p>
                      <p>{formatRelativeTime(tenant.syncStatus.lastSyncAt)}</p>
                    </div>
                  )}
                  {tenant.syncStatus.pendingCount > 0 && (
                    <div>
                      <p className="text-sm text-muted-foreground">Pending Operations</p>
                      <p>{tenant.syncStatus.pendingCount}</p>
                    </div>
                  )}
                  {tenant.syncStatus.errors && tenant.syncStatus.errors.length > 0 && (
                    <div>
                      <p className="text-sm text-muted-foreground">Recent Errors</p>
                      <div className="mt-2 space-y-2 max-h-40 overflow-y-auto">
                        {tenant.syncStatus.errors.map((error) => {
                          const message = typeof error === 'string' ? error : error.message
                          const key =
                            typeof error === 'string'
                              ? error
                              : `${error.timestamp}-${error.message}`
                          return (
                            <div
                              key={key}
                              className="rounded bg-destructive/10 p-2 text-xs font-mono text-destructive"
                            >
                              {message}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}
                  <div className="pt-4 flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleSync('both')}
                      disabled={triggerSync.isPending}
                    >
                      {triggerSync.isPending ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <RefreshCw className="mr-2 h-4 w-4" />
                      )}
                      Sync Now
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleSync('upload')}
                      disabled={triggerSync.isPending}
                    >
                      Upload
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleSync('download')}
                      disabled={triggerSync.isPending}
                    >
                      Download
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="text-center py-8 text-muted-foreground">
                  <Cloud className="mx-auto h-12 w-12 mb-4 opacity-50" />
                  <p>No sync status available</p>
                  {tenant.containerId && (
                    <Button
                      className="mt-4"
                      variant="outline"
                      size="sm"
                      onClick={() => handleSync('both')}
                      disabled={triggerSync.isPending}
                    >
                      <RefreshCw className="mr-2 h-4 w-4" />
                      Trigger Sync
                    </Button>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Sync History */}
        {syncHistory && syncHistory.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Sync History</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {syncHistory.map((job) => (
                  <div
                    key={job.id}
                    className="flex items-center justify-between py-2 border-b last:border-0"
                  >
                    <div className="flex items-center gap-3">
                      <SyncStatusBadge state={job.status} />
                      <span className="text-sm text-muted-foreground">
                        {job.direction ?? 'sync'}
                      </span>
                    </div>
                    <div className="text-right text-sm">
                      {job.completedAt && (
                        <span className="text-muted-foreground">
                          {formatRelativeTime(job.completedAt)}
                        </span>
                      )}
                      {job.bytesTransferred != null && (
                        <span className="ml-2">{(job.bytesTransferred / 1024).toFixed(1)} KB</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </Layout>
  )
}
