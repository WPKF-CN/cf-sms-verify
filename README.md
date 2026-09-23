# SMS Verify — 手机号短信验证服务

给落地页加一道「人机检测 → 短信验证码 → 才跳转 WhatsApp」的关卡。
一个 Cloudflare Worker 同时提供：双短信通道（Twilio / Plivo）、频控、验证记录、免验证凭证、网页管理后台。

## 架构

```
落地页 ai/index.html
   │  点击 Join Group（原有 gotolink 被自动接管，页面代码零改动）
   ▼
弹窗组件 /w.js  ──►  Worker /api/send
   │                    ├─ Cloudflare Turnstile 人机检测（服务端校验）
   │                    ├─ 手机号归一化 + 国家白名单校验
   │                    ├─ 频控（号码/ IP / 全站）
   │                    └─ Twilio Verify 或 Plivo Verify 发码
   │                Worker /api/check
   │                    ├─ 校验验证码
   │                    └─ 通过 → 签发免验证凭证（默认 24h）
   ▼
验证码通过 → 跳转 WhatsApp（链接池可留在页面，也可由 Worker 下发）

D1 数据库：验证记录 + 配置 + 频控计数
后台 /admin：记录查询、CSV 导出、参数配置、测试发送
```

## 一、部署方式（三种任选，结果完全一样）

| 方式 | 适合场景 | 看哪份文档 |
|---|---|---|
| **一键部署按钮**（GitHub + Deploy to Cloudflare） | 交付给客户、或公开分享；自动建库建表绑定 | [一键部署说明.md](./一键部署说明.md) |
| **手动网页部署**（纯 Cloudflare 后台操作） | 不想连 GitHub、或要精细控制每一步 | [手动部署指南.md](./手动部署指南.md) |
| **命令行**（wrangler） | 自己用、或批量给多个客户部署 | 本文件下方 |

> 一键部署按钮最省事：客户点一下，Cloudflare 自动克隆仓库、创建 D1 数据库并回填 ID、
> 执行建表迁移、构建部署、完成绑定，全程不需要命令行。

---

## 一（备选）、命令行部署到 Cloudflare Workers（约 10 分钟）

前提：有一个 Cloudflare 账号（免费版即可）。

```bash
cd sms-verify/worker
npm install

# 1) 登录 Cloudflare（会打开浏览器授权，这一步必须你本人操作）
npx wrangler login

# 2) 一键初始化：建 D1 数据库 → 自动回填 database_id → 建表
npm run setup

# 3) 交互式配置密钥（后台密码自动转哈希、会话密钥自动生成，密码输入不回显）
npm run secrets

# 4) 部署（会自动先跑一遍配置自检，缺东西会拦下来）
npm run deploy
```

就这四条命令。几点说明：

- `npx wrangler login` 会打开浏览器授权（OAuth）。如果你**要给客户部署**，不建议走这条路：
  每次都要在浏览器点授权、还可能被本机代理拦截。给客户部署建议用**手动部署指南**，
  或者改用 Cloudflare API Token（`CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` 环境变量），
  wrangler 会自动走令牌认证、无需浏览器。

- `npm run setup` 免去了手工复制 database_id 的步骤；重复执行也安全（表结构是 `IF NOT EXISTS`）。
  如果用户主要在北美，可以指定数据库主区域：`WV_D1_LOCATION=enam npm run setup`
  （可选值 `wnam/enam/weur/eeur/apac/oc`，不填则用 Cloudflare 默认）。
- `npm run secrets` 里 Twilio 三项必须一起填才有用；Turnstile 和 Plivo 可以先跳过，之后再补跑一次。
  想手工设置也行：`npm run hash -- 你的密码` 然后 `npx wrangler secret put ADMIN_PASSWORD_HASH`。
- 想先看效果不部署：`npm run dev` 然后打开 `http://localhost:8787/demo`（本地是 mock 通道，验证码固定 `123456`，后台密码 `admin123`）。

部署成功后终端会打印 Worker 地址，例如 `https://sms-verify.<你的账号>.workers.dev`：

- 演示页：`https://.../demo`
- 管理后台：`https://.../admin`

建议的验收顺序：

1. 打开 `/admin` 用你刚设置的后台密码登录；
2. 「测试」页给自己的手机发一条，确认通道显示 `twilio` 且能收到短信；
3. 打开 `/demo` 走一遍完整流程；
4. 都正常后，把 Worker 地址填进落地页的 `apiBase`（见下一节）；
5. 回到后台把「允许的站点来源」从 `*` 改成你的实际域名。

