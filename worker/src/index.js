/**
 * sms-verify Worker
 *
 * 公开接口（落地页调用）：
 *   GET  /w.js             弹窗组件脚本
 *   GET  /api/config       前端配置（国家列表 / Turnstile sitekey / 文案）
 *   POST /api/send         发送验证码（含人机检测 + 频控 + 国家白名单）
 *   POST /api/check        校验验证码，通过后签发凭证
 *   POST /api/grant        校验免验证凭证
 *   POST /api/redirect     记录跳转事件（漏斗统计用）
 *
 * 后台（密码登录）：
 *   GET  /admin                     后台页面
 *   POST /admin/api/login|logout    登录 / 退出
 *   GET  /admin/api/stats           统计
 *   GET  /admin/api/records         记录列表（支持筛选 + 分页）
 *   GET  /admin/api/records.csv     导出 CSV
 *   GET/PUT /admin/api/config       读取 / 保存配置
 *   GET  /admin/api/providers       通道配置状态
 *   POST /admin/api/test-send       测试发送
 */
import widgetJs from './client/widget.txt';
import adminHtml from './admin/admin.html';
import demoHtml from './client/demo.html';

import {
  loadConfig,
  saveConfig,
  publicConfig,
  buildCountryList,
  COUNTRY_META,
  DEFAULT_CONFIG,
} from './lib/config.js';
import {
  corsJson,
  preflight,
  json,
  clientIp,
  userAgent,
  normalizePhone,
  randomHex,
  sanitizeSite,
  maskPhone,
} from './lib/utils.js';
import { verifyTurnstile } from './lib/turnstile.js';
import { sendCode, checkCode, providerStatus } from './lib/providers.js';
import {
  checkSendLimit,
  recordSendAttempt,
  createVerification,
  getVerification,
  incrementAttempts,
  markVerified,
  markStatus,
  markRedirect,
  findGrant,
  listVerifications,
  getStats,
  checkLoginLimit,
  cleanup,
} from './lib/db.js';
import { verifyPassword, createSession, sessionCookie, clearCookie, isAuthed } from './lib/auth.js';

const CORS_HEADERS = 'POST, GET, OPTIONS';

/* ───────────── 通用辅助 ───────────── */

function originAllowed(cfg, origin) {
  const list = Array.isArray(cfg.allowedOrigins) ? cfg.allowedOrigins : ['*'];
  if (list.includes('*')) return true;
  if (!origin) return false;
  return list.includes(origin);
}

