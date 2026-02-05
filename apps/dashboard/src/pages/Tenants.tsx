import { Layout } from '@/components/layout'
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui'
import { useTenants } from '@/hooks/useApi'
import { formatRelativeTime } from '@/lib/utils'
import { mockTenants } from '@/mocks/data'
import { Loader2 } from 'lucide-react'
import { Link } from 'react-router-dom'

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

export function TenantsPage() {
  const { data: tenantsData, isLoading } = useTenants()
  const tenants = tenantsData ?? mockTenants

  const activeCount = tenants.filter((t) => t.status === 'active').length
  const idleCount = tenants.filter((t) => t.status === 'idle').length

  if (isLoading && !tenantsData) {
    return (
      <Layout title="Tenants">
        <div className="flex items-center justify-center h-64">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </Layout>
    )
  }

  return (
    <Layout title="Tenants">
      <div className="space-y-6">
        <div className="grid gap-4 md:grid-cols-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Total</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{tenants.length}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Active</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-600">{activeCount}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Idle</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-muted-foreground">{idleCount}</div>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>All Tenants</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tenant ID</TableHead>
                  <TableHead>Pool</TableHead>
                  <TableHead>Container</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Sync Status</TableHead>
                  <TableHead>Assigned</TableHead>
                  <TableHead>Last Activity</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tenants.map((tenant) => (
                  <TableRow key={tenant.id}>
                    <TableCell className="font-medium">
                      <Link to={`/tenants/${tenant.id}`} className="hover:underline">
                        {tenant.id}
                      </Link>
                    </TableCell>
                    <TableCell>
                      {tenant.poolId ? (
                        <Link to={`/pools/${tenant.poolId}`} className="hover:underline">
                          {tenant.poolId}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-sm">
                      {tenant.containerId || <span className="text-muted-foreground">-</span>}
                    </TableCell>
                    <TableCell>
                      <TenantStatusBadge status={tenant.status} />
                    </TableCell>
                    <TableCell>
                      {tenant.syncStatus ? (
                        <SyncStatusBadge state={tenant.syncStatus.state} />
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {tenant.assignedAt ? (
                        formatRelativeTime(tenant.assignedAt)
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {tenant.lastActivityAt ? (
                        formatRelativeTime(tenant.lastActivityAt)
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </Layout>
  )
}
