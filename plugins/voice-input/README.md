# 语音输入插件（voice-input）

输入框旁的 🎤 按钮：点一下说话，识别结果直接填入输入框草稿，你补一句再发送。

## 三条链路（自动降级）

1. **浏览器原生识别**（默认，免费零配置）：Chrome / Edge 用 Web Speech API 本地实时听写，中英文都可。
2. **本地 Whisper**（服务端，一键安装）：点 🎤 后浮层里的「一键安装本地 Whisper」，
   服务端自动装运行时 + 下载模型（base 约 290MB / tiny 约 150MB），以后录音不出本机、不要 key 也能转写。
   录音是浏览器现场编码的 16k 单声道 WAV（AudioWorklet），服务端无需装 ffmpeg。
3. **远端转写**（服务端，需配接口）：Firefox / Safari 等没有 Web Speech API，或识别出错时，
   录音 POST 到服务端的 `/plugins-api/voice-input/transcribe`，
   服务端转发给 OpenAI 兼容的 `/audio/transcriptions` 接口（Whisper）。

`auto` 模式（默认）：浏览器识别 → 本地 Whisper → 远端接口，依次降级。

## 安装

设置面板 → 界面插件 → 插件市场 → 找到「语音输入」点安装；或：

```bash
pi-web-ui install xing-shuyin/pi-web-ui/plugins/voice-input
```

`view: false`：没有独立视图 tab，只在输入框动作区多一个 🎤 按钮
（设置 → 界面布局里可隐藏/排序）。

## 配置（设置面板 → 界面插件 → 语音输入）

| 项             | 说明                                                                                   |
| -------------- | -------------------------------------------------------------------------------------- |
| 识别语言       | 默认 `zh-CN`；浏览器识别与 Whisper `language` 共用                                     |
| 服务端转写降级 | 默认开；关了之后浏览器识别失败就直接报错                                               |
| 转写引擎       | 默认 `auto`（本地优先、挂了切远端）；`local` 只用本地；`remote` 只用远端               |
| 本地模型       | 默认 `base`（中文更准，约 290MB）；`tiny` 更小更快（约 150MB）。转写时常驻内存约 1GB   |
| 转写接口基址   | OpenAI 兼容基址，如 `https://api.openai.com/v1`；留空 = 没配远端转写                   |
| 转写接口密钥   | 存在 `<dataDir>/plugins/voice-input/storage.json`，**不下发浏览器**                    |
| 转写模型       | 默认 `whisper-1`                                                                       |

本地模型文件放在 `<dataDir>/plugins/voice-input/whisper-cache/`（卸载插件即删除）；
设置面板目前没有按钮，**安装/卸载入口在 🎤 浮层里**（没装时会主动提示）。
卸载模型只删权重（`DELETE /plugins-api/voice-input/local`），运行时（node_modules）留着，重装秒级。

第三方兼容接口（本地 Whisper 服务、代理等）只要暴露
`POST {base}/audio/transcriptions`（multipart `file`/`model`/`language`）
就能用。

## Edge сpeech 识别失败排障

点了 🎤 没反应 / 直接报错，先对号入座（现在浮层会直接告诉你是哪一种）：

1. **页面是 `http://<局域网IP>:8787` 打开的**（最常见）：非安全上下文，Edge 直接禁用语音识别+麦克风。
   改用 `http://localhost:8787` 或 `http://127.0.0.1:8787` 打开。
2. **network 错误**：Edge 语音识别要联网，代理 / VPN / 公司网关可能拦了语音服务。
   插件会自动切服务端录音；网络修好前直接用服务端录音即可。
3. **not-allowed**：麦克风权限被拒。点地址栏左侧 🔒 图标 → 麦克风 → 允许 → 刷新页面。
4. **浏览器识别反复静默断句**：浮层里有「改用服务端录音」按钮，一键绕过。

以上都走不通（比如 Firefox / iOS Safari 根本没有语音识别）：浮层里的
「一键安装本地 Whisper」是最省事的路，不用买 key、不用配接口。

## 隐私

- 浏览器识别：音频留在本机与浏览器语音服务之间（Chrome 走 Google 服务），不经过 pi-web-ui 服务端。
- 本地 Whisper：音频不出本机，模型跑在服务端 CPU 上，不落盘（内存转写）。
- 远端转写：录音只转发到你自己配的转写接口，不落盘（内存转发，失败不留文件）。

## 兼容性

- 需要宿主 `window.__piWebUiHost.compose / onUiAction`（插件宿主 API v2+，
  manifest `apiVersion: 2` 会先拦住旧版 pi-web-ui）。
- 移动端：手机 Chrome 可用；iOS Safari 走服务端降级（需配转写接口 + 麦克风权限）。
