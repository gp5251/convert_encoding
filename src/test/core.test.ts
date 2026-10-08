import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as iconv from 'iconv-lite';

import { strictDecode } from '../strict';
import { sniffBom } from '../bom';
import { hasBinaryExtension, looksBinary } from '../binary';
import { detectEncoding } from '../detect';
import { convertBytes } from '../convert';
import { CURATED_ENCODINGS, parseEncodingLabel, displayName, EncodingSpec } from '../encodings';
import { isExcludedPath } from '../util';

const CHINESE = '你好世界，这是一段用于编码转换测试的中文文本。包含标点、English words、数字 12345 以及混合内容，长度足够让编码探测器给出高置信度。';

function spec(id: string): EncodingSpec {
	const s = parseEncodingLabel(id);
	if (!s) {
		throw new Error(`bad spec id in test: ${id}`);
	}
	return s;
}

function toBuffer(bytes: Uint8Array): Buffer {
	return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

// ---------- encodings ----------

test('parseEncodingLabel: canonical ids claim BOM semantics', () => {
	assert.deepEqual(parseEncodingLabel('utf-16le'), { id: 'utf-16le', codec: 'utf-16le', bom: true });
	assert.deepEqual(parseEncodingLabel('UTF-8-BOM'), { id: 'utf-8-bom', codec: 'utf-8', bom: true });
	assert.deepEqual(parseEncodingLabel('utf-8'), { id: 'utf-8', codec: 'utf-8', bom: false });
});

test('parseEncodingLabel: loose aliases and passthrough', () => {
	assert.equal(parseEncodingLabel('utf8')?.id, 'utf-8');
	assert.equal(parseEncodingLabel('utf8bom')?.bom, true);
	assert.equal(parseEncodingLabel('latin1')?.id, 'iso-8859-1');
	assert.equal(parseEncodingLabel('koi8-r')?.codec, 'koi8-r');
	assert.equal(parseEncodingLabel('shiftjis')?.id, 'shift_jis');
	assert.equal(parseEncodingLabel('not-a-codec'), undefined);
	assert.equal(parseEncodingLabel('  '), undefined);
});

test('every curated encoding round-trips through parseEncodingLabel', () => {
	for (const e of CURATED_ENCODINGS) {
		assert.deepEqual(parseEncodingLabel(e.id), e, e.id);
		assert.ok(displayName(e).length > 0);
	}
});

test('every curated codec is registered in iconv-lite (bundle table sanity)', () => {
	// Guards against a bundled build that dropped an encoding table: each codec
	// the QuickPick offers must actually resolve.
	for (const e of CURATED_ENCODINGS) {
		assert.ok(iconv.encodingExists(e.codec), `${e.id} -> ${e.codec} missing from iconv-lite`);
	}
});

// ---------- batch excludes ----------

test('isExcludedPath prunes matched paths and keeps the rest', () => {
	const excludes = ['**/node_modules/**', '**/.git/**'];
	assert.equal(isExcludedPath('a/node_modules/b.js', excludes), true);
	assert.equal(isExcludedPath('deep/nested/node_modules/x/y.ts', excludes), true);
	assert.equal(isExcludedPath('src/.git/config', excludes), true);
	assert.equal(isExcludedPath('src/app.ts', excludes), false);
	assert.equal(isExcludedPath('a/b.js', []), false);
});

// ---------- BOM ----------

test('sniffBom recognizes all five BOM signatures', () => {
	assert.equal(sniffBom(Buffer.from([0xef, 0xbb, 0xbf, 0x61]))?.id, 'utf-8-bom');
	assert.equal(sniffBom(Buffer.from([0xff, 0xfe, 0x61, 0x00]))?.id, 'utf-16le');
	assert.equal(sniffBom(Buffer.from([0xfe, 0xff, 0x00, 0x61]))?.id, 'utf-16be');
	assert.equal(sniffBom(Buffer.from([0xff, 0xfe, 0x00, 0x00, 0x61]))?.id, 'utf-32le');
	assert.equal(sniffBom(Buffer.from([0x00, 0x00, 0xfe, 0xff, 0x00, 0x61]))?.id, 'utf-32be');
	assert.equal(sniffBom(Buffer.from('plain')), undefined);
});

// ---------- binary guard ----------

test('hasBinaryExtension matches case-insensitively and ignores dotfiles', () => {
	assert.equal(hasBinaryExtension('/a/b/c.PNG'), true);
	assert.equal(hasBinaryExtension('archive.tar.gz'), true);
	assert.equal(hasBinaryExtension('src/app.ts'), false);
	assert.equal(hasBinaryExtension('.gitignore'), false);
	assert.equal(hasBinaryExtension('noext'), false);
});

test('looksBinary detects NUL bytes within the scan window', () => {
	assert.equal(looksBinary(Buffer.from('text\u0000text')), true);
	assert.equal(looksBinary(Buffer.from('plain text')), false);
	const nulAfter8k = Buffer.alloc(9000, 0x61);
	nulAfter8k[8193] = 0;
	assert.equal(looksBinary(nulAfter8k), false); // outside scan window
});

// ---------- detection chain ----------

test('auto detection: BOM is definitive, even for NUL-laden UTF-16', () => {
	const utf16le = iconv.encode(CHINESE, 'utf-16le'); // iconv utf-16le codec adds no BOM
	const bom = Buffer.concat([Buffer.from([0xff, 0xfe]), toBuffer(utf16le)]);
	const r = detectEncoding(bom, 90);
	assert.equal(r.kind, 'ok');
	assert.equal(r.via, 'bom');
	assert.equal(r.spec.id, 'utf-16le');
});

test('auto detection: BOM-less valid UTF-8 wins via strict validation', () => {
	const r = detectEncoding(Buffer.from(CHINESE, 'utf-8'), 90);
	assert.equal(r.kind, 'ok');
	assert.equal(r.via, 'utf8');
	assert.equal(r.spec.id, 'utf-8');
});

test('auto detection: GBK bytes detected as GB18030 (superset) with high confidence', () => {
	const gbk = iconv.encode(CHINESE, 'gbk');
	const r = detectEncoding(gbk, 90);
	assert.equal(r.kind, 'ok');
	assert.equal(r.spec.codec, 'gb18030');
	assert.ok(r.confidence >= 90);
});

test('auto detection: strict decode verification rejects a lying detector', () => {
	// Craft bytes that chardet may score highly but that are NOT valid in the
	// claimed codec: the chain must fall through to low-confidence, not guess.
	// 0xD6 0xD0 is a valid GBK pair; 0xFF is not a valid GBK/GB18030 lead byte.
	const garbage = Buffer.from([0xd6, 0xd0, 0xff, 0x41, 0x42, 0x43]);
	const r = detectEncoding(garbage, 90);
	if (r.kind === 'ok') {
		// Whatever the chain accepted must be strictly, losslessly decodable.
		assert.notEqual(strictDecode(garbage, r.spec.codec), undefined);
	} else {
		assert.equal(r.kind, 'low-confidence');
	}
});

// ---------- conversion ----------

test('convert GBK -> UTF-8 preserves text', () => {
	const gbk = iconv.encode(CHINESE, 'gbk');
	const r = convertBytes(gbk, spec('gbk'), spec('utf-8'), 'fail');
	assert.equal(r.kind, 'ok');
	assert.equal(Buffer.from(r.bytes).toString('utf-8'), CHINESE);
});

test('target encoding alone determines BOM: strip and add', () => {
	const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(CHINESE, 'utf-8')]);
	const stripped = convertBytes(withBom, spec('utf-8-bom'), spec('utf-8'), 'fail');
	assert.equal(stripped.kind, 'ok');
	assert.ok(!Buffer.from(stripped.bytes).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])));

	const added = convertBytes(Buffer.from(CHINESE, 'utf-8'), spec('utf-8'), spec('utf-8-bom'), 'fail');
	assert.equal(added.kind, 'ok');
	assert.ok(Buffer.from(added.bytes).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])));
	assert.equal(Buffer.from(added.bytes).subarray(3).toString('utf-8'), CHINESE);
});