function allowedOriginHeader(cfg, origin) {
  const list = Array.isArray(cfg.allowedOrigins) ? cfg.allowedOrigins : ['*'];
  if (list.includes('*')) return '*';
  return origin && list.includes(origin) ? origin : 'null';
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

/** 给前端选择的 WhatsApp 目标链接 */
function pickLink(cfg) {
  const links = (cfg.whatsappLinks || []).filter(Boolean);
  if (!links.length) return null;
  return links[Math.floor(Math.random() * links.length)];
}

/* ───────────── 公开接口 ───────────── */

async function handleConfig(env, request, origin) {
  const cfg = await loadConfig(env);
  if (!originAllowed(cfg, origin)) {
    return corsJson({ ok: false, error: 'ORIGIN_NOT_ALLOWED' }, 403, allowedOriginHeader(cfg, origin));
  }
  return corsJson({ ok: true, config: publicConfig(cfg) }, 200, allowedOriginHeader(cfg, origin));
}

async function handleSend(env, request, origin, ip) {
  const cfg = await loadConfig(env);
  const corsOrigin = allowedOriginHeader(cfg, origin);

  if (!originAllowed(cfg, origin)) {
    return corsJson({ ok: false, error: 'ORIGIN_NOT_ALLOWED' }, 403, corsOrigin);
  }

  const body = await readJson(request);
  const countries = buildCountryList(cfg.allowedCountries);
  if (!countries.length) {
    return corsJson({ ok: false, error: 'NO_COUNTRY_CONFIGURED' }, 503, corsOrigin);
  }

  // 1) 人机检测（在发短信前，避免被刷）
  if (cfg.turnstileEnabled && cfg.turnstileSiteKey) {
    const ts = await verifyTurnstile(env, { token: body.turnstileToken, ip });
    if (!ts.ok) {
      return corsJson({ ok: false, error: 'TURNSTILE_FAILED', detail: ts.error }, 403, corsOrigin);
    }
  }

  // 2) 手机号归一化 + 国家白名单
  const national = body.national || body.phone || '';
  const defaultCountry = body.country || countries[0].iso2;
  const parsed = normalizePhone(national, defaultCountry);
  if (!parsed.ok) {
    return corsJson({ ok: false, error: parsed.error }, 400, corsOrigin);
  }
  const allowedIsos = countries.map((c) => c.iso2);
  if (!allowedIsos.includes(parsed.country)) {
    return corsJson(
      { ok: false, error: 'COUNTRY_NOT_ALLOWED', country: parsed.country, allowed: allowedIsos },
      400,
      corsOrigin,
    );
  }

  // 3) 频控
  const limit = await checkSendLimit(env, cfg, { phone: parsed.e164, ip });
  if (!limit.allowed) {
    return corsJson(
      { ok: false, error: limit.reason, retryAfter: limit.retryAfter },
      429,
      corsOrigin,
    );
  }
  await recordSendAttempt(env, { phone: parsed.e164, ip });

  // 4) 调用短信通道（auto 模式自动容灾）
  const locale = body.locale || 'en';
  const result = await sendCode(env, cfg, { to: parsed.e164, locale });
  const site = sanitizeSite(body.site);
  const id = await createVerification(env, {
    site,
    phone: parsed.e164,
    country: parsed.country,
    provider: result.provider || (cfg.provider === 'auto' ? 'none' : cfg.provider),
    providerRef: result.ref || null,
    sendStatus: result.ok ? 'sent' : 'failed',
    sendError: result.ok ? null : JSON.stringify(result.tried || result.error || null),
    ip,
    ua: userAgent(request),
    origin: origin || null,
  });

  if (!result.ok) {
    return corsJson(
      { ok: false, error: 'SEND_FAILED', id, detail: result.tried || result.error },
      502,
      corsOrigin,
    );
  }

  return corsJson(
    {
      ok: true,
      id,
      phone: maskPhone(parsed.e164),
      provider: result.provider,
      resendAfter: cfg.resendIntervalSec,
    },
    200,
    corsOrigin,
  );
}

async function handleCheck(env, request, origin) {
  const cfg = await loadConfig(env);
  const corsOrigin = allowedOriginHeader(cfg, origin);
  if (!originAllowed(cfg, origin)) {
    return corsJson({ ok: false, error: 'ORIGIN_NOT_ALLOWED' }, 403, corsOrigin);
  }

  const body = await readJson(request);
  const id = Number(body.id);
  const code = String(body.code || '').replace(/\D/g, '');
  if (!id || !code) {
    return corsJson({ ok: false, error: 'BAD_REQUEST' }, 400, corsOrigin);
  }

  const row = await getVerification(env, id);
  if (!row) return corsJson({ ok: false, error: 'NOT_FOUND' }, 404, corsOrigin);

  // 幂等：已通过的直接回凭证
  if (row.status === 'verified') {
    return corsJson(
      {
        ok: true,
        token: row.grant_token,
        expiresAt: row.grant_expires_at,
        redirectUrl: cfg.linkMode === 'server' ? pickLink(cfg) : null,
      },
      200,
      corsOrigin,
    );
  }

  const maxAttempts = Number(cfg.codeMaxAttempts) || 5;
  if (row.attempts >= maxAttempts) {
    await markStatus(env, id, 'expired');
    return corsJson({ ok: false, error: 'TOO_MANY_ATTEMPTS' }, 429, corsOrigin);
  }

  await incrementAttempts(env, id);
  const verified = await checkCode(env, {
    provider: row.provider,
    ref: row.provider_ref,
    code,
    to: row.phone,
  });

  if (!verified.ok) {
    const remaining = maxAttempts - (row.attempts + 1);
    if (remaining <= 0) await markStatus(env, id, 'failed');
    return corsJson(
      {
        ok: false,
        error: verified.status === 'expired' ? 'CODE_EXPIRED' : 'CODE_INCORRECT',
        remaining: Math.max(remaining, 0),
      },
      400,
      corsOrigin,
    );
  }

  // 签发免验证凭证
  let token = null;
  let expiresAt = null;
  if (Number(cfg.grantTtlHours) > 0) {
    token = randomHex(24);
    expiresAt = new Date(Date.now() + Number(cfg.grantTtlHours) * 3600_000)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19);
  }
  await markVerified(env, id, { grantToken: token, grantExpiresAt: expiresAt });

  return corsJson(
    {
      ok: true,
      token,
      expiresAt,
      redirectUrl: cfg.linkMode === 'server' ? pickLink(cfg) : null,
    },
    200,
    corsOrigin,
  );
}

