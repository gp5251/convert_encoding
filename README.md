# Convert Encoding

Convert file encodings **on disk** — right-click a file, a multi-selection, or a whole folder in the VS Code Explorer. No need to open files; the bytes are decoded with the source encoding and re-encoded to the target, then written in place.

English UI by default; Simplified Chinese follows the VS Code display language.

## Why not "Save with Encoding"?

VS Code's built-in encoding switch works on the currently open editor buffer only: you must open each file, its interpretation depends on `files.encoding`, and it cannot batch. This extension operates at the byte level via `workspace.fs` + `iconv-lite` — fully deterministic source decoding, works without opening files, and scales to whole folders (see [ADR-0001](docs/adr/0001-disk-level-byte-conversion.md)).

## Commands

| Command | Where | Behavior |
|---|---|---|
| **Convert Encoding** | Explorer context menu, Editor title, Command Palette | One click: per-file detection or `convertEncoding.sourceEncoding`, writes `convertEncoding.targetEncoding` |
| **Convert Encoding with Options…** | Explorer context menu, Command Palette | QuickPick for source (with detected hint) and target; remembers your last target |
| **Repair Encoding (Fix Garbled Text)** | Explorer context menu, Editor context menu, Command Palette | Proposes scored repairs for garbled files (mojibake reversal + mixed-encoding segmentation); never auto-writes |

- Files (single or multi-select): analyze → convert directly → summary report.
- Folders (recursive): **mandatory dry-run preview** first — every file shown as `detected source → target` with skip reasons; confirm before anything is written.

## Data safety

Four deliberately strict defenses ([ADR-0002](docs/adr/0002-data-safety-first.md), [ADR-0003](docs/adr/0003-strict-decode-verification.md)):

1. **Dirty buffers are refused.** A file open in an editor with unsaved changes is never converted — saving afterwards would overwrite the converted bytes. Clean editors auto-reload from disk.
2. **Unmappable characters fail hard by default** (`convertEncoding.onUnmappable: "fail"`). Emoji→GBK etc. leaves the file untouched with the exact character reported. Switch to `"replace"` to substitute `?` with a warning. Never silent.
3. **Binary guard (auto mode only):** binary extensions and NUL-byte sniffing (first 8 KiB) cause a skip. Not applicable when you explicitly declare the source encoding — that is an informed act, e.g. BOM-less UTF-16 text.
4. **Strict decode verification:** every decode is verified losslessly (decode → re-encode → byte-compare). The detector proposes; the decoder disposes. Invalid sequences can never become silent U+FFFD garbage.

### Semantics

- **Target encoding alone determines the BOM**: `UTF-8` strips any existing BOM, `UTF-8 with BOM` always writes one, `UTF-16 LE/BE` carry theirs.
- **Already-target files are skipped without writing** (byte-level comparison, so GBK files identical under gb18030 also qualify).
- Line endings are preserved verbatim — conversion is byte-level and never passes through the editor model.
- No `.bak` files; your VCS plus the dry-run preview are the safety net.

## Detection chain (`auto`)

1. BOM sniff (UTF-8 / UTF-16 LE+BE / UTF-32 LE+BE) — definitive.
2. Strict UTF-8 validation — a clean lossless decode is conclusive (covers ASCII).
3. [`chardet`](https://github.com/runk/node-chardet) ranked candidates with confidence ≥ threshold, each verified by strict decode — first clean decodable wins.

Below-threshold results skip the file ("low confidence"), they never guess-and-write.

## Repairing garbled files

`Convert Encoding` assumes a file is in ONE encoding. Two real-world cases break that assumption, and the separate **Repair Encoding** command handles them:

- **Mojibake** — the bytes decode cleanly (often as UTF-8) but the *text* is garbage like `锟斤拷`, `Ã©Â¸` or `浣犲ソ`, because the content was misread once and re-saved. Repair reverses it: re-encode the garbled text with the misused codec, then strictly decode with the correct one.
- **Mixed encodings** — a mostly-UTF-8 file with foreign byte spans spliced in (e.g. GBK comments inside a UTF-8 source file). Repair decodes each non-ASCII run as UTF-8 first, falling back to a CJK codec for runs that are not valid UTF-8 end-to-end.

Repair is heuristic, so it **never auto-writes**: it proposes scored candidates, you pick one, a diff preview (`garbled → repaired`) opens, and only a modal confirmation overwrites the file. A single file gets the full picker; folders and multi-select get a dry-run list using each file's best candidate.

> Repair cannot recover *irreversible* damage. If bytes were already replaced — a full-width `；` (`EF BC 9B`) corrupted to `EF BC 3F`, or text lost to `?`/U+FFFD — no decoding can bring the original back; that is what version control is for. The command then reports "no auto-repairable garbling" instead of guessing. See [ADR-0004](docs/adr/0004-repair-candidates-and-preview.md).

## Settings

| Setting | Default | Description |
|---|---|---|
| `convertEncoding.sourceEncoding` | `"auto"` | Source encoding for the one-click command; any iconv-lite id overrides detection |
| `convertEncoding.targetEncoding` | `"utf-8"` | Target encoding id (canonical ids: `utf-8`, `utf-8-bom`, `utf-16le`, `utf-16be`) |
| `convertEncoding.onUnmappable` | `"fail"` | `"fail"` rejects the file; `"replace"` substitutes `?` |
| `convertEncoding.batchExcludes` | node_modules/.git/.svn/.hg | Globs excluded from folder scans |
| `convertEncoding.maxFileSizeMB` | `20` | Skip files above this size; 0 = unlimited |
| `convertEncoding.detectionConfidenceThreshold` | `90` | Minimum confidence for auto-detection acceptance |

Settings accept any iconv-lite encoding label (GBK, GB18030, Big5, Shift_JIS, EUC-JP/KR, KOI8-R, windows-125x…); invalid labels are rejected up front.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # 21 unit tests over the conversion core
npm run build       # esbuild bundle → dist/extension.js
npm run package     # vsce package → .vsix
```

Publisher placeholder `changeencoding` in `package.json` must be replaced before publishing to the Marketplace.
