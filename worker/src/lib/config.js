/**
 * 配置管理：默认值 + D1 读写 + 国家元数据
 *
 * 所有配置存在 D1 的 config 表里（key/value，value 是 JSON），
 * 后台改完即时生效，无需重新部署。
 */
import { safeJsonParse } from './utils.js';

/* ───────────── 国家元数据（下拉框用）───────────── */

/**
 * 常用欧美/主流国家。dial = 国际区号，example = 示例本地号码（用于输入框提示）
 * 需要更多国家时在这里补一行即可。
 */
export const COUNTRY_META = {
  US: { name: 'United States', dial: '1', example: '4155552671' },
  CA: { name: 'Canada', dial: '1', example: '6045551234' },
  GB: { name: 'United Kingdom', dial: '44', example: '7400123456' },
  IE: { name: 'Ireland', dial: '353', example: '850123456' },
  DE: { name: 'Germany', dial: '49', example: '15112345678' },
  FR: { name: 'France', dial: '33', example: '612345678' },
  IT: { name: 'Italy', dial: '39', example: '3123456789' },
  ES: { name: 'Spain', dial: '34', example: '612345678' },
  PT: { name: 'Portugal', dial: '351', example: '912345678' },
  NL: { name: 'Netherlands', dial: '31', example: '612345678' },
  BE: { name: 'Belgium', dial: '32', example: '470123456' },
  AT: { name: 'Austria', dial: '43', example: '664123456' },
  CH: { name: 'Switzerland', dial: '41', example: '781234567' },
  SE: { name: 'Sweden', dial: '46', example: '701234567' },
  NO: { name: 'Norway', dial: '47', example: '40612345' },
  DK: { name: 'Denmark', dial: '45', example: '20123456' },
  FI: { name: 'Finland', dial: '358', example: '401234567' },
  PL: { name: 'Poland', dial: '48', example: '512345678' },
  CZ: { name: 'Czechia', dial: '420', example: '601123456' },
  GR: { name: 'Greece', dial: '30', example: '6912345678' },
  RO: { name: 'Romania', dial: '40', example: '712345678' },
  HU: { name: 'Hungary', dial: '36', example: '201234567' },
  AU: { name: 'Australia', dial: '61', example: '412345678' },
  NZ: { name: 'New Zealand', dial: '64', example: '211234567' },
  BR: { name: 'Brazil', dial: '55', example: '11912345678' },
  MX: { name: 'Mexico', dial: '52', example: '5512345678' },
  AR: { name: 'Argentina', dial: '54', example: '91123456789' },
  CL: { name: 'Chile', dial: '56', example: '912345678' },
  CO: { name: 'Colombia', dial: '57', example: '3012345678' },
  PE: { name: 'Peru', dial: '51', example: '912345678' },
  JP: { name: 'Japan', dial: '81', example: '9012345678' },
  KR: { name: 'South Korea', dial: '82', example: '1012345678' },
  IN: { name: 'India', dial: '91', example: '9876543210' },
  SG: { name: 'Singapore', dial: '65', example: '81234567' },
  MY: { name: 'Malaysia', dial: '60', example: '123456789' },
  TH: { name: 'Thailand', dial: '66', example: '812345678' },
  VN: { name: 'Vietnam', dial: '84', example: '912345678' },
  PH: { name: 'Philippines', dial: '63', example: '9171234567' },
  ID: { name: 'Indonesia', dial: '62', example: '8123456789' },
  ZA: { name: 'South Africa', dial: '27', example: '711234567' },
  AE: { name: 'United Arab Emirates', dial: '971', example: '501234567' },
  SA: { name: 'Saudi Arabia', dial: '966', example: '501234567' },
  IL: { name: 'Israel', dial: '972', example: '501234567' },
  TR: { name: 'Türkiye', dial: '90', example: '5012345678' },
  RU: { name: 'Russia', dial: '7', example: '9123456789' },
  UA: { name: 'Ukraine', dial: '380', example: '501234567' },
};

/* ───────────── 默认配置 ───────────── */

