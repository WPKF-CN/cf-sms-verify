/**
 * 数据访问与频控
 */

/* ───────────── 频控 ───────────── */

async function countEvents(env, bucket, kind, windowSql) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM rate
      WHERE bucket = ? AND kind = ? AND created_at > datetime('now', ?)`,
  )
    .bind(bucket, kind, windowSql)
    .first();
  return Number(row?.n || 0);
}

async function recordEvent(env, bucket, kind) {
  await env.DB.prepare('INSERT INTO rate (bucket, kind) VALUES (?, ?)').bind(bucket, kind).run();
}

/**
 * 发送前的频控检查。返回 { allowed, reason, retryAfter }
 * 检查四层：号码重发间隔 → 号码日上限 → IP 小时上限 → 全站小时上限
 */
export async function checkSendLimit(env, cfg, { phone, ip }) {
  const phoneBucket = `phone:${phone}`;
  const ipBucket = `ip:${ip}`;

  if (cfg.resendIntervalSec > 0) {
    const recent = await countEvents(
      env,
      phoneBucket,
      'send',
      `-${Math.max(1, Math.ceil(cfg.resendIntervalSec))} seconds`,
    );
    if (recent > 0) {
      return { allowed: false, reason: 'RESEND_TOO_SOON', retryAfter: cfg.resendIntervalSec };
    }
  }

  if (cfg.phoneDailyLimit > 0) {
    const daily = await countEvents(env, phoneBucket, 'send', '-1 day');
    if (daily >= cfg.phoneDailyLimit) {
      return { allowed: false, reason: 'PHONE_DAILY_LIMIT', retryAfter: 3600 };
    }
  }

  if (cfg.ipHourlyLimit > 0) {
    const hourly = await countEvents(env, ipBucket, 'send', '-1 hour');
    if (hourly >= cfg.ipHourlyLimit) {
      return { allowed: false, reason: 'IP_HOURLY_LIMIT', retryAfter: 600 };
    }
  }

  if (cfg.globalHourlyLimit > 0) {
    const global = await countEvents(env, 'global', 'send', '-1 hour');
    if (global >= cfg.globalHourlyLimit) {
      return { allowed: false, reason: 'GLOBAL_LIMIT', retryAfter: 600 };
    }
  }

  return { allowed: true };
}

/** 记录一次发送动作（无论成功与否），用于限流统计 */
export async function recordSendAttempt(env, { phone, ip }) {
  await env.DB.batch([
    env.DB.prepare('INSERT INTO rate (bucket, kind) VALUES (?, ?)').bind(`phone:${phone}`, 'send'),
    env.DB.prepare('INSERT INTO rate (bucket, kind) VALUES (?, ?)').bind(`ip:${ip}`, 'send'),
    env.DB.prepare('INSERT INTO rate (bucket, kind) VALUES (?, ?)').bind('global', 'send'),
  ]);
}

/** 登录接口限流：同一 IP 每小时最多 10 次尝试 */
export async function checkLoginLimit(env, ip) {
  const n = await countEvents(env, `login:${ip}`, 'login', '-1 hour');
  if (n >= 10) return { allowed: false };
  await recordEvent(env, `login:${ip}`, 'login');
  return { allowed: true };
}

/* ───────────── 验证记录 ───────────── */

export async function createVerification(env, data) {
  const result = await env.DB.prepare(
    `INSERT INTO verifications
       (site, phone, country, provider, provider_ref, send_status, send_error, ip, ua, origin,
        code_hash, code_salt, code_expires_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
  )
    .bind(
      data.site,
      data.phone,
      data.country,
      data.provider,
      data.providerRef,
      data.sendStatus,
      data.sendError || null,
      data.ip,
      data.ua,
      data.origin,
      data.codeHash || null,
      data.codeSalt || null,
      data.codeExpiresAt || null,
    )
    .run();
  return result.meta?.last_row_id;
}

export async function getVerification(env, id) {
  return env.DB.prepare('SELECT * FROM verifications WHERE id = ?').bind(id).first();
}

export async function incrementAttempts(env, id) {
  await env.DB.prepare(
    `UPDATE verifications SET attempts = attempts + 1, updated_at = datetime('now') WHERE id = ?`,
  )
    .bind(id)
    .run();
}

export async function markVerified(env, id, { grantToken, grantExpiresAt }) {
  await env.DB.prepare(
    `UPDATE verifications
        SET status = 'verified', verified_at = datetime('now'), updated_at = datetime('now'),
            grant_token = ?, grant_expires_at = ?
      WHERE id = ?`,
  )
    .bind(grantToken, grantExpiresAt, id)
    .run();
}

export async function markStatus(env, id, status) {
  await env.DB.prepare(
    `UPDATE verifications SET status = ?, updated_at = datetime('now') WHERE id = ?`,
  )
    .bind(status, id)
    .run();
}

