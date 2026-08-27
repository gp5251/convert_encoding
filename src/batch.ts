import * as vscode from 'vscode';
import { minimatch } from 'minimatch';

/**
 * Recursively collect files under `root`, pruning excluded directories.
 * Symbolic links (files and directories) are never followed.
 */
export async function collectFiles(
	root: vscode.Uri,
	excludes: readonly string[],
	token: vscode.CancellationToken,
): Promise<vscode.Uri[]> {
	const files: vscode.Uri[] = [];
	await walk(root, '', files, excludes, token);
	return files;
}

async function walk(
	dir: vscode.Uri,
	rel: string,
	out: vscode.Uri[],
	excludes: readonly string[],
	token: vscode.CancellationToken,
): Promise<void> {
	if (token.isCancellationRequested) {
		throw new vscode.CancellationError();
	}
	let entries: [string, vscode.FileType][];
	try {
		entries = await vscode.workspace.fs.readDirectory(dir);
	} catch {
		return; // unreadable directory: skip silently, the per-file report covers files
	}
	for (const [name, type] of entries) {
		if (token.isCancellationRequested) {
			throw new vscode.CancellationError();
		}
		if (type & vscode.FileType.SymbolicLink) {
			continue;
		}
		const childRel = rel ? `${rel}/${name}` : name;
		if (type & vscode.FileType.Directory) {
			if (!isExcludedPath(childRel + '/', excludes)) {
				await walk(vscode.Uri.joinPath(dir, name), childRel, out, excludes, token);
			}
		} else if (type & vscode.FileType.File) {
			if (!isExcludedPath(childRel, excludes)) {
				out.push(vscode.Uri.joinPath(dir, name));
			}
		}
	}
}

/** Glob match against the path relative to the scan root, posix separators. */
function isExcludedPath(rel: string, excludes: readonly string[]): boolean {
	return excludes.some((p) => p.length > 0 && (minimatch(rel, p) || minimatch(rel + '/**', p)));
}
