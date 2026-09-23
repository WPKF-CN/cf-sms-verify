/**
 * Cloudflare Turnstile 人机检测（服务端校验）
 * 文档：https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
 */

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export async function verifyTurnstile(env, { token, ip }) {
  // 本地调试模式跳过，方便在 MOCK_MODE 下自测
  if (String(env.MOCK_MODE || '0') === '1' && String(token || '').startsWith('mock-')) {
    return { ok: true, skipped: true };
  }
  if (!env.TURNSTILE_SECRET) {
    return { ok: false, error: 'turnstile_secret_missing' };
  }
  if (!token) {
    return { ok: false, error: 'turnstile_token_missing' };
  }

  const form = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token });
  if (ip && ip !== 'unknown') form.set('remoteip', ip);

  try {
    const res = await fetch(VERIFY_URL, { method: 'POST', body: form });
    const data = await res.json().catch(() => ({}));
    if (data.success) return { ok: true, data };
    return { ok: false, error: (data['error-codes'] || []).join(',') || 'turnstile_failed', data };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}
