import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as iconv from 'iconv-lite';

import { proposeRepairs, RepairCandidate } from '../repair';

/**
 * Simulate the classic mojibake pipeline: the true text's UTF-8 bytes were
 * misread with `wrongCodec`, and the resulting garbage was re-saved as UTF-8.
 */
function mojibakeFile(trueText: string, wrongCodec: string): Buffer {
	const garbled = iconv.decode(Buffer.from(trueText, 'utf-8'), wrongCodec);
	return Buffer.from(garbled, 'utf-8');
}

function texts(cs: RepairCandidate[]): string {
	return cs.map((c) => c.text).join(' | ');
}

// ---------- mojibake ----------

test('mojibake: UTF-8 misread as Latin-1 is recovered', () => {
	// A Latin-1 misread is always reversible: every byte is a valid Latin-1 char.
	const trueText = '中文测试内容 ABC123';
	const file = mojibakeFile(trueText, 'iso-8859-1');
	const cs = proposeRepairs(file);
	const hit = cs.find((c) => c.text === trueText);
	assert.ok(hit, `expected "${trueText}" among: ${texts(cs)}`);
	assert.equal(hit!.kind, 'mojibake');
	if (hit!.kind === 'mojibake') {
		assert.equal(hit!.correct.id, 'utf-8');
	}
});

test('mojibake: UTF-8 misread as GBK is recovered when the misread was lossless', () => {
	const trueText = '你好世界';
	const garbled = iconv.decode(Buffer.from(trueText, 'utf-8'), 'gbk');
	// Only assert recovery when no U+FFFD was introduced (i.e. truly reversible).
	if (!garbled.includes('\uFFFD')) {
		const cs = proposeRepairs(mojibakeFile(trueText, 'gbk'));
		assert.ok(cs.some((c) => c.text === trueText), `expected "${trueText}" among: ${texts(cs)}`);
	}
});

// ---------- segmented ----------

test('segmented: a GBK span inside ASCII is stitched back (the ld_prog.proto case)', () => {
	// ASCII "// " + GBK "文件" + ASCII "ID" — exactly the real garbled comment.
	const file = Buffer.concat([
		Buffer.from('// ', 'ascii'),
		iconv.encode('文件', 'gbk'),
		Buffer.from('ID', 'ascii'),
	]);
	const cs = proposeRepairs(file);
	const hit = cs.find((c) => c.kind === 'segmented' && c.text === '// 文件ID');
	assert.ok(hit, `expected segmented "// 文件ID" among: ${texts(cs)}`);
	if (hit && hit.kind === 'segmented') {
		assert.equal(hit.segment.id, 'gbk');
		assert.equal(hit.segmentCount, 1);
	}
});

test('segmented: several GBK spans separated by ASCII', () => {
	// "//" + GBK"选择的" + "FB" + GBK"名" (the real sChangeTo comment).
	const file = Buffer.concat([
		Buffer.from('//', 'ascii'),
		iconv.encode('选择的', 'gbk'),
		Buffer.from('FB', 'ascii'),
		iconv.encode('名', 'gbk'),
	]);
	const cs = proposeRepairs(file);
	assert.ok(
		cs.some((c) => c.kind === 'segmented' && c.text === '//选择的FB名'),
		`expected "//选择的FB名" among: ${texts(cs)}`,
	);
});

test('segmented: a whole-file GBK blob (no ASCII) decodes as a single span', () => {
	const file = iconv.encode('文件坐标变量名', 'gbk');
	const cs = proposeRepairs(file);
	assert.ok(
		cs.some((c) => c.kind === 'segmented' && c.text === '文件坐标变量名'),
		`expected the GBK text among: ${texts(cs)}`,
	);
});

// ---------- guards ----------

test('pure ASCII yields no candidates', () => {
	assert.equal(proposeRepairs(Buffer.from('hello world 123\r\n', 'ascii')).length, 0);
});

test('clean UTF-8 text is never proposed as its own repair (identity excluded)', () => {
	const original = '你好世界，这是正常的 UTF-8 文本。';
	assert.equal(
		proposeRepairs(Buffer.from(original, 'utf-8')).some((c) => c.text === original),
		false,
	);
});

test('candidates come back sorted by score, descending', () => {
	const cs = proposeRepairs(mojibakeFile('中文测试内容 ABC123', 'iso-8859-1'));
	for (let i = 1; i < cs.length; i++) {
		assert.ok(cs[i - 1].score >= cs[i].score);
	}
});
