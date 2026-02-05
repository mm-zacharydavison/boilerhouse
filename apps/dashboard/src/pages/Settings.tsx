import { Layout } from '@/components/layout'
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui'
import { Save } from 'lucide-react'

export function SettingsPage() {
  return (
    <Layout title="Settings">
      <div className="space-y-6 max-w-2xl">
        <Card>
          <CardHeader>
            <CardTitle>API Configuration</CardTitle>
            <CardDescription>Configure the API server connection</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label htmlFor="api-url" className="text-sm font-medium">
                API URL
              </label>
              <input
                id="api-url"
                type="text"
                className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
                defaultValue="http://localhost:3000"
                disabled
              />
              <p className="mt-1 text-xs text-muted-foreground">
                API URL is configured at build time via proxy
              </p>
            </div>
            <div>
              <label htmlFor="ws-url" className="text-sm font-medium">
                WebSocket URL
              </label>
              <input
                id="ws-url"
                type="text"
                className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
                defaultValue="ws://localhost:3000/ws"
                disabled
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Dashboard Preferences</CardTitle>
            <CardDescription>Customize dashboard behavior</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Auto-refresh</p>
                <p className="text-xs text-muted-foreground">
                  Automatically refresh data every 10 seconds
                </p>
              </div>
              <input id="auto-refresh" type="checkbox" defaultChecked className="h-4 w-4" />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Real-time updates</p>
                <p className="text-xs text-muted-foreground">
                  Enable WebSocket connection for live updates
                </p>
              </div>
              <input id="realtime" type="checkbox" defaultChecked className="h-4 w-4" />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Show notifications</p>
                <p className="text-xs text-muted-foreground">
                  Display notifications for important events
                </p>
              </div>
              <input id="notifications" type="checkbox" defaultChecked className="h-4 w-4" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Default Pool Settings</CardTitle>
            <CardDescription>Default values for new pools</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label htmlFor="min-pool-size" className="text-sm font-medium">
                  Min Pool Size
                </label>
                <input
                  id="min-pool-size"
                  type="number"
                  className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
                  defaultValue={5}
                />
              </div>
              <div>
                <label htmlFor="max-pool-size" className="text-sm font-medium">
                  Max Pool Size
                </label>
                <input
                  id="max-pool-size"
                  type="number"
                  className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
                  defaultValue={50}
                />
              </div>
            </div>
            <div>
              <label htmlFor="idle-timeout" className="text-sm font-medium">
                Idle Timeout (seconds)
              </label>
              <input
                id="idle-timeout"
                type="number"
                className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
                defaultValue={300}
              />
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-end">
          <Button>
            <Save className="mr-2 h-4 w-4" />
            Save Settings
          </Button>
        </div>
      </div>
    </Layout>
  )
}
