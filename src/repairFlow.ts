import * as vscode from 'vscode';
import * as iconv from 'iconv-lite';
import { proposeRepairs, RepairCandidate } from './repair';
import { EncodingSpec, displayName } from './encodings';
import { hasBinaryExtension, looksBinary } from './binary';
import { collectFiles } from './batch';
import { dirtyUris, writeFileAtomic } from './pipeline';
import { pickTargetEncoding } from './quickpick';
import { AppSettings } from './settings';
import { toBuffer } from './util';
import { PREFIX } from './extension';

/** Localized one-line description of HOW a candidate repairs the file. */
function candidateLabel(c: RepairCandidate): string {
	if (c.kind === 'mojibake') {
		return vscode.l10n.t('{0} text that was misread as {1}', displayName(c.correct), displayName(c.wrong));
	}
	return vscode.l10n.t('{0} body with {1} foreign {2} span(s)', displayName(c.main), String(c.segmentCount), displayName(c.segment));
}

/** Collapsed single-line snippet of the repaired text, for inline preview. */
function snippet(text: string, max = 72): string {
	const oneLine = text.replace(/\s+/g, ' ').trim();
	return oneLine.length > max ? oneLine.slice(0, max) + '…' : oneLine;
}

/** Loose UTF-8 decode used ONLY to show the current garbled state in the diff. */
function decodeForDisplay(bytes: Uint8Array): string {
	try {
		return iconv.decode(toBuffer(bytes), 'utf-8');
	} catch {
		return '';
	}
}

function noRepairMessage(): string {
	return vscode.l10n.t('No auto-repairable garbling found. The file may already be correct, or the damage may be irreversible.');
}

type Guard = { skip: true; message: string } | { skip: false; bytes: Uint8Array };

/** Pre-flight mirroring analyzeFile's guards: dirty → binary ext → size → read → NUL sniff. */
async function readGuarded(uri: vscode.Uri, settings: AppSettings, dirty: ReadonlySet<string>): Promise<Guard> {
	if (dirty.has(uri.toString())) {
		return { skip: true, message: vscode.l10n.t('Skipped · file has unsaved changes') };
	}
	if (hasBinaryExtension(uri.path)) {
		return { skip: true, message: vscode.l10n.t('Skipped · looks binary') };
	}
	let size: number;
	try {
		size = (await vscode.workspace.fs.stat(uri)).size;
	} catch {
		return { skip: true, message: vscode.l10n.t('Skipped · read error') };
	}
	if (settings.maxFileSizeBytes > 0 && size > settings.maxFileSizeBytes) {
		return { skip: true, message: vscode.l10n.t('Skipped · exceeds size limit ({0})', `${size} bytes`) };
	}
	let bytes: Uint8Array;
	try {
		bytes = await vscode.workspace.fs.readFile(uri);
	} catch {
		return { skip: true, message: vscode.l10n.t('Skipped · read error') };
	}
	if (looksBinary(bytes)) {
		return { skip: true, message: vscode.l10n.t('Skipped · looks binary') };
	}
	return { skip: false, bytes };
}

/**
 * Entry point for the "Repair Encoding" command. A single file gets the full
 * interactive treatment (candidate picker → diff preview → modal confirm);
 * multi-select and folders go through a dry-run list that uses each file's
 * best-scored candidate, consistent with the converter's folder preview.
 */
export async function runRepair(
	targets: readonly vscode.Uri[],
	settings: AppSettings,
	context?: vscode.ExtensionContext,
): Promise<void> {
	const files: vscode.Uri[] = [];
	const folders: vscode.Uri[] = [];
	for (const t of targets) {
		try {
			if ((await vscode.workspace.fs.stat(t)).type & vscode.FileType.Directory) {
				folders.push(t);
				continue;
			}
		} catch {
			// fall through: readGuarded will surface the read error
		}
		files.push(t);
	}

	if (folders.length > 0) {
		let collected: vscode.Uri[] | undefined;
		try {
			collected = await vscode.window.withProgress<vscode.Uri[]>(
				{ location: vscode.ProgressLocation.Window, cancellable: true, title: vscode.l10n.t('Scanning folders') },
				async (_progress, token) => {
					const out: vscode.Uri[] = [];
					for (const folder of folders) {
						out.push(...(await collectFiles(folder, settings.batchExcludes, token)));
					}
					return out;
				},
			);
		} catch {
			collected = undefined;
		}
		if (!collected) {
			return; // user cancelled the scan
		}
		await repairBatch([...files, ...collected], settings, context);
		return;
	}

	if (files.length === 0) {
		return;
	}
	if (files.length === 1) {
		await repairSingle(files[0], settings, context);
		return;
	}
	await repairBatch(files, settings, context);
}

