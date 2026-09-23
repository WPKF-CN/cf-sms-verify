-- ============================================================
-- 初始表结构（Cloudflare D1 / SQLite）
--
-- 由 deploy 前的 predeploy 钩子自动执行：
--   npx wrangler d1 migrations apply DB --remote
-- 本地开发时执行：
--   npm run db:local
-- ============================================================

-- 配置表（键值对，值均为 JSON 字符串）
CREATE TABLE IF NOT EXISTS config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 验证记录表：一行 = 一次「发送验证码 → 验证」的完整会话
CREATE TABLE IF NOT EXISTS verifications (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  site             TEXT NOT NULL DEFAULT 'default',   -- 落地页标识（多页共用时可区分来源）
  phone            TEXT NOT NULL,                     -- E.164 格式
  country          TEXT,                              -- ISO2，如 US / GB
  provider         TEXT,                              -- twilio | plivo | mock
  provider_ref     TEXT,                              -- Twilio Verification SID / Plivo Session UUID
  send_status      TEXT NOT NULL DEFAULT 'pending',   -- sent | failed | blocked | mock
  send_error       TEXT,
  status           TEXT NOT NULL DEFAULT 'pending',   -- pending | verified | failed | expired
  attempts         INTEGER NOT NULL DEFAULT 0,        -- 校验次数
  ip               TEXT,
  ua               TEXT,
  origin           TEXT,                              -- 来源页面域名
  grant_token      TEXT,                              -- 验证通过后签发的免验证凭证
  grant_expires_at TEXT,
  verified_at      TEXT,
  redirect_at      TEXT                               -- 跳转 WhatsApp 的时间（用于漏斗统计）
);

CREATE INDEX IF NOT EXISTS idx_v_created   ON verifications(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_v_phone     ON verifications(phone, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_v_status    ON verifications(status);
CREATE INDEX IF NOT EXISTS idx_v_grant     ON verifications(grant_token);

-- 频控事件表：每次发送/校验失败都记一条，用于限流统计
CREATE TABLE IF NOT EXISTS rate (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  bucket     TEXT NOT NULL,   -- phone:+1415... | ip:1.2.3.4 | global
  kind       TEXT NOT NULL    -- send | check_fail
);

CREATE INDEX IF NOT EXISTS idx_rate ON rate(bucket, kind, created_at);
