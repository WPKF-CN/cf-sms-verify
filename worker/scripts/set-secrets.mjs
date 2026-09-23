/**
 * 交互式配置 Worker 密钥
 *
 *   npm run secrets
 *
 * 会依次询问：后台密码 → 人机检测密钥 → Twilio 密钥 →（可选）Plivo 密钥
 * 直接回车 = 跳过该项。密码类输入不会回显。
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const rl = createInterface({ input: process.stdin, output: process.stdout });

/* ───────────── 输入辅助 ───────────── */

/** 隐藏输入的读取（需要 TTY；非 TTY 时退回普通读取） */
function askHidden(question) {
  if (!process.stdin.isTTY) return rl.question(question);
  return new Promise((resolvePromise) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          process.stdout.write('\n');
          return resolvePromise(value);
        }
        if (ch === '\u0003') { cleanup(); process.stdout.write('\n'); process.exit(130); }
        if (ch === '\u007f' || ch === '\b') { value = value.slice(0, -1); continue; }
        if (ch >= ' ') value += ch;
      }
    };
    function cleanup() {
      stdin.removeListener('data', onData);
      stdin.setRawMode(Boolean(wasRaw));
      stdin.pause();
    }
    stdin.on('data', onData);
  });
}

async function ask(question) {
  const answer = await rl.question(question);
  return String(answer || '').trim();
}

/* ───────────── 写入 secret ───────────── */

function putSecret(name, value) {
  const res = spawnSync('npx', ['wrangler', 'secret', 'put', name], {
    cwd: ROOT,
    input: value + '\n',
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 60_000,
  });
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  const success = res.status === 0 && !/error/i.test(out);
  if (success) console.log(`  \x1b[32m✓\x1b[0m ${name} 已设置`);
  else {
    console.log(`  \x1b[31m✗\x1b[0m ${name} 设置失败，请手动执行： npx wrangler secret put ${name}`);
    if (out.trim()) console.log('    ' + out.trim().split('\n').slice(-3).join('\n    '));
  }
  return success;
}

/* ───────────── 主流程 ───────────── */

async function main() {
  console.log('\n配置 Worker 密钥（直接回车跳过某项，已有值会被覆盖）');
  console.log('─'.repeat(56));

  // 1) 后台密码
  console.log('\n【后台登录】');
  let pwd = await askHidden('  设置后台密码（输入不回显）: ');
  if (pwd) {
    putSecret('ADMIN_PASSWORD_HASH', createHash('sha256').update(pwd).digest('hex'));
    console.log('    （只写入哈希值，Worker 里拿不到明文密码）');
  } else {
    console.log('  跳过');
  }

  const sessionSecret = randomBytes(32).toString('hex');
  console.log('\n【会话签名】');
  console.log('  已自动生成随机密钥');
  putSecret('SESSION_SECRET', sessionSecret);

  // 2) Turnstile
  console.log('\n【人机检测】Cloudflare Turnstile 的 Secret Key');
  console.log('  没有可先跳过（跳过时不会启用 Turnstile，上线后建议补上）');
  const tsSecret = await askHidden('  TURNSTILE_SECRET: ');
  if (tsSecret) putSecret('TURNSTILE_SECRET', tsSecret);
  else console.log('  跳过');

  // 3) Twilio
  console.log('\n【Twilio Verify】控制台 → Account Info / Verify → Services');
  const twSid = await ask('  TWILIO_ACCOUNT_SID（AC 开头）: ');
  const twToken = twSid ? await askHidden('  TWILIO_AUTH_TOKEN: ') : '';
  const twService = twSid ? await ask('  TWILIO_VERIFY_SERVICE_SID（VA 开头）: ') : '';
  if (twSid && twToken && twService) {
    putSecret('TWILIO_ACCOUNT_SID', twSid);
    putSecret('TWILIO_AUTH_TOKEN', twToken);
    putSecret('TWILIO_VERIFY_SERVICE_SID', twService);
  } else {
    console.log('  跳过（三项需要一起提供）');
  }

  // 4) Plivo（可选）
  console.log('\n【Plivo Verify】可选，需要已开通（联系销售、有最低月消费）');
  const wantPlivo = (await ask('  是否现在配置 Plivo？(y/N): ')).toLowerCase();
  if (wantPlivo === 'y' || wantPlivo === 'yes') {
    const pId = await ask('  PLIVO_AUTH_ID: ');
    const pToken = pId ? await askHidden('  PLIVO_AUTH_TOKEN: ') : '';
    const pApp = pId ? await ask('  PLIVO_APP_UUID: ') : '';
    if (pId && pToken && pApp) {
      putSecret('PLIVO_AUTH_ID', pId);
      putSecret('PLIVO_AUTH_TOKEN', pToken);
      putSecret('PLIVO_APP_UUID', pApp);
    } else {
      console.log('  跳过（三项需要一起提供）');
    }
  } else {
    console.log('  跳过');
  }

  console.log('\n' + '─'.repeat(56));
  console.log('密钥配置完成。下一步：');
  console.log('    npm run deploy\n');
  rl.close();
}

main().catch((err) => {
  console.error('\n出错了：', err?.message || err);
  rl.close();
  process.exit(1);
});
