/**
 * Allocates /30 subnets from 10.89.0.0/16 for per-container network isolation.
 *
 * Pool: 10.89.0.0/16 → 16,384 subnets of /30 (4 addresses each).
 *
 * Layout for subnet index N:
 *   Network:   10.89.X.Y/30   where X = floor(N / 64), Y = (N % 64) * 4
 *   Gateway:   10.89.X.(Y+1)  — assigned to the bridge interface
 *   Container: 10.89.X.(Y+2)  — container IP
 *   Broadcast: 10.89.X.(Y+3)
 *
 * Example:
 *   N=0  → 10.89.0.0/30   (gateway 10.89.0.1)
 *   N=1  → 10.89.0.4/30   (gateway 10.89.0.5)
 *   N=63 → 10.89.0.252/30 (gateway 10.89.0.253)
 *   N=64 → 10.89.1.0/30   (gateway 10.89.1.1)
 */
export class SubnetAllocator {
	/** CIDR covering all boilerhouse container IPs — used in nftables rules. */
	static readonly BASE_CIDR = "10.89.0.0/16";

	/** Maximum number of concurrently allocated subnets. */
	static readonly POOL_SIZE = 16_384;

	private readonly used = new Map<string, number>(); // instanceId → index
	private readonly freed: number[] = []; // reusable indices (freed subnets)
	private nextIndex = 0;

	/**
	 * Allocate a /30 subnet for instanceId.
	 * Returns the CIDR string, e.g. `"10.89.0.0/30"`.
	 * Idempotent: returns the same subnet if already allocated for this id.
	 * Throws if the pool is exhausted.
	 */
	allocate(instanceId: string): string {
		const existing = this.used.get(instanceId);
		if (existing !== undefined) {
			return this.indexToSubnet(existing);
		}

		let index: number;
		if (this.freed.length > 0) {
			index = this.freed.pop()!;
		} else {
			if (this.nextIndex >= SubnetAllocator.POOL_SIZE) {
				throw new Error(
					"Subnet pool exhausted (max 16,384 concurrent containers)",
				);
			}
			index = this.nextIndex++;
		}

		this.used.set(instanceId, index);
		return this.indexToSubnet(index);
	}

	/**
	 * Free the subnet previously allocated for instanceId.
	 * No-op if instanceId was not allocated.
	 */
	free(instanceId: string): void {
		const index = this.used.get(instanceId);
		if (index !== undefined) {
			this.freed.push(index);
			this.used.delete(instanceId);
		}
	}

	/** Returns `true` if a subnet is currently allocated for instanceId. */
	has(instanceId: string): boolean {
		return this.used.has(instanceId);
	}

	// ── Private helpers ───────────────────────────────────────────────────────

	/** Convert a subnet index to its CIDR string. */
	private indexToSubnet(index: number): string {
		const thirdOctet = Math.floor(index / 64);
		const fourthOctet = (index % 64) * 4;
		return `10.89.${thirdOctet}.${fourthOctet}/30`;
	}
}
