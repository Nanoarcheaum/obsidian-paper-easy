import { App, normalizePath } from "obsidian";
import { WriteRecord, WriteStore } from "./transactions";

export function vaultWriteStore(app: App, directory: string): WriteStore {
  const adapter = app.vault.adapter;
  const file = (path: string) => {
    const value = app.vault.getFileByPath(path);
    if (!value) throw new Error(`文件已移动或不存在：${path}`);
    return value;
  };
  const validPath = (path: string) => !path.startsWith("/") && !path.includes("\\") && !path.split("/").some(part => part === ".." || part === ".obsidian");
  const pathFor = (id: string, extension: string) => {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("无效恢复记录 ID");
    return normalizePath(`${directory}/${id}.${extension}`);
  };
  return {
    readPdf: path => app.vault.readBinary(file(path)),
    writePdf: (path, bytes) => app.vault.modifyBinary(file(path), bytes),
    readNote: path => app.vault.read(file(path)),
    processNote: (path, transform) => app.vault.process(file(path), transform),
    async save(record, backup) {
      if (!await adapter.exists(directory)) await adapter.mkdir(directory);
      if (backup) {
        await adapter.writeBinary(pathFor(record.id, "pdf"), backup);
        // Never overwrite the write-ahead record when marking completion.
        await adapter.write(pathFor(record.id, "json"), JSON.stringify(record));
      } else if (record.status !== "pending") {
        await adapter.write(pathFor(record.id, record.status), "1");
      }
      if (record.status === "complete") {
        // Keep three completed backups per PDF. Pending records are never pruned.
        try {
          const older = (await this.records()).filter(item => item.pdfPath === record.pdfPath && item.status === "complete").slice(0, -3);
          for (const item of older) {
            for (const extension of ["json", "pdf", "complete", "undone"]) {
              const path = pathFor(item.id, extension);
              if (await adapter.exists(path)) await adapter.remove(path);
            }
          }
        } catch { /* Retaining extra backups must not turn a successful save into a failure. */ }
      }
    },
    backup: id => adapter.readBinary(pathFor(id, "pdf")),
    async records() {
      if (!await adapter.exists(directory)) return [];
      const results: Array<{ record: WriteRecord; time: number }> = [];
      for (const path of (await adapter.list(directory)).files.filter(p => p.endsWith(".json"))) {
        const record = JSON.parse(await adapter.read(path)) as WriteRecord;
        if (!record || !/^[a-f0-9-]{36}$/.test(record.id) || !Number.isSafeInteger(record.sequence) || record.sequence < 1 || !["pending", "complete", "undone"].includes(record.status)
          || typeof record.pdfPath !== "string" || !validPath(record.pdfPath) || !record.pdfPath.endsWith(".pdf")
          || typeof record.notePath !== "string" || (record.notePath && (!validPath(record.notePath) || !record.notePath.endsWith(".md")))
          || typeof record.noteBefore !== "string" || typeof record.noteAfter !== "string"
          || normalizePath(path) !== pathFor(record.id, "json")
          || !/^[a-f0-9]{64}$/.test(record.beforeHash) || !/^[a-f0-9]{64}$/.test(record.afterHash)) throw new Error("恢复记录损坏，请检查 recovery 目录；未覆盖文件。");
        if (await adapter.exists(pathFor(record.id, "complete"))) record.status = "complete";
        if (await adapter.exists(pathFor(record.id, "undone"))) record.status = "undone";
        results.push({ record, time: (await adapter.stat(path))?.mtime ?? 0 });
      }
      return results.sort((a, b) => a.record.pdfPath.localeCompare(b.record.pdfPath) || a.record.sequence - b.record.sequence).map(item => item.record);
    }
  };
}
