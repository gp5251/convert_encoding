import * as iconv from 'iconv-lite';

/** A concrete encoding choice: iconv codec + BOM policy for output. */
export interface EncodingSpec {
	/** Canonical id used in settings/QuickPick (also the passthrough iconv label). */
	readonly id: string;
	/** iconv-lite codec label. */
	readonly codec: string;
	/** Whether encoded output includes a BOM. */
	readonly bom: boolean;
}

/** Curated list surfaced in the QuickPick; settings accept these ids or any iconv-lite label. */
export const CURATED_ENCODINGS: readonly EncodingSpec[] = [
	{ id: 'utf-8', codec: 'utf-8', bom: false },
	{ id: 'utf-8-bom', codec: 'utf-8', bom: true },
	{ id: 'utf-16le', codec: 'utf-16le', bom: true },
	{ id: 'utf-16be', codec: 'utf-16be', bom: true },
	{ id: 'gbk', codec: 'gbk', bom: false },
	{ id: 'gb18030', codec: 'gb18030', bom: false },
	{ id: 'big5', codec: 'big5', bom: false },
	{ id: 'shift_jis', codec: 'shift_jis', bom: false },
	{ id: 'euc-jp', codec: 'euc-jp', bom: false },
	{ id: 'euc-kr', codec: 'euc-kr', bom: false },
	{ id: 'windows-1252', codec: 'windows-1252', bom: false },
	{ id: 'iso-8859-1', codec: 'iso-8859-1', bom: false },
];

// Aliases that resolve to a canonical id before the loose (dash/underscore-stripped) match.
const ALIASES: Record<string, string> = {
	latin1: 'iso-8859-1',
};

/**
 * Parse a user-supplied encoding label (setting value or QuickPick entry).
 * Canonical ids win over iconv passthrough: `utf-16le` means "UTF-16 LE with BOM".
 * Returns undefined for labels iconv-lite cannot handle.
 */
export function parseEncodingLabel(label: string): EncodingSpec | undefined {
	const l = label.trim().toLowerCase();
	if (l.length === 0) {
		return undefined;
	}
	const wanted = ALIASES[l] ?? l;
	const loose = wanted.replace(/[-_]/g, '');
	const canonical = CURATED_ENCODINGS.find(
		(e) => e.id === wanted || e.id.replace(/[-_]/g, '') === loose,
	);
	if (canonical) {
		return canonical;
	}
	if (iconv.encodingExists(wanted)) {
		return { id: wanted, codec: wanted, bom: false };
	}
	return undefined;
}

const DISPLAY: Record<string, string> = {
	'utf-8': 'UTF-8',
	'utf-8-bom': 'UTF-8 with BOM',
	'utf-16le': 'UTF-16 LE (BOM)',
	'utf-16be': 'UTF-16 BE (BOM)',
	'utf-32le': 'UTF-32 LE (BOM)',
	'utf-32be': 'UTF-32 BE (BOM)',
	gbk: 'GBK',
	gb18030: 'GB18030',
	big5: 'Big5',
	shift_jis: 'Shift_JIS',
	'euc-jp': 'EUC-JP',
	'euc-kr': 'EUC-KR',
	'windows-1252': 'Windows-1252',
	'iso-8859-1': 'ISO-8859-1 (Latin-1)',
};

/** Human label for reports/QuickPick; exported as the single display vocabulary. */
export function displayName(spec: EncodingSpec): string {
	return DISPLAY[spec.id] ?? spec.id.toUpperCase();
}
