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
import { useSyncHistory, useSyncJobs } from '@/hooks/useApi'
import { formatBytes, formatRelativeTime } from '@/lib/utils'
import { Loader2 } from 'lucide-react'
import { Link } from 'react-router-dom'

function SyncStatusBadge({ status }: { status: string }) {
  switch (status) {
    case 'pending':
      return <Badge variant="secondary">Pending</Badge>
    case 'running':
      return <Badge variant="default">Running</Badge>
    case 'completed':
      return <Badge variant="success">Completed</Badge>
    case 'failed':
      return <Badge variant="destructive">Failed</Badge>
    default:
      return <Badge variant="outline">{status}</Badge>
  }
}

function DirectionBadge({ direction }: { direction: string }) {
  switch (direction) {
    case 'upload':
      return <Badge variant="outline">Upload</Badge>
    case 'download':
      return <Badge variant="outline">Download</Badge>
    default:
      return <Badge variant="outline">{direction}</Badge>
  }
}

function ProgressBar({ progress }: { progress: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 w-20 overflow-hidden rounded-full bg-secondary">
        <div className="h-full bg-primary transition-all" style={{ width: `${progress}%` }} />
      </div>
      <span className="text-xs text-muted-foreground">{progress}%</span>
    </div>
  )
}

export function SyncPage() {
  const { data: runningJobsData, isLoading: jobsLoading } = useSyncJobs('running')
  const { data: historyData, isLoading: historyLoading } = useSyncHistory(undefined, 50)

  // Combine running jobs with history for display
  const syncJobs = [...(runningJobsData ?? []), ...(historyData ?? [])]
  const isLoading = jobsLoading || historyLoading

  const runningJobs = syncJobs.filter((j) => j.status === 'running')
  const completedJobs = syncJobs.filter((j) => j.status === 'completed')
  const failedJobs = syncJobs.filter((j) => j.status === 'failed')

  if (isLoading && syncJobs.length === 0) {
    return (
      <Layout title="Sync Monitor">
        <div className="flex items-center justify-center h-64">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </Layout>
    )
  }

  return (
    <Layout title="Sync Monitor">
      <div className="space-y-6">
        <div className="grid gap-4 md:grid-cols-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Total Jobs</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{syncJobs.length}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Running</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-blue-600">{runningJobs.length}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Completed</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-600">{completedJobs.length}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Failed</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-red-600">{failedJobs.length}</div>
            </CardContent>
          </Card>
        </div>

        {/* Active Syncs */}
        {runningJobs.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Active Syncs</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {runningJobs.map((job) => (
                  <div
                    key={job.id}
                    className="flex items-center justify-between rounded-lg border p-4"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <Link
                          to={`/tenants/${job.tenantId}`}
                          className="font-medium hover:underline"
                        >
                          {job.tenantId}
                        </Link>
                        <DirectionBadge direction={job.direction} />
                      </div>
                      <p className="text-sm text-muted-foreground">
                        Pool: {job.poolId} • Started {formatRelativeTime(job.startedAt)}
                      </p>
                    </div>
                    <div className="flex items-center gap-4">
                      {job.bytesTransferred !== undefined && (
                        <span className="text-sm text-muted-foreground">
                          {formatBytes(job.bytesTransferred)}
                        </span>
                      )}
                      {job.progress !== undefined && <ProgressBar progress={job.progress} />}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Sync History */}
        <Card>
          <CardHeader>
            <CardTitle>Sync History</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Job ID</TableHead>
                  <TableHead>Tenant</TableHead>
                  <TableHead>Pool</TableHead>
                  <TableHead>Direction</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Transferred</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Completed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {syncJobs.map((job) => (
                  <TableRow key={job.id}>
                    <TableCell className="font-mono text-sm">{job.id}</TableCell>
                    <TableCell>
                      <Link to={`/tenants/${job.tenantId}`} className="hover:underline">
                        {job.tenantId}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Link to={`/pools/${job.poolId}`} className="hover:underline">
                        {job.poolId}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <DirectionBadge direction={job.direction} />
                    </TableCell>
                    <TableCell>
                      <SyncStatusBadge status={job.status} />
                    </TableCell>
                    <TableCell>
                      {job.bytesTransferred !== undefined ? formatBytes(job.bytesTransferred) : '-'}
                    </TableCell>
                    <TableCell>{formatRelativeTime(job.startedAt)}</TableCell>
                    <TableCell>
                      {job.completedAt ? (
                        formatRelativeTime(job.completedAt)
                      ) : job.status === 'running' ? (
                        <span className="text-muted-foreground">In progress</span>
                      ) : (
                        '-'
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                {syncJobs.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center text-muted-foreground">
                      No sync history yet
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* Failed Jobs */}
        {failedJobs.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-destructive">Failed Jobs</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {failedJobs.map((job) => (
                  <div
                    key={job.id}
                    className="rounded-lg border border-destructive/50 bg-destructive/5 p-4"
                  >
                    <div className="flex items-start justify-between">
                      <div>
                        <div className="flex items-center gap-2">
                          <Link
                            to={`/tenants/${job.tenantId}`}
                            className="font-medium hover:underline"
                          >
                            {job.tenantId}
                          </Link>
                          <span className="text-sm text-muted-foreground">({job.poolId})</span>
                        </div>
                        {job.error && <p className="mt-2 text-sm text-destructive">{job.error}</p>}
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {formatRelativeTime(job.completedAt || job.startedAt)}
                      </span>
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