test('noop: file already in target encoding is reported, not converted', () => {
	assert.equal(convertBytes(Buffer.from(CHINESE, 'utf-8'), spec('utf-8'), spec('utf-8'), 'fail').kind, 'noop');
	// BOM re-added identically
	const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(CHINESE, 'utf-8')]);
	assert.equal(convertBytes(withBom, spec('utf-8-bom'), spec('utf-8-bom'), 'fail').kind, 'noop');
});

test('noop is byte-equality, not label equality: pure-ASCII to GBK is a no-op', () => {
	const ascii = Buffer.from('hello world 123', 'ascii');
	assert.equal(convertBytes(ascii, spec('utf-8'), spec('gbk'), 'fail').kind, 'noop');
});

test('BOM removal is a real conversion, never a no-op', () => {
	const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hello', 'utf-8')]);
	assert.equal(convertBytes(withBom, spec('utf-8-bom'), spec('utf-8'), 'fail').kind, 'ok');
});

test('unmappable characters: fail policy reports the first offending character', () => {
	const emoji = Buffer.from('ok \u{1F600} end', 'utf-8');
	const r = convertBytes(emoji, spec('utf-8'), spec('gbk'), 'fail');
	assert.equal(r.kind, 'unmappable');
	if (r.kind === 'unmappable') {
		assert.ok(r.count >= 1);
		assert.equal(r.firstChar, '\u{1F600}');
	}
});

