import { Layout } from '@/components/layout'
import {
  Badge,
  Button,
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
import { usePools } from '@/hooks/useApi'
import { mockPools } from '@/mocks/data'
import { AlertTriangle, CheckCircle, Loader2, Plus, XCircle } from 'lucide-react'
import { Link } from 'react-router-dom'

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

function UtilizationBar({ current, max }: { current: number; max: number }) {
  const percentage = Math.round((current / max) * 100)
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 w-24 overflow-hidden rounded-full bg-secondary">
        <div
          className={`h-full transition-all ${percentage > 90 ? 'bg-red-500' : percentage > 70 ? 'bg-yellow-500' : 'bg-green-500'}`}
          style={{ width: `${percentage}%` }}
        />
      </div>
      <span className="text-sm text-muted-foreground">{percentage}%</span>
    </div>
  )
}

export function PoolsPage() {
  const { data: poolsData, isLoading } = usePools()
  const pools = poolsData ?? mockPools

  if (isLoading && !poolsData) {
    return (
      <Layout title="Pools">
        <div className="flex items-center justify-center h-64">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </Layout>
    )
  }

  return (
    <Layout title="Pools">
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <p className="text-muted-foreground">Manage container pools and their workloads</p>
          <Button>
            <Plus className="mr-2 h-4 w-4" />
            New Pool
          </Button>
        </div>

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {pools.map((pool) => (
            <Card key={pool.id}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-base font-medium">
                  <Link to={`/pools/${pool.id}`} className="hover:underline">
                    {pool.id}
                  </Link>
                </CardTitle>
                <PoolStatusBadge status={pool.status} />
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  <div>
                    <p className="text-sm font-medium">{pool.workloadName}</p>
                    <p className="text-xs text-muted-foreground">{pool.image}</p>
                  </div>
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <p className="text-muted-foreground">Containers</p>
                      <p className="font-medium">
                        {pool.currentSize} / {pool.maxSize}
                      </p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Claimed</p>
                      <p className="font-medium">{pool.claimedCount}</p>
                    </div>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Utilization</p>
                    <UtilizationBar current={pool.claimedCount} max={pool.currentSize} />
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        <Card>
          <CardHeader>
            <CardTitle>All Pools</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Pool ID</TableHead>
                  <TableHead>Workload</TableHead>
                  <TableHead>Image</TableHead>
                  <TableHead>Min/Max</TableHead>
                  <TableHead>Current</TableHead>
                  <TableHead>Claimed</TableHead>
                  <TableHead>Idle</TableHead>
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
                    <TableCell className="text-xs text-muted-foreground max-w-48 truncate">
                      {pool.image}
                    </TableCell>
                    <TableCell>
                      {pool.minSize} / {pool.maxSize}
                    </TableCell>
                    <TableCell>{pool.currentSize}</TableCell>
                    <TableCell>{pool.claimedCount}</TableCell>
                    <TableCell>{pool.idleCount}</TableCell>
                    <TableCell>
                      <PoolStatusBadge status={pool.status} />
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
