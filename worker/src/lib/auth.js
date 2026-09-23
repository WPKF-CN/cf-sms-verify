/**
 * 后台登录与会话
 *
 * 密码以 SHA-256 哈希存在 Worker secret（ADMIN_PASSWORD_HASH），
 * 会话为 HMAC 签名 Cookie，12 小时过期，无需额外存储。
 */
import { hmacHex, sha256Hex, timingSafeEqual } from './utils.js';

const COOKIE = 'sv_admin';
const TTL_SEC = 12 * 3600;

function parseCookies(request) {
  const header = request.headers.get('cookie') || '';
  const out = {};
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  });
  return out;
}

/** 校验密码 */
export async function verifyPassword(env, password) {
  const expected = String(env.ADMIN_PASSWORD_HASH || '').toLowerCase().trim();
  if (!expected) return false;
  const actual = await sha256Hex(String(password || ''));
  return timingSafeEqual(actual, expected);
}

/** 生成会话 Cookie 值：<exp>.<hmac> */
export async function createSession(env) {
  const exp = Math.floor(Date.now() / 1000) + TTL_SEC;
  const sig = await hmacHex(env.SESSION_SECRET || 'insecure-dev-secret', `admin:${exp}`);
  return `${exp}.${sig}`;
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
  const [expStr, sig] = raw.split('.');
  const exp = Number(expStr);
  if (!exp || !sig || exp < Math.floor(Date.now() / 1000)) return false;
  const expected = await hmacHex(env.SESSION_SECRET || 'insecure-dev-secret', `admin:${exp}`);
  return timingSafeEqual(sig, expected);
}