test('unmappable characters: replace policy writes and counts replacements', () => {
	const emoji = Buffer.from('ok \u{1F600} end', 'utf-8');
	const r = convertBytes(emoji, spec('utf-8'), spec('gbk'), 'replace');
	assert.equal(r.kind, 'ok');
	if (r.kind === 'ok') {
		assert.ok(r.replaced >= 1);
		assert.ok(Buffer.from(r.bytes).includes(Buffer.from('?')));
	}
});

test('invalid source sequence: fatal decode refuses to corrupt', () => {
	const notGbk = Buffer.from([0xff, 0x41, 0x42]);
	assert.equal(convertBytes(notGbk, spec('gbk'), spec('utf-8'), 'fail').kind, 'invalid-source');
});

test('UTF-16LE -> UTF-8 conversion via BOM-detected source', () => {
	const utf16 = iconv.encode(CHINESE, 'utf-16le');
	const file = Buffer.concat([Buffer.from([0xff, 0xfe]), toBuffer(utf16)]);
	const r = convertBytes(file, spec('utf-16le'), spec('utf-8'), 'fail');
	assert.equal(r.kind, 'ok');
	assert.equal(Buffer.from(r.bytes).toString('utf-8'), CHINESE);
});

test('UTF-8 -> UTF-16LE target carries BOM', () => {
	const r = convertBytes(Buffer.from(CHINESE, 'utf-8'), spec('utf-8'), spec('utf-16le'), 'fail');
	assert.equal(r.kind, 'ok');
	if (r.kind === 'ok') {
		const b = Buffer.from(r.bytes);
		assert.ok(b.subarray(0, 2).equals(Buffer.from([0xff, 0xfe])));
		assert.equal(iconv.decode(b, 'utf-16le'), CHINESE);
	}
});

test('full round trip GBK -> UTF-8 -> GBK is byte-identical', () => {
	const original = iconv.encode(CHINESE, 'gbk');
	const toUtf8 = convertBytes(original, spec('gbk'), spec('utf-8'), 'fail');
	assert.equal(toUtf8.kind, 'ok');
	if (toUtf8.kind === 'ok') {
		const backToGbk = convertBytes(toUtf8.bytes, spec('utf-8'), spec('gbk'), 'fail');
		assert.equal(backToGbk.kind, 'ok');
		if (backToGbk.kind === 'ok') {
			assert.ok(Buffer.from(backToGbk.bytes).equals(Buffer.from(original)));
		}
	}
});
