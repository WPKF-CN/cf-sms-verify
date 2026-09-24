-- ============================================================
-- SMS Verify —— 完整建表脚本（全新数据库用这一份）
--
-- 用途：走「Cloudflare 网页后台手动部署」时，把本文件全部内容
--       粘贴到 D1 的 Console 里执行一次即可（重复执行也安全，
--       建表语句都带 IF NOT EXISTS）。
--
-- 走命令行 / Deploy 按钮的部署不用管这个文件——那边由
-- migrations/*.sql 自动执行，内容与本文件保持一致。
--
-- 如果你是从旧版本升级（数据库里已经有数据），不要跑这个文件，
-- 改为执行 migrations/ 里你还没跑过的那几个（例如 0003_links.sql）。
-- ============================================================

-- ─── 1. 配置表（键值对，值均为 JSON 字符串）───
CREATE TABLE IF NOT EXISTS config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── 2. 验证记录表：一行 = 一次「发送验证码 → 验证」的完整会话 ───
CREATE TABLE IF NOT EXISTS verifications (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  site             TEXT NOT NULL DEFAULT 'default',   -- 落地页标识（多页共用时可区分来源）
  phone            TEXT NOT NULL,                     -- E.164 格式
  country          TEXT,                              -- ISO2，如 US / GB
  provider         TEXT,                              -- twilio | plivo | onbuka | mock
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
  redirect_at      TEXT,                              -- 跳转 WhatsApp 的时间（用于漏斗统计）
  code_hash        TEXT,                              -- 自建验证码通道：验证码哈希
  code_salt        TEXT,
  code_expires_at  TEXT,
  link_id          INTEGER,                           -- 分配出去的链接池记录 id（NULL = 走落地页自带池）
  link_url         TEXT                               -- 实际下发的链接（保留历史，链接删了也查得到）
);

CREATE INDEX IF NOT EXISTS idx_v_created ON verifications(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_v_phone   ON verifications(phone, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_v_status  ON verifications(status);
CREATE INDEX IF NOT EXISTS idx_v_grant   ON verifications(grant_token);
CREATE INDEX IF NOT EXISTS idx_v_link    ON verifications(link_id, created_at DESC);

-- ─── 3. 频控事件表：每次发送都记一条，用于限流统计 ───
CREATE TABLE IF NOT EXISTS rate (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  bucket     TEXT NOT NULL,   -- phone:+1415... | ip:1.2.3.4 | global | login:1.2.3.4
  kind       TEXT NOT NULL    -- send | check_fail | login
);

CREATE INDEX IF NOT EXISTS idx_rate ON rate(bucket, kind, created_at);

-- ─── 4. 加密凭证表（短信商密钥、Turnstile Secret，AES-GCM 加密存储）───
CREATE TABLE IF NOT EXISTS secrets (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,          -- 密文（base64）
  iv         TEXT NOT NULL,          -- 初始化向量（base64）
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── 5. 管理员账号（首次访问 /admin 时创建）───
CREATE TABLE IF NOT EXISTS admins (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,       -- PBKDF2-SHA256
  password_salt TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

-- ─── 6. WhatsApp 链接池（后台「链接池」页管理）───
CREATE TABLE IF NOT EXISTS links (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  site       TEXT NOT NULL DEFAULT '*',   -- '*' = 通用池（所有站点共享）
  url        TEXT NOT NULL,
  label      TEXT,
  enabled    INTEGER NOT NULL DEFAULT 1,  -- 1 启用 / 0 停用
  weight     INTEGER NOT NULL DEFAULT 1,  -- 权重，越大分配越多
  daily_cap  INTEGER NOT NULL DEFAULT 0,  -- 每 24 小时分配上限，0 = 不限
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_links_site ON links(site, enabled, sort_order);
