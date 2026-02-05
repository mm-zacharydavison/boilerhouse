import { cn } from '@/lib/utils'
import { Activity, Box, Cloud, HardDrive, LayoutDashboard, Settings, Users } from 'lucide-react'
import { NavLink } from 'react-router-dom'

const navigation = [
  { name: 'Dashboard', href: '/', icon: LayoutDashboard },
  { name: 'Pools', href: '/pools', icon: Box },
  { name: 'Containers', href: '/containers', icon: HardDrive },
  { name: 'Tenants', href: '/tenants', icon: Users },
  { name: 'Sync', href: '/sync', icon: Cloud },
  { name: 'Activity', href: '/activity', icon: Activity },
  { name: 'Settings', href: '/settings', icon: Settings },
]

export function Sidebar() {
  return (
    <div className="flex h-full w-64 flex-col border-r bg-card">
      <div className="flex h-16 items-center border-b px-6">
        <div className="flex items-center gap-2">
          <img src="/boilerhouse.svg" alt="Boilerhouse" className="h-8 w-8" />
          <span className="text-lg font-semibold">Boilerhouse</span>
        </div>
      </div>
      <nav className="flex-1 space-y-1 p-4">
        {navigation.map((item) => (
          <NavLink
            key={item.name}
            to={item.href}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-secondary text-secondary-foreground'
                  : 'text-muted-foreground hover:bg-secondary hover:text-secondary-foreground',
              )
            }
          >
            <item.icon className="h-4 w-4" />
            {item.name}
          </NavLink>
        ))}
      </nav>
      <div className="border-t p-4">
        <div className="flex items-center gap-3 rounded-lg bg-secondary/50 px-3 py-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-green-500">
            <span className="text-xs font-medium text-white">OK</span>
          </div>
          <div className="flex-1 text-sm">
            <div className="font-medium">API Connected</div>
            <div className="text-xs text-muted-foreground">localhost:3000</div>
          </div>
        </div>
      </div>
    </div>
  )
}
