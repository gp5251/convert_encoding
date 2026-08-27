import { EncodingSpec } from './encodings';

interface BomSignature {
	readonly bytes: readonly number[];
	readonly spec: EncodingSpec;
}

// 4-byte signatures MUST be listed before their 2-byte prefixes
// (FF FE 00 00 is UTF-32LE, not UTF-16LE).
const SIGNATURES: readonly BomSignature[] = [
	{ bytes: [0x00, 0x00, 0xfe, 0xff], spec: { id: 'utf-32be', codec: 'utf-32be', bom: true } },
	{ bytes: [0xff, 0xfe, 0x00, 0x00], spec: { id: 'utf-32le', codec: 'utf-32le', bom: true } },
	{ bytes: [0xef, 0xbb, 0xbf], spec: { id: 'utf-8-bom', codec: 'utf-8', bom: true } },
	{ bytes: [0xff, 0xfe], spec: { id: 'utf-16le', codec: 'utf-16le', bom: true } },
	{ bytes: [0xfe, 0xff], spec: { id: 'utf-16be', codec: 'utf-16be', bom: true } },
];

/**
 * Returns the encoding claimed by a leading BOM, or undefined.
 * A BOM is definitive: the file is text in that encoding, regardless of NUL bytes.
 */
export function sniffBom(bytes: Uint8Array): EncodingSpec | undefined {
	for (const sig of SIGNATURES) {
		if (bytes.length < sig.bytes.length) {
			continue;
		}
		let match = true;
		for (let i = 0; i < sig.bytes.length; i++) {
			if (bytes[i] !== sig.bytes[i]) {
				match = false;
				break;
			}
		}
		if (match) {
			return sig.spec;
		}
	}
	return undefined;
}
