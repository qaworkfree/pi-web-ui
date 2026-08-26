# 📝 vscode-editor —— pi-web-ui 编辑器 + SSH 插件（Remote-SSH）

在 pi-web-ui 界面里提供一个类 VSCode 的工作台视图：

- **多根文件树**：本地工作区 + 已保存的 SSH 主机（同一棵树、同一组标签页）
- **CodeMirror 6 多标签编辑器**：本地/远程文件同开，语法高亮、Ctrl+S 保存
  （远程文件经 SFTP 写回）、CRLF 行尾保留、Ctrl+P 快速打开（本地）
- **底部可拖拽终端面板**：每台已连接主机可开多个 shell（xterm.js），窗口
  尺寸同步、keepalive 保活；右键远端文件/文件夹可在所在目录打开终端
- **SFTP 同步**（☁ 菜单 + 右键菜单）：工作区整体上传/下载、文件夹/文件
  双向同步、保存自动上传（uploadOnSave）；配置存工作区 `.vscode/sftp.json`
  （vscode-sftp 兼容格式，可直接编辑该文件、Ctrl+S 即生效），ignore 为 glob 规则

原独立的 ssh 插件已合并进来：旧 `<pluginDir>/ssh-hosts.json` 主机配置在首次
激活时自动迁移，无需手工搬。

## 文件树交互

- **原地展开/收起**：点文件夹只加载该目录子列表（带「⏳ 加载中」占位），
  不整树重绘闪烁；收起零延迟
- **选中高亮**：点/右键任意行都高亮选中，工具栏 ＋📄/＋📁 以当前选中目录
  为落点（选文件则落在其所在文件夹）；新建成功后新条目成为选中项
- **右键菜单**：新建 / 重命名 / 删除 / 双向同步 / 打开终端（scope 感知）

## 统一范围模型

scope = `"local" | connId`。前端所有文件操作（list/read/write/create/rename/
delete）携带 scope，远程时自动附加 connId——服务端据此路由到本地 fs 或该
连接的 SFTP，前后端共用一套代码路径。

## 目录结构

```
vscode-editor/
├── manifest.json        # 插件清单（id/icon/name）
├── index.mjs            # 服务端入口：本地文件 CRUD / SFTP 同步（.vscode/sftp.json）/
│                        #   SSH 主机管理 + 连接池 + PTY shell + exec + 远程 SFTP 操作
├── src/client.js        # 客户端源码（CodeMirror 6 + xterm.js）
├── build.mjs            # esbuild 打包脚本（xterm CSS 内联为文本）
├── package.json         # 构建/依赖清单（ssh2 为 devDep，运行时由服务端自动补装）
└── client/entry.mjs     # 构建产物（自包含 bundle，浏览器直接加载）
```

## 安装

```bash
# 开发态（本仓库）：把插件拷到数据目录后刷新页面
cp -r dev/plugins/vscode-editor ~/.pi-web/plugins/
# Windows（Git Bash）同理；只需 manifest.json + index.mjs + client/ 三个部分，
# node_modules / src / build.mjs 不需要拷贝。

pi-web-ui install <github源>   # 或经 CLI 安装
```

刷新页面后顶栏出现 📝 标签即成功。依赖 ssh2 不随包分发，首次激活自动 npm
补装到插件目录（失败可点侧栏「⚠ssh2」按钮手动触发）。
