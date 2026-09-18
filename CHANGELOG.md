# Changelog :3

All the pours, in order. This project follows [Semantic Versioning](https://semver.org/).

**Traditional Chinese version: [CHANGELOG.zh-TW.md](CHANGELOG.zh-TW.md)**

## [Unreleased]

## [1.1.0] - 2026-09-19

### Added

- **A nudge when your copy goes stale.** Point `updateFeed` — tidiest in the git-ignored `config.local.json`,
  `CC_UPDATE_FEED` works too — at a URL that serves this project's `package.json`. If the feed's `version` is
  newer than the one running here, the window prints the two version numbers and suggests updating. The nudge
  deliberately carries no links and no project names.
- **The window got its bar lights on.** Console output is now colour-coded in a real terminal — a muted grey
  timestamp, a soft-violet `info` badge, amber `warn`, hot-pink `error`, the message in soft pink and the JSON
  tail dimmed — so a long log is readable at a glance. Log files and any redirected output stay plain text (no
  escape codes ever land on disk); `CC_COLOR=0` or `NO_COLOR=1` turns the colours off.
- **The window asks for its language on first launch.** The first windowed run of `scripts/start.cmd` offers
  English (UK) or 繁體中文（台灣）; the answer is remembered in `ui-language.txt` next to `config.json` and later
  launches skip the question. The choice only affects what the window prints — the log file always stays
  English (UK), and `scripts/start-background.cmd` has no window, so it stays English (UK) throughout.
  `CC_UI_LANG` (`en-GB` / `zh-TW`) overrides the remembered choice.

### Fixed

- **An empty stream cut no longer sticks to the same upstream session.** When the upstream accepted a request and
  then closed the stream without sending anything, every retry reused the same session — once that session had
  gone bad on the upstream side, the turn failed, the next turns failed too, and only the 12-hour session lapse
  brought relief. The relay now rotates to a fresh session the first time an empty stream is cut, remembers the
  rotation (including for conversations that pin their own session id or `prompt_cache_key`), and logs
  `rotatedSession` on the retry. `CC_SESSION_TTL_MS` / `CC_SESSION_JITTER_MS` let you shorten the normal session
  lifetime as well.
- **A mid-stream idle timeout now reaches the client as a real error.** The timeout path wrote the SSE `error`
  event and called `res.destroy()` in the same breath, which threw the event away — the client saw the stream
  stop with no reason at all (`curl`: `transfer closed with outstanding read data remaining`, zero error
  frames). All three streaming endpoints now end the response properly, so the reason arrives. Verified with a
  mock upstream that goes silent right after the first delta.
- **Idle keep-alive sockets are no longer closed after 5 seconds.** Node's default `keepAliveTimeout` is 5s; a
  desktop client reusing a pooled connection can race that close, and a POST is not retried automatically. The
  relay now keeps idle sockets for 65s (70s for headers) to stay clear of the race.
- **Streaming failures are reported as SSE, not as a JSON body.** When a streaming request ran into an upstream error
  (a 403, a zero-output reply, an idle timeout, a dropped connection), the relay used to answer with plain JSON; the
  client could only report the generic `stream disconnected before completion: stream closed before response.completed`
  and the real cause stayed hidden. Those paths now send an SSE `error` event carrying the upstream's own message.
  The upstream body is logged too, so `CC API error` finally shows *why* (for example the rate-limit text behind a 403).
- **A cut stream that produced nothing is no longer silent either.** The previous fix only spoke up when some text
  had already been streamed; if the upstream closed the connection before any text *or* tool call came through, the
  turn still ended with nothing on screen. The relay now counts the tool calls it emitted and answers that case with
  an `error` event too ("closed the stream before producing anything"). A normal stream emits no error — verified
  with a mock upstream in both directions.
- **Cross-thread delegation reaches the other model now.** A message sent with `send_message_to_thread`
- **A cut upstream stream is no longer reported as success.** The relay used to answer `response.completed`
  even when the upstream closed the stream without its terminal `finish` event, so a half-written answer
  arrived with no error at all. It now logs `Upstream stream ended without finish` and sends the client an
  `error` event once text has already been streamed, so the truncation is visible. The finish reason of
  every streamed turn (`stop`, `length`, …) is logged too.
- **Every launch leaves a log file.** `scripts/start.cmd` (the one people double-click) kept its output in the
  console window only, so the log vanished when the window closed; both launchers now default `LOG_FILE` to
  `logs/relay.log` unless you set one yourself.
- **Images and notes no longer split a tool-call group.** When one assistant turn called several tools and the
  app inserted an `<image_resize_notice>` (or an image itself) between the results, the upstream answered
  `Tool results are missing for tool calls ...` and the conversation wedged behind a 502. The relay now tracks
  the outstanding call ids of the current group and only releases held-back images and system/developer notes
  once every result has arrived. (Reproduced with a real 529-item history: 502 before, 200 after.)
- **Key fragments never reach the log.** The `Fingerprint generated for key` line printed the first eight
  characters of your API key; it now prints an irreversible short hash instead. The README already promised
  this — now the code keeps the promise.
- **`logLevel` filters for real.** It was accepted and documented but never read, so every level was written;
  `error`, `warn`, `info` and `debug` now behave as documented (default `info`), and the startup line reports
  the active level.
- **Config table tells the truth.** `emptySystemPlaceholder` was missing from the `config.json` table even
  though the code honours it, and `projectSlug` / `PROJECT_SLUG` now say what they are — accepted for
  compatibility, with the slug sent upstream randomised on purpose.
- **Changelog headings render again.** A missing blank line in both changelogs had glued the `1.0.0` heading
  onto the previous list item, so GitHub swallowed it.
- **The Windows banner follows the port.** `scripts/start.cmd` printed `3050` even when `PROXY_PORT` moved the
  relay elsewhere; it now shows the port actually in use.
- **Docs and packaging accuracy.** The Docker examples used an uppercase image tag (`CiderCC-UwU:latest`),
  which Docker rejects — they now use the lowercase `cidercc-uwu:latest`.
- **UK spelling everywhere.** Internal helpers `normalize*` are now `normalise*`, matching the project's
  English (UK) convention.
- **Traditional Chinese typo.** A stray simplified character in `README.zh-TW.md` is fixed.
- **Windows scripts behave as one set.** `scripts/start.cmd` and `scripts/start-background.cmd` now honour
  `PROXY_PORT`, matching `scripts/stop.cmd`, so all three move together when you pour onto another port.
- **`scripts/stop.cmd` follows your port.** It resolves the listening port from `PROXY_PORT`, then `PORT`,
  then `config.json`, instead of assuming 3050.
- **The background launcher hands off and returns.** `scripts/start-background.cmd` now exits cleanly once the
  detached node process owns the port, so the console comes straight back.

### Added

- **Upstream connection failures are retried.** A `fetch failed` (DNS, TLS or a dropped socket) now gets up to three
  attempts with a short backoff before the client ever hears about it, instead of surfacing as an error on the first
  blip. Verified with a mock upstream that destroys the first connection: the retry answers normally and the client
  sees no error.
- **Automatic recovery from a cut upstream stream.** When the upstream closes the stream without its `finish`
  event, the relay no longer hands the cut to the client: if nothing came through yet it retries the same request,
  and if part of the answer was already streamed it re-asks the model to carry on from the last character and
  stitches the two halves together. Two automatic attempts per turn, then the `error` event (from the previous
  fix) is used as the last resort. Verified with a mock upstream: empty cut → silent retry, partial cut → seamless
  continuation, permanent cut → error after two attempts.
- **Documents what the relay does *not* own.** `docs/tool-namespaces.md` now explains that `tool_search` is a
  client-side tool, that the relay keeps no tool list of its own (so future app tool changes pass straight
  through), and the three cases that *do* require a relay change.
- **Docker build in CI.** The workflow builds the image and polls `/health` inside the container, so the
  Dockerfile cannot rot unnoticed.

### Changed

- **Cut-stream recovery tries harder.** The upstream sometimes drops a request several times before it answers, so the
  recovery limit is now four attempts instead of two, with a short wait between them (0.9 s, 1.8 s, 2.7 s). The log also
  records how many input items the request carried, so cut patterns can be compared later. Verified with a mock upstream
  that cuts three times in a row: the fourth attempt answers and the client sees no error.

### Fixed

- **A failed turn now says why, before it ends.** The error event used to be appended *after* `response.completed`,
  which the client has already stopped reading — so a cut turn still looked like a silent stop. The error now comes
  first, the turn ends as `response.incomplete` (`upstream_closed`), and when an automatic recovery fails the upstream's
  own message is passed through: a spent plan now shows `You've reached your weekly usage limit for your plan. Your limit
  resets at …` instead of a generic line. Verified with a mock upstream that cuts the first call and answers 429 on the
  retry — event order is `error` then `response.incomplete` — while a healthy stream still ends with `response.completed`
  and no error at all.

### Added

- **`CC_NATIVE_DELEGATION` — choose how an incoming cross-thread delegation reaches the model.** The Codex App
  injects `send_message_to_thread` payloads as a standalone `function_call_output` with no `call_id` and no pairing
  `function_call` (`openai/codex#45227`, plus #41690 / #43515 / #41799), so the item cannot be forwarded as-is. The
  default keeps the relay’s existing behaviour (a user message, which is the shape OpenAI’s issue also proposes);
  setting the switch to `1` synthesises a matching `function_call` + `function_call_output` pair instead, so the
  upstream sees native tool call/result semantics. Both shapes were verified against a strict mock upstream: default
  produces `user / assistant / user`, native produces `user / assistant / assistant(tool-call) / tool(tool-result)`
  with the calls and results correctly paired.

### Changed

- **Native cross-thread delegation is now the default.** `CC_NATIVE_DELEGATION` no longer needs switching on: an
  incoming delegation is forwarded as the paired `function_call` + `function_call_output` it was meant to be, so the
  model sees native tool call/result semantics and the payload matches strict upstreams. Set `CC_NATIVE_DELEGATION=0`
  to fall back to the previous user-message form, which reads as a plain instruction.

### Fixed

- **Every injected delegation is recognised, not just one flavour.** The orphan-output detection only matched
  `send_message_to_thread` or a `<codex_delegation>` marker, so an injected `create_thread` / `handoff_thread` result
  without that marker was still dropped by the orphan repair. All three tool names are matched now.

## [1.0.0] — 2026-09-12

First public release of **Cider CC UwU**, a heavily patched fork of
[MAXeaglet/commandcode-proxy](https://github.com/MAXeaglet/commandcode-proxy).

### Added

- **Tool-namespace bridge.** Namespace tool declarations (`{"type":"namespace", ...}`) are expanded into
  flat function tools on the way up, and the `namespace` field is restored on the way back down, so MCP
  tools (and Computer Use via `node_repl`/`@oai/sky`) actually execute in modern Codex-App clients.
- **Inline `web_search` / `web_fetch`.** The relay injects both tools and executes them against Command
  Code's own `/alpha/web-search` and `/alpha/web-fetch` routes, then feeds the results back to the model.
  Loop depth is configurable via `CC_MAX_WEB_ROUNDS`.
- **Incomplete-history repair.** Tool calls with no matching result (interrupted turns) get a synthesised
  result, and orphaned tool results are dropped, so a poisoned conversation can continue.
- **Image-aware tool results.** Image payloads inside tool output are re-sent as proper images instead of
  pages of base64, keeping the context window sane.
- **Reasoning-effort clamping.** `ultra` → `max`, `minimal`/`none`/`off` → `low`, unknown values dropped.
- **Anthropic image support** on `/v1/messages` (base64 and URL sources, including images inside tool results).
- **`tool_choice: "none"` handling** that works with the upstream's stricter validation.
- **Runtime switches:** `CC_SEND_NAMESPACE_FIELD`, `CC_REJECT_NAMESPACE_TOOLS`, `CC_NAMESPACE_ALIAS_PROBE`,
  `CC_MAX_TOOL_OUTPUT_CHARS`, `CC_MAX_WEB_ROUNDS`.
- **Windows helper scripts** (`scripts/*.cmd`) with a port-owner-aware stop.
- **UK English + Traditional Chinese (Taiwan) documentation.**

### Fixed

- Oversized tool output no longer explodes the upstream context limit (truncation with a configurable cap).
- Image parts inside a multi-tool turn no longer split the tool-result group (which made the upstream
  answer `Tool results are missing for tool calls ...`).
- Context-limit errors that are only caused by the completion budget are retried once with a smaller
  `max_tokens` instead of failing outright.
- The stop script now kills whatever actually owns the port, rather than trusting a possibly stale PID file.

### Notes

- `tool_search` is intentionally not implemented; tools are exposed directly instead.
- The relay remains stateless — `previous_response_id` is rejected on purpose.

## [0.x] — legacy

Everything before this fork: the original `commandcode-proxy` by MAXeaglet. Thank you for the bar. UwU
