# 部署

## 桌面版（Electron）

桌面版是 pi-web-ui 的 Electron 壳：**主进程 fork 一个隐藏子进程跑 server**（`ELECTRON_RUN_AS_NODE=1`，使用 Electron 内置 Node 运行时），**BrowserWindow 加载 `http://127.0.0.1:{PORT}`**。

```bash
npm run start:electron          # 启动 Electron 桌面版
npm run build:electron          # 构建当前平台安装包
npm run build:electron:mac      # macOS dmg
npm run build:electron:win      # Windows nsis
npm run build:electron:linux    # Linux AppImage/deb
npm run publish:electron        # 构建并上传到 GitHub Releases
```

### 架构要点

| 层 | 技术 |
| --- | --- |
| 主进程 | `electron/main.mjs`（~430 行）—— 启动 server、管理窗口/托盘/自动更新 |
| 子进程 | `dist/server/index.js`（`ELECTRON_RUN_AS_NODE=1`），**零改动跑现有 server** |
| 打包 | `electron-builder.yml` —— `extraResources` 把 `dist/`/`web/dist/`/`themes/`/`extensions/` 拷到 `resources/` |
| 原生模块 | `electron-builder install-app-deps` 自动 rebuild node-pty 为 Electron ABI（VS Code 同款方案） |
| 自动更新 | `electron-updater` + GitHub Releases（`publish:electron` 构建时自动上传 `latest.yml`） |

### 关键路径

- `server/index.ts` 的 `resolvePkgRoot` 已支持 `PI_WEB_PKG_ROOT` env var（Electron 主进程设置它指向 `process.resourcesPath`）
- `package.json` 的 `main` 已改为 `electron/main.mjs`（`npm start` 不受影响——仍直接跑 `node dist/server/index.js`）
- Node ≥22.19 要求：Electron 39+（Node 22.20）✅，当前最新 Electron 40+（Node 24）✅

### CI 发布

`.github/workflows/release-desktop.yml`：tag `v*` 推送时触发，三平台并行构建并上传到 GitHub Releases。签名/公证需在 GitHub Secrets 中配置（见文件头部注释）。

### 开发流程

```bash
npm run build          # 先构建 web + server（必须）
npm run start:electron # 启动 Electron（本地开发）
```

### 注意事项

- 每次 `npm run build` 后 `npm run start:electron` 才能加载最新代码
- 开发模式会自动打开 DevTools
- `electron-builder.yml` 的 `extraResources` 不会把文件打包进 asar——子进程通过 `process.resourcesPath` 访问它们
- 如需修改打包配置，改 `electron-builder.yml` 即可，无需动 Electron 主进程代码

## CLI

```bash
pi-web-ui --port 9000 --cwd /path          # 前台
pi-web-ui install <源> [--name --force --data-dir]  # 安装 GitHub 界面插件到 <dataDir>/plugins/
#                                源: owner/repo · https://github.com/o/r[/tree/分支/子目录] · #分支 · 本地目录；刷新浏览器即生效
pi-web-ui plugins / uninstall <id>          # 列出 / 卸载界面插件
pi-web-ui plugins --check-updates          # 逐个对比远端 HEAD，列出可更新插件
pi-web-ui plugins --rollback <id>          # 回滚到最近一份更新前备份（<dataDir>/plugin-backups/）
pi-web-ui server install [--port --cwd --data-dir --name]   # 开机自启：
                                           #   macOS→launchd（无需 sudo）
                                           #   Linux→systemd（自动 sudo）
                                           #   Windows→计划任务（登录自启，隐藏窗口无黑窗）
pi-web-ui server shortcut [--port --cwd --data-dir --name]  # 桌面「一键启动」图标（启动服务并打开浏览器）：
                                           #   Windows→桌面 .lnk（WScript.Shell COM，OneDrive 安全；服务未运行则在本
                                           #     隐藏窗口前台启动并记录 PID，server stop/uninstall 可止停）
                                           #   macOS→桌面 .command 双击启动器（已装 launchd 则 kickstart，否则终端前台）
                                           #   Linux→桌面 .desktop 图标 + ~/.local/share/pi-web-ui 启动脚本（systemctl 优先）
pi-web-ui server status|restart|stop|uninstall
# Docker：docker-compose.yml（端口映射 + 挂载数据目录）
```

> uninstall 会自动移除桌面图标；未装服务时桌面快捷方式启动的实例在 status/stop 中单独报告（PS1 前台+记录 PID）。