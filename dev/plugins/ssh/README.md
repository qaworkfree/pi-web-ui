# 🖥️ ssh —— pi-web-ui SSH 远程管理插件

通过 SSH 连接远程主机，像本地一样管理文件、运行命令、编辑文件。

## 功能

- **多主机管理**：侧栏主机列表（名称 / 用户@地址:端口 / 状态点），新建/编辑/删除；
  凭据只存本机插件目录（`ssh-hosts.json`，明文本机），界面回显脱敏（只报是否已设置）
- **远程终端**：xterm.js PTY，支持同时连接多台主机互不中断；窗口尺寸变化自动同步
- **文件管理**（SFTP）：路径栏直达/上级/刷新、新建文件夹与文件、重命名、删除（目录须为空）
- **远程编辑**：点击文本文件打开内嵌编辑器，Ctrl+S 保存回远端；二进制文件拒绝编辑
- **依赖自管**：`ssh2` 不随包分发，首次激活自动 npm 安装到插件目录（失败可在面板手动触发）

## 目录结构

```
ssh/
├── manifest.json        # 插件清单
├── index.mjs            # 服务端入口：连接池 / PTY 流转发 / exec / SFTP
├── src/client.js        # 客户端源码（xterm.js + 文件面板 + 编辑器）
├── build.mjs            # esbuild 打包（xterm CSS 内联）
├── package.json         # 构建依赖（仅本地构建/测试用）
└── client/entry.mjs     # 构建产物（自包含 bundle）
```

## 协议（plugin_message）

上行 `{ action, reqId?, ... }`：

| action | 参数 | 说明 |
| --- | --- | --- |
| `state` | — | 拉取状态（主机列表/连接列表/依赖状态） |
| `deps_install` | — | 手动触发 npm 安装 ssh2 |
| `hosts_save` | `host:{id?,name,host,port,username,password?,privateKey?}` | 新建/编辑；凭据留空=沿用旧值 |
| `hosts_delete` | `id` | 删除主机并断开其连接 |
| `connect` | `id` | 建立连接 → 异步回 `{connId,label}` |
| `disconnect` | `connId` | 断开 |
| `shell_open` | `connId, cols, rows` | 开 PTY → `{shellId}` |
| `shell_input` | `connId, shellId, b64` | 终端输入（无 reqId，不占响应协议） |
| `shell_resize` | `connId, shellId, cols, rows` | 窗口尺寸 |
| `shell_close` | `connId, shellId` | 关闭通道 |
| `exec` | `connId, cmd` | 单命令执行 → `{exitCode,output}`（256KB 截断） |
| `sftp_list/read/write/mkdir/rename/delete` | `connId, path, …` | SFTP 文件操作 |

下行事件（定向 sendTo 创建者）：`shell_data`(b64) / `shell_exit` / `conn_closed`。
广播 `{kind:"state", state}`：主机/连接列表变化时全量推送。

## 构建

```bash
cd dev/plugins/ssh && npm install && npm run build
```

## 测试

协议冒烟（零 token、自包含——内嵌 ssh2 Server 做 mock 远端，覆盖认证失败/
成功、PTY shell 输入输出、exec、SFTP 全操作）：

```bash
npm run build:server && node tests/ssh-plugin-test.mjs
```
