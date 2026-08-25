# 📝 vscode-editor —— pi-web-ui 类 VSCode 编辑器插件

在 pi-web-ui 界面里提供一个轻量的代码编辑视图：左侧文件树、多标签页、
CodeMirror 6 语法高亮编辑器，支持 Ctrl+S 保存、Ctrl+P 快速打开、
右键新建/重命名/删除。纯界面插件，不注册 AI 工具。

## 目录结构

```
vscode-editor/
├── manifest.json        # 插件清单（id/icon/name）
├── index.mjs            # 服务端入口：文件树/读写/建删改名（路径越界防护）
├── src/client.js        # 客户端源码（CodeMirror 6）
├── build.mjs            # esbuild 打包脚本
├── package.json         # 构建依赖（仅本地构建用，不随插件分发）
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

刷新页面后顶栏出现 📝 标签即成功。

## 构建（改动客户端后）

```bash
cd dev/plugins/vscode-editor
npm install
npm run build        # src/client.js → client/entry.mjs
```

服务端 `index.mjs` 是免构建的纯 Node ESM，改完直接生效（需触发
`plugins_reload` 或重启服务重新激活）。

## 协议（plugin_message）

上行 `{ action, reqId, ... }`，下行 `{ res: true, reqId, ok, ... }`
定向回发起 socket：

| action | 参数 | 说明 |
| --- | --- | --- |
| `list` | `dir` | 单层目录列表（文件树惰性展开），跳过 node_modules/.git 等 |
| `flatlist` | — | 全仓扁平相对路径列表（Ctrl+P 数据源，8000 条/12 层上限） |
| `read` | `path` | 读文本（UTF-8→GBK 回退解码，2MB 上限）；二进制返回 `{binary:true}` |
| `write` | `path, text` | 原子写（tmp+rename），自动补父目录 |
| `create` | `path, kind:"file"\|"dir"` | 新建 |
| `rename` | `path, newName` | 同目录内重命名（名称禁含路径分隔符） |
| `delete` | `path` | 删除文件/目录 |

安全约定：所有 `path` 必须是相对**服务启动工作区**的路径，resolve 后越界
直接拒绝；符号链接不展开。

## 回归测试

```bash
npm run build:server && node tests/vscode-editor-plugin-test.mjs
```
