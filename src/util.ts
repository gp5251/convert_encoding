import { minimatch } from 'minimatch';

/** Zero-copy Buffer view over a Uint8Array (workspace.fs.readFile result). */
export function toBuffer(bytes: Uint8Array): Buffer {
	return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) {
		return false;
	}
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) {
			return false;
		}
	}
	return true;
}

/**
 * Glob match against a path relative to the scan root (posix separators).
 * Matches the entry itself or anything beneath it, so a directory pattern
 * like `node_modules/**` prunes both the folder and its contents.
 * Pure (no vscode): unit-testable.
 */
export function isExcludedPath(rel: string, excludes: readonly string[]): boolean {
	return excludes.some((p) => p.length > 0 && (minimatch(rel, p) || minimatch(rel + '/**', p)));
}
