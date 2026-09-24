/**
 * WhatsApp 链接池
 *
 * 设计要点：
 *   · 链接是有归属的：site='*' 是「通用池」（多个落地页共享），否则只服务那一个站点
 *   · 选择顺序：站点专属池 → 通用池 → （都没配）旧版 config.whatsappLinks → null
 *     返回 null 时，前端会自动回落到落地页自带的链接池，保证不丢转化
 *   · 每条链接可以单独启用/停用、设权重、设「每 24 小时分配上限」
 *   · 每次分配都会写回 verifications.link_id / link_url，于是能做链接级统计
 */

const STRATEGIES = ['weighted', 'random', 'least'];
export const LINK_STRATEGIES = STRATEGIES;

/** 链接池「是否已被接管」的判断：只要后台建过任何一条链接，旧版 textarea 就不再生效 */
export async function hasAnyLink(env) {
  try {
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM links').first();
    return Number(row?.n || 0) > 0;
  } catch {
    return false; // 还没迁移（表不存在）时当作没有，继续走旧逻辑
  }
}

/* ───────────── 归一化与校验 ───────────── */

export function normalizeSite(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s || s === '*' || s === 'all' || s === '通用' || s === '通用池') return '*';
  return s.replace(/[^a-z0-9._-]/g, '').slice(0, 40) || '*';
}

