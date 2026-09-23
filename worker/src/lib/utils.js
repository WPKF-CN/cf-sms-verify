/**
 * 通用工具：响应、CORS、IP、手机号归一化、加密辅助
 */
import { parsePhoneNumberFromString } from 'libphonenumber-js/min';

/* ───────────── 响应 ───────────── */

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders,
    },
  });
}

/** 带 CORS 的 JSON 响应；origin 由调用方按白名单校验后传入 */
export function corsJson(data, status, origin, extraHeaders = {}) {
  const headers = {
    'access-control-allow-origin': origin || '*',
    'access-control-allow-methods': 'POST, GET, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    vary: 'origin',
    ...extraHeaders,
  };
  return json(data, status, headers);
}

export function preflight(origin) {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': origin || '*',
      'access-control-allow-methods': 'POST, GET, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '86400',
      vary: 'origin',
    },
  });
}

/* ───────────── 请求信息 ───────────── */

export function clientIp(request) {
  return (
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-real-ip') ||
    (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
    'unknown'
  );
}

export function userAgent(request) {
  return (request.headers.get('user-agent') || '').slice(0, 300);
}

/* ───────────── 手机号 ───────────── */

/**
 * 把用户输入归一化成 E.164。
 * 支持两种输入：带国家码（+4420...）或纯本地号码（4155552671 + country=US）
 * @returns {{ok: true, e164: string, country: string} | {ok: false, error: string}}
 */
export function normalizePhone(input, defaultCountry) {
  const raw = String(input || '').trim();
  if (!raw) return { ok: false, error: 'PHONE_REQUIRED' };

  let parsed = null;
  if (raw.startsWith('+')) {
    parsed = parsePhoneNumberFromString(raw.replace(/[\s\-().]/g, ''));
  } else {
    const digits = raw.replace(/\D/g, '');
    if (!digits) return { ok: false, error: 'PHONE_REQUIRED' };
    if (!defaultCountry) return { ok: false, error: 'COUNTRY_REQUIRED' };
    parsed = parsePhoneNumberFromString(digits, defaultCountry.toUpperCase());
  }

  if (!parsed || !parsed.isValid() || !parsed.country) {
    return { ok: false, error: 'PHONE_INVALID' };
  }
  return { ok: true, e164: parsed.number, country: parsed.country };
}

/* ───────────── 加密辅助 ───────────── */

export function randomHex(bytes = 24) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hmacHex(secret, text) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 常数时间字符串比较，避免时序侧信道 */
export function timingSafeEqual(a, b) {
  const sa = String(a || '');
  const sb = String(b || '');
  if (sa.length !== sb.length) return false;
  let diff = 0;
  for (let i = 0; i < sa.length; i += 1) diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  return diff === 0;
}

/** 手机号脱敏显示：+1415****2671 */
export function maskPhone(e164) {
  const s = String(e164 || '');
  if (s.length < 8) return s;
  return `${s.slice(0, 5)}****${s.slice(-4)}`;
}

export function nowIso() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

export function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** 简单校验：只允许安全字符的 site 标识 */
export function sanitizeSite(site) {
  const s = String(site || 'default').trim().slice(0, 64);
  return /^[a-zA-Z0-9._\-]+$/.test(s) ? s : 'default';
}
