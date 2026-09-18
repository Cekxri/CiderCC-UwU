# 版本紀錄 :3

每一杯的配方，按時間排列。本專案遵循 [Semantic Versioning](https://semver.org/)。

**English version: [CHANGELOG.md](CHANGELOG.md)**

## [Unreleased]

## [1.1.0] - 2026-09-19

### 新增

- **版本舊了會提醒你。** `config.json` 預設就帶一個指向本專案 `package.json` 的 `updateFeed`，所以每份下載都會在
  啟動時檢查；如果上面的 `version` 比這裡跑的新，視窗就會印出兩個版本號並建議更新——永遠不會出現連結、也不會
  出現專案名稱。想換來源、或關掉（設空字串），可在不進 repo 的 `config.local.json` 覆蓋，或用 `CC_UPDATE_FEED`。
- **視窗的酒吧燈亮了。** 在真正的終端機視窗裡，輸出現在以紫為主：時間戳深紫，每一層都有自己的深淺兩色
  （`info` 亮紫／淺紫、`warn` 杏桃／蜜桃、`error` 暖珊瑚／暖粉），JSON 尾巴是暖玫瑰色，壓暗但不發灰——
  長長的日誌一眼就好讀。日誌檔與任何被重導的輸出都維持純文字（永遠不會有 ANSI 逃脫碼被寫進檔案）；
  `CC_COLOR=0` 或 `NO_COLOR=1` 可以關掉顏色。
- **視窗第一次啟動時會問語言。** 第一次用視窗版跑 `scripts\start.cmd`，會讓你選 English (UK) 或 繁體中文（台灣）；
  答案記在 `config.json` 旁邊的 `ui-language.txt`，之後啟動就不再問。這個選擇只影響「視窗印出的內容」——
  日誌檔一律保持英文（UK）；背景版 `scripts\start-background.cmd` 沒有視窗，所以全程英文（UK）。
  想覆蓋記憶的選擇可以用 `CC_UI_LANG`（`en-GB` / `zh-TW`）。

### 修正

- **零位元組斷流不再黏在同一條上游 session 上。** 上游接受請求後什麼都沒送就把串流關掉時，以前每一次重試都沿用
  同一條 session；那條 session 一旦在上游那邊壞掉，這一輪會失敗、下一輪也繼續失敗，只能等 12 小時自然汰換。
  現在只要遇到零位元組斷流，代理就會先換一條全新的 session 再重試，而且會記住這次更換（連客戶端自己釘住的
  session id／`prompt_cache_key` 也涵蓋），重試日誌會出現 `rotatedSession`。`CC_SESSION_TTL_MS` 與
  `CC_SESSION_JITTER_MS` 也可以讓你直接調短平常的 session 壽命。
- **串流中途閒置逾時，錯誤真的送得到了。** 逾時路徑以前先寫 SSE `error` 事件、下一秒就 `res.destroy()`，
  事件一起被丟掉——使用者只看到串流忽然停住、沒有任何原因（curl 會說
  `transfer closed with outstanding read data remaining`、錯誤事件 0 筆）。現在三個串流端點都會正常收尾，
  原因送得到客戶端。用「送出第一個 delta 後就沉默」的假上游驗證過。
- **閒置的 keep-alive 連線不再 5 秒就被關。** Node 預設 `keepAliveTimeout` 是 5 秒；桌面客戶端重用連線池時
  可能撞上「連線剛好被關」的競態，而 POST 不會自動重試。現在閒置連線保留 65 秒（headers 70 秒），避開這個窗口。
- **串流失敗改用 SSE 回報，不再回 JSON。** 串流請求遇到上游錯誤（403、零輸出、閒置逾時、連線中斷）時，以前回的是
  一般 JSON，客戶端只能顯示含糊的 `stream closed before response.completed`，真正原因被藏住。現在這些路徑會送 SSE
  的 `error` 事件並帶上上游自己的訊息；日誌也會記下上游回應內容，`CC API error` 終於能看出**為什麼**（例如 403 背後
  的額度訊息）。
- **什麼都沒產出就被切斷，也不再無聲。** 上一版只在「已經有文字」時才會提示；如果上游在**沒有文字、也沒有工具呼叫**
  之前就把連線關掉，那一輪仍然是「想了一下就結束、畫面全空」。現在代理會計算這一輪送出過幾個工具呼叫，遇到這種
  情況同樣送出 `error` 事件（"closed the stream before producing anything"）。正常串流不會誤報（用假上游雙向驗證過）。
- **跨對話委派現在真的送得到另一個模型。** `send_message_to_thread` 的訊息在目標對話裡是一筆帶
- **上游把串流切斷時，不再回報成功。** 以前即使上游沒送結尾的 `finish` 事件就斷線，代理照樣回
  `response.completed`，導致「輸出到一半卻沒有任何錯誤」。現在會記下 `Upstream stream ended without finish`，
  而且只要已經輸出過文字，就會送出 `error` 事件讓使用者看得見；每一輪的結束原因（`stop`、`length`…）也會寫進日誌。
- **每次啟動都會留下日誌檔。** `scripts/start.cmd`（雙擊捷徑用的那支）原本只把輸出留在視窗裡，關掉就沒了；
  現在兩支啟動腳本都會預設把 `LOG_FILE` 指到 `logs/relay.log`（你自己有設定就照你的）。
- **圖片與提示訊息不再切斷工具呼叫群組。** 同一輪呼叫多個工具時，App 會在結果之間插入 `<image_resize_notice>`
  （或圖片本身），上游就會回 `Tool results are missing for tool calls ...`，對話卡在 502。現在代理會追蹤
  這一組還沒回結果的 call id，等整組到齊才把扣住的圖片與 system/developer 提示放出去。
  （用真實 529 項歷史重現：修前 502、修後 200。）
- **金鑰片段不再進日誌。** `Fingerprint generated for key` 這行原本會印出 API key 的前八個字元，
  現在改成不可逆的短雜湊。README 早就承諾過這件事 —— 現在程式真的做到了。
- **`logLevel` 真的會過濾。** 它一直被接受、也被寫進文件，但程式從沒讀過；現在 `error`、`warn`、
  `info`、`debug` 會照文件運作（預設 `info`），啟動那行也會回報目前等級。
- **設定表照實寫。** `emptySystemPlaceholder` 明明程式有支援、卻漏在 `config.json` 表格外；
  `projectSlug`／`PROJECT_SLUG` 也改成照實描述 —— 只為相容而保留，送上上游的 slug 是刻意隨機化的。
- **CHANGELOG 標題重新渲染。** 兩份 CHANGELOG 都少了一個空行，害 `1.0.0` 標題被前一條清單吃掉，
  GitHub 上根本看不到那個標題。
- **Windows 橫幅會跟著埠跑。** `scripts/start.cmd` 之前即使 `PROXY_PORT` 換了埠、橫幅還是印 `3050`；
  現在會顯示實際使用的埠。
- **文件與封裝正確性。** Docker 範例用了大寫 image tag（`CiderCC-UwU:latest`），Docker 會直接拒絕；
  已改為小寫 `cidercc-uwu:latest`。
- **統一英式拼字。** 內部函式 `normalize*` 更名為 `normalise*`，符合本專案的 English (UK) 慣例。
- **繁中錯字。** `README.zh-TW.md` 裡混入的簡體字已修正。
- **Windows 三支腳本行為一致。** `scripts/start.cmd` 與 `scripts/start-background.cmd` 現在也認
  `PROXY_PORT`，跟 `scripts/stop.cmd` 對齊；要換到別的埠時三個會一起移動。
- **`scripts/stop.cmd` 會跟著你的埠。** 它依序從 `PROXY_PORT`、`PORT`、`config.json` 解析出真正
  在監聽的埠，不再寫死 3050。
- **背景啟動器交棒後就返回。** `scripts/start-background.cmd` 把 node 交給背景行程後會乾淨結束，
  主控台會立刻回到你手上。

### 新增

- **上游連線失敗會自動重試。** `fetch failed`（DNS／TLS／連線被切）現在會先重試最多 3 次（短暫退避）才讓客戶端知道，
  不會第一次瞬斷就變成錯誤。用「第一次連線直接斷掉」的假上游驗證：重試後正常回覆、客戶端零錯誤。
- **上游切斷串流時會自動救回來。** 上游沒送 `finish` 就關掉連線時，代理不再把「斷一半」丟給使用者：
  如果還沒輸出任何東西就重試同一個請求；如果已經輸出部分文字，就請模型「從最後一個字接下去」並把兩段
  縫起來。一輪最多自動救 2 次，真的救不回來才用 `error` 事件（上一版加的）當最後手段。
  用假上游驗證：空切斷 → 無聲重試成功、部分切斷 → 無縫接續、一直切斷 → 兩次後顯示錯誤。
- **說清楚反代「不擁有」什麼。** `docs/tool-namespaces.md` 現在解釋 `tool_search` 是客戶端工具、反代不維護
  任何工具清單（App 之後的工具變動會自動透傳），以及真正需要改反代的三種情況。
- **CI 會建 Docker 映像。** 工作流程會建置映像並在容器內輪詢 `/health`，Dockerfile 不會悄悄爛掉。

### 變更

- **切斷救援更用力。** 上游有時會連續丟掉同一個請求才肯回答，所以自動救援從 2 次提高到 **4 次**，之間加入短暫等待
  （0.9 秒、1.8 秒、2.7 秒）。日誌也會記下請求帶了幾個輸入項目，方便之後比對「多大的請求容易被切」。
  用「連續切 3 次」的假上游驗證：第 4 次成功回覆，客戶端零錯誤。

### 修正

- **失敗的那一輪，現在會在結束前說出原因。** 錯誤事件原本排在 `response.completed` **之後**，而客戶端讀到 completed
  就已經停止讀取，所以被切斷的回合看起來仍是「默默停住」。現在錯誤會**先**送出，該輪改用 `response.incomplete`
  （`upstream_closed`）收尾；若自動救援失敗，會把上游自己的訊息原樣帶出來——額度用完時會直接顯示
  `You've reached your weekly usage limit for your plan. Your limit resets at …`，而不是一句籠統的話。
  用假上游驗證（第一次切斷、重試回 429）：事件順序為 `error` → `response.incomplete`；正常串流仍是
  `response.completed` 且沒有錯誤事件。

### 新增

- **`CC_NATIVE_DELEGATION` —— 選擇進來的跨對話委派要用哪種形狀送給模型。** Codex App 把
  `send_message_to_thread` 的內容注入成單獨一筆 `function_call_output`，**沒有 `call_id`、也沒有配對的
  `function_call`**（`openai/codex#45227`，另有 #41690／#43515／#41799），所以這種資料不可能原樣轉送。預設維持
  現行行為（轉成使用者訊息，這也是 OpenAI issue 裡建議的修法之一）；設成 `1` 則改為補一組配對的 `function_call`
  ＋ `function_call_output`，讓上游看到原生 tool call/result 語意。兩種形狀都用嚴格 mock 上游驗證過：預設送出
  `user / assistant / user`，原生模式送出 `user / assistant / assistant(tool-call) / tool(tool-result)`，呼叫與結果
  正確配對。

### 變更

- **跨對話委派現在預設就是原生。** `CC_NATIVE_DELEGATION` 不用再手動打開：進來的委派會以它本來該有的樣子
  （配對的 `function_call` + `function_call_output`）轉送，模型看到的是原生 tool call/result 語意，也符合嚴格上游的要求。
  設 `CC_NATIVE_DELEGATION=0` 可退回先前的使用者訊息模式（讀起來就是一則指示）。

### 修正

- **每一種被注入的委派都認得出來。** 原本只認 `send_message_to_thread` 或含 `<codex_delegation>` 標記的內容，
  所以被注入、又不帶標記的 `create_thread`／`handoff_thread` 結果仍會被孤兒修補丟掉；現在三種工具名都認。

## [1.0.0] — 2026-09-12

**Cider CC UwU** 的第一個公開版本，是
[MAXeaglet/commandcode-proxy](https://github.com/MAXeaglet/commandcode-proxy) 的重度修補分支。

### 新增

- **工具 namespace 橋接。** 把 namespace 工具宣告（`{"type":"namespace", ...}`）展開成扁平 function
  工具送上上游，並在回傳時把 `namespace` 欄位補回去，讓新版 Codex App 的 MCP 工具（以及透過
  `node_repl`／`@oai/sky` 的 Computer Use）真的能執行。
- **內建 `web_search` / `web_fetch`。** 代理注入這兩個工具，並以 Command Code 自己的
  `/alpha/web-search` 與 `/alpha/web-fetch` 執行，再把結果餵回模型。迴圈深度以 `CC_MAX_WEB_ROUNDS` 控制。
- **殘缺歷史修補。** 沒有對應結果的工具呼叫（回合被中斷）會補上一筆說明，孤兒工具結果則丟棄，
  讓被卡死的對話能繼續。
- **圖片型工具結果。** 工具輸出裡的圖片會以真正的圖片重送，不再用一大坨 base64 撐爆上下文。
- **思考等級收斂。** `ultra` → `max`，`minimal`／`none`／`off` → `low`，無法識別的值直接丟棄。
- **Anthropic 端點支援圖片**（base64 與 URL，含 tool result 內的圖片）。
- **`tool_choice: "none"` 處理**，相容上游較嚴格的驗證。
- **執行期開關：** `CC_SEND_NAMESPACE_FIELD`、`CC_REJECT_NAMESPACE_TOOLS`、`CC_NAMESPACE_ALIAS_PROBE`、
  `CC_MAX_TOOL_OUTPUT_CHARS`、`CC_MAX_WEB_ROUNDS`。
- **Windows 輔助腳本**（`scripts/*.cmd`），停止腳本會找出真正佔用埠的進程。
- **English UK ＋ 繁體中文文件。**

### 修正

- 超長工具輸出不再撐爆上游上下文（可設定截斷上限）。
- 多工具回合中的圖片不再把工具結果群組切斷（那會讓上游回報 `Tool results are missing for tool calls ...`）。
- 只因 completion 預算而超限的情況，會自動降低 `max_tokens` 重試一次。
- 停止腳本改為殺掉真正佔用連接埠的進程，而不是信任可能過期的 PID 檔。

### 備註

- `tool_search` 刻意不實作；工具現在都直接提供。
- 代理維持無狀態 —— `previous_response_id` 會刻意拒絕。

## [0.x] — 早期

本分支之前的一切：MAXeaglet 的原始 `commandcode-proxy`。謝謝那間酒吧。UwU
