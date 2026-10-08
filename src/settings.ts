import * as vscode from 'vscode';
import { PREFIX } from './extension';
import { EncodingSpec, parseEncodingLabel } from './encodings';

export interface AppSettings {
	/** Raw source label: 'auto' or an encoding id. */
	readonly sourceLabel: string;
	/** Parsed source spec; undefined in auto mode. */
	readonly sourceSpec?: EncodingSpec;
	readonly targetLabel: string;
	readonly targetSpec: EncodingSpec;
	readonly onUnmappable: 'fail' | 'replace';
	readonly batchExcludes: readonly string[];
	/** 0 = unlimited. */
	readonly maxFileSizeBytes: number;
	/** 0..100. */
	readonly confidenceThreshold: number;
}

/** Throws a localized user-facing message on invalid settings. */
export function loadSettings(): AppSettings {
	const cfg = vscode.workspace.getConfiguration(PREFIX);
	const sourceLabel = (cfg.get<string>('sourceEncoding') ?? 'auto').trim();
	const targetLabel = (cfg.get<string>('targetEncoding') ?? 'utf-8').trim();
	const targetSpec = parseEncodingLabel(targetLabel);
	if (!targetSpec) {
		throw new Error(
			vscode.l10n.t("Invalid 'convertEncoding.targetEncoding': '{0}' is not a supported encoding label.", targetLabel),
		);
	}
	let sourceSpec: EncodingSpec | undefined;
	if (sourceLabel.toLowerCase() !== 'auto') {
		sourceSpec = parseEncodingLabel(sourceLabel);
		if (!sourceSpec) {
			throw new Error(
				vscode.l10n.t("Invalid 'convertEncoding.sourceEncoding': '{0}' is not a supported encoding label. Use 'auto' or a valid id.", sourceLabel),
			);
		}
	}
	const maxMB = cfg.get<number>('maxFileSizeMB') ?? 20;
	return {
		sourceLabel,
		sourceSpec,
		targetLabel,
		targetSpec,
		onUnmappable: cfg.get<string>('onUnmappable') === 'replace' ? 'replace' : 'fail',
		batchExcludes: cfg.get<string[]>('batchExcludes') ?? [],
		maxFileSizeBytes: Math.max(0, maxMB) * 1024 * 1024,
		confidenceThreshold: Math.min(100, Math.max(0, cfg.get<number>('detectionConfidenceThreshold') ?? 80)),
	};
}
