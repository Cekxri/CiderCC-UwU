# Cider CC UwU :3

> 一座介於 **Command Code** 與 OpenAI／Anthropic 客戶端之間的小小 chill 轉接酒吧。
> 拉張高腳椅坐下，挑你要的那一杯，讓模型慢慢流出來 ~ UwU

Cider CC UwU 是一個單檔、零外部依賴的反向代理。它把 Command Code 的 API 端成
**OpenAI Chat Completions**、**Anthropic Messages** 與 **OpenAI Responses** 三種端點，
讓你的愛用客戶端能啜一口原本沒那麼好親近的訂閱服務。:3

它是 [MAXeaglet/commandcode-proxy](https://github.com/MAXeaglet/commandcode-proxy) 的重度修補分支，
用很多個深夜熬出來，並且好好尊重了別人的授權條款。

**English (UK) documentation: [README.md](README.md)**

---

## 招牌特調（功能）

- **三個酒頭、一間吧** — OpenAI `/v1/chat/completions`、Anthropic `/v1/messages`、OpenAI `/v1/responses`。
- **串流與非串流**、工具呼叫、多模態圖片輸入、思考等級（reasoning effort）直通。
- **新 Codex App 的工具橋接** — 遇到 namespace 工具（`{"type":"namespace", ...}`）會展開成扁平工具，
  回傳時再把 `namespace` 欄位補回去，MCP 工具與 Computer Use 才真的跑得起來。OwO
- **內建網路工具** — 客戶端只要了 `web_search`，代理會順手把 `web_fetch` 也倒進去，兩者都由代理
  透過 Command Code 自己的 route 執行。模型上網，客戶端完全看不到管路。
- **殘缺歷史自動修補** — 中途被打斷的回合不再把整個對話毒死。
- **思考等級收斂** — `ultra` 變 `max`、`minimal` 變 `low`，上游就不會再鬧脾氣。
- **工具輸出裡的圖片** — 截圖會被轉成真正的圖片重送，而不是一大坨 base64 把上下文炸掉。
- **零外部依賴** — 就一個 `proxy.mjs`，Node 18+，不用 `npm install`。
- **對隱私友善的日誌** — 不記金鑰、不記錯誤內容、不記 stack trace。

## 快速開始

```bash
git clone https://github.com/Cekxri/CiderCC-UwU.git
cd CiderCC-UwU
npm start        # 專案附的 config.json 會聽 http://0.0.0.0:3050
```

不用安裝任何東西。金鑰不會被存起來——每次請求自己帶，直接透傳上游。

```bash
curl http://127.0.0.1:3050/v1/chat/completions \
  -H "Authorization: Bearer user_你的金鑰" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"嗨"}]}'
```

金鑰必須以 `user_` 開頭（上游就是靠這個認 CLI 訂閱）。代理會自己從
`Authorization: Bearer <key>` 或 `x-api-key` 撈出來，所以 OpenAI 與 Anthropic 兩種 SDK 風格都能直接用。

**Windows 的朋友：**`scripts/start.cmd` 會在視窗裡開起來、`scripts/start-background.cmd` 會安靜地在背景跑
（日誌放在 `logs/`）、`scripts/stop.cmd` 負責收攤。三個腳本都認 `PROXY_PORT`（預設 3050）：啟動前 `set PROXY_PORT=13050`，
前景、背景與停止會一起換到別的埠。

第一次用視窗版啟動時會問你視窗要說哪種語言——English (UK) 或 繁體中文（台灣）——答案記在
`ui-language.txt`，之後就不再問。這個選擇只影響視窗印出的內容：日誌檔一律英文（UK），背景版（沒有視窗）
也維持英文（UK）。想重新選，把 `ui-language.txt` 刪掉再開就好。

## 設定

`config.json` —— 這間吧的小帳本：

| 欄位 | 預設 | 說明 |
|---|---|---|
| `port` | `3000`（專案附 `3050`） | 監聽埠 |
| `host` | `0.0.0.0` | 監聽位址。只想本機用就改 `127.0.0.1` |
| `apiBase` | `https://api.commandcode.ai` | 上游 Command Code 網址 |
| `projectSlug` | `cc-proxy` | 只為相容而保留 —— 代理故意每次 session 送一個隨機化的 slug，用來對上 CLI 的 handshake |
| `apiKey` | `""` | 選用的本機備援金鑰；留空、改用「每次請求帶」最乾淨 |
| `logFile` | `""` | 日誌檔路徑；留空就只輸出到主控台 |
| `logLevel` | `info` | 日誌等級：`error`、`warn`、`info`、`debug` |
| `useProviderModels` | `true` | 是否向上游動態抓模型清單 |
| `modelRefreshIntervalMs` | `300000` | 模型清單快取時間（5 分鐘） |
| `zdr` | `false` | 向上游要求零資料留存（ZDR）路由 |
| `emptySystemPlaceholder` | `true` | 請求沒有 system prompt 時送一個空格，避免上游注入它自己 ~7.5K token 的預設提示詞（issue #17） |

環境變數會覆蓋檔案設定，Docker 或特殊部署特別好用：

| 變數 | 覆蓋 | 說明 |
|---|---|---|
| `PORT` / `HOST` | `port` / `host` | |
| `CC_API_BASE` | `apiBase` | |
| `PROJECT_SLUG` | `projectSlug` | 只為相容而保留；送上上游的 slug 是刻意隨機化的 |
| `LOG_FILE` | `logFile` | |
| `CC_UI_LANG` | 視窗啟動器的介面語言 | `en-GB`（預設）或 `zh-TW`；正常會在首次啟動時選一次並記在 `ui-language.txt`。日誌檔一律英文（UK） |
| `CC_USE_PROVIDER_MODELS` | `useProviderModels` | 設 `false` 用內建清單 |
| `CC_STREAM_IDLE_MS` | 串流閒置看門狗 | 預設 `30000`；推理模型請調大 |
| `CC_NONSTREAM_IDLE_MS` | 非串流閒置看門狗 | 預設 `90000` |
| `CC_SESSION_TTL_MS` | 上游 session 存活時間 | 預設 `43200000`（12 小時）；零位元組斷流時代理會提前換一條，所以這只是上限 |
| `CC_SESSION_JITTER_MS` | session 額外隨機壽命 | 預設 `3600000`（最多再多 1 小時） |
| `CC_MAX_BODY_MB` | 請求體上限 | 預設 `100`（MB） |
| `CC_MAX_INFLIGHT` | 單進程併發上限 | 預設 `0`（不限） |
| `CMD_ZDR` | `zdr` | 設 `1` 要求 ZDR |
| `CC_MAX_WEB_ROUNDS` | 內建網路工具迴圈 | 預設 `3`，最多 `8` |
| `CC_SEND_NAMESPACE_FIELD` | 工具呼叫的 namespace 欄位 | 預設開；未來客戶端不用了可設 `0` |
| `CC_REJECT_NAMESPACE_TOOLS` | 強制退回扁平工具（實驗） | 預設關；設 `1` 會拒絕 namespace 工具 |
| `CC_MAX_TOOL_OUTPUT_CHARS` | 工具輸出截斷長度 | 預設 `100000` 字元 |
| `CC_NAMESPACE_ALIAS_PROBE` | namespace 別名探針 | 預設關；設 `1` 會多暴露短名／`ns__tool`／`ns::tool` 三種別名（診斷用） |
| `CC_ALIAS_PROBE_TOOL` | 探針針對哪個工具 | 預設 `list_threads` |
| `CC_EMPTY_SYSTEM_PLACEHOLDER` | 空 system prompt 的空格佔位 | 預設開；設 `false` 關閉 |
| `CC_CLIENT_DRAIN_TIMEOUT_MS` | 僵死客戶端保護 | 預設未設；例如 `60000` 會丟掉停止讀取的卡住客戶端 |
| `CC_DEBUG_TOOLS` | 工具清單除錯日誌 | 設 `1` 會把收到的工具清單寫進 `tools-debug.log` |
| `CC_NATIVE_DELEGATION` | 進來的跨對話委派要用哪種形狀 | **預設開啟**：補一組配對的 `function_call` + `function_call_output`，讓模型看到原生 tool call/result 語意。設 `0` 可退回使用者訊息模式（詳見 [docs/tool-namespaces.md](docs/tool-namespaces.md)） |

## 端點

| 端點 | 內容 |
|---|---|
| `POST /v1/chat/completions` | OpenAI Chat Completions（串流、工具、圖片、思考等級） |
| `POST /v1/messages` | Anthropic Messages（串流、tool use、thinking budget 對應） |
| `POST /v1/responses` | OpenAI Responses（串流、function call、namespace 工具、`input_image`） |
| `GET /v1/models` | 模型清單（動態抓取，快取 5 分鐘） |
| `GET /health` | 回 `OK`，探活與編排器的好朋友 |

### 小小試喝

```bash
curl http://127.0.0.1:3050/v1/responses \
  -H "Authorization: Bearer user_你的金鑰" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek/deepseek-v4.1-flash","input":"say okay","stream":true}'
```

```python
from openai import OpenAI

client = OpenAI(api_key="user_你的金鑰", base_url="http://127.0.0.1:3050/v1")
for chunk in client.chat.completions.create(
    model="deepseek/deepseek-v4-flash",
    messages=[{"role": "user", "content": "你好"}],
    stream=True,
):
    print(chunk.choices[0].delta.content or "", end="")
```

```python
import anthropic

client = anthropic.Anthropic(api_key="user_你的金鑰", base_url="http://127.0.0.1:3050")
message = client.messages.create(
    model="claude-sonnet-4-6", max_tokens=1000, messages=[{"role": "user", "content": "你好"}]
)
print(message.content[0].text)
```

Cursor（或任何 OpenAI 相容工具）填 `http://127.0.0.1:3050/v1` 加上同一把金鑰就能上工。

## 模型

`GET /v1/models` 會回傳上游當下提供的清單，抓不到時會退回內建清單。常見的幾款：

| 模型 | 產地 |
|---|---|
| `claude-sonnet-4-6`、`claude-opus-4-8`、`claude-haiku-4-5-20251001` | Anthropic |
| `gpt-5.5`、`gpt-5.4`、`gpt-5.3-codex` | OpenAI |
| `deepseek/deepseek-v4-pro`、`deepseek/deepseek-v4-flash` | DeepSeek |
| `moonshotai/Kimi-K2.6`、`zai-org/GLM-5.1`、`MiniMaxAI/MiniMax-M3` | 各路好友 |
| `xiaomi/mimo-v2.5`、`google/gemini-3.5-flash` | 看得見圖的那些 |

有些模型完全看不到圖片——要傳截圖請挑有視覺能力的（例如 `deepseek/deepseek-v4.1-flash` 或
`xiaomi/mimo-v2.5`），不然它會禮貌地跟你說「沒有附圖喔」。

## 工具橋接（最有意思的部分）

新版 Codex App 不再把 MCP／App 工具用扁平清單送出，而是包成 namespace：

```json
{"type":"namespace","name":"mcp__node_repl","tools":[{"name":"js","description":"...","parameters":{...}}]}
```

要讓這些工具真的能跑，得做兩件事：

1. **進代理時**：把每個子工具展開成一般 function 工具（上游只接受扁平、且符合 `[a-zA-Z0-9_-]` 的名字）。
2. **回客戶端時**：模型呼叫時要回
   `{"name":"js","namespace":"mcp__node_repl", ...}` —— `namespace` 欄位就是客戶端用來找執行器的關鍵。
   少送它，所有工具都會回 `unsupported call`（我們可是親身經歷過的）。

代理也會自動正規化模型可能送出的各種寫法（`js`、`ns::tool`、`ns__tool`），兩種行為都能用上面列出的
環境變數開關切換。

`web_search` 與 `web_fetch` 則是另一個故事：Command Code 的網路工具是**客戶端執行**的（實際去搜尋的是 CLI），
所以代理就扮演 CLI 的角色——注入工具、去打 `/alpha/web-search` 與 `/alpha/web-fetch`、再把結果餵回模型。
更多細節在 [docs/tool-namespaces.md](docs/tool-namespaces.md)。

## Docker

```bash
docker compose up -d                        # 或 PROXY_PORT=13050 docker compose up -d
docker build -t cidercc-uwu:latest .         # 想自己蓋也行
```

映像檔是輕量 `node:22-alpine`，聽 `3050`，內建 `/health` 健康檢查。

## 疑難排解

| 症狀 | 可能原因 | 先試這個 |
|---|---|---|
| `error sending request`／連線被拒 | 代理沒在跑 | 啟動它，再看 `http://127.0.0.1:3050/health` 是否回 `OK` |
| 所有工具都回 `unsupported call` | 客戶端／工具協定對不上 | 看日誌的 `aliasProbe` 與工具清單，或試 `CC_SEND_NAMESPACE_FIELD=0`、`CC_REJECT_NAMESPACE_TOOLS=1` |
| `502 Tool results are missing` | 歷史裡有沒結果的工具呼叫（回合被打斷） | 代理會自動修補；若持續出現，日誌會有 `Repaired incomplete tool history` |
| 推理模型出現 `429 Response timeout` | 閒置看門狗太急 | 調大 `CC_STREAM_IDLE_MS`（例如 `300000`） |
| `maximum context length` | 對話真的太長 | 調小客戶端的 context window，或讓它早點壓縮 |
| 模型說看不到圖片 | 用了不支援視覺的模型 | 換有視覺能力的模型 |
| 換版後行為沒變 | 舊進程還佔著埠 | 執行 `scripts/stop.cmd`（它會殺掉佔用 3050 的進程）再啟動 |

## 已知限制

- **非官方專案。** 這是針對一個沒有正式開放此類存取服務的逆向客戶端。Command Code 的條款仍然適用，
  而且上游在交握階段確實會偵測單純的代理流量——請自行衡量風險，那不是這支程式可以「修好」的東西。
- `tool_search` 是客戶端（App）自己的延遲工具查詢，這裡沒有實作：反代從不延後工具，而且就算 App
  哪天真的提供它，執行者也是 App 本身。詳見 [docs/tool-namespaces.md](docs/tool-namespaces.md)。
- 無狀態設計：`previous_response_id` 會刻意拒絕，每輪請帶完整上下文。
- 要水平擴展時請用 API key 做一致性雜湊——session 與裝置指紋是存在單一進程裡的。
- 記憶體用量約為 `請求體大小 × 併發數`；公開部署請在前面用反向代理限制 body 與連線數（程式碼內有註記）。

## 隱私

- 你的 API key 不會寫進 `config.json`、不會進日誌、除了當上游的 `Authorization` 標頭之外不會離開你的機器。
- 只有在真的想要本機備援金鑰時才填 `apiKey`；留空是比較有禮貌的預設。
- 日誌只記錄工具名稱、大小與狀態碼——不記提示詞、不記金鑰、不記錯誤內容。

## 致謝

- **原始專案：**[MAXeaglet/commandcode-proxy](https://github.com/MAXeaglet/commandcode-proxy)（MIT）——
  這支程式從那裡開始，本分支保留了同樣的授權與同樣的感謝。
- **Cider CC UwU 的修補：**工具 namespace 橋接、內建網路工具、圖片型工具結果、思考等級收斂、
  殘缺歷史修補，以及一堆小型穩定度修正。

## 授權

MIT —— 詳見 [LICENSE](LICENSE)。拉張椅子、fork 它、改造它。:3
