"""Build GitHub-ready distributions from an explicit repository allowlist."""
from pathlib import Path
import hashlib
import json
import shutil
import zipfile

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "release"
manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
version, plugin_id = manifest["version"], manifest["id"]
package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
assert version == package["version"], "Version mismatch"
OUT.mkdir(exist_ok=True)

runtime = ["main.js", "manifest.json", "styles.css", "THIRD_PARTY_NOTICES.md"]
root_files = runtime + ["README.md", "RELEASE_NOTES.md", "CHANGELOG.md", ".gitignore", "package.json", "package-lock.json", "versions.json", "tsconfig.json", "esbuild.config.mjs"]
if (ROOT / "LICENSE").is_file():
    root_files.append("LICENSE")
source = [ROOT / name for name in root_files]
for folder in ["src", "test", "docs", "scripts", ".github"]:
    source += [p for p in (ROOT / folder).rglob("*") if p.is_file() and not p.is_symlink()
               and p.suffix.lower() in {".ts", ".mjs", ".py", ".html", ".md", ".png", ".yml", ".yaml", ".css", ".json"}]
source = sorted(set(source))
assert all(p.is_file() and p.resolve().is_relative_to(ROOT) for p in source)

def archive(path, entries):
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as target:
        for file, name in entries:
            target.write(file, name)
    with zipfile.ZipFile(path) as target:
        assert target.testzip() is None
        for file, name in entries:
            assert target.read(name) == file.read_bytes(), name

installer = OUT / f"paper-easy-{version}.zip"
source_zip = OUT / f"paper-easy-{version}-source.zip"
archive(installer, [(ROOT / name, f"{plugin_id}/{name}") for name in runtime])
archive(source_zip, [(p, "paper-easy/" + p.relative_to(ROOT).as_posix()) for p in source])

assets = OUT / f"{version}-assets"
assets.mkdir(exist_ok=True)
asset_files = []
for path in [*(ROOT / name for name in runtime), ROOT / "RELEASE_NOTES.md", installer, source_zip]:
    destination = assets / path.name
    shutil.copyfile(path, destination)
    asset_files.append(destination)
checksums = assets / "SHA256SUMS.txt"
checksums.write_text("".join(f"{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n" for p in asset_files), encoding="utf-8")
asset_files.append(checksums)

start = OUT / f"START_HERE-{version}.md"
start.write_text(f"""# Paper-easy {version} GitHub 发布包

作者：{manifest['author']}

1. 将 repository/ **里面的内容**提交到 GitHub 仓库根目录，包含 .github/ 和 .gitignore。
2. 新建标签为 {version} 的 Release，粘贴 RELEASE_NOTES.md。
3. 将 release-assets/ 中的文件作为附件上传，保留 main.js、manifest.json、styles.css 三个独立文件。
4. 普通用户下载 {installer.name}；开发者可下载 {source_zip.name}。

详细说明见 repository/docs/PUBLISHING.md。此包不包含用户配置或论文，也没有自动上传到 GitHub。
""", encoding="utf-8")
bundle = OUT / f"paper-easy-{version}-github.zip"
prefix = f"paper-easy-{version}-github/"
archive(bundle, [(p, prefix + "repository/" + p.relative_to(ROOT).as_posix()) for p in source]
        + [(p, prefix + "release-assets/" + p.name) for p in asset_files]
        + [(start, prefix + "START_HERE.md"), (ROOT / "RELEASE_NOTES.md", prefix + "RELEASE_NOTES.md")])
print(f"Verified {len(source)} repository files and {len(asset_files)} release assets.")
print(bundle)
print(installer)
