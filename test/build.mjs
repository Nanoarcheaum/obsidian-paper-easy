import { build } from 'esbuild';
const options = { bundle: true, platform: 'node', format: 'esm', outdir: 'test-dist', outExtension: { '.js': '.mjs' } };
await build({ ...options, entryPoints: ['src/paper.ts', 'src/pdf-annotations.ts', 'src/transactions.ts', 'src/zotero-matching.ts'] });
await build({ ...options, entryPoints: ['src/translator.ts', 'src/zotero.ts', 'src/write-store.ts'], alias: { obsidian: './test/obsidian-mock.mjs' } });
await build({ entryPoints: ['src/main.ts'], bundle: true, platform: 'browser', format: 'esm', outfile: 'test-dist/plugin.js', alias: { obsidian: './test/obsidian-mock.mjs' } });
