/**
 * 部署前自检（由 npm run deploy 自动触发）
 * 目的：避免用占位符 database_id 或漏配密钥就上线，导致线上静默失败。
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PLACEHOLDER = '00000000-0000-0000-0000-000000000000';
const LEGACY_PLACEHOLDER = 'REPLACE_WITH_YOUR_D1_DATABASE_ID';

const problems = [];
const warnings = [];

/* 1. database_id 是否已填 */
const toml = readFileSync(resolve(ROOT, 'wrangler.toml'), 'utf8');
if (toml.includes(PLACEHOLDER) || toml.includes(LEGACY_PLACEHOLDER)) {
  problems.push('wrangler.toml 的 database_id 还是占位符 —— 先运行 npm run setup');
}

/* 2. 是否已登录（未登录就不必再查密钥，否则提示会很误导） */
const who = spawnSync('npx', ['wrangler', 'whoami'], {
  cwd: ROOT,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});
const whoOut = `${who.stdout || ''}${who.stderr || ''}`;
const authed = who.status === 0 && !/not authenticated/i.test(whoOut);

if (!authed) {
  problems.push('尚未登录 Cloudflare —— 先运行 npx wrangler login');
}

/*
 * 3. 密钥检查已移除
 *
 * 现在后台账号密码在首次访问 /admin 时创建，短信商密钥和 Turnstile Secret
 * 都在后台「配置」页填写（加密存 D1），因此部署前不再需要检查环境变量。
 */

/* 4. 输出 */
warnings.forEach((w) => console.log(`  \x1b[33m!\x1b[0m 提醒：${w}`));
if (problems.length) {
  console.error('\n\x1b[31m部署前检查未通过：\x1b[0m');
  problems.forEach((p) => console.error(`  · ${p}`));
  console.error('');
  process.exit(1);
}
console.log('  \x1b[32m✓\x1b[0m 部署前检查通过');
