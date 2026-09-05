# Paper-easy 1.0.0

**作者：Nanoarcheaum**

Paper-easy 首个 1.0 版本：在 Obsidian 中完成论文阅读、PDF 批注、选段翻译与知识引用，让论文和自己的笔记留在同一套目录中。

## 主要功能

- 批量导入到不同学科目录，自动创建 PDF 与同名 Markdown。
- PDF 左、伴随笔记右的阅读布局。
- 高光、下划线、删除线和文字便签，支持编辑、删除及改色。
- 两行右键菜单，直接访问批注、引用、回链、截图和翻译。
- 框选截图自动进入笔记，附带原页链接。
- 可从其他笔记嵌入的稳定来源块。
- Ollama／兼容接口选段翻译，可保存原生 PDF 翻译批注。
- 完整批注检索、按论文折叠分组和块引用复制。
- 保存前备份、中断同步恢复和满足条件的单步撤销。
- 可选 Zotero 题录同步与共享 PDF。

## 本次发布调整

基于已完成的 0.9.0 初版，名称统一为 **Paper-easy**，版本统一为 **1.0.0**；插件作者与界面署名统一为 **Nanoarcheaum**，移除旧作者外链。补充面向 GitHub 的功能介绍、使用文档、发布指南和依赖许可声明。

保留 `ai4discovering-paper-notes` 插件 ID、既有块 ID 和用户配置。升级不会批量改写历史 PDF 批注作者；已有自定义批注作者设置继续生效。

## 下载与安装

一般用户下载 **paper-easy-1.0.0.zip**，将其中的插件目录放入 Vault 的 `.obsidian/plugins/` 下，再启用 Paper-easy。

已有用户先关闭插件，覆盖 main.js、manifest.json、styles.css，保留 data.json 和恢复目录，再启用。

main.js、manifest.json、styles.css 也作为独立 Release 附件提供。源码与文档可在仓库查看，或下载 paper-easy-1.0.0-source.zip。

## 验证与已知边界

自动化验证覆盖保存恢复、来源块处理、PDF 批注、翻译请求及 Zotero 匹配；另有浏览器夹具和内存 Vault 集成测试。具体结果见仓库 docs/VALIDATION.md。

真实 Obsidian 的主题、PDF++ 并存、多窗口和非 Windows 平台尚未完整验收。当前批注选区限定单页，Zotero 数据库批注不做双向同步。
