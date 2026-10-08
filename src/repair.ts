import * as iconv from 'iconv-lite';
import { EncodingSpec, parseEncodingLabel } from './encodings';
import { strictDecode } from './strict';
import { sniffBom } from './bom';
import { toBuffer } from './util';

/**
 * A proposed repair for a garbled file. The core emits structured data only;
 * the orchestration layer (repairFlow) turns it into localized UI text.
 *
 * Two families, matching the two ways a text file gets garbled:
 *
 * - 'mojibake': the bytes decode cleanly under one encoding, but the resulting
 *   text is garbage because the original bytes were once misread and re-saved
 *   (e.g. UTF-8 bytes read as GBK, then stored as UTF-8 → "浣犲ソ"). Reversed by
 *   re-encoding the garbled text with the misused codec and strictly decoding
 *   the result with the correct one.
 *
 * - 'segmented': the bytes contain spans that are invalid in the dominant
 *   encoding (e.g. GBK bytes spliced into an otherwise-UTF-8 file). Each
 *   maximal run of non-ASCII bytes rejected by the main codec is decoded with
 *   a fallback codec and the pieces are stitched back together.
 */
export type RepairCandidate =
	| {
			readonly kind: 'mojibake';
			/** Codec the bytes were originally misread with. */
			readonly wrong: EncodingSpec;
			/** Codec that yields the real text once re-encoded via `wrong`. */
			readonly correct: EncodingSpec;
			readonly text: string;
			/** 0..1 plausibility of `text`; higher is more likely the true content. */
			readonly score: number;
	  }
	| {
			readonly kind: 'segmented';
			/** Dominant encoding of the file (always UTF-8 here). */
			readonly main: EncodingSpec;
			/** Fallback codec that cleanly decoded every foreign span. */
			readonly segment: EncodingSpec;
			readonly segmentCount: number;
			readonly text: string;
			readonly score: number;
	  };

const UTF8: EncodingSpec = { id: 'utf-8', codec: 'utf-8', bom: false };

function spec(id: string): EncodingSpec {
	const s = parseEncodingLabel(id);
	if (!s) {
		throw new Error(`repair: unsupported encoding id '${id}'`);
	}
	return s;
}

/** Misread → correct pairs covering the common CJK / Latin mojibake cases. */
const MOJIBAKE_PAIRS: ReadonlyArray<readonly [wrong: string, correct: string]> = [
	['gbk', 'utf-8'],
	['gb18030', 'utf-8'],
	['big5', 'utf-8'],
	['shift_jis', 'utf-8'],
	['euc-kr', 'utf-8'],
	['windows-1252', 'utf-8'],
	['iso-8859-1', 'utf-8'],
	['utf-8', 'gbk'],
	['utf-8', 'big5'],
	['utf-8', 'shift_jis'],
];

/** Fallback codecs tried for the foreign spans in the segmented path. */
const SEGMENT_CODECS: readonly string[] = ['gbk', 'gb18030', 'big5', 'shift_jis', 'euc-kr'];

/** A stitched segmented result below this plausibility is not worth proposing. */
const MIN_SEGMENT_SCORE = 0.6;

/**
 * Propose every plausible repair for `bytes`, best-scored first and de-duplicated
 * by resulting text. Binary/size/dirty guards are the caller's job (they need
 * vscode APIs); this is pure and total — it returns [] when nothing fits.
 *
 * The two paths are mutually exclusive by construction: a buffer that is clean
 * UTF-8 (or BOM-decodable) only feeds the mojibake path; a buffer that is NOT
 * clean UTF-8 only feeds the segmented path.
 */
export function proposeRepairs(bytes: Uint8Array): RepairCandidate[] {
	const candidates: RepairCandidate[] = [];
	const bom = sniffBom(bytes);
	const asUtf8 = bom ? undefined : strictDecode(bytes, UTF8.codec);

	// Mojibake path: the buffer is cleanly decodable text (via BOM or UTF-8),
	// but that text may itself be garbage from a prior misread.
	const storageText = bom ? strictDecode(bytes, bom.codec) : asUtf8;
	if (storageText !== undefined) {
		candidates.push(...mojibakeCandidates(storageText));
	}

	// Segmented path: not clean UTF-8 → suspect foreign byte spans.
	if (!bom && asUtf8 === undefined) {
		candidates.push(...segmentedCandidates(bytes));
	}

	return dedupeByScore(candidates);
}

function mojibakeCandidates(garbled: string): RepairCandidate[] {
	const out: RepairCandidate[] = [];
	const garbledScore = scoreText(garbled);
	for (const [wrongId, correctId] of MOJIBAKE_PAIRS) {
		const wrong = spec(wrongId);
		const correct = spec(correctId);
		if (wrong.codec === correct.codec) {
			continue;
		}
		let recovered: Buffer;
		try {
			recovered = iconv.encode(garbled, wrong.codec);
		} catch {
			continue;
		}
		// The misused codec must represent every garbled char losslessly,
		// otherwise it cannot be the codec that produced the mojibake.
		if (iconv.decode(recovered, wrong.codec) !== garbled) {
			continue;
		}
		const fixed = strictDecode(recovered, correct.codec);
		// Reject a failed decode and the identity (no actual change).
		if (fixed === undefined || fixed === garbled) {
			continue;
		}
		const score = scoreText(fixed);
		// Drop only repairs clearly WORSE than the garbled text. Equality is kept:
		// CJK mojibake (UTF-8 misread as GBK) garbles into CJK-looking chars that
		// score as high as the true text, so a strict '>' would discard the real
		// fix. The preview is the arbiter for same-score candidates.
		if (score < garbledScore) {
			continue;
		}
		out.push({ kind: 'mojibake', wrong, correct, text: fixed, score });
	}
	return out;
}

