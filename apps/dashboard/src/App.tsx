import { Route, Routes } from 'react-router-dom'
import { ActivityPage } from './pages/Activity'
import { ContainersPage } from './pages/Containers'
import { DashboardPage } from './pages/Dashboard'
import { PoolDetailPage } from './pages/PoolDetail'
import { PoolsPage } from './pages/Pools'
import { SettingsPage } from './pages/Settings'
import { SyncPage } from './pages/Sync'
import { TenantDetailPage } from './pages/TenantDetail'
import { TenantsPage } from './pages/Tenants'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<DashboardPage />} />
      <Route path="/pools" element={<PoolsPage />} />
      <Route path="/pools/:poolId" element={<PoolDetailPage />} />
      <Route path="/containers" element={<ContainersPage />} />
      <Route path="/tenants" element={<TenantsPage />} />
      <Route path="/tenants/:tenantId" element={<TenantDetailPage />} />
      <Route path="/sync" element={<SyncPage />} />
      <Route path="/activity" element={<ActivityPage />} />
      <Route path="/settings" element={<SettingsPage />} />
    </Routes>
  )
}
