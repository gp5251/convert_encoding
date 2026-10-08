import * as vscode from 'vscode';
import { EncodingSpec, displayName } from './encodings';
import { hasBinaryExtension, looksBinary } from './binary';
import { sniffBom } from './bom';
import { detectEncoding, DetectionVia } from './detect';
import { convertBytes } from './convert';
import { AppSettings } from './settings';

export type SkipReason = 'dirty' | 'binary' | 'low-confidence' | 'too-large' | 'read-error' | 'cancelled';

/** Pre-flight analysis of one file: what WOULD happen (no writing). */
export type PlanItem =
	| {
			kind: 'convert';
			uri: vscode.Uri;
			src: EncodingSpec;
			tgt: EncodingSpec;
			srcVia: 'explicit' | DetectionVia;
			confidence: number;
			/** Replacements already known from the simulated convert (policy 'replace'). */
			replacedHint: number;
			/**
			 * Simulated output, cached when the run supplies a SimCache with budget.
			 * executeConvert reuses it if the file is unchanged, skipping the second
			 * decode/encode pass (P1-4).
			 */
			sim?: ConvertSim;
	  }
	| { kind: 'already-target'; uri: vscode.Uri; src: EncodingSpec; tgt: EncodingSpec }
	| { kind: 'skip'; uri: vscode.Uri; reason: SkipReason; detail?: string }
	| { kind: 'fail'; uri: vscode.Uri; reason: 'invalid-source' | 'unmappable'; detail: string };

/** What DID happen to one file. */
export type Outcome =
	| { kind: 'converted'; uri: vscode.Uri; src: EncodingSpec; tgt: EncodingSpec; replaced: number }
	| { kind: 'already-target'; uri: vscode.Uri; src: EncodingSpec; tgt: EncodingSpec }
	| { kind: 'skipped'; uri: vscode.Uri; reason: SkipReason; detail?: string }
	| { kind: 'failed'; uri: vscode.Uri; reason: 'invalid-source' | 'unmappable' | 'write-error'; detail: string };

export function dirtyUris(): Set<string> {
	return new Set(vscode.workspace.textDocuments.filter((d) => d.isDirty).map((d) => d.uri.toString()));
}

/** A simulated convert output plus the input's freshness key (size + mtime). */
export interface ConvertSim {
	readonly out: Uint8Array;
	readonly size: number;
	readonly mtime: number;
}

/**
 * Budget tracker for cached convert outputs held between analysis and execution.
 * Over-budget items simply skip the cache and recompute on execute, bounding
 * memory on huge folder batches while caching the common case (P1-4).
 */
export class SimCache {
	private used = 0;
	constructor(private readonly budget = 64 * 1024 * 1024) {}
	reserve(bytes: number): boolean {
		if (this.used + bytes > this.budget) {
			return false;
		}
		this.used += bytes;
		return true;
	}
}

/** Fresh single-file dirty check, for re-validating immediately before a write. */
function isDirtyNow(uri: vscode.Uri): boolean {
	const s = uri.toString();
	return vscode.workspace.textDocuments.some((d) => d.isDirty && d.uri.toString() === s);
}

/**
 * Atomic in-place write (ADR-0002): write a sibling temp file, then rename over
 * the target. A crash / full disk mid-write leaves the ORIGINAL file intact
 * rather than truncated. On failure the temp file is best-effort removed.
 */
export async function writeFileAtomic(uri: vscode.Uri, bytes: Uint8Array): Promise<void> {
	const tmp = uri.with({ path: `${uri.path}.${process.pid}.${Date.now()}.tmp` });
	try {
		await vscode.workspace.fs.writeFile(tmp, bytes);
		await vscode.workspace.fs.rename(tmp, uri, { overwrite: true });
	} catch (e) {
		try {
			await vscode.workspace.fs.delete(tmp);
		} catch {
			// best effort: the temp file may never have been created
		}
		throw e;
	}
}

function unmappableDetail(count: number, firstChar: string, firstIndex: number): string {
	const cp = firstChar.codePointAt(0)?.toString(16).toUpperCase() ?? '?';
	return vscode.l10n.t('{0} unmappable character(s); first: U+{1} at char {2}.', String(count), cp, String(firstIndex));
}

