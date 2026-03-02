import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Thrown when an archive's HMAC does not match the expected value.
 */
export class ArchiveIntegrityError extends Error {
	constructor(message = "Archive HMAC verification failed") {
		super(message);
		this.name = "ArchiveIntegrityError";
	}
}

/**
 * Computes an HMAC-SHA256 of the given data using a hex-encoded key.
 * @returns Hex-encoded HMAC string.
 */
export function computeArchiveHmac(data: Buffer, hexKey: string): string {
	return createHmac("sha256", Buffer.from(hexKey, "hex"))
		.update(data)
		.digest("hex");
}

/**
 * Verifies an archive's HMAC against an expected value using
 * timing-safe comparison.
 *
 * @throws {ArchiveIntegrityError} if the HMAC does not match.
 */
export function verifyArchiveHmac(
	data: Buffer,
	hexKey: string,
	expectedHmac: string,
): void {
	const actual = computeArchiveHmac(data, hexKey);
	const actualBuf = Buffer.from(actual, "hex");
	const expectedBuf = Buffer.from(expectedHmac, "hex");

	if (
		actualBuf.length !== expectedBuf.length ||
		!timingSafeEqual(actualBuf, expectedBuf)
	) {
		throw new ArchiveIntegrityError();
	}
}
