# Cider CC UwU :3

> A chill little relay between **Command Code** and the wider world of OpenAI / Anthropic clients.
> Pull up a stool, pick your pour, and let the models flow ~ UwU

Cider CC UwU is a single-file, zero-dependency reverse proxy. It takes the Command Code API and
serves it up as **OpenAI Chat Completions**, **Anthropic Messages** and **OpenAI Responses** endpoints,
so your favourite client can sip from a subscription that was never really meant to be this sociable. :3

It is a heavily patched fork of [MAXeaglet/commandcode-proxy](https://github.com/MAXeaglet/commandcode-proxy),
brewed over far too many late nights and with a healthy respect for other people's licences.

**Traditional Chinese documentation: [README.zh-TW.md](README.zh-TW.md)**

---

## The house specials

- **Three taps, one bar** — OpenAI `/v1/chat/completions`, Anthropic `/v1/messages`, OpenAI `/v1/responses`.
- **Streaming and non-streaming**, tool calling, multimodal image input, reasoning effort pass-through.
- **Tool bridge for the new Codex App** — namespace tools (`{"type":"namespace", ...}`) are expanded, and
  the `namespace` field is put back on the way out, so MCP tools and Computer Use actually run. OwO
- **Inline web tools** — when a client asks for `web_search`, the relay quietly pours `web_fetch` in as
  well, and executes both through Command Code's own routes. The model gets the internet; the client
  never sees the plumbing.
- **Incomplete-history repair** — a turn interrupted mid-tool no longer poisons the whole conversation.
- **Reasoning-effort clamp** — `ultra` becomes `max`, `minimal` becomes `low`, and the upstream stops sulking.
- **Image-aware tool results** — screenshots returned by tools are re-sent as proper images instead of a
  mountain of base64 that would otherwise blow up your context window.
- **Zero dependencies** — one `proxy.mjs`, Node 18+, no `npm install` required.
- **Privacy-minded logging** — no API keys, no error bodies, no stack traces in the log file.

## Quick start

```bash
git clone https://github.com/Cekxri/CiderCC-UwU.git
cd CiderCC-UwU
npm start        # config.json ships listening on http://0.0.0.0:3050
```

There is nothing to install. Your API key is never stored — you send it with each request and it goes
straight upstream.

```bash
curl http://127.0.0.1:3050/v1/chat/completions \
  -H "Authorization: Bearer user_your_key_here" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"hi"}]}'
```

Keys must start with `user_` (that is how the upstream identifies a CLI subscription key). The relay
plucks it out of `Authorization: Bearer <key>` or `x-api-key`, so both the OpenAI and Anthropic SDK
styles work without any extra fiddling.

**Windows friends:** `scripts/start.cmd` opens it in a console window, `scripts/start-background.cmd`
runs it quietly in the background (logs in `logs/`), and `scripts/stop.cmd` shuts it down again. All three
honour `PROXY_PORT` (default 3050): `set PROXY_PORT=13050` before starting moves the foreground,
background and stop scripts together.

The very first windowed launch asks which language the window should speak — English (UK) or
繁體中文（台灣）— and remembers the answer in `ui-language.txt` so it only ever asks once. The choice
only changes what the window prints: the log file always stays English (UK), and the background launcher
(no window) stays English (UK) as well. Delete `ui-language.txt` to be asked again.

## Configuration

`config.json` — the relay's little black book:

A `config.local.json` sitting next to it (git-ignored) is merged on top, so machine-specific settings never
have to touch the tracked file.

| Field | Default | Notes |
|---|---|---|
| `port` | `3000` (repo ships `3050`) | Listen port |
| `host` | `0.0.0.0` | Listen address. Use `127.0.0.1` if you only want it on this machine |
| `apiBase` | `https://api.commandcode.ai` | Upstream Command Code base URL |
| `projectSlug` | `cc-proxy` | Accepted for compatibility only — the relay deliberately sends a randomised slug per session to match the CLI handshake |
| `apiKey` | `""` | Optional fallback key. Leave empty and send the key per request instead |
| `logFile` | `""` | Log file path. Empty means console only |
| `logLevel` | `info` | Log verbosity: `error`, `warn`, `info` or `debug` |
| `useProviderModels` | `true` | Fetch the model list live from the provider API |
| `modelRefreshIntervalMs` | `300000` | Model-list cache lifetime (5 minutes) |
| `zdr` | `false` | Ask upstream for zero-data-retention routing |
| `emptySystemPlaceholder` | `true` | Send a single space when a request has no system prompt, so the upstream does not inject its ~7.5K-token default prompt (issue #17) |
| `updateFeed` | `""` | Optional URL serving this project's `package.json`; when its `version` is newer than the running one, the window prints an update nudge (no links, no names). Handiest in `config.local.json` |

Environment variables override the file, which is handy for Docker and for that one weird deployment:

| Variable | Overrides | Notes |
|---|---|---|
| `PORT` / `HOST` | `port` / `host` | |
| `CC_API_BASE` | `apiBase` | |
| `PROJECT_SLUG` | `projectSlug` | Accepted for compatibility; the slug sent upstream is randomised by design |
| `LOG_FILE` | `logFile` | |
| `CC_UI_LANG` | console language for the windowed launcher | `en-GB` (default) or `zh-TW`; normally picked once on first launch and remembered in `ui-language.txt`. The log file always stays English (UK) |
| `CC_COLOR` | console colours for the window | on by default in a real terminal — violet-led: deep-purple stamp, bright/light violet `info`, apricot/peach `warn`, warm coral `error`, dusty-rose JSON tail; `0` (or `NO_COLOR=1`) switches them off, `1` forces them on. Log files and redirected output are always plain text |
| `CC_UPDATE_FEED` | `updateFeed` | same URL as the config field, for when an env var is easier |
| `CC_USE_PROVIDER_MODELS` | `useProviderModels` | set to `false` to use the built-in list |
| `CC_STREAM_IDLE_MS` | streaming idle watchdog | default `30000`; raise it for slow reasoning models |
| `CC_NONSTREAM_IDLE_MS` | non-streaming idle watchdog | default `90000` |
| `CC_SESSION_TTL_MS` | upstream session lifetime | default `43200000` (12h); an empty stream cut rotates the session early, so this is only the ceiling |
| `CC_SESSION_JITTER_MS` | extra randomised session life | default `3600000` (up to 1h more) |
| `CC_MAX_BODY_MB` | request body cap | default `100` (MB) |
| `CC_MAX_INFLIGHT` | in-process concurrency cap | default `0` (unlimited) |
| `CMD_ZDR` | `zdr` | set to `1` to request ZDR routing |
| `CC_MAX_WEB_ROUNDS` | inline web-tool loop | default `3`, max `8` |
| `CC_SEND_NAMESPACE_FIELD` | namespace field in tool calls | default on; set to `0` if a future client stops wanting it |
| `CC_REJECT_NAMESPACE_TOOLS` | flat-tool fallback experiment | default off; set to `1` to refuse namespace tools |
| `CC_MAX_TOOL_OUTPUT_CHARS` | tool-output truncation | default `100000` characters |
| `CC_NAMESPACE_ALIAS_PROBE` | namespace alias probe | off by default; set to `1` to expose short / `ns__tool` / `ns::tool` aliases for diagnosis |
| `CC_ALIAS_PROBE_TOOL` | which tool the alias probe targets | default `list_threads` |
| `CC_EMPTY_SYSTEM_PLACEHOLDER` | space placeholder for empty system prompts | on by default; set to `false` to disable |
| `CC_CLIENT_DRAIN_TIMEOUT_MS` | stalled-client guard | unset by default; for example `60000` drops a client that stops draining |
| `CC_DEBUG_TOOLS` | tool-list debug log | set to `1` to write the received tool list to `tools-debug.log` |
| `CC_NATIVE_DELEGATION` | how an incoming cross-thread delegation is shaped | **on by default**: a matching `function_call` + `function_call_output` pair is synthesised, so the model sees native tool call/result semantics. Set to `0` for the user-message fallback (see [docs/tool-namespaces.md](docs/tool-namespaces.md)) |

## Endpoints

| Endpoint | What it is |
|---|---|
| `POST /v1/chat/completions` | OpenAI Chat Completions (streaming, tools, images, reasoning) |
| `POST /v1/messages` | Anthropic Messages (streaming, tool use, thinking budget mapping) |
| `POST /v1/responses` | OpenAI Responses (streaming, function calls, `namespace` tools, `input_image`) |
| `GET /v1/models` | Model list (live from the provider API, 5-minute cache) |
| `GET /health` | Returns `OK`. Your orchestration probe's new best friend |

### A tiny taster

```bash
curl http://127.0.0.1:3050/v1/responses \
  -H "Authorization: Bearer user_your_key_here" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek/deepseek-v4.1-flash","input":"just say okay","stream":true}'
```

```python
from openai import OpenAI

client = OpenAI(api_key="user_your_key_here", base_url="http://127.0.0.1:3050/v1")
for chunk in client.chat.completions.create(
    model="deepseek/deepseek-v4-flash",
    messages=[{"role": "user", "content": "hello"}],
    stream=True,
):
    print(chunk.choices[0].delta.content or "", end="")
```

```python
import anthropic

client = anthropic.Anthropic(api_key="user_your_key_here", base_url="http://127.0.0.1:3050")
message = client.messages.create(
    model="claude-sonnet-4-6", max_tokens=1000, messages=[{"role": "user", "content": "hello"}]
)
print(message.content[0].text)
```

Point Cursor (or any OpenAI-compatible tool) at `http://127.0.0.1:3050/v1` with the same key, and off you go.

## Models

`GET /v1/models` returns whatever the provider is currently offering, and falls back to a built-in list
when it cannot reach upstream. Common pours include:

| Model | House |
|---|---|
| `claude-sonnet-4-6`, `claude-opus-4-8`, `claude-haiku-4-5-20251001` | Anthropic |
| `gpt-5.5`, `gpt-5.4`, `gpt-5.3-codex` | OpenAI |
| `deepseek/deepseek-v4-pro`, `deepseek/deepseek-v4-flash` | DeepSeek |
| `moonshotai/Kimi-K2.6`, `zai-org/GLM-5.1`, `MiniMaxAI/MiniMax-M3` | assorted friends |
| `xiaomi/mimo-v2.5`, `google/gemini-3.5-flash` | the vision-capable lot |

Some models cannot see images at all — pick a vision model (for example `deepseek/deepseek-v4.1-flash`
or `xiaomi/mimo-v2.5`) before sending screenshots, or the poor thing will politely tell you there is no
image attached.

## The tool bridge (the interesting bit)

Modern Codex-App builds no longer send MCP and app tools as a flat list. They send them as namespaces:

```json
{"type":"namespace","name":"mcp__node_repl","tools":[{"name":"js","description":"...","parameters":{...}}]}
```

Two things then have to happen for those tools to actually run:

1. **Into the relay:** each sub-tool is expanded into a normal function tool, because the upstream only
   accepts flat, `[a-zA-Z0-9_-]`-safe names.
2. **Back out:** when the model calls one of them, the relay returns
   `{"name":"js","namespace":"mcp__node_repl", ...}` — the `namespace` field is what the client uses to
   find the actual executor. Miss it, and every tool answers `unsupported call` (ask us how we know).

The relay also normalises whichever shape the model happens to use (`js`, `ns::tool` or `ns__tool`), and
can flip either behaviour off with the environment switches listed above.

`web_search` and `web_fetch` are a slightly different story. Command Code's own web tools are
*client-executed* — the CLI is the thing that calls the search route — so the relay plays the part of the
CLI: it injects the tools, executes them against Command Code's `/alpha/web-search` and `/alpha/web-fetch`,
and feeds the results back to the model. More notes in [docs/tool-namespaces.md](docs/tool-namespaces.md).

## Docker

```bash
docker compose up -d                       # or: PROXY_PORT=13050 docker compose up -d
docker build -t cidercc-uwu:latest .         # if you prefer building by hand
```

The image is a slim `node:22-alpine`, listens on `3050`, and carries a healthcheck on `/health`.

## When things go sideways

| Symptom | Likely culprit | First thing to try |
|---|---|---|
| `error sending request` / connection refused | the relay is not running | start it, then check `http://127.0.0.1:3050/health` |
| Every tool answers `unsupported call` | client/tool-protocol mismatch | check `aliasProbe` and the tool-entry log lines; try `CC_SEND_NAMESPACE_FIELD=0` or `CC_REJECT_NAMESPACE_TOOLS=1` |
| `502 Tool results are missing` | history contains a tool call with no result (interrupted turn) | the relay repairs this automatically — if it persists, check the log for `Repaired incomplete tool history` |
| `429 Response timeout` on a thinking model | idle watchdog is too eager | raise `CC_STREAM_IDLE_MS` (try `300000`) |
| `maximum context length` | conversation genuinely got fat | lower the client's context window, or let it compact earlier |
| Images look invisible to the model | you picked a text-only model | switch to a vision model |
| Stale relay version still serving | an old process is holding the port | `scripts/stop.cmd` (it kills whatever owns port 3050), then start again |

## Known limitations

- **Unofficial.** This is a reverse-engineered client for a service that does not officially offer this
  sort of access. Command Code's own terms apply, and the upstream does actively detect plain proxies
  during a handshake — treat that as your risk to weigh, not a bug in the relay.
- `tool_search` is the client's own deferred-tool lookup, so it is not implemented here: the relay never
  defers tools, and if the app ever offers it the app is the one that executes it. See
  [docs/tool-namespaces.md](docs/tool-namespaces.md).
- The relay is stateless: `previous_response_id` is rejected on purpose, so send the full context each turn.
- Horizontal scaling needs sticky hashing on the API key — sessions and device fingerprints live per process.
- Memory grows with `body size × concurrency`; for public deployments cap bodies and connections at a
  reverse proxy (see the notes in the code).

## Privacy

- Your API key is never written to `config.json`, never logged, and never leaves your machine except as
  the upstream `Authorization` header.
- Set `apiKey` in `config.json` only if you really want a local fallback; leaving it empty is the polite
  default.
- Logs record tool names, sizes and status codes — not prompts, not keys, not error bodies.

## Credits

- **Original project:** [MAXeaglet/commandcode-proxy](https://github.com/MAXeaglet/commandcode-proxy) (MIT) —
  the relay started life there, and this fork keeps that licence and that debt.
- **Cider CC UwU patches:** tool-namespace bridge, inline web tools, image-aware tool results,
  reasoning-effort clamping, incomplete-history repair, and a pile of small robustness fixes.

## Licence

MIT — see [LICENSE](LICENSE). Pull up a stool, fork it, remix it. :3