export async function markRedirect(env, id) {
  await env.DB.prepare(
    `UPDATE verifications SET redirect_at = datetime('now') WHERE id = ?`,
  )
    .bind(id)
    .run();
}

/** 校验免验证凭证 */
export async function findGrant(env, token) {
  if (!token || typeof token !== 'string' || token.length < 16) return null;
  const row = await env.DB.prepare(
    `SELECT id, phone, country, grant_expires_at
       FROM verifications
      WHERE grant_token = ? AND status = 'verified'
        AND grant_expires_at > datetime('now')
      LIMIT 1`,
  )
    .bind(token)
    .first();
  return row || null;
}

/* ───────────── 后台查询 ───────────── */

export async function listVerifications(env, { page = 1, pageSize = 20, phone, status, provider, site, from, to } = {}) {
  const where = [];
  const params = [];
  if (phone) {
    where.push('phone LIKE ?');
    params.push(`%${String(phone).replace(/\D/g, '')}%`);
  }
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  if (provider) {
    where.push('provider = ?');
    params.push(provider);
  }
  if (site) {
    where.push('site = ?');
    params.push(site);
  }
  if (from) {
    where.push('created_at >= ?');
    params.push(from);
  }
  if (to) {
    where.push('created_at <= ?');
    params.push(to);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const size = Math.min(Math.max(Number(pageSize) || 20, 1), 200);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * size;

  const [rows, totalRow] = await Promise.all([
    env.DB.prepare(
      `SELECT id, created_at, updated_at, site, phone, country, provider, provider_ref,
              send_status, send_error, status, attempts, ip, ua, origin,
              grant_expires_at, verified_at, redirect_at
         FROM verifications ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`,
    )
      .bind(...params, size, offset)
      .all(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM verifications ${whereSql}`)
      .bind(...params)
      .first(),
  ]);

  return {
    rows: rows.results || [],
    total: Number(totalRow?.n || 0),
    page: Math.max(Number(page) || 1, 1),
    pageSize: size,
  };
}

export async function getStats(env) {
  const [overview, byCountry, byProvider, bySite, daily, hourly] = await Promise.all([
    env.DB.prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'verified' THEN 1 ELSE 0 END) AS verified,
         SUM(CASE WHEN send_status = 'failed' THEN 1 ELSE 0 END) AS send_failed,
         SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END) AS expired,
         SUM(CASE WHEN redirect_at IS NOT NULL THEN 1 ELSE 0 END) AS redirected
       FROM verifications
       WHERE created_at > datetime('now', '-30 days')`,
    ).first(),
    env.DB.prepare(
      `SELECT country, COUNT(*) AS n,
              SUM(CASE WHEN status = 'verified' THEN 1 ELSE 0 END) AS verified
         FROM verifications
        WHERE created_at > datetime('now', '-30 days')
        GROUP BY country ORDER BY n DESC LIMIT 12`,
    ).all(),
    env.DB.prepare(
      `SELECT provider, COUNT(*) AS n,
              SUM(CASE WHEN send_status = 'failed' THEN 1 ELSE 0 END) AS failed
         FROM verifications
        WHERE created_at > datetime('now', '-30 days')
        GROUP BY provider ORDER BY n DESC`,
    ).all(),
    env.DB.prepare(
      `SELECT site, COUNT(*) AS n,
              SUM(CASE WHEN status = 'verified' THEN 1 ELSE 0 END) AS verified
         FROM verifications
        WHERE created_at > datetime('now', '-30 days')
        GROUP BY site ORDER BY n DESC LIMIT 10`,
    ).all(),
    env.DB.prepare(
      `SELECT date(created_at) AS day, COUNT(*) AS n,
              SUM(CASE WHEN status = 'verified' THEN 1 ELSE 0 END) AS verified
         FROM verifications
        WHERE created_at > datetime('now', '-14 days')
        GROUP BY day ORDER BY day DESC`,
    ).all(),
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM verifications WHERE created_at > datetime('now', '-1 hour')`,
    ).first(),
  ]);

  return {
    overview: {
      total: Number(overview?.total || 0),
      verified: Number(overview?.verified || 0),
      sendFailed: Number(overview?.send_failed || 0),
      expired: Number(overview?.expired || 0),
      redirected: Number(overview?.redirected || 0),
      lastHour: Number(hourly?.n || 0),
    },
    byCountry: byCountry.results || [],
    byProvider: byProvider.results || [],
    bySite: bySite.results || [],
    daily: (daily.results || []).reverse(),
  };
}

/* ───────────── 定时清理 ───────────── */

export async function cleanup(env) {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM rate WHERE created_at < datetime('now', '-3 days')`),
    env.DB.prepare(`DELETE FROM verifications WHERE created_at < datetime('now', '-180 days')`),
  ]);
}
