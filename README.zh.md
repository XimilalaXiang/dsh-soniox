# dsh-soniox

DeepSeek Harness 的**原生 BYOK** Soniox 语音转文字（STT）插件，provider id 为 `soniox`。
直接用你自己的 `SONIOX_API_KEY` 调 Soniox 官方接口——没有代理、没有网关、没有第三方中转，
运行时零依赖（只用标准库和全局 `fetch`）。

[English](README.md) | 中文

## 为什么只有 STT

DSH 的语音输入子系统有 provider 注册表，但**没有语音合成服务**：服务定义里写得很明确——
"服务没有流式识别或语音合成方法"（`@deepseek-ai/dsh-experimental-speech-to-text`）。
也就是说 TTS 在 DSH 里没有宿主槽位可插，本包不会自己造一个。

姊妹项目 [hermes-soniox](https://github.com/XimilalaXiang/hermes-soniox) 两半都有，是因为
Hermes 两个 provider 槽位都存在。这里 STT 部分是忠实移植，TTS 部分在 DSH 暂无对应物。

## 安装

```bash
dsh plugin --profile <profile> add dsh-soniox
```

然后把包名加进该 profile 的 `bundles`（`$DSH_HOME/profiles/<profile>/package.json`）：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-soniox"]
    }
  }
}
```

重启 Host。bundle patch 会挂载四行：语音服务、浏览器 API、麦克风 UI、Soniox 识别器，
`defaultProvider: soniox` —— 不下载任何本地模型，也无需手动选择。

> **只能启用一个语音 bundle。** 这些 id 与官方 voice-input bundle 相同。官方 bundle 与本包
> 二者只启其一；同时启用会导致同一 id 被插入两次，加载器会直接拒绝。

把密钥写进 `$DSH_HOME/.env`：

```bash
SONIOX_API_KEY=your-soniox-key
```

也支持 Host 凭据库（任意命名为 `SONIOX_API_KEY` 的 ref）与 `apiKeyFile`。
密钥只以 `Authorization: Bearer` 头发给 `https://api.soniox.com`，不会写入配置或日志，
并且本包产生的所有错误信息都会把它打码。

## 数据去向

| 功能 | 目的地 | 发送内容 |
|---|---|---|
| STT | `https://api.soniox.com/v1`（`/files`、`/transcriptions`） | 录音（16 kHz 单声道 PCM16 WAV）、语言提示、可选上下文文本 |

录音上传并转写后会**被删除**——成功、失败、取消三条路径都删。Soniox 自身的留存与计费条款
适用于你发送的任何内容。

## 配置

默认值可在插件设置项或 profile patch 里改：

```yaml
- id: dsh-soniox
  name: 'dsh-soniox'
  config:
    model: stt-async-v5      # 也支持 stt-async-v6
    languageHints: zh,en     # 可选，裸 ISO 代码
    contextText: ""          # 可选，作为 context.text 发送
    apiKeyEnv: SONIOX_API_KEY
    pollTimeoutMs: 60000     # 异步任务等待上限
```

- **语言**：DSH 会用 provider 声明的语言列表校验用户选择，所以默认列表是 Soniox 60+ 语言中
  本插件暴露的子集，并始终包含 `auto`。`auto` 表示不发送任何提示，由 Soniox 自行检测；
  `zh-CN` 会被归一化为 `zh`（Soniox 只接受裸 ISO 代码）。
- **contextText** 相当于 hermes-soniox 的 `stt.prompt`：在不改变语言的前提下，把人名、术语
  等词汇偏置给识别模型。
- **刻意选择异步**：DSH 交给 provider 的是**一段完整录音**，Soniox 官方对完整录音的建议就是
  异步文件接口。实时 WebSocket 会牺牲全局上下文精度，且按流时长计费。实测一段 7.4 秒中文
  音频端到端约 2.3 秒（见下）。

## 测试

```bash
npm test              # 20 个离线测试，mock 掉 HTTP，不需要凭据
npm run live          # 真实跑一次 TTS -> STT 往返；需要 SONIOX_API_KEY 和 ffmpeg
npm run integration   # 挂进真实的 DSH 语音服务；需要 SONIOX_API_KEY、ffmpeg 和 DSH 运行时
```

`npm run live` 会用 Soniox TTS 合成中文语音，转成 DSH 交给 provider 的精确格式
（16 kHz 单声道 PCM16 WAV），经本包转写，然后**重新读取远端资源**证明已删除（应为 HTTP 404）。

`npm run integration` 会用 `@deepseek-ai/cordis` 启动真实的
`@deepseek-ai/dsh-experimental-speech-to-text` 服务，按 Host 的方式挂载本插件，断言 provider
名单、语言校验，并走一次真实的 `ctx.speechToText` 转写调用。`DSH_ROOT` 指向你的 DSH 运行时
（默认 `/home/ubuntu/apps/deepseek-harness`）。

本机实测：7.4 秒中文音频端到端约 2.3 秒（`stt-async-v5`，上传 + 建任务 + 轮询 + 取文本）。

## 排错

- *"Soniox API key is unavailable"* —— 在 `$DSH_HOME/.env` 里设置 `SONIOX_API_KEY` 并重启 Host。
- *HTTP 401* 密钥错误；*402* 余额不足；*429* 限流。
- *HTTP 400 / invalid_request* —— 模型名或语言提示对该模型非法。用
  `curl -H "Authorization: Bearer $SONIOX_API_KEY" https://api.soniox.com/v1/models` 查看。
- *"transcription timed out"* —— 音频过长，调大 `pollTimeoutMs`。
- 选择器里看不到 provider —— 查 Host 日志有无 `[dsh-soniox] registered`，确认包在 `bundles` 里，
  且没有同时启用另一个语音 bundle。

## 卸载

```bash
dsh plugin --profile <profile> remove dsh-soniox
```

从 `bundles` 中删除、重启，不再需要就删掉 `SONIOX_API_KEY`。

## 许可证

MIT
