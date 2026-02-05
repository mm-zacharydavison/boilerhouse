export interface ClaimResult {
  containerId: string
  endpoints: {
    http: string
    port: number
  }
}

export interface TenantStatus {
  status: 'cold' | 'warm' | 'provisioning'
  containerId?: string
  poolId?: string
  port?: number
  endpoints?: {
    http: string
  }
  lastActivity?: string
  syncStatus?: {
    lastSync?: string
    state: 'idle' | 'syncing' | 'error'
    error?: string
  }
}

export interface SyncResult {
  success: boolean
  results: Array<{
    success: boolean
    bytesTransferred?: number
    filesTransferred?: number
    errors?: string[]
  }>
}

export interface ReleaseOptions {
  sync?: boolean
}

export interface BoilerhouseClient {
  claim(tenantId: string, poolId: string): Promise<ClaimResult>
  release(tenantId: string, options?: ReleaseOptions): Promise<void>
  status(tenantId: string): Promise<TenantStatus>
  sync(tenantId: string, direction?: 'upload' | 'download' | 'both'): Promise<SyncResult>
}

export function createClient(baseUrl: string): BoilerhouseClient {
  const api = baseUrl.replace(/\/$/, '')

  return {
    async claim(tenantId, poolId) {
      const res = await fetch(`${api}/api/v1/tenants/${tenantId}/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ poolId }),
      })
      if (!res.ok) throw new Error(`Claim failed: ${await res.text()}`)
      return res.json() as Promise<ClaimResult>
    },

    async release(tenantId, options = {}) {
      const res = await fetch(`${api}/api/v1/tenants/${tenantId}/release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sync: options.sync ?? true }),
      })
      if (!res.ok) throw new Error(`Release failed: ${await res.text()}`)
    },

    async status(tenantId) {
      const res = await fetch(`${api}/api/v1/tenants/${tenantId}/status`)
      if (!res.ok) throw new Error(`Status failed: ${await res.text()}`)
      return res.json() as Promise<TenantStatus>
    },

    async sync(tenantId, direction = 'both') {
      const res = await fetch(`${api}/api/v1/tenants/${tenantId}/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction }),
      })
      if (!res.ok) throw new Error(`Sync failed: ${await res.text()}`)
      return res.json() as Promise<SyncResult>
    },
  }
}
