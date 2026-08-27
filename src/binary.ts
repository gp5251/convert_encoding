const BINARY_EXTENSIONS: Record<string, true> = {
	png: true, jpg: true, jpeg: true, gif: true, bmp: true, ico: true, webp: true, svgz: true, avif: true,
	pdf: true, ps: true, eps: true,
	zip: true, gz: true, tgz: true, bz2: true, xz: true, '7z': true, rar: true, tar: true, jar: true, war: true, ear: true,
	exe: true, dll: true, so: true, dylib: true, o: true, a: true, obj: true, lib: true, bin: true, class: true, pyc: true, node: true, wasm: true,
	woff: true, woff2: true, ttf: true, otf: true, eot: true,
	mp3: true, wav: true, ogg: true, flac: true, mp4: true, avi: true, mov: true, mkv: true, webm: true, flv: true,
	sqlite: true, db: true, mdb: true,
	apk: true, ipa: true, iso: true, img: true, dmg: true, pkg: true, msi: true, cab: true, de: true,
};

export function hasBinaryExtension(path: string): boolean {
	const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	const dot = path.lastIndexOf('.');
	if (dot <= slash + 1) {
		return false;
	}
	return path.slice(dot + 1).toLowerCase() in BINARY_EXTENSIONS;
}

/**
 * NUL-byte sniff over the first 8 KiB. Call only AFTER a BOM sniff:
 * BOM-less UTF-16/32 text files legitimately contain NUL bytes, but those
 * are claimed by their BOM before this check runs.
 */
export function looksBinary(bytes: Uint8Array, scanLength = 8192): boolean {
	const n = Math.min(bytes.length, scanLength);
	for (let i = 0; i < n; i++) {
		if (bytes[i] === 0) {
			return true;
		}
	}
	return false;
}
