import { EncodingSpec, parseEncodingLabel } from './encodings';
import { sniffBom } from './bom';
import { analyse } from 'chardet';
import { strictDecode } from './strict';

export type DetectionVia = 'bom' | 'utf8' | 'detector';

export type DetectionOutcome =
	| { kind: 'ok'; spec: EncodingSpec; confidence: number; via: DetectionVia }
	| { kind: 'low-confidence'; bestName?: string; bestConfidence?: number };

const UTF8: EncodingSpec = { id: 'utf-8', codec: 'utf-8', bom: false };

/**
 * Source-encoding resolution chain (auto mode):
 *   1. BOM sniff — definitive.
 *   2. Strict UTF-8 validation — a clean decode is conclusive (covers ASCII).
 *   3. chardet ranked candidates with confidence >= threshold, each verified by
 *      strict decode; the first cleanly decodable one wins.
 * Anything else is low-confidence: the caller skips the file, never guesses.
 */
export function detectEncoding(bytes: Uint8Array, threshold: number): DetectionOutcome {
	const bomSpec = sniffBom(bytes);
	if (bomSpec) {
		return { kind: 'ok', spec: bomSpec, confidence: 100, via: 'bom' };
	}
	if (strictDecode(bytes, 'utf-8') !== undefined) {
		return { kind: 'ok', spec: UTF8, confidence: 100, via: 'utf8' };
	}
	const matches = analyse(bytes);
	for (const m of matches) {
		if (m.confidence < threshold) {
			continue;
		}
		const spec = parseEncodingLabel(m.name);
		if (!spec || spec.codec === 'utf-8') {
			continue; // utf-8 already failed strict validation above
		}
		if (strictDecode(bytes, spec.codec) !== undefined) {
			return { kind: 'ok', spec, confidence: m.confidence, via: 'detector' };
		}
	}
	const best = matches[0];
	return best ? { kind: 'low-confidence', bestName: best.name, bestConfidence: best.confidence } : { kind: 'low-confidence' };
}
