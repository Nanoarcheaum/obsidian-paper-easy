/** A write-ahead record makes a PDF/Markdown pair recoverable after interruption. */
export interface WriteRecord {
  id: string;
  sequence: number;
  pdfPath: string;
  notePath: string;
  beforeHash: string;
  afterHash: string;
  noteBefore: string;
  noteAfter: string;
  status: "pending" | "complete" | "undone";
}

export interface WriteStore {
  readPdf(path: string): Promise<ArrayBuffer>;
  writePdf(path: string, bytes: ArrayBuffer): Promise<void>;
  readNote(path: string): Promise<string>;
  processNote(path: string, change: (text: string) => string): Promise<unknown>;
  save(record: WriteRecord, backup?: ArrayBuffer): Promise<void>;
  backup(id: string): Promise<ArrayBuffer>;
  records(): Promise<WriteRecord[]>;
}

export class KeyedQueue {
  private tails = new Map<string, Promise<unknown>>();
  run<T>(key: string, action: () => Promise<T>): Promise<T> {
    const result = (this.tails.get(key) ?? Promise.resolve()).catch(() => {}).then(action);
    this.tails.set(key, result);
    void result.finally(() => { if (this.tails.get(key) === result) this.tails.delete(key); }).catch(() => {});
    return result;
  }
}

export async function digest(bytes: ArrayBuffer): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), n => n.toString(16).padStart(2, "0")).join("");
}

export class AnnotationWrites {
  private queue = new KeyedQueue();
  constructor(private store: WriteStore) {}

  run(pdfPath: string, notePath: string, transformPdf: (bytes: ArrayBuffer) => Promise<Uint8Array>, transformNote: (text: string) => string): Promise<void> {
    return this.queue.run(pdfPath, async () => {
      const records = await this.store.records();
      const pending = records.filter(r => r.pdfPath === pdfPath && r.status === "pending");
      if (pending.length) throw new Error("这篇论文有未完成的保存，请先运行“恢复未完成的批注同步”。");
      const before = await this.store.readPdf(pdfPath);
      const noteBefore = notePath ? await this.store.readNote(notePath) : "";
      const noteAfter = transformNote(noteBefore); // Validate Markdown boundaries before touching the PDF.
      const changed = await transformPdf(before);
      const after = changed.slice().buffer as ArrayBuffer;
      const record: WriteRecord = {
        id: crypto.randomUUID(), sequence: Math.max(0, ...records.filter(r => r.pdfPath === pdfPath).map(r => r.sequence)) + 1, pdfPath, notePath,
        beforeHash: await digest(before), afterHash: await digest(after),
        noteBefore, noteAfter, status: "pending"
      };
      await this.store.save(record, before);
      if (await digest(await this.store.readPdf(pdfPath)) !== record.beforeHash) {
        record.status = "undone";
        await this.store.save(record);
        throw new Error("PDF 已被其他操作修改，本次未覆盖。请重新选择批注。");
      }
      try {
        await this.store.writePdf(pdfPath, after);
        await this.finishNote(record);
        record.status = "complete";
        await this.store.save(record);
      } catch (error) {
        throw new Error(`保存尚未完成，恢复记录已保留；请运行“恢复未完成的批注同步”。${error instanceof Error ? error.message : ""}`);
      }
    });
  }

  private async finishNote(record: WriteRecord): Promise<void> {
    if (!record.notePath || record.noteBefore === record.noteAfter) return;
    await this.store.processNote(record.notePath, current => {
      if (current === record.noteAfter) return current;
      if (current !== record.noteBefore) throw new Error("伴随笔记已更改，未覆盖你的内容。请检查恢复记录。");
      return record.noteAfter;
    });
  }

  async recover(): Promise<{ recovered: number; conflicts: number }> {
    let recovered = 0;
    let conflicts = 0;
    for (const record of await this.store.records()) {
      if (record.status !== "pending") continue;
      await this.queue.run(record.pdfPath, async () => {
        try {
          const hash = await digest(await this.store.readPdf(record.pdfPath));
          if (hash === record.afterHash) {
            await this.finishNote(record);
            record.status = "complete";
          } else if (hash === record.beforeHash) {
            // The PDF was never committed. Do not replay a stale selection.
            record.status = "undone";
          } else throw new Error("PDF conflict");
          await this.store.save(record);
          recovered++;
        } catch { conflicts++; }
      });
    }
    return { recovered, conflicts };
  }

  undo(pdfPath: string): Promise<void> {
    return this.queue.run(pdfPath, async () => {
      const records = (await this.store.records()).filter(r => r.pdfPath === pdfPath);
      if (records.some(r => r.status === "pending")) throw new Error("请先恢复未完成的批注同步。");
      const record = records.filter(r => r.status === "complete").at(-1);
      if (!record) throw new Error("没有可撤销的批注操作。");
      if (await digest(await this.store.readPdf(pdfPath)) !== record.afterHash) throw new Error("PDF 后来已被修改，无法安全撤销；原文件备份仍在恢复目录。");
      if (record.notePath && await this.store.readNote(record.notePath) !== record.noteAfter) throw new Error("笔记后来已被修改，无法安全撤销；原内容仍在恢复记录。");
      const backup = await this.store.backup(record.id);
      if (await digest(backup) !== record.beforeHash) throw new Error("恢复备份校验失败，未修改文件。");
      // Undo is itself recoverable, including a failure of its Markdown write.
      const undo: WriteRecord = { ...record, id: crypto.randomUUID(), sequence: Math.max(...records.map(r => r.sequence)) + 1, beforeHash: record.afterHash, afterHash: record.beforeHash,
        noteBefore: record.noteAfter, noteAfter: record.noteBefore, status: "pending" };
      await this.store.save(undo, await this.store.readPdf(pdfPath));
      await this.store.writePdf(pdfPath, backup);
      await this.finishNote(undo);
      undo.status = "complete";
      await this.store.save(undo);
    });
  }
}