可选：想用自己的域名（例如 `sms.你的域名.com`）而不是 `workers.dev`，在 `wrangler.toml` 末尾取消注释并修改：

```toml
[[routes]]
pattern = "sms.你的域名.com"
custom_domain = true
```

## 二、落地页接入（每页改 3 行）

在 `</body>` 前加：

```html
<script>
  window.SMS_VERIFY_CONFIG = {
    apiBase: 'https://sms-verify.<你的账号>.workers.dev',  // 必填
    site: 'ai-lander',        // 站点标识，用于后台区分来源
    failOpen: true,           // 后端异常时是否放行（默认 true，避免丢转化）
  };
</script>
<script src="https://sms-verify.<你的账号>.workers.dev/w.js" async></script>
```

就这样，**页面里原有的 30 个 `onclick="gotolink(nbgoto)"` 一行都不用改**：
组件会自动包装 `window.gotolink`，点击 → 弹窗 → 验证 → 跳转。

补充说明：

- `apiBase` 留空时脚本完全不接管页面行为（所以可以先加代码、之后再填地址）；
- 用户验证通过后默认 24 小时内免二次验证，直接跳转（可在后台把「免验时长」设为 0 关闭）；
- 想埋点/接 TikTok 像素，用事件回调即可：

```js
window.SMS_VERIFY_CONFIG.onEvent = function (name, detail) {
  if (name === 'sms:verified') ttq.track('SubmitForm');
  if (name === 'sms:redirect') ttq.track('Contact');
};
```

可用事件：`sms:modal_open`、`sms:sent`、`sms:verified`、`sms:redirect`、`sms:error`、`sms:grant_reused`。

## 三、人机检测（Cloudflare Turnstile，免费不限量）

1. Cloudflare 控制台 → Turnstile → Add widget（模式选 Managed）；
2. Hostnames 里填你所有落地页的域名（这是防止别人盗用你短信额度的第一道闸）；
3. Site Key 填到后台「配置 → 人机检测」，Secret Key 用
   `npx wrangler secret put TURNSTILE_SECRET` 写入。

Turnstile 免费版最多 20 个 widget、每个 widget 10 个域名，通常够用。

## 四、短信通道怎么选

| | Twilio Verify | Plivo Verify |
|---|---|---|
| 开通方式 | 自助注册，即时可用 | **需联系销售开通，自助不可用** |
| 门槛 | 无最低消费 | **最低月消费承诺 $1,000 起**（$10,000 档才覆盖需预注册的国家） |
| 费用（美国） | $0.05/成功验证 + 约 $0.0083/条短信 | 只收短信费（约 $0.0077/条），无验证服务费 |
| 美国 10DLC | 仅做用户验证时可免注册 | 免注册（用 Plivo 自己的 Sender ID） |
| 到达率口碑 | 最好 | 良好，自带免费 Fraud Shield |

建议：**先用 Twilio Verify 上线**（自助、即时可用、文档最全）；Plivo 的适配器已经写好，
等你申请下来、或用量涨到能覆盖 MMC 时，在后台把通道切成 `auto` 或 `plivo` 即可，代码无需改动。

Plivo 侧需要准备的三个值（拿到后执行 `wrangler secret put`）：
`PLIVO_AUTH_ID`、`PLIVO_AUTH_TOKEN`、`PLIVO_APP_UUID`（在 Plivo 控制台创建 Verify 应用后获得）。

## 五、后台功能（`/admin`）

- **概览**：30 天发送量、验证通过率、失败数、跳转数、近 1 小时量、按国家/通道/站点拆分、14 天趋势；
- **记录**：按手机号 / 状态 / 通道 / 站点 / 日期筛选，分页浏览，一键导出 CSV；
- **配置**（保存后约 10 秒对所有落地页生效，无需重新部署）：

  | 配置项 | 说明 |
  |---|---|
  | 允许的国家 | 勾一个国家 = 只允许该国；勾多个 = 多国放行；有预设按钮（仅美国 / 美加 / 英语区 / 欧美） |
  | 短信通道 | `auto`（按优先级容灾）/ 仅 Twilio / 仅 Plivo / mock |
  | 优先级 | auto 模式下的尝试顺序，前一个失败自动切下一个 |
  | 重发间隔 | 同一号码两次发送的最小间隔（默认 60 秒） |
  | 单号码每日上限 | 默认 5 次 |
  | 单 IP 每小时上限 | 默认 30 次 |
  | 全站每小时上限 | 默认 2000 次（熔断保护，防短信轰炸烧钱） |
  | 单次最多试错次数 | 默认 5 次，超过作废 |
  | 免验时长 | 验证通过后多少小时内免二次验证，0 = 每次都验证 |
  | 链接模式 | `client` 链接留在落地页 / `server` 验证通过后由 Worker 下发 |
  | 允许的站点来源 | 允许调用接口的域名白名单，`*` 表示不限制（**生产建议填具体域名**） |
  | 弹窗文案 | 标题、按钮、错误提示等，全部可在后台改 |

