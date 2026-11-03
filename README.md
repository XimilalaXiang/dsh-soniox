# dsh-soniox

Native **BYOK** Soniox speech-to-text for DeepSeek Harness. Provider id: `soniox`.
It calls Soniox directly with your own `SONIOX_API_KEY` — no proxy, no gateway, no third-party
middleman, no runtime dependencies (standard library + global `fetch` only).

English | [中文](README.zh.md)

## Scope: STT only, and why

DSH's voice-input subsystem has a provider registry but **no speech-synthesis service** — the
service definition states plainly that "streaming recognition and speech synthesis have no
service methods" (`@deepseek-ai/dsh-experimental-speech-to-text`). A TTS half therefore has no
host slot to plug into, and this package does not invent one.

The sibling Hermes plugin ([hermes-soniox](https://github.com/XimilalaXiang/hermes-soniox))
ships both halves because Hermes has both provider slots. Here the STT half is a faithful port;
the TTS half has no counterpart in DSH today.

## Install

```bash
dsh plugin --profile <profile> add dsh-soniox
```

Then add the package to that profile's `bundles` list (`$DSH_HOME/profiles/<profile>/package.json`):

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-soniox"]
    }
  }
}
```

Restart the Host. The bundle patch mounts four rows: the voice-input service, its browser API, the
microphone UI, and the Soniox recognizer, with `defaultProvider: soniox` — so no model download
happens and nothing has to be selected by hand.

> **One bundle at a time.** These rows use the same ids as the official voice-input bundle. Enable
> either that bundle **or** this one; enabling both inserts each id twice and the loader rejects it.

Add the key to `$DSH_HOME/.env`:

```bash
SONIOX_API_KEY=your-soniox-key
```

It is also read from the Host credential store (any ref named `SONIOX_API_KEY`) and from `apiKeyFile`.
The key is sent only as an `Authorization: Bearer` header to `https://api.soniox.com`, is never
written to config or logs, and is redacted from every error message this package produces.

## Data path (what leaves your machine)

| Feature | Destination | Data sent |
|---|---|---|
| STT | `https://api.soniox.com/v1` (`/files`, `/transcriptions`) | the recording (16 kHz mono PCM16 WAV), language hints, optional context text |

Recording audio is uploaded, transcribed, and then **deleted** — on success, failure and cancellation
alike. Soniox's own retention and billing terms apply to anything you send.

## Configuration

Defaults, editable in the plugin's settings entry or directly in a profile patch:

```yaml
- id: dsh-soniox
  name: 'dsh-soniox'
  config:
    model: stt-async-v5      # stt-async-v6 also exists
    languageHints: zh,en     # optional; a bare ISO code list
    contextText: ""          # optional; sent as context.text
    apiKeyEnv: SONIOX_API_KEY
    pollTimeoutMs: 60000     # async job wait budget
```

- **Languages**: DSH validates the selected language against the provider's advertised list, so the
  default list is the subset of Soniox's 60+ languages exposed by the plugin plus `auto`. `auto` sends
  no hints at all, letting Soniox detect the language. `zh-CN` is reduced to `zh` — Soniox takes bare
  ISO codes.
- **Context text** is the equivalent of hermes-soniox's `stt.prompt`: it biases recognition toward
  names and jargon without changing the language.
- **Async, deliberately**: DSH hands a provider one *complete* recording, and Soniox's own guidance
  for a finished recording is the async file path. The realtime socket gives up full-context accuracy
  and bills stream duration. A 7.4-second Chinese clip round-trips in ~2.3 s end to end (see below).

## Testing

```bash
npm test          # 20 offline tests, mocked HTTP, no credentials
npm run live      # one real TTS -> STT round trip; needs SONIOX_API_KEY and ffmpeg
```

`npm run live` synthesizes Chinese speech with Soniox TTS, converts it to the exact container DSH
hands a provider (16 kHz mono PCM16 WAV), transcribes it through this package, then proves the remote
objects were deleted by re-reading them (expects HTTP 404).

## Troubleshooting

- *"Soniox API key is unavailable"* — set `SONIOX_API_KEY` in `$DSH_HOME/.env` and restart the Host.
- *HTTP 401* — wrong key. *HTTP 402* — Soniox balance exhausted. *HTTP 429* — rate/concurrency limit.
- *HTTP 400 / invalid_request* — model name or language hint not valid for that model.
  `curl -H "Authorization: Bearer $SONIOX_API_KEY" https://api.soniox.com/v1/models` lists them.
- *"transcription timed out"* — very long audio; raise `pollTimeoutMs`.
- Provider missing from the picker — check the Host log for `[dsh-soniox] registered`, confirm the
  bundle is in `bundles`, and that no other voice-input bundle is enabled.

## Uninstall

```bash
dsh plugin --profile <profile> remove dsh-soniox
```

Remove it from `bundles`, restart, and delete `SONIOX_API_KEY` if you no longer need it.

## License

MIT
