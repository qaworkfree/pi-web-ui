# 插件 SDK（starter）

`@pi-web-ui/plugin-sdk` 是写插件的**起手包**：`index.mjs`（零依赖纯 ESM，可直接拷进插件目录）+ `index.d.ts`（宿主接口精简类型，编辑器补全用）。

> 和 `server/plugins.ts` 的全量 `PluginHost` 是**同语义的精简版**：运行时以宿主实际注入为准，宿主版本见 `PLUGIN_API_VERSION`。SDK 只求“写得顺”，不做运行时 polyfill。

## 怎么用

1. 把 `index.mjs`（和要补全就把 `index.d.ts`）拷进你的插件目录（如 `my-plugin/sdk/`）；
2. 服务端入口：

```js
import { definePlugin, selectOptions } from "./sdk/index.mjs";

export default definePlugin({
	async activate(host) {
		const tone = String(host.getSettings().tone ?? "short");
		const off = host.ui.register({
			slot: "composer.actions",
			id: "tone",
			label: "语气",
			kind: "select",
			action: "my-plugin:tone",
			value: tone,
			options: selectOptions([
				{ value: "short", label: "简短" },
				{ value: "full", label: "详细" },
			]),
		});
		// 反激活时注销（可选，宿主也会统一清理）
		return;
	},
});
```

3. 客户端视图（`client/entry.mjs`）：

```js
import { defineView, onUiAction } from "./sdk/index.mjs";

export default defineView({
	mount(el, ctx) {
		const status = document.createElement("div");
		status.textContent = "就绪";
		el.appendChild(status);
		// 动作回调走宿主桥（client bundle 与宿主同页，window 直达），
		// 要落盘/跨端再经 ctx.send 发给服务端入口。
		return onUiAction("my-plugin:tone", (itemId, value) => {
			status.textContent = `语气：${value ?? ""}`;
			ctx.send({ action: "my-plugin:tone", value });
		});
	},
});
```

注意 `select` 的切换值是第二个参数：`onUiAction("my-plugin:tone", (itemId, value) => …)`。

## 本次 P0 新增速览

| 能力                                        | 服务端              | 视图                       |
| ------------------------------------------- | ------------------- | -------------------------- |
| `host.fs.stat/mkdir/append/glob`（+ `*Path` 跨目录版） | ✅                   | —                          |
| `kind: "select"` + `options` + `value`，`host.ui.update(id, { value })` 刷新 | ✅                   | 顶栏/输入框/消息工具条已渲染 |
| `when` 肯定形条件（`file.isDir` / `file.isFile` / `session.isRunning` / `message.hasSelection`） | — | 右键菜单现场求值，置灰 |
| `settings` 新增 `secret` 类型（加密存，浏览器只见有无） | ✅ | 设置表单掩码 + 留空不改 |
| `host.llm.complete`（孤立无工具补全，不建对话） | ✅（要 `llm` 能力族） | — |
| `schedule` 持久版（`{id, persistent, catchUp, label}`，落盘+补跑+进后台面板） | ✅ | — |
| `host.requestPermission`（动态授权：net 补主机 / llm 限模型，用户逐条确认可记住） | ✅（基础族须已声明） | 确认框 + 设置面板「已授权能力」 |

完整契约见 `docs/architecture-plugins.md`。
