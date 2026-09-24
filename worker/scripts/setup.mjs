/**
 * 一键初始化：建 D1 数据库 → 自动把 database_id 写进 wrangler.toml → 建表
 *
 *   npm run setup            正常执行
 *   npm run setup -- --check 只检查状态，不改动任何东西
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const TOML = resolve(ROOT, 'wrangler.toml');

const CHECK_ONLY = process.argv.includes('--check');
const DB_NAME = 'sms-verify';
// 可选：指定数据库主区域，例如 WV_D1_LOCATION=enam npm run setup（用户多在北美时推荐 enam）
const LOCATION = String(process.env.WV_D1_LOCATION || '').trim();
const LOCATIONS = ['weur', 'eeur', 'apac', 'oc', 'wnam', 'enam'];
// 仓库里的占位值（Deploy 按钮或本脚本会把它替换成真实 ID）
const PLACEHOLDER = '00000000-0000-0000-0000-000000000000';
const LEGACY_PLACEHOLDER = 'REPLACE_WITH_YOUR_D1_DATABASE_ID';
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/* ───────────── 工具 ───────────── */

function run(args, opts = {}) {
  return spawnSync('npx', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: opts.capture ? 'pipe' : 'inherit',
    ...opts,
  });
}

function log(msg) { console.log(msg); }
function step(n, msg) { console.log(`\n\x1b[36m[${n}]\x1b[0m ${msg}`); }
function ok(msg) { console.log(`  \x1b[32m✓\x1b[0m ${msg}`); }
function warn(msg) { console.log(`  \x1b[33m!\x1b[0m ${msg}`); }

export function parseDatabaseId(text) {
  const m = String(text || '').match(/database_id\s*=\s*"([^"]+)"/i);
  if (m && UUID_RE.test(m[1])) return m[1];
  const u = String(text || '').match(UUID_RE);
  return u ? u[0] : null;
}

export function patchToml(content, id) {
  if (content.includes(PLACEHOLDER)) {
    return content.replace(new RegExp(`database_id\\s*=\\s*"${PLACEHOLDER}"`), `database_id = "${id}"`);
  }
  return content.replace(/database_id\s*=\s*"[^"]*"/, `database_id = "${id}"`);
}

/* ───────────── 主流程 ───────────── */

async function main() {
  log('SMS Verify 部署助手' + (CHECK_ONLY ? '（仅检查）' : ''));

  /* 0. 登录状态 */
  step(0, '检查 Cloudflare 登录状态');
  const who = run(['wrangler', 'whoami'], { capture: true });
  const whoOut = `${who.stdout || ''}${who.stderr || ''}`;
  const authed = who.status === 0 && !/not authenticated/i.test(whoOut);
  if (!authed) {
    warn('尚未登录 Cloudflare');
    log('\n  请先执行下面这条命令完成浏览器授权（必须由你本人登录）：');
    log('\n    cd ' + ROOT);
    log('    npx wrangler login\n');
    log('  登录完成后再运行：npm run setup');
    process.exit(1);
  }
  ok('已登录 Cloudflare');

  /* 1. 读取 wrangler.toml，看 database_id 是否已填 */
  let toml = readFileSync(TOML, 'utf8');
  const currentId = parseDatabaseId(toml);
  const needsCreate = toml.includes(PLACEHOLDER);
  if (needsCreate) warn('wrangler.toml 里的 database_id 还是占位符');
  else ok(`wrangler.toml 已配置 database_id: ${currentId}`);

  /* 2. 建库（如果还没建） */
  if (needsCreate) {
    step(1, `创建 D1 数据库 ${DB_NAME}${LOCATION ? `（区域：${LOCATION}）` : ''}`);
    if (CHECK_ONLY) {
      warn('仅检查模式：跳过创建');
    } else {
      if (LOCATION && !LOCATIONS.includes(LOCATION)) {
        console.error(`\n  区域参数不合法：${LOCATION}，可选值：${LOCATIONS.join(' / ')}\n`);
        process.exit(1);
      }
      const createArgs = ['wrangler', 'd1', 'create', DB_NAME];
      if (LOCATION) createArgs.push('--location', LOCATION);
      const created = run(createArgs, { capture: true });
      const out = `${created.stdout || ''}${created.stderr || ''}`;

      let id = parseDatabaseId(out);
      if (!id) {
        // 可能已存在同名库，改为列出后解析
        warn('创建未成功（可能同名库已存在），尝试从已有列表里查找…');
        const list = run(['wrangler', 'd1', 'list'], { capture: true });
        const listOut = `${list.stdout || ''}${list.stderr || ''}`;
        const line = listOut.split('\n').find((l) => l.includes(DB_NAME) && UUID_RE.test(l));
        id = line ? line.match(UUID_RE)[0] : null;
      }

      if (!id) {
        console.error('\n  无法自动获取 database_id。请手动执行：');
        console.error('    npx wrangler d1 list');
        console.error('  把 sms-verify 对应的 UUID 填进 wrangler.toml 的 database_id 后，重新运行 npm run setup\n');
        process.exit(1);
      }

      writeFileSync(TOML, patchToml(toml, id));
      toml = readFileSync(TOML, 'utf8');
      ok(`已创建数据库并把 database_id 写入 wrangler.toml：${id}`);
    }
  }

  /* 3. 建表 */
  step(2, '建表（config / verifications / rate / secrets / admins / links）');
  if (CHECK_ONLY) {
    warn('仅检查模式：跳过建表');
  } else {
    const res = run(['wrangler', 'd1', 'execute', DB_NAME, '--remote', '--file=./schema.sql']);
    if (res.status !== 0) {
      console.error('\n  建表失败，请先确认 wrangler.toml 里的 database_id 是否正确。\n');
      process.exit(1);
    }
    ok('表结构已就绪（重复执行也安全）');
  }

  /* 4. 下一步提示 */
  log('\n' + '─'.repeat(56));
  log('接下来还有 2 步：');
  log('');
  log('  1) 配置密钥（交互式，会依次询问后台密码和短信商密钥）');
  log('       npm run secrets');
  log('');
  log('  2) 部署上线');
  log('       npm run deploy');
  log('');
  log('  部署完成后会打印形如 https://sms-verify.<账号>.workers.dev 的地址：');
  log('    · 后台   <地址>/admin');
  log('    · 演示页 <地址>/demo');
  log('    · 把这个地址填进落地页 ai/index.html 的 apiBase 即接入完成');
  log('─'.repeat(56) + '\n');
}

// 只在直接运行时执行（被 import 时只导出工具函数，方便测试）
if (process.argv[1] && process.argv[1].endsWith('setup.mjs')) {
  main().catch((err) => {
    console.error('\n出错了：', err?.message || err);
    process.exit(1);
  });
}
