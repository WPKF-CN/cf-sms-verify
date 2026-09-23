-- ============================================================
-- 迁移 0002：凭证改存数据库 + 支持自建验证码
--
-- 背景：
--   1. 短信商密钥、Turnstile 密钥改为在后台填写，不再要求部署时配置
--   2. 管理员账号改为首次访问时创建（密码用 PBKDF2 存库）
--   3. Onbuka 等普通短信网关没有 OTP 接口，需要自己生成/校验验证码
-- ============================================================

-- 加密凭证表（短信商密钥、Turnstile Secret 等）
-- value 用 AES-GCM 加密存储，密钥由 Worker 内部派生，避免明文落库
CREATE TABLE IF NOT EXISTS secrets (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,          -- 密文（base64）
  iv         TEXT NOT NULL,          -- 初始化向量（base64）
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 管理员账号（首次访问 /admin 时创建）
CREATE TABLE IF NOT EXISTS admins (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,       -- PBKDF2-SHA256
  password_salt TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

-- 自建验证码通道（Onbuka 等）需要自己保存验证码
-- 存的是哈希而非明文，降低数据库泄露风险
ALTER TABLE verifications ADD COLUMN code_hash       TEXT;
ALTER TABLE verifications ADD COLUMN code_salt       TEXT;
ALTER TABLE verifications ADD COLUMN code_expires_at TEXT;
