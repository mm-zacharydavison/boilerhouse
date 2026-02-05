#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { program } from 'commander'
import { createClient } from './client'
import { createMinioClient } from './minio'

const DEFAULT_API_URL = process.env.BOILERHOUSE_API_URL ?? 'http://localhost:3000'
const DEFAULT_POOL_ID = process.env.BOILERHOUSE_POOL_ID ?? 'default'

program.name('boilerhouse').description('CLI for managing Boilerhouse containers').version('0.1.0')

// ─────────────────────────────────────────────────────────────────────────────
// Core Commands
// ─────────────────────────────────────────────────────────────────────────────

program
  .command('claim <tenant-id>')
  .description('Claim a container for a tenant')
  .option('-p, --pool <pool-id>', 'Pool ID', DEFAULT_POOL_ID)
  .option('-u, --url <url>', 'Boilerhouse API URL', DEFAULT_API_URL)
  .action(async (tenantId: string, options: { pool: string; url: string }) => {
    try {
      const client = createClient(options.url)
      const result = await client.claim(tenantId, options.pool)
      console.log(JSON.stringify(result, null, 2))
    } catch (e) {
      console.error(e instanceof Error ? e.message : 'Claim failed')
      process.exit(1)
    }
  })

program
  .command('release <tenant-id>')
  .description('Release a container (syncs state first)')
  .option('-u, --url <url>', 'Boilerhouse API URL', DEFAULT_API_URL)
  .option('--no-sync', 'Skip sync on release')
  .action(async (tenantId: string, options: { url: string; sync: boolean }) => {
    try {
      const client = createClient(options.url)
      await client.release(tenantId, { sync: options.sync })
      console.log(options.sync ? 'Released (state synced)' : 'Released (sync skipped)')
    } catch (e) {
      console.error(e instanceof Error ? e.message : 'Release failed')
      process.exit(1)
    }
  })

program
  .command('status <tenant-id>')
  .description('Get tenant container status')
  .option('-u, --url <url>', 'Boilerhouse API URL', DEFAULT_API_URL)
  .action(async (tenantId: string, options: { url: string }) => {
    try {
      const client = createClient(options.url)
      const status = await client.status(tenantId)
      console.log(JSON.stringify(status, null, 2))
    } catch (e) {
      console.error(e instanceof Error ? e.message : 'Status failed')
      process.exit(1)
    }
  })

program
  .command('shell <tenant-id>')
  .description('Get interactive shell inside container')
  .option('-u, --url <url>', 'Boilerhouse API URL', DEFAULT_API_URL)
  .option('-s, --shell <shell>', 'Shell to use', '/bin/sh')
  .action(async (tenantId: string, options: { url: string; shell: string }) => {
    try {
      const client = createClient(options.url)
      const status = await client.status(tenantId)

      if (status.status !== 'warm') {
        console.error('Container not ready. Run `claim` first.')
        process.exit(1)
      }

      if (!status.containerId) {
        console.error('No container ID found')
        process.exit(1)
      }

      const dockerContainerName = `container-${status.containerId}`
      console.log(`Connecting to container ${dockerContainerName}...`)
      console.log('Type "exit" to leave the shell.\n')

      const proc = spawn('docker', ['exec', '-it', dockerContainerName, options.shell], {
        stdio: 'inherit',
      })

      proc.on('exit', (code: number | null) => {
        process.exit(code ?? 0)
      })
    } catch (e) {
      console.error(e instanceof Error ? e.message : 'Shell failed')
      process.exit(1)
    }
  })

// ─────────────────────────────────────────────────────────────────────────────
// Sync Commands (for verifying state sync with MinIO/S3)
// ─────────────────────────────────────────────────────────────────────────────

