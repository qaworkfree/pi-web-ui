# AMD Radeon Cloud TokenFactory 上游服务商评估

调研时间：2026-09-16。pi 上游基线：[`60e7e76`](https://github.com/earendil-works/pi/tree/60e7e76bd7ea25cad1dd6f3f1ce0d18814a42759)。仅使用 pi 上游仓库与 AMD 官方 Radeon Cloud 文档。

## 结论

**适合向 pi 提议，但不适合未经沟通直接提交拉取请求（Pull Request，PR）。** 技术兼容性较高：AMD 公共模型接口使用 OpenAI Chat Completions 协议、Bearer 密钥、服务器发送事件流，并支持工具调用。产品成熟度和维护成本则明显低于常规商业服务商：该接口被 AMD 定义为免费试用与开发服务、无服务等级协议、当前模型整体为实验性，目录及域名都可能变化。

建议先提交一页内的功能请求，说明愿意实现，并取得维护者回复中的 `lgtm` 后再开 PR。pi 明确要求核心保持精简，新贡献者的 Issue 和 PR 默认自动关闭；只有维护者给出 `lgtm` 才允许提交 PR。提交前还必须通过 `npm run check` 和 `./test.sh`，且不得编辑变更日志。[pi 贡献规则](https://github.com/earendil-works/pi/blob/60e7e76bd7ea25cad1dd6f3f1ce0d18814a42759/CONTRIBUTING.md#philosophy)

## 为什么技术上可行

- 公共基础地址目前是 `https://developer.amd.com.cn/radeon/api/v1`，认证使用 `Authorization: Bearer rc-...`。[接口概览](https://amd-aim.github.io/radeon-cloud-docs/api/overview/#base-urls)、[认证](https://amd-aim.github.io/radeon-cloud-docs/api/authentication/#api-keys)
- `POST /v1/chat/completions` 遵循 OpenAI Chat Completions 协议，支持流式响应、`tools`、`tool_choice`、`response_format` 与 `reasoning_effort`；当前模型均通过了函数工具调用测试。[聊天补全](https://amd-aim.github.io/radeon-cloud-docs/api/chat-completions/)、[模型能力](https://amd-aim.github.io/radeon-cloud-docs/models/overview/#structured-output-and-tools)
- pi 已有可复用的 `openai-completions` 适配器。NVIDIA 服务商就是一个简短的 `createProvider()` 工厂，组合基础地址、环境变量密钥、模型目录和该适配器。[NVIDIA 实现](https://github.com/earendil-works/pi/blob/60e7e76bd7ea25cad1dd6f3f1ce0d18814a42759/packages/ai/src/providers/nvidia.ts)
- pi 原生支持 `fetchModels` 动态目录、持久化缓存与刷新；这正好匹配 AMD 要求运行时调用 `GET /v1/models`、不要硬编码模型名称的约束。[pi 动态目录](https://github.com/earendil-works/pi/blob/60e7e76bd7ea25cad1dd6f3f1ce0d18814a42759/packages/ai/README.md#dynamic-model-lists)、[AMD 模型目录](https://amd-aim.github.io/radeon-cloud-docs/api/models/)

## PR 需要解决的关键问题

1. **目录必须动态获取。** AMD 明确说明模型会加入或退役；`GET /v1/models` 才是事实来源。该接口需要用户密钥，不能像部分公开目录那样在构建时无认证抓取。适合采用空或极小的静态基线，加 `fetchModels`，并使用 pi 的模型存储缓存。
2. **目录不是标准 OpenAI Model object。** 返回为 `{data:[...]}`，条目没有 `object`、`owned_by`、`created`，需要专用解析器。目录提供 `context_length`、模态、定价、能力和稳定性，但官方示例没有可靠的最大输出令牌字段；`Model.maxTokens` 的映射必须由实测或 AMD 明确资料支撑，不能猜测。[目录字段](https://amd-aim.github.io/radeon-cloud-docs/api/models/#fields)、[pi Model 类型](https://github.com/earendil-works/pi/blob/60e7e76bd7ea25cad1dd6f3f1ce0d18814a42759/packages/ai/src/types.ts#L845-L875)
3. **需要保守的兼容性标记。** 公共端点没有 Responses API；未列入白名单的参数会被静默丢弃。所有模型共同可用的消息形式是首条 `system`，不应默认发送 `developer`；输出上限字段应使用 `max_tokens`。流式用量、严格工具模式、缓存保留等能力应逐项验证后再开启。[接口范围](https://amd-aim.github.io/radeon-cloud-docs/api/overview/#public-free-model-apis)、[跨模型兼容建议](https://amd-aim.github.io/radeon-cloud-docs/models/overview/#writing-one-client-for-every-model)
4. **错误格式并不完全兼容 OpenAI。** 一部分限流和平台错误包在 `detail.error` 中，而非顶层 `error`；`429` 应遵守 `Retry-After`。应验证 pi 现有重试与错误展示是否足够，必要时仅做 AMD 范围内的规范化。[错误格式](https://amd-aim.github.io/radeon-cloud-docs/api/errors/#error-bodies)、[限流](https://amd-aim.github.io/radeon-cloud-docs/api/rate-limits/)
5. **地域与基础地址不能假定唯一。** 中国站和全球站的账户、密钥及额度不互通；AMD 还提醒部署主机名可能变化，应优先使用控制台提供的地址。内置服务商至少应允许覆盖基础地址，必要时区分区域服务商。[区域说明](https://amd-aim.github.io/radeon-cloud-docs/introduction/#two-sites-one-platform)、[基础地址说明](https://amd-aim.github.io/radeon-cloud-docs/api/overview/#base-urls)
6. **定位必须明确为实验用途。** AMD 条款称公共接口不适合生产，没有可用性或支持承诺，模型、端点和密钥可能少量通知或无通知地变更。模型参考还将当前模型整体标为 `experimental`。[接口条款](https://amd-aim.github.io/radeon-cloud-docs/api/terms/#not-for-production)、[稳定性](https://amd-aim.github.io/radeon-cloud-docs/models/overview/#true-for-every-model)
7. **用户必须自带且独占密钥。** 条款禁止共享、转让、转售密钥，也禁止通过代理向第三方提供服务。pi 的本地自带密钥模式符合该约束，但不得附带公共密钥或代理。[密钥与转售限制](https://amd-aim.github.io/radeon-cloud-docs/api/terms/#keys-and-accounts)

## 建议的上游实施范围

- 新增 `amd-radeon-cloud` 服务商工厂，使用 OpenAI Chat Completions 适配器、用户自带密钥、可覆盖基础地址。
- 从 AMD `/v1/models` 动态生成 pi `Model`，只暴露文本输入、文本输出且支持工具调用的模型；根据目录元数据设置图片、推理、上下文和费用能力。
- 为 AMD 端点设置经过验证的兼容性参数，并覆盖嵌套错误与动态目录解析测试。
- 注册到 `providers/all.ts`，补充 `/login` 环境变量、服务商文档和默认模型策略。pi 的新增服务商清单还要求更新流式、工具、令牌、取消、上下文溢出、跨服务商交接和认证等测试。[新增服务商清单](https://github.com/earendil-works/pi/blob/60e7e76bd7ea25cad1dd6f3f1ce0d18814a42759/packages/ai/README.md#adding-a-new-provider)

## 推荐推进顺序

1. 先用 `models.json` 或扩展做真实会话验证；pi 已把兼容 OpenAI 接口列为自定义服务商支持场景。[自定义服务商文档](https://github.com/earendil-works/pi/blob/60e7e76bd7ea25cad1dd6f3f1ce0d18814a42759/packages/coding-agent/docs/providers.md#custom-providers)
2. 准备简短 Issue：说明用户价值、OpenAI 兼容性、动态目录方案、实验性与区域限制，并声明愿意实现。
3. 等维护者明确回复 `lgtm` 后再开发和提交 PR；若维护者认为免费试用服务不应进入精简核心，则将同一实现发布为 pi 扩展。

最终判断：**值得提案，合并把握取决于维护者是否接受“实验性、动态目录、区域化的免费开发服务”进入核心。技术实现不是主要障碍；贡献门槛和长期维护承诺才是。**
