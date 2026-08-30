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
#                                           #   Windows→登录自启 Run 键（HKCU，无需管理员；wscript 隐藏启动无黑窗）
pi-web-ui server shortcut [--port --cwd --data-dir --name]  # 桌面「一键启动」图标（启动服务并打开浏览器）：
#                                           #   Windows→桌面 .lnk（WScript.Shell COM，OneDrive 安全；服务未运行则在本
#                                           #     隐藏窗口前台启动并记录 PID，server stop/uninstall 可止停）
#                                           #   macOS→桌面 .command 双击启动器（已装 launchd 则 kickstart，否则终端前台）
#                                           #   Linux→桌面 .desktop 图标 + ~/.local/share/pi-web-ui 启动脚本（systemctl 优先）
pi-web-ui server status|restart|stop|uninstall
# Docker：docker-compose.yml（端口映射 + 挂载数据目录）
```

> Windows 自启服务 = HKCU 登录 Run 键 + wscript/VBS 隐藏启动器（生成在 `%APPDATA%\pi-web-ui\`，
> 无黑窗、无需管理员）；ps1 内置看门狗，服务器崩溃 10 秒后自动重启。旧版本的计划任务安装会在
> install 时自动迁移（删除任务，改用 Run 键）。服务安装未指定 --cwd 时默认以用户主目录为工作目录
> （前台启动仍默认当前目录）。

> uninstall 会自动移除桌面图标；未装服务时桌面快捷方式启动的实例在 status/stop 中单独报告（PS1 前台+记录 PID）。

## 子路径反代（nginx 挂在 /pi/ 等路径下）

页面挂在 `https://example.com/pi/` 而非根路径时，nginx 需要**剥离前缀**转发。
浏览器侧会自动从页面 baseURI 推导应用根（/pi/），插件 bundle、WebSocket、
`/api`、`/themes` 全部请求都会带上 `/pi/` 前缀，因此只需一条转发规则，无需
额外配置：

```nginx
server {
    listen 80;
    server_name example.com;

    # 关键是 proxy_pass 末尾的 /：剥离 /pi 前缀后透传给后端（8787 为默认端口）
    location /pi/ {
        proxy_pass http://127.0.0.1:8787/;
        proxy_http_version 1.1;
        # WebSocket 升级头必须透传
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        # 保持 Host/Origin 一致（服务端同源校验依赖它）
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

注意：

- 官方 dist 的静态资源是根绝对路径（`/assets/...`），与 JS 里的应用根推导无关。
  要让 HTML 在 /pi/ 下渲染，二选一：① 另加一条 `location /assets/ { proxy_pass
  http://127.0.0.1:8787; }` 转发静态资源；② 用 `vite build --base=/pi/` 重新构建
  （产物里 assets 引用与 `import.meta.env.BASE_URL` 均为 /pi/，与 baseURI 推导
  结果一致，两种方式可混用）。
- 插件目录（`<dataDir>/plugins/`）不需要在 nginx 单独配置——客户端请求
  `/pi/plugins/...`，剥离前缀后由后端标准路由处理。