/** Full interactive repair for one file. */
async function repairSingle(uri: vscode.Uri, settings: AppSettings, context?: vscode.ExtensionContext): Promise<void> {
	const guard = await readGuarded(uri, settings, dirtyUris());
	if (guard.skip) {
		vscode.window.showWarningMessage(guard.message);
		return;
	}
	const candidates = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Window, title: vscode.l10n.t('Analyzing garbling') },
		async () => {
			// Yield once so the spinner paints before the synchronous candidate scan
			// blocks the extension host. ponytail: the scan itself is still one
			// uninterruptible burst; the upgrade path is an async proposeRepairs that
			// yields between candidates (see ADR-0004).
			await new Promise<void>((resolve) => setImmediate(resolve));
			return proposeRepairs(guard.bytes);
		},
	);
	if (candidates.length === 0) {
		vscode.window.showInformationMessage(noRepairMessage());
		return;
	}
	const candidate = await pickCandidate(candidates);
	if (!candidate) {
		return;
	}
	const target = await chooseTarget(context);
	if (!target) {
		return;
	}
	await showRepairDiff(uri, guard.bytes, candidate);
	const overwrite = vscode.l10n.t('Overwrite');
	const choice = await vscode.window.showWarningMessage(
		vscode.l10n.t(
			'Overwrite {0} with the repaired text, encoded as {1}? This cannot be undone.',
			vscode.workspace.asRelativePath(uri, false),
			displayName(target),
		),
		{ modal: true },
		overwrite,
	);
	// Close the read-only diff tab regardless of the decision.
	await closeDiffTab();
	if (choice !== overwrite) {
		return;
	}
	// Re-check dirty immediately before the destructive write: the file may have
	// been edited while picking a candidate, choosing the target, or reviewing
	// the diff (ADR-0002: dirty buffers are always refused).
	if (dirtyUris().has(uri.toString())) {
		vscode.window.showWarningMessage(vscode.l10n.t('Skipped · file has unsaved changes'));
		return;
	}
	await writeRepair(uri, candidate.text, target);
}

async function pickCandidate(candidates: readonly RepairCandidate[]): Promise<RepairCandidate | undefined> {
	interface Item extends vscode.QuickPickItem {
		candidate: RepairCandidate;
	}
	const items: Item[] = candidates.map((c) => ({
		label: candidateLabel(c),
		description: vscode.l10n.t('{0}% plausible', String(Math.round(c.score * 100))),
		detail: snippet(c.text),
		candidate: c,
	}));
	const pick = await vscode.window.showQuickPick(items, {
		placeHolder: vscode.l10n.t('Pick a repair — {0} candidate(s), most plausible first', String(candidates.length)),
		matchOnDetail: true,
	});
	return pick?.candidate;
}

async function chooseTarget(context?: vscode.ExtensionContext): Promise<EncodingSpec | undefined> {
	const lastTarget = context?.workspaceState.get<string>(`${PREFIX}.lastTarget`);
	const target = await pickTargetEncoding(lastTarget);
	if (target) {
		await context?.workspaceState.update(`${PREFIX}.lastTarget`, target.id);
	}
	return target;
}

/** Open a read-only diff: current on-disk bytes (garbled) vs the repaired text. */
async function showRepairDiff(uri: vscode.Uri, bytes: Uint8Array, candidate: RepairCandidate): Promise<void> {
	const left = await vscode.workspace.openTextDocument({ language: 'plaintext', content: decodeForDisplay(bytes) });
	const right = await vscode.workspace.openTextDocument({ language: 'plaintext', content: candidate.text });
	const title = vscode.l10n.t('{0}: garbled → repaired', vscode.workspace.asRelativePath(uri, false));
	await vscode.commands.executeCommand('vscode.diff', left.uri, right.uri, title);
}

/** Best-effort close of the read-only diff tab opened by showRepairDiff. */
async function closeDiffTab(): Promise<void> {
	try {
		await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
	} catch {
		// the tab may already be gone; nothing to clean up
	}
}

