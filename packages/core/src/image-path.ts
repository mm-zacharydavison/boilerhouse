import { join } from "node:path";
import type { Workload } from "./workload";

/**
 * Resolves the rootfs storage path for a workload's image.
 *
 * - `image.ref = "alpine/openclaw:main"` → `<imagesDir>/alpine/openclaw/main/rootfs.ext4`
 * - `image.dockerfile` on workload `{name: "foo", version: "1.0"}` → `<imagesDir>/_builds/foo/1.0/rootfs.ext4`
 *
 * @throws {Error} if neither `image.ref` nor `image.dockerfile` is set
 */
export function resolveImagePath(imagesDir: string, workload: Workload): string {
	if (workload.image.ref) {
		const refPath = workload.image.ref.replace(/:/g, "/");
		return join(imagesDir, refPath, "rootfs.ext4");
	}

	if (workload.image.dockerfile) {
		return join(imagesDir, "_builds", workload.workload.name, workload.workload.version, "rootfs.ext4");
	}

	throw new Error("Workload must specify either image.ref or image.dockerfile");
}
