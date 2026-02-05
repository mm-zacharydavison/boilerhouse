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
import { formatRelativeTime } from '@/lib/utils'
import { mockContainers } from '@/mocks/data'
import { Link } from 'react-router-dom'

function ContainerStatusBadge({ status }: { status: string }) {
  switch (status) {
    case 'idle':
      return <Badge variant="secondary">Idle</Badge>
    case 'assigned':
      return <Badge variant="success">Assigned</Badge>
    case 'stopping':
      return <Badge variant="warning">Stopping</Badge>
    default:
      return <Badge variant="outline">{status}</Badge>
  }
}

export function ContainersPage() {
  const containers = mockContainers

  const idleCount = containers.filter((c) => c.status === 'idle').length
  const assignedCount = containers.filter((c) => c.status === 'assigned').length

  return (
    <Layout title="Containers">
      <div className="space-y-6">
        <div className="grid gap-4 md:grid-cols-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Total</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{containers.length}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Assigned</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-600">{assignedCount}</div>
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
            <CardTitle>All Containers</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Container ID</TableHead>
                  <TableHead>Pool</TableHead>
                  <TableHead>Tenant</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Workload</TableHead>
                  <TableHead>CPU</TableHead>
                  <TableHead>Memory</TableHead>
                  <TableHead>Last Activity</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {containers.map((container) => (
                  <TableRow key={container.id}>
                    <TableCell className="font-mono text-sm">{container.id}</TableCell>
                    <TableCell>
                      <Link to={`/pools/${container.poolId}`} className="hover:underline">
                        {container.poolId}
                      </Link>
                    </TableCell>
                    <TableCell>
                      {container.tenantId ? (
                        <Link to={`/tenants/${container.tenantId}`} className="hover:underline">
                          {container.tenantId}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <ContainerStatusBadge status={container.status} />
                    </TableCell>
                    <TableCell>{container.workloadName}</TableCell>
                    <TableCell>
                      {container.cpuUsagePercent !== undefined
                        ? `${container.cpuUsagePercent}%`
                        : '-'}
                    </TableCell>
                    <TableCell>
                      {container.memoryUsageMb !== undefined
                        ? `${container.memoryUsageMb} MB`
                        : '-'}
                    </TableCell>
                    <TableCell>{formatRelativeTime(container.lastActivityAt)}</TableCell>
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
