import * as iconv from 'iconv-lite';
import { toBuffer } from './util';

/**
 * Strict decode (ADR-0003): returns the text iff `bytes` is a fully valid,
 * losslessly representable sequence of `codec`; undefined otherwise.
 *
 * iconv-lite has no fatal-decode option — its decoder silently replaces
 * invalid sequences with U+FFFD and even drops odd trailing bytes for
 * UTF-16/32. Strictness is therefore enforced by re-encoding the decoded
 * text and requiring byte equality with the input. Both directions use the
 * same iconv codec, so this also rejects inputs whose only "valid" decode
 * would normalize on re-encode (pathological GB18030 dual forms).
 *
 * Known false-invalid: the passthrough 'utf-16' codec (endianness heuristic
 * on decode, BOM-adding on encode) may not round-trip. Use the canonical
 * 'utf-16le'/'utf-16be' ids instead.
 */
export function strictDecode(bytes: Uint8Array, codec: string): string | undefined {
	const buf = toBuffer(bytes);
	try {
		const raw = iconv.decode(buf, codec, { stripBOM: false });
		if (!buf.equals(Buffer.from(iconv.encode(raw, codec)))) {
			return undefined;
		}
		return iconv.decode(buf, codec); // default: strips BOM for BOM-aware codecs
	} catch {
		return undefined;
	}
}
