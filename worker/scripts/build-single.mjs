/**
 * 打包成「单文件 Worker」，用于 Cloudflare 网页后台手动部署。
 *
 *   npm run bundle
 *
 * 产物：dist/worker.js —— 直接复制粘贴到 Cloudflare 后台的编辑器即可，
 * 不需要本地构建、不需要 wrangler、不需要登录。
 */
import { build } from 'esbuild';
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT_DIR = resolve(ROOT, 'dist');
const OUT_FILE = resolve(OUT_DIR, 'worker.js');

mkdirSync(OUT_DIR, { recursive: true });

const MIN_FILE = resolve(OUT_DIR, 'worker.min.js');

const common = {
  entryPoints: [resolve(ROOT, 'src/index.js')],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'browser',
  legalComments: 'none',
  // 把 .txt / .html 当作字符串内联（等价于 wrangler 的 Text rule）
  loader: {
    '.txt': 'text',
    '.html': 'text',
  },
};

// 在文件头部加一段部署说明（Cloudflare 编辑器里能看到）
const banner = `/*
 * SMS Verify Worker —— 单文件版
 *
 * 部署方式（Cloudflare 网页后台）：
 *   1. 控制台 → Compute (Workers) → Create → Start with Hello World
 *   2. 把本文件全部内容覆盖粘贴到左侧编辑器
 *   3. Deploy
 *   4. Settings → Bindings 添加 D1 数据库绑定，变量名必须填 DB
 *   5. Settings → Variables and Secrets 添加各项密钥
 *   6. 访问 <你的地址>/admin 登录后台
 *
 * 注意：本文件是打包产物，不要直接改这里；改源码后重新执行 npm run bundle
 */

`;

// ① 可读版（推荐：方便在后台编辑器里查看）
const r1 = await build({ ...common, outfile: OUT_FILE, minify: false });
if (r1.errors?.length) {
  console.error(r1.errors);
  process.exit(1);
}
const { readFileSync } = await import('node:fs');
writeFileSync(OUT_FILE, banner + readFileSync(OUT_FILE, 'utf8'));

// ② 压缩版（体积更小，粘贴更顺畅）
const r2 = await build({ ...common, outfile: MIN_FILE, minify: true });
if (r2.errors?.length) {
  console.error(r2.errors);
  process.exit(1);
}
writeFileSync(MIN_FILE, banner + readFileSync(MIN_FILE, 'utf8'));

const kb = (n) => (n / 1024).toFixed(1) + ' KB';
console.log('');
console.log(`  \x1b[32m✓\x1b[0m dist/worker.js      ${kb(statSync(OUT_FILE).size)}   可读版（推荐）`);
console.log(`  \x1b[32m✓\x1b[0m dist/worker.min.js  ${kb(statSync(MIN_FILE).size)}   压缩版（粘贴更快）`);
console.log('');
console.log('  复制其中任意一个文件的全部内容，粘贴到 Cloudflare 后台的 Worker 编辑器即可。');
console.log('  详细步骤见：sms-verify/手动部署指南.md\n');