async function handleGrant(env, request, origin) {
  const cfg = await loadConfig(env);
  const corsOrigin = allowedOriginHeader(cfg, origin);
  if (!originAllowed(cfg, origin)) {
    return corsJson({ ok: false, error: 'ORIGIN_NOT_ALLOWED' }, 403, corsOrigin);
  }
  const body = await readJson(request);
  const row = await findGrant(env, body.token);
  if (!row) return corsJson({ ok: false, valid: false }, 200, corsOrigin);
  return corsJson(
    {
      ok: true,
      valid: true,
      phone: maskPhone(row.phone),
      expiresAt: row.grant_expires_at,
      redirectUrl: cfg.linkMode === 'server' ? pickLink(cfg) : null,
    },
    200,
    corsOrigin,
  );
}

async function handleRedirect(env, request, origin) {
  const cfg = await loadConfig(env);
  const corsOrigin = allowedOriginHeader(cfg, origin);
  const body = await readJson(request);
  const id = Number(body.id);
  if (id) await markRedirect(env, id);
  return corsJson({ ok: true }, 200, corsOrigin);
}

/* ───────────── 后台接口 ───────────── */

function adminUnauthorized() {
  return json({ ok: false, error: 'UNAUTHORIZED' }, 401);
}

async function handleAdminApi(env, request, path, ip) {
  /* 登录 / 退出 / 会话状态：不需要已登录 */
  if (path === '/admin/api/login') {
    const limit = await checkLoginLimit(env, ip);
    if (!limit.allowed) return json({ ok: false, error: 'TOO_MANY_ATTEMPTS' }, 429);
    const body = await readJson(request);
    const ok = await verifyPassword(env, body.password);
    if (!ok) return json({ ok: false, error: 'BAD_CREDENTIALS' }, 401);
    const value = await createSession(env);
    return json({ ok: true }, 200, {
      'set-cookie': sessionCookie(value, { secure: true }),
    });
  }
  if (path === '/admin/api/logout') {
    return json({ ok: true }, 200, { 'set-cookie': clearCookie() });
  }
  if (path === '/admin/api/session') {
    const authed = await isAuthed(env, request);
    return json({ ok: true, authed });
  }

  /* 以下接口都需要登录 */
  if (!(await isAuthed(env, request))) return adminUnauthorized();

  if (path === '/admin/api/stats') {
    return json({ ok: true, ...(await getStats(env)) });
  }

  if (path === '/admin/api/records') {
    const url = new URL(request.url);
    const q = Object.fromEntries(url.searchParams.entries());
    const data = await listVerifications(env, q);
    return json({ ok: true, ...data });
  }

  if (path === '/admin/api/records.csv') {
    const url = new URL(request.url);
    const q = Object.fromEntries(url.searchParams.entries());
    const { rows } = await listVerifications(env, { ...q, pageSize: 200 });
    const cols = [
      'id', 'created_at', 'site', 'phone', 'country', 'provider',
      'send_status', 'status', 'attempts', 'verified_at', 'redirect_at', 'ip', 'origin',
    ];
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
    return new Response(csv, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="verifications-${Date.now()}.csv"`,
      },
    });
  }

  if (path === '/admin/api/config' && request.method === 'GET') {
    const cfg = await loadConfig(env, { force: true });
    return json({ ok: true, config: cfg });
  }

  if (path === '/admin/api/config' && (request.method === 'PUT' || request.method === 'POST')) {
    const body = await readJson(request);
    const patch = body.config || body;
    const saved = await saveConfig(env, patch);
    return json({ ok: true, config: saved });
  }

  if (path === '/admin/api/providers') {
    return json({
      ok: true,
      providers: providerStatus(env),
      mockMode: String(env.MOCK_MODE || '0') === '1',
    });
  }

  if (path === '/admin/api/meta') {
    return json({
      ok: true,
      countries: buildCountryList(Object.keys(COUNTRY_META)),
      defaults: DEFAULT_CONFIG,
      secrets: {
        ADMIN_PASSWORD_HASH: Boolean(env.ADMIN_PASSWORD_HASH),
        SESSION_SECRET: Boolean(env.SESSION_SECRET),
        TURNSTILE_SECRET: Boolean(env.TURNSTILE_SECRET),
        TWILIO_ACCOUNT_SID: Boolean(env.TWILIO_ACCOUNT_SID),
        TWILIO_AUTH_TOKEN: Boolean(env.TWILIO_AUTH_TOKEN),
        TWILIO_VERIFY_SERVICE_SID: Boolean(env.TWILIO_VERIFY_SERVICE_SID),
        PLIVO_AUTH_ID: Boolean(env.PLIVO_AUTH_ID),
        PLIVO_AUTH_TOKEN: Boolean(env.PLIVO_AUTH_TOKEN),
        PLIVO_APP_UUID: Boolean(env.PLIVO_APP_UUID),
      },
    });
  }

  if (path === '/admin/api/test-send') {
    const body = await readJson(request);
    const cfg = await loadConfig(env, { force: true });
    const parsed = normalizePhone(body.national || body.phone, body.country || 'US');
    if (!parsed.ok) return json({ ok: false, error: parsed.error }, 400);
    const result = await sendCode(env, cfg, { to: parsed.e164, locale: 'en' });
    await createVerification(env, {
      site: 'admin-test',
      phone: parsed.e164,
      country: parsed.country,
      provider: result.provider || 'none',
      providerRef: result.ref || null,
      sendStatus: result.ok ? 'sent' : 'failed',
      sendError: result.ok ? null : JSON.stringify(result.tried || result.error || null),
      ip: clientIp(request),
      ua: 'admin-console',
      origin: 'admin',
    });
    return json({ ok: result.ok, provider: result.provider, error: result.error, tried: result.tried });
  }

  return json({ ok: false, error: 'NOT_FOUND' }, 404);
}

/* ───────────── 入口 ───────────── */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const origin = request.headers.get('origin');
    const ip = clientIp(request);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': CORS_HEADERS,
          'access-control-allow-headers': 'content-type',
          'access-control-max-age': '86400',
        },
      });
    }

    try {
      /* —— 员工弹窗组件 —— */
      if (path === '/w.js') {
        return new Response(widgetJs, {
          headers: {
            'content-type': 'application/javascript; charset=utf-8',
            'cache-control': 'public, max-age=300',
            'access-control-allow-origin': '*',
          },
        });
      }

      /* —— 公开 API —— */
      if (path === '/api/config') return handleConfig(env, request, origin);
      if (path === '/api/send') return handleSend(env, request, origin, ip);
      if (path === '/api/check') return handleCheck(env, request, origin);
      if (path === '/api/grant') return handleGrant(env, request, origin);
      if (path === '/api/redirect') return handleRedirect(env, request, origin);

      /* —— 后台 —— */
      if (path === '/admin' || path === '/') {
        return new Response(adminHtml, {
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
        });
      }
      if (path === '/demo') {
        return new Response(demoHtml, {
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
        });
      }
      if (path.startsWith('/admin/api/')) {
        return handleAdminApi(env, request, path, ip);
      }

      return json({ ok: false, error: 'NOT_FOUND' }, 404);
    } catch (err) {
      console.error('unhandled', err?.stack || err);
      return json({ ok: false, error: 'INTERNAL_ERROR' }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(cleanup(env));
  },
};
