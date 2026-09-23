/**
 * Cloudflare Turnstile 人机检测（服务端校验）
 * 文档：https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
 *
 * Secret 从数据库凭证读取（后台可改），不再依赖环境变量。
 */

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * @param secrets 凭证集合（含 TURNSTILE_SECRET / MOCK_MODE）
 */
export async function verifyTurnstile(secrets, { token, ip }) {
  // 本地调试模式跳过，方便在 MOCK_MODE 下自测
  if (String(secrets?.MOCK_MODE || '0') === '1' && String(token || '').startsWith('mock-')) {
    return { ok: true, skipped: true };
  }
  if (!secrets?.TURNSTILE_SECRET) {
    return { ok: false, error: 'turnstile_secret_missing' };
  }
  if (!token) {
    return { ok: false, error: 'turnstile_token_missing' };
  }

  const form = new URLSearchParams({ secret: secrets.TURNSTILE_SECRET, response: token });
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
