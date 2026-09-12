# Paper-easy 1.1.0

**作者：Nanoarcheaum**

本次更新在 PDF 选区右键菜单中加入“公式转 MD”。它调用设置中的本地 Ollama 模型，把 PDF 文字层中常见的扁平上下标、分式、希腊字母、根式和矩阵还原为 Obsidian 可渲染的 Markdown/LaTeX。

## 新功能

- 选中 PDF 公式后右键选择“公式转 MD”。
- 输出统一为 Obsidian 支持的行内 `$...$` 或独立 `$$...$$` 公式。
- 结果卡片保留原始选区，便于写入前核对。
- 支持复制 Markdown，或写入同名伴随笔记并附上 PDF 页码回链。
- 只调用本地 Ollama；若当前翻译服务不是 Ollama，会提示切换设置。

## 安装

下载 **paper-easy-1.1.0.zip**，把其中的 `ai4discovering-paper-notes` 目录放入 Vault 的 `.obsidian/plugins/` 下并启用。升级时保留插件目录中的 `data.json` 和恢复目录。

公式转写的准确性取决于 PDF 文字层和本地模型。复杂公式写入笔记前，请先在结果卡片中核对。