export function normalizeLinkUrl(v) {
  let u = String(v ?? '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u.replace(/^\/+/, '');
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function toInt(v, { min = 0, max = 1_000_000, fallback = 0 } = {}) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function cleanLabel(v) {
  return String(v ?? '').trim().slice(0, 60);
}

/* ───────────── 读取 ───────────── */

/** 后台列表：带统计（近 24 小时分配 / 累计分配 / 累计跳转 / 最近一次分配时间） */
export async function listLinks(env, { site } = {}) {
  const where = site ? 'WHERE lower(l.site) = lower(?)' : '';
  const params = site ? [normalizeSite(site)] : [];
  const { results } = await env.DB.prepare(
    `SELECT l.id, l.site, l.url, l.label, l.enabled, l.weight, l.daily_cap, l.sort_order,
            l.created_at, l.updated_at,
            (SELECT COUNT(*) FROM verifications v
              WHERE v.link_id = l.id AND v.created_at > datetime('now', '-1 day')) AS last24h,
            (SELECT COUNT(*) FROM verifications v WHERE v.link_id = l.id) AS total,
            (SELECT COUNT(*) FROM verifications v
              WHERE v.link_id = l.id AND v.redirect_at IS NOT NULL) AS redirected,
            (SELECT MAX(v.created_at) FROM verifications v WHERE v.link_id = l.id) AS last_at
       FROM links l ${where}
      ORDER BY l.site, l.sort_order, l.id`,
  )
    .bind(...params)
    .all();

  return (results || []).map((r) => ({
    id: r.id,
    site: r.site,
    url: r.url,
    label: r.label || '',
    enabled: Number(r.enabled) === 1,
    weight: Number(r.weight) || 1,
    dailyCap: Number(r.daily_cap) || 0,
    sortOrder: Number(r.sort_order) || 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    last24h: Number(r.last24h || 0),
    total: Number(r.total || 0),
    redirected: Number(r.redirected || 0),
    lastAt: r.last_at || null,
  }));
}

/** 站点下拉选项：链接池里出现过的站点 + 记录里出现过的站点 */
export async function linkSiteOptions(env) {
  const out = new Set();
  try {
    const { results } = await env.DB.prepare('SELECT DISTINCT site FROM links').all();
    for (const r of results || []) if (r.site && r.site !== '*') out.add(String(r.site).toLowerCase());
  } catch { /* ignore */ }
  try {
    const { results } = await env.DB.prepare(
      `SELECT site FROM verifications
        WHERE created_at > datetime('now', '-30 days')
        GROUP BY site ORDER BY COUNT(*) DESC LIMIT 20`,
    ).all();
    for (const r of results || []) if (r.site && r.site !== '*') out.add(String(r.site).toLowerCase());
  } catch { /* ignore */ }
  return [...out].sort();
}

export async function getLink(env, id) {
  const row = await env.DB.prepare('SELECT * FROM links WHERE id = ?').bind(Number(id)).first();
  return row || null;
}

/** 某站点下启用中的链接 */
async function enabledLinks(env, site) {
  const { results } = await env.DB.prepare(
    `SELECT id, site, url, label, weight, daily_cap
       FROM links
      WHERE lower(site) = lower(?) AND enabled = 1
      ORDER BY sort_order, id`,
  )
    .bind(site)
    .all();
  return results || [];
}

/** 近 24 小时每条链接被分配了几次（用于上限判断与「最闲优先」） */
async function counts24h(env, ids) {
  const map = new Map();
  if (!ids.length) return map;
  const holders = ids.map(() => '?').join(',');
  const { results } = await env.DB.prepare(
    `SELECT link_id, COUNT(*) AS n
       FROM verifications
      WHERE link_id IN (${holders}) AND created_at > datetime('now', '-1 day')
      GROUP BY link_id`,
  )
    .bind(...ids)
    .all();
  for (const r of results || []) map.set(Number(r.link_id), Number(r.n || 0));
  return map;
}

/* ───────────── 选择算法 ───────────── */

function pickWeighted(pool) {
  const total = pool.reduce((sum, r) => sum + Math.max(1, Number(r.weight) || 1), 0);
  let r = Math.random() * total;
  for (const row of pool) {
    r -= Math.max(1, Number(row.weight) || 1);
    if (r <= 0) return row;
  }
  return pool[pool.length - 1];
}

function pickLeastUsed(pool, counts) {
  // 按「已分配次数 / 权重」排序，越小越优先；并列时随机挑一个
  let best = null;
  let bestScore = Infinity;
  const ties = [];
  for (const row of pool) {
    const used = counts.get(Number(row.id)) || 0;
    const score = (used + 1) / Math.max(1, Number(row.weight) || 1);
    if (score < bestScore - 1e-9) {
      bestScore = score;
      best = row;
      ties.length = 0;
      ties.push(row);
    } else if (Math.abs(score - bestScore) <= 1e-9) {
      ties.push(row);
    }
  }
  return ties.length ? ties[Math.floor(Math.random() * ties.length)] : best;
}

function chooseLink(pool, counts, strategy) {
  if (strategy === 'random') return pool[Math.floor(Math.random() * pool.length)];
  if (strategy === 'least') return pickLeastUsed(pool, counts);
  return pickWeighted(pool);
}

/**
 * 为一次跳转挑一条链接。
 * 返回 { id, url, source } ；返回 null 表示后台没得发，前端应回落到落地页自带池。
 */
export async function pickLinkForSite(env, cfg, site) {
  const strategy = STRATEGIES.includes(cfg?.linkStrategy) ? cfg.linkStrategy : 'weighted';
  const wanted = normalizeSite(site);
  const scopes = wanted === '*' ? ['*'] : [wanted, '*'];

  let poolEverFound = false;
  for (const scope of scopes) {
    const rows = await enabledLinks(env, scope);
    if (!rows.length) continue;
    poolEverFound = true;
    const counts = await counts24h(env, rows.map((r) => Number(r.id)));
    const usable = rows.filter((r) => {
      const cap = Number(r.daily_cap) || 0;
      return !cap || (counts.get(Number(r.id)) || 0) < cap;
    });
    if (!usable.length) continue; // 这个池子全到上限了，看下一个池子
    const row = chooseLink(usable, counts, strategy);
    return {
      id: Number(row.id),
      url: row.url,
      source: scope === wanted ? 'site' : 'shared',
    };
  }

  // 后台链接池完全没配过 → 兼容旧版「一行一条」的链接数组
  if (!poolEverFound && !(await hasAnyLink(env))) {
    const legacy = (cfg?.whatsappLinks || []).map((s) => String(s).trim()).filter(Boolean);
    if (legacy.length) {
      return { id: null, url: legacy[Math.floor(Math.random() * legacy.length)], source: 'legacy' };
    }
  }
  return null;
}

/** 把分配结果写回验证记录（用于统计与「同一用户保持同一条」） */
export async function assignLink(env, verificationId, link) {
  const id = Number(verificationId);
  if (!id) return;
  await env.DB.prepare(
    `UPDATE verifications
        SET link_id = ?, link_url = ?, updated_at = datetime('now')
      WHERE id = ?`,
  )
    .bind(link?.id ?? null, link?.url ?? null, id)
    .run();
}

/* ───────────── 后台增删改 ───────────── */

export async function createLink(env, data) {
  const url = normalizeLinkUrl(data.url);
  if (!url) return { ok: false, error: 'BAD_URL' };
  const site = normalizeSite(data.site);
  const result = await env.DB.prepare(
    `INSERT INTO links (site, url, label, enabled, weight, daily_cap, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      site,
      url,
      cleanLabel(data.label),
      data.enabled === false ? 0 : 1,
      toInt(data.weight, { min: 1, max: 1000, fallback: 1 }),
      toInt(data.dailyCap, { min: 0, max: 1_000_000, fallback: 0 }),
      toInt(data.sortOrder, { min: 0, max: 100_000, fallback: 0 }),
    )
    .run();
  return { ok: true, id: result.meta?.last_row_id };
}

export async function updateLink(env, id, data) {
  const linkId = Number(id);
  const existing = await getLink(env, linkId);
  if (!existing) return { ok: false, error: 'NOT_FOUND' };

  const patch = [];
  const params = [];
  const set = (col, value) => {
    patch.push(`${col} = ?`);
    params.push(value);
  };

  if (data.url !== undefined) {
    const url = normalizeLinkUrl(data.url);
    if (!url) return { ok: false, error: 'BAD_URL' };
    set('url', url);
  }
  if (data.site !== undefined) set('site', normalizeSite(data.site));
  if (data.label !== undefined) set('label', cleanLabel(data.label));
  if (data.enabled !== undefined) set('enabled', data.enabled ? 1 : 0);
  if (data.weight !== undefined) {
    set('weight', toInt(data.weight, { min: 1, max: 1000, fallback: 1 }));
  }
  if (data.dailyCap !== undefined) {
    set('daily_cap', toInt(data.dailyCap, { min: 0, max: 1_000_000, fallback: 0 }));
  }
  if (data.sortOrder !== undefined) {
    set('sort_order', toInt(data.sortOrder, { min: 0, max: 100_000, fallback: 0 }));
  }
  if (!patch.length) return { ok: true };

  patch.push(`updated_at = datetime('now')`);
  await env.DB.prepare(`UPDATE links SET ${patch.join(', ')} WHERE id = ?`)
    .bind(...params, linkId)
    .run();
  return { ok: true };
}

export async function deleteLink(env, id) {
  await env.DB.prepare('DELETE FROM links WHERE id = ?').bind(Number(id)).run();
  return { ok: true };
}

/** 批量导入：一行一条链接，全部放进指定站点池 */
export async function importLinks(env, { site, text, label, weight, dailyCap }) {
  const lines = String(text || '')
    .split(/[\r\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const normalized = [...new Set(lines.map(normalizeLinkUrl).filter(Boolean))];
  let added = 0;
  let skipped = 0;
  for (const url of normalized) {
    const dup = await env.DB.prepare('SELECT id FROM links WHERE url = ?').bind(url).first();
    if (dup) {
      skipped += 1;
      continue;
    }
    const res = await createLink(env, { site, url, label, weight, dailyCap, enabled: true });
    if (res.ok) added += 1;
    else skipped += 1;
  }
  return { ok: true, added, skipped };
}
