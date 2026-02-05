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
import { mockActivity, mockPools, mockStats } from '@/mocks/data'
import {
  Activity,
  AlertTriangle,
  Box,
  CheckCircle,
  Cloud,
  HardDrive,
  Users,
  XCircle,
} from 'lucide-react'
import { Link } from 'react-router-dom'

function StatCard({
  title,
  value,
  subtitle,
  icon: Icon,
  trend,
}: {
  title: string
  value: string | number
  subtitle?: string
  icon: React.ComponentType<{ className?: string }>
  trend?: 'up' | 'down' | 'neutral'
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        {subtitle && (
          <p
            className={`text-xs ${trend === 'up' ? 'text-green-500' : trend === 'down' ? 'text-red-500' : 'text-muted-foreground'}`}
          >
            {subtitle}
          </p>
        )}
      </CardContent>
    </Card>
  )
}

function PoolStatusBadge({ status }: { status: 'healthy' | 'degraded' | 'error' }) {
  switch (status) {
    case 'healthy':
      return (
        <Badge variant="success">
          <CheckCircle className="mr-1 h-3 w-3" /> Healthy
        </Badge>
      )
    case 'degraded':
      return (
        <Badge variant="warning">
          <AlertTriangle className="mr-1 h-3 w-3" /> Degraded
        </Badge>
      )
    case 'error':
      return (
        <Badge variant="destructive">
          <XCircle className="mr-1 h-3 w-3" /> Error
        </Badge>
      )
  }
}

function ActivityIcon({ type }: { type: string }) {
  switch (type) {
    case 'container.created':
    case 'container.claimed':
      return <HardDrive className="h-4 w-4 text-green-500" />
    case 'container.released':
    case 'container.destroyed':
      return <HardDrive className="h-4 w-4 text-muted-foreground" />
    case 'container.unhealthy':
      return <AlertTriangle className="h-4 w-4 text-red-500" />
    case 'sync.started':
    case 'sync.completed':
      return <Cloud className="h-4 w-4 text-blue-500" />
    case 'sync.failed':
      return <Cloud className="h-4 w-4 text-red-500" />
    case 'pool.scaled':
      return <Box className="h-4 w-4 text-purple-500" />
    default:
      return <Activity className="h-4 w-4 text-muted-foreground" />
  }
}

export function DashboardPage() {
  const stats = mockStats
  const pools = mockPools
  const activity = mockActivity

  return (
    <Layout title="Dashboard">
      <div className="space-y-6">
        {/* Stats Grid */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <StatCard title="Total Pools" value={stats.totalPools} icon={Box} />
          <StatCard
            title="Containers"
            value={`${stats.activeContainers} / ${stats.totalContainers}`}
            subtitle={`${Math.round((stats.activeContainers / stats.totalContainers) * 100)}% utilized`}
            icon={HardDrive}
          />
          <StatCard title="Active Tenants" value={stats.totalTenants} icon={Users} />
          <StatCard
            title="Sync Status"
            value={stats.syncStatus.healthy}
            subtitle={
              stats.syncStatus.warning > 0 || stats.syncStatus.error > 0
                ? `${stats.syncStatus.warning} warnings, ${stats.syncStatus.error} errors`
                : 'All healthy'
            }
            icon={Cloud}
            trend={
              stats.syncStatus.error > 0 ? 'down' : stats.syncStatus.warning > 0 ? 'neutral' : 'up'
            }
          />
        </div>

        {/* Pool Status Table */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Pool Status</CardTitle>
            <Link to="/pools" className="text-sm text-primary hover:underline">
              View all
            </Link>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Pool</TableHead>
                  <TableHead>Workload</TableHead>
                  <TableHead>Containers</TableHead>
                  <TableHead>Claimed</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pools.map((pool) => (
                  <TableRow key={pool.id}>
                    <TableCell className="font-medium">
                      <Link to={`/pools/${pool.id}`} className="hover:underline">
                        {pool.id}
                      </Link>
                    </TableCell>
                    <TableCell>{pool.workloadName}</TableCell>
                    <TableCell>
                      {pool.currentSize} / {pool.maxSize}
                    </TableCell>
                    <TableCell>{pool.claimedCount}</TableCell>
                    <TableCell>
                      <PoolStatusBadge status={pool.status} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* Recent Activity */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Recent Activity</CardTitle>
            <Link to="/activity" className="text-sm text-primary hover:underline">
              View all
            </Link>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {activity.slice(0, 5).map((event) => (
                <div key={event.id} className="flex items-start gap-3">
                  <div className="mt-0.5">
                    <ActivityIcon type={event.type} />
                  </div>
                  <div className="flex-1 space-y-1">
                    <p className="text-sm">{event.message}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatRelativeTime(event.timestamp)}
                    </p>
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
