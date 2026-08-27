import * as vscode from 'vscode';
import { CURATED_ENCODINGS, EncodingSpec, displayName, parseEncodingLabel } from './encodings';

interface EncodingPickItem extends vscode.QuickPickItem {
	spec?: EncodingSpec;
	isAuto?: boolean;
}

export type SourceChoice = { auto: true } | { spec: EncodingSpec };

async function pickCustomEncoding(): Promise<EncodingSpec | undefined> {
	const custom = await vscode.window.showInputBox({
		placeHolder: 'gbk, big5, koi8-r, cp1251, …',
		prompt: vscode.l10n.t('Enter an iconv-lite encoding id'),
		validateInput: (v) => (parseEncodingLabel(v) ? undefined : vscode.l10n.t('Unknown encoding label')),
	});
	return custom ? parseEncodingLabel(custom) : undefined;
}

export async function pickSourceEncoding(hint?: { label: string; confidence: number }): Promise<SourceChoice | undefined> {
	const autoLabel = hint
		? vscode.l10n.t('Auto (detected: {0} · {1}%)', hint.label, String(Math.round(hint.confidence)))
		: vscode.l10n.t('Auto (detect per file)');
	const items: EncodingPickItem[] = [
		{ label: autoLabel, description: 'auto', isAuto: true },
		...CURATED_ENCODINGS.map((e) => ({ label: displayName(e), description: e.id, spec: e })),
		{ label: vscode.l10n.t('Other… (type an encoding id)') },
	];
	const pick = await vscode.window.showQuickPick(items, {
		placeHolder: vscode.l10n.t('Source encoding — how the file is READ'),
	});
	if (!pick) {
		return undefined;
	}
	if (pick.isAuto) {
		return { auto: true };
	}
	if (pick.spec) {
		return { spec: pick.spec };
	}
	const custom = await pickCustomEncoding();
	return custom ? { spec: custom } : undefined;
}

/** Target picker; remembers the last choice by pre-selecting `lastId`. */
export async function pickTargetEncoding(lastId?: string): Promise<EncodingSpec | undefined> {
	const qp = vscode.window.createQuickPick<EncodingPickItem>();
	qp.items = [
		...CURATED_ENCODINGS.map((e) => ({ label: displayName(e), description: e.id, spec: e })),
		{ label: vscode.l10n.t('Other… (type an encoding id)') },
	];
	qp.placeholder = vscode.l10n.t('Target encoding — how the file is WRITTEN (determines BOM)');
	if (lastId) {
		const active = qp.items.find((i) => i.spec?.id === lastId);
		if (active) {
			qp.activeItems = [active];
		}
	}
	qp.show();
	const pick = await new Promise<EncodingPickItem | undefined>((resolve) => {
		qp.onDidAccept(() => resolve(qp.activeItems[0]));
		qp.onDidHide(() => resolve(undefined));
	});
	qp.dispose();
	if (!pick) {
		return undefined;
	}
	if (pick.spec) {
		return pick.spec;
	}
	return pickCustomEncoding();
}
