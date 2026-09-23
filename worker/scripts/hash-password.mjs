/**
 * 生成后台密码哈希：
 *   npm run hash -- 你的密码
 * 输出用 wrangler secret put ADMIN_PASSWORD_HASH 写入。
 */
import { createHash } from 'node:crypto';

const pwd = process.argv.slice(2).join(' ').trim();
if (!pwd) {
  console.error('用法: npm run hash -- <你的密码>');
  process.exit(1);
}
console.log(createHash('sha256').update(pwd).digest('hex'));
