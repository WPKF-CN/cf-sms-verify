/**
 * 加密工具：MD5、密码哈希（PBKDF2）、验证码生成
 *
 * 说明：Cloudflare Workers 的 WebCrypto 不提供 MD5，
 * 而 Onbuka 的接口签名要求 md5(apiKey + apiPwd + timestamp)，
 * 所以这里用纯 JS 实现一份（仅用于签名，不用于密码存储）。
 */

/* ───────────── 十六进制辅助 ───────────── */

export function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export function randomHex(bytes = 16) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return bytesToHex(buf);
}

/* ───────────── MD5（纯 JS）───────────── */

const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const MD5_K = (() => {
  const k = new Uint32Array(64);
  for (let i = 0; i < 64; i += 1) k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
  return k;
})();

/** 计算字符串的 MD5（UTF-8），返回 32 位小写十六进制 */
export function md5(input) {
  const bytes = new TextEncoder().encode(String(input));
  const len = bytes.length;
  const padded = new Uint8Array((((len + 8) >> 6) + 1) * 64);
  padded.set(bytes);
  padded[len] = 0x80;

  const view = new DataView(padded.buffer);
  const bitLen = len * 8;
  view.setUint32(padded.length - 8, bitLen >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(bitLen / 4294967296), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const m = new Uint32Array(16);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i += 1) m[i] = view.getUint32(off + i * 4, true);

    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let i = 0; i < 64; i += 1) {
      let f;
      let g;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      f = (f + a + MD5_K[i] + m[g]) >>> 0;
      a = d;
      d = c;
      c = b;
      const s = MD5_S[i];
      b = (b + ((f << s) | (f >>> (32 - s)))) >>> 0;
    }

    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, a0, true);
  ov.setUint32(4, b0, true);
  ov.setUint32(8, c0, true);
  ov.setUint32(12, d0, true);
  return bytesToHex(out);
}

/* ───────────── 后台密码哈希（PBKDF2-SHA256）───────────── */

const PBKDF2_ITERATIONS = 100_000;

/** 生成密码哈希；返回 { hash, salt } */
export async function hashPassword(password, saltHex) {
  const salt = hexToBytes(saltHex || randomHex(16));
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(String(password)),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key,
    256,
  );
  return { hash: bytesToHex(new Uint8Array(bits)), salt: bytesToHex(salt) };
}

/** 校验密码 */
export async function verifyPasswordHash(password, saltHex, expectedHash) {
  if (!saltHex || !expectedHash) return false;
  const { hash } = await hashPassword(password, saltHex);
  return timingSafeEqual(hash, expectedHash);
}

/** 常数时间比较 */
export function timingSafeEqual(a, b) {
  const sa = String(a || '');
  const sb = String(b || '');
  if (sa.length !== sb.length) return false;
  let diff = 0;
  for (let i = 0; i < sa.length; i += 1) diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  return diff === 0;
}

/* ───────────── 短信验证码 ───────────── */

/** 生成指定位数的数字验证码（均匀分布，无取模偏差） */
export function generateCode(length = 6) {
  const digits = [];
  const max = 10;
  const limit = Math.floor(4294967296 / max) * max; // 拒绝采样上界
  while (digits.length < length) {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    if (buf[0] >= limit) continue;
    digits.push(String(buf[0] % max));
  }
  return digits.join('');
}

/** 验证码哈希（带 salt，避免明文落库） */
export async function hashCode(code, saltHex) {
  const salt = hexToBytes(saltHex || randomHex(16));
  const data = new TextEncoder().encode(`${saltHex || bytesToHex(salt)}:${code}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return bytesToHex(new Uint8Array(digest));
}
