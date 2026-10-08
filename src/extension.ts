import * as vscode from 'vscode';

/** Single source of truth for command ids, config section, and state keys. */
export const PREFIX = 'convertEncoding';

export function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(
		vscode.commands.registerCommand(`${PREFIX}.convert`, (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
			void runConvertCommand(uri, uris);
		}),
		vscode.commands.registerCommand(`${PREFIX}.convertWithOptions`, (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
			void runOptionsCommand(uri, uris, context);
		}),
		vscode.commands.registerCommand(`${PREFIX}.repair`, (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
			void runRepairCommand(uri, uris, context);
		}),
	);
}

export function deactivate() {}

/** Explorer passes (clicked, selected[]); command palette falls back to the active editor. */
function resolveTargetUris(uri?: vscode.Uri, uris?: vscode.Uri[]): vscode.Uri[] {
	const list = (uris?.length ? uris : uri ? [uri] : []).filter((u) => u.scheme === 'file');
	if (list.length > 0) {
		return list;
	}
	const active = vscode.window.activeTextEditor?.document.uri;
	return active?.scheme === 'file' ? [active] : [];
}

async function runConvertCommand(uri?: vscode.Uri, uris?: vscode.Uri[]) {
	const targets = resolveTargetUris(uri, uris);
	if (targets.length === 0) {
		vscode.window.showInformationMessage(vscode.l10n.t('Select a file or folder in the Explorer, or open a file first.'));
		return;
	}
	let settings: AppSettings;
	try {
		settings = loadSettings();
	} catch (e) {
		vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
		return;
	}
	await runConversion(targets, settings);
}

async function runOptionsCommand(uri?: vscode.Uri, uris?: vscode.Uri[], context?: vscode.ExtensionContext) {
	const targets = resolveTargetUris(uri, uris);
	if (targets.length === 0) {
		vscode.window.showInformationMessage(vscode.l10n.t('Select a file or folder in the Explorer, or open a file first.'));
		return;
	}
	let settings: AppSettings;
	try {
		settings = loadSettings();
	} catch (e) {
		vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
		return;
	}
	const hint = targets.length === 1 ? await detectHint(targets[0], settings) : undefined;
	const source = await pickSourceEncoding(hint);
	if (!source) {
		return;
	}
	const lastTarget = context?.workspaceState.get<string>(`${PREFIX}.lastTarget`);
	const targetSpec = await pickTargetEncoding(lastTarget);
	if (!targetSpec) {
		return;
	}
	await context?.workspaceState.update(`${PREFIX}.lastTarget`, targetSpec.id);
	await runConversion(targets, {
		...settings,
		sourceLabel: 'spec' in source ? source.spec.id : 'auto',
		sourceSpec: 'spec' in source ? source.spec : undefined,
		targetLabel: targetSpec.id,
		targetSpec,
	});
}

async function runRepairCommand(uri?: vscode.Uri, uris?: vscode.Uri[], context?: vscode.ExtensionContext) {
	const targets = resolveTargetUris(uri, uris);
	if (targets.length === 0) {
		vscode.window.showInformationMessage(vscode.l10n.t('Select a file or folder in the Explorer, or open a file first.'));
		return;
	}
	let settings: AppSettings;
	try {
		settings = loadSettings();
	} catch (e) {
		vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
		return;
	}
	await runRepair(targets, settings, context);
}

/**
 * Route a run: any folder → recursive collect + mandatory dry-run preview;
 * plain files → analyze and convert directly with a summary report.
 */
async function runConversion(targets: readonly vscode.Uri[], settings: AppSettings) {
	const files: vscode.Uri[] = [];
	const folders: vscode.Uri[] = [];
	for (const t of targets) {
		try {
			if ((await vscode.workspace.fs.stat(t)).type & vscode.FileType.Directory) {
				folders.push(t);
				continue;
			}
		} catch {
			// fall through: analysis will report the read error
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
		await previewAndConvert([...files, ...collected], settings);
		return;
	}

	if (files.length === 0) {
		return;
	}
	// More than one plain file is a batch too: route it through the same
	// mandatory dry-run preview a folder gets, so nothing is overwritten blind.
	if (files.length > 1) {
		await previewAndConvert(files, settings);
		return;
	}
	const dirty = dirtyUris();
	const cache = new SimCache();
	let items: PlanItem[] | undefined;
	try {
		items = await vscode.window.withProgress<PlanItem[]>(
			{ location: vscode.ProgressLocation.Window, cancellable: true, title: vscode.l10n.t('Analyzing encodings') },
			async (progress, token) => {
				const out: PlanItem[] = [];
				const increment = 100 / Math.max(1, files.length);
				for (let i = 0; i < files.length; i++) {
					if (token.isCancellationRequested) {
						throw new vscode.CancellationError();
					}
					progress.report({ message: `${i + 1}/${files.length}`, increment });
					out.push(await analyzeFile(files[i], settings, dirty, cache));
				}
				return out;
			},
		);
	} catch {
		items = undefined;
	}
	if (!items) {
		return; // user cancelled analysis
	}
	// A lossy (replace-policy) single-file convert destroys characters with no
	// undo: confirm before writing rather than only reporting afterwards.
	const lossy = items.find((i): i is Extract<PlanItem, { kind: 'convert' }> => i.kind === 'convert' && i.replacedHint > 0);
	if (lossy) {
		const proceed = vscode.l10n.t('Convert anyway');
		const choice = await vscode.window.showWarningMessage(
			vscode.l10n.t(
				'{0} character(s) cannot be represented in {1} and will be replaced with "?". This cannot be undone. Continue?',
				String(lossy.replacedHint),
				displayName(settings.targetSpec),
			),
			{ modal: true },
			proceed,
		);
		if (choice !== proceed) {
			return;
		}
	}
	const outcomes = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Window, cancellable: true, title: vscode.l10n.t('Converting files') },
		(progress, token) => executePlanItems(items, settings, progress, token),
	);
	reportOutcomes(
		outcomes,
		vscode.l10n.t('Convert to {0} · {1} file(s)', displayName(settings.targetSpec), String(items.length)),
	);
}

import { displayName } from './encodings';
import { collectFiles } from './batch';
import { PlanItem, SimCache, analyzeFile, detectHint, dirtyUris, executePlanItems } from './pipeline';
import { previewAndConvert } from './preview';
import { pickSourceEncoding, pickTargetEncoding } from './quickpick';
import { reportOutcomes } from './report';
import { runRepair } from './repairFlow';
import { AppSettings, loadSettings } from './settings';
