/**
 * 凭证存储：短信商密钥、Turnstile Secret 等存在 D1 里，由后台管理
 *
 * 设计说明：
 *   · 值用 AES-GCM 加密后存储，密钥（master key）首次使用时随机生成并存在同一张表
 *   · 这样做的意义：后台界面、日志、CSV 导出、SQL 查询都不会直接看到明文
 *   · 局限：master key 与密文同库，若有人拿到完整数据库导出仍可解密。
 *     真正的防线是保护好 Cloudflare 账号本身（开二次验证、最小权限 API Token）
 *
 * 环境变量优先级高于数据库：如果部署时填了 TWILIO_AUTH_TOKEN 等，
 * 会优先使用环境变量（方便老用户和命令行部署），数据库值作为后备。
 */
import { randomHex, timingSafeEqual } from './crypto.js';

const MASTER_KEY_NAME = '__master_key';

/* ───────────── 加解密 ───────────── */

async function importKey(rawHex) {
  const raw = new Uint8Array(rawHex.length / 2);
  for (let i = 0; i < raw.length; i += 1) raw[i] = parseInt(rawHex.substr(i * 2, 2), 16);
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function b64encode(bytes) {
  let s = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i += 1) s += String.fromCharCode(arr[i]);
  return btoa(s);
}

function b64decode(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

async function encrypt(keyHex, plaintext) {
  const key = await importKey(keyHex);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(String(plaintext));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  return { value: b64encode(cipher), iv: b64encode(iv) };
}

async function decrypt(keyHex, valueB64, ivB64) {
  const key = await importKey(keyHex);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64decode(ivB64) },
    key,
    b64decode(valueB64),
  );
  return new TextDecoder().decode(plain);
}

/* ───────────── master key ───────────── */

let masterKeyCache = null;

async function getMasterKey(env) {
  if (masterKeyCache) return masterKeyCache;

  const row = await env.DB.prepare('SELECT value FROM secrets WHERE key = ?')
    .bind(MASTER_KEY_NAME)
    .first();
  if (row?.value) {
    masterKeyCache = row.value;
    return masterKeyCache;
  }

  // 首次使用：生成并落库
  const key = randomHex(32);
  await env.DB.prepare(
    'INSERT INTO secrets (key, value, iv) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING',
  )
    .bind(MASTER_KEY_NAME, key, '')
    .run();

  // 并发情况下可能有别的请求先写入，读回为准
  const again = await env.DB.prepare('SELECT value FROM secrets WHERE key = ?')
    .bind(MASTER_KEY_NAME)
    .first();
  masterKeyCache = again?.value || key;
  return masterKeyCache;
}

/* ───────────── 对外接口 ───────────── */

/** 写入一个凭证 */
export async function setSecret(env, key, plaintext) {
  const master = await getMasterKey(env);
  const value = String(plaintext ?? '');
  if (!value) {
    await env.DB.prepare('DELETE FROM secrets WHERE key = ?').bind(key).run();
    return;
  }
  const enc = await encrypt(master, value);
  await env.DB.prepare(
    `INSERT INTO secrets (key, value, iv, updated_at) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, iv = excluded.iv,
                                    updated_at = datetime('now')`,
  )
    .bind(key, enc.value, enc.iv)
    .run();
}

/** 读取一个凭证（不存在返回 null） */
export async function getSecret(env, key) {
  const row = await env.DB.prepare('SELECT value, iv FROM secrets WHERE key = ?')
    .bind(key)
    .first();
  if (!row?.value) return null;
  // master key 自身是明文存的
  if (key === MASTER_KEY_NAME) return row.value;
  try {
    const master = await getMasterKey(env);
    return await decrypt(master, row.value, row.iv);
  } catch {
    return null; // 解密失败（如 master key 被替换）当作未配置
  }
}

/**
 * 读取全部凭证，返回 { KEY: value }
 *
 * 优先级：数据库 > 环境变量
 *   后台填写的值应当生效（那是用户最近一次的意图）；
 *   环境变量作为后备，兼容用 wrangler secret 配置的老部署。
 */
export async function loadSecrets(env, keys) {
  const out = {};
  let rows = [];
  try {
    const res = await env.DB.prepare(
      `SELECT key, value, iv FROM secrets WHERE key != ?`,
    )
      .bind(MASTER_KEY_NAME)
      .all();
    rows = res.results || [];
  } catch {
    rows = []; // 迁移未执行时不报错
  }

  const master = rows.length ? await getMasterKey(env) : null;
  for (const row of rows) {
    try {
      out[row.key] = await decrypt(master, row.value, row.iv);
    } catch {
      out[row.key] = '';
    }
  }

  // 环境变量只作为后备：数据库里没有的键才用环境变量
  for (const k of keys) {
    if (out[k]) continue; // 数据库已有值，跳过
    const fromEnv = env[k];
    if (fromEnv !== undefined && fromEnv !== null && String(fromEnv) !== '') {
      out[k] = String(fromEnv);
    }
  }
  // 补齐未设置的键
  for (const k of keys) if (!(k in out)) out[k] = '';
  return out;
}

/** 各凭证是否已配置（后台展示用，不返回明文） */
export async function secretsStatus(env, keys) {
  const values = await loadSecrets(env, keys);
  const out = {};
  for (const k of keys) out[k] = Boolean(values[k]);
  return out;
}

/** 删除全部凭证（调试/重置用） */
export async function clearSecrets(env) {
  await env.DB.prepare('DELETE FROM secrets WHERE key != ?').bind(MASTER_KEY_NAME).run();
}

export { MASTER_KEY_NAME };
