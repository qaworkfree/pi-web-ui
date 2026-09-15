# 语音输入插件（voice-input）

输入框旁的 🎤 按钮：点一下说话，识别结果直接填入输入框草稿，你补一句再发送。

## 两条链路（自动降级）

1. **浏览器原生识别**（默认，免费零配置）：Chrome / Edge 用 Web Speech API 本地实时听写，中英文都可。
2. **服务端转写**（降级）：Firefox / Safari 等没有 Web Speech API，或识别出错（断网）时，
   插件录音并 POST 到服务端的 `/plugins-api/voice-input/transcribe`，
   服务端转发给 OpenAI 兼容的 `/audio/transcriptions` 接口（Whisper）。

## 安装

设置面板 → 界面插件 → 插件市场 → 找到「语音输入」点安装；或：

```bash
pi-web-ui install xing-shuyin/pi-web-ui/plugins/voice-input
```

`view: false`：没有独立视图 tab，只在输入框动作区多一个 🎤 按钮
（设置 → 界面布局里可隐藏/排序）。

## 配置（设置面板 → 界面插件 → 语音输入）

| 项             | 说明                                                                   |
| -------------- | ---------------------------------------------------------------------- |
| 识别语言       | 默认 `zh-CN`；浏览器识别与 Whisper `language` 共用                     |
| 服务端转写降级 | 默认开；关了之后浏览器识别失败就直接报错                               |
| 转写接口基址   | OpenAI 兼容基址，如 `https://api.openai.com/v1`；留空 = 没配服务端转写 |
| 转写接口密钥   | 存在 `<dataDir>/plugins/voice-input/storage.json`，**不下发浏览器**    |
| 转写模型       | 默认 `whisper-1`                                                       |

第三方兼容接口（本地 Whisper 服务、代理等）只要暴露
`POST {base}/audio/transcriptions`（multipart `file`/`model`/`language`）
就能用。

## 隐私

- 浏览器识别：音频留在本机与浏览器语音服务之间（Chrome 走 Google 服务），不经过 pi-web-ui 服务端。
- 服务端转写：录音只转发到你自己配的转写接口，不落盘（内存转发，失败不留文件）。

## 兼容性

- 需要宿主 `window.__piWebUiHost.compose / onUiAction`（插件宿主 API v2+，
  manifest `apiVersion: 2` 会先拦住旧版 pi-web-ui）。
- 移动端：手机 Chrome 可用；iOS Safari 走服务端降级（需配转写接口 + 麦克风权限）。
