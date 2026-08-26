# 📬 webmail —— pi-web-ui 网页邮箱插件

在 pi-web-ui 界面里提供一个完整的邮箱管理视图（顶栏 📬 标签页）：
IMAP 收件 + SMTP 发信 + 新邮件通知，还可以把邮箱开放给 AI 直接管理。

## 功能

- **收件箱**：浏览 / 关键词搜索（主题、发件人、收件人）/ 阅读完整正文 /
  标记已读未读 / 删除邮件
- **发信**：SMTP 纯文本邮件，支持抄送
- **新邮件通知**：周期轮询 INBOX 未读数，发现新邮件经 `host.notify` 弹通知条
  （轮询间隔可配，默认 60s）
- **AI 管理邮箱**（默认关闭）：设置里打开「允许 AI 管理邮箱」后，注册六个
  AI 工具 —— `mail_list` / `mail_read` / `mail_search` / `mail_send` /
  `mail_manage` / `mail_folders`，对话里直接说「看看最近有什么邮件」即可；
  关闭即注销工具

## 配置

设置面板存 `<dataDir>/plugins/webmail/config.json`（明文本机，与 pi
auth.json 同级安全模型）：

| 字段 | 说明 |
| --- | --- |
| IMAP 主机 / 端口 / TLS | 收件服务器（如 imap.qq.com:993） |
| SMTP 主机 / 端口 / TLS | 发件服务器（如 smtp.qq.com:465） |
| 用户名 / 密码 | 邮箱账号与密码或授权码 |
| 轮询间隔 pollSec | 未读检查周期，默认 60s |
| 允许 AI 管理 aiEnabled | 注册/注销 AI 邮箱工具 |

配置回显脱敏：只返回 `hasPass` 是否存在，密码不回传浏览器。

## 安装 / 卸载 / 更新

```bash
# ── 安装 ──
pi-web-ui install https://github.com/xing-shuyin/pi-web-ui/tree/main/dev/plugins/webmail
pi-web-ui install dev/plugins/webmail        # 或本地目录（开发态）
# 可选：--data-dir <dir> 自定义数据目录（默认 ~/.pi-web）

# ── 查看 ──
pi-web-ui plugins                            # 列出已装插件与 id

# ── 更新 ──
pi-web-ui install https://github.com/xing-shuyin/pi-web-ui/tree/main/dev/plugins/webmail --force
                                             # --force 覆盖重装即更新
                                             # ⚠ 先备份插件目录里的 config.json（账号凭据）

cp -r dev/plugins/webmail ~/.pi-web/plugins/ # 本地开发态：直接拷贝覆盖
                                             # Windows: %USERPROFILE%\.pi-web\plugins\webmail

# ── 卸载 ──
pi-web-ui uninstall webmail                  # 移除插件目录（config.json 一并删除）
# 手动方式：rm -rf ~/.pi-web/plugins/webmail
```

刷新浏览器即生效。依赖 imapflow / mailparser / nodemailer **不随包分发**：
首次激活自动 npm 补装到插件目录，失败可在视图里点「安装依赖」手动触发。

## 回归测试

- `tests/unit/plugin-tools.test.ts`：同步 diff + 注册生命周期（vitest）
- `tests/scratch/webmail-e2e-test.mjs`：协议冒烟（清单/state 回显/save_config
  写盘/密码不回传）
- `tests/scratch/webmail-crash-test.mjs`：缺依赖时插件错误不炸主进程 +
  激活即自动补装
