import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3'

export interface MinioConfig {
  endpoint: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
}

const DEFAULT_CONFIG: MinioConfig = {
  endpoint: process.env.MINIO_ENDPOINT ?? 'http://localhost:9000',
  accessKeyId: process.env.MINIO_ACCESS_KEY ?? 'minioadmin',
  secretAccessKey: process.env.MINIO_SECRET_KEY ?? 'minioadmin',
  bucket: process.env.MINIO_BUCKET ?? 'boilerhouse',
}

export interface TenantFile {
  key: string
  relativePath: string
  size: number
  lastModified?: Date
}

export interface IsolationResult {
  tenantA: { fileCount: number; files: string[] }
  tenantB: { fileCount: number; files: string[] }
  isolated: boolean
  crossContamination: string[]
}

export function createMinioClient(config: Partial<MinioConfig> = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config }

  const client = new S3Client({
    endpoint: cfg.endpoint,
    region: 'us-east-1',
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
    forcePathStyle: true,
  })

  return {
    /**
     * List all files synced for a tenant
     */
    async listTenantFiles(tenantId: string): Promise<TenantFile[]> {
      const prefix = `tenants/${tenantId}/`
      const command = new ListObjectsV2Command({
        Bucket: cfg.bucket,
        Prefix: prefix,
      })

      const response = await client.send(command)
      return (response.Contents ?? [])
        .filter((obj): obj is typeof obj & { Key: string } => obj.Key !== undefined)
        .map((obj) => ({
          key: obj.Key,
          relativePath: obj.Key.replace(prefix, ''),
          size: obj.Size ?? 0,
          lastModified: obj.LastModified,
        }))
    },

    /**
     * Get the content of a synced file
     */
    async getFile(tenantId: string, relativePath: string): Promise<string> {
      const key = `tenants/${tenantId}/${relativePath}`
      const command = new GetObjectCommand({
        Bucket: cfg.bucket,
        Key: key,
      })

      const response = await client.send(command)
      return (await response.Body?.transformToString()) ?? ''
    },

    /**
     * Delete all files for a tenant (for testing cleanup)
     */
    async deleteTenantFiles(tenantId: string): Promise<number> {
      const files = await this.listTenantFiles(tenantId)
      let deleted = 0

      for (const file of files) {
        const command = new DeleteObjectCommand({
          Bucket: cfg.bucket,
          Key: file.key,
        })
        await client.send(command)
        deleted++
      }

      return deleted
    },

    /**
     * Verify tenant isolation - check that tenant A cannot see tenant B's files
     */
    async verifyIsolation(tenantA: string, tenantB: string): Promise<IsolationResult> {
      const filesA = await this.listTenantFiles(tenantA)
      const filesB = await this.listTenantFiles(tenantB)

      // Check for any cross-contamination
      const aKeysInB = filesA.filter((f) =>
        filesB.some((b) => b.relativePath === f.relativePath && b.key !== f.key),
      )

      return {
        tenantA: { fileCount: filesA.length, files: filesA.map((f) => f.relativePath) },
        tenantB: { fileCount: filesB.length, files: filesB.map((f) => f.relativePath) },
        isolated: aKeysInB.length === 0,
        crossContamination: aKeysInB.map((f) => f.relativePath),
      }
    },
  }
}
