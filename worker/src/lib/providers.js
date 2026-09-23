/**
 * 短信通道适配层
 *
 * 统一接口：
 *   send({ to, locale, brand })  -> { ok, provider, ref, status, raw, error }
 *   check({ ref, code, to })     -> { ok, status, raw, error }
 *
 * 已接入：Twilio Verify、Plivo Verify、Onbuka、（本地调试用）mock
 * 新增供应商只需实现同样两个方法，并在 PROVIDERS 里注册。
 *
 * 两类通道的区别：
 *   · OTP 类（Twilio / Plivo）：验证码由服务商生成和校验，我们不接触明文
 *   · 网关类（Onbuka）：只有发短信接口，验证码由我们自己生成、
 *     存哈希到 D1、并在 check 时自行比对
 */
import { md5, generateCode, hashCode, timingSafeEqual } from './crypto.js';

/* ───────────── Twilio Verify ───────────── */

const TWILIO_PROVIDER = {
  name: 'twilio',
  kind: 'otp', // 验证码由服务商管理
  configured: (s) =>
    Boolean(s.TWILIO_ACCOUNT_SID && s.TWILIO_AUTH_TOKEN && s.TWILIO_VERIFY_SERVICE_SID),

  async send(s, { to, locale }) {
    const sid = s.TWILIO_VERIFY_SERVICE_SID;
    const body = new URLSearchParams({ To: to, Channel: 'sms' });
    if (locale) body.set('Locale', locale);

    const res = await fetch(`https://verify.twilio.com/v2/Services/${sid}/Verifications`, {
      method: 'POST',
      headers: {
        authorization:
          'Basic ' + btoa(`${s.TWILIO_ACCOUNT_SID}:${s.TWILIO_AUTH_TOKEN}`),
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

  async check(s, { ref, code, to }) {
    const sid = s.TWILIO_VERIFY_SERVICE_SID;
    const res = await fetch(`https://verify.twilio.com/v2/Services/${sid}/VerificationCheck`, {
      method: 'POST',
      headers: {
        authorization:
          'Basic ' + btoa(`${s.TWILIO_ACCOUNT_SID}:${s.TWILIO_AUTH_TOKEN}`),
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
  kind: 'otp',
  configured: (s) => Boolean(s.PLIVO_AUTH_ID && s.PLIVO_AUTH_TOKEN && s.PLIVO_APP_UUID),

  async send(s, { to, locale }) {
    const res = await fetch(
      `https://api.plivo.com/v1/Account/${s.PLIVO_AUTH_ID}/Verify/Session/`,
      {
        method: 'POST',
        headers: {
          authorization: 'Basic ' + btoa(`${s.PLIVO_AUTH_ID}:${s.PLIVO_AUTH_TOKEN}`),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          recipient: to,
          app_uuid: s.PLIVO_APP_UUID,
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

  async check(s, { ref, code }) {
    const res = await fetch(
      `https://api.plivo.com/v1/Account/${s.PLIVO_AUTH_ID}/Verify/Session/${ref}/`,
      {
        method: 'POST',
        headers: {
          authorization: 'Basic ' + btoa(`${s.PLIVO_AUTH_ID}:${s.PLIVO_AUTH_TOKEN}`),
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
  kind: 'local', // 本地自己校验
  configured: () => true,

  /** 固定返回 123456，方便本地自测 */
  async prepare(s, { codeLength = 6 } = {}) {
    const code = MOCK_CODE.slice(0, Number(codeLength) || 6).padEnd(Number(codeLength) || 6, '0');
    const { randomHex, hashCode } = await import('./crypto.js');
    const salt = randomHex(16);
    return { code, codeHash: await hashCode(code, salt), codeSalt: salt };
  },

  async send(s, { to, code }) {
    console.log(`[MOCK] send code ${code} to ${to}`);
    return {
      ok: true,
      provider: 'mock',
      ref: `mock_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
      status: 'sent',
      raw: { mock: true, code },
    };
  },

  /** 与 Onbuka 相同的本地比对逻辑 */
  async check(s, { code, storedHash, storedSalt }) {
    const { hashCode, timingSafeEqual } = await import('./crypto.js');
    if (!storedHash || !storedSalt) {
      return { ok: false, provider: 'mock', status: 'expired', error: 'code_not_found' };
    }
    const hash = await hashCode(String(code).trim(), storedSalt);
    const ok = timingSafeEqual(hash, storedHash);
    return { ok, provider: 'mock', status: ok ? 'approved' : 'failed' };
  },
};

/* ───────────── Onbuka（普通短信网关，自建验证码）───────────── */

/**
 * Onbuka 只有「发短信」接口，没有 OTP 校验接口，
 * 因此验证码由本服务生成、哈希后存 D1，校验时自行比对。
 *
 * 签名规则：Sign = md5(apiKey + apiPwd + timestamp)，timestamp 为秒级时间戳
 * 请求头：Sign / Timestamp / Api-Key
 * 文档：https://www.onbuka.com/zh-cn/sms-api3/
 */
const ONBUKA_PROVIDER = {
  name: 'onbuka',
  kind: 'local', // 验证码由本服务管理
  configured: (s) => Boolean(s.ONBUKA_API_KEY && s.ONBUKA_API_PWD && s.ONBUKA_APP_ID),

  /** 生成验证码，返回 { code, codeHash, codeSalt } 交给调用方入库 */
  async prepare(s, { codeLength = 6 } = {}) {
    const code = generateCode(Number(codeLength) || 6);
    const salt = (await import('./crypto.js')).randomHex(16);
    const hash = await hashCode(code, salt);
    return { code, codeHash: hash, codeSalt: salt };
  },

  async send(s, { to, code, content }) {
    const apiKey = s.ONBUKA_API_KEY;
    const apiPwd = s.ONBUKA_API_PWD;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sign = md5(apiKey + apiPwd + timestamp);

    // 短信内容：优先用后台配置的模板，占位符 {code} / {brand}
    const template = content || s.ONBUKA_TEMPLATE || 'Your verification code is {code}';
    const text = String(template)
      .replace(/\{code\}/g, code || '')
      .replace(/\{brand\}/g, s.ONBUKA_SENDER_ID || '');

    const payload = {
      appId: s.ONBUKA_APP_ID,
      numbers: String(to).replace(/^\+/, ''), // Onbuka 要求不带 + 的纯数字
      content: text,
      trackClicks: 0,
    };
    if (s.ONBUKA_SENDER_ID) payload.senderId = s.ONBUKA_SENDER_ID;

    const res = await fetch('https://api.onbuka.com/v3/sendSms', {
      method: 'POST',
      headers: {
        'content-type': 'application/json;charset=UTF-8',
        Sign: sign,
        Timestamp: timestamp,
        'Api-Key': apiKey,
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json().catch(() => ({}));
    // status "0" 表示成功；失败时 reason 里带原因
    if (!res.ok || String(data.status) !== '0') {
      return {
        ok: false,
        provider: 'onbuka',
        error: data.reason || `onbuka_status_${data.status || res.status}`,
        raw: data,
      };
    }

    const first = Array.isArray(data.array) ? data.array[0] : null;
    return {
      ok: true,
      provider: 'onbuka',
      ref: first?.msgId || `onbuka_${timestamp}`,
      status: 'sent',
      raw: data,
    };
  },

  /** 本地比对验证码（数据库里存的是哈希） */
  async check(s, { code, storedHash, storedSalt }) {
    if (!storedHash || !storedSalt) {
      return { ok: false, provider: 'onbuka', status: 'expired', error: 'code_not_found' };
    }
    const hash = await hashCode(String(code).trim(), storedSalt);
    const ok = timingSafeEqual(hash, storedHash);
    return {
      ok,
      provider: 'onbuka',
      status: ok ? 'approved' : 'failed',
      error: ok ? undefined : 'code_incorrect',
    };
  },
};

/* ───────────── 注册表与调度 ───────────── */

const PROVIDERS = {
  twilio: TWILIO_PROVIDER,
  plivo: PLIVO_PROVIDER,
  onbuka: ONBUKA_PROVIDER,
  mock: MOCK_PROVIDER,
};

/** 该通道是否由本服务自己管理验证码 */
export function isLocalCodeProvider(name) {
  return getProvider(name)?.kind === 'local';
}

export function getProvider(name) {
  return PROVIDERS[name] || null;
}

/** 列出各通道配置状态（后台用）。s = 凭证集合 */
export function providerStatus(s) {
  return Object.values(PROVIDERS).map((p) => ({
    name: p.name,
    kind: p.kind || 'otp',
    configured: p.configured(s),
  }));
}

/**
 * 按配置选择通道。auto 模式下依次尝试，前一个失败自动切下一个。
 * @param s 凭证集合（来自 loadSecrets）
 * @returns {{ok: true, provider, ref, status, raw, tried, code?, codeHash?, codeSalt?}
 *          | {ok: false, error, tried}}
 */
export async function sendCode(s, cfg, { to, locale, brand, codeLength }) {
  const mockMode = String(s.MOCK_MODE || '0') === '1';
  const order = mockMode
    ? ['mock']
    : cfg.provider === 'auto'
      ? cfg.providerPriority || ['twilio', 'plivo', 'onbuka']
      : [cfg.provider];

  const tried = [];
  for (const name of order) {
    const provider = getProvider(name);
    if (!provider) continue;
    if (!mockMode && name === 'mock') continue; // 生产环境不允许走 mock
    if (!provider.configured(s)) {
      tried.push({ provider: name, error: 'not_configured' });
      continue;
    }
    try {
      // 自建验证码通道：先生成验证码，再带着它去发短信
      let code;
      let codeHash;
      let codeSalt;
      if (provider.kind === 'local') {
        const prepared = await provider.prepare(s, { codeLength });
        code = prepared.code;
        codeHash = prepared.codeHash;
        codeSalt = prepared.codeSalt;
      }

      const result = await provider.send(s, { to, locale, brand, code });
      if (result.ok) return { ...result, tried, code, codeHash, codeSalt };
      tried.push({ provider: name, error: result.error });
    } catch (err) {
      tried.push({ provider: name, error: String(err?.message || err) });
    }
  }
  return { ok: false, error: 'all_providers_failed', tried };
}

/** 用发送时记录的 provider 去校验验证码 */
export async function checkCode(s, { provider, ref, code, to, storedHash, storedSalt }) {
  const impl = getProvider(provider);
  if (!impl) return { ok: false, status: 'failed', error: 'provider_unknown' };
  try {
    return await impl.check(s, { ref, code, to, storedHash, storedSalt });
  } catch (err) {
    return { ok: false, status: 'failed', error: String(err?.message || err) };
  }
}
