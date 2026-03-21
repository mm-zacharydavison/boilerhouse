import {
	createCipheriv,
	createDecipheriv,
	randomBytes,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/**
 * Header prepended to every encrypted archive so we can detect encrypted
 * files and evolve the format later.
 *
 * Layout (32 bytes total):
 *   [8]  magic   "BHCRYPT\0"
 *   [1]  version  0x01
 *   [1]  algo     0x01 = AES-256-GCM
 *   [2]  reserved (zero)
 *   [12] IV
 *   [4]  reserved (zero, pad to 28→32)
 *
 * Followed by: [ciphertext][16-byte GCM auth tag]
 */
const MAGIC = Buffer.from("BHCRYPT\0");
const FORMAT_VERSION = 0x01;
const ALGO_AES_256_GCM = 0x01;
const HEADER_LENGTH = 32;

/**
 * Thrown when decryption fails (bad key, tampered data, wrong format).
 */
export class ArchiveDecryptionError extends Error {
	constructor(message = "Archive decryption failed") {
		super(message);
		this.name = "ArchiveDecryptionError";
	}
}

/**
 * Encrypts an archive buffer using AES-256-GCM.
 *
 * @param data - Plaintext archive data.
 * @param hexKey - Hex-encoded 32-byte encryption key.
 * @returns Encrypted buffer with header, ciphertext, and GCM auth tag.
 */
export function encryptArchive(data: Buffer, hexKey: string): Buffer {
	const key = Buffer.from(hexKey, "hex");
	if (key.length !== 32) {
		throw new Error(
			`Encryption key must be 32 bytes (64 hex chars), got ${key.length} bytes`,
		);
	}

	const iv = randomBytes(IV_LENGTH);
	const cipher = createCipheriv(ALGORITHM, key, iv);
	const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
	const authTag = cipher.getAuthTag();

	// Build header
	const header = Buffer.alloc(HEADER_LENGTH);
	MAGIC.copy(header, 0);
	header[8] = FORMAT_VERSION;
	header[9] = ALGO_AES_256_GCM;
	// bytes 10-11 reserved (zero)
	iv.copy(header, 12);
	// bytes 24-31 reserved (zero)

	return Buffer.concat([header, ciphertext, authTag]);
}

/**
 * Decrypts an archive buffer that was encrypted with {@link encryptArchive}.
 *
 * @param encrypted - Encrypted buffer (header + ciphertext + auth tag).
 * @param hexKey - Hex-encoded 32-byte encryption key.
 * @returns Decrypted plaintext buffer.
 * @throws {ArchiveDecryptionError} on bad format, wrong key, or tampered data.
 */
export function decryptArchive(encrypted: Buffer, hexKey: string): Buffer {
	const key = Buffer.from(hexKey, "hex");
	if (key.length !== 32) {
		throw new Error(
			`Encryption key must be 32 bytes (64 hex chars), got ${key.length} bytes`,
		);
	}

	if (encrypted.length < HEADER_LENGTH + AUTH_TAG_LENGTH) {
		throw new ArchiveDecryptionError("Data too short to be an encrypted archive");
	}

	// Validate magic
	if (!encrypted.subarray(0, MAGIC.length).equals(MAGIC)) {
		throw new ArchiveDecryptionError("Not an encrypted archive (bad magic)");
	}

	const version = encrypted[8];
	if (version !== FORMAT_VERSION) {
		throw new ArchiveDecryptionError(`Unsupported format version: ${version}`);
	}

	const algo = encrypted[9];
	if (algo !== ALGO_AES_256_GCM) {
		throw new ArchiveDecryptionError(`Unsupported algorithm: ${algo}`);
	}

	const iv = encrypted.subarray(12, 12 + IV_LENGTH);
	const authTag = encrypted.subarray(encrypted.length - AUTH_TAG_LENGTH);
	const ciphertext = encrypted.subarray(HEADER_LENGTH, encrypted.length - AUTH_TAG_LENGTH);

	try {
		const decipher = createDecipheriv(ALGORITHM, key, iv);
		decipher.setAuthTag(authTag);
		return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
	} catch {
		throw new ArchiveDecryptionError();
	}
}

/**
 * Returns `true` if the buffer starts with the encrypted archive magic bytes.
 */
export function isEncryptedArchive(data: Buffer): boolean {
	return data.length >= MAGIC.length && data.subarray(0, MAGIC.length).equals(MAGIC);
}
