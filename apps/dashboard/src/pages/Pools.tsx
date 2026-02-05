import { Layout } from '@/components/layout'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui'
import { useCreatePool, usePools, useWorkloads } from '@/hooks/useApi'
import { mockPools } from '@/mocks/data'
import { AlertTriangle, CheckCircle, Loader2, Plus, XCircle } from 'lucide-react'
import { useState } from 'react'
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
  const { data: workloads } = useWorkloads()
  const createPool = useCreatePool()
  const pools = poolsData ?? mockPools

  const [dialogOpen, setDialogOpen] = useState(false)
  const [newPoolId, setNewPoolId] = useState('')
  const [selectedWorkload, setSelectedWorkload] = useState('')
  const [minSize, setMinSize] = useState('2')
  const [maxSize, setMaxSize] = useState('10')

  const handleCreatePool = async () => {
    if (!newPoolId || !selectedWorkload) return
    try {
      await createPool.mutateAsync({
        poolId: newPoolId,
        workloadId: selectedWorkload,
        minSize: Number.parseInt(minSize, 10),
        maxSize: Number.parseInt(maxSize, 10),
      })
      setDialogOpen(false)
      setNewPoolId('')
      setSelectedWorkload('')
      setMinSize('2')
      setMaxSize('10')
    } catch (err) {
      console.error('Failed to create pool:', err)
    }
  }

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
          <Button onClick={() => setDialogOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            New Pool
          </Button>
        </div>

        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogHeader>
            <DialogTitle>Create New Pool</DialogTitle>
            <DialogDescription>
              Create a new container pool from an available workload.
            </DialogDescription>
          </DialogHeader>
          <DialogContent>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="poolId">Pool ID</Label>
                <Input
                  id="poolId"
                  placeholder="my-pool"
                  value={newPoolId}
                  onChange={(e) => setNewPoolId(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="workload">Workload</Label>
                <Select
                  id="workload"
                  value={selectedWorkload}
                  onChange={(e) => setSelectedWorkload(e.target.value)}
                >
                  <option value="">Select a workload...</option>
                  {workloads?.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name} ({w.image})
                    </option>
                  ))}
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="minSize">Min Size</Label>
                  <Input
                    id="minSize"
                    type="number"
                    min="0"
                    value={minSize}
                    onChange={(e) => setMinSize(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="maxSize">Max Size</Label>
                  <Input
                    id="maxSize"
                    type="number"
                    min="1"
                    value={maxSize}
                    onChange={(e) => setMaxSize(e.target.value)}
                  />
                </div>
              </div>
            </div>
          </DialogContent>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleCreatePool}
              disabled={!newPoolId || !selectedWorkload || createPool.isPending}
            >
              {createPool.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Create Pool
            </Button>
          </DialogFooter>
        </Dialog>

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
