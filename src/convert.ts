import * as iconv from 'iconv-lite';
import { EncodingSpec } from './encodings';
import { bytesEqual } from './util';
import { strictDecode } from './strict';

export type UnmappablePolicy = 'fail' | 'replace';

export type ConvertResult =
	| { kind: 'ok'; bytes: Uint8Array; replaced: number }
	/** Output bytes are identical to input: the file already is the target encoding — skip writing. */
	| { kind: 'noop' }
	/** Source bytes are not a valid, losslessly decodable sequence of the source encoding. */
	| { kind: 'invalid-source' }
	/** Target encoding cannot represent some characters and policy is 'fail'. */
	| { kind: 'unmappable'; count: number; firstChar: string; firstIndex: number };

/**
 * Convert raw bytes: strict-decode with `src`, re-encode with `tgt`.
 * BOM semantics: decode strips a leading BOM (BOM-aware codecs); encode adds one
 * iff `tgt.bom` — the target encoding alone determines the output BOM.
 * Lossless guarantee: the output is round-trip decoded and compared; any
 * replacement iconv silently performed is detected and surfaced.
 */
export function convertBytes(
	input: Uint8Array,
	src: EncodingSpec,
	tgt: EncodingSpec,
	policy: UnmappablePolicy,
): ConvertResult {
	const text = strictDecode(input, src.codec);
	if (text === undefined) {
		return { kind: 'invalid-source' };
	}
	const out = iconv.encode(text, tgt.codec, { addBOM: tgt.bom });
	const back = iconv.decode(out, tgt.codec, { stripBOM: false });
	const expected = (tgt.bom ? '\uFEFF' : '') + text;
	if (back === expected) {
		return bytesEqual(out, input) ? { kind: 'noop' } : { kind: 'ok', bytes: out, replaced: 0 };
	}
	const firstIndex = firstDiffIndex(back, expected);
	const count = countDiffs(back, expected, firstIndex);
	if (policy === 'fail') {
		return {
			kind: 'unmappable',
			count,
			firstChar: codePointAtOrEmpty(expected, firstIndex),
			firstIndex,
		};
	}
	return { kind: 'ok', bytes: out, replaced: count };
}

function codePointAtOrEmpty(s: string, index: number): string {
	if (index >= s.length) {
		return '';
	}
	const cp = s.codePointAt(index);
	return cp === undefined ? '' : String.fromCodePoint(cp);
}

function firstDiffIndex(a: string, b: string): number {
	const n = Math.min(a.length, b.length);
	let i = 0;
	while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) {
		i++;
	}
	return i;
}

function countDiffs(back: string, expected: string, from: number): number {
	const n = Math.min(back.length, expected.length);
	let count = Math.abs(back.length - expected.length);
	for (let j = from; j < n; j++) {
		if (back.charCodeAt(j) !== expected.charCodeAt(j)) {
			count++;
		}
	}
	return count;
}
