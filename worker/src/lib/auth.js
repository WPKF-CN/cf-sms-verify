/**
 * 后台登录与会话
 *
 * 两种模式：
 *   1. 数据库管理员（推荐）：首次访问 /admin 时创建账号，密码 PBKDF2 存 D1
 *   2. 环境变量密码（兼容）：部署时设置了 ADMIN_PASSWORD_HASH 则沿用
 *
 * 会话为 HMAC 签名 Cookie，12 小时过期。
 * 签名密钥优先用环境变量 SESSION_SECRET，否则自动生成并存库（用户无需配置）。
 */
import { timingSafeEqual, hashPassword, verifyPasswordHash, randomHex } from './crypto.js';
import { hmacHex } from './utils.js';
import { getSecret, setSecret } from './secrets.js';

const COOKIE = 'sv_admin';
const TTL_SEC = 12 * 3600;
const SESSION_KEY = '__session_secret';

/* ───────────── 会话密钥 ───────────── */

let sessionSecretCache = null;

async function getSessionSecret(env) {
  if (env.SESSION_SECRET) return String(env.SESSION_SECRET);
  if (sessionSecretCache) return sessionSecretCache;
  let stored = await getSecret(env, SESSION_KEY);
  if (!stored) {
    stored = randomHex(32);
    await setSecret(env, SESSION_KEY, stored);
  }
  sessionSecretCache = stored;
  return stored;
}

/* ───────────── 管理员账号 ───────────── */

/** 是否已有管理员账号（数据库或环境变量任一） */
export async function hasAdmin(env) {
  if (env.ADMIN_PASSWORD_HASH) return true;
  try {
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM admins').first();
    return Number(row?.n || 0) > 0;
  } catch {
    return false;
  }
}

/** 创建管理员账号（仅在还没有任何管理员时允许） */
export async function createAdmin(env, username, password) {
  const name = String(username || '').trim() || 'admin';
  if (!/^[a-zA-Z0-9._@-]{3,64}$/.test(name)) {
    return { ok: false, error: 'USERNAME_INVALID' };
  }
  if (String(password || '').length < 8) {
    return { ok: false, error: 'PASSWORD_TOO_SHORT' };
  }
  if (await hasAdmin(env)) {
    return { ok: false, error: 'ADMIN_ALREADY_EXISTS' };
  }
  const { hash, salt } = await hashPassword(password);
  await env.DB.prepare(
    'INSERT INTO admins (username, password_hash, password_salt) VALUES (?, ?, ?)',
  )
    .bind(name, hash, salt)
    .run();
  return { ok: true, username: name };
}

/** 修改密码（需已登录） */
export async function changeAdminPassword(env, username, newPassword) {
  if (String(newPassword || '').length < 8) return { ok: false, error: 'PASSWORD_TOO_SHORT' };
  const { hash, salt } = await hashPassword(newPassword);
  const res = await env.DB.prepare(
    'UPDATE admins SET password_hash = ?, password_salt = ? WHERE username = ?',
  )
    .bind(hash, salt, username)
    .run();
  return { ok: (res.meta?.changes || 0) > 0 };
}

/** 列出管理员（不含密码） */
export async function listAdmins(env) {
  try {
    const { results } = await env.DB.prepare(
      'SELECT id, username, created_at, last_login_at FROM admins ORDER BY id',
    ).all();
    return results || [];
  } catch {
    return [];
  }
}

function parseCookies(request) {
  const header = request.headers.get('cookie') || '';
  const out = {};
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  });
  return out;
}

/**
 * 校验登录。支持两种方式：
 *   1. 数据库账号（用户名 + 密码）
 *   2. 环境变量密码（只传密码，用户名忽略；兼容命令行部署）
 * @returns {{ ok: true, username } | { ok: false, error }}
 */
export async function verifyLogin(env, username, password) {
  const pwd = String(password || '');

  // 方式 1：数据库账号
  const name = String(username || '').trim();
  if (name) {
    try {
      const row = await env.DB.prepare(
        'SELECT username, password_hash, password_salt FROM admins WHERE username = ?',
      )
        .bind(name)
        .first();
      if (row && (await verifyPasswordHash(pwd, row.password_salt, row.password_hash))) {
        await env.DB.prepare(
          `UPDATE admins SET last_login_at = datetime('now') WHERE username = ?`,
        )
          .bind(row.username)
          .run();
        return { ok: true, username: row.username };
      }
    } catch {
      /* 表不存在时继续尝试环境变量方式 */
    }
  }

  // 方式 2：环境变量（ADMIN_PASSWORD_HASH 为 sha256）
  const expected = String(env.ADMIN_PASSWORD_HASH || '').toLowerCase().trim();
  if (expected) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pwd));
    const actual = [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    if (timingSafeEqual(actual, expected)) return { ok: true, username: 'env-admin' };
  }

  return { ok: false, error: 'BAD_CREDENTIALS' };
}

/** 生成会话 Cookie 值：<exp>.<hmac> */
export async function createSession(env, username = 'admin') {
  const secret = await getSessionSecret(env);
  const exp = Math.floor(Date.now() / 1000) + TTL_SEC;
  const sig = await hmacHex(secret, `admin:${username}:${exp}`);
  return `${exp}.${encodeURIComponent(username)}.${sig}`;
}

export function sessionCookie(value, { secure = true } = {}) {
  const attrs = [
    `${COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${TTL_SEC}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

/** 校验请求是否已登录 */
export async function isAuthed(env, request) {
  const raw = parseCookies(request)[COOKIE];
  if (!raw) return false;
  const parts = raw.split('.');
  if (parts.length !== 3) return false;
  const [expStr, username, sig] = parts;
  const exp = Number(expStr);
  if (!exp || !sig || exp < Math.floor(Date.now() / 1000)) return false;
  const secret = await getSessionSecret(env);
  const expected = await hmacHex(secret, `admin:${username}:${exp}`);
  return timingSafeEqual(sig, expected);
}

/** 从会话中取出用户名 */
export function sessionUser(request) {
  const raw = parseCookies(request)[COOKIE];
  if (!raw) return null;
  const parts = raw.split('.');
  if (parts.length !== 3) return null;
  try {
    return decodeURIComponent(parts[1]);
  } catch {
    return parts[1];
  }
}
