-- ============================================================
-- 迁移 0003：后台可管理的 WhatsApp 链接池
--
-- 背景：
--   原来 linkMode=server 时只有一个全局的「一行一条」链接数组（config.whatsappLinks），
--   不分站点、没有开关、没有权重、没有上限，也统计不到「这条链接被发了多少次」。
--
--   这一版把链接变成正经的记录：
--     · 归属站点（site='*' 表示通用池，多个站点共享）
--     · 开关 / 权重 / 每 24 小时上限
--     · 每次分配写回 verifications.link_id，于是能做链接级统计
-- ============================================================

CREATE TABLE IF NOT EXISTS links (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  site       TEXT NOT NULL DEFAULT '*',   -- '*' = 通用池；否则是落地页的 site 标识
  url        TEXT NOT NULL,               -- WhatsApp 链接（https://...）
  label      TEXT,                        -- 备注名（后台显示用，比如「A 群 / 客服 1」）
  enabled    INTEGER NOT NULL DEFAULT 1,  -- 1 启用 / 0 停用
  weight     INTEGER NOT NULL DEFAULT 1,  -- 权重（越大分配越多，最小 1）
  daily_cap  INTEGER NOT NULL DEFAULT 0,  -- 每 24 小时最多分配几次；0 = 不限
  sort_order INTEGER NOT NULL DEFAULT 0,  -- 展示顺序
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_links_site ON links(site, enabled, sort_order);

-- 记录「这次验证分配了哪条链接」，用于链接级统计
ALTER TABLE verifications ADD COLUMN link_id  INTEGER;
ALTER TABLE verifications ADD COLUMN link_url TEXT;

CREATE INDEX IF NOT EXISTS idx_v_link ON verifications(link_id, created_at DESC);
