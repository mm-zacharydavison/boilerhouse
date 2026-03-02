import { describe, test, expect } from "bun:test";
import { randomBytes } from "node:crypto";
import { computeArchiveHmac, verifyArchiveHmac, ArchiveIntegrityError } from "./hmac";

const TEST_KEY = randomBytes(32).toString("hex");
const OTHER_KEY = randomBytes(32).toString("hex");
const TEST_DATA = Buffer.from("checkpoint-archive-content");

describe("computeArchiveHmac", () => {
	test("returns a deterministic hex string", () => {
		const hmac1 = computeArchiveHmac(TEST_DATA, TEST_KEY);
		const hmac2 = computeArchiveHmac(TEST_DATA, TEST_KEY);
		expect(hmac1).toBe(hmac2);
		expect(hmac1).toMatch(/^[a-f0-9]{64}$/);
	});

	test("different data produces different HMACs", () => {
		const hmac1 = computeArchiveHmac(TEST_DATA, TEST_KEY);
		const hmac2 = computeArchiveHmac(Buffer.from("different"), TEST_KEY);
		expect(hmac1).not.toBe(hmac2);
	});

	test("different keys produce different HMACs", () => {
		const hmac1 = computeArchiveHmac(TEST_DATA, TEST_KEY);
		const hmac2 = computeArchiveHmac(TEST_DATA, OTHER_KEY);
		expect(hmac1).not.toBe(hmac2);
	});
});

describe("verifyArchiveHmac", () => {
	test("accepts a correct HMAC", () => {
		const hmac = computeArchiveHmac(TEST_DATA, TEST_KEY);
		expect(() => verifyArchiveHmac(TEST_DATA, TEST_KEY, hmac)).not.toThrow();
	});

	test("rejects a wrong HMAC", () => {
		const hmac = computeArchiveHmac(TEST_DATA, TEST_KEY);
		expect(() =>
			verifyArchiveHmac(Buffer.from("tampered"), TEST_KEY, hmac),
		).toThrow(ArchiveIntegrityError);
	});

	test("rejects HMAC computed with a different key", () => {
		const hmac = computeArchiveHmac(TEST_DATA, OTHER_KEY);
		expect(() =>
			verifyArchiveHmac(TEST_DATA, TEST_KEY, hmac),
		).toThrow(ArchiveIntegrityError);
	});

	test("rejects a truncated HMAC", () => {
		const hmac = computeArchiveHmac(TEST_DATA, TEST_KEY);
		expect(() =>
			verifyArchiveHmac(TEST_DATA, TEST_KEY, hmac.slice(0, 32)),
		).toThrow(ArchiveIntegrityError);
	});
});
