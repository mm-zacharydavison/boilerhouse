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
import {
  queryKeys,
  useContainers,
  useDestroyContainer,
  usePool,
  useScalePool,
} from '@/hooks/useApi'
import { formatRelativeTime } from '@/lib/utils'
import type { PoolId } from '@boilerhouse/core'
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ArrowLeft, Loader2, Minus, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { Link, useParams } from 'react-router-dom'

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

export function PoolDetailPage() {
  const { poolId } = useParams<{ poolId: string }>()
  const queryClient = useQueryClient()
  const { data: pool, isLoading: poolLoading, error: poolError } = usePool(poolId as PoolId)
  const { data: containers = [] } = useContainers(poolId as PoolId)
  const scalePool = useScalePool()
  const destroyContainer = useDestroyContainer()

  const handleRefresh = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.pool(poolId as PoolId) })
    queryClient.invalidateQueries({ queryKey: queryKeys.containers(poolId as PoolId) })
  }

  const handleScaleUp = () => {
    if (pool && pool.currentSize < pool.maxSize) {
      scalePool.mutate({ poolId: poolId as PoolId, targetSize: pool.currentSize + 1 })
    }
  }

  const handleScaleDown = () => {
    if (pool && pool.currentSize > pool.minSize) {
      scalePool.mutate({ poolId: poolId as PoolId, targetSize: pool.currentSize - 1 })
    }
  }

  const handleDeleteContainer = (containerId: string) => {
    if (confirm('Are you sure you want to delete this container?')) {
      destroyContainer.mutate(containerId)
    }
  }

  if (poolLoading) {
    return (
      <Layout title="Loading...">
        <div className="flex items-center justify-center h-64">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </Layout>
    )
  }

  if (poolError || !pool) {
    return (
      <Layout title="Pool Not Found">
        <div className="flex flex-col items-center justify-center py-12">
          <p className="text-muted-foreground">Pool "{poolId}" not found</p>
          <Link to="/pools" className="mt-4 text-primary hover:underline">
            Back to pools
          </Link>
        </div>
      </Layout>
    )
  }

  return (
    <Layout title={`Pool: ${pool.id}`}>
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Link to="/pools">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div className="flex-1">
            <h2 className="text-2xl font-bold">{pool.id}</h2>
            <p className="text-muted-foreground">{pool.workloadName}</p>
          </div>
          <Button variant="outline" onClick={handleRefresh}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        </div>

        {/* Error Alert */}
        {pool.lastError && (
          <Card className="border-destructive bg-destructive/10">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-destructive">
                <AlertTriangle className="h-5 w-5" />
                Pool Error
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="font-mono text-sm">{pool.lastError.message}</p>
              <p className="mt-2 text-xs text-muted-foreground">
                Occurred at: {new Date(pool.lastError.timestamp).toLocaleString()}
              </p>
            </CardContent>
          </Card>
        )}

        {/* Pool Stats */}
        <div className="grid gap-4 md:grid-cols-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Current Size</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{pool.currentSize}</div>
              <p className="text-xs text-muted-foreground">
                Min: {pool.minSize} / Max: {pool.maxSize}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Claimed</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{pool.claimedCount}</div>
              <p className="text-xs text-muted-foreground">
                {Math.round((pool.claimedCount / pool.currentSize) * 100)}% utilization
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Idle</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{pool.idleCount}</div>
              <p className="text-xs text-muted-foreground">Available for assignment</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Image</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm font-mono truncate" title={pool.image}>
                {pool.image}
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Scaling Controls */}
        <Card>
          <CardHeader>
            <CardTitle>Scaling</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-4">
              <span className="text-sm text-muted-foreground">
                Current size: {pool.currentSize}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="icon"
                  disabled={pool.currentSize <= pool.minSize || scalePool.isPending}
                  onClick={handleScaleDown}
                >
                  <Minus className="h-4 w-4" />
                </Button>
                <span className="w-12 text-center font-medium">{pool.currentSize}</span>
                <Button
                  variant="outline"
                  size="icon"
                  disabled={pool.currentSize >= pool.maxSize || scalePool.isPending}
                  onClick={handleScaleUp}
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
              <span className="text-xs text-muted-foreground">
                (min: {pool.minSize}, max: {pool.maxSize})
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Container List */}
        <Card>
          <CardHeader>
            <CardTitle>Containers</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Container ID</TableHead>
                  <TableHead>Tenant</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>CPU</TableHead>
                  <TableHead>Memory</TableHead>
                  <TableHead>Last Activity</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {containers.map((container) => (
                  <TableRow key={container.id}>
                    <TableCell className="font-mono text-sm">{container.id}</TableCell>
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
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-destructive hover:text-destructive"
                        disabled={container.status === 'assigned' || destroyContainer.isPending}
                        onClick={() => handleDeleteContainer(container.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {containers.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-muted-foreground">
                      No containers in this pool
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </Layout>
  )
}
