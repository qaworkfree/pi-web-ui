# 部署

pi-web-ui 是纯 Web 服务（Node + Express + WebSocket），不再包含 Electron 桌面壳。

## CLI

```bash
pi-web-ui --port 9000 --cwd /path          # 前台
pi-web-ui install <源> [--name --force --data-dir]  # 安装 GitHub 界面插件到 <dataDir>/plugins/
#                                源: owner/repo · https://github.com/o/r[/tree/分支/子目录] · #分支 · 本地目录；刷新浏览器即生效
pi-web-ui plugins / uninstall <id>          # 列出 / 卸载界面插件
pi-web-ui plugins --check-updates          # 逐个对比远端 HEAD，列出可更新插件
pi-web-ui plugins --rollback <id>          # 回滚到最近一份更新前备份（<dataDir>/plugin-backups/）
pi-web-ui server install [--port --cwd --data-dir --name]   # 开机自启：
#                                           #   macOS→launchd（无需 sudo）
#                                           #   Linux→systemd（自动 sudo）
#                                           #   Windows→计划任务（登录自启，隐藏窗口无黑窗）
pi-web-ui server shortcut [--port --cwd --data-dir --name]  # 桌面「一键启动」图标（启动服务并打开浏览器）：
#                                           #   Windows→桌面 .lnk（WScript.Shell COM，OneDrive 安全；服务未运行则在本
#                                           #     隐藏窗口前台启动并记录 PID，server stop/uninstall 可止停）
#                                           #   macOS→桌面 .command 双击启动器（已装 launchd 则 kickstart，否则终端前台）
#                                           #   Linux→桌面 .desktop 图标 + ~/.local/share/pi-web-ui 启动脚本（systemctl 优先）
pi-web-ui server status|restart|stop|uninstall
# Docker：docker-compose.yml（端口映射 + 挂载数据目录）
```

> uninstall 会自动移除桌面图标；未装服务时桌面快捷方式启动的实例在 status/stop 中单独报告（PS1 前台+记录 PID）。
