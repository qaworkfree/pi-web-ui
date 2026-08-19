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

## License

MIT
