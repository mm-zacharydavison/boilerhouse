import { describe, test, expect } from "bun:test";
import { randomBytes } from "node:crypto";
import {
	encryptArchive,
	decryptArchive,
	isEncryptedArchive,
	ArchiveDecryptionError,
} from "./archive-crypto";

const TEST_KEY = randomBytes(32).toString("hex");
const OTHER_KEY = randomBytes(32).toString("hex");
const TEST_DATA = Buffer.from("checkpoint-archive-content-with-process-memory");

describe("encryptArchive / decryptArchive", () => {
	test("round-trips data correctly", () => {
		const encrypted = encryptArchive(TEST_DATA, TEST_KEY);
		const decrypted = decryptArchive(encrypted, TEST_KEY);
		expect(decrypted).toEqual(TEST_DATA);
	});

	test("encrypted output differs from plaintext", () => {
		const encrypted = encryptArchive(TEST_DATA, TEST_KEY);
		expect(encrypted).not.toEqual(TEST_DATA);
		expect(encrypted.length).toBeGreaterThan(TEST_DATA.length);
	});

	test("each encryption produces different ciphertext (random IV)", () => {
		const a = encryptArchive(TEST_DATA, TEST_KEY);
		const b = encryptArchive(TEST_DATA, TEST_KEY);
		expect(a).not.toEqual(b);
		// But both decrypt to the same thing
		expect(decryptArchive(a, TEST_KEY)).toEqual(TEST_DATA);
		expect(decryptArchive(b, TEST_KEY)).toEqual(TEST_DATA);
	});

	test("wrong key fails decryption", () => {
		const encrypted = encryptArchive(TEST_DATA, TEST_KEY);
		expect(() => decryptArchive(encrypted, OTHER_KEY)).toThrow(
			ArchiveDecryptionError,
		);
	});

	test("tampered ciphertext fails decryption", () => {
		const encrypted = encryptArchive(TEST_DATA, TEST_KEY);
		// Flip a byte in the ciphertext region (after 32-byte header)
		encrypted[40] ^= 0xff;
		expect(() => decryptArchive(encrypted, TEST_KEY)).toThrow(
			ArchiveDecryptionError,
		);
	});

	test("tampered auth tag fails decryption", () => {
		const encrypted = encryptArchive(TEST_DATA, TEST_KEY);
		// Flip last byte (in auth tag)
		encrypted[encrypted.length - 1] ^= 0xff;
		expect(() => decryptArchive(encrypted, TEST_KEY)).toThrow(
			ArchiveDecryptionError,
		);
	});

	test("truncated data fails decryption", () => {
		const encrypted = encryptArchive(TEST_DATA, TEST_KEY);
		const truncated = encrypted.subarray(0, 40);
		expect(() => decryptArchive(truncated, TEST_KEY)).toThrow(
			ArchiveDecryptionError,
		);
	});

	test("rejects non-encrypted data", () => {
		expect(() => decryptArchive(TEST_DATA, TEST_KEY)).toThrow(
			ArchiveDecryptionError,
		);
	});

	test("handles empty plaintext", () => {
		const empty = Buffer.alloc(0);
		const encrypted = encryptArchive(empty, TEST_KEY);
		const decrypted = decryptArchive(encrypted, TEST_KEY);
		expect(decrypted).toEqual(empty);
	});

	test("handles large data", () => {
		const large = randomBytes(1024 * 1024); // 1 MB
		const encrypted = encryptArchive(large, TEST_KEY);
		const decrypted = decryptArchive(encrypted, TEST_KEY);
		expect(decrypted).toEqual(large);
	});

	test("rejects invalid key length", () => {
		expect(() => encryptArchive(TEST_DATA, "abcd")).toThrow(/32 bytes/);
		expect(() => decryptArchive(Buffer.alloc(100), "abcd")).toThrow(/32 bytes/);
	});
});

describe("isEncryptedArchive", () => {
	test("returns true for encrypted data", () => {
		const encrypted = encryptArchive(TEST_DATA, TEST_KEY);
		expect(isEncryptedArchive(encrypted)).toBe(true);
	});

	test("returns false for plain data", () => {
		expect(isEncryptedArchive(TEST_DATA)).toBe(false);
	});

	test("returns false for short data", () => {
		expect(isEncryptedArchive(Buffer.alloc(4))).toBe(false);
	});

	test("returns false for empty buffer", () => {
		expect(isEncryptedArchive(Buffer.alloc(0))).toBe(false);
	});
});
