# pi-web-ui

[English](https://github.com/xing-shuyin/pi-web-ui/blob/main/README.md) | **简体中文**

[![npm 版本](https://img.shields.io/npm/v/pi-web-ui?color=cb3837&logo=npm)](https://www.npmjs.com/package/pi-web-ui)
[![Node.js](https://img.shields.io/node/v/pi-web-ui?logo=node.js&logoColor=white)](https://nodejs.org/)
[![许可证](https://img.shields.io/github/license/xing-shuyin/pi-web-ui)](LICENSE)

> 一个精致的 pi 浏览器界面：流式对话、查看工具调用、管理文件，
> 在一个工作台里完成开发任务。

[pi 编码智能体](https://pi.dev) 的 Web 聊天界面 —— 智能体通过 pi SDK 在服务端进程内运行，
事件经 WebSocket 流式推送到浏览器。支持思考块与工具调用、附件与图片问答、内置终端、
模型管理，以及设置面板（自定义系统提示词、技能/插件开关、设置预设一键应用）等功能。
需要 Node.js ≥ 22.19 及配置好的 pi 环境。

## 作者的其他项目

> **正在使用 DSH 构建工具？**
>
> [**dsh-ui-tools**](https://github.com/xing-shuyin/dsh-ui-tools) 是作者的配套项目，
> 用于在 DSH 生态中构建和扩展 UI 工具。

## 功能特性

**对话**

- WebSocket 流式聊天 —— pi SDK 在服务端进程内运行，事件以快照（60ms 节流）推送，浏览器按快照渲染。
- 思考块、工具调用卡片、bash 输出，实时显示状态（执行中 → 已结束 · 等模型 · 耗时）。
- **补充（steer）** —— 回复流式中可排队发送跟进消息，当前回合工具结算后立即注入（对应 pi CLI 的 Enter 打断语义）。
- **斜杠命令** —— 输入 `/` 弹出命令选择器（内置 / 扩展 / 模板 / 技能）；内置 `/new /model /compact /cwd /thinking /resume`，另有 `/help`（命令清单）与 `/copy`（复制上一条回复）。
- **每项目多对话并发** —— 每个对话独立 agent runtime，切走后仍在后台运行；「运行的对话」列表显示流式进度，可随时切回。
- **编辑重问** —— 把任意历史问题 fork 成新分支重新提问，原对话不受影响。
- 超过 30 条的消息自动折叠为摘要行（惰性渲染，点击展开）。
- 问题导航 —— 右侧浮动导航条 + 每个问题顶部的序号标签，一键跳转。

**文件、图片与附件**

- 三种附件模式：`inline`（≤12KB 内联）、`reference`（仅路径引用）、`lines`（选中行），超限自动降级。
- 粘贴 / 拖拽 / 上传图片 —— 浏览器端自动缩放，模型支持识图时作为图片内容发送（不支持时提示警告）。
- **视觉桥** —— 当前模型不支持识图时，把图片交给自动发现的视觉模型转写成文字证据（按批次缓存，可在设置里指定模型/开关）。
- 免工作区路径附加任意文件 —— 存入全局上传目录，小文件内联，其余以绝对路径引用。
- 文件预览 —— 行号、点选/拖拽/Shift 选区（可添加到对话为 lines 附件）、GBK 回退解码、二进制十六进制视图、媒体 HTTP 预览（支持 Range）、下载按钮。
- 实时文件树 —— 服务端对当前列出目录 fs.watch，改动即静默重列；超大目录显示截断提示。

**终端与 Git**

- 内置终端（xterm.js + node-pty），每客户端独立 PTY 管理；Windows 自动选择 Git Bash（busybox 兜底）。
- **源代码管理（Git）面板** —— 经隐藏查询终端展示 status / branch / diff / 未跟踪文件；提交、切换分支、推送、拉取复用可见终端并自动切换到终端视图。

**模型与设置**

- 模型管理 —— UI 里编辑 models.json、按 provider 设置 API key（密钥/headers 永不下发浏览器）。
- 主题切换 —— 顶栏选择主题；每个主题是完整独立的样式表（默认深色 + 内置亮色）。如何添加自定义主题或向仓库贡献主题，见 [主题](#主题)。
- 思考强度（thinking level）按模型切换（只显示该模型实际支持的档位）。
- 首次配置引导（PiSetupModal）。
- 设置面板 —— 系统提示词（追加或整体替换）、技能/插件一键开关（即时生效）、设置预设保存/应用/删除、视觉桥模型与开关。

**目标（Goal）模式**

- GoalBar 目标栏 —— 设置目标 + 审查模型 + 最大轮数 + 锁定开关。
- 目标调研向导（「AI 提炼」）—— 通过引导式问卷把原始需求收敛成明确目标。
- 自动审查循环 —— 每轮结束后用独立审查会话核对「目标 + 最终文本 + git diff HEAD」；不达标就把审查意见作为 steer 注入重改，直到通过或达到轮数上限。

**后台任务**

- 后台任务面板 —— 通过端口快照检测 agent 启动的服务（端口/pid/名称），可单独停止或全部关闭。
- 工具看门狗 —— 单个工具调用超过 20 分钟自动中断会话。
- **只停止 bash 命令** —— 中止运行中的 bash 工具而不打断对话。

**安全与运维**

- 默认只绑 loopback；局域网 / 容器需显式 `PI_WEB_HOST=0.0.0.0`。
- WebSocket Origin/Host 同权威校验 —— 跨源页面直接拒绝（403）；反代场景用 `PI_WEB_ALLOW_ORIGINS` 白名单。
- 本地控制 socket 提供 `server status|quiesce|unquiesce`（排空模式：拒绝新工作、存量跑完）。
- 凭据不下发浏览器 —— provider headers（可能含 Authorization/API key）永不发送到前端。
- 声音提醒、中英文界面、最近项目列表（点击即切换工作目录）。

**部署与更新**

- 前台运行 / 全局 npm 安装 / Docker（docker-compose）/ macOS launchd / Linux systemd / Windows 计划任务 / 桌面快捷方式（`server shortcut`）。
- 界面内自更新 —— 对比 npm registry 版本，安装后自动重启服务。

## 界面截图

![设置面板](https://raw.githubusercontent.com/xing-shuyin/pi-web-ui/main/assets/shot1.png)

![内置终端](https://raw.githubusercontent.com/xing-shuyin/pi-web-ui/main/assets/shot2.jpeg)

![对话界面](https://raw.githubusercontent.com/xing-shuyin/pi-web-ui/main/assets/shot3.jpeg)

![Git 源代码管理面板](https://raw.githubusercontent.com/xing-shuyin/pi-web-ui/main/assets/shot4.jpeg)

## 安装

```bash
npm i -g pi-web-ui            # 全局安装（推荐）
npx pi-web-ui                 # 或免安装直接跑（拉取最新版，启动在 :8787）
npm i -g .                    # 或安装本地 checkout
```

**npm ≥ 12？** npm 12+ 默认阻止依赖安装脚本（会看到 `npm warn install-scripts … blocked` 警告）。
node-pty 是原生模块，需要放行其脚本（其余两个包只是 no-op/纯提示，一并放行可消除警告）：

```bash
npm i -g --allow-scripts=node-pty,@google/genai,protobufjs pi-web-ui@latest
```

## 启动

```bash
pi-web-ui                                           # 前台，http://localhost:8787
PORT=9000 PI_WEB_CWD=/path/to/project pi-web-ui     # 自定义端口 / 工作目录
```

## 停止

- **前台**：在运行它的终端里按 `Ctrl+C`。
- **作为服务**：`pi-web-ui server stop`（停止实例；开机自启保留，直到 `server uninstall`）。

## 更新

```bash
npm i -g pi-web-ui@latest     # 升级到最新发布版本
pi-web-ui server restart      # 重启服务使新版本生效（前台运行则手动重启）
```

## 卸载

```bash
npm uninstall -g pi-web-ui
```

卸载**不会**删除你的聊天记录 —— 会话数据存放在 `<cwd>/.pi-web`（或 `PI_WEB_DATA_DIR`），
卸载/升级后依然保留。

## 作为系统服务（开机自启）

```bash
pi-web-ui server install --port 9000 --cwd /path/to/project   # 安装 + 启动
pi-web-ui server status                     # 运行中？开机自启？
pi-web-ui server restart                    # 重启（应用配置/版本变更）
pi-web-ui server stop                       # 停止（开机自启保留）
pi-web-ui server start                      # 再次启动
pi-web-ui server uninstall                  # 彻底移除服务
pi-web-ui server shortcut                   # 桌面一键启动图标
pi-web-ui server quiesce                    # 排空：拒绝新的对话/消息，存量运行继续跑完
pi-web-ui server unquiesce                  # 解除排空，恢复接收新工作
```

`server status` 还会经本地控制 socket 显示实时状态（版本、PID、排空状态、
浏览器连接数、运行中对话数）——`quiesce`/`unquiesce` 也走同一个 socket。

- **macOS** → launchd 代理（无需 sudo），日志 `/tmp/pi-web-ui.log` / `.err`
- **Linux** → systemd unit（`systemctl enable --now`），日志 `journalctl -u pi-web-ui -f`
- **Windows** → 计划任务（登录自启，隐藏 PowerShell 窗口，无黑窗）

选项：`--port`（默认 8787）、`--cwd`（工作目录）、`--data-dir`（会话目录）、
`--name`（自定义服务名）。重复执行 `server install` 并传入新选项即可重新生成配置
并重启服务 —— 这就是修改已装服务端口/工作目录的方式。

## 界面插件

插件是可选的界面组件（顶栏多出一个 tab，背后是插件自己的视图，可带服务端入口和 AI 工具）。
它们安装在**数据目录的 plugins 文件夹**（`<dataDir>/plugins/<id>/`，默认
`~/.pi-web/plugins/`）—— 一个插件就是一个目录：`manifest.json` + 可选服务端入口
（`index.mjs`）+ 可选视图入口（`client/entry.mjs`）。目录不存在 = 没有插件，界面上不会有任何痕迹。

### 插件目录

以下插件随本仓库发布（`dev/plugins/<id>/`），可直接从 GitHub 安装：

| 插件 | 功能 |
| --- | --- |
| 📬 [网页邮箱 webmail](https://github.com/xing-shuyin/pi-web-ui/tree/main/dev/plugins/webmail) | IMAP 收件箱浏览/搜索/阅读/标记/删除 + SMTP 发信、新邮件通知，可选「允许 AI 管理邮箱」（六个 `mail_*` AI 工具）。首次激活自动补装 npm 依赖。 |
| 🗄️ [数据库 db-client](https://github.com/xing-shuyin/pi-web-ui/tree/main/dev/plugins/db-client) | 数据库工作台：MySQL / PostgreSQL / SQLite / SQL Server / MongoDB / Redis 连接管理 + 库表树 —— 表结构、分页排序、SQL 编辑器、行编辑。驱动首次使用自动安装。 |
| 📝 [编辑器 + SSH vscode-editor](https://github.com/xing-shuyin/pi-web-ui/tree/main/dev/plugins/vscode-editor) | 类 VSCode 工作台：多根文件树（本地 + SSH 主机）、CodeMirror 多标签编辑器、Remote-SSH 远程文件浏览/编辑、可拖拽多终端面板（xterm.js）、SFTP 同步与下载到电脑。自动安装 `ssh2`。 |
| 📬 [示例邮箱 demo-mailbox](https://github.com/xing-shuyin/pi-web-ui/tree/main/dev/plugins/demo-mailbox) | 最小示例插件：演示服务端入口 + 客户端视图 + 双向消息协议，兼作测试夹具——想自己写插件从这里入手。 |

安装示例（网页邮箱）：

```bash
pi-web-ui install https://github.com/xing-shuyin/pi-web-ui/tree/main/dev/plugins/webmail
```

每个插件在仓库里的目录都带独立 `README.md`，含完整功能清单、配置说明与注意事项。

### 安装

从 GitHub 安装（支持以下任意源写法）：

```bash
pi-web-ui install owner/repo                                  # 简写
pi-web-ui install https://github.com/owner/repo               # 完整 URL（.git 可省）
pi-web-ui install https://github.com/o/r/tree/dev/sub/dir     # 指定分支 + 仓库内子目录
pi-web-ui install owner/repo#v1.2                             # 指定分支/tag（#后缀对以上任意写法都适用）
pi-web-ui install /path/to/plugin-dir                         # 本地目录直接安装（开发调试用）
```

常用选项：

- `--name <id>` —— 自定义插件 id / 目录名（默认取仓库名或子目录名；仅限字母数字-`-`/`_`）。
- `--force` —— 目标目录已存在时覆盖安装。插件本地的 `config.json`（凭据等）在升级时会原样保留。
- `--data-dir <dir>` —— 覆盖数据目录（默认 `~/.pi-web`）。

CLI 会浅克隆仓库（无 git 时回退 tarball 下载），定位其中的 `manifest.json`
（包括仓库内子目录里的），然后把插件拷贝到 `<dataDir>/plugins/<id>/`。

**没装 git？没有网络？** 直接把插件目录手工拷进 `~/.pi-web/plugins/` 也行——效果完全一样。

### 更新

对同一来源重新执行 `install` 并加 `--force` 即覆盖更新：

```bash
# 例：把网页邮箱插件更新到仓库里的最新版
pi-web-ui install https://github.com/xing-shuyin/pi-web-ui/tree/main/dev/plugins/webmail --force
```

- 升级时会自动保留插件目录里的 `config.json`（账号凭据等）。
- 存放在插件目录**其他位置**的本地数据不在保留范围内（如 db-client 的
  `db-connections.json`、vscode-editor 的 `ssh-hosts.json`）——强制重装前请先备份。
- 更新后刷新浏览器即可生效，无需重启服务。

### 生效方式

服务运行中只需**刷新浏览器**——新插件在 attach 时即被加载，无需重启；服务未运行则下次启动生效。
每个插件会在顶栏出现一个 tab（🧩 或插件自带图标）。

### 列出 / 停用 / 卸载

```bash
pi-web-ui plugins             # 列出已装插件（id / 名称 / 版本 / 描述）
pi-web-ui uninstall <id>      # 卸载插件
```

- 想临时隐藏某个插件而不卸载：设置面板（⚙）→「界面插件」开关即可——按客户端持久化、纯 UI
  隐藏，无需重启，随时可重新打开。
- `uninstall` 会删除插件目录；刷新浏览器后 tab 即消失。写在插件目录内的配置文件也会一并删除——
  如需保留请先备份 `<dataDir>/plugins/<id>/config.json`。

## 主题

每个主题是**一份完整独立的样式表** —— 即内置深色 `web/src/styles.css` 的整份副本，只是配色不同（不做 CSS 变量抽取、不需要引入基础文件）。切换主题就是整文件替换，因此任何主题都能在所有版本上工作。

内置主题随 npm 包分发（`themes/`，例如自带的亮色主题）。主题选择器在顶栏（🌞 图标），当前选择按浏览器存在 `localStorage`。

### 使用主题

在顶栏直接选择即可 —— 内置主题和用户主题合并显示在同一个菜单里；同名 id 时用户主题优先。

### 本地添加主题（无需 GitHub）

把任意 CSS 文件丢进**数据目录的 themes 文件夹**就会自动出现在主题菜单里 —— 不用重启、不用重新构建：

1. 找到数据目录（默认 `~/.pi-web`，可用 `PI_WEB_DATA_DIR` 覆盖）。
2. 创建 `<dataDir>/themes/` 并放入你的样式表，例如 `~/.pi-web/themes/my-theme.css`。
3. 刷新页面，在顶栏选择它。**文件名（去掉 `.css`）** 就是菜单里显示的主题 id。

```
~/.pi-web/
└── themes/
    └── my-theme.css          # 菜单里显示为 "my-theme"
```

最容易的写法：复制 `themes/light.css`（或源码仓库里内置的深色 `web/src/styles.css`），改 `:root` 颜色和必要的硬编码值即可 —— 文件必须**自包含**。注意：

- **终端跟随主题** —— 在你的 `:root` 里设置 `--term-*` 变量（终端 ANSI 配色 + `--term-bg`），xterm 画布和它的内边距容器都会自动适配（默认值见 `styles.css`，亮色值见 `themes/light.css`）。
- 代码高亮色（打包自带 `highlight.js` 的 `github-dark.css`）必须在你的主题文件里覆盖，否则代码会看不清 —— 参照 `themes/light.css` 末尾的 `.hljs` 覆盖写法。
- 主题 id 必须匹配 `^[A-Za-z0-9_-]+$`（不能有点和斜杠 —— 服务端有路径穿越防护）。

### 向仓库贡献主题（GitHub）

想让你的主题随包分发给所有人？在 [github.com/xing-shuyin/pi-web-ui](https://github.com/xing-shuyin/pi-web-ui) 开一个 Pull Request：

1. Fork 并 clone 仓库。
2. 创建 `themes/<id>.css` —— 一份**自包含**的样式表。以 `themes/light.css` 为模板（它是生成器产出的完整独立主题）。
3. 本地验证：运行 `npm run dev`，用顶栏主题选择器确认你的主题能被列出、渲染正确（对话卡片、代码块、工具调用卡片、Git/终端面板）。
4. 如果你只改了 `styles.css` 里的颜色、想让内置亮色主题同步更新，用 `node make-light-theme.mjs` 重新生成。
5. 提交（`git add themes/<id>.css`）并开 PR。`themes/` 已在 npm 包 `files` 白名单里，合并发布后 `npm i -g pi-web-ui` 即可把你的主题带给所有人。

合并主题的规则：必须是单一自包含 CSS 文件、是完整独立主题（不得 import 基础 `styles.css`）、保持 xterm 区域深色、覆盖 `.hljs` 语法高亮色以保证代码可读。

## 安全

- **默认只绑 loopback** —— 服务器只监听 `127.0.0.1`，不暴露到网络；需要局域网访问或
  Docker 端口映射时显式设置 `PI_WEB_HOST=0.0.0.0`（docker-compose.yml 已内置）。
- **WebSocket Origin 校验** —— 浏览器页面连 `/ws` 时其 Origin 的 hostname **和端口**
  必须与请求 Host 一致，跨源页面直接 403；无 Origin 的非浏览器客户端不受影响。
  反向代理场景可用 `PI_WEB_ALLOW_ORIGINS=http://你的域名:端口` 放行。
- **Quiesce 排空** —— `server quiesce` 后拒绝新的 prompt/编辑重问/会话恢复，存量运行
  跑完为止（升级/备份前用）；`server unquiesce` 恢复。
- **凭据不下发浏览器** —— provider 的 `headers`（可能含 Authorization / API key）
  永不发给浏览器；模型管理 UI 编辑其他字段，服务端自动保留 headers。

## 反向代理（nginx）

pi-web-ui 默认只绑 loopback，同机 nginx 反代是官方支持的远程访问方式（无需
`PI_WEB_HOST=0.0.0.0`）：

```nginx
# pi-web-ui 在 127.0.0.1:8787，对外暴露为 https://your-host/pi/
server {
    listen 443 ssl;
    server_name your-host;
    # ssl_certificate ... / ssl_certificate_key ...

    # 应用入口（剥掉 /pi/ 前缀）
    location /pi/ {
        proxy_pass http://127.0.0.1:8787/;
        proxy_http_version 1.1;
        # 必须用 $http_host（保留端口）—— 服务端的 Origin 校验比较完整权威
        # （hostname + 端口），$host 会丢掉端口导致 403
        proxy_set_header Host $http_host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # WebSocket —— 必须原样转发 Host，否则升级被 403（页面能开，
    # 但对话/终端一直重连）
    location /ws {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    # 构建产物的绝对路径资源/API（根路径，不带 /pi/）
    location /assets/  { proxy_pass http://127.0.0.1:8787; }
    location = /favicon.svg           { proxy_pass http://127.0.0.1:8787; }
    location = /favicon-streaming.svg { proxy_pass http://127.0.0.1:8787; }
    location = /api/file   { proxy_pass http://127.0.0.1:8787; }
    location = /api/health { proxy_pass http://127.0.0.1:8787; }
}
```

要点：

- **`Host` 必须用 `$http_host`**（保留端口），`/pi/` 和 `/ws` 都要 —— Origin 校验比较
  hostname **和**端口。`proxy_set_header Host $host` 或不设置（默认上游地址
  `127.0.0.1:8787`）都会 403。
- **同源自动通过**：只要浏览器 Origin 与转发后的 Host 一致（普通反代天然如此），
  就无需 `PI_WEB_ALLOW_ORIGINS`；仅当浏览器 Origin 与后端看到的 Host 不同
  （如 TLS 终止代理改了端口）才需要设置。
- **不要开 `proxy_protocol`**（除非确实要真实客户端 IP）：它会让 nginx 拒绝所有
  不带 PROXY 头的连接，局域网直连和 frp 以外的客户端全挂。用 frp 时同样去掉
  `transport.proxyProtocolVersion`（除非 nginx 也 listen proxy_protocol）。
- **局域网免代理访问**：直接设 `PI_WEB_HOST=0.0.0.0`（加防火墙规则），
  或把上面的 server 块放到 80/443 端口。

带 frp 内网穿透的完整可运行示例：`deploy/nginx-subpath.conf`。

## 参与贡献

pi-web-ui 是一个小型开源项目 —— **你的贡献就是它成长的力量**。代码、插件、主题、文档、翻译、想法，统统欢迎；每一个合并的 PR 都会随下一次 `npm publish` 送达所有用户。❤️

| 贡献方式 | 如何开始 |
| --- | --- |
| 🧩 **写插件** | 打造你自己的界面 tab + AI 工具。以 `dev/plugins/demo-mailbox` 为最小模板（它兼作测试夹具），本地开发后既可开 PR 收录进[插件目录](#插件目录)，也可独立发布。 |
| 🎨 **贡献主题** | 以 `themes/light.css` 为自包含模板，调整 `:root` 配色 + `--term-*` + `.hljs`，用 `npm run dev` 验证后开 PR —— 完整步骤见[向仓库贡献主题](#向仓库贡献主题github)。 |
| 💻 **修 bug / 加功能** | 在 [Issues](https://github.com/xing-shuyin/pi-web-ui/issues) 里挑一个，或提出新想法。Fork → 分支 → PR。代码约定见 `AGENTS.md`（Tab 缩进、i18n 双语 key、协议改动只动 `server/protocol.ts`）。 |
| 📖 **文档与翻译** | 完善 README、补插件文档、改错别字，或帮忙把界面/文档翻译成更多语言。 |
| 💡 **想法与反馈** | 在 [Issues](https://github.com/xing-shuyin/pi-web-ui/issues) 或 [Discussions](https://github.com/xing-shuyin/pi-web-ui/discussions) 里开帖 —— 功能建议、bug 报告、界面优化点子、部署经验分享都欢迎。 |

**开 PR 前**，快速自检能让维护者更省心：

- `npm run check:protocol` + `npm test` —— 协议同步与单元测试。
- `npm run typecheck` —— 无类型错误。
- `npm run build` —— 前后端都能编译。
- 涉及协议改动：`server/index.ts` 与 `web/src/use-chat.ts` 两端 dispatch 都要加分支（详见 `AGENTS.md`「协议单源」）。

> 喜欢 pi-web-ui？给仓库点个 ⭐，帮助更多人发现它。如果你在上面做了很酷的东西（插件、主题、部署方案），记得告诉我们 —— 我们乐于展示社区作品。

## License

MIT
