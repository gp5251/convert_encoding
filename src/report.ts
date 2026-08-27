import * as vscode from 'vscode';
import { displayName } from './encodings';
import { Outcome, SkipReason } from './pipeline';

let channel: vscode.OutputChannel | undefined;

function getChannel(): vscode.OutputChannel {
	channel ??= vscode.window.createOutputChannel('Convert Encoding');
	return channel;
}

export function skipReasonText(reason: SkipReason, detail?: string): string {
	switch (reason) {
		case 'dirty':
			return vscode.l10n.t('Skipped · file has unsaved changes');
		case 'binary':
			return vscode.l10n.t('Skipped · looks binary');
		case 'low-confidence':
			return vscode.l10n.t('Skipped · low detection confidence{0}', detail ? ` (${detail})` : '');
		case 'too-large':
			return vscode.l10n.t('Skipped · exceeds size limit ({0})', detail ?? '');
		case 'read-error':
			return vscode.l10n.t('Skipped · read error');
		case 'cancelled':
			return vscode.l10n.t('Skipped · cancelled');
	}
}

function outcomeLine(o: Outcome): string {
	const rel = vscode.workspace.asRelativePath(o.uri, false);
	switch (o.kind) {
		case 'converted':
			return `✓ ${rel}  ${displayName(o.src)} → ${displayName(o.tgt)}${
				o.replaced > 0 ? ' · ' + vscode.l10n.t('{0} char(s) replaced with ?', String(o.replaced)) : ''
			}`;
		case 'already-target':
			return `= ${rel}  ${vscode.l10n.t('already {0}', displayName(o.tgt))}`;
		case 'skipped':
			return `⚠ ${rel}  ${skipReasonText(o.reason, o.detail)}`;
		case 'failed':
			return `✗ ${rel}  ${o.detail}`;
	}
}

export function singleOutcomeMessage(o: Outcome): string {
	switch (o.kind) {
		case 'converted':
			return vscode.l10n.t('Converted: {0} → {1}', displayName(o.src), displayName(o.tgt));
		case 'already-target':
			return vscode.l10n.t('Already {0} — nothing to do', displayName(o.tgt));
		case 'skipped':
			return skipReasonText(o.reason, o.detail);
		case 'failed':
			return o.detail;
	}
}

/**
 * Log outcomes to the "Convert Encoding" channel, notify with a summary,
 * and auto-open the channel when anything was skipped or failed.
 */
export function reportOutcomes(outcomes: readonly Outcome[], header: string): void {
	const counts = {
		converted: 0,
		already: 0,
		skipped: 0,
		failed: 0,
	};
	for (const o of outcomes) {
		if (o.kind === 'converted') counts.converted++;
		else if (o.kind === 'already-target') counts.already++;
		else if (o.kind === 'skipped') counts.skipped++;
		else counts.failed++;
	}
	const summary = vscode.l10n.t(
		'Converted {0} · Already target {1} · Skipped {2} · Failed {3}',
		String(counts.converted),
		String(counts.already),
		String(counts.skipped),
		String(counts.failed),
	);

	if (outcomes.length === 1) {
		const o = outcomes[0];
		const message = `${singleOutcomeMessage(o)}${o.kind === 'converted' && o.replaced > 0 ? ' · ' + vscode.l10n.t('{0} char(s) replaced with ?', String(o.replaced)) : ''}`;
		if (o.kind === 'failed') {
			vscode.window.showErrorMessage(message);
		} else if (o.kind === 'skipped' || (o.kind === 'converted' && o.replaced > 0)) {
			vscode.window.showWarningMessage(message);
		} else {
			vscode.window.showInformationMessage(message);
		}
		return;
	}

	const ch = getChannel();
	ch.appendLine(header);
	for (const o of outcomes) {
		ch.appendLine(outcomeLine(o));
	}
	ch.appendLine(summary);
	ch.appendLine('');

	const hasIssues = counts.skipped > 0 || counts.failed > 0;
	if (hasIssues) {
		ch.show();
		vscode.window.showWarningMessage(summary);
	} else {
		vscode.window.showInformationMessage(summary);
	}
}
