# GitHub 发布指南

项目仓库：[Nanoarcheaum/obsidian-paper-easy](https://github.com/Nanoarcheaum/obsidian-paper-easy)。本指南说明如何重新打包和发布后续版本。

## 使用完整发布包

解压 `paper-easy-1.1.0-github.zip`：

- **repository/**：仓库根目录内容。将其中的文件提交到你的 GitHub 仓库，确保 README.md、manifest.json、src/ 等直接位于仓库根目录，而不是再套一层 repository/。
- **release-assets/**：1.1.0 发布附件，含三个独立插件文件、安装 ZIP、源码 ZIP、第三方声明和 SHA256SUMS.txt。
- **RELEASE_NOTES.md**：可直接复制到 GitHub Release 的介绍。
- **START_HERE.md**：快速上传说明。

仓库名称为 `obsidian-paper-easy`，简介：

> Lightweight PDF reading, annotation, translation and linked paper notes for Obsidian. / 轻量的 Obsidian 论文阅读、批注与选段翻译插件。

安装包见 [Releases](https://github.com/Nanoarcheaum/obsidian-paper-easy/releases)，运行结果见 [Actions](https://github.com/Nanoarcheaum/obsidian-paper-easy/actions)。

## 创建 Release

1. 提交 repository/ 中的内容，包括隐藏的 .github/ 与 .gitignore。
2. 在 GitHub 的 Releases 页面创建新发布，标签填写 **1.1.0**，与 manifest.json 完全一致；标题可写 **Paper-easy 1.1.0**。
3. 粘贴 RELEASE_NOTES.md 内容。
4. 上传 release-assets/ 中的附件，特别是 **main.js、manifest.json、styles.css 三个独立文件**；不能只上传 ZIP。
5. 检查附件和说明后发布。

独立文件的上传方式参考 [Obsidian 官方发布示例](https://github.com/obsidianmd/obsidian-developer-docs/blob/main/en/Plugins/Releasing/Release%20your%20plugin%20with%20GitHub%20Actions.md)。GitHub 发布和提交到 Obsidian 社区插件目录是不同步骤；本包不代表已通过社区审核。

## 从源码重新打包

需要 Node.js 24、npm、Python 3：

```sh
npm ci
npm test
npm run package
```

输出在 release/：

```text
paper-easy-1.1.0.zip
paper-easy-1.1.0-source.zip
paper-easy-1.1.0-github.zip
1.1.0-assets/
  main.js
  manifest.json
  styles.css
  THIRD_PARTY_NOTICES.md
  RELEASE_NOTES.md
  paper-easy-1.1.0.zip
  paper-easy-1.1.0-source.zip
  SHA256SUMS.txt
```

打包脚本使用明确的文件清单，排除 node_modules、历史 release、测试输出、交接对话及用户配置。许可证尚未指定；需要项目许可证时，请先按自己的选择添加 LICENSE 再重新打包。第三方依赖许可声明已经保留。

`.github/workflows/ci.yml` 只执行测试、构建和上传构建产物，不会自动发布 Release。