/**
 * Analyze one file end-to-end: dirty check → size/binary guards → source
 * resolution (explicit or auto chain) → simulated conversion. Never writes.
 * Order matters: dirty first (data loss), cheap guards before I/O, and the
 * binary NUL sniff only runs when no BOM claims the file (BOM-less UTF-16/32
 * text is NUL-laden but text). Explicit source mode bypasses the binary
 * guards — declaring the encoding is an informed act.
 */
export async function analyzeFile(
	uri: vscode.Uri,
	settings: AppSettings,
	dirty: ReadonlySet<string>,
	cache?: SimCache,
): Promise<PlanItem> {
	if (dirty.has(uri.toString())) {
		return { kind: 'skip', uri, reason: 'dirty' };
	}
	const autoMode = settings.sourceSpec === undefined;
	if (autoMode && hasBinaryExtension(uri.path)) {
		return { kind: 'skip', uri, reason: 'binary' };
	}
	let stat: vscode.FileStat;
	try {
		stat = await vscode.workspace.fs.stat(uri);
	} catch {
		return { kind: 'skip', uri, reason: 'read-error' };
	}
	if (settings.maxFileSizeBytes > 0 && stat.size > settings.maxFileSizeBytes) {
		return { kind: 'skip', uri, reason: 'too-large', detail: `${stat.size} bytes` };
	}
	let bytes: Uint8Array;
	try {
		bytes = await vscode.workspace.fs.readFile(uri);
	} catch {
		return { kind: 'skip', uri, reason: 'read-error' };
	}

	let src: EncodingSpec;
	let srcVia: 'explicit' | DetectionVia;
	let confidence = 100;
	if (settings.sourceSpec) {
		src = settings.sourceSpec;
		srcVia = 'explicit';
	} else {
		const bom = sniffBom(bytes);
		if (bom) {
			src = bom;
			srcVia = 'bom';
		} else if (looksBinary(bytes)) {
			return { kind: 'skip', uri, reason: 'binary' };
		} else {
			const d = detectEncoding(bytes, settings.confidenceThreshold);
			if (d.kind === 'low-confidence') {
				return {
					kind: 'skip',
					uri,
					reason: 'low-confidence',
					detail: d.bestName ? `${d.bestName} ${Math.round(d.bestConfidence ?? 0)}%` : undefined,
				};
			}
			src = d.spec;
			srcVia = d.via;
			confidence = d.confidence;
		}
	}

	const res = convertBytes(bytes, src, settings.targetSpec, settings.onUnmappable);
	switch (res.kind) {
		case 'noop':
			return { kind: 'already-target', uri, src, tgt: settings.targetSpec };
		case 'invalid-source':
			return {
				kind: 'fail',
				uri,
				reason: 'invalid-source',
				detail: vscode.l10n.t('Not a valid {0} byte sequence.', displayName(src)),
			};
		case 'unmappable':
			return { kind: 'fail', uri, reason: 'unmappable', detail: unmappableDetail(res.count, res.firstChar, res.firstIndex) };
		default: {
			const sim =
				cache && cache.reserve(res.bytes.byteLength)
					? { out: res.bytes, size: stat.size, mtime: stat.mtime }
					: undefined;
			return { kind: 'convert', uri, src, tgt: settings.targetSpec, srcVia, confidence, replacedHint: res.replaced, sim };
		}
	}
}

/**
 * Execute a convert plan item. When a cached simulation is present and the file
 * is unchanged (size+mtime), the cached output is written directly; otherwise a
 * fresh read + convert runs. The fresh-read fallback keeps the write honest to
 * the current bytes on disk (ADR-0002), while the cache removes the ~2x CPU cost
 * of converting every file twice (P1-4).
 */