export const DEFAULT_CONFIG = {
  /* —— 国家白名单：只填一个即只允许该国；填多个 = 多国放行；空数组 = 全部拒绝 —— */
  allowedCountries: ['US'],

  /* —— 短信通道 —— */
  provider: 'auto', // auto | twilio | plivo | mock
  providerPriority: ['twilio', 'plivo'], // auto 模式下的尝试顺序

  /* —— 人机检测（Cloudflare Turnstile）—— */
  turnstileEnabled: true,
  turnstileSiteKey: '', // 前端用；Secret 放在 Worker secret 里

  /* —— 频控 —— */
  resendIntervalSec: 60, // 同一号码重发间隔
  phoneDailyLimit: 5, // 同一号码每日上限
  ipHourlyLimit: 30, // 同一 IP 每小时发送上限
  globalHourlyLimit: 2000, // 全站每小时发送上限（熔断保护）
  codeMaxAttempts: 5, // 单次会话最多校验次数

  /* —— 验证通过后的免验证窗口（小时）。0 = 每次都要验证 —— */
  grantTtlHours: 24,

  /* —— 链接模式：client = 链接留在页面里；server = 验证通过后由 Worker 下发 —— */
  linkMode: 'client',
  whatsappLinks: [], // linkMode=server 时使用

  /* —— 允许的站点来源；["*"] 表示不限制（建议生产环境填具体域名）—— */
  allowedOrigins: ['*'],

  /* —— 文案与外观 —— */
  accentColor: '#30a05c',
  texts: {
    title: 'Verify your phone',
    subtitle: 'Confirm your number to join the group',
    phoneLabel: 'Phone number',
    sendBtn: 'Send code',
    codeLabel: 'Enter the 6-digit code',
    verifyBtn: 'Verify & continue',
    resend: 'Resend code',
    resendIn: 'Resend in {s}s',
    back: 'Change number',
    securityNote: 'We only use your number to verify you. No spam.',
    sending: 'Sending…',
    verifying: 'Verifying…',
    success: 'Verified! Redirecting…',
    errorGeneric: 'Something went wrong. Please try again.',
    errorPhone: 'Please enter a valid phone number.',
    errorCountry: 'This country is not supported.',
    errorCode: 'Incorrect or expired code.',
    errorRateLimit: 'Too many requests. Please try again later.',
    errorResend: 'Please wait before requesting a new code.',
    errorTurnstile: 'Verification check failed. Please retry.',
  },
};

/* ───────────── 读写 ───────────── */

let cache = null;
let cacheAt = 0;
const CACHE_MS = 10_000; // 10 秒缓存，后台改配置后最多 10 秒生效

/** 读取全部配置（默认值 + D1 覆盖） */
export async function loadConfig(env, { force = false } = {}) {
  const now = Date.now();
  if (!force && cache && now - cacheAt < CACHE_MS) return cache;

  const merged = structuredClone(DEFAULT_CONFIG);
  try {
    const { results } = await env.DB.prepare('SELECT key, value FROM config').all();
    for (const row of results || []) {
      const val = safeJsonParse(row.value, undefined);
      if (val !== undefined) merged[row.key] = val;
    }
  } catch {
    // 数据库还没初始化时，退回到默认配置，保证 API 不至于 500
  }
  if (merged.texts && typeof merged.texts === 'object') {
    merged.texts = { ...DEFAULT_CONFIG.texts, ...merged.texts };
  }
  cache = merged;
  cacheAt = now;
  return merged;
}

/** 保存部分配置（只写传入的 key） */
export async function saveConfig(env, patch) {
  const entries = Object.entries(patch || {}).filter(([k]) => k in DEFAULT_CONFIG);
  const stmts = entries.map(([key, value]) =>
    env.DB.prepare(
      `INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    ).bind(key, JSON.stringify(value)),
  );
  if (stmts.length) await env.DB.batch(stmts);
  cache = null;
  cacheAt = 0;
  return loadConfig(env, { force: true });
}

/** 组装给前端用的国家列表 */
export function buildCountryList(allowed) {
  const list = Array.isArray(allowed) ? allowed : [];
  return list
    .map((iso) => {
      const code = String(iso || '').toUpperCase();
      const meta = COUNTRY_META[code];
      if (!meta) return null;
      return {
        iso2: code,
        name: meta.name,
        dial: meta.dial,
        example: meta.example,
      };
    })
    .filter(Boolean);
}

/** 前端可见的公开配置（不含任何密钥） */
export function publicConfig(cfg) {
  const countries = buildCountryList(cfg.allowedCountries);
  return {
    countries,
    defaultCountry: countries[0]?.iso2 || '',
    turnstileEnabled: Boolean(cfg.turnstileEnabled && cfg.turnstileSiteKey),
    turnstileSiteKey: cfg.turnstileSiteKey || '',
    accentColor: cfg.accentColor,
    codeLength: 6,
    resendIntervalSec: cfg.resendIntervalSec,
    grantTtlHours: cfg.grantTtlHours,
    linkMode: cfg.linkMode,
    texts: cfg.texts,
  };
}
