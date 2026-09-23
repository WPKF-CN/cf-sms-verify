/**
 * 短信通道适配层
 *
 * 统一接口：
 *   send({ to, locale, brand })  -> { ok, provider, ref, status, raw, error }
 *   check({ ref, code, to })     -> { ok, status, raw, error }
 *
 * 已接入：Twilio Verify、Plivo Verify、（本地调试用）mock
 * 新增供应商只需实现同样两个方法，并在 PROVIDERS 里注册。
 */

/* ───────────── Twilio Verify ───────────── */

const TWILIO_PROVIDER = {
  name: 'twilio',
  configured: (env) =>
    Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_VERIFY_SERVICE_SID),

  async send(env, { to, locale }) {
    const sid = env.TWILIO_VERIFY_SERVICE_SID;
    const body = new URLSearchParams({ To: to, Channel: 'sms' });
    if (locale) body.set('Locale', locale);

    const res = await fetch(`https://verify.twilio.com/v2/Services/${sid}/Verifications`, {
      method: 'POST',
      headers: {
        authorization:
          'Basic ' + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        provider: 'twilio',
        error: data.message || `twilio_http_${res.status}`,
        raw: data,
      };
    }
    return {
      ok: true,
      provider: 'twilio',
      ref: data.sid,
      status: data.status || 'pending',
      raw: data,
    };
  },

  async check(env, { ref, code, to }) {
    const sid = env.TWILIO_VERIFY_SERVICE_SID;
    const res = await fetch(`https://verify.twilio.com/v2/Services/${sid}/VerificationCheck`, {
      method: 'POST',
      headers: {
        authorization:
          'Basic ' + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, Code: code }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // 404 = 会话已过期/已通过/尝试次数超限
      return {
        ok: false,
        provider: 'twilio',
        status: res.status === 404 ? 'expired' : 'failed',
        error: data.message || `twilio_http_${res.status}`,
        raw: data,
      };
    }
    return {
      ok: data.status === 'approved',
      provider: 'twilio',
      status: data.status,
      raw: data,
    };
  },
};

/* ───────────── Plivo Verify ───────────── */

const PLIVO_PROVIDER = {
  name: 'plivo',
  configured: (env) => Boolean(env.PLIVO_AUTH_ID && env.PLIVO_AUTH_TOKEN && env.PLIVO_APP_UUID),

  async send(env, { to, locale }) {
    const res = await fetch(
      `https://api.plivo.com/v1/Account/${env.PLIVO_AUTH_ID}/Verify/Session/`,
      {
        method: 'POST',
        headers: {
          authorization: 'Basic ' + btoa(`${env.PLIVO_AUTH_ID}:${env.PLIVO_AUTH_TOKEN}`),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          recipient: to,
          app_uuid: env.PLIVO_APP_UUID,
          channel: 'sms',
          ...(locale ? { locale } : {}),
        }),
      },
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.session_uuid) {
      return {
        ok: false,
        provider: 'plivo',
        error: data.error || data.message || `plivo_http_${res.status}`,
        raw: data,
      };
    }
    return {
      ok: true,
      provider: 'plivo',
      ref: data.session_uuid,
      status: 'pending',
      raw: data,
    };
  },

  async check(env, { ref, code }) {
    const res = await fetch(
      `https://api.plivo.com/v1/Account/${env.PLIVO_AUTH_ID}/Verify/Session/${ref}/`,
      {
        method: 'POST',
        headers: {
          authorization: 'Basic ' + btoa(`${env.PLIVO_AUTH_ID}:${env.PLIVO_AUTH_TOKEN}`),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ otp: code }),
      },
    );
    const data = await res.json().catch(() => ({}));
    const message = String(data.message || '');
    const ok = res.ok && /validated successfully/i.test(message);
    return {
      ok,
      provider: 'plivo',
      status: ok ? 'approved' : 'failed',
      error: ok ? undefined : data.error || message || `plivo_http_${res.status}`,
      raw: data,
    };
  },
};

/* ───────────── Mock（本地调试，不真发短信）───────────── */

export const MOCK_CODE = '123456';

const MOCK_PROVIDER = {
  name: 'mock',
  configured: () => true,
  async send(env, { to }) {
    console.log(`[MOCK] send code ${MOCK_CODE} to ${to}`);
    return {
      ok: true,
      provider: 'mock',
      ref: `mock_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
      status: 'sent',
      raw: { mock: true, code: MOCK_CODE },
    };
  },
  async check(env, { code }) {
    const ok = String(code).trim() === MOCK_CODE;
    return { ok, provider: 'mock', status: ok ? 'approved' : 'failed' };
  },
};

/* ───────────── 注册表与调度 ───────────── */

const PROVIDERS = {
  twilio: TWILIO_PROVIDER,
  plivo: PLIVO_PROVIDER,
  mock: MOCK_PROVIDER,
};

export function getProvider(name) {
  return PROVIDERS[name] || null;
}

/** 列出各通道配置状态（后台用） */
export function providerStatus(env) {
  return Object.values(PROVIDERS).map((p) => ({
    name: p.name,
    configured: p.configured(env),
  }));
}

/**
 * 按配置选择通道。auto 模式下依次尝试，前一个失败自动切下一个。
 * @returns {{ok: true, provider, ref, status, raw, tried} | {ok: false, error, tried}}
 */
export async function sendCode(env, cfg, { to, locale, brand }) {
  const mockMode = String(env.MOCK_MODE || '0') === '1';
  const order = mockMode
    ? ['mock']
    : cfg.provider === 'auto'
      ? cfg.providerPriority || ['twilio', 'plivo']
      : [cfg.provider];

  const tried = [];
  for (const name of order) {
    const provider = getProvider(name);
    if (!provider) continue;
    if (!mockMode && name === 'mock') continue; // 生产环境不允许走 mock
    if (!provider.configured(env)) {
      tried.push({ provider: name, error: 'not_configured' });
      continue;
    }
    try {
      const result = await provider.send(env, { to, locale, brand });
      if (result.ok) return { ...result, tried };
      tried.push({ provider: name, error: result.error });
    } catch (err) {
      tried.push({ provider: name, error: String(err?.message || err) });
    }
  }
  return { ok: false, error: 'all_providers_failed', tried };
}

/** 用发送时记录的 provider 去校验验证码 */
export async function checkCode(env, { provider, ref, code, to }) {
  const impl = getProvider(provider);
  if (!impl) return { ok: false, status: 'failed', error: 'provider_unknown' };
  try {
    return await impl.check(env, { ref, code, to });
  } catch (err) {
    return { ok: false, status: 'failed', error: String(err?.message || err) };
  }
}
