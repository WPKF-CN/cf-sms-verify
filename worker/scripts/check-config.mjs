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

/* 3. 密钥是否已配置（仅登录后检查） */
if (authed) {
  const res = spawnSync('npx', ['wrangler', 'secret', 'list', '--format', 'json'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = `${res.stdout || ''}${res.stderr || ''}`;

  // Worker 还不存在时会报错，这属于首次部署的正常情况
  if (res.status !== 0 && !/not found|does not exist|10007/i.test(out)) {
    warnings.push('无法读取密钥列表（首次部署可忽略）');
  }

  let names = [];
  try {
    const parsed = JSON.parse((res.stdout || '').trim() || '[]');
    names = Array.isArray(parsed) ? parsed.map((s) => s.name) : [];
  } catch {
    names = (res.stdout || '').match(/"name"\s*:\s*"([^"]+)"/g)?.map((s) => s.match(/"([^"]+)"$/)[1]) || [];
  }
  const has = (n) => names.includes(n);

  if (!has('ADMIN_PASSWORD_HASH')) problems.push('缺少密钥 ADMIN_PASSWORD_HASH（后台密码）—— 运行 npm run secrets');
  if (!has('SESSION_SECRET')) problems.push('缺少密钥 SESSION_SECRET —— 运行 npm run secrets');

  const twilioOk = has('TWILIO_ACCOUNT_SID') && has('TWILIO_AUTH_TOKEN') && has('TWILIO_VERIFY_SERVICE_SID');
  const plivoOk = has('PLIVO_AUTH_ID') && has('PLIVO_AUTH_TOKEN') && has('PLIVO_APP_UUID');
  if (!twilioOk && !plivoOk) {
    problems.push('Twilio 和 Plivo 都没有配齐，部署后无法发送验证码 —— 运行 npm run secrets');
  }
  if (twilioOk && !has('TWILIO_VERIFY_SERVICE_SID')) {
    problems.push('Twilio 缺少 TWILIO_VERIFY_SERVICE_SID（VA 开头）');
  }
  if (!has('TURNSTILE_SECRET')) {
    warnings.push('未配置 TURNSTILE_SECRET —— 人机检测不会生效，上线后建议补上');
  }
}

/* 4. 输出 */
warnings.forEach((w) => console.log(`  \x1b[33m!\x1b[0m 提醒：${w}`));
if (problems.length) {
  console.error('\n\x1b[31m部署前检查未通过：\x1b[0m');
  problems.forEach((p) => console.error(`  · ${p}`));
  console.error('');
  process.exit(1);
}
console.log('  \x1b[32m✓\x1b[0m 部署前检查通过');
