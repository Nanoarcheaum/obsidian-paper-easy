import {
  App,
  Editor,
  FileSystemAdapter,
  ItemView,
  Menu,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  SuggestModal,
  TFile,
  TFolder,
  WorkspaceLeaf,
  normalizePath,
  parseYaml,
  setIcon
} from "obsidian";
import {
  appendPaperBlock,
  repairBlockReferences,
  paperTags,
  PaperBlock,
  PaperAnnotationIndex,
  PaperRecord,
  annotationEmbed,
  buildAnnotation,
  buildFigureAnnotation,
  buildMarkupAnnotation,
  buildPaperNote,
  parsePaperBlocks,
  parseAnnotationIndex,
  parsePaperLink,
  removeMarkupBlock,
  safeStem,
  updateMarkupBlockComment
} from "./paper";
import { AnnotationWrites, KeyedQueue } from "./transactions";
import { vaultWriteStore } from "./write-store";
import { translateText } from "./translator";
import { matchZoteroAttachment } from "./zotero-matching";
import { ZoteroCreator, ZoteroLocalClient } from "./zotero";
import {
  PdfAnnotationSummary,
  PdfRect,
  TextMarkupSubtype,
  deletePdfAnnotation,
  readPdfAnnotations,
  updatePdfAnnotationContents,
  updatePdfAnnotationColor,
  writeTextMarkupAnnotation,
  writeTextNoteAnnotation
} from "./pdf-annotations";

const VIEW_TYPE = "ai4d-paper-library";
const ANNOTATION_VIEW_TYPE = "ai4d-annotation-sidebar";

interface PaperNotesSettings {
  openSideBySide: boolean;
  defaultStatus: string;
  zoteroEnabled: boolean;
  zoteroBaseUrl: string;
  zoteroApiKey: string;
  translationEndpoint: string;
  translationApiKey: string;
  translationModel: string;
  targetLanguage: string;
  preservePdfColors: boolean;
  translationPreset: "custom" | "deepseek" | "ollama";
  annotationColor: string;
  annotationAuthor: string;
}

interface PdfTextSelection {
  pdf: TFile;
  text: string;
  page: number;
  rect: DOMRect;
  range: Range;
  pdfRects: PdfRect[];
  modified: number;
}

interface ImportAssignment {
  source: File;
  destinationFolder: string;
}

const DEFAULT_SETTINGS: PaperNotesSettings = {
  openSideBySide: true,
  defaultStatus: "unread",
  zoteroEnabled: false,
  zoteroBaseUrl: "http://localhost:23119/api",
  zoteroApiKey: "",
  translationEndpoint: "http://localhost:11434/api/chat",
  translationApiKey: "",
  translationModel: "qwen3:14b",
  targetLanguage: "简体中文",
  preservePdfColors: true,
  translationPreset: "ollama",
  annotationColor: "#ffd54f",
  annotationAuthor: "Nanoarcheaum"
};

export default class PaperNotesPlugin extends Plugin {
  settings: PaperNotesSettings = DEFAULT_SETTINGS;
  private writes!: AnnotationWrites;
  private companionQueue = new KeyedQueue();
  private translationRequest = 0;
  private disposed = false;
  private zoteroBusy = false;
  private importing = false;
  private annotationCache = new Map<string, { mtime: number; title: string; pdf: string; rows: PaperAnnotationIndex[] }>();
  private notePairs = new WeakMap<WorkspaceLeaf, WorkspaceLeaf>();
  private selectionTrigger: HTMLElement | null = null;
  private translationCard: HTMLElement | null = null;
  private figureCaptureCleanup: (() => void) | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.writes = new AnnotationWrites(vaultWriteStore(this.app, `${this.manifest.dir}/recovery`));
    this.addCommand({ id: "recover-annotation-writes", name: "恢复未完成的批注同步", callback: () => void this.recoverWrites() });
    this.addCommand({ id: "undo-pdf-annotation", name: "撤销当前论文上一次批注操作", callback: () => void this.undoAnnotation() });
    this.addCommand({ id: "repair-paper-blocks", name: "修复当前论文旧摘录的块引用", callback: () => void this.repairCurrentBlocks() });
    document.querySelectorAll(".ai4d-pdf-action").forEach(element => element.remove());
    this.applyPdfColorPreference();
    this.registerView(VIEW_TYPE, leaf => new PaperLibraryView(leaf, this));
    this.registerView(ANNOTATION_VIEW_TYPE, leaf => new AnnotationSidebarView(leaf, this));
    this.addRibbonIcon("folders", "Paper 文件", () => void this.activateLibrary());
    this.addRibbonIcon("list-filter", "检索论文批注", () => void this.activateAnnotationSidebar());
    this.addRibbonIcon("file-plus-2", "批量导入论文", () => this.choosePdfs());
    this.addRibbonIcon("languages", "翻译当前论文选段", () => {
      const pdf = this.activePdf();
      if (pdf) void this.translateSelection(pdf);
      else new Notice("请先打开一篇 PDF 或它的伴随笔记");
    });

    this.addCommand({ id: "import-papers", name: "导入 PDF 并创建伴随笔记", callback: () => this.choosePdfs() });
    this.addCommand({ id: "open-paper-library", name: "打开 Paper 文件", callback: () => void this.activateLibrary() });
    this.addCommand({ id: "open-annotation-sidebar", name: "打开论文批注边栏", callback: () => void this.activateAnnotationSidebar() });
    this.addCommand({ id: "open-or-create-paper-note", name: "打开当前 PDF 的伴随笔记", checkCallback: checking => {
      const file = this.app.workspace.getActiveFile();
      if (file?.extension !== "pdf") return false;
      if (!checking) void this.openPaper(file);
      return true;
    }});
    this.addCommand({ id: "capture-paper-annotation", name: "记录当前论文摘录", hotkeys: [{ modifiers: ["Mod", "Shift"], key: "e" }], checkCallback: checking => {
      const pdf = this.activePdf();
      if (!pdf) return false;
      if (!checking) void this.captureAnnotation(pdf);
      return true;
    }});
    this.addCommand({ id: "capture-paper-figure", name: "截取论文图像批注", hotkeys: [{ modifiers: ["Mod", "Shift"], key: "g" }], checkCallback: checking => {
      const pdf = this.activePdf();
      if (!pdf) return false;
      if (!checking) this.startFigureCapture(pdf);
      return true;
    }});
    this.addCommand({ id: "manage-pdf-annotations", name: "管理当前 PDF 批注", checkCallback: checking => {
      const pdf = this.activePdf();
      if (!pdf) return false;
      if (!checking) void this.managePdfAnnotations(pdf);
      return true;
    }});
    this.addCommand({ id: "insert-paper-block", name: "插入论文块引用", editorCallback: editor => void this.choosePaperBlock(editor) });
    this.addCommand({ id: "sync-zotero", name: "从 Zotero 同步论文元数据", callback: () => void this.syncFromZotero() });
    this.addCommand({ id: "send-paper-to-zotero", name: "将当前论文链接到 Zotero", checkCallback: checking => {
      const pdf = this.activePdf();
      if (!pdf) return false;
      if (!checking) void this.sendToZotero(pdf);
      return true;
    }});
    this.addCommand({ id: "translate-paper-selection", name: "翻译当前论文选段", hotkeys: [{ modifiers: ["Mod", "Shift"], key: "t" }], checkCallback: checking => {
      const pdf = this.activePdf();
      if (!pdf) return false;
      if (!checking) void this.translateSelection(pdf);
      return true;
    }});