program
  .command('sync:list <tenant-id>')
  .description('List all synced files for a tenant in MinIO')
  .option('-e, --minio-endpoint <url>', 'MinIO endpoint', 'http://localhost:9000')
  .option('-b, --bucket <name>', 'MinIO bucket', 'boilerhouse')
  .action(async (tenantId: string, options: { minioEndpoint: string; bucket: string }) => {
    try {
      const minio = createMinioClient({
        endpoint: options.minioEndpoint,
        bucket: options.bucket,
      })

      const files = await minio.listTenantFiles(tenantId)

      if (files.length === 0) {
        console.log(`No files synced for tenant: ${tenantId}`)
        return
      }

      console.log(`Files synced for tenant ${tenantId}:`)
      console.log('─'.repeat(60))
      for (const file of files) {
        const size = file.size > 1024 ? `${(file.size / 1024).toFixed(1)} KB` : `${file.size} B`
        const date = file.lastModified?.toISOString() ?? 'unknown'
        console.log(`  ${file.relativePath.padEnd(40)} ${size.padStart(10)}  ${date}`)
      }
      console.log('─'.repeat(60))
      console.log(`Total: ${files.length} files`)
    } catch (e) {
      console.error(e instanceof Error ? e.message : 'List failed')
      process.exit(1)
    }
  })

program
  .command('sync:cat <tenant-id> <path>')
  .description('Display content of a synced file')
  .option('-e, --minio-endpoint <url>', 'MinIO endpoint', 'http://localhost:9000')
  .option('-b, --bucket <name>', 'MinIO bucket', 'boilerhouse')
  .action(
    async (tenantId: string, path: string, options: { minioEndpoint: string; bucket: string }) => {
      try {
        const minio = createMinioClient({
          endpoint: options.minioEndpoint,
          bucket: options.bucket,
        })

        const content = await minio.getFile(tenantId, path)
        console.log(content)
      } catch (e) {
        console.error(`File not found: tenants/${tenantId}/${path}`)
        process.exit(1)
      }
    },
  )

program
  .command('sync:verify <tenant-a> <tenant-b>')
  .description('Verify sync isolation between two tenants')
  .option('-e, --minio-endpoint <url>', 'MinIO endpoint', 'http://localhost:9000')
  .option('-b, --bucket <name>', 'MinIO bucket', 'boilerhouse')
  .action(
    async (
      tenantA: string,
      tenantB: string,
      options: { minioEndpoint: string; bucket: string },
    ) => {
      try {
        const minio = createMinioClient({
          endpoint: options.minioEndpoint,
          bucket: options.bucket,
        })

        console.log(`Verifying isolation between ${tenantA} and ${tenantB}...`)
        const result = await minio.verifyIsolation(tenantA, tenantB)

        console.log(`\nTenant ${tenantA}: ${result.tenantA.fileCount} files`)
        for (const f of result.tenantA.files) console.log(`  - ${f}`)

        console.log(`\nTenant ${tenantB}: ${result.tenantB.fileCount} files`)
        for (const f of result.tenantB.files) console.log(`  - ${f}`)

        console.log('')
        if (result.isolated) {
          console.log('✓ Tenants are properly isolated')
        } else {
          console.log('✗ ISOLATION VIOLATION DETECTED!')
          console.log('Cross-contaminated files:', result.crossContamination)
          process.exit(1)
        }
      } catch (e) {
        console.error(e instanceof Error ? e.message : 'Verify failed')
        process.exit(1)
      }
    },
  )

program
  .command('sync:clean <tenant-id>')
  .description('Delete all synced files for a tenant (for testing)')
  .option('-e, --minio-endpoint <url>', 'MinIO endpoint', 'http://localhost:9000')
  .option('-b, --bucket <name>', 'MinIO bucket', 'boilerhouse')
  .option('--force', 'Skip confirmation')
  .action(
    async (
      tenantId: string,
      options: { minioEndpoint: string; bucket: string; force: boolean },
    ) => {
      if (!options.force) {
        console.log(`This will delete all synced files for tenant: ${tenantId}`)
        console.log('Use --force to skip this confirmation')
        process.exit(1)
      }

      try {
        const minio = createMinioClient({
          endpoint: options.minioEndpoint,
          bucket: options.bucket,
        })

        const deleted = await minio.deleteTenantFiles(tenantId)
        console.log(`Deleted ${deleted} files for tenant: ${tenantId}`)
      } catch (e) {
        console.error(e instanceof Error ? e.message : 'Clean failed')
        process.exit(1)
      }
    },
  )

program.parse()
