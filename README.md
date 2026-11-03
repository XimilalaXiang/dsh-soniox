# dsh-soniox

Native **BYOK** Soniox speech-to-text for DeepSeek Harness. Provider id: `soniox`.
It calls Soniox directly with your own `SONIOX_API_KEY` — no proxy, no gateway, no third-party
middleman, no runtime dependencies (standard library + global `fetch` only).

English | [中文](README.zh.md)

## What it does

| Half | Seam | Status |
|---|---|---|
| **STT** (`soniox`) | a real provider in `ctx.speechToText`; the microphone UI lists it | shipped |
| **TTS** | no service exists — this package mounts its own authenticated routes (`POST /api/dsh-soniox/speak`, `GET /api/dsh-soniox/audio`) plus an agent tool `speak` | shipped |
| Read-aloud button above each reply | a client UI bundle on `conversation.chat.assistant-actions` | next |

DSH's voice-input subsystem has a provider registry but **no speech-synthesis service** — the
service definition states plainly that "streaming recognition and speech synthesis have no
service methods" (`@deepseek-ai/dsh-experimental-speech-to-text`). A TTS half therefore has no
host slot to plug into, so it builds the same kind of seam the harness itself uses for
feature-owned downloads. The sibling Hermes plugin
([hermes-soniox](https://github.com/XimilalaXiang/hermes-soniox)) ships both halves through
Hermes' two provider slots; only the STT half has a counterpart here.

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

The voice-input packages are declared as *optional peers*, never dependencies: DSH supplies them from
its own runtime, so the versions always match the running harness. Shipping a copy would let pnpm
resolve a newer release and the version guard would then disable those rows entirely.

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
| TTS | `https://tts-rt.soniox.com/tts` | the text to speak, voice, model, language, audio format |

Recording audio is uploaded, transcribed, and then **deleted** — on success, failure and cancellation
alike. Synthesized audio stays on this machine; the text that produced it does not. Soniox's own
retention and billing terms apply to anything you send.

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

## Speech synthesis

```yaml
- id: dsh-soniox
  name: 'dsh-soniox'
  config:
    tts:
      enabled: true         # false installs only the recognizer
      voice: Meilin         # any name from GET /v1/tts-models
      language: zh
      model: tts-rt-v2
      format: mp3           # mp3 | wav | opus | flac | aac | pcm_s16le
      speakable: true       # strip markdown before speaking
      maxCharacters: 5000   # billed characters per request
      dataDir: ~/.dsh/dsh-soniox
```

Two surfaces, one pipeline:

- **Agent tool `speak`** — `speak({ text, voice?, format?, file? })` writes an audio file and returns
  its path. This is the path that also works headless, over Remote, and for any bot front end.
- **Host routes** — `POST /api/dsh-soniox/speak` returns `{ id, url, characters, cached }` and
  `GET /api/dsh-soniox/audio?id=...` serves the bytes with `Cache-Control: private, immutable,
  no-transform`, so a browser can point an `<audio>` element at it. Both are authenticated by the
  Host's own browser-session policy; only the owner peer reaches them.

Details that matter:

- **Cached by content.** The id hashes the text *and* every synthesis parameter, so replaying a reply,
  re-opening a session, or pressing a button twice never bills twice.
- **Markdown is normalized first.** Code fences, tables, links, `MEDIA:` paths, bare URLs and emoji
  are removed before synthesis (`speakable.mjs`) — speaking them raw is unusable. Set
  `speakable: false` to send the text verbatim.
- **No `speed` setting.** Soniox's REST schema accepts model, language, voice, audio_format, text,
  sample_rate and bitrate — there is no speed field, so nothing is clamped or forwarded (the Hermes
  plugin sent one; the API ignores it). Use `sampleRate`/`bitrate` instead.
- **Latency**: request/response synthesis of a 43-character Chinese line measured ~7.9 s wall time on
  this host, and 13 characters of WAV ~2.4 s. Per-sentence streaming is the next improvement; the
  cache keeps repeat playback instant.

## Testing

```bash
npm test              # 20 offline tests, mocked HTTP, no credentials
npm run live          # one real TTS -> STT round trip; needs SONIOX_API_KEY and ffmpeg
npm run live:tts      # real synthesis through the routes and the tool; needs SONIOX_API_KEY + ffprobe
npm run integration   # mounts into the real DSH speech service; needs SONIOX_API_KEY, ffmpeg, DSH
```

`npm run live` synthesizes Chinese speech with Soniox TTS, converts it to the exact container DSH
hands a provider (16 kHz mono PCM16 WAV), transcribes it through this package, then proves the remote
objects were deleted by re-reading them (expects HTTP 404).

`npm run integration` boots `@deepseek-ai/cordis` with the real
`@deepseek-ai/dsh-experimental-speech-to-text` service, mounts this plugin the way the Host does, and
asserts the provider roster, the language guard and one real `transcribe()` call through
`ctx.speechToText`. Point `DSH_ROOT` at your DSH runtime (default
`/home/ubuntu/apps/deepseek-harness`).

Measured on this host: a 7.4 s Chinese clip round-trips in ~2.3 s end to end
(`stt-async-v5`, upload + create + poll + transcript).

## Troubleshooting

- *"Soniox API key is unavailable"* — set `SONIOX_API_KEY` in `$DSH_HOME/.env` and restart the Host.
- *HTTP 401* — wrong key. *HTTP 402* — Soniox balance exhausted. *HTTP 429* — rate/concurrency limit.
- *HTTP 400 / invalid_request* — model name or language hint not valid for that model.
  `curl -H "Authorization: Bearer $SONIOX_API_KEY" https://api.soniox.com/v1/models` lists them.
- *"transcription timed out"* — very long audio; raise `pollTimeoutMs`.
- *"Soniox API key is unavailable"* from the routes or `speak` — same key, same fix as above.
- *HTTP 422 "nothing to speak"* — after markdown normalization the text held nothing pronounceable
  (an empty reply, or a pure code block / file-path message).
- *HTTP 413* — the request exceeds `tts.maxCharacters`; raise it deliberately, it is billed per
  character.
- Audio plays nothing in a browser — check the audio route's response headers include
  `content-type: audio/*`; a generic `application/octet-stream` is replaced by the requested format
  for exactly that reason.
- Provider missing from the picker — check the Host log for `[dsh-soniox] registered`, confirm the
  bundle is in `bundles`, and that no other voice-input bundle is enabled.

## Uninstall

```bash
dsh plugin --profile <profile> remove dsh-soniox
```

Remove it from `bundles`, restart, and delete `SONIOX_API_KEY` if you no longer need it.

## License

MIT