async function executeConvert(
	item: Extract<PlanItem, { kind: 'convert' }>,
	settings: AppSettings,
	dirty: ReadonlySet<string>,
): Promise<Outcome> {
	if (dirty.has(item.uri.toString())) {
		return { kind: 'skipped', uri: item.uri, reason: 'dirty' };
	}
	// Fast path (P1-4): reuse the simulated output when the file is unchanged since
	// analysis, skipping the second decode/encode pass. size+mtime is the freshness
	// key (the same cheap check build tools use); on any doubt we fall through to a
	// fresh read + convert.
	// ponytail ceiling: a same-size edit landing within the filesystem's mtime
	// resolution could be missed. The analysis→execute window is short and the
	// single-file path has none. Upgrade path: hash the input bytes instead.
	if (item.sim) {
		try {
			const st = await vscode.workspace.fs.stat(item.uri);
			if (st.size === item.sim.size && st.mtime === item.sim.mtime) {
				if (isDirtyNow(item.uri)) {
					return { kind: 'skipped', uri: item.uri, reason: 'dirty' };
				}
				await writeFileAtomic(item.uri, item.sim.out);
				return { kind: 'converted', uri: item.uri, src: item.src, tgt: item.tgt, replaced: item.replacedHint };
			}
		} catch {
			// stat/write failed: fall through to the full path, which reports precisely
		}
	}
	let bytes: Uint8Array;
	try {
		bytes = await vscode.workspace.fs.readFile(item.uri);
	} catch {
		return { kind: 'skipped', uri: item.uri, reason: 'read-error' };
	}
	const r = convertBytes(bytes, item.src, item.tgt, settings.onUnmappable);
	switch (r.kind) {
		case 'noop':
			return { kind: 'already-target', uri: item.uri, src: item.src, tgt: item.tgt };
		case 'invalid-source':
			return {
				kind: 'failed',
				uri: item.uri,
				reason: 'invalid-source',
				detail: vscode.l10n.t('Not a valid {0} byte sequence.', displayName(item.src)),
			};
		case 'unmappable':
			return { kind: 'failed', uri: item.uri, reason: 'unmappable', detail: unmappableDetail(r.count, r.firstChar, r.firstIndex) };
		default:
			// Re-check dirty immediately before the destructive write: the file may
			// have been edited while the batch was running (ADR-0002 first line).
			if (isDirtyNow(item.uri)) {
				return { kind: 'skipped', uri: item.uri, reason: 'dirty' };
			}
			try {
				await writeFileAtomic(item.uri, r.bytes);
				return { kind: 'converted', uri: item.uri, src: item.src, tgt: item.tgt, replaced: r.replaced };
			} catch (e) {
				return { kind: 'failed', uri: item.uri, reason: 'write-error', detail: e instanceof Error ? e.message : String(e) };
			}
	}
}

/** Map an unexecuted plan item to its outcome equivalent (convert → cancelled). */
export function planItemToOutcome(item: PlanItem): Outcome {
	switch (item.kind) {
		case 'convert':
			return { kind: 'skipped', uri: item.uri, reason: 'cancelled' };
		case 'already-target':
			return item;
		case 'skip':
			return { kind: 'skipped', uri: item.uri, reason: item.reason, detail: item.detail };
		case 'fail':
			return { kind: 'failed', uri: item.uri, reason: item.reason, detail: item.detail };
	}
}

/**
 * Execute plan items sequentially. Convert items are written in place; the
 * rest pass through as outcomes so summaries stay complete. Cancellation
 * marks the remaining items as skipped.
 */
export async function executePlanItems(
	items: readonly PlanItem[],
	settings: AppSettings,
	progress: vscode.Progress<{ message?: string; increment?: number }>,
	token: vscode.CancellationToken,
): Promise<Outcome[]> {
	const dirty = dirtyUris();
	const outcomes: Outcome[] = [];
	const increment = items.length > 0 ? 100 / items.length : 100;
	for (let i = 0; i < items.length; i++) {
		if (token.isCancellationRequested) {
			for (let j = i; j < items.length; j++) {
				outcomes.push(planItemToOutcome(items[j]));
			}
			break;
		}
		const item = items[i];
		progress.report({ message: `${i + 1}/${items.length}`, increment });
		outcomes.push(item.kind === 'convert' ? await executeConvert(item, settings, dirty) : planItemToOutcome(item));
	}
	return outcomes;
}

/**
 * Quick detection preview for the source picker of the options flow
 * (single file only). Returns undefined when nothing confident surfaces.
 */
export async function detectHint(uri: vscode.Uri, settings: AppSettings): Promise<{ label: string; confidence: number } | undefined> {
	try {
		if (settings.maxFileSizeBytes > 0 && (await vscode.workspace.fs.stat(uri)).size > settings.maxFileSizeBytes) {
			return undefined;
		}
		const bytes = await vscode.workspace.fs.readFile(uri);
		if (hasBinaryExtension(uri.path) || looksBinary(bytes)) {
			return undefined;
		}
		const bom = sniffBom(bytes);
		if (bom) {
			return { label: displayName(bom), confidence: 100 };
		}
		const d = detectEncoding(bytes, settings.confidenceThreshold);
		return d.kind === 'ok' ? { label: displayName(d.spec), confidence: d.confidence } : undefined;
	} catch {
		return undefined;
	}
}
