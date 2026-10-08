import * as vscode from 'vscode';
import { displayName } from './encodings';
import { PlanItem, SimCache, analyzeFile, dirtyUris, executePlanItems, planItemToOutcome } from './pipeline';
import { AppSettings } from './settings';
import { reportOutcomes, skipReasonText } from './report';

interface PreviewItem extends vscode.QuickPickItem {
	plan: PlanItem;
}

function toPreviewItem(p: PlanItem): PreviewItem {
	const rel = vscode.workspace.asRelativePath(p.uri, false);
	switch (p.kind) {
		case 'convert': {
			const lossy =
				p.replacedHint > 0 ? `  $(warning) ${vscode.l10n.t('{0} char(s) → ?', String(p.replacedHint))}` : '';
			return {
				label: rel,
				description: `${displayName(p.src)} → ${displayName(p.tgt)}${lossy}`,
				plan: p,
				picked: true,
			};
		}
		case 'already-target':
			return { label: `$(check) ${rel}`, description: vscode.l10n.t('already {0}', displayName(p.tgt)), plan: p };
		case 'skip':
			return { label: `$(circle-slash) ${rel}`, description: skipReasonText(p.reason, p.detail), plan: p };
		case 'fail':
			return { label: `$(error) ${rel}`, description: p.detail, plan: p };
	}
}

/**
 * Mandatory dry-run before any folder batch: analyze every file, show a
 * checkable list (convertible pre-checked, the rest annotated with reasons),
 * then execute the confirmed selection. Enter with no convertible file
 * checked cancels silently.
 */
export async function previewAndConvert(files: readonly vscode.Uri[], settings: AppSettings): Promise<void> {
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
		return; // user cancelled analysis
	}

	const convertible = items.filter((i) => i.kind === 'convert');
	const rest = items.filter((i) => i.kind !== 'convert');

	if (convertible.length === 0) {
		reportOutcomes(
			rest.map(planItemToOutcome),
			vscode.l10n.t('Convert to {0} · dry run', displayName(settings.targetSpec)),
		);
		return;
	}

	const qp = vscode.window.createQuickPick<PreviewItem>();
	qp.canSelectMany = true;
	qp.matchOnDescription = true;
	qp.title = vscode.l10n.t(
		'Convert to {0} — {1} convertible · {2} already target · {3} skipped · {4} failed',
		displayName(settings.targetSpec),
		String(convertible.length),
		String(items.filter((i) => i.kind === 'already-target').length),
		String(items.filter((i) => i.kind === 'skip').length),
		String(items.filter((i) => i.kind === 'fail').length),
	);
	qp.placeholder = vscode.l10n.t('Confirm the files to convert, Enter to start');
	qp.buttons = [{ iconPath: new vscode.ThemeIcon('check-all'), tooltip: vscode.l10n.t('Select / deselect all') }];
	qp.items = [...convertible.map(toPreviewItem), ...rest.map(toPreviewItem)];
	qp.show();

	const selected = await new Promise<readonly PlanItem[] | undefined>((resolve) => {
		let settled = false;
		qp.onDidTriggerButton(() => {
			// Derive the next state from the ACTUAL selection, not a cached flag: a
			// stale flag (initial `picked` vs. reality, or manual per-row edits between
			// clicks) made the first click a no-op or do the opposite.
			const convertItems = qp.items.filter((i) => i.plan.kind === 'convert');
			const allSelected = convertItems.every((i) => qp.selectedItems.includes(i));
			qp.selectedItems = allSelected ? [] : convertItems;
		});
		qp.onDidAccept(() => {
			settled = true;
			const chosen = qp.selectedItems;
			const plans = chosen.filter((i) => i.plan.kind === 'convert').map((i) => i.plan);
			// UX-2: the list also shows skipped/failed/already-target rows; if the user
			// ticked any of those they cannot be converted, so say so instead of
			// dropping them silently.
			const dropped = chosen.length - plans.length;
			if (dropped > 0) {
				void vscode.window.showInformationMessage(
					vscode.l10n.t('{0} non-convertible file(s) in the selection were ignored.', String(dropped)),
				);
			}
			resolve(plans);
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

	const outcomes = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Window, cancellable: true, title: vscode.l10n.t('Converting files') },
		(progress, token) => executePlanItems(selected, settings, progress, token),
	);
	reportOutcomes(
		outcomes,
		vscode.l10n.t('Convert to {0} · {1} file(s)', displayName(settings.targetSpec), String(selected.length)),
	);
}