function segmentedCandidates(bytes: Uint8Array): RepairCandidate[] {
	const out: RepairCandidate[] = [];
	for (const segId of SEGMENT_CODECS) {
		const segment = spec(segId);
		const r = segmentedDecode(bytes, segment.codec);
		if (!r) {
			continue;
		}
		const score = scoreText(r.text);
		// A stitched result that still looks garbled is not worth proposing.
		if (score < MIN_SEGMENT_SCORE) {
			continue;
		}
		out.push({ kind: 'segmented', main: UTF8, segment, segmentCount: r.segments, text: r.text, score });
	}
	return out;
}

/**
 * Decode `bytes` as UTF-8, except that each maximal run of non-ASCII bytes is
 * tried as UTF-8 WHOLESALE first and, only if the entire run is invalid UTF-8,
 * decoded strictly as `segCodec`. ASCII runs pass through verbatim (identical
 * under every codec we support). Returns undefined if any span decodes under
 * neither codec — we never emit a half-repaired U+FFFD result.
 *
 * Judging the whole run (not byte-by-byte) is what makes this correct: a GBK
 * pair like D1A1 ("选") is ALSO a valid 2-byte UTF-8 sequence (U+0461 'ѡ'), so
 * a greedy per-char UTF-8 walk would silently swallow it. Requiring the entire
 * non-ASCII run to be valid UTF-8 lets the surrounding invalid bytes (D4F1…)
 * force the fallback to the foreign codec.
 *
 * ponytail: two ceilings, both fail-safe (no candidate → nothing is written):
 * (1) a foreign run touching valid non-ASCII UTF-8 with no ASCII between them
 * is judged as one span; (2) a foreign char whose trail byte lands in ASCII
 * (GBK trail bytes 0x40-0x7E) splits the run so it decodes under neither codec.
 * Upgrade path: a full UTF-8 state machine with per-span codec voting.
 */
function segmentedDecode(bytes: Uint8Array, segCodec: string): { text: string; segments: number } | undefined {
	const buf = toBuffer(bytes);
	const parts: string[] = [];
	let segments = 0;
	let i = 0;
	while (i < bytes.length) {
		if (bytes[i] < 0x80) {
			let k = i;
			while (k < bytes.length && bytes[k] < 0x80) {
				k++;
			}
			parts.push(iconv.decode(buf.subarray(i, k), UTF8.codec));
			i = k;
			continue;
		}
		let j = i;
		while (j < bytes.length && bytes[j] >= 0x80) {
			j++;
		}
		const run = buf.subarray(i, j);
		const asMain = strictDecode(run, UTF8.codec);
		if (asMain !== undefined) {
			parts.push(asMain);
		} else {
			const asSeg = strictDecode(run, segCodec);
			if (asSeg === undefined) {
				return undefined;
			}
			parts.push(asSeg);
			segments++;
		}
		i = j;
	}
	return { text: parts.join(''), segments };
}

/**
 * Plausibility of a repaired text, 0..1. Rewards the characters real CJK/mixed
 * source text is made of; penalises U+FFFD, control bytes, the private-use
 * area, and the Latin-ext / Cyrillic / Hebrew code points that mojibake and
 * half-decoded GBK typically surface (e.g. U+013C 'ļ', U+05E2 'ע', U+0461 'ѡ').
 *
 * ponytail: the heuristic is deliberately CJK-centric (ADR-0004). Scripts whose
 * legitimate text lives outside ASCII + the CJK blocks (accented Latin, Cyrillic,
 * Greek, …) score every real char as 'bad', so repair ranking is unreliable for
 * them. Ceiling: non-CJK garbling may be mis-scored or filtered out. Upgrade
 * path: a script-aware scorer that rewards the expected Unicode blocks per locale.
 */
function scoreText(text: string): number {
	let good = 0;
	let bad = 0;
	for (const ch of text) {
		const cp = ch.codePointAt(0)!;
		if (cp === 0xfffd) {
			bad += 2;
		} else if (cp === 0x09 || cp === 0x0a || cp === 0x0d) {
			good += 1;
		} else if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) {
			bad += 2;
		} else if (cp < 0x7f) {
			good += 1;
		} else if (cp >= 0x4e00 && cp <= 0x9fff) {
			good += 1; // CJK unified ideographs
		} else if (cp >= 0x3000 && cp <= 0x303f) {
			good += 1; // CJK punctuation
		} else if (cp >= 0xff00 && cp <= 0xffef) {
			good += 1; // fullwidth forms
		} else if (cp >= 0xe000 && cp <= 0xf8ff) {
			bad += 1; // private use area
		} else {
			bad += 1; // other non-ASCII: a mojibake tell in CJK/mixed text
		}
	}
	const total = good + bad;
	return total === 0 ? 0 : good / total;
}

function dedupeByScore(candidates: RepairCandidate[]): RepairCandidate[] {
	const best = new Map<string, RepairCandidate>();
	for (const c of candidates) {
		const prev = best.get(c.text);
		if (!prev || c.score > prev.score) {
			best.set(c.text, c);
		}
	}
	return [...best.values()].sort((a, b) => b.score - a.score);
}
