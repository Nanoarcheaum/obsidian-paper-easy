import { requestUrl } from "obsidian";
import { verifyWriteResult } from "./zotero-matching";

interface PendingLink { parentKey: string; attachmentKey: string; }

export interface ZoteroCreator {
  creatorType?: string;
  firstName?: string;
  lastName?: string;
  name?: string;
}

export interface ZoteroItemData {
  key: string;
  version?: number;
  itemType: string;
  title?: string;
  creators?: ZoteroCreator[];
  date?: string;
  DOI?: string;
  publicationTitle?: string;
  abstractNote?: string;
  tags?: Array<{ tag: string }>;
  parentItem?: string;
  linkMode?: string;
  contentType?: string;
  filename?: string;
  path?: string;
}

interface ZoteroEnvelope { data: ZoteroItemData; }

export interface ZoteroPaperMatch {
  item: ZoteroItemData;
  attachment: ZoteroItemData;
}

export class ZoteroLocalClient {
  private serverId = "";
  private zoteroVersion = "unknown";
  constructor(private baseUrl: string, private apiKey: string, private saveKey: (key: string) => Promise<void>) {}

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  }

  private headers(write = false): Record<string, string> {
    const headers: Record<string, string> = {
      "Zotero-API-Version": "3",
      "Zotero-Allowed-Request": "1"
    };
    if (this.serverId) headers["Zotero-Server-ID"] = this.serverId;
    if (write && this.apiKey) headers["Zotero-API-Key"] = this.apiKey;
    return headers;
  }

  async ping(): Promise<void> {
    const response = await requestUrl({ url: this.url("users/0/items?limit=1"), headers: this.headers() });
    this.serverId = response.headers["zotero-server-id"] ?? response.headers["Zotero-Server-ID"] ?? this.serverId;
    this.zoteroVersion = response.headers["x-zotero-version"] ?? response.headers["X-Zotero-Version"] ?? this.zoteroVersion;
  }

  private async allItems(query: string): Promise<ZoteroItemData[]> {
    const result: ZoteroItemData[] = [];
    for (let start = 0; ; start += 100) {
      const separator = query.includes("?") ? "&" : "?";
      const response = await requestUrl({ url: this.url(`${query}${separator}format=json&limit=100&start=${start}`), headers: this.headers() });
      const page = response.json as ZoteroEnvelope[];
      result.push(...page.map(entry => entry.data));
      if (page.length < 100) return result;
    }
  }

  async paperMatches(): Promise<ZoteroPaperMatch[]> {
    await this.ping();
    const [parents, attachments] = await Promise.all([
      this.allItems("users/0/items/top?itemType=-attachment"),
      this.allItems("users/0/items?itemType=attachment")
    ]);
    const parentMap = new Map(parents.map(item => [item.key, item]));
    return attachments
      .filter(item => item.contentType === "application/pdf" && item.parentItem && parentMap.has(item.parentItem))
      .map(attachment => ({ item: parentMap.get(attachment.parentItem ?? "")!, attachment }));
  }

  private async authorize(): Promise<void> {
    await this.ping();
    const response = await requestUrl({
      url: this.url("local/authorize"),
      method: "POST",
      contentType: "application/json",
      headers: this.headers(),
      body: JSON.stringify({ appName: "Paper-easy" }),
      throw: false
    });
    if (response.status !== 200 || !response.json?.key) throw new Error(response.status === 403 ? "你在 Zotero 中拒绝了写入授权" : "无法获得 Zotero 写入授权");
    this.apiKey = String(response.json.key);
    await this.saveKey(this.apiKey);
  }

  async createLinkedPaper(input: { title: string; authors: string[]; year: string; doi: string; pdfPath: string; pending?: PendingLink; savePending: (pending: PendingLink) => Promise<void> }): Promise<PendingLink> {
    if (!this.serverId) await this.ping();
    if (!this.serverId) throw new Error(`Zotero ${this.zoteroVersion} 未提供本地写入能力标识。请暂时在 Zotero 中使用“链接到文件”选择这份 PDF。`);
    if (!this.apiKey) await this.authorize();
    const pending = input.pending ?? { parentKey: zoteroKey(), attachmentKey: zoteroKey() };
    if (![pending.parentKey, pending.attachmentKey].every(key => /^[A-Z0-9]{8}$/.test(key))) throw new Error("Zotero 待完成关联无效，请检查笔记属性。");
    await input.savePending(pending);
    const { parentKey, attachmentKey } = pending;
    const creators = input.authors.map(name => ({ creatorType: "author", name }));
    const payload = [
      {
        key: parentKey,
        itemType: "journalArticle",
        title: input.title,
        creators,
        date: input.year,
        DOI: input.doi,
        publicationTitle: "",
        abstractNote: "",
        tags: [],
        collections: [],
        relations: {}
      },
      {
        key: attachmentKey,
        itemType: "attachment",
        parentItem: parentKey,
        linkMode: "linked_file",
        title: "PDF",
        contentType: "application/pdf",
        path: input.pdfPath,
        note: "",
        tags: [],
        relations: {}
      }
    ];
    const missing = [];
    for (const item of payload) {
      const existing = await requestUrl({ url: this.url(`users/0/items/${item.key}`), headers: this.headers(), throw: false });
      if (existing.status === 404) { missing.push(item); continue; }
      if (existing.status !== 200 || existing.json?.data?.key !== item.key) throw new Error("无法核对 Zotero 已保存进度，请稍后重试。");
      const data = existing.json.data;
      if (data.itemType !== item.itemType || (item.itemType === "attachment" && (data.path !== input.pdfPath || data.parentItem !== parentKey))) throw new Error("Zotero 关联与预期不符，未覆盖现有条目。");
    }
    if (!missing.length) return pending;
    const token = writeToken();
    let response = await requestUrl({
      url: this.url("users/0/items"), method: "POST", contentType: "application/json",
      headers: { ...this.headers(true), "Zotero-Write-Token": token }, body: JSON.stringify(missing), throw: false
    });
    if (response.status === 401) {
      this.apiKey = "";
      await this.authorize();
      response = await requestUrl({
        url: this.url("users/0/items"), method: "POST", contentType: "application/json",
        headers: { ...this.headers(true), "Zotero-Write-Token": token }, body: JSON.stringify(missing), throw: false
      });
    }
    if (response.status !== 200) throw new Error(`Zotero 写入失败（HTTP ${response.status}）`);
    verifyWriteResult(response.json, missing.map(item => item.key));
    return pending;
  }
}

function zoteroKey(): string {
  const alphabet = "23456789ABCDEFGHIJKLMNPQRSTUVWXYZ";
  return Array.from({ length: 8 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}

function writeToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
}