- **测试**：给任意号码发一条测试短信，直接看到走了哪个通道、失败原因是什么；同时显示各通道密钥是否已配置。

## 六、安全与防刷

1. 发短信前必须过 Turnstile（服务端校验 token，5 分钟有效、一次性）；
2. 四层频控：号码重发间隔 → 号码日上限 → IP 小时上限 → 全站小时上限；
3. 验证码校验在服务端完成，前端拿不到也无法伪造；验证码最多试错 5 次即作废；
4. 验证通过的凭证是服务端随机签发的一次性 token，存 D1，可随时在后台看到；
5. 后台密码只存 SHA-256 哈希，会话是 HMAC 签名 Cookie（12 小时过期），登录接口有 IP 限流；
6. 手机号等隐私数据只存在你自己的 D1 里（默认保留 180 天，定时任务自动清理，另有 `rate` 表 3 天清理）。

> 注意 `failOpen: true` 的取舍：后端完全挂掉时用户仍能跳到 WhatsApp（不丢转化），
> 代价是理论上有人可以通过屏蔽接口来绕过验证。若要严格拦截，把它设为 `false`。

## 七、成本参考

- Cloudflare：Turnstile 免费；Workers 免费额度通常够用（超出约 $5/月起）；D1 免费额度 5GB；
- 短信：美国约 $0.008（Plivo）～ $0.058（Twilio，含验证服务费）每次；欧洲各国约 $0.01–0.09；
- 举例：每月 1 万次验证 ≈ Plivo 约 $80–100，Twilio 约 $600。

## 八、排查

| 现象 | 排查方向 |
|---|---|
| 弹窗不出现 | `apiBase` 是否填对；浏览器控制台是否有 `/w.js` 404；`allowedOrigins` 是否包含该域名 |
| 提示「国家不支持」 | 后台「允许的国家」是否勾选；注意 +1 同时属于美国和加拿大，要按号码段区分（系统已区分） |
| 提示「人机检测失败」 | Turnstile widget 的 Hostnames 是否包含当前域名；Secret 是否写对 |
| 一直收不到短信 | 后台「测试」页发一条看错误原因；Twilio 试用账号只能发给已验证号码；确认目标国家是否在通道覆盖内 |
| 发送很慢 | auto 模式下第一个通道失败会等一次超时，可在后台改成固定通道 |

## 九、目录结构

```
sms-verify/
├── README.md
├── 一键部署说明.md              # GitHub + Deploy to Cloudflare 按钮（交付客户首选）
├── 手动部署指南.md              # 纯网页后台操作，不用命令行
└── worker/
    ├── wrangler.toml           # 绑定与 Text 内嵌规则
    ├── migrations/
    │   └── 0001_init.sql       # D1 建表脚本（部署时自动执行）
    ├── .dev.vars.example       # 声明需要哪些密钥（部署页面据此生成表单）
    ├── scripts/
    │   ├── setup.mjs            # 一键建库 + 回填 database_id + 建表
    │   ├── set-secrets.mjs      # 交互式配置密钥
    │   ├── check-config.mjs     # 部署前自检（deploy 自动触发）
    │   ├── build-single.mjs     # 打包成单文件（网页后台手动部署用）
    │   └── hash-password.mjs    # 单独算密码哈希
    └── src/
        ├── index.js            # 路由：公开 API + 后台 API
        ├── lib/
        │   ├── config.js       # 默认配置 + 国家元数据 + 读写
        │   ├── providers.js    # Twilio / Plivo / mock 适配层
        │   ├── db.js           # 记录、频控、统计、清理
        │   ├── auth.js         # 后台登录与会话
        │   ├── turnstile.js    # 人机检测服务端校验
        │   └── utils.js        # 响应、CORS、手机号归一化、加密
        ├── client/
        │   ├── widget.txt      # 弹窗组件（部署时按文本内嵌）
        │   └── demo.html       # 演示页 /demo
        └── admin/admin.html    # 后台页面 /admin
```
