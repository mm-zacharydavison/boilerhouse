import { describe, test, expect } from "bun:test";
import { parseSni } from "./sni";

/**
 * Builds a minimal TLS ClientHello with optional SNI extension.
 * This constructs the binary format byte-by-byte for test isolation.
 */
function buildClientHello(options: {
	hostname?: string;
	/** Include a dummy extension before SNI to test non-first-extension parsing */
	prefixExtension?: boolean;
	/** Omit SNI entirely */
	omitSni?: boolean;
}): Buffer {
	// Extensions
	const extensions: Buffer[] = [];

	if (options.prefixExtension) {
		// Dummy extension: type=0xFF01 (renegotiation_info), data=0x00
		const dummyData = Buffer.from([0x00]);
		const dummyExt = Buffer.alloc(4 + dummyData.length);
		dummyExt.writeUInt16BE(0xff01, 0); // type
		dummyExt.writeUInt16BE(dummyData.length, 2); // length
		dummyData.copy(dummyExt, 4);
		extensions.push(dummyExt);
	}

	if (!options.omitSni && options.hostname) {
		const hostnameBytes = Buffer.from(options.hostname, "ascii");
		// SNI extension: type=0x0000
		// ServerNameList: length(2) + ServerName entry
		// ServerName: type(1)=0x00 + length(2) + hostname
		const sniEntryLen = 1 + 2 + hostnameBytes.length;
		const sniListLen = 2 + sniEntryLen;
		const sniData = Buffer.alloc(sniListLen);
		let off = 0;
		sniData.writeUInt16BE(sniEntryLen, off);
		off += 2;
		sniData.writeUInt8(0x00, off); // host_name type
		off += 1;
		sniData.writeUInt16BE(hostnameBytes.length, off);
		off += 2;
		hostnameBytes.copy(sniData, off);

		const sniExt = Buffer.alloc(4 + sniData.length);
		sniExt.writeUInt16BE(0x0000, 0); // SNI extension type
		sniExt.writeUInt16BE(sniData.length, 2); // extension data length
		sniData.copy(sniExt, 4);
		extensions.push(sniExt);
	}

	// Combine extensions
	let extensionsBlock: Buffer;
	if (extensions.length > 0) {
		const allExt = Buffer.concat(extensions);
		extensionsBlock = Buffer.alloc(2 + allExt.length);
		extensionsBlock.writeUInt16BE(allExt.length, 0);
		allExt.copy(extensionsBlock, 2);
	} else {
		extensionsBlock = Buffer.alloc(2);
		extensionsBlock.writeUInt16BE(0, 0);
	}

	// ClientHello body:
	// version(2) + random(32) + sessionIdLen(1) + cipherSuitesLen(2) + cipherSuites(2) + compressionLen(1) + compression(1) + extensions
	const sessionId = Buffer.alloc(0);
	const cipherSuites = Buffer.from([0x00, 0x2f]); // TLS_RSA_WITH_AES_128_CBC_SHA
	const compression = Buffer.from([0x00]); // null compression

	const clientHelloBody = Buffer.concat([
		Buffer.from([0x03, 0x03]), // TLS 1.2
		Buffer.alloc(32, 0xab), // random
		Buffer.from([sessionId.length]),
		sessionId,
		Buffer.from([
			(cipherSuites.length >> 8) & 0xff,
			cipherSuites.length & 0xff,
		]),
		cipherSuites,
		Buffer.from([compression.length]),
		compression,
		extensionsBlock,
	]);

	// Handshake header: type(1)=0x01 + length(3)
	const handshakeHeader = Buffer.alloc(4);
	handshakeHeader.writeUInt8(0x01, 0);
	handshakeHeader.writeUInt8((clientHelloBody.length >> 16) & 0xff, 1);
	handshakeHeader.writeUInt16BE(clientHelloBody.length & 0xffff, 2);

	const handshake = Buffer.concat([handshakeHeader, clientHelloBody]);

	// TLS record header: type(1)=0x16 + version(2)=0x0301 + length(2)
	const recordHeader = Buffer.alloc(5);
	recordHeader.writeUInt8(0x16, 0);
	recordHeader.writeUInt16BE(0x0301, 1);
	recordHeader.writeUInt16BE(handshake.length, 3);

	return Buffer.concat([recordHeader, handshake]);
}

describe("parseSni", () => {
	test("extracts hostname from valid ClientHello", () => {
		const data = buildClientHello({ hostname: "example.com" });
		expect(parseSni(data)).toBe("example.com");
	});

	test("returns null for non-TLS data", () => {
		const data = Buffer.from("GET / HTTP/1.1\r\n\r\n");
		expect(parseSni(data)).toBeNull();
	});

	test("returns null for ClientHello without SNI extension", () => {
		const data = buildClientHello({ omitSni: true });
		expect(parseSni(data)).toBeNull();
	});

	test("finds SNI when it is not the first extension", () => {
		const data = buildClientHello({
			hostname: "not-first.example.com",
			prefixExtension: true,
		});
		expect(parseSni(data)).toBe("not-first.example.com");
	});

	test("returns null for truncated buffer", () => {
		const data = buildClientHello({ hostname: "example.com" });
		// Truncate to just the record header
		expect(parseSni(data.subarray(0, 5))).toBeNull();
	});

	test("returns null for empty buffer", () => {
		expect(parseSni(Buffer.alloc(0))).toBeNull();
	});
});
