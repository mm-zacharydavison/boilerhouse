/**
 * Parses the SNI (Server Name Indication) hostname from a TLS ClientHello message.
 *
 * Returns the hostname string, or `null` if the data is not a valid
 * ClientHello or does not contain an SNI extension.
 */
export function parseSni(data: Buffer): string | null {
	let offset = 0;

	// Minimum TLS record header: 5 bytes
	if (data.length < 5) return null;

	// TLS record header
	const contentType = data[offset]!;
	if (contentType !== 0x16) return null; // Not a handshake record
	offset += 1;

	const recordVersion = data.readUInt16BE(offset);
	if (recordVersion < 0x0301) return null; // Too old
	offset += 2;

	const recordLength = data.readUInt16BE(offset);
	offset += 2;

	if (data.length < offset + recordLength) return null;

	// Handshake header: type(1) + length(3)
	if (data.length < offset + 4) return null;
	const handshakeType = data[offset]!;
	if (handshakeType !== 0x01) return null; // Not ClientHello
	offset += 1;

	const handshakeLength =
		(data[offset]! << 16) | (data[offset + 1]! << 8) | data[offset + 2]!;
	offset += 3;

	const handshakeEnd = offset + handshakeLength;
	if (data.length < handshakeEnd) return null;

	// ClientHello body: version(2) + random(32)
	if (data.length < offset + 34) return null;
	offset += 2; // version
	offset += 32; // random

	// Session ID: length(1) + data
	if (data.length < offset + 1) return null;
	const sessionIdLength = data[offset]!;
	offset += 1 + sessionIdLength;

	// Cipher suites: length(2) + data
	if (data.length < offset + 2) return null;
	const cipherSuitesLength = data.readUInt16BE(offset);
	offset += 2 + cipherSuitesLength;

	// Compression methods: length(1) + data
	if (data.length < offset + 1) return null;
	const compressionLength = data[offset]!;
	offset += 1 + compressionLength;

	// Extensions: length(2) + extension list
	if (data.length < offset + 2) return null;
	const extensionsLength = data.readUInt16BE(offset);
	offset += 2;

	const extensionsEnd = offset + extensionsLength;
	if (data.length < extensionsEnd) return null;

	// Walk extensions looking for SNI (type 0x0000)
	while (offset + 4 <= extensionsEnd) {
		const extType = data.readUInt16BE(offset);
		offset += 2;
		const extLength = data.readUInt16BE(offset);
		offset += 2;

		if (extType === 0x0000) {
			return parseSniExtension(data, offset, extLength);
		}

		offset += extLength;
	}

	return null;
}

function parseSniExtension(
	data: Buffer,
	offset: number,
	_extLength: number,
): string | null {
	// ServerNameList: length(2)
	if (data.length < offset + 2) return null;
	const listLength = data.readUInt16BE(offset);
	offset += 2;

	const listEnd = offset + listLength;
	if (data.length < listEnd) return null;

	// Walk ServerName entries
	while (offset + 3 <= listEnd) {
		const nameType = data[offset]!;
		offset += 1;
		const nameLength = data.readUInt16BE(offset);
		offset += 2;

		if (data.length < offset + nameLength) return null;

		if (nameType === 0x00) {
			// host_name
			return data.toString("ascii", offset, offset + nameLength);
		}

		offset += nameLength;
	}

	return null;
}