    this.registerEvent(this.app.workspace.on("file-menu", (menu: Menu, file) => {
      if (!(file instanceof TFile) || file.extension !== "pdf") return;
      menu.addItem(item => item.setTitle("打开论文与伴随笔记").setIcon("panel-right-open").onClick(() => void this.openPaper(file)));
      menu.addItem(item => item.setTitle("记录论文摘录").setIcon("highlighter").onClick(() => void this.captureAnnotation(file)));
      menu.addItem(item => item.setTitle("截取图像批注").setIcon("scan-line").onClick(() => this.startFigureCapture(file)));
      menu.addItem(item => item.setTitle("管理 PDF 批注").setIcon("list-checks").onClick(() => void this.managePdfAnnotations(file)));
      menu.addItem(item => item.setTitle("翻译论文选段").setIcon("languages").onClick(() => void this.translateSelection(file)));
      if (this.settings.zoteroEnabled) menu.addItem(item => item.setTitle("链接到 Zotero").setIcon("refresh-cw").onClick(() => void this.sendToZotero(file)));
    }));
    this.registerEvent(this.app.metadataCache.on("changed", file => {
      if (file.extension === "md") { this.annotationCache.delete(file.path); this.refreshLibrary(); }
    }));
    this.registerEvent(this.app.workspace.on("active-leaf-change", leaf => { this.dismissTranslationUi(); this.stopFigureCapture(); this.decoratePdfView(leaf); }));
    this.registerDomEvent(document, "contextmenu", event => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest(".workspace-leaf-content[data-type='pdf']")) return;
      const annotationEl = target.closest<HTMLElement>("[data-annotation-id]");
      if (annotationEl?.dataset.annotationId) {
        const leaf = this.app.workspace.getLeavesOfType("pdf").find(candidate => candidate.view.containerEl.contains(target));
        const pdf = leaf ? this.app.vault.getFileByPath(String(leaf.getViewState().state?.file || "")) : null;
        const pageEl = target.closest<HTMLElement>(".page");
        const page = Number(pageEl?.dataset.pageNumber || pageEl?.getAttribute("data-page-number") || "1");
        if (pdf?.extension === "pdf") {
          event.preventDefault();
          event.stopPropagation();
          void this.showExistingAnnotationMenu(pdf, page, annotationEl.dataset.annotationId, event);
          return;
        }
      }
      const selection = this.readPdfSelection();
      if (!selection) return;
      event.preventDefault();
      event.stopPropagation();
      this.showPdfSelectionTrigger(selection, { x: event.clientX, y: event.clientY });
    }, true);
    this.registerDomEvent(document, "mousedown", event => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest(".ai4d-selection-toolbar, .ai4d-translation-card")) this.dismissTranslationUi();
    }, true);
    this.app.workspace.onLayoutReady(() => {
      for (const leaf of this.app.workspace.getLeavesOfType("pdf")) this.decoratePdfView(leaf);
    });
    this.registerEvent(this.app.workspace.on("layout-change", () => {
      for (const leaf of this.app.workspace.getLeavesOfType("pdf")) this.decoratePdfView(leaf);
    }));
    this.registerDomEvent(document, "keydown", event => {
      if (event.key === "Escape") this.dismissTranslationUi();
    });
    this.registerDomEvent(document, "scroll", event => {
      const target = event.target;
      if (target instanceof HTMLElement && target.closest(".workspace-leaf-content[data-type='pdf']")) this.dismissTranslationUi();
    }, true);
    this.registerEvent(this.app.vault.on("rename", () => { this.annotationCache.clear(); this.refreshLibrary(); }));
    this.registerEvent(this.app.vault.on("delete", () => { this.annotationCache.clear(); this.refreshLibrary(); }));
    this.addSettingTab(new PaperNotesSettingTab(this.app, this));
  }

  onunload(): void {
    this.disposed = true;
    document.querySelectorAll(".ai4d-markup-flash").forEach(el => el.remove());
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
    this.app.workspace.detachLeavesOfType(ANNOTATION_VIEW_TYPE);
    document.body.removeClass("ai4d-preserve-pdf-colors");
    document.querySelectorAll(".ai4d-pdf-action").forEach(element => element.remove());
    this.dismissTranslationUi();
    this.stopFigureCapture();
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<PaperNotesSettings> | null);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  applyPdfColorPreference(): void {
    document.body.toggleClass("ai4d-preserve-pdf-colors", this.settings.preservePdfColors);
  }


  private decoratePdfView(leaf: WorkspaceLeaf | null): void {
    if (!leaf || leaf.view.getViewType() !== "pdf") return;
    const actions = leaf.view.containerEl.querySelector<HTMLElement>(".view-actions");
    if (!actions) return;
    if (actions.querySelectorAll(".ai4d-pdf-action").length === 4) return;
    actions.querySelectorAll(".ai4d-pdf-action").forEach(element => element.remove());
    const annotate = actions.createEl("button", { cls: "clickable-icon view-action ai4d-pdf-action", attr: { "aria-label": "记录论文摘录" } });
    setIcon(annotate, "highlighter");
    annotate.addEventListener("click", () => {
      const filePath = String(leaf.getViewState().state?.file || "");
      const pdf = this.app.vault.getFileByPath(filePath);
      if (pdf) void this.captureAnnotation(pdf);
    });
    const captureFigure = actions.createEl("button", { cls: "clickable-icon view-action ai4d-pdf-action", attr: { "aria-label": "截取图像批注" } });
    setIcon(captureFigure, "scan-line");
    captureFigure.addEventListener("click", () => {
      const filePath = String(leaf.getViewState().state?.file || "");
      const pdf = this.app.vault.getFileByPath(filePath);
      if (pdf) this.startFigureCapture(pdf);
    });
    const manage = actions.createEl("button", { cls: "clickable-icon view-action ai4d-pdf-action", attr: { "aria-label": "管理 PDF 批注" } });
    setIcon(manage, "list-checks");
    manage.addEventListener("click", () => {
      const filePath = String(leaf.getViewState().state?.file || "");
      const pdf = this.app.vault.getFileByPath(filePath);
      if (pdf) void this.managePdfAnnotations(pdf);
    });
    const translate = actions.createEl("button", { cls: "clickable-icon view-action ai4d-pdf-action", attr: { "aria-label": "翻译论文选段" } });
    setIcon(translate, "languages");
    translate.addEventListener("click", () => {
      const filePath = String(leaf.getViewState().state?.file || "");
      const pdf = this.app.vault.getFileByPath(filePath);
      if (pdf) void this.translateSelection(pdf);
    });
  }

  async activateLibrary(): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getLeftLeaf(false) ?? this.app.workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
  }

  async activateAnnotationSidebar(): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(ANNOTATION_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf(true);
      await leaf.setViewState({ type: ANNOTATION_VIEW_TYPE, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
  }

  choosePdfs(): void {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/pdf,.pdf";
    input.multiple = true;
    input.addEventListener("change", () => {
      const files = Array.from(input.files ?? []);
      if (!files.length) return;
      const active = this.app.workspace.getActiveFile();
      const defaultFolder = active?.parent?.path ?? "";
      new BatchImportModal(this.app, files, defaultFolder, assignments => void this.importFiles(assignments)).open();
    }, { once: true });
    input.click();
  }

  private async importFiles(assignments: ImportAssignment[]): Promise<void> {
    if (!assignments.length || this.importing) return;
    this.importing = true;
    let last: TFile | null = null;
    let imported = 0;
    const failures: string[] = [];
    for (const { source, destinationFolder } of assignments) {
      try {
        const stem = safeStem(source.name);
        const paperFolder = this.availablePaperFolder(destinationFolder, stem);
        const bytes = await source.arrayBuffer();
        if (!new TextDecoder('latin1').decode(bytes.slice(0, 1024)).includes('%PDF-')) throw new Error("文件不是有效 PDF");
        const pdfPath = normalizePath(`${paperFolder}/${stem}.pdf`);
        const pendingPath = await this.savePending("pending-imports", crypto.randomUUID(), { pdfPath, title: stem });
        await this.app.vault.createFolder(paperFolder);
        const importedPdf = await this.app.vault.createBinary(pdfPath, bytes);
        const notePath = pdfPath.replace(/\.pdf$/i, ".md");
        const note = await this.app.vault.create(notePath, buildPaperNote(pdfPath, stem));
        await this.applyDefaultStatus(note);
        last = importedPdf;
        imported += 1;
        await this.app.vault.adapter.remove(pendingPath);
      } catch (error) {
        console.error(error);
        failures.push(`${source.name}：${error instanceof Error ? error.message : "保存失败"}`);
      }
    }
    if (last) {
      await this.openPaper(last);
      new Notice(imported === 1 ? "论文文件夹、PDF 与伴随笔记已创建" : `已导入 ${imported} 篇论文`);
    }
    this.importing = false;
    if (failures.length) new Notice(`导入完成 ${imported} 篇，失败 ${failures.length} 篇。${failures.join("；")}。已写入的 PDF 可运行“恢复未完成的批注同步”补齐笔记。`, 12000);
    this.refreshLibrary();
  }

  private async applyDefaultStatus(note: TFile): Promise<void> {
    if (this.settings.defaultStatus === "unread") return;
    await this.app.fileManager.processFrontMatter(note, frontmatter => { frontmatter.status = this.settings.defaultStatus; });
  }

  private availablePaperFolder(parentFolder: string, stem: string): string {
    const root = normalizePath(parentFolder.trim().replace(/^\/+|\/+$/g, ""));
    let index = 1;
    while (true) {
      const suffix = index === 1 ? "" : ` (${index})`;
      const candidate = normalizePath([root, `${stem}${suffix}`].filter(Boolean).join("/"));
      if (!this.app.vault.getAbstractFileByPath(candidate)) return candidate;
      index += 1;
    }
  }

  activePdf(): TFile | null {
    const active = this.app.workspace.getActiveFile();
    if (active?.extension === "pdf") return active;
    const note = active?.extension === "md" ? this.paperForNote(active) : null;
    return note ? this.app.vault.getFileByPath(note) : null;
  }

  paperForNote(note: TFile): string | null {
    const frontmatter = this.app.metadataCache.getFileCache(note)?.frontmatter;
    const linked = parsePaperLink(frontmatter?.paper);
    if (linked) return this.app.metadataCache.getFirstLinkpathDest(linked, note.path)?.path ?? linked;
    const tagged = hasPaperTag(frontmatter?.tags) || this.app.metadataCache.getFileCache(note)?.tags?.some(tag => tag.tag.toLowerCase() === "#paper");
    return tagged ? this.app.vault.getFileByPath(note.path.replace(/\.md$/i, ".pdf"))?.path ?? null : null;
  }

  async companionFor(pdf: TFile, create = true): Promise<TFile | null> {
    return this.companionQueue.run(pdf.path, async () => {
      const matches = this.app.vault.getMarkdownFiles().filter(note => this.paperForNote(note) === pdf.path);
      const expectedPath = pdf.path.replace(/\.pdf$/i, ".md");
      const direct = this.app.vault.getFileByPath(expectedPath);
      if (direct) {
        if (this.paperForNote(direct) === pdf.path) return direct;
        const body = await this.app.vault.read(direct);
        const header = body.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        if (header && parsePaperLink(parseYaml(header[1]!)?.paper) === pdf.path) return direct;
      }
      if (matches.length === 1) return matches[0]!;
      if (matches.length > 1) throw new Error("多篇笔记关联这份 PDF，请先明确伴随笔记。");
      if (!create) return null;
      if (direct) throw new Error("同名笔记已存在但未关联这份 PDF，已保留原文；请设置笔记的 paper 属性后重试。");
      return this.app.vault.create(expectedPath, buildPaperNote(pdf.path, pdf.basename));
    });
  }

  private async showCompanion(pdf: TFile, note: TFile, focus = false): Promise<void> {
    const pdfLeaf = this.app.workspace.getLeavesOfType("pdf").find(leaf => leaf.getViewState().state?.file === pdf.path);
    if (!pdfLeaf) { await this.app.workspace.getLeaf(false).openFile(note); return; }
    let noteLeaf = this.notePairs.get(pdfLeaf);
    if (!noteLeaf || !this.app.workspace.getLeavesOfType("markdown").includes(noteLeaf)) {
      noteLeaf = this.app.workspace.createLeafBySplit(pdfLeaf, "vertical", false);
      this.notePairs.set(pdfLeaf, noteLeaf);
    }
    if (noteLeaf.getViewState().state?.file !== note.path) await noteLeaf.openFile(note, { active: focus });
    if (focus) this.app.workspace.setActiveLeaf(noteLeaf, { focus: true });
  }

  async openPaper(pdf: TFile, page?: number): Promise<void> {
    try {
      const note = await this.companionFor(pdf, true);
      if (!note) return;
      const pdfLeaf = this.app.workspace.getLeavesOfType("pdf").find(candidate => candidate.getViewState().state?.file === pdf.path) ?? this.app.workspace.getLeaf(false);
      if (pdfLeaf.getViewState().state?.file !== pdf.path) await pdfLeaf.openFile(pdf);
      if (page) await pdfLeaf.openFile(pdf, { eState: { subpath: `#page=${page}` } });
      if (this.settings.openSideBySide) await this.showCompanion(pdf, note);
      this.app.workspace.setActiveLeaf(pdfLeaf, { focus: true });
    } catch (error) { this.reportError(error); }
  }

  private reportError(error: unknown): void { new Notice(error instanceof Error ? error.message : "操作失败，请重试"); }

  private async savePending(kind: "pending-notes" | "pending-imports", id: string, value: object): Promise<string> {
    const directory = `${this.manifest.dir}/${kind}`;
    if (!await this.app.vault.adapter.exists(directory)) await this.app.vault.adapter.mkdir(directory);
    const path = `${directory}/${id}.json`;
    await this.app.vault.adapter.write(path, JSON.stringify(value));
    return path;
  }

  private async appendRecoverable(note: TFile, block: string, id: string, assetPath = ""): Promise<void> {
    const pending = await this.savePending("pending-notes", id, { notePath: note.path, block, id, assetPath });
    try {
      await this.app.vault.process(note, content => appendPaperBlock(content, block, id));
      await this.app.vault.adapter.remove(pending);
    } catch (error) {
      throw new Error(`笔记保存未完成，内容已保留${assetPath ? `，截图位于 ${assetPath}` : ""}。请运行“恢复未完成的批注同步”。${error instanceof Error ? error.message : ""}`);
    }
  }

  private async recoverAdditions(): Promise<{ recovered: number; conflicts: number }> {
    let recovered = 0, conflicts = 0;
    for (const kind of ["pending-notes", "pending-imports"] as const) {
      const directory = `${this.manifest.dir}/${kind}`;
      if (!await this.app.vault.adapter.exists(directory)) continue;
      for (const path of (await this.app.vault.adapter.list(directory)).files.filter(path => path.endsWith(".json"))) {
        try {
          const value = JSON.parse(await this.app.vault.adapter.read(path));
          if (kind === "pending-imports") {
            const pdf = typeof value.pdfPath === "string" ? this.app.vault.getFileByPath(value.pdfPath) : null;
            if (!pdf || pdf.extension !== "pdf") throw new Error("原始 PDF 未写入，请重新导入");
            const note = await this.companionFor(pdf, true);
            if (note) await this.applyDefaultStatus(note);
          } else {
            const note = typeof value.notePath === "string" ? this.app.vault.getFileByPath(value.notePath) : null;
            if (!note || note.extension !== "md" || typeof value.block !== "string" || !/^ai4d-[a-z0-9-]+$/.test(value.id)) throw new Error("无法识别摘录");
            if (value.assetPath && !this.app.vault.getFileByPath(value.assetPath)) throw new Error("截图已移动");
            await this.app.vault.process(note, content => appendPaperBlock(content, value.block, value.id));
          }
          await this.app.vault.adapter.remove(path); recovered++;
        } catch { conflicts++; }
      }
    }
    return { recovered, conflicts };
  }

  private async recoverWrites(): Promise<void> {
    if (this.importing) { new Notice("请等待当前导入完成"); return; }
    try {
      const result = await this.writes.recover();
      const additions = await this.recoverAdditions();
      result.recovered += additions.recovered; result.conflicts += additions.conflicts;
      this.annotationCache.clear(); this.refreshLibrary();
      new Notice(`已恢复 ${result.recovered} 项；${result.conflicts} 项未能自动恢复，已保留记录，请检查文件是否移动或有后续修改。`);
    } catch (error) { this.reportError(error); }
  }

  private async undoAnnotation(): Promise<void> {
    const pdf = this.activePdf();
    if (!pdf) { new Notice("请先打开论文"); return; }
    try { await this.writes.undo(pdf.path); this.annotationCache.clear(); this.refreshLibrary(); new Notice("已撤销上一次批注操作"); }
    catch (error) { this.reportError(error); }
  }

  private async repairCurrentBlocks(): Promise<void> {
    const pdf = this.activePdf();
    if (!pdf) return;
    try {
      const note = await this.companionFor(pdf, false);
      if (!note) return;
      await this.writes.run(pdf.path, note.path, async bytes => new Uint8Array(bytes), repairBlockReferences);
      this.annotationCache.clear(); this.refreshLibrary();
      new Notice("旧摘录的引用边界已修复，块 ID 保持不变");
    } catch (error) { this.reportError(error); }
  }

  async captureAnnotation(pdf: TFile): Promise<void> {
    const note = await this.companionFor(pdf, true);
    if (!note) return;
    let clipboard = "";
    try { clipboard = (await navigator.clipboard.readText()).trim(); } catch { /* Clipboard permission is optional. */ }
    new AnnotationModal(this.app, pdf, clipboard, async (page, quote, comment) => {
      await this.saveAnnotation(pdf, note, page, quote, comment);
    }).open();
  }

  async saveAnnotation(pdf: TFile, note: TFile, page: number, quote: string, comment: string, translation = "", openNote = true): Promise<void> {
    const id = `ai4d-${crypto.randomUUID()}`;
    const block = buildAnnotation(pdf.path, page, quote, comment, id, translation);
    await this.appendRecoverable(note, block, id);
    if (!this.disposed && this.settings.openSideBySide) await this.showCompanion(pdf, note, openNote);
    new Notice(`已记录第 ${page} 页摘录`);
    this.refreshLibrary();
  }

  startFigureCapture(pdf: TFile): void {
    this.stopFigureCapture();
    const leaf = this.app.workspace.getLeavesOfType("pdf").find(candidate => String(candidate.getViewState().state?.file || "") === pdf.path);
    if (!leaf) { new Notice("请先打开这篇 PDF，再截取图像"); return; }
    const viewer = leaf.view.containerEl.querySelector<HTMLElement>(".pdf-viewer-container, .pdfViewer");
    if (!viewer) { new Notice("PDF 页面仍在载入，请稍后再试"); return; }

    const notice = new Notice("图像批注：在 PDF 上拖动框选；按 Esc 取消", 0);
    const overlays: HTMLElement[] = [];
    let keyHandler: ((event: KeyboardEvent) => void) | null = null;
    const cleanup = (): void => {
      for (const overlay of overlays) overlay.remove();
      document.body.removeClass("ai4d-figure-capture-active");
      if (keyHandler) document.removeEventListener("keydown", keyHandler, true);
      notice.hide();
      if (this.figureCaptureCleanup === cleanup) this.figureCaptureCleanup = null;
    };
    this.figureCaptureCleanup = cleanup;
    keyHandler = event => {
      if (event.key === "Escape") {
        event.preventDefault();
        cleanup();
        new Notice("已取消图像截取");
      }
    };
    document.addEventListener("keydown", keyHandler, true);
    document.body.addClass("ai4d-figure-capture-active");

    const pages = Array.from(viewer.querySelectorAll<HTMLElement>(".page"));
    for (const pageEl of pages) {
      const overlay = pageEl.createDiv({ cls: "ai4d-figure-capture-layer" });
      overlays.push(overlay);
      let startX = 0;
      let startY = 0;
      let frame: HTMLElement | null = null;
      overlay.addEventListener("pointerdown", event => {
        if (event.button !== 0) return;
        event.preventDefault();
        overlay.setPointerCapture(event.pointerId);
        const bounds = overlay.getBoundingClientRect();
        startX = event.clientX - bounds.left;
        startY = event.clientY - bounds.top;
        frame?.remove();
        frame = overlay.createDiv({ cls: "ai4d-figure-selection" });
        frame.style.left = `${startX}px`;
        frame.style.top = `${startY}px`;
      });
      overlay.addEventListener("pointermove", event => {
        if (!frame || !overlay.hasPointerCapture(event.pointerId)) return;
        const bounds = overlay.getBoundingClientRect();
        const x = Math.max(0, Math.min(bounds.width, event.clientX - bounds.left));
        const y = Math.max(0, Math.min(bounds.height, event.clientY - bounds.top));
        frame.style.left = `${Math.min(startX, x)}px`;
        frame.style.top = `${Math.min(startY, y)}px`;
        frame.style.width = `${Math.abs(x - startX)}px`;
        frame.style.height = `${Math.abs(y - startY)}px`;
      });
      overlay.addEventListener("pointerup", event => {
        if (!frame) return;
        const selectionRect = frame.getBoundingClientRect();
        if (selectionRect.width < 12 || selectionRect.height < 12) {
          frame.remove();
          frame = null;
          new Notice("框选范围太小，请重新拖动");
          return;
        }
        const canvas = pageEl.querySelector<HTMLCanvasElement>(".canvasWrapper canvas, canvas");
        const page = Number(pageEl.dataset.pageNumber || pageEl.getAttribute("data-page-number") || "1");
        if (!canvas || !canvas.width || !canvas.height) { new Notice("这一页尚未渲染完成，请稍后再试"); return; }
        cleanup();
        void this.cropPdfFigure(pdf, canvas, selectionRect, Number.isFinite(page) && page > 0 ? page : 1).catch(error => this.reportError(error));
      });
    }
    if (!pages.length) {
      cleanup();
      new Notice("没有找到已渲染的 PDF 页面，请稍后再试");
    }
  }

  private stopFigureCapture(): void {
    this.figureCaptureCleanup?.();
    this.figureCaptureCleanup = null;
  }

  private async cropPdfFigure(pdf: TFile, source: HTMLCanvasElement, selection: DOMRect, page: number): Promise<void> {
    const canvasRect = source.getBoundingClientRect();
    const left = Math.max(selection.left, canvasRect.left);
    const top = Math.max(selection.top, canvasRect.top);
    const right = Math.min(selection.right, canvasRect.right);
    const bottom = Math.min(selection.bottom, canvasRect.bottom);
    if (right <= left || bottom <= top) { new Notice("框选区域没有覆盖论文页面"); return; }
    const scaleX = source.width / canvasRect.width;
    const scaleY = source.height / canvasRect.height;
    const sx = Math.max(0, Math.round((left - canvasRect.left) * scaleX));
    const sy = Math.max(0, Math.round((top - canvasRect.top) * scaleY));
    const sw = Math.min(source.width - sx, Math.max(1, Math.round((right - left) * scaleX)));
    const sh = Math.min(source.height - sy, Math.max(1, Math.round((bottom - top) * scaleY)));
    const output = document.createElement("canvas");
    output.width = sw;
    output.height = sh;
    const context = output.getContext("2d");
    if (!context) { new Notice("无法创建截图"); return; }
    context.drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh);
    const blob = await new Promise<Blob | null>(resolve => output.toBlob(resolve, "image/png"));
    if (!blob) { new Notice("无法生成截图"); return; }
    await this.saveFigureAnnotation(pdf, page, blob);
  }

  private async saveFigureAnnotation(pdf: TFile, page: number, blob: Blob): Promise<void> {
    const note = await this.companionFor(pdf, true);
    if (!note) return;
    const parent = pdf.parent?.path ?? "";
    const figureFolder = normalizePath([parent, "figures"].filter(Boolean).join("/"));
    if (!this.app.vault.getAbstractFileByPath(figureFolder)) await this.app.vault.createFolder(figureFolder);
    const id = `ai4d-fig-${crypto.randomUUID()}`;
    const imagePath = normalizePath(`${figureFolder}/figure-p${page}-${id}.png`);
    await this.app.vault.createBinary(imagePath, await blob.arrayBuffer());
    const block = buildFigureAnnotation(pdf.path, imagePath, page, id);
    await this.appendRecoverable(note, block, id, imagePath);
    if (this.settings.openSideBySide) await this.showCompanion(pdf, note, false);
    new Notice(`截图已粘贴到论文笔记`);
    this.refreshLibrary();
  }

  async translateSelection(pdf?: TFile, captured?: PdfTextSelection): Promise<void> {
    const selection = captured ?? this.readPdfSelection(pdf);
    if (!selection) { new Notice("请先在 PDF 页面中划选需要翻译的文字"); return; }
    const request = ++this.translationRequest;
    this.selectionTrigger?.addClass("is-loading");
    new Notice("正在翻译选段…");
    try {
      const translation = await translateText(selection.text, {
        endpoint: this.settings.translationEndpoint,
        apiKey: this.settings.translationApiKey,
        model: this.settings.translationModel,
        targetLanguage: this.settings.targetLanguage
      });
      if (this.disposed || request !== this.translationRequest || !selection.range.startContainer.isConnected) return;
      this.selectionTrigger?.remove();
      this.selectionTrigger = null;
      this.showTranslationCard(selection, translation);
    } catch (error) {
      if (this.disposed || request !== this.translationRequest) return;
      this.selectionTrigger?.removeClass("is-loading");
      new Notice(error instanceof Error ? error.message : "翻译失败");
    }
  }

  private readPdfSelection(preferredPdf?: TFile): PdfTextSelection | null {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
    const text = selection.toString().replace(/\s+/g, " ").trim();
    if (!text) return null;
    const range = selection.getRangeAt(0).cloneRange();
    const node = range.startContainer;
    const element = node instanceof HTMLElement ? node : node.parentElement;
    if (!element) return null;
    const leaf = this.app.workspace.getLeavesOfType("pdf").find(candidate => candidate.view.containerEl.contains(element));
    if (!leaf) return null;
    const filePath = String(leaf.getViewState().state?.file || "");
    if (preferredPdf && preferredPdf.path !== filePath) return null;
    const pdf = this.app.vault.getFileByPath(filePath);
    if (!pdf || pdf.extension !== "pdf") return null;
    const pageEl = element.closest<HTMLElement>(".page");
    const endElement = range.endContainer instanceof HTMLElement ? range.endContainer : range.endContainer.parentElement;
    if (!pageEl || endElement?.closest<HTMLElement>(".page") !== pageEl) return null;
    const page = Number(pageEl?.dataset.pageNumber || pageEl?.getAttribute("data-page-number") || "1");
    const rect = range.getBoundingClientRect();
    const pageNumber = Number.isFinite(page) && page > 0 ? page : 1;
    const pdfRects = this.selectionRectsToPdf(leaf, pageEl, pageNumber, range);
    return { pdf, text, page: pageNumber, rect, range, pdfRects, modified: pdf.stat.mtime };
  }

  private selectionRectsToPdf(leaf: WorkspaceLeaf, pageEl: HTMLElement, page: number, range: Range): PdfRect[] {
    const canvas = pageEl.querySelector<HTMLCanvasElement>(".canvasWrapper canvas, canvas");
    if (!canvas) return [];
    const canvasRect = canvas.getBoundingClientRect();
    type Viewport = { width: number; height: number; convertToPdfPoint: (x: number, y: number) => [number, number] };
    type PageView = { viewport?: Viewport };
    type PdfViewer = { getPageView?: (index: number) => PageView; pdfViewer?: PdfViewer };
    const child = (leaf.view as unknown as { viewer?: { child?: { getPage?: (page: number) => PageView; pdfViewer?: PdfViewer } } }).viewer?.child;
    const viewport = child?.pdfViewer?.pdfViewer?.getPageView?.(page - 1)?.viewport
      ?? child?.pdfViewer?.getPageView?.(page - 1)?.viewport ?? child?.getPage?.(page)?.viewport;
    if (!viewport?.convertToPdfPoint) return [];
    const rects: PdfRect[] = [];
    for (const clientRect of Array.from(range.getClientRects())) {
      const left = Math.max(clientRect.left, canvasRect.left);
      const top = Math.max(clientRect.top, canvasRect.top);
      const right = Math.min(clientRect.right, canvasRect.right);
      const bottom = Math.min(clientRect.bottom, canvasRect.bottom);
      if (right - left < 1 || bottom - top < 1) continue;
      const scaleX = viewport.width / canvasRect.width;
      const scaleY = viewport.height / canvasRect.height;
      const first = viewport.convertToPdfPoint((left - canvasRect.left) * scaleX, (top - canvasRect.top) * scaleY);
      const second = viewport.convertToPdfPoint((right - canvasRect.left) * scaleX, (bottom - canvasRect.top) * scaleY);
      rects.push([
        Math.min(first[0], second[0]),
        Math.min(first[1], second[1]),
        Math.max(first[0], second[0]),
        Math.max(first[1], second[1])
      ]);
    }
    return rects.filter((rect, index) => rect.every(Number.isFinite) && !rects.slice(0, index).some(previous => previous.every((value, i) => Math.abs(value - rect[i]!) < 0.1)));
  }

  private showPdfSelectionTrigger(captured?: PdfTextSelection, anchor?: { x: number; y: number }): void {
    this.dismissTranslationUi();
    const selection = captured ?? this.readPdfSelection();
    if (!selection) return;
    const toolbar = document.body.createDiv({ cls: "ai4d-selection-toolbar", attr: { role: "toolbar", "aria-label": "PDF 批注工具" } });
    const colors = ["#ffd54f", "#ef767a", "#65b6e3", "#75c49a"];
    const annotationRow = toolbar.createDiv({ cls: "ai4d-toolbar-row is-annotation" });
    annotationRow.createSpan({ cls: "ai4d-toolbar-row-label", text: "批注" });
    const palette = annotationRow.createDiv({ cls: "ai4d-markup-palette" });
    for (const color of colors) {
      const swatch = palette.createEl("button", { cls: `ai4d-color-swatch${this.settings.annotationColor === color ? " is-active" : ""}`, attr: { "aria-label": `使用颜色 ${color}` } });
      swatch.style.setProperty("--swatch", color);
      swatch.style.setProperty("background-color", color, "important");
      swatch.addEventListener("mousedown", event => event.preventDefault());
      swatch.addEventListener("click", async () => {
        this.settings.annotationColor = color;
        await this.saveSettings();
        palette.querySelectorAll(".is-active").forEach(element => element.removeClass("is-active"));
        swatch.addClass("is-active");
      });
    }
    const referenceRow = toolbar.createDiv({ cls: "ai4d-toolbar-row is-reference" });
    referenceRow.createSpan({ cls: "ai4d-toolbar-row-label", text: "引用" });
    const addAction = (row: HTMLElement, icon: string, label: string, action: () => void): void => {
      const button = row.createEl("button", { cls: "ai4d-markup-action", attr: { "aria-label": label, "data-tooltip-position": "top" } });
      setIcon(button, icon);
      button.createSpan({ text: label });
      button.addEventListener("mousedown", event => event.preventDefault());
      button.addEventListener("click", action);
    };
    addAction(annotationRow, "highlighter", "高光", () => void this.applyTextMarkup(selection, "Highlight"));
    addAction(annotationRow, "underline", "下划线", () => void this.applyTextMarkup(selection, "Underline"));
    addAction(annotationRow, "strikethrough", "删除线", () => void this.applyTextMarkup(selection, "StrikeOut"));
    addAction(annotationRow, "message-square-text", "文字批注", () => this.openTextNote(selection));
    addAction(referenceRow, "quote", "引用到笔记", () => void (async () => {
      if (this.selectionTrigger?.hasClass("is-loading")) return;
      this.selectionTrigger?.addClass("is-loading");
      const note = await this.companionFor(selection.pdf, true);
      if (note) await this.saveAnnotation(selection.pdf, note, selection.page, selection.text, "", "", false);
      window.getSelection()?.removeAllRanges();
      this.dismissTranslationUi();
    })().catch(error => { this.selectionTrigger?.removeClass("is-loading"); this.reportError(error); }));
    addAction(referenceRow, "link", "复制原文链接", () => void (async () => {
      await navigator.clipboard.writeText(`[[${selection.pdf.path}#page=${selection.page}|${selection.pdf.basename} · p.${selection.page}]]`);
      new Notice("原文链接已复制");
      this.dismissTranslationUi();
    })().catch(error => { this.selectionTrigger?.removeClass("is-loading"); this.reportError(error); }));
    addAction(referenceRow, "scan-line", "截图", () => {
      window.getSelection()?.removeAllRanges();
      this.dismissTranslationUi();
      this.startFigureCapture(selection.pdf);
    });
    addAction(referenceRow, "languages", "翻译", () => void this.translateSelection(selection.pdf, selection));
    const width = toolbar.offsetWidth || 480;
    const height = toolbar.offsetHeight || 72;
    const originX = anchor?.x ?? selection.rect.left + selection.rect.width / 2;
    const originY = anchor?.y ?? selection.rect.bottom;
    toolbar.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, originX - 12))}px`;
    toolbar.style.top = `${Math.max(48, Math.min(window.innerHeight - height - 8, originY + 8))}px`;
    toolbar.addEventListener("mousedown", event => event.preventDefault());
    this.selectionTrigger = toolbar;
  }

  private async createNativeMarkup(selection: PdfTextSelection, subtype: TextMarkupSubtype, comment = "", translation = false): Promise<void> {
    if (selection.pdf.stat.mtime !== selection.modified) throw new Error("PDF 已变化，请重新划选后保存批注。");
    if (!selection.pdfRects.length) throw new Error("无法读取选区坐标，请在已加载的单页中重新划选。");
    const note = await this.companionFor(selection.pdf, true);
    if (!note) throw new Error("未找到伴随笔记");
    const kind = subtype === "Highlight" ? "highlight" : subtype === "Underline" ? "underline" : "strikeout";
    const id = `ai4d-${translation ? "translation" : kind}-${crypto.randomUUID()}`;
    const block = translation ? buildAnnotation(selection.pdf.path, selection.page, selection.text, "", id, comment)
      : buildMarkupAnnotation(selection.pdf.path, selection.page, selection.text, kind, comment, id);
    const color = this.settings.annotationColor;
    await this.writes.run(selection.pdf.path, note.path,
      bytes => writeTextMarkupAnnotation(bytes, { page: selection.page, rects: selection.pdfRects, subtype, color,
        author: this.settings.annotationAuthor, contents: comment, quote: selection.text, id }),
      content => appendPaperBlock(content, block, id));
    this.annotationCache.delete(note.path);
    this.refreshLibrary();
    if (!this.disposed && this.settings.openSideBySide) await this.showCompanion(selection.pdf, note);
  }

  private async applyTextMarkup(selection: PdfTextSelection, subtype: TextMarkupSubtype): Promise<void> {
    if (this.selectionTrigger?.hasClass("is-loading")) return;
    this.selectionTrigger?.addClass("is-loading");
    try {
      await this.createNativeMarkup(selection, subtype);
      this.flashSelection(selection, subtype.toLowerCase());
      window.getSelection()?.removeAllRanges();
      this.dismissTranslationUi();
      new Notice("批注已保存 · 可在命令面板撤销上一次操作");
    } catch (error) { this.selectionTrigger?.removeClass("is-loading"); this.reportError(error); }
  }

  private openTextNote(selection: PdfTextSelection): void {
    if (!selection.pdfRects.length) { new Notice("无法读取这个选区的 PDF 坐标，请重新划选"); return; }
    new TextNoteModal(this.app, selection, async comment => {
      if (selection.pdf.stat.mtime !== selection.modified) throw new Error("PDF 已变化，请重新划选后保存批注。");
      const note = await this.companionFor(selection.pdf, true);
      if (!note) throw new Error("未找到伴随笔记");
      const id = `ai4d-comment-${crypto.randomUUID()}`;
      const anchor = selection.pdfRects[0]!;
      const block = buildMarkupAnnotation(selection.pdf.path, selection.page, selection.text, "comment", comment, id);
      await this.writes.run(selection.pdf.path, note.path,
        bytes => writeTextNoteAnnotation(bytes, { page: selection.page, point: [anchor[2], anchor[3]],
          color: this.settings.annotationColor, author: this.settings.annotationAuthor, contents: comment, quote: selection.text, id }),
        content => appendPaperBlock(content, block, id));
      this.annotationCache.delete(note.path); this.refreshLibrary();
      if (!this.disposed && this.settings.openSideBySide) await this.showCompanion(selection.pdf, note);
      window.getSelection()?.removeAllRanges(); this.dismissTranslationUi();
      new Notice("文字批注已写入 PDF 与伴随笔记");
    }).open();
  }

  private async managePdfAnnotations(pdf: TFile, selectedKey?: string): Promise<void> {
    try {
      const annotations = await readPdfAnnotations(await this.app.vault.readBinary(pdf));
      new PdfAnnotationManagerModal(
        this.app,
        pdf,
        annotations,
        page => void this.openPaper(pdf, page),
        (annotation, contents) => this.editNativeAnnotation(pdf, annotation, contents),
        annotation => this.deleteNativeAnnotation(pdf, annotation),
        (annotation, color) => this.recolorNativeAnnotation(pdf, annotation, color),
        selectedKey
      ).open();
    } catch (error) {
      console.error(error);
      new Notice(error instanceof Error ? `无法读取 PDF 批注：${error.message}` : "无法读取 PDF 批注");
    }
  }

  private async changeNativeAnnotation(pdf: TFile, annotation: PdfAnnotationSummary, transform: (bytes: ArrayBuffer) => Promise<Uint8Array>, noteChange: (content: string) => string): Promise<void> {
    const note = await this.companionFor(pdf, false);
    await this.writes.run(pdf.path, note?.path ?? "", async bytes => {
      const current = (await readPdfAnnotations(bytes)).find(item => item.key === annotation.key && item.page === annotation.page);
      if (!current || current.contents !== annotation.contents || current.color !== annotation.color) throw new Error("这条批注已变化，请重新打开批注管理后重试。");
      return transform(bytes);
    }, content => annotation.key.startsWith("ai4d-") ? noteChange(content) : content);
    if (note) this.annotationCache.delete(note.path);
    this.refreshLibrary();
  }

  private async editNativeAnnotation(pdf: TFile, annotation: PdfAnnotationSummary, contents: string): Promise<void> {
    await this.changeNativeAnnotation(pdf, annotation, bytes => updatePdfAnnotationContents(bytes, annotation.page, annotation.key, contents),
      content => updateMarkupBlockComment(content, annotation.key, contents));
  }

  private async deleteNativeAnnotation(pdf: TFile, annotation: PdfAnnotationSummary): Promise<void> {
    await this.changeNativeAnnotation(pdf, annotation, bytes => deletePdfAnnotation(bytes, annotation.page, annotation.key),
      content => removeMarkupBlock(content, annotation.key));
  }

  private async recolorNativeAnnotation(pdf: TFile, annotation: PdfAnnotationSummary, color: string): Promise<void> {
    await this.changeNativeAnnotation(pdf, annotation, bytes => updatePdfAnnotationColor(bytes, annotation.page, annotation.key, color), content => content);
    annotation.color = color;
  }

  private async showExistingAnnotationMenu(pdf: TFile, page: number, domId: string, event: MouseEvent): Promise<void> {
    try {
      const annotations = await readPdfAnnotations(await this.app.vault.readBinary(pdf));
      const normalized = domId.replace(/R0$/, "R");
      const annotation = annotations.find(item => item.page === page && (item.key === domId || item.refKey === domId || item.refKey.replace(/R0$/, "R") === normalized));
      if (!annotation) { void this.managePdfAnnotations(pdf); return; }
      const menu = new Menu();
      menu.addItem(item => item.setTitle("编辑批注 / 颜色").setIcon("pencil").onClick(() => void this.managePdfAnnotations(pdf, annotation.key)));
      menu.addItem(item => item.setTitle("撤销上一次批注操作").setIcon("undo-2").onClick(async () => {
        try { await this.writes.undo(pdf.path); this.annotationCache.clear(); this.refreshLibrary(); new Notice("已撤销"); }
        catch (error) { this.reportError(error); }
      }));
      menu.addItem(item => item.setTitle("回到伴随笔记").setIcon("notebook-pen").onClick(async () => {
        const note = await this.companionFor(pdf, true);
        if (note) await this.showCompanion(pdf, note, true);
      }));
      menu.addItem(item => item.setTitle("删除这条批注").setIcon("trash-2").onClick(() => {
        new ConfirmAnnotationDeleteModal(this.app, annotation, async () => {
          await this.deleteNativeAnnotation(pdf, annotation);
          new Notice("批注已从 PDF 和伴随笔记删除");
        }).open();
      }));
      menu.addSeparator();
      menu.addItem(item => item.setTitle("打开批注边栏").setIcon("list-filter").onClick(() => void this.activateAnnotationSidebar()));
      menu.addItem(item => item.setTitle("管理这篇 PDF 的全部批注").setIcon("list-checks").onClick(() => void this.managePdfAnnotations(pdf)));
      menu.showAtMouseEvent(event);
    } catch (error) {
      console.error(error);
      new Notice("无法读取这条 PDF 批注");
    }
  }

  private flashSelection(selection: PdfTextSelection, kind: string): void {
    for (const rect of Array.from(selection.range.getClientRects())) {
      const flash = document.body.createDiv({ cls: `ai4d-markup-flash is-${kind}` });
      flash.style.left = `${rect.left}px`;
      flash.style.top = `${rect.top}px`;
      flash.style.width = `${rect.width}px`;
      flash.style.height = `${rect.height}px`;
      flash.style.setProperty("--markup-color", this.settings.annotationColor);
      window.setTimeout(() => flash.remove(), 650);
    }
  }

  private showTranslationCard(selection: PdfTextSelection, translation: string): void {
    this.translationCard?.remove();
    const card = document.body.createDiv({ cls: "ai4d-translation-card" });
    card.style.left = `${Math.max(12, Math.min(window.innerWidth - 392, selection.rect.right + 10))}px`;
    card.style.top = `${Math.max(58, Math.min(window.innerHeight - 330, selection.rect.top))}px`;
    const header = card.createDiv({ cls: "ai4d-translation-card-header" });
    header.createSpan({ text: `第 ${selection.page} 页 · ${this.settings.targetLanguage}` });
    const close = header.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "关闭" } });
    setIcon(close, "x");
    close.addEventListener("click", () => this.dismissTranslationUi());
    card.createEl("p", { cls: "ai4d-translation-source", text: selection.text });
    card.createEl("p", { cls: "ai4d-translation-text", text: translation });
    const actions = card.createDiv({ cls: "ai4d-translation-actions" });
    const copy = actions.createEl("button", { text: "复制译文" });
    copy.addEventListener("click", async () => { await navigator.clipboard.writeText(translation); new Notice("译文已复制"); });
    const save = actions.createEl("button", { cls: "mod-cta", text: "生成翻译批注" });
    save.addEventListener("click", async () => {
      save.disabled = true;
      try {
        await this.createNativeMarkup(selection, "Highlight", translation, true);
        this.dismissTranslationUi();
        new Notice("译文已保存为 PDF 高光批注和笔记，重新打开仍可查看");
      } catch (error) { this.reportError(error); save.disabled = false; }
    });
    this.translationCard = card;
  }

  private dismissTranslationUi(): void {
    this.translationRequest++;
    this.selectionTrigger?.remove();
    this.translationCard?.remove();
    this.selectionTrigger = null;
    this.translationCard = null;
  }

  private zoteroClient(): ZoteroLocalClient {
    return new ZoteroLocalClient(this.settings.zoteroBaseUrl, this.settings.zoteroApiKey, async key => {
      this.settings.zoteroApiKey = key;
      await this.saveSettings();
    });
  }

  async syncFromZotero(): Promise<void> {
    if (!this.settings.zoteroEnabled) { new Notice("请先在插件设置中启用 Zotero 兼容模式"); return; }
    if (this.zoteroBusy) return;
    this.zoteroBusy = true;
    try {
      const matches = await this.zoteroClient().paperMatches();
      const pdfs = this.app.vault.getFiles().filter(file => file.extension === "pdf");
      const candidates = [];
      for (const pdf of pdfs) {
        const note = await this.companionFor(pdf, false);
        const fm = note ? this.app.metadataCache.getFileCache(note)?.frontmatter : undefined;
        candidates.push({ path: pdf.path,
          absolutePath: this.app.vault.adapter instanceof FileSystemAdapter ? this.app.vault.adapter.getFullPath(pdf.path) : undefined,
          attachmentKey: fm?.["zotero-attachment-key"] as string | undefined, parentKey: fm?.["zotero-key"] as string | undefined });
      }
      const used = new Set<string>();
      let synced = 0;
      let skipped = 0;
      for (const match of matches) {
        const candidate = matchZoteroAttachment(match.attachment, candidates);
        const pdf = candidate ? this.app.vault.getFileByPath(candidate.path) : null;
        if (!pdf || used.has(pdf.path)) { skipped++; continue; }
        used.add(pdf.path);
        const note = await this.companionFor(pdf, true);
        if (!note) continue;
        const authors = formatCreators(match.item.creators ?? []);
        await this.app.fileManager.processFrontMatter(note, frontmatter => {
          frontmatter["ai4d-type"] = "paper";
          frontmatter.tags = paperTags(frontmatter.tags);
          frontmatter.paper = `[[${pdf.path}]]`;
          frontmatter.title = match.item.title || pdf.basename;
          frontmatter.authors = authors;
          frontmatter.year = match.item.date?.match(/\d{4}/)?.[0] ?? "";
          frontmatter.doi = match.item.DOI || "";
          frontmatter.journal = match.item.publicationTitle || "";
          frontmatter["zotero-key"] = match.item.key;
          frontmatter["zotero-attachment-key"] = match.attachment.key;
          frontmatter["zotero-synced-at"] = new Date().toISOString();
        });
        synced += 1;
      }
      new Notice(`已同步 ${synced} 篇；${skipped} 个附件未能唯一关联，已跳过。`);
      this.refreshLibrary();
    } catch (error) {
      console.error(error);
      this.reportError(error);
    } finally { this.zoteroBusy = false; }
  }

  private async sendToZotero(pdf: TFile): Promise<void> {
    if (!this.settings.zoteroEnabled) { new Notice("请先在插件设置中启用 Zotero 兼容模式"); return; }
    if (!(this.app.vault.adapter instanceof FileSystemAdapter)) { new Notice("链接附件目前只支持桌面端本地 Vault"); return; }
    const note = await this.companionFor(pdf, true);
    if (!note) return;
    const frontmatter = this.app.metadataCache.getFileCache(note)?.frontmatter ?? {};
    if (frontmatter["zotero-key"]) { new Notice("这篇论文已经关联 Zotero"); return; }
    if (this.zoteroBusy) return;
    this.zoteroBusy = true;
    const absolutePath = this.app.vault.adapter.getFullPath(pdf.path);
    try {
      const linked = await this.zoteroClient().createLinkedPaper({
        title: String(frontmatter.title || pdf.basename),
        authors: Array.isArray(frontmatter?.authors) ? frontmatter.authors.map(String) : [],
        year: String(frontmatter?.year || ""),
        doi: String(frontmatter.doi || ""),
        pdfPath: absolutePath,
        pending: frontmatter["zotero-pending"],
        savePending: async pending => this.app.fileManager.processFrontMatter(note, data => { data["zotero-pending"] = pending; })
      });
      await this.app.fileManager.processFrontMatter(note, data => {
        data.tags = paperTags(data.tags);
        data["zotero-key"] = linked.parentKey;
        data["zotero-attachment-key"] = linked.attachmentKey;
        delete data["zotero-pending"];
        data["zotero-synced-at"] = new Date().toISOString();
      });
      new Notice("已在 Zotero 中创建条目和链接附件");
    } catch (error) {
      console.error(error);
      new Notice(error instanceof Error ? error.message : "写入 Zotero 失败");
    } finally { this.zoteroBusy = false; }
  }

  private async choosePaperBlock(editor: Editor): Promise<void> {
    const blocks: PaperBlock[] = [];
    for (const paper of this.getPapers()) {
      const note = this.app.vault.getFileByPath(paper.notePath);
      if (!note) continue;
      blocks.push(...parsePaperBlocks(await this.app.vault.cachedRead(note), note.path, paper.title));
    }
    if (!blocks.length) {
      new Notice("还没有论文摘录。先打开一篇 PDF，按 Ctrl/Cmd + Shift + E 记录摘录。");
      return;
    }
    new PaperBlockSuggestModal(this.app, blocks, block => editor.replaceSelection(annotationEmbed(block))).open();
  }

  getPapers(): PaperRecord[] {
    const papers: PaperRecord[] = [];
    for (const note of this.app.vault.getMarkdownFiles()) {
      const frontmatter = this.app.metadataCache.getFileCache(note)?.frontmatter;
      const cache = this.app.metadataCache.getFileCache(note);
      if (!hasPaperTag(frontmatter?.tags) && !cache?.tags?.some(tag => tag.tag.toLowerCase() === "#paper")) continue;
      const pdfPath = this.paperForNote(note);
      if (!pdfPath) continue;
      papers.push({
        notePath: note.path,
        pdfPath,
        title: String(frontmatter?.title || note.basename),
        authors: Array.isArray(frontmatter?.authors) ? frontmatter.authors.map(String) : [],
        year: String(frontmatter?.year || ""),
        status: String(frontmatter?.status || "unread"),
        modified: note.stat.mtime
      });
    }
    return papers.sort((a, b) => b.modified - a.modified);
  }

  async getAnnotationIndex(): Promise<PaperAnnotationIndex[]> {
    const output: PaperAnnotationIndex[] = [];
    for (const paper of this.getPapers()) {
      const note = this.app.vault.getFileByPath(paper.notePath);
      if (!note) continue;
      let cached = this.annotationCache.get(note.path);
      if (!cached || cached.mtime !== note.stat.mtime || cached.title !== paper.title || cached.pdf !== paper.pdfPath) {
        cached = { mtime: note.stat.mtime, title: paper.title, pdf: paper.pdfPath,
          rows: parseAnnotationIndex(await this.app.vault.cachedRead(note), note.path, paper.pdfPath, paper.title) };
        this.annotationCache.set(note.path, cached);
      }
      output.push(...cached.rows);
    }
    return output.sort((a, b) => a.paperTitle.localeCompare(b.paperTitle, "zh-CN") || a.page - b.page);
  }

  refreshLibrary(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof PaperLibraryView) view.render();
    }
    for (const leaf of this.app.workspace.getLeavesOfType(ANNOTATION_VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof AnnotationSidebarView) void view.render();
    }
  }
}

class PdfAnnotationManagerModal extends Modal {
  constructor(
    app: App,
    private pdf: TFile,
    private annotations: PdfAnnotationSummary[],
    private openSource: (page: number) => void,
    private editAnnotation: (annotation: PdfAnnotationSummary, contents: string) => Promise<void>,
    private deleteAnnotation: (annotation: PdfAnnotationSummary) => Promise<void>,
    private recolorAnnotation: (annotation: PdfAnnotationSummary, color: string) => Promise<void>,
    private selectedKey?: string
  ) { super(app); }

  onOpen(): void {
    this.modalEl.addClass("ai4d-annotation-manager");
    this.titleEl.setText("PDF 批注");
    this.render();
  }

  private render(): void {
    this.contentEl.empty();
    this.contentEl.createEl("p", { cls: "ai4d-modal-kicker", text: `${this.pdf.basename} · ${this.annotations.length} 条` });
    if (!this.annotations.length) {
      const empty = this.contentEl.createDiv({ cls: "ai4d-annotation-empty" });
      setIcon(empty.createSpan(), "highlighter");
      empty.createEl("strong", { text: "还没有原生 PDF 批注" });
      empty.createEl("p", { text: "在论文中划选文字，即可使用高光、下划线、删除线和文字批注。" });
      return;
    }
    const list = this.contentEl.createDiv({ cls: "ai4d-native-annotation-list" });
    const labels: Record<string, string> = { Highlight: "高光", Underline: "下划线", StrikeOut: "删除线", Text: "文字批注" };
    for (const annotation of this.annotations) {
      const row = list.createDiv({ cls: "ai4d-native-annotation-row" });
      const color = row.createSpan({ cls: "ai4d-native-annotation-color" });
      color.style.setProperty("--annotation-color", annotation.color);
      const body = row.createDiv({ cls: "ai4d-native-annotation-body" });
      const meta = body.createDiv({ cls: "ai4d-native-annotation-meta" });
      meta.createEl("strong", { text: labels[annotation.subtype] ?? annotation.subtype });
      meta.createSpan({ text: `第 ${annotation.page} 页` });
      if (annotation.quote) body.createEl("blockquote", { cls: "ai4d-managed-quote", text: annotation.quote });
      body.createEl("p", { text: annotation.contents || "未添加批注文字" });
      const picker = body.createEl("input", { cls: "ai4d-annotation-color-input", attr: { type: "color", "aria-label": "修改批注颜色" } });
      picker.value = annotation.color;
      picker.addEventListener("change", async () => {
        picker.disabled = true;
        try { await this.recolorAnnotation(annotation, picker.value); color.style.setProperty("--annotation-color", annotation.color); }
        catch (error) { new Notice(error instanceof Error ? error.message : "颜色保存失败"); picker.value = annotation.color; }
        finally { picker.disabled = false; }
      });
      const tools = row.createDiv({ cls: "ai4d-native-annotation-tools" });
      const locate = tools.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "转到原文" } });
      setIcon(locate, "locate-fixed");
      locate.addEventListener("click", () => { this.close(); this.openSource(annotation.page); });
      const edit = tools.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "编辑批注文字" } });
      setIcon(edit, "pencil");
      edit.addEventListener("click", () => this.startInlineEdit(row, annotation));
      const remove = tools.createEl("button", { cls: "clickable-icon mod-warning", attr: { "aria-label": "删除批注" } });
      setIcon(remove, "trash-2");
      remove.addEventListener("click", () => {
        new ConfirmAnnotationDeleteModal(this.app, annotation, async () => {
          await this.deleteAnnotation(annotation);
          this.annotations = this.annotations.filter(item => item !== annotation);
          this.render();
          new Notice("批注已从 PDF 删除");
        }).open();
      });
      if (annotation.key === this.selectedKey) {
        this.selectedKey = undefined;
        this.startInlineEdit(row, annotation);
      }
    }
  }

  private startInlineEdit(row: HTMLElement, annotation: PdfAnnotationSummary): void {
    if (row.hasClass("is-editing")) return;
    row.addClass("is-editing");
    const body = row.querySelector<HTMLElement>(".ai4d-native-annotation-body");
    const tools = row.querySelector<HTMLElement>(".ai4d-native-annotation-tools");
    if (!body || !tools) return;
    const paragraph = body.querySelector("p");
    paragraph?.hide();
    tools.hide();
    const editor = body.createEl("textarea", { cls: "ai4d-native-annotation-editor" });
    editor.value = annotation.contents;
    editor.rows = 3;
    const actions = body.createDiv({ cls: "ai4d-inline-actions" });
    const cancel = actions.createEl("button", { text: "取消" });
    cancel.addEventListener("click", () => { editor.remove(); actions.remove(); paragraph?.show(); tools.show(); row.removeClass("is-editing"); });
    const save = actions.createEl("button", { cls: "mod-cta", text: "保存" });
    save.addEventListener("click", async () => {
      save.setAttr("disabled", "true");
      try {
        await this.editAnnotation(annotation, editor.value.trim());
        annotation.contents = editor.value.trim();
        this.render();
        new Notice("PDF 批注已更新");
      } catch (error) {
        console.error(error);
        new Notice(error instanceof Error ? `更新失败：${error.message}` : "更新批注失败");
        save.removeAttribute("disabled");
      }
    });
    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);
  }
}

class ConfirmAnnotationDeleteModal extends Modal {
  constructor(app: App, private annotation: PdfAnnotationSummary, private confirmDelete: () => Promise<void>) { super(app); }
  onOpen(): void {
    this.modalEl.addClass("ai4d-confirm-modal");
    this.titleEl.setText("删除这条批注？");
    this.contentEl.createEl("p", { text: `将从 PDF 第 ${this.annotation.page} 页删除，并同步移除由本插件创建的 Markdown 来源块。可通过命令“撤销当前论文上一次批注操作”恢复；若文件之后又有修改，将保留备份供检查。` });
    const actions = this.contentEl.createDiv({ cls: "ai4d-batch-actions" });
    actions.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    const remove = actions.createEl("button", { cls: "mod-warning", text: "删除" });
    remove.addEventListener("click", async () => {
      remove.setAttr("disabled", "true");
      try { await this.confirmDelete(); this.close(); }
      catch (error) { console.error(error); new Notice(error instanceof Error ? `删除失败：${error.message}` : "删除批注失败"); remove.removeAttribute("disabled"); }
    });
  }
}

class TextNoteModal extends Modal {
  private comment = "";

  constructor(app: App, private selection: PdfTextSelection, private submit: (comment: string) => Promise<void>) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("ai4d-text-note-modal");
    this.titleEl.setText("添加文字批注");
    this.contentEl.createEl("p", { cls: "ai4d-modal-kicker", text: `${this.selection.pdf.basename} · 第 ${this.selection.page} 页` });
    this.contentEl.createEl("blockquote", { cls: "ai4d-note-selection-preview", text: this.selection.text });
    let input!: HTMLTextAreaElement;
    new Setting(this.contentEl).setName("批注内容").setDesc("将作为标准 PDF 便签写入，也会同步到伴随笔记。").addTextArea(area => {
      area.setPlaceholder("记录疑问、判断或待验证的想法…").onChange(value => this.comment = value);
      input = area.inputEl;
      area.inputEl.rows = 5;
    });
    const actions = this.contentEl.createDiv({ cls: "ai4d-batch-actions" });
    actions.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    const save = actions.createEl("button", { cls: "mod-cta", text: "保存批注" });
    save.addEventListener("click", async () => {
      if (!this.comment.trim()) { new Notice("请先填写批注内容"); input.focus(); return; }
      save.setAttr("disabled", "true");
      try {
        await this.submit(this.comment.trim());
        this.close();
      } catch (error) {
        console.error(error);
        new Notice(error instanceof Error ? `保存失败：${error.message}` : "保存文字批注失败");
        save.removeAttribute("disabled");
      }
    });
    window.setTimeout(() => input.focus(), 30);
  }
}

class AnnotationModal extends Modal {
  private page = "1";
  private quote: string;
  private comment = "";

  constructor(app: App, private pdf: TFile, clipboard: string, private submit: (page: number, quote: string, comment: string) => Promise<void>) {
    super(app);
    this.quote = clipboard.length <= 10000 ? clipboard : "";
  }

  onOpen(): void {
    this.modalEl.addClass("ai4d-annotation-modal");
    this.titleEl.setText("记录论文摘录");
    this.contentEl.createEl("p", { cls: "ai4d-modal-kicker", text: this.pdf.basename });
    new Setting(this.contentEl).setName("页码").setDesc("点击摘录中的链接会返回这一页。").addText(text => {
      text.setValue(this.page).setPlaceholder("1").onChange(value => this.page = value);
      text.inputEl.type = "number";
      text.inputEl.min = "1";
    });
    new Setting(this.contentEl).setName("原文").setDesc(this.quote ? "已自动读取剪贴板，可直接修改。" : "先在 PDF 中复制原文，再打开此窗口会更快。").addTextArea(area => {
      area.setValue(this.quote).setPlaceholder("粘贴或输入论文原文…").onChange(value => this.quote = value);
      area.inputEl.rows = 7;
      area.inputEl.focus();
    });
    new Setting(this.contentEl).setName("我的批注").setDesc("可留空；原文与想法会被明确分开。").addTextArea(area => {
      area.setPlaceholder("这段话为什么重要？").onChange(value => this.comment = value);
      area.inputEl.rows = 4;
    });
    new Setting(this.contentEl).addButton(button => button.setButtonText("保存摘录").setCta().onClick(async () => {
      const page = Number.parseInt(this.page, 10);
      if (!Number.isFinite(page) || page < 1) { new Notice("请输入有效页码"); return; }
      if (!this.quote.trim() && !this.comment.trim()) { new Notice("原文和批注不能同时为空"); return; }
      button.setDisabled(true);
      try { await this.submit(page, this.quote, this.comment); this.close(); }
      catch (error) { new Notice(error instanceof Error ? error.message : "保存失败"); button.setDisabled(false); }
    }));
  }

  onClose(): void { this.contentEl.empty(); }
}

class PaperBlockSuggestModal extends SuggestModal<PaperBlock> {
  constructor(app: App, private blocks: PaperBlock[], private select: (block: PaperBlock) => void) {
    super(app);
    this.setPlaceholder("搜索论文、摘录内容或页码…");
    this.setInstructions([{ command: "↵", purpose: "插入块引用" }, { command: "esc", purpose: "关闭" }]);
  }
  getSuggestions(query: string): PaperBlock[] {
    const needle = query.toLocaleLowerCase();
    return this.blocks.filter(block => `${block.paperTitle} ${block.quote} ${block.translation} ${block.comment} ${block.page}`.toLocaleLowerCase().includes(needle));
  }
  renderSuggestion(block: PaperBlock, el: HTMLElement): void {
    el.addClass("ai4d-block-suggestion");
    el.createEl("div", { cls: "ai4d-block-title", text: `${block.paperTitle} · p.${block.page}` });
    el.createEl("div", { cls: "ai4d-block-quote", text: block.quote || block.comment });
  }
  onChooseSuggestion(block: PaperBlock): void { this.select(block); }
}

class AnnotationSidebarView extends ItemView {
  private query = "";
  private renderVersion = 0;
  private expanded = new Map<string, boolean>();

  constructor(leaf: WorkspaceLeaf, private plugin: PaperNotesPlugin) { super(leaf); }
  getViewType(): string { return ANNOTATION_VIEW_TYPE; }
  getDisplayText(): string { return "论文批注"; }
  getIcon(): string { return "list-filter"; }
  async onOpen(): Promise<void> { await this.render(); }

  async render(): Promise<void> {
    const version = ++this.renderVersion;
    const annotations = await this.plugin.getAnnotationIndex();
    if (version !== this.renderVersion) return;
    const container = this.contentEl;
    container.empty();
    container.addClass("ai4d-annotation-sidebar");
    const header = container.createDiv({ cls: "ai4d-annotation-sidebar-header" });
    const heading = header.createDiv();
    heading.createEl("span", { cls: "ai4d-eyebrow", text: "ANNOTATIONS" });
    heading.createEl("h3", { text: "论文批注" });
    header.createEl("span", { cls: "ai4d-annotation-count", text: String(annotations.length) });
    const close = header.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "收起批注边栏" } });
    setIcon(close, "panel-right-close"); close.addEventListener("click", () => this.leaf.detach());
    const search = container.createEl("input", { cls: "ai4d-library-search", attr: { type: "search", placeholder: "搜索论文、批注内容或页码…" } });
    search.value = this.query;
    const list = container.createDiv({ cls: "ai4d-annotation-groups" });
    search.addEventListener("input", () => { this.query = search.value; this.renderList(list, annotations); });
    this.renderList(list, annotations);
    const footer = container.createDiv({ cls: "ai4d-library-footer" });
    footer.createSpan({ text: "点击批注返回原文" });
    footer.createSpan({ text: "By Nanoarcheaum" });
  }

  private renderList(container: HTMLElement, annotations: PaperAnnotationIndex[]): void {
    container.empty();
    const needle = this.query.trim().toLocaleLowerCase();
    const filtered = annotations.filter(item => `${item.paperTitle} ${item.text} ${item.type} ${item.page}`.toLocaleLowerCase().includes(needle));
    if (!filtered.length) {
      const empty = container.createDiv({ cls: "ai4d-annotation-empty" });
      setIcon(empty.createSpan(), "search-x");
      empty.createEl("strong", { text: needle ? "没有匹配的批注" : "还没有批注" });
      return;
    }
    const groups = new Map<string, PaperAnnotationIndex[]>();
    for (const annotation of filtered) {
      const values = groups.get(annotation.notePath) ?? [];
      values.push(annotation);
      groups.set(annotation.notePath, values);
    }
    const labels: Record<PaperAnnotationIndex["type"], string> = { quote: "摘录", figure: "截图", highlight: "高光", underline: "下划线", strikeout: "删除线", comment: "批注" };
    for (const [notePath, items] of groups) {
      const group = container.createEl("details", { cls: "ai4d-annotation-group" });
      group.open = Boolean(needle) || (this.expanded.get(notePath) ?? groups.size <= 4);
      group.addEventListener("toggle", () => { if (!needle) this.expanded.set(notePath, group.open); });
      const summary = group.createEl("summary");
      summary.createSpan({ text: items[0]!.paperTitle, attr: { title: notePath } });
      group.createEl("small", { cls: "ai4d-group-path", text: notePath });
      summary.createEl("small", { text: String(items.length) });
      const children = group.createDiv({ cls: "ai4d-annotation-group-items" });
      for (const annotation of items) {
        const item = children.createEl("button", { cls: `ai4d-annotation-hit is-${annotation.type}` });
        const meta = item.createDiv({ cls: "ai4d-annotation-hit-meta" });
        meta.createSpan({ text: labels[annotation.type] });
        meta.createSpan({ text: `p.${annotation.page}` });
        item.createEl("p", { text: annotation.text.slice(0, 220) || labels[annotation.type] });
        item.title = annotation.text;
        item.addEventListener("click", () => {
          const pdf = this.app.vault.getFileByPath(annotation.pdfPath);
          if (pdf) void this.plugin.openPaper(pdf, annotation.page);
        });
        const copy = children.createEl("button", { cls: "ai4d-copy-block", text: "复制块引用", attr: { "aria-label": `复制第 ${annotation.page} 页块引用` } });
        copy.addEventListener("click", () => void navigator.clipboard.writeText(annotationEmbed(annotation)).then(() => new Notice("块引用已复制")).catch(() => new Notice("无法访问剪贴板")));
      }
    }
  }
}

class PaperLibraryView extends ItemView {
  private query = "";
  constructor(leaf: WorkspaceLeaf, private plugin: PaperNotesPlugin) { super(leaf); }
  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return "Paper 文件"; }
  getIcon(): string { return "folders"; }
  async onOpen(): Promise<void> { this.render(); }

  render(): void {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("ai4d-library");
    const header = root.createDiv({ cls: "ai4d-library-header" });
    const title = header.createDiv();
    title.createEl("span", { cls: "ai4d-eyebrow", text: "Paper-easy" });
    title.createEl("h3", { text: "Paper 文件" });
    const tools = header.createDiv({ cls: "ai4d-library-tools" });
    if (this.plugin.settings.zoteroEnabled) {
      const sync = tools.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "从 Zotero 同步" } });
      setIcon(sync, "refresh-cw");
      sync.addEventListener("click", () => void this.plugin.syncFromZotero());
    }
    const translate = tools.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "翻译当前论文选段" } });
    setIcon(translate, "languages");
    translate.addEventListener("click", () => {
      const pdf = this.plugin.activePdf();
      if (pdf) void this.plugin.translateSelection(pdf);
      else new Notice("请先打开一篇 PDF 或它的伴随笔记");
    });
    const search = root.createEl("input", { cls: "ai4d-library-search", attr: { type: "search", placeholder: "筛选文件名、路径、作者…", "aria-label": "筛选 Paper 文件" } });
    search.value = this.query;
    search.addEventListener("input", () => { this.query = search.value; this.renderList(list); });
    const list = root.createDiv({ cls: "ai4d-paper-list" });
    this.renderList(list);
    const footer = root.createDiv({ cls: "ai4d-library-footer" });
    footer.createSpan({ text: `${this.plugin.getPapers().length} 篇论文 · 本地保存` });
    footer.createSpan({ text: "By Nanoarcheaum" });
  }

  private renderList(list: HTMLElement): void {
    list.empty();
    const needle = this.query.trim().toLocaleLowerCase();
    const papers = this.plugin.getPapers().filter(paper => `${paper.title} ${paper.notePath} ${paper.pdfPath} ${paper.authors.join(" ")} ${paper.year}`.toLocaleLowerCase().includes(needle));
    if (!papers.length) {
      const empty = list.createDiv({ cls: "ai4d-empty" });
      empty.createEl("div", { cls: "ai4d-empty-mark", text: "⌁" });
      empty.createEl("strong", { text: needle ? "没有匹配的 Paper 文件" : "还没有带 Paper 标签的笔记" });
      empty.createEl("p", { text: needle ? "换一个关键词试试。" : "点击左侧功能区的导入按钮，或给现有论文笔记添加 Paper 标签。" });
      return;
    }
    const tree: PaperFolderNode = { folders: new Map(), papers: [] };
    for (const paper of papers) {
      const parts = paper.notePath.split("/").slice(0, -1);
      let node = tree;
      for (const part of parts) {
        if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), papers: [] });
        node = node.folders.get(part)!;
      }
      node.papers.push(paper);
    }
    this.renderFolderNode(list, tree, 0);
  }

  private renderFolderNode(container: HTMLElement, node: PaperFolderNode, depth: number): void {
    const folders = [...node.folders.entries()].sort(([a], [b]) => a.localeCompare(b, "zh-CN"));
    for (const [name, child] of folders) {
      const details = container.createEl("details", { cls: "ai4d-tree-folder" });
      details.open = depth < 2;
      const summary = details.createEl("summary");
      const icon = summary.createSpan({ cls: "ai4d-tree-icon" });
      setIcon(icon, "folder");
      summary.createSpan({ text: name });
      const body = details.createDiv({ cls: "ai4d-tree-children" });
      this.renderFolderNode(body, child, depth + 1);
    }
    for (const paper of [...node.papers].sort((a, b) => a.title.localeCompare(b.title, "zh-CN"))) {
      const pdf = container.createEl("button", { cls: "ai4d-tree-file" });
      const pdfIcon = pdf.createSpan({ cls: "ai4d-tree-icon" });
      setIcon(pdfIcon, "file-text");
      pdf.createSpan({ cls: "ai4d-tree-name", text: paper.pdfPath.split("/").at(-1) ?? paper.title });
      pdf.createSpan({ cls: `ai4d-tree-status is-${paper.status}`, text: statusLabel(paper.status) });
      pdf.addEventListener("click", () => {
        const file = this.app.vault.getFileByPath(paper.pdfPath);
        if (file) void this.plugin.openPaper(file);
        else new Notice("找不到关联的 PDF 文件");
      });
      const note = container.createEl("button", { cls: "ai4d-tree-file" });
      const noteIcon = note.createSpan({ cls: "ai4d-tree-icon" });
      setIcon(noteIcon, "notebook-pen");
      note.createSpan({ cls: "ai4d-tree-name", text: paper.notePath.split("/").at(-1) ?? `${paper.title}.md` });
      note.addEventListener("click", () => {
        const file = this.app.vault.getFileByPath(paper.notePath);
        if (file) void this.app.workspace.getLeaf(false).openFile(file);
      });
    }
  }
}

interface PaperFolderNode {
  folders: Map<string, PaperFolderNode>;
  papers: PaperRecord[];
}

const statusLabel = (status: string): string => ({ unread: "待读", reading: "在读", done: "已读" }[status] ?? status);

class FolderSuggestModal extends SuggestModal<TFolder> {
  private folders: TFolder[];
  constructor(app: App, initialPath: string, private selectFolder: (folder: TFolder) => void) {
    super(app);
    this.folders = app.vault.getAllLoadedFiles().filter((file): file is TFolder => file instanceof TFolder)
      .sort((a, b) => Number(b.path === initialPath) - Number(a.path === initialPath) || a.path.localeCompare(b.path, "zh-CN"));
    this.setPlaceholder("选择论文所属的学科文件夹…");
    this.setInstructions([{ command: "↵", purpose: "在这里导入" }, { command: "esc", purpose: "取消" }]);
  }
  getSuggestions(query: string): TFolder[] {
    const needle = query.trim().toLocaleLowerCase();
    return this.folders.filter(folder => (folder.path || "Vault 根目录").toLocaleLowerCase().includes(needle));
  }
  renderSuggestion(folder: TFolder, el: HTMLElement): void {
    el.createEl("div", { cls: "ai4d-folder-choice", text: folder.path || "Vault 根目录" });
  }
  onChooseSuggestion(folder: TFolder): void { this.selectFolder(folder); }
}

class BatchImportModal extends Modal {
  private assignments: ImportAssignment[];
  constructor(app: App, files: File[], defaultFolder: string, private submit: (assignments: ImportAssignment[]) => void) {
    super(app);
    this.assignments = files.map(source => ({ source, destinationFolder: defaultFolder }));
  }
  onOpen(): void {
    this.modalEl.addClass("ai4d-batch-import-modal");
    this.titleEl.setText(`批量导入 ${this.assignments.length} 篇论文`);
    this.contentEl.createEl("p", { text: "每篇论文会在所选学科下建立独立文件夹，并生成 PDF、同名笔记和 Paper 标签。" });
    const toolbar = this.contentEl.createDiv({ cls: "ai4d-batch-toolbar" });
    const sameFolder = toolbar.createEl("button", { text: "统一设置目标文件夹" });
    const rows = this.contentEl.createDiv({ cls: "ai4d-import-rows" });
    const renderRows = (): void => {
      rows.empty();
      this.assignments.forEach((assignment, index) => {
        const row = rows.createDiv({ cls: "ai4d-import-row" });
        const file = row.createDiv({ cls: "ai4d-import-file" });
        file.createEl("strong", { text: safeStem(assignment.source.name) });
        file.createEl("small", { text: assignment.source.name });
        const folder = row.createEl("button", { cls: "ai4d-import-folder" });
        setIcon(folder, "folder");
        folder.createSpan({ text: assignment.destinationFolder || "Vault 根目录" });
        folder.addEventListener("click", () => new FolderSuggestModal(this.app, assignment.destinationFolder, selected => {
          this.assignments[index]!.destinationFolder = selected.path;
          renderRows();
        }).open());
      });
    };
    sameFolder.addEventListener("click", () => new FolderSuggestModal(this.app, this.assignments[0]?.destinationFolder ?? "", selected => {
      this.assignments.forEach(assignment => assignment.destinationFolder = selected.path);
      renderRows();
    }).open());
    renderRows();
    const actions = this.contentEl.createDiv({ cls: "ai4d-batch-actions" });
    const cancel = actions.createEl("button", { text: "取消" });
    cancel.addEventListener("click", () => this.close());
    const confirm = actions.createEl("button", { cls: "mod-cta", text: "开始导入" });
    confirm.addEventListener("click", () => { this.submit(this.assignments); this.close(); });
  }
  onClose(): void { this.contentEl.empty(); }
}

class PaperNotesSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: PaperNotesPlugin) { super(app, plugin); }
  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Paper-easy" });
    containerEl.createEl("p", { text: "插件直接使用当前 Vault。导入论文时选择所属学科文件夹，PDF 与同名 Markdown 就地保存，不建立集中式论文目录。" });
    new Setting(containerEl).setName("左右分屏打开").setDesc("打开论文时，PDF 在左，伴随笔记在右。").addToggle(toggle => toggle.setValue(this.plugin.settings.openSideBySide).onChange(async value => {
      this.plugin.settings.openSideBySide = value;
      await this.plugin.saveSettings();
    }));
    new Setting(containerEl).setName("论文保持原始颜色").setDesc("关闭主题对 PDF 的反色滤镜，避免夜间主题中出现黑底白字和图片颜色反转。").addToggle(toggle => toggle.setValue(this.plugin.settings.preservePdfColors).onChange(async value => {
      this.plugin.settings.preservePdfColors = value;
      this.plugin.applyPdfColorPreference();
      await this.plugin.saveSettings();
    }));
    new Setting(containerEl).setName("新论文默认状态").addDropdown(dropdown => dropdown.addOptions({ unread: "待读", reading: "在读", done: "已读" }).setValue(this.plugin.settings.defaultStatus).onChange(async value => {
      this.plugin.settings.defaultStatus = value;
      await this.plugin.saveSettings();
    }));
    containerEl.createEl("h3", { text: "PDF 原生批注" });
    containerEl.createEl("p", { text: "高光、下划线、删除线和文字便签会直接写入 PDF 标准批注层，同时在伴随笔记中生成可检索的来源块。" });
    new Setting(containerEl).setName("默认批注颜色").setDesc("划选文字后的浮动工具条也可以快速切换四色。 ").addColorPicker(picker => picker.setValue(this.plugin.settings.annotationColor).onChange(async value => {
      this.plugin.settings.annotationColor = value;
      await this.plugin.saveSettings();
    }));
    new Setting(containerEl).setName("批注作者").setDesc("会写入 PDF 批注元数据，便于与 Zotero 等阅读器共用。").addText(text => text.setValue(this.plugin.settings.annotationAuthor).setPlaceholder("你的名字").onChange(async value => {
      this.plugin.settings.annotationAuthor = value.trim() || "Nanoarcheaum";
      await this.plugin.saveSettings();
    }));
    containerEl.createEl("h3", { text: "Zotero 兼容模式" });
    containerEl.createEl("p", { text: "Zotero 管理题录，Obsidian 管理 Markdown 笔记；双方引用同一份 PDF。请先在 Zotero 设置的高级选项中允许本机应用通信。" });
    new Setting(containerEl).setName("启用 Zotero 兼容模式").setDesc("不会读取 Zotero 数据库文件，只连接 Zotero 官方本地 API。").addToggle(toggle => toggle.setValue(this.plugin.settings.zoteroEnabled).onChange(async value => {
      this.plugin.settings.zoteroEnabled = value;
      await this.plugin.saveSettings();
      this.plugin.refreshLibrary();
    }));
    new Setting(containerEl).setName("Zotero 本地接口").setDesc("通常无需修改。").addText(text => text.setValue(this.plugin.settings.zoteroBaseUrl).onChange(async value => {
      this.plugin.settings.zoteroBaseUrl = value.trim() || DEFAULT_SETTINGS.zoteroBaseUrl;
      await this.plugin.saveSettings();
    }));
    new Setting(containerEl).setName("立即同步").setDesc("以 Zotero 的题录为准，更新同名 PDF 的 Markdown 属性。").addButton(button => button.setButtonText("从 Zotero 同步").onClick(() => void this.plugin.syncFromZotero()));

    containerEl.createEl("h3", { text: "选段翻译" });
    containerEl.createEl("p", { text: "插件只在你点击翻译后发送当前选段，不会上传整篇论文。兼容常见的 Chat Completions 接口，也可填写本机模型地址。" });
    new Setting(containerEl).setName("翻译服务").setDesc("DeepSeek 开箱即用但需要 API Key；Ollama 完全本地但需要先安装模型。").addDropdown(dropdown => dropdown.addOptions({
      custom: "自定义兼容接口",
      deepseek: "DeepSeek 云端",
      ollama: "Ollama 本地"
    }).setValue(this.plugin.settings.translationPreset).onChange(async value => {
      this.plugin.settings.translationPreset = value as PaperNotesSettings["translationPreset"];
      if (value === "deepseek") {
        this.plugin.settings.translationEndpoint = "https://api.deepseek.com/chat/completions";
        this.plugin.settings.translationModel = "deepseek-v4-flash";
      } else if (value === "ollama") {
        this.plugin.settings.translationEndpoint = "http://localhost:11434/api/chat";
        this.plugin.settings.translationModel = "qwen3:14b";
        this.plugin.settings.translationApiKey = "";
      }
      await this.plugin.saveSettings();
      this.display();
    }));
    new Setting(containerEl).setName("接口地址").setDesc("例如服务商的 /v1/chat/completions，或本机 Ollama 兼容地址。").addText(text => text.setPlaceholder("https://…/v1/chat/completions").setValue(this.plugin.settings.translationEndpoint).onChange(async value => {
      this.plugin.settings.translationEndpoint = value.trim();
      await this.plugin.saveSettings();
    }));
    new Setting(containerEl).setName("模型").addText(text => text.setPlaceholder("模型名称").setValue(this.plugin.settings.translationModel).onChange(async value => {
      this.plugin.settings.translationModel = value.trim();
      await this.plugin.saveSettings();
    }));
    new Setting(containerEl).setName("API 密钥").setDesc("仅保存在当前 Vault 的插件配置中；使用本机模型时可留空。").addText(text => {
      text.setPlaceholder("可留空").setValue(this.plugin.settings.translationApiKey).onChange(async value => {
        this.plugin.settings.translationApiKey = value.trim();
        await this.plugin.saveSettings();
      });
      text.inputEl.type = "password";
    });
    new Setting(containerEl).setName("目标语言").addText(text => text.setValue(this.plugin.settings.targetLanguage).onChange(async value => {
      this.plugin.settings.targetLanguage = value.trim() || "简体中文";
      await this.plugin.saveSettings();
    }));
    new Setting(containerEl).setName("测试翻译接口").setDesc("发送一句简短测试文本，确认地址、模型和密钥可用。").addButton(button => button.setButtonText("测试连接").onClick(async () => {
      button.setDisabled(true).setButtonText("测试中…");
      try {
        const result = await translateText("Scientific discovery begins with a precise question.", {
          endpoint: this.plugin.settings.translationEndpoint,
          apiKey: this.plugin.settings.translationApiKey,
          model: this.plugin.settings.translationModel,
          targetLanguage: this.plugin.settings.targetLanguage
        });
        new Notice(`翻译接口正常：${result.slice(0, 60)}`);
      } catch (error) {
        new Notice(error instanceof Error ? error.message : "翻译接口测试失败");
      } finally {
        button.setDisabled(false).setButtonText("测试连接");
      }
    }));
  }
}

function formatCreators(creators: ZoteroCreator[]): string[] {
  return creators
    .filter(creator => !creator.creatorType || creator.creatorType === "author")
    .map(creator => creator.name || [creator.firstName, creator.lastName].filter(Boolean).join(" "))
    .filter((name): name is string => Boolean(name));
}

function hasPaperTag(tags: unknown): boolean {
  const values = Array.isArray(tags) ? tags : typeof tags === "string" ? tags.split(/[\s,]+/) : [];
  return values.some(tag => String(tag).replace(/^#/, "").toLocaleLowerCase() === "paper");
}