async function writeRepair(uri: vscode.Uri, text: string, target: EncodingSpec): Promise<void> {
	const out = iconv.encode(text, target.codec, { addBOM: target.bom });
	try {
		await writeFileAtomic(uri, out);
		vscode.window.showInformationMessage(
			vscode.l10n.t('Repaired {0} → {1}', vscode.workspace.asRelativePath(uri, false), displayName(target)),
		);
	} catch (e) {
		vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
	}
}

interface BatchRow {
	uri: vscode.Uri;
	candidate?: RepairCandidate;
	skipMessage?: string;
}

/** Dry-run list for multi-select / folders: best candidate per file, then overwrite. */
async function repairBatch(files: readonly vscode.Uri[], settings: AppSettings, context?: vscode.ExtensionContext): Promise<void> {
	const dirty = dirtyUris();
	let rows: BatchRow[] | undefined;
	try {
		rows = await vscode.window.withProgress<BatchRow[]>(
			{ location: vscode.ProgressLocation.Window, cancellable: true, title: vscode.l10n.t('Analyzing garbling') },
			async (progress, token) => {
				const out: BatchRow[] = [];
				const increment = 100 / Math.max(1, files.length);
				for (let i = 0; i < files.length; i++) {
					if (token.isCancellationRequested) {
						throw new vscode.CancellationError();
					}
					progress.report({ message: `${i + 1}/${files.length}`, increment });
					const uri = files[i];
					const guard = await readGuarded(uri, settings, dirty);
					if (guard.skip) {
						out.push({ uri, skipMessage: guard.message });
						continue;
					}
					const best = proposeRepairs(guard.bytes)[0];
					out.push(best ? { uri, candidate: best } : { uri, skipMessage: noRepairMessage() });
				}
				return out;
			},
		);
	} catch {
		rows = undefined;
	}
	if (!rows) {
		return; // user cancelled analysis
	}

	if (!rows.some((r) => r.candidate)) {
		vscode.window.showInformationMessage(vscode.l10n.t('No auto-repairable files found in the selection.'));
		return;
	}

	interface Item extends vscode.QuickPickItem {
		row: BatchRow;
	}
	const qp = vscode.window.createQuickPick<Item>();
	qp.canSelectMany = true;
	qp.matchOnDescription = true;
	qp.matchOnDetail = true;
	qp.placeholder = vscode.l10n.t('Confirm the files to repair (best candidate each), Enter to continue');
	qp.items = rows.map((r) =>
		r.candidate
			? {
					label: vscode.workspace.asRelativePath(r.uri, false),
					description: candidateLabel(r.candidate),
					detail: snippet(r.candidate.text),
					picked: true,
					row: r,
			  }
			: {
					label: `$(circle-slash) ${vscode.workspace.asRelativePath(r.uri, false)}`,
					description: r.skipMessage,
					row: r,
			  },
	);
	qp.show();
	const selected = await new Promise<readonly BatchRow[] | undefined>((resolve) => {
		let settled = false;
		qp.onDidAccept(() => {
			settled = true;
			resolve(qp.selectedItems.filter((i) => i.row.candidate).map((i) => i.row));
		});
		qp.onDidHide(() => {
			if (!settled) {
				resolve(undefined);
			}
		});
	});
	qp.dispose();
	if (!selected || selected.length === 0) {
		return;
	}

	const target = await chooseTarget(context);
	if (!target) {
		return;
	}

	// Re-check dirty right before writing (ADR-0002): the selection may have gone
	// stale while the user reviewed the list and picked a target encoding.
	const dirtyNow = dirtyUris();
	let done = 0;
	let failed = 0;
	for (const row of selected) {
		if (dirtyNow.has(row.uri.toString())) {
			failed++;
			continue;
		}
		try {
			const out = iconv.encode(row.candidate!.text, target.codec, { addBOM: target.bom });
			await writeFileAtomic(row.uri, out);
			done++;
		} catch {
			failed++;
		}
	}
	if (failed > 0) {
		vscode.window.showWarningMessage(
			vscode.l10n.t('Repaired {0} file(s) → {1} · {2} failed', String(done), displayName(target), String(failed)),
		);
	} else {
		vscode.window.showInformationMessage(vscode.l10n.t('Repaired {0} file(s) → {1}', String(done), displayName(target)));
	}
}
