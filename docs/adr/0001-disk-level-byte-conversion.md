# 磁盘级字节转换，而非包装 VSCode 编码 API

VSCode 内置的"通过编码保存"只作用于当前打开的单个缓冲区，受 `files.encoding` / `files.autoGuessEncoding` 支配，无独立探测，且必须先打开文件。决定：插件走磁盘级管线——`vscode.workspace.fs` 读原始字节，iconv-lite 解码/重编码，原位覆写——完全绕开 VSCode 编码管线。被否决的替代方案（自动 open → save with encoding → close 的包装实现）更简单，但源编码不可控、无法不打开文件批量处理，与"配置读取编码"这一核心需求直接冲突。

## Consequences

- 转换不经 TextDocument 模型，行尾符（CRLF/LF）作为普通字符原样保留，绝无 EOL 意外。
- 写盘后必须主动 reload 已打开的干净编辑器；脏缓冲文件必须拒绝（见 ADR-0002）。
