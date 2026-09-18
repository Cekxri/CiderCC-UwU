/**
 * Cider CC UwU — a chill little proxy between Command Code and the world of OpenAI / Anthropic clients.
 *
 * Pull up a stool: this single-file relay turns the Command Code API into OpenAI Chat Completions,
 * Anthropic Messages and OpenAI Responses endpoints. Zero external dependencies, one file, no nonsense. :3
 *
 * Built from passive analysis of the official CLI traffic, then patched through many a late-night debugging
 * session (tool namespaces, reasoning effort clamping, image handling, context repair, inline web tools).
 *
 * Original work: MAXeaglet/commandcode-proxy (MIT). This fork keeps the same licence and adds the fixes.
 *
 * Licensed under the MIT Licence. Unofficial project — not affiliated with Command Code.
 */
import http from 'http';
import crypto from 'crypto';
import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';

// ── Configuration loading / 設定載入 ───────────────
const __dirname = dirname(fileURLToPath(import.meta.url));

function loadConfig() {
  const defaults = {
    port: 3000,
    host: '0.0.0.0',
    apiBase: 'https://api.commandcode.ai',
    projectSlug: 'cc-proxy',
    logFile: '',
    logLevel: 'info',
    useProviderModels: true,
    modelRefreshIntervalMs: 5 * 60 * 1000,  // 5 minutes
    zdr: false,
    emptySystemPlaceholder: true, // send a space placeholder when there is no system prompt, so the upstream does not inject its ~7.5K-token default prompt (issue #17)
    updateFeed: '', // optional URL serving this project's package.json; gives the window a nudge when a newer pour is out
  };

  const configPath = resolve(__dirname, 'config.json');
  if (existsSync(configPath)) {
    try {
      const user = JSON.parse(readFileSync(configPath, 'utf-8'));
      Object.assign(defaults, user);
    } catch (e) {
      console.error('[config] Failed to parse config.json:', e.message);
    }
  }

  // Local, git-ignored overrides live in config.local.json — the place for things this machine should keep
  // out of the repo (the update feed, for instance).
  // 繁中：config.local.json 是「這台機器專用」的覆蓋檔（已列在 .gitignore），用來放不想進 repo 的設定。
  const localPath = resolve(__dirname, 'config.local.json');
  if (existsSync(localPath)) {
    try {
      Object.assign(defaults, JSON.parse(readFileSync(localPath, 'utf-8')));
    } catch (e) {
      console.error('[config] Failed to parse config.local.json:', e.message);
    }
  }

  // Environment-variable overrides
  if (process.env.PORT) defaults.port = parseInt(process.env.PORT);
  if (process.env.HOST) defaults.host = process.env.HOST;
  if (process.env.CC_API_BASE) defaults.apiBase = process.env.CC_API_BASE;
  if (process.env.PROJECT_SLUG) defaults.projectSlug = process.env.PROJECT_SLUG;
  if (process.env.LOG_FILE) defaults.logFile = process.env.LOG_FILE;
  if (process.env.CC_USE_PROVIDER_MODELS) defaults.useProviderModels = process.env.CC_USE_PROVIDER_MODELS !== 'false';
  if (process.env.CMD_ZDR !== undefined) defaults.zdr = process.env.CMD_ZDR === '1';
  if (process.env.CC_EMPTY_SYSTEM_PLACEHOLDER) defaults.emptySystemPlaceholder = process.env.CC_EMPTY_SYSTEM_PLACEHOLDER !== 'false';
  if (process.env.CC_UPDATE_FEED) defaults.updateFeed = process.env.CC_UPDATE_FEED;

  return defaults;
}

const CFG = loadConfig();

// ── Console language / 視窗語言 ─────────────────────
// Chosen once on the first windowed launch and remembered in ui-language.txt (next to config.json).
// It only changes what the console shows — the log file always stays English (UK), and the background
// launcher has no window, so it defaults to English (UK) as well.
// 繁中：視窗語言在首次啟動時選擇，記在 config.json 旁的 ui-language.txt；只影響「視窗印出」的內容，
// 日誌檔一律英文（UK）；背景版沒有視窗，預設也是英文（UK）。
const UI_LANGUAGE_FILE = resolve(__dirname, 'ui-language.txt');

function normaliseUiLanguage(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'zh-tw' || v === 'zh_tw' || v === 'zh-hant' || v === 'zh') return 'zh-TW';
  if (v === 'en-gb' || v === 'en_gb' || v === 'en' || v === 'english') return 'en-GB';
  return null;
}

function readUiLanguageFile() {
  try { return normaliseUiLanguage(readFileSync(UI_LANGUAGE_FILE, 'utf-8')); } catch { return null; }
}

function writeUiLanguageFile(value) {
  try { writeFileSync(UI_LANGUAGE_FILE, value + '\n', 'utf-8'); } catch {}
}

function promptForUiLanguage() {
  return new Promise((resolveChoice) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ask = () => {
      rl.question('Choose the window language / 選擇視窗語言：\n  [1] English (UK)\n  [2] 繁體中文（台灣）\n> ', (answer) => {
        const a = String(answer).trim().toLowerCase();
        if (a === '1' || a === 'en' || a === 'en-gb') { rl.close(); resolveChoice('en-GB'); return; }
        if (a === '2' || a === 'zh' || a === 'zh-tw' || answer.trim() === '中文') { rl.close(); resolveChoice('zh-TW'); return; }
        console.log('Please type 1 or 2. / 請輸入 1 或 2。');
        ask();
      });
    };
    ask();
  });
}

const UI_LANG = await (async () => {
  const fromEnv = normaliseUiLanguage(process.env.CC_UI_LANG);
  if (fromEnv) return fromEnv;
  const fromFile = readUiLanguageFile();
  if (fromFile) return fromFile;
  if (!process.stdin.isTTY) return 'en-GB';   // no window to ask in (background launcher, pipes)
  const chosen = await promptForUiLanguage();
  writeUiLanguageFile(chosen);
  return chosen;
})();

// ── Fingerprint generation / 裝置指紋產生（首次自動建立）──
// CPU model to core-count lookup (Windows x64 only)
const FINGERPRINT_CPUS = [
  { model: '12th Gen Intel(R) Core(TM) i7-12650H', cores: 10 },
  { model: '12th Gen Intel(R) Core(TM) i5-12400F', cores: 6 },
  { model: '12th Gen Intel(R) Core(TM) i9-12900K', cores: 16 },
  { model: '13th Gen Intel(R) Core(TM) i7-13700K', cores: 16 },
  { model: '13th Gen Intel(R) Core(TM) i5-13600K', cores: 14 },
  { model: '13th Gen Intel(R) Core(TM) i9-13900K', cores: 24 },
  { model: 'Intel(R) Core(TM) Ultra 7 155H', cores: 16 },
  { model: 'Intel(R) Core(TM) Ultra 9 285H', cores: 16 },
  { model: 'Intel(R) Core(TM) i9-14900K', cores: 24 },
  { model: 'Intel(R) Core(TM) i7-14700K', cores: 20 },
  { model: 'AMD Ryzen 7 7800X3D', cores: 8 },
  { model: 'AMD Ryzen 9 7950X', cores: 16 },
  { model: 'AMD Ryzen 5 7600', cores: 6 },
  { model: 'AMD Ryzen 9 7900X', cores: 12 },
  { model: 'AMD Ryzen 7 5800X3D', cores: 8 },
];
const FINGERPRINT_MEMS = [8, 16, 24, 32, 48, 64];
const FINGERPRINT_TZS = [
  'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'America/Toronto',
  'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'Europe/Moscow',
  'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Singapore', 'Asia/Seoul', 'Asia/Hong_Kong',
  'Australia/Sydney', 'Pacific/Auckland',
];
const FINGERPRINT_MAC_COUNT_RANGE = [2, 3, 4, 5]; // random 2–5 MAC addresses

function generateFingerprint() {
  const cpuEntry = FINGERPRINT_CPUS[Math.floor(Math.random() * FINGERPRINT_CPUS.length)];
  const memGiB = FINGERPRINT_MEMS[Math.floor(Math.random() * FINGERPRINT_MEMS.length)];
  const tz = FINGERPRINT_TZS[Math.floor(Math.random() * FINGERPRINT_TZS.length)];
  const macCount = FINGERPRINT_MAC_COUNT_RANGE[Math.floor(Math.random() * FINGERPRINT_MAC_COUNT_RANGE.length)];

  function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
  function randHex(n) { return crypto.randomBytes(n).toString('hex'); }

  const macHashes = [];
  for (let i = 0; i < macCount; i++) macHashes.push(sha256(randHex(32)));

  const machineIdHash = sha256(randHex(32));
  const osUserHash = sha256(randHex(16));
  const hostnameHash = sha256(randHex(16));
  const gitEmailHash = sha256(randHex(16));

  // thumbmark = a combined hash of every component
  const thumbData = [machineIdHash, ...macHashes, osUserHash, hostnameHash, gitEmailHash, 'win32', '10.0.22631', cpuEntry.model, String(cpuEntry.cores), String(memGiB)].join('|');
  const thumbmark = sha256(thumbData);

  return {
    thumbmark,
    components: {
      machineIdHash,
      macHashes,
      osUserHash,
      hostnameHash,
      gitEmailHash,
      platform: 'win32',
      arch: 'x64',
      osRelease: '10.0.22631',
      cpuModel: cpuEntry.model,
      cpuCount: cpuEntry.cores,
      memGiB,
      isContainer: false,
      timezone: tz,
      runtime: 'cli',
      collectorVersion: 1,
    },
  };
}

let CC_VERSION = '0.32.3';
const CC_VERSION_FALLBACK = '0.32.3';
const CC_VERSION_REFRESH_MS = 24 * 60 * 60 * 1000; // 24h — npm registry refresh interval

// ── Dynamic CC version / 動態 CC 版本號（取自 npm registry）──
async function refreshCCVersion() {
  try {
    const url = 'https://registry.npmjs.org/command-code/latest';
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`npm responded with ${res.status}`);
    const pkg = await res.json();
    if (pkg.version && typeof pkg.version === 'string') {
      CC_VERSION = pkg.version;
      log('info', 'CC Version refreshed from npm', { version: CC_VERSION });
    }
  } catch (e) {
    log('warn', 'CC Version fetch failed, using current', { version: CC_VERSION, error: e.message });
  }
}
refreshCCVersion(); // fetch straight away on start-up
setInterval(refreshCCVersion, CC_VERSION_REFRESH_MS);

// Request body cap: 100MB by default, overridable with CC_MAX_BODY_MB (a positive integer, in MB)
// ⚠️ Memory behaviour (measured in issue #20): the body exists in several copies before it reaches upstream —
//    chunks[] / Buffer.concat / utf8 string / JSON.parse object tree / the tree rebuilt by buildCcRequest / the JSON.stringify payload.
//    Measured peak ≈ body size × 5.1–7.4 (7MB→+52MB, 20MB→+116MB; a rejected 413 costs only ×1.05).
//    A 100MB cap therefore means one request can cost ~550MB at worst, and the cap is per request, not global.
// 繁中：請求體在上游前會存在多份副本，實測峰值約 body × 5.1~7.4；預設 100MB 上限代表單一請求最壞 ~550MB，且是「每請求」不是全域。公開部署請在反向代理同時限制 body 與在途數。
const MAX_BODY_SIZE = (() => {
  const mb = Number.parseInt(process.env.CC_MAX_BODY_MB ?? '', 10);
  return Number.isFinite(mb) && mb > 0 ? mb * 1024 * 1024 : 100 * 1024 * 1024;
})();
// Upstream read-idle timeout (issue #19): counts only the time spent waiting in reader.read(), reset on every chunk —
// not the total duration of the request. The defaults are unchanged (30s / 90s) and can be overridden by environment variable —
// the official CLI has no upstream idle timeout at all (verified by decompiling command-code@1.50.0:
// every createApiClient call site passes no timeout), and legitimate thinking stalls can run for hundreds of seconds.
// 繁中：看門狗只算 reader.read() 的等待、收到 chunk 就重置，不是整支請求的總時長；推理模型被 30 秒誤殺或觸發 429 重試放大時，把這兩個值調大。
const STREAM_IDLE_TIMEOUT_MS = (() => {
  const ms = Number.parseInt(process.env.CC_STREAM_IDLE_MS ?? '', 10);
  return Number.isFinite(ms) && ms > 0 ? ms : 30000;   // default 30s — abort a stream only when no new data arrives
})();
const NONSTREAM_IDLE_TIMEOUT_MS = (() => {
  const ms = Number.parseInt(process.env.CC_NONSTREAM_IDLE_MS ?? '', 10);
  return Number.isFinite(ms) && ms > 0 ? ms : 90000;   // default 90s — a more forgiving window for non-streaming
})();

// Stalled-client guard: a client that neither reads nor disconnects keeps its request (and the upstream connection) hanging —
// the residue left behind after the backpressure fix. Measured cost is ~5MB per connection: bounded, no leak, reclaimed on
// disconnect — but the number of connections is itself unbounded. Default 0 = disabled, so existing behaviour is unchanged:
// a stalled client cannot be told apart, at the protocol level, from a legitimate client blocked on tool execution, and
// the official CLI has no upstream idle timeout at all (issue #19), so a rushed timeout would kill healthy requests.
// downstream (nginx limit_conn, per-IP / per-key). This option merely offers an in-process global
// backstop for running without a reverse proxy; it does not replace the downstream approach, nor does it know who the client is.
// Memory = in-flight × (0.13MB + 5.5 × body_MB): the body cap bounds one request, this bounds the multiplier.
// Over the limit it answers 503 + Retry-After (SDKs back off and retry) instead of letting the process be OOM-killed.
// 繁中：在途上限預設關閉（0）。記憶體 ≈ 在途數 × (0.13MB + 5.5 × body_MB)；要硬性上界需同時下調 CC_MAX_BODY_MB。
//   CC_MAX_INFLIGHT=32 npm start
// Note: the body cap only bounds a single request; this option caps the multiplier. With the default 100MB body cap that is
// N × 550MB worst case — for a hard memory ceiling, lower CC_MAX_BODY_MB as well.
const MAX_INFLIGHT = (() => {
  const n = Number.parseInt(process.env.CC_MAX_INFLIGHT ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 0;            // default 0 = unlimited
})();

let inflightCount = 0;   // current in-flight requests (excluding /health)

const CLIENT_DRAIN_TIMEOUT_MS = (() => {
  const ms = Number.parseInt(process.env.CC_CLIENT_DRAIN_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
})();

// Consecutive-timeout counter: warn about reducing context only after three in a row; any success resets it
let consecutiveTimeouts = 0;
const TIMEOUT_REDUCE_CONTEXT_THRESHOLD = 3;

// ── Logging / 日誌 ──────────────────────────────────
// 繁中：logLevel 現在真的會過濾 —— error < warn < info < debug（預設 info）。
// English: logLevel now actually filters — error < warn < info < debug (default info).
const LOG_LEVEL_ORDER = { error: 0, warn: 1, info: 2, debug: 3 };
const LOG_LEVEL_FLOOR = LOG_LEVEL_ORDER[String(CFG.logLevel || 'info').toLowerCase()] ?? LOG_LEVEL_ORDER.info;

// ── Console colours / 視窗配色 ───────────────────────
// A Nordic-bar paint job where violet calls the tune: a deep-purple timestamp, and every level gets two
// shades — info in bright/light violet, warnings in apricot/peach, errors in warm coral/pink (peachy,
// never cold), and the JSON tail in a dusty warm rose so it recedes without going grey. Only a real
// terminal gets the codes — redirected output (the log file, the background launcher) stays plain text,
// so nothing ever greps an escape sequence again. `CC_COLOR=0` or `NO_COLOR=1` switches them off.
// 繁中：以紫為主的北歐酒吧配色——時間戳深紫，info 亮紫／淺紫，warn 杏桃／蜜桃，error 暖珊瑚／暖粉，
// JSON 尾巴用暖玫瑰色壓暗（不再灰灰的）。只有「真正的視窗」上色；日誌檔與背景版永遠純文字。
// Precedence: CC_COLOR=0 (off) > CC_COLOR=1 (on) > NO_COLOR (off) > a real terminal (on).
const USE_COLOUR = process.env.CC_COLOR === '1'
  ? true
  : (process.env.CC_COLOR === '0' ? false : (Boolean(process.stdout.isTTY) && !process.env.NO_COLOR));
const ANSI_PAINT = {
  reset: '\u001b[0m',
  stamp: '\u001b[38;5;97m',      // deep muted purple — the small print
  data: '\u001b[38;5;181m',      // dusty warm rose — the JSON tail, warm but quiet
};
const LEVEL_PAINT = {
  debug: { badge: '\u001b[38;5;97m',  message: '\u001b[38;5;139m' }, // deep purple / muted mauve
  info:  { badge: '\u001b[38;5;141m', message: '\u001b[38;5;183m' }, // bright violet / light violet
  warn:  { badge: '\u001b[38;5;215m', message: '\u001b[38;5;223m' }, // apricot / peach
  error: { badge: '\u001b[38;5;203m', message: '\u001b[38;5;210m' }, // warm coral / warm pink
};

// Console-only translations for the window language. The log file and the English console keep the
// original strings, so anything grepping the log file never has to know about this table.
// 繁中：這張表只給「視窗」用；日誌檔與英文模式都維持原文，抓日誌的工具完全不受影響。
const LOG_TEXT_ZH_TW = {
  'A newer version is available': '有新版本可以更新',
  'Aborted request cleaned up': '已中止的請求已清理',
  'Answer truncated by max_output_tokens': '回應被 max_output_tokens 截斷',
  'Anthropic stream error': 'Anthropic 串流錯誤',
  'CC API error': 'CC API 錯誤',
  'CC API error (Anthropic)': 'CC API 錯誤（Anthropic）',
  'CC error (Anthropic non-stream)': 'CC 錯誤（Anthropic 非串流）',
  'CC stream error': 'CC 串流錯誤',
  'CC stream error (non-stream)': 'CC 串流錯誤（非串流）',
  'CC stream error event': 'CC 串流錯誤事件',
  'CC tool history': 'CC 工具歷史',
  'CC Version fetch failed, using current': 'CC 版本查詢失敗，沿用目前版本',
  'CC Version refreshed from npm': 'CC 版本已從 npm 更新',
  'Cider CC UwU is open ~ pull up a stool :3': 'Cider CC UwU 開張啦～拉張高腳凳坐吧 :3',
  'Client disconnected': '客戶端已斷線',
  'Client drain timeout enabled': '客戶端讀取逾時保護已啟用',
  'Client stalled on backpressure, dropping connection': '客戶端不再讀取（背壓卡住），切斷連線',
  'Context limit exceeded by messages alone (cannot retry)': '單靠訊息就超過上下文上限（無法重試）',
  'Context limit hit, retrying with reduced max_tokens': '撞到上下文上限，降低 max_tokens 重試',
  'Executed internal web tools': '已執行內建網路工具',
  'Executed internal web tools (non-stream)': '已執行內建網路工具（非串流）',
  'Fetched models from Provider API': '已從 Provider API 取得模型清單',
  'Fingerprint generated for key': '已為金鑰產生裝置指紋',
  'Fingerprint record error': '裝置指紋記錄錯誤',
  'Fingerprint record failed': '裝置指紋記錄失敗',
  'Fingerprint recorded': '裝置指紋已記錄',
  'Fingerprint/lifecycle next refresh': '裝置指紋／生命週期下次更新',
  'Fingerprint/lifecycle refresh error, will retry next request': '裝置指紋／生命週期更新失敗，下次請求再試',
  'In-flight limit reached, rejecting request': '達到在途請求上限，拒絕請求',
  'Lifecycle event error': '生命週期事件錯誤',
  'Lifecycle event failed': '生命週期事件失敗',
  'Lifecycle event sent': '生命週期事件已送出',
  'No API key in config. API key must be sent in Authorization: Bearer <key> header per request.': '設定檔沒有 API key；請在每個請求用 Authorization: Bearer <key> 標頭帶上',
  'Provider models fetch error, using hardcoded list': 'Provider 模型清單取得錯誤，改用內建清單',
  'Provider models fetch failed, using hardcoded list': 'Provider 模型清單取得失敗，改用內建清單',
  'Rejected namespace tools (forcing flat-tool fallback)': '已拒絕 namespace 工具（強制改用扁平工具）',
  'Repaired incomplete tool history': '已修補不完整的工具歷史',
  'Request body limit implies high per-request worst-case memory': '請求體上限代表單一請求最壞記憶體用量偏高',
  'Request cancelled (client disconnected before CC response)': '請求已取消（CC 回應前客戶端就斷線）',
  'Responses handler error': 'Responses 處理器錯誤',
  'Responses input items': 'Responses 輸入項目',
  'Session cleanup': 'Session 清理',
  'Session created': 'Session 已建立',
  'Stream error': '串流錯誤',
  'Stream idle timeout': '串流閒置逾時',
  'Stream recovery failed': '串流恢復失敗',
  'Tool entries (kept vs ignored)': '工具項目（保留 vs 忽略）',
  'Tool output truncated': '工具輸出已截斷',
  'Unhandled rejection': '未處理的 Promise 拒絕',
  'Unknown CC event type': '未知的 CC 事件類型',
  'Update check failed': '更新檢查失敗',
  'Upstream cut the stream — recovering': '上游切斷串流 — 正在恢復',
  'Upstream error': '上游錯誤',
  'Upstream fetch failed — retrying': '上游連線失敗 — 正在重試',
  'Upstream stream ended without finish': '上游串流在沒有 finish 的情況下結束',
  'Upstream stream finished': '上游串流完成',
  'Up to date, nothing to pour': '已是最新版本，沒什麼好倒的 :3',
};

function log(level, msg, data) {
  if ((LOG_LEVEL_ORDER[level] ?? LOG_LEVEL_ORDER.info) > LOG_LEVEL_FLOOR) return;
  const stamp = `[${new Date().toISOString()}]`;
  const badge = `[${level}]`;
  const tail = data ? ' ' + JSON.stringify(data) : '';
  // 繁中：視窗照選定語言顯示；日誌檔固定英文（UK）。
  // English: the window follows the chosen language; the log file always stays English (UK).
  const shown = UI_LANG === 'zh-TW' ? (LOG_TEXT_ZH_TW[msg] || msg) : msg;
  if (USE_COLOUR) {
    const paint = LEVEL_PAINT[level] || LEVEL_PAINT.info;
    console.log(`${ANSI_PAINT.stamp}${stamp}${ANSI_PAINT.reset} ${paint.badge}${badge}${ANSI_PAINT.reset} ${paint.message}${shown}${ANSI_PAINT.reset}${ANSI_PAINT.data}${tail}${ANSI_PAINT.reset}`);
  } else {
    console.log(`${stamp} ${badge} ${shown}${tail}`);
  }
  if (CFG.logFile) {
    try { appendFileSync(CFG.logFile, `${stamp} ${badge} ${msg}${tail}\n`, 'utf-8'); } catch {}
  }
}

// ── Update check / 更新檢查 ─────────────────────────
// Optional. Point `updateFeed` (config.local.json is the tidy place; `CC_UPDATE_FEED` also works) at a URL
// that serves this project's package.json — or any JSON with a "version" field. When the feed is newer than
// the copy running here, the window gets a friendly nudge. The message deliberately carries no links and no
// project names: just the two version numbers.
// 繁中：選用功能。把 updateFeed（建議放 config.local.json，或用 CC_UPDATE_FEED）指到一個會回傳本專案
// package.json 的網址；遠端版本較新時只在視窗提示兩個版本號，不含任何連結或專案名稱。
const UPDATE_FEED = String(CFG.updateFeed || '').trim();

function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

async function checkForUpdate() {
  if (!UPDATE_FEED) return;
  try {
    const localVersion = String(JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8')).version || '0.0.0');
    const res = await fetch(UPDATE_FEED, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) { log('debug', 'Update check failed', { status: res.status }); return; }
    const remoteVersion = String((JSON.parse(await res.text()) || {}).version || '').trim();
    if (!remoteVersion) { log('debug', 'Update check failed', { reason: 'feed has no version field' }); return; }
    if (compareVersions(remoteVersion, localVersion) > 0) {
      log('warn', 'A newer version is available', {
        running: localVersion,
        available: remoteVersion,
        hint: 'a fresher pour is on the shelf — update when convenient :3',
      });
    } else {
      log('debug', 'Up to date, nothing to pour', { version: localVersion });
    }
  } catch (e) {
    log('debug', 'Update check failed', { message: e.message });
  }
}

// ── Session management / Session 管理 ───────────────
// One session per API key, expiring after 12h plus up to 1h of random jitter
// The same key reuses its session within a cycle and gets a fresh one when it lapses
const SESSION_DURATION_MS = (() => {
  const n = Number.parseInt(process.env.CC_SESSION_TTL_MS ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 12 * 60 * 60 * 1000;   // 12h default
})();
const SESSION_JITTER_MS = (() => {
  const n = Number.parseInt(process.env.CC_SESSION_JITTER_MS ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : 60 * 60 * 1000;       // up to 1h of jitter
})();

const sessionStore = new Map(); // apiKey → { sessionId, expiresAt }

// Rotated stand-ins for sessions the client pinned itself (a session-ish header or prompt_cache_key):
// the client keeps its pin, but the upstream sees the replacement.
// 繁中：客戶端自己釘住 session id 時，換新只能靠這張覆蓋表記住「這個 pin 之後改用哪一條」。
const sessionRotations = new Map(); // `${apiKey}\u0000${pin}` → { sessionId, expiresAt }

function mintSessionEntry() {
  const jitter = SESSION_JITTER_MS > 0 ? Math.floor(Math.random() * SESSION_JITTER_MS) : 0;
  return { sessionId: randomUUID(), expiresAt: Date.now() + SESSION_DURATION_MS + jitter };
}

function sessionPin(incomingHeaders, promptCacheKey) {
  // Prefer the session-ish headers sent by the client
  const candidates = [
    incomingHeaders && incomingHeaders['x-session-id'],
    incomingHeaders && incomingHeaders['x-claude-code-session-id'],
    incomingHeaders && incomingHeaders['session_id'],
    promptCacheKey,
  ];
  for (const id of candidates) {
    if (id && typeof id === 'string' && id.length >= 8) return id;
  }
  return null;
}

function rotationKey(apiKey, pin) { return apiKey + '\u0000' + pin; }

function ensureSession(apiKey) {
  const now = Date.now();
  const entry = sessionStore.get(apiKey);

  if (entry && now < entry.expiresAt) {
    return entry.sessionId;
  }

  // Expired, or the first time: mint a new session
  const fresh = mintSessionEntry();
  sessionStore.set(apiKey, fresh);
      log('info', 'Session created', { sessionId: fresh.sessionId.slice(0, 8), storeSize: sessionStore.size });
  return fresh.sessionId;
}

// 繁中：上游在「還沒送出任何東西」就切斷串流時，問題可能就出在 session 本身（上游那邊壞掉的那一條）。
// English: when the upstream cuts a stream before sending anything, the session itself may be the broken part —
// rotate to a fresh one so the retry, and the rest of the conversation, stop hitting the dead session.
function rotateSession(apiKey, incomingHeaders, promptCacheKey) {
  const fresh = mintSessionEntry();
  const pin = sessionPin(incomingHeaders || {}, promptCacheKey);
  if (pin) sessionRotations.set(rotationKey(apiKey, pin), fresh);
  else sessionStore.set(apiKey, fresh);
  return fresh;
}

// Periodically sweep expired sessions and key state so the Maps cannot grow without bound
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [key, entry] of sessionStore) {
    if (now >= entry.expiresAt) {
      sessionStore.delete(key);
      keyStateStore.delete(key); // drop this key’s fingerprint state too
      cleaned++;
    }
  }
  for (const [key, entry] of sessionRotations) {
    if (now >= entry.expiresAt) sessionRotations.delete(key);
  }
  if (cleaned > 0) log('info', 'Session cleanup', { cleaned, remaining: sessionStore.size });
}, 60 * 60 * 1000); // hourly

function getSessionId(incomingHeaders, apiKey, promptCacheKey) {
  const pin = sessionPin(incomingHeaders, promptCacheKey);
  if (pin) {
    // A pin the relay rotated away from is answered with its replacement for as long as it lives
    const rotated = sessionRotations.get(rotationKey(apiKey, pin));
    if (rotated && Date.now() < rotated.expiresAt) return rotated.sessionId;
    return pin;
  }
  // One session per API key
  return ensureSession(apiKey);
}

// A fresh thread ID for every request
function newThreadId() { return randomUUID(); }

// ── Per-key state / 每把金鑰的獨立狀態（指紋＋初始化節流）──
// Every API key gets its own device fingerprint and initialisation timer
const keyStateStore = new Map(); // apiKey → { fingerprint, nextInitAt }

function getOrCreateKeyState(apiKey) {
  let state = keyStateStore.get(apiKey);
  if (!state) {
    state = {
      fingerprint: generateFingerprint(),
      nextInitAt: 0,
    };
    keyStateStore.set(apiKey, state);
    // 繁中：只記錄金鑰的不可逆短雜湊，永不記錄金鑰片段（key prefix 曾違反本專案的隱私規則）。
    // English: log an irreversible short hash of the key only — never a key fragment.
    log('info', 'Fingerprint generated for key', { keyHash: crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 8) });
  }
  return state;
}

// ── Initialisation pre-requests / 初始化預請求（指紋＋lifecycle；首次後每 8h±2h）──
const INIT_REFRESH_MS = 8 * 60 * 60 * 1000;    // 8h
const INIT_JITTER_MS  = 2 * 60 * 60 * 1000;    // 2h of jitter

async function ensureInitialized(apiKey, signal) {
  const state = getOrCreateKeyState(apiKey);
  const now = Date.now();
  if (now < state.nextInitAt) return;

  try {
    // Fire both pre-requests in parallel
    const headers = {
      'Content-Type': 'application/json',
      'x-cli-environment': 'production',
      'Authorization': `Bearer ${apiKey}`,
      'x-command-code-version': CC_VERSION,
      ...(CFG.zdr ? { 'x-cmd-zdr': '1' } : {}),
    };
    const fingerprint = state.fingerprint || {};

    await Promise.all([
      fetch(`${CFG.apiBase}/alpha/fingerprint/record`, {
        method: 'POST', headers, signal,
        body: JSON.stringify(fingerprint),
      }).then(r => {
        if (!r.ok) log('warn', 'Fingerprint record failed', { status: r.status });
        else log('info', 'Fingerprint recorded');
      }).catch(e => {
        if (e.name !== 'AbortError') log('warn', 'Fingerprint record error', { error: e.message });
      }),

      fetch(`${CFG.apiBase}/alpha/lifecycle-events`, {
        method: 'POST', headers, signal,
        body: JSON.stringify({
          eventType: 'cli_session_exists',
          metadata: {
            sessionId: `sess_${crypto.randomBytes(8).toString('hex')}`,
            cliVersion: CC_VERSION,
            mode: 'interactive',
            os: `${fingerprint.components.platform}-${fingerprint.components.arch}`,
          },
        }),
      }).then(r => {
        if (!r.ok) log('warn', 'Lifecycle event failed', { status: r.status });
        else log('info', 'Lifecycle event sent');
      }).catch(e => {
        if (e.name !== 'AbortError') log('warn', 'Lifecycle event error', { error: e.message });
      }),
    ]);

    // Success: 8h plus up to 2h of random jitter
    const jitter = Math.floor(Math.random() * INIT_JITTER_MS);
    state.nextInitAt = Date.now() + INIT_REFRESH_MS + jitter;
    log('info', 'Fingerprint/lifecycle next refresh', { nextIn: `${(INIT_REFRESH_MS + jitter) / 3600000}h` });
  } catch (e) {
    if (e.name !== 'AbortError') log('warn', 'Fingerprint/lifecycle refresh error, will retry next request', { error: e.message });
  }
}

// ── Model list / 模型清單 ───────────────────────────
const MODELS = [
  // Anthropic
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
  { id: 'claude-opus-4-8', name: 'Claude Opus 4.8' },
  { id: 'claude-opus-4-7', name: 'Claude Opus 4.7' },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
  // OpenAI
  { id: 'gpt-5.5', name: 'GPT-5.5' },
  { id: 'gpt-5.4', name: 'GPT-5.4' },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini' },
  { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex' },
  // DeepSeek
  { id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
  { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
  // Kimi
  { id: 'moonshotai/Kimi-K2.6', name: 'Kimi K2.6' },
  { id: 'moonshotai/Kimi-K2.5', name: 'Kimi K2.5' },
  // GLM
  { id: 'zai-org/GLM-5.1', name: 'GLM 5.1' },
  { id: 'zai-org/GLM-5', name: 'GLM 5' },
  // MiniMax
  { id: 'MiniMaxAI/MiniMax-M3', name: 'MiniMax M3' },
  { id: 'MiniMaxAI/MiniMax-M2.7', name: 'MiniMax M2.7' },
  { id: 'MiniMaxAI/MiniMax-M2.5', name: 'MiniMax M2.5' },
  // Qwen
  { id: 'Qwen/Qwen3.6-Max-Preview', name: 'Qwen 3.6 Max Preview' },
  { id: 'Qwen/Qwen3.6-Plus', name: 'Qwen 3.6 Plus' },
  { id: 'Qwen/Qwen3.7-Max', name: 'Qwen 3.7 Max' },
  // Step
  { id: 'stepfun/Step-3.7-Flash', name: 'Step 3.7 Flash' },
  { id: 'stepfun/Step-3.5-Flash', name: 'Step 3.5 Flash' },
  // Xiaomi
  { id: 'xiaomi/mimo-v2.5-pro', name: 'MiMo V2.5 Pro' },
  { id: 'xiaomi/mimo-v2.5', name: 'MiMo V2.5' },
  // Gemini
  { id: 'google/gemini-3.5-flash', name: 'Gemini 3.5 Flash' },
  { id: 'google/gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite' },
];

// ── Helper functions / 輔助函式 ─────────────────────

// Build a fake working directory from the sessionId, then derive a slug using the real CLI’s rules
// The result looks like "d-users-dev-projects-web-app-a3f2" (matching the real CLI’s slug format)
function fakeProjectSlug(sessionId) {
  const names = ['app', 'api', 'backend', 'bot', 'cli', 'core', 'data', 'frontend',
    'lib', 'plugin', 'proxy', 'server', 'service', 'tool', 'web', 'worker'];
  const id = String(sessionId || '');
  const head = id.slice(0, 4);
  // The sessionId is either a random UUID (first four characters hexadecimal) or a client-supplied
  // prompt_cache_key (such as "my-stable-cache-key-001"). The latter parses as NaN in base 16, which would
  // 繁中：sessionId 可能是 UUID 或客戶端的 prompt_cache_key；後者以 16 進位解析得到 NaN，會讓 slug 變成 undefined，故改用確定性的字元雜湊。
  let idx = parseInt(head, 16);
  if (!Number.isFinite(idx)) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    idx = h;
  }
  const name = names[idx % names.length];
  const suffix = head || '0000';
  // Mimic a path such as C:\Users\dev\projects\{name}-{suffix}
  const path = `C:\\Users\\dev\\projects\\${name}-${suffix}`;
  return path
    .toLowerCase()
    .replace(/^[a-z]:/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function generateTraceparent() {
  const traceId = crypto.randomBytes(16).toString('hex');
  const parentId = crypto.randomBytes(8).toString('hex');
  return `00-${traceId}-${parentId}-01`;
}

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function getDateStr() {
  return new Date().toISOString().slice(0, 10);
}

function getEnvironment() {
  return `${process.platform}-${process.arch}, Node.js ${process.version.slice(1)}`;
}

// ── CC request body / CC 請求體建構 ─────────────────

function buildCcRequest(openaiReq) {
  const { model, messages, max_tokens, temperature, tools, stream, reasoning_effort, tool_choice, parallel_tool_calls, prompt_cache_key } = openaiReq;

  // Extract the system prompt: OpenAI’s system and developer messages both map onto it
  // Array-style content must be flattened to text and joined into a *string*, not turned into a JSON string,
  // and certainly not emitted as an Anthropic-style content-block array: the upstream insists that
  // params.system is always a string, and rejects arrays outright (verified against the live service:
  // Validation error: Invalid input: expected string, received array at "params.system").
  const systemMsgs = messages.filter(m => m.role === 'system' || m.role === 'developer');
  const systemPrompt = systemMsgs.map(m => {
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) return m.content.map(c => c?.text ?? c?.content ?? '').join('\n');
    return m.content == null ? '' : String(m.content);
  }).join('\n');
  const chatMessages = messages.filter(m => m.role !== 'system' && m.role !== 'developer');

  // Build tool_call_id → tool_name reverse lookup
  const toolNameMap = {};
  for (const msg of chatMessages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (tc.id) {
          toolNameMap[tc.id] = tc.function?.name || '';
        }
      }
    }
  }

  // Convert messages into CC format
  const ccMessages = chatMessages.map(msg => {
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        return { role: 'user', content: [{ type: 'text', text: msg.content }] };
      }
      // Multimodal: pass array content straight through (text + image_url → CC image format)
      if (Array.isArray(msg.content)) {
        const parts = msg.content.map(part => {
          if (part.type === 'image_url') {
            const url = part.image_url?.url || '';
            // The real CC CLI format: { type: "image", image: "data:image/jpeg;base64,..." }
            return { type: 'image', image: url };
          }
          return part;
        }).filter(Boolean);
        return { role: 'user', content: parts };
      }
      return { role: 'user', content: [{ type: 'text', text: String(msg.content) }] };
    }
    if (msg.role === 'assistant') {
      const parts = [];
      // Thinking content must travel back: in thinking mode CC verifies that reasoning comes with the history,
      // and dropping it makes the upstream refuse the request. The order must match the CLI’s captured traffic —
      // [reasoning, text, tool-call], with reasoning first.
      if (msg.reasoning_content) {
        parts.push({ type: 'reasoning', text: msg.reasoning_content });
      }
      if (msg.content && typeof msg.content === 'string') {
        if (msg.content) parts.push({ type: 'text', text: msg.content });
      } else if (msg.content && Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (!part) continue;
          if (part.type === 'text') parts.push(part);
          // Pass reasoning through when the client puts it inside the content array instead;
          // do not duplicate it when reasoning_content is already present
          else if (part.type === 'reasoning' && !msg.reasoning_content) parts.push(part);
        }
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          parts.push({
            type: 'tool-call',
            toolCallId: tc.id,
            toolName: tc.function?.name || '',
            input: (typeof tc.function?.arguments === 'string' ? tryParseJSON(tc.function.arguments) : (tc.function?.arguments || {})),
          });
        }
      }
      return { role: 'assistant', content: parts };
    }
    if (msg.role === 'tool') {
      return {
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: msg.tool_call_id,
          toolName: toolNameMap[msg.tool_call_id] || msg.name || '',
          output: { type: 'text', value: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) },
        }],
      };
    }
    // Unknown roles: normalise to user and make sure content is an array, so CC validation does not reject it
    return { role: 'user', content: [{ type: 'text', text: String(msg.content ?? '') }] };
  });

  if (ccMessages.some((m) => m.role === 'tool' || (Array.isArray(m.content) && m.content.some((part) => part && part.type === 'tool-call')))) {
    const summary = ccMessages.map((m) => {
      if (m.role === 'tool') return 'tool:' + (Array.isArray(m.content) && m.content[0] ? m.content[0].toolCallId : '?');
      if (Array.isArray(m.content)) { const calls = m.content.filter((part) => part && part.type === 'tool-call').map((part) => part.toolCallId); if (calls.length) return 'assistant:' + calls.join('|'); }
      return m.role;
    });
    log('info', 'CC tool history', { messages: summary.slice(-40) });
  }

  const hasMessageCacheMarker = ccMessages.some(msg =>
    Array.isArray(msg.content) && msg.content.some(part => part?.cache_control));
  if (prompt_cache_key && !hasMessageCacheMarker) {
    const firstUserMessage = ccMessages.find(msg => msg.role === 'user' && Array.isArray(msg.content));
    const cacheBoundary = firstUserMessage?.content.findLast(part => part?.type === 'text');
    if (cacheBoundary) cacheBoundary.cache_control = { type: 'ephemeral' };
  }

  const threadId = newThreadId();

  const body = {
    config: {
      workingDir: process.cwd(),
      date: getDateStr(),
      environment: getEnvironment(),
      structure: [],
      isGitRepo: false,
      currentBranch: '',
      mainBranch: '',
      gitStatus: '',
      recentCommits: [],
    },
    memory: null,
    taste: null,
    skills: '',
    permissionMode: 'standard',
    params: {
      model: model || 'deepseek/deepseek-v4-flash',
      messages: ccMessages,
      max_tokens: Math.min(max_tokens || 64000, 200000),
      stream: true,  // the CC API always streams
    },
  };

  // Conditional fields
  if (systemPrompt) {
    body.params.system = systemPrompt;
  } else if (CFG.emptySystemPlaceholder) {
    // When params.system is absent, the upstream injects its own ~7.5K-token default prompt (entering the
    // default context/prefix path), which both burns cached tokens and pollutes the conversation (the model
    // thinks it is sitting in CC’s own executable directory — see issue #17). A single space bypasses it;
    // measured on the live service, prompt_tokens dropped from 7653 to 85.
    // On by default; disable with "emptySystemPlaceholder": false in config.json or
    // 繁中：params.system 缺省時上游會注入約 7.5K token 的預設提示詞（污染對話又耗 cached token）；送一個空格即可繞過（實測 prompt_tokens 7653 → 85）。
    body.params.system = ' ';
  }
  if (temperature !== undefined) {
    body.params.temperature = temperature;
  }
  if (reasoning_effort !== undefined) {
    const eff = normaliseReasoningEffort(reasoning_effort);
    if (eff) body.params.reasoning_effort = eff;
  }
  if (tools && tools.length > 0) {
    body.params.tools = tools.map(t => ({
      type: t.type || 'function',
      name: t.function?.name || t.name || '',
      description: t.function?.description || t.description || '',
      input_schema: t.function?.parameters || t.input_schema || { type: 'object', properties: {} },
    }));
  }
  if (tool_choice !== undefined) {
    const isNone = (typeof tool_choice === 'string' && tool_choice === 'none') || (tool_choice && typeof tool_choice === 'object' && tool_choice.type === 'none');
    if (isNone) {
      // The upstream accepts only tool_choice.type = auto|any|tool; sending none answers 400.
      // 繁中：上游只接受 auto|any|tool，送 none 會 400；改成「完全不提供 tools」，語意相同。
      delete body.params.tools;
      delete body.params.tool_choice;
    } else
    // OpenAI format → CC (Anthropic-style) format
    if (typeof tool_choice === 'string') {
      const map = { 'auto': 'auto', 'none': 'none', 'required': 'any' };
      body.params.tool_choice = { type: map[tool_choice] || 'auto' };
    } else if (tool_choice.type === 'function') {
      // OpenAI object → Anthropic object
      body.params.tool_choice = { type: 'tool', name: tool_choice.function?.name };
    } else {
      body.params.tool_choice = tool_choice;
    }
  }
  if (parallel_tool_calls !== undefined) {
    body.params.parallel_tool_calls = parallel_tool_calls;
  }

  return body;
}

function tryParseJSON(str) {
  try { return JSON.parse(str); } catch { return {}; }
}

// ── CC NDJSON → OpenAI SSE / NDJSON 轉 SSE ─────────

function createSseTranslator(model, completionId, created) {
  let chunkIndex = 0;
  let sentRole = false;
  let finishReason = null;
  let usage = null;
  let toolCallIndex = 0;

  return {
    lastCcEvent: '',
    upstreamError: null,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    /** Parse one NDJSON line and return an array of OpenAI chunks */
    parseLine(line) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === '[DONE]' || trimmed.startsWith(':')) return null;

      let event;
      try { event = JSON.parse(trimmed); } catch { return null; }
      if (!event.type) return null;
      this.lastCcEvent = event.type;

      const out = [];

      switch (event.type) {
        case 'text-start':
        case 'reasoning-start':
        case 'start':
        case 'start-step':
          // Ignored — nothing user-visible
          break;

        case 'text-delta': {
          const text = event.text || event.delta || '';
          if (!text) break;
          const delta = chunkIndex === 0 ? { role: 'assistant', content: text } : { content: text };
          chunkIndex++;
          sentRole = true;
          out.push(makeChunk(completionId, created, model, delta, null, null));
          break;
        }

        case 'reasoning-delta': {
          const text = event.text || '';
          if (!text) break;
          const delta = chunkIndex === 0
            ? { role: 'assistant', reasoning_content: text }
            : { reasoning_content: text };
          chunkIndex++;
          out.push(makeChunk(completionId, created, model, delta, null, null));
          break;
        }

        case 'tool-call': {
          const id = event.toolCallId || `call_${Date.now()}_${toolCallIndex}`;
          const name = event.toolName || '';
          const args = typeof event.input === 'string' ? event.input : JSON.stringify(event.input || {});
          const tcEntry = { index: toolCallIndex, id, type: 'function', function: { name, arguments: args } };
          const delta = chunkIndex === 0
            ? { role: 'assistant', content: null, tool_calls: [tcEntry] }
            : { tool_calls: [tcEntry] };
          chunkIndex++;
          toolCallIndex++;
          out.push(makeChunk(completionId, created, model, delta, null, null));
          break;
        }

        case 'finish-step': {
          if (event.finishReason) finishReason = mapFinishReason(event.finishReason);
          if (event.usage) {
            usage = event.usage;
            this.inputTokens = event.usage.inputTokens ?? 0;
            this.outputTokens = event.usage.outputTokens ?? 0;
            this.cachedInputTokens = event.usage.cachedInputTokens ?? 0;
          }
          break;
        }

        case 'finish': {
          const fr = finishReason || mapFinishReason(event.finishReason || 'stop');
          const u = event.totalUsage || usage || {};
          normaliseUsage(u);
          this.inputTokens = u.inputTokens ?? 0;
          this.outputTokens = u.outputTokens ?? 0;
          this.cachedInputTokens = u.cachedInputTokens ?? 0;
          const openaiUsage = u ? {
            prompt_tokens: u.inputTokens ?? 0,
            completion_tokens: u.outputTokens ?? 0,
            total_tokens: (u.inputTokens ?? 0) + (u.outputTokens ?? 0),
            prompt_tokens_details: { cached_tokens: u.cachedInputTokens ?? 0 },
          } : undefined;
          out.push(makeChunk(completionId, created, model, {}, fr, openaiUsage));
          break;
        }

        case 'error': {
          const msg = event.error?.message || event.message || 'Unknown error';
          log('warn', 'CC stream error', { message: msg });
          this.upstreamError = mapCcEventError(event);
          // Don't emit a finish_reason chunk — let the natural stream termination
          // handle it. Otherwise a subsequent finish(tool_calls) would be ignored
          // by downstream agent loops that stop at the first finish_reason.
          break;
        }

        case 'reasoning-end': case 'provider-metadata': case 'tool-input-start': case 'tool-input-delta': case 'tool-input-end': case 'tool-error': case 'text-end':
          // Silent - no user-visible content
          break;
        default:
          log('warn', 'Unknown CC event type', { type: event.type });
          break;
      }

      return out.length > 0 ? out : null;
    },

    /** Get the SSE terminator */
    getDoneEvent() {
      return 'data: [DONE]\n\n';
    },
  };
}

function makeChunk(id, created, model, delta, finishReason, usage) {
  const chunk = {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason || null }],
  };
  if (usage) chunk.usage = usage;
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

// normalise CC usage stats:
// - outputTokens=0 → zero everything (anti false billing)
function normaliseUsage(u) {
  if (!u) return;
  const ot = Number(u.outputTokens);
  if (!ot) {  // 0, null, undefined, NaN → zero input + cached (anti false billing)
    u.inputTokens = 0;
    u.cachedInputTokens = 0;
  }
}

// CC’s inputTokens is a *total* (cache hits included), whereas Anthropic’s input_tokens counts only
// the non-cached part — as the official SDK notes: "Total input tokens in a request is the summation of
// `input_tokens`, `cache_creation_input_tokens`, and `cache_read_input_tokens`.
// Forwarding CC’s inputTokens as input_tokens makes downstream clients treat the two as disjoint,
// so they add up to roughly twice the real input (issue #25).
//
// CC already computes what we need: inputTokenDetails.noCacheTokens (measured: noCacheTokens + cacheReadTokens
// 繁中：CC 的 inputTokens 已含快取命中，而 Anthropic 的 input_tokens 只算非快取；直接轉發會讓下游相加約為真實輸入兩倍（issue #25）。優先用 noCacheTokens，缺失時退迴減法。
function anthropicInputTokens(usage, noCacheOverride) {
  const u = usage || {};
  if (typeof noCacheOverride === 'number' && noCacheOverride >= 0) return noCacheOverride;
  const noCache = u.inputTokenDetails && u.inputTokenDetails.noCacheTokens;
  if (typeof noCache === 'number' && noCache >= 0) return noCache;
  const cacheRead = u.cachedInputTokens || (u.inputTokenDetails && u.inputTokenDetails.cacheReadTokens) || 0;
  const cacheWrite = (u.inputTokenDetails && u.inputTokenDetails.cacheWriteTokens) || 0;
  return Math.max(0, (u.inputTokens || 0) - cacheRead - cacheWrite);
}

function mapFinishReason(reason) {
  switch (reason) {
    case 'tool-calls': return 'tool_calls';
    case 'length': return 'length';
    case 'stop': return 'stop';
    default: return reason || 'stop';
  }
}

// ── Error mapping / 錯誤映射 ────────────────────────
const CC_STATUS_MAP = {
  400: { status: 400, type: 'invalid_request_error' },
  401: { status: 401, type: 'authentication_error' },
  402: { status: 429, type: 'rate_limit_error' },       // payment required → rate limit
  403: { status: 401, type: 'authentication_error' },
  404: { status: 404, type: 'not_found' },
  422: { status: 400, type: 'invalid_request_error' },
  429: { status: 429, type: 'rate_limit_error' },
  500: { status: 502, type: 'upstream_error' },
  502: { status: 502, type: 'upstream_error' },
  503: { status: 503, type: 'temporarily_unavailable' },
};

function mapCcError(ccStatus, ccBody) {
  const mapped = CC_STATUS_MAP[ccStatus] || { status: 502, type: 'upstream_error' };
  let message = `CC API error (${ccStatus})`;

  if (ccBody) {
    try {
      const parsed = JSON.parse(ccBody);
      message = parsed.error?.message || parsed.message || message;
    } catch {
      message = ccBody.slice(0, 200) || message;
    }
  }

  // A CC 429 may carry retry-after
  if (ccStatus === 429) {
    return {
      status: 429,
      body: {
        error: { message, type: 'rate_limit_error' },
        retry_after: 30,
      },
    };
  }

  return { status: mapped.status, body: { error: { message, type: mapped.type } } };
}

function mapCcEventError(event) {
  const message = event.error?.message || event.message || 'Unknown CC error';
  const statusMatch = message.match(/^<(\d{3})>/);
  const ccStatus = statusMatch ? Number(statusMatch[1]) : 502;
  const mapped = CC_STATUS_MAP[ccStatus] || { status: 502, type: 'upstream_error' };

  // Keep this consistent with mapCcError: carry retry_after when the final status is 429,
  // otherwise client SDKs get no back-off hint (402 maps to 429 as well, treated the same)
  if (mapped.status === 429) {
    return {
      status: 429,
      body: { error: { message, type: 'rate_limit_error' }, retry_after: 30 },
    };
  }

  return { status: mapped.status, body: { error: { message, type: mapped.type } } };
}

// ── HTTP request handling / HTTP 請求處理 ───────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalSize = 0;
    let settled = false;
    let drained = 0;
    // After a 413, switch to drain mode: keep reading and discarding the rest of the body so the keep-alive
    // connection stays reusable, and make sure the client actually sees a 413 rather than a connection reset (issue #7).
    // 繁中：413 後進入排空模式，讓 keep-alive 可重用、客戶端明確收到 413 而非連線重置；超過 DRAIN_LIMIT 則強制切斷。
    const DRAIN_LIMIT = 32 * 1024 * 1024;
    req.on('data', c => {
      if (settled) {
        drained += c.length;
        if (drained > DRAIN_LIMIT) { try { req.destroy(); } catch {} }
        return;
      }
      totalSize += c.length;
      if (totalSize > MAX_BODY_SIZE) {
        settled = true;
        chunks.length = 0;
        const mb = Math.round(MAX_BODY_SIZE / 1024 / 1024);
        const err = new Error(`Request body exceeds ${mb}MB limit`);
        err.statusCode = 413;
        reject(err);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', e => { if (!settled) { settled = true; reject(e); } });
  });
}

// Downstream backpressure: res.write() returning false means the socket write buffer passed highWaterMark (the consumer is behind).
// Ignoring it lets the whole upstream stream pile up in memory — with a client that never reads, RSS grows with the stream (issue #20).
// Listen for close/error as well, or a client disconnect leaves the request coroutine parked for ever.
// With CLIENT_DRAIN_TIMEOUT_MS > 0 an extra idle watchdog destroys the response on timeout,
// 繁中：忽略 res.write() 的 false 會讓上游流在記憶體無界堆積（issue #20）；必須同時監聽 close/error，否則客戶端斷線會讓協程永久掛住。
function waitDrain(res) {
  if (!res.writableNeedDrain) return Promise.resolve();
  return new Promise((resolve) => {
    let timer = null;
    const done = () => {
      res.off('drain', done); res.off('close', done); res.off('error', done);
      if (timer) { clearTimeout(timer); timer = null; }
      resolve();
    };
    res.once('drain', done); res.once('close', done); res.once('error', done);
    if (CLIENT_DRAIN_TIMEOUT_MS > 0) {
      timer = setTimeout(() => {
        log('warn', 'Client stalled on backpressure, dropping connection', {
          path: res.req?.url || '(unknown)',
          timeoutMs: CLIENT_DRAIN_TIMEOUT_MS,
          bufferedBytes: res.writableLength,
        });
        try { res.destroy(); } catch {}
        done();
      }, CLIENT_DRAIN_TIMEOUT_MS);
    }
  });
}

// Upstream read-idle watchdog: one shared timer, instead of “a fresh setTimeout per chunk that is never cleared”.
// Measured cost is ~225B per pending timer; steady state = throughput × timeout window × chunks per response × 225B
// (50 rps × 2000 chunks × 30s ≈ 644MB; the 90s non-streaming window is about three times that).
// 繁中：單一定時器重複使用，避免「每個 chunk 新建 setTimeout 且從不清理」的記憶體滯留；arm() 以 refresh() 把窗口重設為本輪 read 開始。
function createIdleWatchdog(timeoutMs) {
  let rejectFn = null;
  const expired = new Promise((_, reject) => { rejectFn = reject; });
  expired.catch(() => {}); // avoid an unhandledRejection if the timer fires after the read loop has finished
  const timer = setTimeout(() => rejectFn(new Error('STREAM_IDLE_TIMEOUT')), timeoutMs);
  return {
    arm() { timer.refresh(); return expired; },
    dispose() { clearTimeout(timer); },
  };
}

function sendJSON(res, status, data) {
  const headers = { 'Content-Type': 'application/json' };
  if (data && data.retry_after !== undefined) {
    headers['Retry-After'] = String(data.retry_after);
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(data));
}

function getApiKey(headers) {
  // Try Authorization: Bearer header (OpenAI SDK style)
  const auth = headers['authorization'] || headers['Authorization'] || '';
  if (auth.startsWith('Bearer ')) {
    const match = auth.slice(7).match(/user_[a-zA-Z0-9_-]+/);
    if (match) return match[0];
  }
  // Fall back to x-api-key header (Anthropic SDK style)
  const xKey = headers['x-api-key'] || headers['X-Api-Key'] || '';
  if (xKey) {
    const match = xKey.match(/user_[a-zA-Z0-9_-]+/);
    if (match) return match[0];
  }
  return null;
}

// ── Streaming relay / 串流轉發 ──────────────────────

// 繁中：上游連不上（fetch failed＝DNS/TLS/連線中斷）時重試幾次，網路瞬斷就不用使用者重送。
// English: retry the upstream call when the connection itself fails (DNS/TLS/socket), so a transient
// network hiccup does not turn into a visible error for the client.
async function forwardToCCWithRetry(body, apiKey, incomingHeaders, signal, promptCacheKey, attempts = 3) {
  let lastErr = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await forwardToCC(body, apiKey, incomingHeaders, signal, promptCacheKey);
    } catch (e) {
      lastErr = e;
      if (signal && signal.aborted) throw e;
      log('warn', 'Upstream fetch failed — retrying', { attempt: i, of: attempts, error: String((e && e.message) || e) });
      if (i < attempts) await new Promise((r) => setTimeout(r, 700 * i));
    }
  }
  throw lastErr;
}

async function forwardToCC(body, apiKey, incomingHeaders = {}, signal, promptCacheKey) {
  const url = `${CFG.apiBase}/alpha/generate`;
  const traceparent = generateTraceparent();
  const sessionId = getSessionId(incomingHeaders, apiKey, promptCacheKey);

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
    'x-cli-environment': 'production',
    'x-command-code-version': CC_VERSION,
    'x-session-id': sessionId,
    'x-co-flag': 'false',
    'x-taste-learning': 'false',
    'x-project-slug': fakeProjectSlug(sessionId),
    'traceparent': traceparent,
  };

  if (CFG.zdr || incomingHeaders['x-cmd-zdr'] === '1') {
    headers['x-cmd-zdr'] = '1';
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });

  return response;
}

// ── Routing / 路由 ──────────────────────────────────

async function handleChatCompletions(req, res) {
  let openaiReq;
  try {
    openaiReq = await readBody(req);
  } catch (e) {
    if (e.statusCode === 413) {
      sendJSON(res, 413, { error: { message: e.message, type: 'invalid_request_error' } });
      return;
    }
    sendJSON(res, 400, { error: { message: 'Invalid JSON body', type: 'invalid_request_error' } });
    return;
  }

  const apiKey = getApiKey(req.headers);
  if (!apiKey) {
    sendJSON(res, 401, { error: { message: 'Missing API key. Send in Authorization: Bearer <key> or x-api-key header', type: 'auth_error' } });
    return;
  }

  const stream = openaiReq.stream === true;
  const model = openaiReq.model || 'deepseek/deepseek-v4-flash';
  const completionId = `chatcmpl-${randomUUID().slice(0, 12)}`;
  const created = nowUnix();

  // Build the CC request body
  const ccBody = buildCcRequest(openaiReq);

  // AbortController so a client disconnect really does abort the CC upstream (the pi-commandcode-provider pattern)
  const abortController = new AbortController();
  let aborted = false;
  // Initialised early so the disconnect callback and timeout handler can reference it safely (no block-scope ReferenceError)
  const startTime = Date.now();
  let bytesReceived = 0; let lastCcEvent = ''; let keepaliveCount = 0; let fullText = '';
  let reader = null;
  let translator = null;

  try {
    // First-time initialisation (fingerprint + lifecycle)
    await ensureInitialized(apiKey, abortController.signal);
    // Forward to the CC API (client headers are passed in so the session ID can be extracted)
    const ccResponse = await forwardToCCWithRetry(ccBody, apiKey, req.headers, abortController.signal, openaiReq.prompt_cache_key);

    if (!ccResponse.ok) {
      const errorText = await ccResponse.text().catch(() => '');
      log('error', 'CC API error', { status: ccResponse.status, body: String(errorText).slice(0, 200) });
      const mapped = mapCcError(ccResponse.status, errorText);
      sendJSON(res, mapped.status, mapped.body);
      return;
    }

    // Downstream disconnect detection: abort the CC upstream and log it
    res.on('close', () => {
      if (res.writableEnded) return; // Normal completion, not a disconnect
      aborted = true;
      const reason = lastCcEvent?.startsWith('tool-input') ? 'tool-input-silent-timeout'
        : lastCcEvent?.includes('delta') ? 'streaming-active-disconnect'
        : 'client-hangup';
      abortController.signal.aborted || log('warn', 'Client disconnected', {
        path: '/v1/chat/completions',
        model, completionId, reason,
        streaming: stream,
        elapsedMs: Date.now() - startTime,
        bytesSent: bytesReceived,
        lastCcEvent: lastCcEvent || '(none)',
        keepaliveCount,
        inputTokens: translator?.inputTokens ?? 0,
        outputTokens: translator?.outputTokens ?? 0,
        cachedInputTokens: translator?.cachedInputTokens ?? 0,
      });
      if (!abortController.signal.aborted) {
        // Before disconnecting, fire a terminal chunk with usage=0 so downstream does not estimate tokens itself
        try {
          res.write(`data: ${JSON.stringify({
            id: completionId,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } },
          })}\n\n`);
          res.write('data: [DONE]\n\n');
        } catch {}
        try { abortController.abort(); } catch {}
      }
    });

    if (stream) {
      // ── Streaming response ──
      translator = createSseTranslator(model, completionId, created);
      let buffer = '';
      // 繁中：延後送出 200 標頭，讓逾時／零輸出時能改回 JSON 429/502，交由 SDK 自動重試。
      let started = false; // delay the 200 header so timeouts/zero output can be answered as JSON 429/502 and retried by the SDK
      const decoder = new TextDecoder();
      reader = ccResponse.body.getReader();

      const idle = createIdleWatchdog(STREAM_IDLE_TIMEOUT_MS);
      try {
        while (true) {
          const result = await Promise.race([reader.read(), idle.arm()]);
          const { done, value } = result;
          if (done) break;
          if (aborted) break;
          bytesReceived += value.length;

          const chunkText = decoder.decode(value, { stream: true });
          buffer += chunkText;
          // Split only when the new data contains a newline: the buffer never retains a newline, so no newline means no complete line.
          // 繁中：只在收到換行時才切分，避免對不斷增長的單行反覆全量 split（O(n²) → O(n)）。
          let lines = [];
          if (chunkText.indexOf('\n') !== -1) {
            lines = buffer.split('\n');
            buffer = lines.pop() || '';
          }

          let hadOutput = false;
          for (const line of lines) {
            const events = translator.parseLine(line);
            if (events) {
              if (!started) {
                res.writeHead(200, {
                  'Content-Type': 'text/event-stream',
                  'Cache-Control': 'no-cache',
                  'Connection': 'keep-alive',
                  'X-Accel-Buffering': 'no',
                });
                started = true;
              }
              for (const evt of events) res.write(evt);
              await waitDrain(res);
              hadOutput = true;
            }
            if (translator.lastCcEvent) lastCcEvent = translator.lastCcEvent;
          }
          // Send keepalives during silent periods so the client does not time out and disconnect
          if (started && !hadOutput) {
            try { res.write(': keepalive\n\n'); keepaliveCount++; } catch {}
            await waitDrain(res);
          }
        }

        if (!aborted) {
          // A request completed successfully: reset the consecutive-timeout counter
          consecutiveTimeouts = 0;
          // Handle whatever is left in the buffer
          if (buffer.trim()) {
            const events = translator.parseLine(buffer);
            if (events) {
              if (!started) started = true;
              for (const evt of events) res.write(evt);
              await waitDrain(res);
            }
          }
          if (translator.upstreamError) {
            if (!started) {
              sendJSON(res, translator.upstreamError.status, translator.upstreamError.body);
              return;
            }
            try { res.write(`data: ${JSON.stringify(translator.upstreamError.body)}\n\n`); } catch {}
          // Zero output tokens is treated as an error, so downstream is not billed oddly
          } else if (translator.outputTokens === 0) {
            try { if (!abortController.signal.aborted) abortController.abort(); } catch {}
            if (!started) {
              sendJSON(res, 429, { error: { message: 'Empty response from upstream (zero output tokens)', type: 'rate_limit_error' }, retry_after: 10 });
              return;
            }
            try { res.write(`data: ${JSON.stringify({ error: { message: 'Empty response from upstream (zero output tokens)', type: 'rate_limit_error' }, retry_after: 10 })}\n\n`); } catch {}
          } else {
            if (!started) {
              res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no',
              });
              started = true;
            }
            res.write(translator.getDoneEvent());
          }
        }
      } catch (e) {
        if (aborted) {
          // Client already gone: just clean up (the close handler has already called abortController.abort())
          try { reader.cancel(); } catch {}
        } else if (e.message === 'STREAM_IDLE_TIMEOUT') {
          log('warn', 'Stream idle timeout', {
            path: '/v1/chat/completions',
            model,
            streaming: true,
            timeoutMs: STREAM_IDLE_TIMEOUT_MS,
            elapsedMs: Date.now() - startTime,
            id: completionId,
            bytesReceived,
            lastCcEvent: lastCcEvent || '(none)',
            inputTokens: translator.inputTokens,
            outputTokens: translator.outputTokens,
            cachedInputTokens: translator.cachedInputTokens,
          });
          try { reader.cancel(); } catch {}
          try { abortController.abort(); } catch {} // abort the CC upstream so we stop burning tokens
          consecutiveTimeouts++;
          const timeoutMsg = consecutiveTimeouts >= TIMEOUT_REDUCE_CONTEXT_THRESHOLD
            ? 'Response timeout - try reducing context length (summarize earlier messages)'
            : 'Response timeout - request timed out';
          if (!started) {
            sendJSON(res, 429, { error: { message: timeoutMsg, type: 'rate_limit_error', input_tokens: 0 }, retry_after: 5 });
            return;
          }
          if (!res.writableEnded) {
            // 繁中：用 res.end() 收尾，剛寫入的錯誤事件才送得出去（destroy 會把它一起丟掉）。
            // English: end the response so the error frame reaches the client — destroy would drop it.
            try { res.write(`data: ${JSON.stringify({ error: { message: timeoutMsg, type: 'rate_limit_error' }, retry_after: 5 })}\n\n`); } catch {}
            try { res.end(); } catch {}
          }
        } else {
          log('error', 'Stream error', { message: e.message });
          try { abortController.abort(); } catch {} // abort the CC upstream
          if (!started) {
            sendJSON(res, 502, { error: { message: `Upstream error: ${e.message}`, type: 'proxy_error', input_tokens: 0 }, retry_after: 10 });
            return;
          }
          if (!res.writableEnded) {
            try { res.write(`data: ${JSON.stringify({ error: { message: e.message, type: 'proxy_error' } })}\n\n`); } catch {}
          }
        }
      } finally {
        idle.dispose();
      }

      if (!res.writableEnded) res.end();
    } else {
      // ── Non-streaming response (buffer the whole NDJSON) ──
      let reasoningContent = '';
      let finishReason = 'stop';
      let usage = null;
      let toolCalls = null;
      let upstreamError = null;

      reader = ccResponse.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      const processLines = () => {
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === '[DONE]' || trimmed.startsWith(':')) continue;
          try {
            const event = JSON.parse(trimmed);
            switch (event.type) {
              case 'text-delta': lastCcEvent = event.type; fullText += event.text || ''; break;
              case 'reasoning-delta': lastCcEvent = event.type; reasoningContent += event.text || ''; break;
              case 'tool-call':
                lastCcEvent = event.type;
                toolCalls = toolCalls || [];
                toolCalls.push({
                  id: event.toolCallId || ('call_' + randomUUID().slice(0, 8)),
                  type: 'function',
                  function: {
                    name: event.toolName || '',
                    arguments: typeof event.input === 'string' ? event.input : JSON.stringify(event.input || {}),
                  },
                });
                break;
              case 'finish':
                lastCcEvent = event.type;
                finishReason = mapFinishReason(event.finishReason || 'stop');
                if (event.totalUsage) usage = event.totalUsage;
                break;
              case 'error':
                lastCcEvent = event.type;
                log('warn', 'CC stream error (non-stream)', { message: event.error?.message || event.message });
                upstreamError = mapCcEventError(event);
                break;
              case 'reasoning-end': case 'provider-metadata': case 'tool-input-start': case 'tool-input-delta': case 'tool-input-end': case 'tool-error': case 'text-end':
                // Silent - no user-visible content
                break;
              default:
                log('warn', 'Unknown CC event type', { type: event.type });
                break;
            }
          } catch {}
        }
      };

      const idle = createIdleWatchdog(NONSTREAM_IDLE_TIMEOUT_MS);
      while (true) {
        const result = await Promise.race([reader.read(), idle.arm()]);
        const { done, value } = result;
        if (done) break;
        bytesReceived += value.length;
        const chunkText = decoder.decode(value, { stream: true });
        buf += chunkText;
        // Without a newline no complete line can exist, so skip the full split (see the same note in the streaming section)
        if (chunkText.indexOf('\n') !== -1) processLines();
      }
      idle.dispose();
      processLines();

      if (upstreamError) {
        sendJSON(res, upstreamError.status, upstreamError.body);
        return;
      }

      // Zero output tokens is treated as an error, so downstream is not billed oddly
      if ((usage?.outputTokens ?? 0) === 0) {
        try { if (!abortController.signal.aborted) abortController.abort(); } catch {}
        sendJSON(res, 429, { error: { message: 'Empty response from upstream (zero output tokens)', type: 'rate_limit_error' }, retry_after: 10 });
        return;
      }

      consecutiveTimeouts = 0;
      sendJSON(res, 200, {
        id: completionId,
        object: 'chat.completion',
        created,
        model,
        choices: [{
          index: 0,
          message: Object.assign(
            { role: 'assistant', content: fullText || null },
            toolCalls ? { tool_calls: toolCalls } : {},
            reasoningContent ? { reasoning_content: reasoningContent } : {},
          ),
          finish_reason: finishReason,
        }],
    usage: (() => {
      if (!usage) usage = {};
      normaliseUsage(usage);
      return {
        prompt_tokens: usage.inputTokens ?? 0,
        completion_tokens: usage.outputTokens ?? 0,
        total_tokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
        prompt_tokens_details: { cached_tokens: usage.cachedInputTokens ?? 0 },
      };
    })(),
      });
    }
  } catch (e) {
    if (abortController.signal.aborted) {
      log('warn', 'Request cancelled (client disconnected before CC response)', {
        path: '/v1/chat/completions',
        model,
        completionId,
      });
    } else if (e.message === 'STREAM_IDLE_TIMEOUT') {
      log('warn', 'Stream idle timeout', {
        path: '/v1/chat/completions',
        model,
        streaming: false,
        timeoutMs: NONSTREAM_IDLE_TIMEOUT_MS,
        elapsedMs: Date.now() - startTime,
        id: completionId,
        bytesReceived,
        lastCcEvent: lastCcEvent || '(none)',
        partialLen: fullText ? fullText.length : 0,
      });
      try { reader?.cancel(); } catch {}
      try { abortController.abort(); } catch {} // abort the CC upstream
      consecutiveTimeouts++;
      const timeoutMsg = consecutiveTimeouts >= TIMEOUT_REDUCE_CONTEXT_THRESHOLD
        ? 'Response timeout - try reducing context length (summarize earlier messages)'
        : 'Response timeout - request timed out';
      res.setHeader('Retry-After', '5');
      sendJSON(res, 429, { error: { message: timeoutMsg, type: 'rate_limit_error', input_tokens: 0 }, retry_after: 5 });
    } else {
      log('error', 'Upstream error', { message: e.message });
      try { abortController.abort(); } catch {} // abort the CC upstream
      sendJSON(res, 502, { error: { message: `Upstream error: ${e.message}`, type: 'proxy_error', input_tokens: 0 }, retry_after: 10 });
    }
  }
}

// ── Anthropic /v1/messages conversion / 協定轉換 ───

function mapAnthropicStopReason(finishReason) {
  switch (finishReason) {
    case 'tool_calls': return 'tool_use';
    case 'length': return 'max_tokens';
    case 'stop': return 'end_turn';
    default: return 'end_turn';
  }
}

// Generate a Claude-format fake signature for thinking blocks.
// Anthropic validates thinking signatures cryptographically; third-party
// proxies cannot mint valid ones. Claude Code's shallow check only requires
// base64 starting with 'E' (single-layer) / 'R' (double-layer) with payload
// first byte 0x12 — this satisfies that, letting CC display thinking.
// The payload is derived from the thinking text so each block's signature
// differs (closer to spec, avoids identical-signature quirks).
function fakeThinkingSignature(thinkingText) {
  const seed = crypto.createHash('sha256').update(thinkingText || 'dsh-proxy-thinking').digest().subarray(0, 64);
  const raw = Buffer.concat([Buffer.from([0x12, seed.length]), seed]);
  return raw.toString('base64');
}

function buildAnthropicResponse(model, fullText, toolCalls, finishReason, usage, thinkingText) {
  const content = [];
  if (thinkingText) content.push({ type: 'thinking', thinking: thinkingText, signature: fakeThinkingSignature(thinkingText) });
  if (fullText) content.push({ type: 'text', text: fullText });
  if (toolCalls) {
    for (const tc of toolCalls) {
      let input = {};
      try { input = JSON.parse(tc.function.arguments); } catch { input = {}; }
      content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
    }
  }
  return {
    id: `msg_${randomUUID().slice(0, 12)}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: mapAnthropicStopReason(finishReason || 'stop'),
    stop_sequence: null,
    usage: (() => {
      normaliseUsage(usage || {});
      // When CC reports no usage, estimate output tokens from the content length so clients do not show/report zero
      const estOut = Math.max(1,
        Math.ceil(((fullText || '').length + (thinkingText || '').length) / 4) + (toolCalls ? toolCalls.length * 20 : 0));
      return {
        // 繁中：input_tokens 只計非快取部分（Anthropic 語意），與 cache_* 相加才是總輸入。
        input_tokens: anthropicInputTokens(usage),
        output_tokens: usage?.outputTokens || estOut,
        cache_creation_input_tokens: usage?.inputTokenDetails?.cacheWriteTokens ?? 0,
        cache_read_input_tokens: usage?.cachedInputTokens ?? 0,
      };
    })(),
  };
}

// Anthropic image blocks (base64 or url) → the data URL / URL used by OpenAI image_url
function anthropicImageUrl(block) {
  const src = block && block.source ? block.source : null;
  if (!src) return '';
  if (src.type === 'base64' && src.data) return 'data:' + (src.media_type || 'image/png') + ';base64,' + src.data;
  if (src.type === 'url' && src.url) return src.url;
  return '';
}

function convertAnthropicToOpenAI(anthropicReq) {
  // 1. Extract system prompt (top-level, not in messages array)
  let systemPrompt = '';
  if (anthropicReq.system) {
    if (typeof anthropicReq.system === 'string') {
      systemPrompt = anthropicReq.system;
    } else if (Array.isArray(anthropicReq.system)) {
      systemPrompt = anthropicReq.system
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n');
    }
  }

  // 2. Build tool name map + convert messages
  const toolNameFromId = {};
  const openaiMessages = [];

  if (systemPrompt) {
    openaiMessages.push({ role: 'system', content: systemPrompt });
  }

  const messages = anthropicReq.messages || [];
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      let textContent = '';
      // Anthropic thinking blocks carry the reasoning text, which must become reasoning_content
      // 繁中：Anthropic 的 thinking block 要轉成 reasoning_content 回傳，否則 CC 會因缺少 reasoning 而拒絕。
      let thinkingContent = '';
      const toolCalls = [];
      const blocks = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content || '' }];
      for (const block of blocks) {
        if (block.type === 'text') {
          textContent += block.text || '';
        } else if (block.type === 'thinking') {
          thinkingContent += block.thinking || '';
        } else if (block.type === 'tool_use') {
          toolNameFromId[block.id] = block.name;
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input || {}),
            },
          });
        }
      }
      const assistantMsg = { role: 'assistant', content: textContent || null };
      if (thinkingContent) assistantMsg.reasoning_content = thinkingContent;
      if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
      openaiMessages.push(assistantMsg);
    } else if (msg.role === 'user') {
      let textContent = '';
      const toolResults = [];
      const userImages = [];
      if (typeof msg.content === 'string') {
        textContent = msg.content;
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text') {
            textContent += block.text || '';
          } else if (block.type === 'tool_result') {
            toolResults.push(block);
          } else if (block.type === 'image') {
            const u = anthropicImageUrl(block);
            if (u) userImages.push(u);
          }
        }
      }
      if (textContent) {
        // Held back so tool_results are queued first: OpenAI semantics require tool messages to follow the assistant’s
        // 繁中：OpenAI 語意要求 tool 訊息緊跟 assistant 的 tool_calls；同一則 user 訊息裡的文字要排在工具結果之後。
      }
      for (const tr of toolResults) {
        const toolContent = typeof tr.content === 'string' ? tr.content
          : Array.isArray(tr.content) ? tr.content.map(c => { const u = anthropicImageUrl(c); if (u) userImages.push(u); return c.text || ''; }).join('')
          : String(tr.content || '');
        // The name on an OpenAI tool message is optional; when resuming a session, the tool_use_id may have no
        // matching assistant tool_use (the client trimmed the history), so do not force an empty name —
        // 繁中：恢復對話時可能找不到對應的 tool_use（歷史被裁剪），此時不要硬塞空 name，否則上游會報 "Tool result is missing"（issue #15）。
        const toolMsg = { role: 'tool', tool_call_id: tr.tool_use_id, content: toolContent };
        if (toolNameFromId[tr.tool_use_id]) toolMsg.name = toolNameFromId[tr.tool_use_id];
        openaiMessages.push(toolMsg);
      }
      if (userImages.length) {
        const parts = [];
        if (textContent) parts.push({ type: 'text', text: textContent });
        for (const u of userImages) parts.push({ type: 'image_url', image_url: { url: u } });
        openaiMessages.push({ role: 'user', content: parts });
      } else if (textContent) {
        openaiMessages.push({ role: 'user', content: textContent });
      }
    }
  }

  // 3. Build OpenAI request
  const repairedOpenaiMessages = repairToolCallPairs(openaiMessages);
  const openaiReq = {
    model: anthropicReq.model || 'deepseek/deepseek-v4-flash',
    messages: repairedOpenaiMessages,
    max_tokens: anthropicReq.max_tokens || 64000,
    stream: anthropicReq.stream === true,
  };

  // 4. Map tools
  if (anthropicReq.tools && anthropicReq.tools.length > 0) {
    openaiReq.tools = anthropicReq.tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || { type: 'object', properties: {} },
      },
    }));
  }

  // 5. Map tool_choice
  if (anthropicReq.tool_choice) {
    const tc = anthropicReq.tool_choice;
    if (tc.type === 'auto' || tc.type === undefined) {
      openaiReq.tool_choice = 'auto';
    } else if (tc.type === 'any') {
      openaiReq.tool_choice = 'required';
    } else if (tc.type === 'tool') {
      openaiReq.tool_choice = { type: 'function', function: { name: tc.name } };
    } else if (tc.type === 'none') {
      openaiReq.tool_choice = 'none';
    }
  }

  // 6. Optional params
  if (anthropicReq.temperature !== undefined) openaiReq.temperature = anthropicReq.temperature;
  if (anthropicReq.top_p !== undefined) openaiReq.top_p = anthropicReq.top_p;
  if (anthropicReq.stop_sequences) openaiReq.stop = anthropicReq.stop_sequences;
  if (anthropicReq.metadata?.user_id) openaiReq.user = anthropicReq.metadata.user_id;

  // 7. Anthropic thinking → reasoning_effort (the standard LiteLLM mapping)
  if (anthropicReq.thinking) {
    const t = anthropicReq.thinking;
    if (t.type === 'disabled' || t.type === 'none') {
      // do not send reasoning_effort
    } else if (t.type === 'adaptive') {
      openaiReq.reasoning_effort = t.effort ?? 'medium';
    } else if (t.budget_tokens !== undefined) {
      if (t.budget_tokens >= 10000) openaiReq.reasoning_effort = 'high';
      else if (t.budget_tokens >= 5000) openaiReq.reasoning_effort = 'medium';
      else if (t.budget_tokens >= 2000) openaiReq.reasoning_effort = 'low';
      else openaiReq.reasoning_effort = 'low'; // <2000 → low
    }
  }

  return openaiReq;
}

/**
 * Async generator that reads CC NDJSON response body and yields
 * Anthropic SSE events for streaming.
 */
async function* createAnthropicSseTranslator(response, model, messageId, ctx) {
  let nextBlockIndex = 0;
  let currentBlockIndex = -1;
  let currentBlockType = null;
  let blockStarted = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let cacheWriteTokens = 0;
  let noCacheTokens = -1;   // -1 = the upstream did not provide the field, so fall back to subtraction
  let stopReason = null;
  let hasError = false;
  let currentThinkingText = ''; // accumulated thinking text for the open block

  // Close the current block (text or thinking) if one is active.
  // For thinking blocks, emit a signature_delta (Anthropic standard) before stop.
  function closeBlock() {
    if (blockStarted) {
      const idx = currentBlockIndex;
      const type = currentBlockType;
      let out = '';
      if (type === 'thinking') {
        out += `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: idx, delta: { type: 'signature_delta', signature: fakeThinkingSignature(currentThinkingText) } })}\n\n`;
        currentThinkingText = '';
      }
      blockStarted = false;
      currentBlockType = null;
      return out + `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: idx })}\n\n`;
    }
    return '';
  }
  const closeTextBlock = closeBlock;

  // Open a new block of the given type (closing any previous block first)
  function startBlock(type, contentBlock) {
    if (!blockStarted || currentBlockType !== type) {
      const close = closeBlock();
      currentBlockIndex = nextBlockIndex++;
      currentBlockType = type;
      blockStarted = true;
      return close + `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: currentBlockIndex, content_block: contentBlock })}\n\n`;
    }
    return '';
  }

  // Open a new text block (closing any previous block first)
  function startTextBlock() {
    return startBlock('text', { type: 'text', text: '' });
  }

  // Open a new thinking block (closing any previous block first)
  function startThinkingBlock() {
    return startBlock('thinking', { type: 'thinking', thinking: '' });
  }

  // Emit message_start (always the first event)
  yield `event: message_start\ndata: ${JSON.stringify({
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      content: [],
      model,
      usage: { input_tokens: 0, output_tokens: 0 },
    }
  })}\n\n`;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const idle = createIdleWatchdog(STREAM_IDLE_TIMEOUT_MS);

  try {
    while (true) {
      const result = await Promise.race([reader.read(), idle.arm()]);
      const { done, value } = result;
      if (done) break;
      ctx.bytesReceived += value.length;
      const chunkText = decoder.decode(value, { stream: true });
      buffer += chunkText;
      // As in handleChatCompletions: no newline means no complete line, so skip the full split
      let lines = [];
      if (chunkText.indexOf('\n') !== -1) {
        lines = buffer.split('\n');
        buffer = lines.pop() || '';
      }

      let hadOutput = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === '[DONE]') continue;
        let event;
        try { event = JSON.parse(trimmed); } catch { continue; }
        if (!event.type) continue;
        ctx.lastCcEvent = event.type;

        switch (event.type) {
          case 'start': case 'start-step': case 'text-start': case 'reasoning-start':
            // Signal events, no user-visible data
            break;

          case 'reasoning-delta': {
            // CC reasoning → Anthropic thinking block (Claude Code shows this as thinking)
            const text = event.text || '';
            if (!text) break;
            const startBlock = startThinkingBlock();
            currentThinkingText += text;
            yield startBlock + `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: currentBlockIndex, delta: { type: 'thinking_delta', thinking: text } })}\n\n`;
            hadOutput = true;
            break;
          }

          case 'text-delta': {
            const text = event.text || '';
            const startBlock = startTextBlock();
            yield startBlock + `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: currentBlockIndex, delta: { type: 'text_delta', text } })}\n\n`;
            outputTokens += 1;
            hadOutput = true;
            break;
          }

          case 'tool-call': {
            // Close any pending text block
            const closeBlock = closeTextBlock();
            if (closeBlock) yield closeBlock;

            const id = event.toolCallId || `toolu_${randomUUID().slice(0, 12)}`;
            const name = event.toolName || '';
            const input = typeof event.input === 'string' ? event.input : JSON.stringify(event.input || {});

            const tcIndex = nextBlockIndex++;
            yield `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: tcIndex, content_block: { type: 'tool_use', id, name, input: {} } })}\n\n`;
            yield `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: tcIndex, delta: { type: 'input_json_delta', partial_json: input } })}\n\n`;
            yield `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: tcIndex })}\n\n`;
            outputTokens += 20;
            break;
          }

          case 'finish-step':
          case 'finish': {
            if (event.finishReason) stopReason = mapAnthropicStopReason(event.finishReason);
            const u = event.totalUsage || event.usage;
            if (u) {
              normaliseUsage(u);
              inputTokens = u.inputTokens ?? inputTokens;
              outputTokens = u.outputTokens ?? outputTokens;
              cachedInputTokens = u.cachedInputTokens ?? cachedInputTokens;
              cacheWriteTokens = u.inputTokenDetails?.cacheWriteTokens ?? cacheWriteTokens;
              if (typeof u.inputTokenDetails?.noCacheTokens === 'number') {
                noCacheTokens = u.inputTokenDetails.noCacheTokens;
              }
              ctx.inputTokens = inputTokens;
              ctx.outputTokens = outputTokens;
              ctx.cachedInputTokens = cachedInputTokens;
            }
            // When the upstream reports no usage, keep the local delta-based estimate — clearing it would
            // misjudge a response that did produce content as zero output (triggering 429). Leave unknown fields as they are.
            break;
          }

          case 'error': {
            hasError = true;
            const upstreamError = mapCcEventError(event);
            ctx.upstreamError = upstreamError;
            yield `event: error\ndata: ${JSON.stringify({ type: 'error', error: upstreamError.body.error })}\n\n`;
            break;
          }

          case 'reasoning-end': case 'provider-metadata': case 'tool-input-start': case 'tool-input-delta': case 'tool-input-end': case 'tool-error': case 'text-end':
            // Silent - no user-visible content
            break;
          default:
            log('warn', 'Unknown CC event type', { type: event.type });
            break;
        }
      }
    }

    // Whether or not the upstream reports usage, sync the local counters into ctx (zero-output detection and timeout logs rely on them).
    // Note: ctx.inputTokens holds the upstream’s raw total, for log forensics only;
    // 繁中：本地計數同步進 ctx 供零輸出判定與逾時日誌使用；ctx.inputTokens 是上游原始總數，僅供排查，message_delta 走換算。
    ctx.inputTokens = inputTokens;
    ctx.outputTokens = outputTokens;
    ctx.cachedInputTokens = cachedInputTokens;
    ctx.cacheWriteTokens = cacheWriteTokens;

    // Finalize — close pending text block, emit message_delta + message_stop
    if (!hasError) {
      const closeBlock = closeTextBlock();
      if (closeBlock) yield closeBlock;

      // Zero output tokens is treated as an error, so downstream is not billed oddly
      if (outputTokens === 0) {
        yield `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Empty response from upstream (zero output tokens)' }, retry_after: 10 })}\n\n`;
      } else {
        yield `event: message_delta\ndata: ${JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: stopReason || 'end_turn' },
          usage: {
            output_tokens: outputTokens,
            cache_read_input_tokens: cachedInputTokens,
            cache_creation_input_tokens: cacheWriteTokens || 0,
            // Count only the non-cached part; otherwise downstream adds input + cache_read and gets about double (issue #25)
            input_tokens: noCacheTokens >= 0
              ? noCacheTokens
              : Math.max(0, inputTokens - cachedInputTokens - (cacheWriteTokens || 0)),
          },
        })}\n\n`;

        yield `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`;
      }
    }
  } finally {
    // Make sure the upstream is told when the stream breaks
    idle.dispose();
    try { reader.cancel(); } catch {}
  }
}

function sendAnthropicError(res, status, type, message, retryAfter) {
  const body = { type: 'error', error: { type, message } };
  const headers = { 'Content-Type': 'application/json' };
  if (retryAfter !== undefined) {
    body.retry_after = retryAfter;
    headers['Retry-After'] = String(retryAfter);
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

async function handleMessages(req, res) {
  let anthropicReq;
  try {
    anthropicReq = await readBody(req);
  } catch (e) {
    if (e.statusCode === 413) {
      sendAnthropicError(res, 413, 'invalid_request_error', e.message);
      return;
    }
    sendAnthropicError(res, 400, 'invalid_request_error', 'Invalid JSON body');
    return;
  }

  const apiKey = getApiKey(req.headers);
  if (!apiKey) {
    sendJSON(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'Missing API key. Send in Authorization: Bearer <key> or x-api-key header' } });
    return;
  }

  const stream = anthropicReq.stream === true;
  const model = anthropicReq.model || 'claude-sonnet-4-6';

  // Convert Anthropic → OpenAI → CC
  const openaiReq = convertAnthropicToOpenAI(anthropicReq);
  const ccBody = buildCcRequest(openaiReq);

  const abortController = new AbortController();
  let aborted = false;
  // Initialised early so the disconnect callback and timeout handler can reference it safely (no block-scope ReferenceError)
  const startTime = Date.now();
  let messageId = '';
  let reader = null;
  let bytesReceived = 0; let lastCcEvent = ''; let fullText = '';

  try {
    // First-time initialisation (fingerprint + lifecycle)
    await ensureInitialized(apiKey, abortController.signal);
    const ccResponse = await forwardToCCWithRetry(ccBody, apiKey, req.headers, abortController.signal);

    if (!ccResponse.ok) {
      const errorText = await ccResponse.text().catch(() => '');
      log('error', 'CC API error (Anthropic)', { status: ccResponse.status });
      const mapped = mapCcError(ccResponse.status, errorText);
      sendAnthropicError(res, mapped.status, mapped.body.error.type, mapped.body.error.message);
      return;
    }

    // Downstream disconnect detection: abort the CC upstream and log it
    res.on('close', () => {
      if (res.writableEnded) return; // Normal completion, not a disconnect
      aborted = true;
      if (!abortController.signal.aborted) {
        // Before disconnecting, fire a terminal event with usage=0 so downstream does not estimate tokens itself
        try {
          res.write(`event: message_delta\ndata: ${JSON.stringify({
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 0, input_tokens: 0, cache_read_input_tokens: 0 },
          })}\n\n`);
          res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
        } catch {}
        try { abortController.abort(); } catch {}
      }
      log('warn', 'Client disconnected', {
        path: '/v1/messages',
        model,
        messageId,
        streaming: stream,
        elapsedMs: Date.now() - startTime,
      });
    });

    if (stream) {
      // ── Streaming Anthropic SSE ──
      // Aligned with /v1/chat/completions: send the header as soon as the first upstream event (thinking/text/tool_use)
      // arrives — previously it waited for text_delta, so during a reasoning model’s thinking phase the client saw no
      // bytes at all and tripped its own 60s first-byte timeout (context canceled). message_start is still buffered:
      // with no output at all we can still answer a JSON 429/502 and let the SDK retry (same as the chat endpoint).
      let started = false;
      const buf = [];
      const SSE_HEADERS = {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      };
      const flushBuf = async () => {
        if (!started) {
          res.writeHead(200, SSE_HEADERS);
          started = true;
        }
        for (const ev of buf) { try { res.write(ev); } catch {} }
        buf.length = 0;
        await waitDrain(res);
      };

      // Heartbeat: the equivalent of the chat endpoint’s keepalive comment line, but the Anthropic translator
      // swallows signal events, so an idle timer sends a ping instead (a standard Anthropic event that official
      // SDKs ignore), covering silent windows such as upstream queueing or long thinking.
      let lastSentAt = Date.now();
      const heartbeat = setInterval(() => {
        // Do not keep pushing data at a backed-up downstream: the timer callback is synchronous and cannot await waitDrain,
        // so skip this heartbeat when writableNeedDrain is set (one fewer ping under backpressure does no harm).
        if (started && !aborted && !res.writableEnded && !res.writableNeedDrain && Date.now() - lastSentAt > 15000) {
          try { res.write('event: ping\ndata: {"type":"ping"}\n\n'); lastSentAt = Date.now(); } catch {}
        }
      }, 5000);

      let ctx;
      try {
        messageId = 'msg_' + randomUUID().slice(0, 12);
        ctx = { bytesReceived: 0, lastCcEvent: '', inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, upstreamError: null };
        const generator = createAnthropicSseTranslator(ccResponse, model, messageId, ctx);
        for await (const event of generator) {
          if (aborted) break;
          if (!started && !event.startsWith('event: message_start')) {
            await flushBuf();
          }
          if (started) {
            try { res.write(event); } catch {}
            lastSentAt = Date.now();
            await waitDrain(res);
          } else {
            buf.push(event);
          }
        }

        if (!aborted) {
          consecutiveTimeouts = 0;
          if (ctx.upstreamError) {
            if (!started) {
              sendAnthropicError(
                res,
                ctx.upstreamError.status,
                ctx.upstreamError.body.error.type,
                ctx.upstreamError.body.error.message,
              );
            }
            // When started, the error event has already gone out over SSE in the loop; by spec, error terminates the stream
          } else if (ctx.outputTokens === 0) {
            try { abortController.abort(); } catch {}
            if (!started) {
              sendAnthropicError(res, 429, 'rate_limit_error', 'Empty response from upstream (zero output tokens)', 10);
              return;
            }
            await flushBuf();
          } else {
            await flushBuf();
          }
        }
      } catch (e) {
        if (aborted) {
          // Client already gone: just clean up (the close handler has already called abortController.abort())
        } else if (e.message === 'STREAM_IDLE_TIMEOUT') {
          log('warn', 'Stream idle timeout', {
            path: '/v1/messages',
            model,
            streaming: true,
            timeoutMs: STREAM_IDLE_TIMEOUT_MS,
            elapsedMs: Date.now() - startTime,
            id: messageId,
            bytesReceived: ctx.bytesReceived,
            lastCcEvent: ctx.lastCcEvent || '(none)',
            inputTokens: ctx.inputTokens,
            outputTokens: ctx.outputTokens,
            cachedInputTokens: ctx.cachedInputTokens,
          });
          try { abortController.abort(); } catch {} // abort the CC upstream
          if (!started) {
            consecutiveTimeouts++;
            const timeoutMsg = consecutiveTimeouts >= TIMEOUT_REDUCE_CONTEXT_THRESHOLD
              ? 'Response timeout - try reducing context length (summarize earlier messages)'
              : 'Response timeout - request timed out';
            sendAnthropicError(res, 429, 'rate_limit_error', timeoutMsg);
            return;
          }
          if (!res.writableEnded) {
            consecutiveTimeouts++;
            const timeoutMsg = consecutiveTimeouts >= TIMEOUT_REDUCE_CONTEXT_THRESHOLD
              ? 'Response timeout - try reducing context length (summarize earlier messages)'
              : 'Response timeout - request timed out';
            // 繁中：用 res.end() 收尾，剛寫入的錯誤事件才送得出去（destroy 會把它一起丟掉）。
            // English: end the response so the error frame reaches the client — destroy would drop it.
            try { res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: timeoutMsg }, retry_after: 5 })}\n\n`); } catch {}
            try { res.end(); } catch {}
          }
        } else {
          log('error', 'Anthropic stream error', { message: e.message });
          try { abortController.abort(); } catch {} // abort the CC upstream
          if (!started) {
            sendAnthropicError(res, 502, 'proxy_error', `Upstream error: ${e.message}`, 10);
            return;
          }
          if (!res.writableEnded) {
            try {
              res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'internal_error', message: e.message } })}\n\n`);
            } catch {}
          }
        }
      } finally {
        clearInterval(heartbeat);
      }

      if (!res.writableEnded) res.end();
    } else {
      // ── Non-streaming Anthropic JSON ──
      const messageId = 'msg_' + randomUUID().slice(0, 12);
      let finishReason = 'stop';
      let usage = null;
      let toolCalls = null;
      let thinkingText = ''; // CC reasoning → Anthropic thinking block
      let upstreamError = null;

      reader = ccResponse.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      const processLines = () => {
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === '[DONE]') continue;
          try {
            const event = JSON.parse(trimmed);
            switch (event.type) {
              case 'text-delta': lastCcEvent = event.type; fullText += event.text || ''; break;
              case 'reasoning-delta': lastCcEvent = event.type; thinkingText += event.text || ''; break;
              case 'tool-call':
                lastCcEvent = event.type;
                (toolCalls = toolCalls || []).push({
                  id: event.toolCallId || ('call_' + randomUUID().slice(0, 8)),
                  type: 'function',
                  function: {
                    name: event.toolName || '',
                    arguments: typeof event.input === 'string' ? event.input : JSON.stringify(event.input || {}),
                  },
                });
                break;
              case 'finish':
                lastCcEvent = event.type;
                finishReason = mapFinishReason(event.finishReason || 'stop');
                if (event.totalUsage || event.usage) usage = event.totalUsage || event.usage;
                break;
              case 'error':
                lastCcEvent = event.type;
                log('warn', 'CC error (Anthropic non-stream)', { message: event.error?.message || event.message });
                upstreamError = mapCcEventError(event);
                break;
              case 'reasoning-end': case 'provider-metadata': case 'tool-input-start': case 'tool-input-delta': case 'tool-input-end': case 'tool-error': case 'text-end':
                // Silent - no user-visible content
                break;
              default:
                log('warn', 'Unknown CC event type', { type: event.type });
                break;
            }
          } catch {}
        }
      };

      const idle = createIdleWatchdog(NONSTREAM_IDLE_TIMEOUT_MS);
      while (true) {
        const result = await Promise.race([reader.read(), idle.arm()]);
        const { done, value } = result;
        if (done) break;
        bytesReceived += value.length;
        const chunkText = decoder.decode(value, { stream: true });
        buf += chunkText;
        // Without a newline no complete line can exist, so skip the full split
        if (chunkText.indexOf('\n') !== -1) processLines();
      }
      idle.dispose();
      processLines();

      if (upstreamError) {
        sendAnthropicError(res, upstreamError.status, upstreamError.body.error.type, upstreamError.body.error.message);
        return;
      }

      // Zero-output detection now looks at the actual content: when the upstream occasionally omits totalUsage, the old
      // logic would kill a response that had full text and report 429
      if (!fullText && !thinkingText && !toolCalls) {
        try { if (!abortController.signal.aborted) abortController.abort(); } catch {}
        sendAnthropicError(res, 429, 'rate_limit_error', 'Empty response from upstream (zero output tokens)', 10);
        return;
      }

      consecutiveTimeouts = 0;
      sendJSON(res, 200, buildAnthropicResponse(model, fullText, toolCalls, finishReason, usage, thinkingText));
    }
  } catch (e) {
    if (abortController.signal.aborted) {
      log('warn', 'Request cancelled (client disconnected before CC response)', {
        path: '/v1/messages',
        model,
        messageId,
      });
    } else if (e.message === 'STREAM_IDLE_TIMEOUT') {
      log('warn', 'Stream idle timeout', {
        path: '/v1/messages',
        model,
        streaming: false,
        timeoutMs: NONSTREAM_IDLE_TIMEOUT_MS,
        elapsedMs: Date.now() - startTime,
        id: messageId,
        bytesReceived,
        lastCcEvent: lastCcEvent || '(none)',
        partialLen: fullText ? fullText.length : 0,
      });
      try { reader?.cancel(); } catch {}
      try { abortController.abort(); } catch {} // abort the CC upstream
      consecutiveTimeouts++;
      const timeoutMsg = consecutiveTimeouts >= TIMEOUT_REDUCE_CONTEXT_THRESHOLD
        ? 'Response timeout - try reducing context length (summarize earlier messages)'
        : 'Response timeout - request timed out';
      res.setHeader('Retry-After', '5');
      sendAnthropicError(res, 429, 'rate_limit_error', timeoutMsg);
    } else {
      log('error', 'Upstream error', { message: e.message });
      try { abortController.abort(); } catch {} // abort the CC upstream
      sendAnthropicError(res, 502, 'proxy_error', `Upstream error: ${e.message}`, 10);
    }
  }
}

// ── Dynamic model list / 動態模型清單 ───────────────

let dynamicModels = null;
let modelsLastFetch = 0;

async function fetchModels(apiKey) {
  const now = Date.now();
  if (dynamicModels && (now - modelsLastFetch) < CFG.modelRefreshIntervalMs) {
    return dynamicModels;
  }

  try {
    if (!apiKey || !CFG.useProviderModels) throw new Error('Provider models disabled');

    const response = await fetch(`${CFG.apiBase}/provider/v1/models`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'x-cli-environment': 'production',
        'x-command-code-version': CC_VERSION,
      },
      signal: AbortSignal.timeout(10000),
    });

    if (response.ok) {
      const data = await response.json();
      if (Array.isArray(data.data)) {
        dynamicModels = data.data.map(m => ({
          id: m.id,
          name: m.id,
        }));
        modelsLastFetch = now;
        log('info', 'Fetched models from Provider API', { count: dynamicModels.length });
        return dynamicModels;
      }
    }
    log('warn', 'Provider models fetch failed, using hardcoded list', { status: response.status });
  } catch (e) {
    log('warn', 'Provider models fetch error, using hardcoded list', { error: e.message });
  }

  // Fallback to hardcoded MODELS
  return MODELS;
}

// ── OpenAI Responses API / Responses 端點 ───────────
// For clients that speak the Responses protocol (Codex and friends). The relay stays a stateless translation layer:
// it translates input into the internal Chat format and reuses the same CC forwarding pipeline.
// previous_response_id / store are not supported (they need server-side conversation state, which conflicts with
// 繁中：Responses 端點把 input 轉成內部 Chat 格式後重用同一條 CC 管線；不支援 previous_response_id / store（需伺服器端保存，與無狀態衝突），收到直接 400。

function responsesTextOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(p => (p && typeof p === 'object' ? (p.text || '') : '')).join('');
}

function responsesReasoningOf(item) {
  if (!item) return '';
  if (Array.isArray(item.summary) && item.summary.length) return item.summary.map(p => (p && p.text) || '').join('');
  if (Array.isArray(item.content) && item.content.length) return item.content.map(p => (p && p.text) || '').join('');
  return typeof item.text === 'string' ? item.text : '';
}

function newResponsesId(prefix) {
  return prefix + randomUUID().replace(/-/g, '').slice(0, 24);
}

// The Command Code upstream accepts only low|medium|high|xhigh|max (ultra answers 400 invalid option in testing).
// 繁中：Codex／cc-switch 會送 ultra、minimal、none 等值，這裡統一收斂（ultra→max、minimal/none/off→low），無法識別的就丟棄。
const CC_REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
function normaliseReasoningEffort(value) {
  if (value === undefined || value === null) return undefined;
  const v = String(value).toLowerCase().trim();
  if (CC_REASONING_EFFORTS.has(v)) return v;
  if (v === 'ultra') return 'max';
  if (v === 'minimal' || v === 'none' || v === 'off') return 'low';
  return undefined;
}

// Responses content parts → OpenAI chat content (images preserved, so buildCcRequest can convert them to CC image format)
function responsesContentToChat(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const p of content) {
    if (!p || typeof p !== 'object') continue;
    const url = (p.image_url && p.image_url.url) || (typeof p.image_url === 'string' ? p.image_url : '') || p.url || p.image || '';
    if (url && (p.type === 'input_image' || p.type === 'image_url' || p.type === 'image' || url.startsWith('data:image'))) {
      parts.push({ type: 'image_url', image_url: { url } });
      continue;
    }
    const t = p.text ?? p.content ?? '';
    if (t) parts.push({ type: 'text', text: t });
  }
  if (!parts.length) return '';
  if (parts.every((x) => x.type === 'text')) return parts.map((x) => x.text).join('');
  return parts;
}

// 繁中：解析「maximum context length」錯誤，自動降低 completion 預算並重試一次。
function parseContextLimitError(text) {
  if (!text || !/maximum context length/i.test(text)) return null;
  const limit = Number((text.match(/maximum context length is (\d+)/i) || [])[1]);
  const requested = Number((text.match(/you requested (\d+)/i) || [])[1]);
  const messagesTokens = Number((text.match(/\((\d+) in the messages/i) || [])[1]);
  let completionTokens = Number((text.match(/(\d+) in the completion/i) || [])[1]);
  if (!Number.isFinite(completionTokens) && Number.isFinite(requested) && Number.isFinite(messagesTokens)) completionTokens = requested - messagesTokens;
  if (!Number.isFinite(limit) || !Number.isFinite(messagesTokens)) return null;
  return { limit, requested, messagesTokens, completionTokens: Number.isFinite(completionTokens) ? completionTokens : 64000 };
}

// With CC_DEBUG_TOOLS=1, write the received tool list to tools-debug.log (never any keys) to diagnose tool-calling issues.
const DEBUG_TOOLS = process.env.CC_DEBUG_TOOLS === '1';
function debugToolsLog(entry) {
  if (!DEBUG_TOOLS) return;
  try {
    appendFileSync(resolve(__dirname, 'tools-debug.log'), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch (e) { /* ignore */ }
}

// Tool output (a screenshot returned by view_image, say) often carries very long base64; sent as plain text,
// the upstream bills it as *text tokens* (measured: 2.2M characters ≈ 1.53M tokens) and one turn blows the 1M context.
// 繁中：工具輸出常含超長 base64（例如 view_image 的截圖）；當文字送出會被上游以文字 token 計價（實測 220 萬字 ≈ 153 萬 token）。這裡把 data URL 抽出改用圖片重送，並截斷超長輸出。
const MAX_TOOL_OUTPUT_CHARS = (() => { const n = Number.parseInt(process.env.CC_MAX_TOOL_OUTPUT_CHARS ?? '', 10); return Number.isFinite(n) && n > 0 ? n : 100000; })();
const DATA_URL_RE = /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi;
function extractToolOutput(item) {
  const images = [];
  const rawOut = item ? item.output : '';
  if (rawOut === undefined || rawOut === null) return { text: '', images };
  let text = typeof rawOut === 'string' ? rawOut : (() => { try { return JSON.stringify(rawOut); } catch (e) { return String(rawOut); } })();
  const found = text.match(DATA_URL_RE) || [];
  for (const u of found) if (u.length > 1024 && !images.includes(u)) images.push(u);
  text = text.replace(DATA_URL_RE, '[image data removed: use the attached image]');
  if (text.length > MAX_TOOL_OUTPUT_CHARS) {
    const removed = text.length - MAX_TOOL_OUTPUT_CHARS;
    log('warn', 'Tool output truncated', { originalChars: text.length, kept: MAX_TOOL_OUTPUT_CHARS, removed });
    text = text.slice(0, MAX_TOOL_OUTPUT_CHARS) + '\n...[truncated ' + removed + ' chars]';
  }
  return { text, images };
}

// ── Built-in web tools / 內建網路工具（客戶端執行，由反代代跑）──
// CLI 1.53.1: POST /alpha/web-search {query,numResults,allowedDomains?,blockedDomains?}
//             POST /alpha/web-fetch  {url,format} → {content,url,status}
const MAX_WEB_ROUNDS = (() => { const n = Number.parseInt(process.env.CC_MAX_WEB_ROUNDS ?? '', 10); return Number.isFinite(n) && n > 0 ? Math.min(8, n) : 3; })();
const WEB_SEARCH_NAME = "web_search";
const WEB_FETCH_NAME = "web_fetch";

function webSearchToolDef() {
  return { type: "function", function: { name: WEB_SEARCH_NAME,
    description: "Searches the web for real-time information and returns ranked results with titles, URLs, and snippets. Use for current events, documentation lookup, or anything beyond your knowledge cutoff. If you need the full page contents of a specific URL, call web_fetch on it afterwards.",
    parameters: { type: "object", properties: {
      query: { type: "string", description: "The search query (at least 2 characters)." },
      numResults: { type: "number", description: "Integer between 1 and 10. Defaults to 5." },
      allowed_domains: { type: "array", items: { type: "string" }, description: "Only include results from these domains." },
      blocked_domains: { type: "array", items: { type: "string" }, description: "Never include results from these domains. Do not combine with allowed_domains." },
    }, required: ["query"] } } };
}
function webFetchToolDef() {
  return { type: "function", function: { name: WEB_FETCH_NAME,
    description: "Fetches a URL and returns its content (markdown by default). Use startIndex to page through long pages.",
    parameters: { type: "object", properties: {
      url: { type: "string", description: "The URL to fetch. Must begin with http:// or https:// (http is upgraded to https)." },
      format: { type: "string", enum: ["markdown", "text", "html"], description: "Output format (default markdown)." },
      startIndex: { type: "number", description: "Character offset to continue reading a long page." },
    }, required: ["url"] } } };
}
function ccWebHeaders(apiKey, incomingHeaders, promptCacheKey) {
  const sessionId = getSessionId(incomingHeaders || {}, apiKey, promptCacheKey);
  const headers = {
    "Content-Type": "application/json",
    "Authorization": "Bearer " + apiKey,
    "x-cli-environment": "production",
    "x-command-code-version": CC_VERSION,
    "x-session-id": sessionId,
    "x-co-flag": "false",
    "x-taste-learning": "false",
    "x-project-slug": fakeProjectSlug(sessionId),
    "traceparent": generateTraceparent(),
  };
  if (CFG.zdr || (incomingHeaders && incomingHeaders["x-cmd-zdr"] === "1")) headers["x-cmd-zdr"] = "1";
  return headers;
}
function normaliseDomainFilter(list) {
  if (!Array.isArray(list)) return [];
  return list.map((d) => String(d || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "")).filter(Boolean);
}
function urlMatchesDomain(url, domains) {
  let host = "";
  try { host = new URL(url).hostname.toLowerCase(); } catch (e) { return false; }
  return domains.some((d) => host === d || host.endsWith("." + d));
}
function formatWebSearchResults(query, results, filtered) {
  if (!results.length) return "No results found for: " + query + "\n\n" + (filtered ? "Try loosening or removing the domain filters, or broadening the query." : "Try a broader or differently-worded query.");
  const lines = results.map((r, i) => (i + 1) + ". **" + (r.title || "(no title)") + "**\n " + (r.url || "") + "\n " + (r.snippet || r.description || ""));
  return ["Search results for: " + query, "", lines.join("\n\n"), "", "Cite the results you use: end your response with a \"Sources:\" section of [Title](URL) markdown links."].join("\n");
}
function guardWebFetchUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch (e) { return { ok: false, error: "Invalid URL." }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, error: "Only http/https URLs are allowed." };
  if (u.username || u.password) return { ok: false, error: "Credentials in URL are not allowed." };
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.indexOf(".") === -1) return { ok: false, error: "Private, loopback or single-label hosts are not allowed." };
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return { ok: false, error: "Private addresses are not allowed." };
  if (host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) return { ok: false, error: "Private addresses are not allowed." };
  if (u.protocol === "http:") u.protocol = "https:";
  return { ok: true, url: u.toString() };
}
async function callCcWebRoute(route, body, apiKey, incomingHeaders, promptCacheKey, signal) {
  const response = await fetch(CFG.apiBase + route, { method: "POST", headers: ccWebHeaders(apiKey, incomingHeaders, promptCacheKey), body: JSON.stringify(body), signal });
  const text = await response.text();
  if (!response.ok) throw new Error(response.status + " error: " + String(text).slice(0, 200));
  try { return JSON.parse(text); } catch (e) { throw new Error("Invalid JSON from " + route); }
}
async function executeCcWebTool(name, argsRaw, apiKey, incomingHeaders, promptCacheKey, signal) {
  let args = {};
  try { args = typeof argsRaw === "string" ? JSON.parse(argsRaw || "{}") : (argsRaw || {}); } catch (e) { args = {}; }
  if (name === WEB_SEARCH_NAME) {
    const query = String(args.query || "").trim();
    if (query.length < 2) return "Error searching the web: web_search requires a \"query\" of at least 2 characters.";
    const allowed = normaliseDomainFilter(args.allowed_domains);
    const blocked = normaliseDomainFilter(args.blocked_domains);
    if (allowed.length && blocked.length) return "Error searching the web: pass either allowed_domains or blocked_domains, not both.";
    const numResults = Math.min(10, Math.max(1, Math.round(Number(args.numResults) || 5)));
    let data;
    try {
      const body = { query, numResults };
      if (allowed.length) body.allowedDomains = allowed;
      if (blocked.length) body.blockedDomains = blocked;
      data = await callCcWebRoute("/alpha/web-search", body, apiKey, incomingHeaders, promptCacheKey, signal);
    } catch (e) { return "Error searching the web: " + e.message; }
    if (!Array.isArray(data.results)) return data.formatted || formatWebSearchResults(query, [], allowed.length > 0 || blocked.length > 0);
    const filtered = data.results.filter((r) => (allowed.length ? urlMatchesDomain(r.url, allowed) : !(blocked.length && urlMatchesDomain(r.url, blocked)))).slice(0, numResults);
    return formatWebSearchResults(query, filtered, allowed.length > 0 || blocked.length > 0);
  }
  if (name === WEB_FETCH_NAME) {
    const guard = guardWebFetchUrl(args.url);
    if (!guard.ok) return "Error fetching " + args.url + ": " + guard.error;
    const fmt = ["markdown", "text", "html"].includes(String(args.format || "markdown").toLowerCase()) ? String(args.format || "markdown").toLowerCase() : "markdown";
    let data;
    try { data = await callCcWebRoute("/alpha/web-fetch", { url: guard.url, format: fmt }, apiKey, incomingHeaders, promptCacheKey, signal); }
    catch (e) { return "Error fetching " + guard.url + ": " + e.message; }
    const content = String(data.content == null ? "" : data.content);
    const finalUrl = data.url || guard.url;
    const status = data.status == null ? 0 : data.status;
    const startIndex = Math.max(0, Math.floor(Number(args.startIndex) || 0));
    if (startIndex >= content.length) return "Error fetching " + guard.url + ": startIndex " + startIndex + " is past the end of the content (" + content.length + " characters total).";
    const end = Math.min(startIndex + 100000, content.length);
    const head = ["URL: " + finalUrl, "Status: " + status];
    try { const a = new URL(finalUrl).hostname; const b = new URL(guard.url).hostname; if (a && b && a !== b) head.push("Redirected: " + guard.url + " → " + finalUrl); } catch (e) {}
    const parts = [head.join("\n"), "", content.slice(startIndex, end)];
    if (startIndex > 0 || end < content.length) parts.push("", "[Showing characters " + startIndex + "-" + end + " of " + content.length + (end < content.length ? ". Call web_fetch again with startIndex=" + end + " to continue reading." : ". End of content.") + "]");
    return parts.join("\n");
  }
  return "Error: unsupported internal tool " + name;
}

// When a client interrupts a turn, the history can keep a tool_call with no tool result, or an orphaned tool result.
// The upstream (DeepSeek/CC) rejects that outright — “Tool result is missing for tool call <id>” — and the conversation wedges.
// 繁中：客戶端中斷回合時，歷史可能留下沒有結果的 tool_call（上游會直接拒絕並讓對話卡死）；這裡自動補一筆說明，孤兒結果則丟棄。
function repairToolCallPairs(messages) {
  const callIds = new Set();
  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) if (tc && tc.id) callIds.add(tc.id);
    }
  }
  const existingResults = new Set(messages.filter((m) => m.role === 'tool' && m.tool_call_id).map((m) => m.tool_call_id));
  const out = [];
  let repairedCount = 0;
  let droppedCount = 0;
  for (const msg of messages) {
    if (msg.role === 'tool') {
      if (!callIds.has(msg.tool_call_id)) { droppedCount++; continue; }
      out.push(msg);
      continue;
    }
    out.push(msg);
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (!tc || !tc.id || existingResults.has(tc.id)) continue;
        repairedCount++;
        out.push({
          role: 'tool',
          tool_call_id: tc.id,
          name: (tc.function && tc.function.name) || '',
          content: '[tool result missing: the previous turn was interrupted before this tool returned]',
        });
      }
    }
  }
  if (repairedCount || droppedCount) log('warn', 'Repaired incomplete tool history', { repaired: repairedCount, droppedOrphanResults: droppedCount });
  return out;
}

// 繁中：跨對話委派（send_message_to_thread）進到目標對話時，是一筆沒有 call_id 的 function_call_output，
// 內容包在 <codex_delegation> 裡。若照一般工具結果處理，孤兒修補會把它丟掉，目標對話的模型根本看不到，
// 就會繼續回答上一則真人訊息（實測：指揮無效）。這裡把它轉成使用者訊息，委派才會真的生效。
// English: a cross-thread delegation arrives as a function_call_output with no matching call. Treating it as a
// tool result means the orphan repair drops it and the target model never sees it; converting it to a user
// message is what makes multi-agent delegation actually work.
// 繁中：跨對話委派有兩種送法（CC_NATIVE_DELEGATION 切換）：
//   0＝轉成使用者訊息（退路；OpenAI issue #45227 也建議這種做法，內容一定送達）。
//   1（預設）＝在上游請求裡補一組配對的 function_call + function_call_output（原生 tool call/result 語意，
//      對嚴格的上游也能通過），模型看到的形狀就跟 Codex App 自己的設計一致。
// English: two shapes for an incoming cross-thread delegation (CC_NATIVE_DELEGATION, default native):
//   0 = a user message (the fallback; OpenAI's issue #45227 lists this as one of the intended fixes).
//   1 (default) = synthesise a matching function_call + function_call_output pair, so the model sees native
//       tool call/result semantics instead of a synthetic user turn.
// 繁中：預設原生（配合 App 自己的資料形狀）；設 CC_NATIVE_DELEGATION=0 可退回使用者訊息模式。
// English: native is the default now; set CC_NATIVE_DELEGATION=0 for the user-message fallback.
const NATIVE_DELEGATION = process.env.CC_NATIVE_DELEGATION !== '0';

function delegationToToolPair(raw, name) {
  const callId = 'call_deleg_' + randomUUID().replace(/-/g, '').slice(0, 16);
  const toolName = name || 'send_message_to_thread';
  return [
    { role: 'assistant', content: null, tool_calls: [{ id: callId, type: 'function', function: { name: toolName, arguments: '{}' } }] },
    { role: 'tool', tool_call_id: callId, name: toolName, content: String(raw || '') },
  ];
}

function delegationToUserMessage(raw) {
  const m = /<input>([\s\S]*?)<\/input>/.exec(String(raw || ''));
  const body = (m ? m[1] : String(raw || '')).trim();
  return '[Message from another task — treat this as a user instruction]' + '\n\n' + body;
}

function convertResponsesToChat(respReq) {
  const messages = [];
  // Images inside tool output must be inserted *after* the whole group of tool results;
  // inserting them in between puts a user message between assistant(tool_calls) and the later tool results,
  // 繁中：工具輸出裡的圖片必須延後到整組 tool results 之後才插入，否則會在 assistant(tool_calls) 與結果之間夾一條 user 訊息，上游會判定 missing（DeepSeek 實測 502）。
  const deferredImageMsgs = [];
  // 繁中：上游要求「同一組工具呼叫的結果」必須連續；中間插進任何訊息（圖片或 system/developer 提示）
  // 都會被判成 missing tool result（用真實歷史重現 502）。所以追蹤這一組還缺哪些 call id，
  // 整組到齊之前先把圖片與提示訊息扣住，到齊後才放出去。
  // English: the upstream requires the results of one tool-call group to be contiguous; anything inserted
  // between them is reported as a missing tool result. Track the outstanding call ids and hold back
  // images and system/developer notes until the whole group has arrived.
  const awaitingResultIds = new Set();
  const deferredSystemMsgs = [];
  const nsByToolName = new Map();
  // ==== Experiment: namespace alias probe (off by default; CC_NAMESPACE_ALIAS_PROBE=1 enables it) ====
  // Purpose: find out which tool-name shape the app actually expects (bare name / mcp__ns__tool / ns::tool)
  const NAMESPACE_ALIAS_PROBE = process.env.CC_NAMESPACE_ALIAS_PROBE === '1';
  const ALIAS_PROBE_TOOL = process.env.CC_ALIAS_PROBE_TOOL || 'list_threads';
  const probeForward = new Map();
  const probeReverse = new Map();
  if (NAMESPACE_ALIAS_PROBE && Array.isArray(respReq.tools)) {
    for (const entry of respReq.tools) {
      if (!entry || entry.type !== 'namespace' || !entry.name || !Array.isArray(entry.tools)) continue;
      for (const sub of entry.tools) {
        const base = sub && sub.name;
        if (!base) continue;
        const prefixed = entry.name + '__' + base;
        const colonAlias = entry.name + '_x_' + base;
        probeForward.set(prefixed, prefixed);
        probeForward.set(colonAlias, entry.name + '::' + base);
        probeReverse.set(entry.name + '::' + base, colonAlias);
      }
    }
  }
  const flushDeferredImages = () => {
    if (!deferredImageMsgs.length) return;
    for (const m of deferredImageMsgs) messages.push(m);
    deferredImageMsgs.length = 0;
  };

  const flushDeferredSystems = () => {
    if (!deferredSystemMsgs.length) return;
    for (const m of deferredSystemMsgs) messages.push(m);
    deferredSystemMsgs.length = 0;
  };
  // 繁中：整組工具結果到齊前不放行任何插入物。
  // English: nothing may slip in until every result of the group has arrived.
  const toolGroupComplete = () => awaitingResultIds.size === 0;
  const flushGroupTail = () => {
    flushDeferredSystems();
    flushDeferredImages();
  };

  if (respReq.instructions !== undefined && respReq.instructions !== null) {
    const sys = responsesTextOf(respReq.instructions);
    if (sys) messages.push({ role: 'system', content: sys });
  }

  // Responses splits reasoning / message / function_call into sibling items,
  // while Chat requires them on one assistant message, so accumulate and then flush.
  let pending = null;
  const ensurePending = () => (pending = pending || { role: 'assistant', content: null, tool_calls: [] });
  const flushPending = () => {
    if (!pending) return;
    if (!pending.tool_calls.length) delete pending.tool_calls;
    if (!pending.reasoning_content) delete pending.reasoning_content;
    if (pending.content === null && !pending.tool_calls) { pending = null; return; }
    messages.push(pending);
    pending = null;
  };

  const input = respReq.input;
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== 'object') continue;
      // Some clients omit the type field on message items; default it to message so the whole input is not dropped.
      if (!item.type && item.role) item.type = 'message';
      // 繁中：只有整組工具結果到齊時，才允許把扣住的圖片／提示放出去。
      // English: only release held-back images/notes once the whole tool group is complete.
      if (item.type !== 'function_call_output' && toolGroupComplete()) flushGroupTail();
      switch (item.type) {
        case 'reasoning': {
          const t = responsesReasoningOf(item);
          if (t) ensurePending().reasoning_content = t;
          break;
        }
        case 'message': {
          const rich = responsesContentToChat(item.content);
          const text = responsesTextOf(item.content);
          if (item.role === 'assistant') {
            if (text) ensurePending().content = text;
          } else if (item.role === 'system' || item.role === 'developer') {
            // 繁中：這一組工具結果還沒到齊（或剛好緊接在結果後面）就先把提示扣住，等整組結束再送。
            // English: hold the note back while the group is still open; release it once the group is done.
            const lastIsToolResult = messages.length > 0 && messages[messages.length - 1].role === 'tool';
            if (!toolGroupComplete() || lastIsToolResult) {
              deferredSystemMsgs.push({ role: 'system', content: text });
            } else {
              flushPending();
              messages.push({ role: 'system', content: text });
            }
          } else {
            flushPending();
            messages.push({ role: 'user', content: rich || text });
          }
          break;
        }
        case 'function_call': {
          if (item.name && probeReverse.has(item.name)) item.name = probeReverse.get(item.name);
          {
            const callId = item.call_id || item.id || ('call_' + randomUUID().slice(0, 8));
            awaitingResultIds.add(callId);
            ensurePending().tool_calls.push({
              id: callId,
              type: 'function',
              function: { name: item.name || '', arguments: item.arguments || '{}' },
            });
          }
          break;
        }
        case 'function_call_output': {
          flushPending();
          {
            const { text, images } = extractToolOutput(item);
            // 繁中：沒有 call_id 的委派訊息 → 使用者訊息（否則會被孤兒修補丟掉）。
            // English: a delegation with no call_id becomes a user message, not a droppable tool result.
            // 繁中：App 注入的委派可能來自 send_message_to_thread／create_thread／handoff_thread，
            // 有些還不帶 <codex_delegation> 標記；三種名字都要認，否則會被孤兒修補丟掉。
            // English: injected delegations can come from send_message_to_thread, create_thread or
            // handoff_thread, sometimes without the <codex_delegation> marker — recognise all three.
            const isDelegation = item.name === 'send_message_to_thread' || item.name === 'create_thread' || item.name === 'handoff_thread' || /<codex_delegation>/.test(text);
            if (!item.call_id && isDelegation) {
              // 繁中：原生模式＝補一組配對的 tool call/result；否則維持使用者訊息。
              // English: native mode synthesises the matching tool call/result pair; otherwise a user message.
              if (NATIVE_DELEGATION) {
                for (const m of delegationToToolPair(text, item.name)) messages.push(m);
              } else {
                messages.push({ role: 'user', content: delegationToUserMessage(text) });
              }
              break;
            }
            messages.push({
              role: 'tool',
              tool_call_id: item.call_id || '',
              content: text,
            });
            if (images.length) {
              // Re-send images as real image parts (one image costs ~900 tokens, not hundreds of thousands as text)
              deferredImageMsgs.push({
                role: 'user',
                content: [
                  { type: 'text', text: '[tool output image attached: ' + images.length + ']' },
                  ...images.slice(0, 4).map((u) => ({ type: 'image_url', image_url: { url: u } })),
                ],
              });
            }
            if (item.call_id) awaitingResultIds.delete(item.call_id);
            if (toolGroupComplete()) flushGroupTail();
          }
          break;
        }
        default: break;
      }
    }
  }
  flushDeferredSystems();
  flushPending();
  flushDeferredImages();

  const repairedMessages = repairToolCallPairs(messages);
  messages.length = 0;
  for (const m of repairedMessages) messages.push(m);

  let tools;
  if (Array.isArray(respReq.tools) && respReq.tools.length) {
    // Newer Codex-App builds wrap tools in a namespace, for example
    // {"type":"namespace","name":"mcp__node_repl","tools":[{"name":"js",...}]}.
    // 繁中：新版 Codex App 會把工具包在 namespace 裡；展開成扁平 function 清單，模型才看得到 js 等子工具（否則 Computer Use 會失效）。
    const flattened = [];
    const collect = (entry, depth, nsName) => {
      if (!entry || typeof entry !== 'object' || depth > 4) return;
      const type = entry.type || 'function';
      if (type === 'namespace') {
        const subs = Array.isArray(entry.tools) ? entry.tools : (Array.isArray(entry.children) ? entry.children : (Array.isArray(entry.functions) ? entry.functions : []));
        for (const s of subs) collect(s, depth + 1, entry.name || nsName || '');
        return;
      }
      if (type === 'function') {
        flattened.push(entry);
        if (nsName && entry.name) nsByToolName.set(entry.name, nsName);
        if (NAMESPACE_ALIAS_PROBE && nsName && entry.name && entry.name === ALIAS_PROBE_TOOL) {
          const mk = (nm, desc) => ({ type: 'function', name: nm, description: desc, parameters: entry.parameters || { type: 'object', properties: {} } });
          flattened.push(mk(nsName + '__' + entry.name, '(probe-prefixed) ' + (entry.description || '')));
          flattened.push(mk(nsName + '_x_' + entry.name, '(probe-colon) ' + (entry.description || '')));
        }
      }
    };
    for (const entry of respReq.tools) collect(entry, 0, '');
    const seenNames = new Set();
    const deduped = [];
    for (const t of flattened) {
      const nm = (t.function && t.function.name) || t.name || '';
      if (!nm || seenNames.has(nm)) continue;
      seenNames.add(nm);
      deduped.push(t);
    }
    const nonFunction = respReq.tools.filter(t => t && t.type && t.type !== 'function');
    if (nonFunction.length) {
      log('info', 'Tool entries (kept vs ignored)', {
        kept: deduped.map(t => (t.function && t.function.name) || t.name || null).filter(Boolean).slice(0, 60),
        ignored: nonFunction.map(t => ({ type: t.type, name: t.name || null, keys: Object.keys(t).slice(0, 8), subTools: Array.isArray(t.tools) ? t.tools.map(s => (s && s.name) || null).slice(0, 20) : undefined })).slice(0, 12),
        total: respReq.tools.length,
      });
    }
    tools = deduped.map(t => ({
      type: 'function',
      function: {
        name: (t.function && t.function.name) || t.name || '',
        description: t.description || (t.function && t.function.description) || '',
        parameters: (t.function && t.function.parameters) || t.parameters || t.input_schema || { type: 'object', properties: {} },
      },
    }));
    if (!tools.length) tools = undefined;
  }

  const rawWebTools = Array.isArray(respReq.tools) ? respReq.tools : [];
  const wantsWebSearch = rawWebTools.some((t) => t && (t.type === "web_search" || t.type === "web_search_preview"));
  // 繁中：App 只送 web_search；這裡一併注入 web_fetch，兩者都由代理代跑（與 CC CLI 行為一致）。
  const wantsWebFetch = wantsWebSearch || rawWebTools.some((t) => t && t.type === "web_fetch");
  if (wantsWebSearch || wantsWebFetch) {
    tools = tools || [];
    const existing = new Set(tools.map((t) => t.function.name));
    if (wantsWebSearch && !existing.has(WEB_SEARCH_NAME)) tools.push(webSearchToolDef());
    if (wantsWebFetch && !existing.has(WEB_FETCH_NAME)) tools.push(webFetchToolDef());
  }

  let toolChoice;
  const tc = respReq.tool_choice;
  if (typeof tc === 'string') toolChoice = tc;
  else if (tc && typeof tc === 'object' && tc.name) toolChoice = { type: 'function', function: { name: tc.name } };

  const out = { model: respReq.model, messages, stream: respReq.stream === true, __webTools: { search: wantsWebSearch, fetch: wantsWebFetch }, __toolNameMap: probeForward, __toolNamespaces: nsByToolName };
  if (tools) out.tools = tools;
  if (toolChoice) out.tool_choice = toolChoice;
  if (respReq.max_output_tokens !== undefined) out.max_tokens = respReq.max_output_tokens;
  if (respReq.temperature !== undefined) out.temperature = respReq.temperature;
  if (respReq.top_p !== undefined) out.top_p = respReq.top_p;
  if (respReq.parallel_tool_calls !== undefined) out.parallel_tool_calls = respReq.parallel_tool_calls;
  const eff = normaliseReasoningEffort(respReq.reasoning && typeof respReq.reasoning === 'object' ? respReq.reasoning.effort : undefined);
  if (eff) out.reasoning_effort = eff;
  return out;
}

// Responses’ input_tokens is a total, with cached / cache_write as subsets of it —
// the opposite of Anthropic (where cache_read is a separate increment and must be subtracted — see issue #25).
// Our upstream CC also includes cache hits in inputTokens, so it is passed through without subtraction.
// 繁中：Responses 的 input_tokens 是總數（cached 為其子集），與 Anthropic 相反故不做減法；實測 total = input + output。
function buildResponsesUsage(usage, fallbackOutputTokens) {
  const u = usage || {};
  normaliseUsage(u);
  const inTok = u.inputTokens || 0;
  const outTok = u.outputTokens || fallbackOutputTokens || 0;
  return {
    input_tokens: inTok,
    // cached_tokens and cache_write_tokens are both required by the spec
    input_tokens_details: {
      cached_tokens: u.cachedInputTokens || 0,
      cache_write_tokens: (u.inputTokenDetails && u.inputTokenDetails.cacheWriteTokens) || 0,
    },
    output_tokens: outTok,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: inTok + outTok,
  };
}

function buildResponsesOutput(fullText, thinkingText, toolCalls) {
  const output = [];
  if (thinkingText) {
    output.push({ type: 'reasoning', id: newResponsesId('rs_'), summary: [{ type: 'summary_text', text: thinkingText }] });
  }
  if (fullText) {
    output.push({
      type: 'message', id: newResponsesId('msg_'), status: 'completed', role: 'assistant',
      content: [{ type: 'output_text', text: fullText, annotations: [] }],
    });
  }
  for (const tc of (toolCalls || [])) {
    const rawArgs = tc.function ? tc.function.arguments : '{}';
    const item = {
      type: 'function_call', id: newResponsesId('fc_'), call_id: tc.id,
      name: tc.function ? (tc.function.name || '') : '',
      arguments: typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs || {}),
      status: 'completed',
    };
    if (tc.namespace) item.namespace = tc.namespace;
    output.push(item);
  }
  return output;
}

function buildResponsesObject(responseId, model, created, fullText, thinkingText, toolCalls, usage, opts) {
  const o = opts || {};
  const truncated = o.finishReason === 'length';
  return {
    id: responseId,
    object: 'response',
    created_at: created,
    status: truncated ? 'incomplete' : 'completed',
    completed_at: nowUnix(),
    error: null,
    incomplete_details: truncated ? { reason: 'max_output_tokens' } : null,
    input: o.input || [],
    instructions: o.instructions === undefined ? null : o.instructions,
    max_output_tokens: o.max_output_tokens === undefined ? null : o.max_output_tokens,
    model,
    output: buildResponsesOutput(fullText, thinkingText, toolCalls),
    output_text: fullText || '',
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: o.reasoning || null,
    store: false,
    temperature: o.temperature === undefined ? 1 : o.temperature,
    text: { format: { type: 'text' } },
    tool_choice: o.tool_choice || 'auto',
    tools: o.tools || [],
    top_p: o.top_p === undefined ? 1 : o.top_p,
    truncation: 'disabled',
    usage: buildResponsesUsage(usage, 0),
    user: null,
    metadata: {},
  };
}

// 繁中：串流請求失敗時要用 SSE 的 error 事件回報；回 JSON 只會讓客戶端顯示「stream closed before
// response.completed」，真正的錯誤（例如 403 的訊息）就被藏起來了。
// English: a streaming request must hear about a failure as an SSE error event — a JSON body makes the client
// report the generic "stream closed before response.completed" and hides the real cause.
function sendResponsesStreamError(res, status, type, message) {
  if (res.headersSent) return false;
  try {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const payload = { type: 'error', code: String(type || 'proxy_error'), message: String(message || 'Upstream error'), param: null, upstream_status: status || null };
    res.write('event: error\ndata: ' + JSON.stringify(payload) + '\n\n');
    res.end();
    return true;
  } catch (e) { return false; }
}

function sendResponsesError(res, status, type, message, retryAfter) {
  const body = { error: { message, type, code: null, param: null } };
  if (retryAfter !== undefined) body.retry_after = retryAfter;
  sendJSON(res, status, body);
}

// CC NDJSON → named Responses SSE events (every event carries an incrementing sequence_number)
function createResponsesSseTranslator(model, responseId, created, opts) {
  const toolNameMap = (opts && opts.toolNameMap) || null;
  const toolNamespaces = (opts && opts.toolNamespaces) || null;
  const SEND_NAMESPACE_FIELD = process.env.CC_SEND_NAMESPACE_FIELD !== '0';
  // 繁中：模型可能送出短名、ns::tool 或 ns__tool，三種都統一解析成 (name, namespace)。
  const resolveToolCall = (rawName) => {
    const nm = String(rawName || '');
    if (toolNamespaces && toolNamespaces.has(nm)) return { name: nm, namespace: toolNamespaces.get(nm) };
    const idx = nm.indexOf('::');
    if (idx > 0) return { name: nm.slice(idx + 2), namespace: nm.slice(0, idx) };
    if (toolNamespaces) {
      for (const [tool, ns] of toolNamespaces) {
        if (nm === ns + '__' + tool) return { name: tool, namespace: ns };
      }
    }
    return { name: nm, namespace: undefined };
  };
  const clientName = (nm) => (toolNameMap && toolNameMap.has(nm) ? toolNameMap.get(nm) : nm);
  const internalToolNames = (opts && opts.internalToolNames) || null;
  const internalCalls = [];
  let reasoningAcc = '';
  let seq = 0;
  const sse = (type, data) => 'event: ' + type + '\ndata: ' + JSON.stringify(Object.assign({ type, sequence_number: seq++ }, data)) + '\n\n';
  let createdSent = false;
  let current = null;
  let outputIndex = 0;
  const doneItems = [];
  let usage = null;
  let textAcc = '';
  // 繁中：這一輪送出了幾個工具呼叫（用來判斷「斷線時到底有沒有產出東西」）。
  // English: how many tool calls this turn emitted, so a cut stream can be classified.
  let toolCallCount = 0;
  let finishReason = null;
  let cutReason = '';
  // 繁中：上游正常結束一定會送 finish；沒收到就代表串流被切斷，不能假裝完成。
  // English: a well-formed upstream stream always ends with `finish`; without it the stream was cut.
  let sawFinish = false;

  const baseResponse = (status, output) => ({
    id: responseId, object: 'response', created_at: created, status,
    output: output || [], output_text: '', model, error: null, incomplete_details: null,
    parallel_tool_calls: true, previous_response_id: null, store: false, tools: [], metadata: {},
  });

  function startResponse() {
    createdSent = true;
    return [
      sse('response.created', { response: baseResponse('in_progress') }),
      sse('response.in_progress', { response: baseResponse('in_progress') }),
    ];
  }

  function closeItem() {
    if (!current) return [];
    const out = [];
    const item = current.item;
    const idx = current.index;
    if (current.kind === 'message') {
      out.push(sse('response.output_text.done', { item_id: item.id, output_index: idx, content_index: 0, text: current.textBuf, logprobs: [] }));
      out.push(sse('response.content_part.done', {
        item_id: item.id, output_index: idx, content_index: 0,
        part: { type: 'output_text', text: current.textBuf, annotations: [] },
      }));
      item.content = [{ type: 'output_text', text: current.textBuf, annotations: [] }];
      item.status = 'completed';
    } else if (current.kind === 'function_call') {
      out.push(sse('response.function_call_arguments.done', { item_id: item.id, output_index: idx, arguments: item.arguments }));
      item.status = 'completed';
    } else if (current.kind === 'reasoning') {
      out.push(sse('response.reasoning_summary_text.done', { item_id: item.id, output_index: idx, summary_index: 0, text: current.textBuf }));
      out.push(sse('response.reasoning_summary_part.done', {
        item_id: item.id, output_index: idx, summary_index: 0,
        part: { type: 'summary_text', text: current.textBuf },
      }));
      item.summary = [{ type: 'summary_text', text: current.textBuf }];
      item.status = 'completed';
    }
    out.push(sse('response.output_item.done', { output_index: idx, item }));
    doneItems.push(item);
    current = null;
    return out;
  }

  function openItem(kind, item) {
    const out = closeItem();
    current = { kind, index: outputIndex++, item, textBuf: '' };
    out.push(sse('response.output_item.added', { output_index: current.index, item }));
    if (kind === 'message') {
      out.push(sse('response.content_part.added', {
        item_id: item.id, output_index: current.index, content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      }));
    } else if (kind === 'reasoning') {
      out.push(sse('response.reasoning_summary_part.added', {
        item_id: item.id, output_index: current.index, summary_index: 0,
        part: { type: 'summary_text', text: '' },
      }));
    }
    return out;
  }

  return {
    lastCcEvent: '',
    upstreamError: null,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    get started() { return createdSent; },
    get stopReason() { return finishReason; },
    get reasoningText() { return reasoningAcc; },
    // 繁中：自動恢復要知道「上游有沒有正常收尾」「已經輸出多少文字」「送過幾個工具呼叫」。
    // English: the recovery path needs to know whether the upstream finished, and what it produced so far.
    get sawFinish() { return sawFinish; },
    get text() { return textAcc; },
    get toolCallsEmitted() { return toolCallCount; },
    beginContinuation() { sawFinish = false; },
    setCutReason(message) { cutReason = String(message || ''); },
    consumeInternalCalls() { const list = internalCalls.slice(); internalCalls.length = 0; return list; },
    parseLine(line) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === '[DONE]' || trimmed.startsWith(':')) return null;
      let event;
      try { event = JSON.parse(trimmed); } catch { return null; }
      if (!event.type) return null;
      this.lastCcEvent = event.type;
      const out = [];

      switch (event.type) {
        case 'text-start': case 'reasoning-start': case 'start': case 'start-step':
          break;

        case 'text-delta': {
          const text = event.text || event.delta || '';
          if (!text) break;
          if (!createdSent) out.push.apply(out, startResponse());
          if (!current || current.kind !== 'message') {
            out.push.apply(out, openItem('message', { type: 'message', id: newResponsesId('msg_'), status: 'in_progress', role: 'assistant', content: [] }));
          }
          current.textBuf += text;
          textAcc += text;
          out.push(sse('response.output_text.delta', { item_id: current.item.id, output_index: current.index, content_index: 0, delta: text, logprobs: [] }));
          break;
        }

        case 'reasoning-delta': {
          const text = event.text || '';
          if (!text) break;
          if (!createdSent) out.push.apply(out, startResponse());
          if (!current || current.kind !== 'reasoning') {
            out.push.apply(out, openItem('reasoning', { type: 'reasoning', id: newResponsesId('rs_'), summary: [], status: 'in_progress' }));
          }
          current.textBuf += text;
          reasoningAcc += text;
          out.push(sse('response.reasoning_summary_text.delta', {
            item_id: current.item.id, output_index: current.index, summary_index: 0, delta: text,
          }));
          break;
        }

        case 'tool-call': {
          if (!createdSent) out.push.apply(out, startResponse());
          const callId = event.toolCallId || newResponsesId('call_');
          const args = typeof event.input === 'string' ? event.input : JSON.stringify(event.input || {});
          if (internalToolNames && internalToolNames.has(event.toolName)) {
            // Tools the relay runs itself (web_search / web_fetch): never shown to the client, just recorded for later execution.
            out.push.apply(out, closeItem());
            internalCalls.push({ callId, name: event.toolName, args });
            break;
          }
          toolCallCount++;
          out.push.apply(out, openItem('function_call', {
            type: 'function_call', id: newResponsesId('fc_'), call_id: callId,
            name: resolveToolCall(clientName(event.toolName || '')).name, arguments: '', status: 'in_progress',
            namespace: SEND_NAMESPACE_FIELD ? resolveToolCall(clientName(event.toolName || '')).namespace : undefined,
          }));
          current.item.arguments = args;
          out.push(sse('response.function_call_arguments.delta', { item_id: current.item.id, output_index: current.index, delta: args }));
          break;
        }

        case 'finish': {
          sawFinish = true;
          finishReason = event.finishReason || null;
          const u = event.totalUsage || event.usage || null;
          if (u) {
            normaliseUsage(u);
            usage = u;
            this.inputTokens = u.inputTokens || 0;
            this.outputTokens = u.outputTokens || 0;
            this.cachedInputTokens = u.cachedInputTokens || 0;
          }
          break;
        }

        case 'error': {
          this.upstreamError = mapCcEventError(event);
          break;
        }

        default: break;
      }
      return out.length ? out : null;
    },
    finish() {
      if (!createdSent) return [];
      const out = closeItem();
      // finishReason=length means max_output_tokens truncated the answer: the spec requires status=incomplete
      const truncated = finishReason === 'length';
      // 繁中：沒收到 finish = 上游把串流切斷；這一輪要標成 incomplete 並把錯誤「先」送出去。
      // English: no finish event means the upstream cut the stream; mark the turn incomplete and
      // send the error BEFORE the terminal event, otherwise the client never sees it.
      const cut = !sawFinish;
      // 繁中：把「這一輪到底怎麼結束的」寫進日誌；上游沒送 finish 就斷線時，額外告訴使用者答案被切斷了，
      // 不然畫面上只會看到輸出到一半、卻沒有任何錯誤（使用者回報過的情況）。
      // English: log how the turn actually ended, and surface a cut stream instead of pretending success.
      if (!sawFinish) {
        log('warn', 'Upstream stream ended without finish', { textChars: textAcc.length, outputTokens: this.outputTokens || 0 });
      } else if (truncated) {
        log('warn', 'Answer truncated by max_output_tokens', { textChars: textAcc.length, outputTokens: this.outputTokens || 0 });
      } else {
        log('info', 'Upstream stream finished', { finishReason: finishReason || '(none)', outputTokens: this.outputTokens || 0, textChars: textAcc.length });
      }
      if (cut) {
        // 繁中：錯誤事件一定要在結尾事件之前；排在 completed 之後客戶端已停止讀取，使用者只會看到默默停住。
        // English: the error must precede the terminal event — after response.completed the client has stopped reading.
        out.push(this.errorEvent(cutReason || (textAcc.length === 0 && toolCallCount === 0
          ? 'Upstream closed the stream before producing anything (no text, no tool call). Please send the message again.'
          : 'Upstream stream ended early: the reply above is incomplete. Send "continue" to carry on.')));
      }
      out.push(sse(cut || truncated ? 'response.incomplete' : 'response.completed', {
        response: Object.assign(baseResponse(cut || truncated ? 'incomplete' : 'completed', doneItems.slice()), {
          output_text: textAcc,
          incomplete_details: truncated ? { reason: 'max_output_tokens' } : (cut ? { reason: 'upstream_closed' } : null),
          usage: buildResponsesUsage(usage, this.outputTokens),
        }),
      }));
      return out;
    },
    fail(message) {
      if (!createdSent) return [];
      return [sse('response.failed', {
        response: Object.assign(baseResponse('failed'), {
          error: { code: 'upstream_error', message: message || 'Upstream error' },
        }),
      })];
    },
    errorEvent(message) {
      return sse('error', { code: null, message: message || 'Upstream error', param: null });
    },
  };
}

async function handleResponses(req, res) {
  let respReq;
  try {
    respReq = await readBody(req);
  } catch (e) {
    if (e.statusCode === 413) { sendResponsesError(res, 413, 'invalid_request_error', e.message); return; }
    sendResponsesError(res, 400, 'invalid_request_error', 'Invalid JSON body');
    return;
  }

  if (respReq.previous_response_id) {
    sendResponsesError(res, 400, 'invalid_request_error',
      'previous_response_id is not supported (this proxy is stateless); send the full input each turn');
    return;
  }

  const apiKey = getApiKey(req.headers);
  if (!apiKey) {
    sendResponsesError(res, 401, 'authentication_error',
      'Missing API key. Send in Authorization: Bearer <key> or x-api-key header');
    return;
  }

  if (Array.isArray(respReq.input)) {
    const itemSummary = respReq.input.map((it) => {
      if (!it || typeof it !== 'object') return typeof it;
      if (it.type === 'function_call') return 'call:' + (it.call_id || '?') + ':' + (it.name || '');
      if (it.type === 'function_call_output') return 'result:' + (it.call_id || '?');
      if (it.type === 'message') return 'msg:' + (it.role || '?');
      if (it.type === 'reasoning') return 'reasoning';
      return it.type || '?';
    });
    log('info', 'Responses input items', { count: itemSummary.length, items: itemSummary.slice(-60) });
  }
  {
    // Experiment (off by default; set CC_REJECT_NAMESPACE_TOOLS=1 to enable):
    // When we accept namespace tools, the app treats MCP/app tools as non-executable (every call answers unsupported call).
    // Agent Router fails such requests outright, and the app then falls back to flat tools (where everything works).
    // This mirrors that: refuse namespace tools so the app falls back to the flat list.
    if (process.env.CC_REJECT_NAMESPACE_TOOLS === '1' && Array.isArray(respReq.tools)) {
      const nsTool = respReq.tools.find((t) => t && t.type === 'namespace');
      if (nsTool) {
        log('warn', 'Rejected namespace tools (forcing flat-tool fallback)', { namespace: nsTool.name, tools: respReq.tools.length });
        sendResponsesError(res, 400, 'invalid_request_error',
          'Unsupported tool type "namespace": this endpoint only supports flat "function" tools. Resend the tools as individual function entries.');
        return;
      }
    }
  }

  let chatReq = convertResponsesToChat(respReq);
  if (!chatReq.messages.length) {
    sendResponsesError(res, 400, 'invalid_request_error', 'input is required');
    return;
  }

  const stream = chatReq.stream === true;
  const model = chatReq.model || 'deepseek/deepseek-v4-flash';
  const responseId = newResponsesId('resp_');
  const created = nowUnix();
  const echoOpts = {
    instructions: respReq.instructions === undefined ? null : respReq.instructions,
    max_output_tokens: respReq.max_output_tokens === undefined ? null : respReq.max_output_tokens,
    temperature: respReq.temperature,
    top_p: respReq.top_p,
    reasoning: respReq.reasoning || null,
    tool_choice: typeof respReq.tool_choice === 'string' ? respReq.tool_choice : 'auto',
    tools: respReq.tools || [],
  };
  const ccBody = buildCcRequest(chatReq);
  const promptCacheKey = chatReq.prompt_cache_key;
  const baseChat = chatReq;
  chatReq = null;

  const abortController = new AbortController();
  let aborted = false;
  const startTime = Date.now();
  let bytesReceived = 0;
  let lastCcEvent = '';
  let reader = null;
  let translator = null;

  res.on('close', () => {
    if (res.writableEnded) return;
    aborted = true;
    log('warn', 'Client disconnected', {
      path: '/v1/responses', model, responseId, elapsedMs: Date.now() - startTime,
      bytesSent: bytesReceived, lastCcEvent: lastCcEvent || '(none)',
    });
    if (!abortController.signal.aborted) { try { abortController.abort(); } catch (e2) {} }
  });

  try {
    await ensureInitialized(apiKey, abortController.signal);
    debugToolsLog({ event: 'responses_in', model: respReq.model, stream: respReq.stream === true, rawTools: (Array.isArray(respReq.tools) ? respReq.tools : []).map(t => ({ type: (t && t.type) || null, name: (t && (t.name || (t.function && t.function.name))) || null, hasParams: !!(t && (t.parameters || t.input_schema)) })), inputItems: (Array.isArray(respReq.input) ? respReq.input : []).map(it => (it && it.type) || typeof it) });
    let ccResponse = await forwardToCCWithRetry(ccBody, apiKey, req.headers, abortController.signal, promptCacheKey);

    if (!ccResponse.ok) {
      let errorText = await ccResponse.text().catch(() => '');
      const ctxLimit = parseContextLimitError(errorText);
      if (ctxLimit && ctxLimit.messagesTokens < ctxLimit.limit) {
        const budget = Math.max(1024, ctxLimit.limit - ctxLimit.messagesTokens - 1024);
        const safeCompletion = Math.max(1024, Math.min(ccBody.params.max_tokens || 64000, budget));
        log('warn', 'Context limit hit, retrying with reduced max_tokens', { messagesTokens: ctxLimit.messagesTokens, limit: ctxLimit.limit, newMaxTokens: safeCompletion });
        ccResponse = await forwardToCCWithRetry({ ...ccBody, params: { ...ccBody.params, max_tokens: safeCompletion } }, apiKey, req.headers, abortController.signal, promptCacheKey);
        if (!ccResponse.ok) errorText = await ccResponse.text().catch(() => '');
      } else if (ctxLimit) {
        log('warn', 'Context limit exceeded by messages alone (cannot retry)', { messagesTokens: ctxLimit.messagesTokens, limit: ctxLimit.limit });
      }
      if (!ccResponse.ok) {
        log('error', 'CC API error', { status: ccResponse.status, path: '/v1/responses', body: String(errorText).slice(0, 200) });
        const mapped = mapCcError(ccResponse.status, errorText);
        // 繁中：串流請求要用 SSE 回報，不然客戶端只會看到「stream closed before response.completed」。
        // English: a streaming client must hear this as SSE, not as a JSON body.
        if (stream && sendResponsesStreamError(res, mapped.status, mapped.body.error.type, mapped.body.error.message)) return;
        sendResponsesError(res, mapped.status, mapped.body.error.type, mapped.body.error.message, mapped.body.retry_after);
        return;
      }
    }

    if (stream) {
      const internalToolNames = new Set();
      if (baseChat.__webTools && baseChat.__webTools.search) internalToolNames.add(WEB_SEARCH_NAME);
      if (baseChat.__webTools && baseChat.__webTools.fetch) internalToolNames.add(WEB_FETCH_NAME);
      translator = createResponsesSseTranslator(model, responseId, created, { internalToolNames, toolNameMap: baseChat.__toolNameMap, toolNamespaces: baseChat.__toolNamespaces });
      let buffer = '';
      let started = false;
      // 繁中：一輪最多自動救 2 次，避免上游一直斷時無限迴圈。
      // English: at most two automatic recoveries per turn, so a flapping upstream cannot loop for ever.
      let recoveryAttempts = 0;
      const decoder = new TextDecoder();
      const idle = createIdleWatchdog(STREAM_IDLE_TIMEOUT_MS);
      const SSE_HEADERS = {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      };
      const writeEvents = async (evts) => {
        if (!started) { res.writeHead(200, SSE_HEADERS); started = true; }
        for (const e2 of evts) res.write(e2);
        await waitDrain(res);
      };
      const convoMessages = baseChat.messages.slice();
      let currentResponse = ccResponse;
      let round = 0;

      try {
        while (true) {
          reader = currentResponse.body.getReader();
          buffer = '';
          while (true) {
            const result = await Promise.race([reader.read(), idle.arm()]);
            const done = result.done;
            const value = result.value;
            if (done) break;
            if (aborted || res.destroyed) break;
            bytesReceived += value.length;
            const chunkText = decoder.decode(value, { stream: true });
            buffer += chunkText;
            let lines = [];
            if (chunkText.indexOf('\n') !== -1) {
              lines = buffer.split('\n');
              buffer = lines.pop() || '';
            }
            for (const line of lines) {
              const evts = translator.parseLine(line);
              if (evts) await writeEvents(evts);
              if (translator.lastCcEvent) lastCcEvent = translator.lastCcEvent;
            }
          }
          if (aborted) break;
          if (buffer.trim()) {
            const evts = translator.parseLine(buffer);
            if (evts) await writeEvents(evts);
          }

          if (translator.upstreamError) {
            log('error', 'CC stream error event', { status: translator.upstreamError.status, message: translator.upstreamError.body.error.message });
            if (!started) {
              sendResponsesError(res, translator.upstreamError.status,
                translator.upstreamError.body.error.type, translator.upstreamError.body.error.message,
                translator.upstreamError.body.retry_after);
              return;
            }
            const failed = translator.fail(translator.upstreamError.body.error.message);
            if (failed.length) await writeEvents(failed);
            break;
          }

          const internalCalls = translator.consumeInternalCalls();
          if (internalCalls.length && round < MAX_WEB_ROUNDS) {
            round++;
            const results = [];
            for (const call of internalCalls) {
              const text = await executeCcWebTool(call.name, call.args, apiKey, req.headers, promptCacheKey, abortController.signal);
              results.push({ call, text });
            }
            log('info', 'Executed internal web tools', { round, tools: internalCalls.map((c) => c.name), chars: results.map((r) => r.text.length) });
            const assistantMsg = { role: 'assistant', content: null, tool_calls: internalCalls.map((c) => ({ id: c.callId, type: 'function', function: { name: c.name, arguments: c.args } })) };
            if (translator.reasoningText) assistantMsg.reasoning_content = translator.reasoningText;
            convoMessages.push(assistantMsg);
            for (const r of results) convoMessages.push({ role: 'tool', tool_call_id: r.call.callId, name: r.call.name, content: r.text });
            const nextBody = buildCcRequest(Object.assign({}, baseChat, { messages: convoMessages }));
            const next = await forwardToCCWithRetry(nextBody, apiKey, req.headers, abortController.signal, promptCacheKey);
            if (!next.ok) {
              const errText = await next.text().catch(() => '');
              const mapped = mapCcError(next.status, errText);
              if (!started) {
                sendResponsesError(res, mapped.status, mapped.body.error.type, mapped.body.error.message, mapped.body.retry_after);
                return;
              }
              const failed = translator.fail(mapped.body.error.message);
              if (failed.length) await writeEvents(failed);
              break;
            }
            currentResponse = next;
            continue;
          }

          // 繁中：上游沒送 finish 就把串流關掉（使用者看到的「斷一半」）→ 自動重試或接續，最多兩次。
          // English: the upstream closed the stream without its finish event — the "cut off" the user sees.
          // Retry when nothing came through, or continue the partial answer, instead of passing the cut on.
          if (!translator.sawFinish && recoveryAttempts < 4) {
            recoveryAttempts++;
            const partial = translator.text;
            const nothingYet = partial.length === 0 && translator.toolCallsEmitted === 0;
            // 繁中：零位元組斷流代表這一條 session 可能已經死在上游；重試前先換一條新的，
            // 這個對話之後也會沿用新 session，不必等到 12 小時的自然汰換。
            // English: a zero-byte cut smells like a dead session — rotate to a fresh one before retrying,
            // and remember the rotation so the rest of this conversation keeps off the dead session too.
            const rotated = nothingYet ? rotateSession(apiKey, req.headers, promptCacheKey) : null;
            // 繁中：上游瞬間過載時立刻重試常常還是被切；先等一下再試，並記下請求大小方便比對。
            // English: an immediately repeated call often gets cut again while the upstream is busy — wait a
            // little, and record how big the request was so cut patterns can be compared later.
            if (recoveryAttempts > 1) await new Promise((r) => setTimeout(r, 900 * (recoveryAttempts - 1)));
            log('warn', 'Upstream cut the stream — recovering', { attempt: recoveryAttempts, nothingYet, textChars: partial.length, inputItems: Array.isArray(respReq.input) ? respReq.input.length : 0, rotatedSession: rotated ? rotated.sessionId.slice(0, 8) : false });
            const contMessages = convoMessages.slice();
            if (!nothingYet && partial) {
              contMessages.push({ role: 'assistant', content: partial });
              contMessages.push({ role: 'user', content: 'Continue exactly where you stopped. Do not repeat anything you already wrote; carry straight on from the last character.' });
            }
            const retryBody = buildCcRequest(Object.assign({}, baseChat, { messages: contMessages }));
            const retry = await forwardToCCWithRetry(retryBody, apiKey, req.headers, abortController.signal, promptCacheKey);
            if (retry.ok) {
              translator.beginContinuation();
              currentResponse = retry;
              continue;
            }
            {
              const errText = await retry.text().catch(() => '');
              const mapped = mapCcError(retry.status, errText);
              // 繁中：把上游真正的原因（例如 429 週額度）帶到 finish()，使用者才看得到為什麼被斷。
              // English: carry the upstream's own reason (e.g. a 429 weekly limit) into finish() so the
              // client sees why the turn ended instead of a generic message.
              translator.setCutReason(mapped.body.error.message || ('Upstream error ' + retry.status));
            }
            log('warn', 'Stream recovery failed', { status: retry.status });
          }

          if (translator.outputTokens === 0 && !translator.started) {
            try { if (!abortController.signal.aborted) abortController.abort(); } catch (e2) {}
            if (stream && sendResponsesStreamError(res, 429, 'rate_limit_error', 'Empty response from upstream (zero output tokens)')) return;
            sendResponsesError(res, 429, 'rate_limit_error',
              'Empty response from upstream (zero output tokens)', 10);
            return;
          }
          if (!started) { res.writeHead(200, SSE_HEADERS); started = true; }
          for (const e2 of translator.finish()) res.write(e2);
          consecutiveTimeouts = 0;
          break;
        }
      } catch (e) {
        if (aborted) {
          try { reader.cancel(); } catch (e2) {}
        } else if (e.message === 'STREAM_IDLE_TIMEOUT') {
          log('warn', 'Stream idle timeout', {
            path: '/v1/responses', model, streaming: true, timeoutMs: STREAM_IDLE_TIMEOUT_MS,
            elapsedMs: Date.now() - startTime, bytesReceived, lastCcEvent: lastCcEvent || '(none)',
          });
          consecutiveTimeouts++;
          const timeoutMsg = consecutiveTimeouts >= TIMEOUT_REDUCE_CONTEXT_THRESHOLD
            ? 'Response timeout - try reducing context length (summarize earlier messages)'
            : 'Response timeout - request timed out';
          if (!started) {
            // 繁中：串流請求要用 SSE 回報（重試中的客戶端才看得懂）。
            // English: streaming clients need the failure as SSE.
            if (stream && sendResponsesStreamError(res, 429, 'rate_limit_error', timeoutMsg)) return;
            sendResponsesError(res, 429, 'rate_limit_error', timeoutMsg, 5); return; }
          if (!res.writableEnded) {
            // 繁中：一定要用 res.end() 收尾；res.destroy() 會把剛寫入的錯誤事件一起丟掉，
            // 客戶端只會看到「沒報錯就停住」。也順手取消上游讀取，不讓它繼續燒。
            // English: end the response so the freshly written error event actually goes out — a res.destroy()
            // here drops it and the stop looks silent. Cancel the upstream read as well.
            try { reader.cancel(); } catch (e2) {}
            try { abortController.abort(); } catch (e2) {}
            try { res.write(translator.errorEvent(timeoutMsg)); } catch (e2) {}
            try { res.end(); } catch (e2) {}
          }
        } else {
          log('error', 'Stream error', { message: e.message, path: '/v1/responses' });
          try { abortController.abort(); } catch (e2) {}
          if (!started) {
            if (stream && sendResponsesStreamError(res, 502, 'proxy_error', 'Upstream error: ' + e.message)) return;
            if (stream && sendResponsesStreamError(res, 502, 'proxy_error', 'Upstream error: ' + e.message)) return;
          sendResponsesError(res, 502, 'proxy_error', 'Upstream error: ' + e.message, 10);
            return;
          }
          if (!res.writableEnded) {
            try { res.write(translator.errorEvent(e.message)); } catch (e2) {}
          }
        }
      } finally {
        idle.dispose();
      }

      if (!res.writableEnded) res.end();
    } else {
      // ── Non-streaming: buffer the whole NDJSON, then build the Responses object once (with the web-tool loop) ──
      const internalToolNames = new Set();
      if (baseChat.__webTools && baseChat.__webTools.search) internalToolNames.add(WEB_SEARCH_NAME);
      if (baseChat.__webTools && baseChat.__webTools.fetch) internalToolNames.add(WEB_FETCH_NAME);
      const convoMessages = baseChat.messages.slice();
      let currentResponse = ccResponse;
      let round = 0;
      let outText = '';
      let outThinking = '';
      let outUsage = null;
      let outFinish = 'stop';
      let outToolCalls = [];

      while (true) {
        let fullText = '';
        let thinkingText = '';
        let usage = null;
        let finishReason = 'stop';
        let upstreamError = null;
        const toolCalls = [];
        reader = currentResponse.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        const processLines = () => {
          const lines = buf.split('\n');
          buf = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed === '[DONE]' || trimmed.startsWith(':')) continue;
            let event;
            try { event = JSON.parse(trimmed); } catch (e2) { continue; }
            switch (event.type) {
              case 'text-delta': lastCcEvent = event.type; fullText += event.text || ''; break;
              case 'reasoning-delta': lastCcEvent = event.type; thinkingText += event.text || ''; break;
              case 'tool-call': {
                lastCcEvent = event.type;
                toolCalls.push({
                  id: event.toolCallId || ('call_' + randomUUID().slice(0, 8)),
                  type: 'function',
                  namespace: ((process.env.CC_SEND_NAMESPACE_FIELD !== '0') && baseChat.__toolNamespaces && baseChat.__toolNamespaces.get(event.toolName)) || undefined,
                  function: {
                    name: event.toolName || '',
                    arguments: typeof event.input === 'string' ? event.input : JSON.stringify(event.input || {}),
                  },
                });
                break;
              }
              case 'finish':
                lastCcEvent = event.type;
                finishReason = mapFinishReason(event.finishReason || 'stop');
                if (event.totalUsage || event.usage) usage = event.totalUsage || event.usage;
                break;
              case 'error':
                lastCcEvent = event.type;
                log('warn', 'CC stream error (non-stream)', { message: event.error ? event.error.message : event.message });
                upstreamError = mapCcEventError(event);
                break;
              default:
                log('warn', 'Unknown CC event type', { type: event.type });
                break;
            }
          }
        };

        const idle = createIdleWatchdog(NONSTREAM_IDLE_TIMEOUT_MS);
        while (true) {
          const result = await Promise.race([reader.read(), idle.arm()]);
          const done = result.done;
          const value = result.value;
          if (done) break;
          bytesReceived += value.length;
          const chunkText = decoder.decode(value, { stream: true });
          buf += chunkText;
          if (chunkText.indexOf('\n') !== -1) processLines();
        }
        idle.dispose();
        processLines();

        if (upstreamError) {
          sendResponsesError(res, upstreamError.status, upstreamError.body.error.type,
            upstreamError.body.error.message, upstreamError.body.retry_after);
          return;
        }

        const internal = toolCalls.filter((t) => internalToolNames.has(t.function.name));
        if (internal.length && round < MAX_WEB_ROUNDS) {
          round++;
          const results = [];
          for (const call of internal) {
            const text = await executeCcWebTool(call.function.name, call.function.arguments, apiKey, req.headers, promptCacheKey, abortController.signal);
            results.push({ call, text });
          }
          log('info', 'Executed internal web tools (non-stream)', { round, tools: internal.map((c) => c.function.name), chars: results.map((r) => r.text.length) });
          const assistantMsg = { role: 'assistant', content: null, tool_calls: internal.map((c) => ({ id: c.id, type: 'function', function: { name: c.function.name, arguments: c.function.arguments } })) };
          if (thinkingText) assistantMsg.reasoning_content = thinkingText;
          convoMessages.push(assistantMsg);
          for (const r of results) convoMessages.push({ role: 'tool', tool_call_id: r.call.id, name: r.call.function.name, content: r.text });
          const nextBody = buildCcRequest(Object.assign({}, baseChat, { messages: convoMessages }));
          const next = await forwardToCCWithRetry(nextBody, apiKey, req.headers, abortController.signal, promptCacheKey);
          if (!next.ok) {
            const errText = await next.text().catch(() => '');
            const mapped = mapCcError(next.status, errText);
            sendResponsesError(res, mapped.status, mapped.body.error.type, mapped.body.error.message, mapped.body.retry_after);
            return;
          }
          currentResponse = next;
          continue;
        }

        outText = fullText;
        outThinking = thinkingText;
        outUsage = usage;
        outFinish = finishReason;
        outToolCalls = toolCalls.filter((t) => !internalToolNames.has(t.function.name));
        break;
      }

      if (!outText && !outThinking && !outToolCalls.length) {
        try { if (!abortController.signal.aborted) abortController.abort(); } catch (e2) {}
        sendResponsesError(res, 429, 'rate_limit_error',
          'Empty response from upstream (zero output tokens)', 10);
        return;
      }

      consecutiveTimeouts = 0;
      echoOpts.finishReason = outFinish;
      sendJSON(res, 200, buildResponsesObject(
        responseId, model, created, outText, outThinking, outToolCalls, outUsage, echoOpts));
    }
  } catch (e) {
    if (e.name === 'AbortError' || e.code === 'ABORT_ERR') return;
    log('error', 'Responses handler error', { message: e.message });
    if (!res.headersSent) {
      sendResponsesError(res, 502, 'proxy_error', 'Upstream error: ' + e.message, 10);
    } else if (!res.writableEnded) {
      try { res.write(translator ? translator.errorEvent(e.message) : ''); } catch (e2) {}
      try { res.end(); } catch (e2) {}
    }
  }
}

async function handleModels(req, res) {
  const apiKey = getApiKey(req.headers);
  const models = await fetchModels(apiKey);
  const now = nowUnix();
  sendJSON(res, 200, {
    object: 'list',
    data: models.map(m => ({
      id: m.id,
      object: 'model',
      created: now,
      owned_by: 'command-code',
    })),
  });
}

function handleHealth(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
}

// ── Server / 伺服器 ─────────────────────────────────

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const host = req.headers.host || 'localhost';
  const url = new URL(req.url, `http://${host}`);

  // In-flight admission. /health and / are exempt: probes and orchestrators should never see a 503 just because business traffic is busy.
  const isLiveness = url.pathname === '/health' || url.pathname === '/';
  if (!isLiveness && MAX_INFLIGHT > 0) {
    if (inflightCount >= MAX_INFLIGHT) {
      log('warn', 'In-flight limit reached, rejecting request', {
        maxInflight: MAX_INFLIGHT, inflight: inflightCount, path: url.pathname,
      });
      sendJSON(res, 503, {
        error: { message: `Too many concurrent requests (limit ${MAX_INFLIGHT}), retry shortly`, type: 'server_busy' },
        retry_after: 5,
      });
      return;
    }
    inflightCount++;
    // Release timing: when the response finishes or the connection closes — whichever comes first, and idempotent,
    // 繁中：槽位在回應完成或連線關閉時釋放（取先到者且冪等），確保任何退出路徑都不會漏掉槽位。
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (inflightCount > 0) inflightCount--;
    };
    res.once('finish', release);
    res.once('close', release);
  }

  try {
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      await handleChatCompletions(req, res);
    } else if (url.pathname === '/v1/messages' && req.method === 'POST') {
      await handleMessages(req, res);
    } else if (url.pathname === '/v1/responses' && req.method === 'POST') {
      await handleResponses(req, res);
    } else if (url.pathname === '/v1/models' && req.method === 'GET') {
      await handleModels(req, res);
    } else if (url.pathname === '/health' || url.pathname === '/') {
      handleHealth(req, res);
    } else {
      sendJSON(res, 404, { error: { message: 'Not found', type: 'not_found' } });
    }
  } catch (e) {
    sendJSON(res, 500, { error: { message: e.message, type: 'internal_error' } });
  }
});

// Global backstop: an async rejection triggered by an abort must not bring the process down
process.on('unhandledRejection', (reason) => {
  if (reason?.name === 'AbortError' || reason?.code === 'ABORT_ERR') {
    // An abort caused by a client disconnect — expected, handled quietly
    log('info', 'Aborted request cleaned up');
  } else {
    log('error', 'Unhandled rejection', { message: reason?.message || String(reason), stack: reason?.stack?.split('\n')[0] });
  }
});

// 繁中：Node 預設 keep-alive 閒置 5 秒就關連線；桌面客戶端重用連線池時偶爾會撞上「連線剛好被關」的
// 競態，而 POST 不會自動重試，就變成一次無聲失敗。把閒置窗口拉長到 65 秒避開這個節奏。
// English: Node closes idle keep-alive sockets after 5s by default; a desktop chat client reusing that socket
// can race the close, and a POST is not retried automatically. Give idle sockets 65s instead.
server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;
server.listen(CFG.port, CFG.host, () => {
  log('info', 'Cider CC UwU is open ~ pull up a stool :3', {
    webTools: 'web_search/web_fetch internal execution on',
    aliasProbe: (process.env.CC_NAMESPACE_ALIAS_PROBE === '1') ? ('on: ' + (process.env.CC_ALIAS_PROBE_TOOL || 'list_threads')) : 'off',
    url: `http://${CFG.host}:${CFG.port}`,
    api: CFG.apiBase,
    models: MODELS.length,
    session: '12h + 1h jitter, per API key',
    zdr: CFG.zdr ? 'enabled (x-cmd-zdr: 1 on generation/init requests)' : 'off (CMD_ZDR=1 or per-request x-cmd-zdr: 1 to enable)',
    emptySystemPlaceholder: CFG.emptySystemPlaceholder ? 'on (space placeholder for requests without system prompt, issue #17)' : 'off',
    logLevel: CFG.logLevel || 'info',
    logFile: CFG.logFile || '(console only)',
    clientDrainTimeout: CLIENT_DRAIN_TIMEOUT_MS > 0 ? `${CLIENT_DRAIN_TIMEOUT_MS}ms` : 'disabled',
    idleTimeouts: `stream ${STREAM_IDLE_TIMEOUT_MS}ms / nonstream ${NONSTREAM_IDLE_TIMEOUT_MS}ms`,
    maxInflight: MAX_INFLIGHT > 0 ? `${MAX_INFLIGHT} (global, /health exempt)` : 'unlimited (CC_MAX_INFLIGHT=0)',
  });
  if (CLIENT_DRAIN_TIMEOUT_MS > 0) {
    log('info', 'Client drain timeout enabled', { timeoutMs: CLIENT_DRAIN_TIMEOUT_MS });
  }
  // Memory hint: the implied worst case is the cap × the measured multiplier (see MAX_BODY_SIZE / issue #20)
  const bodyCapMB = Math.round(MAX_BODY_SIZE / 1048576);
  const worstCaseMB = Math.round(bodyCapMB * 5.5);
  if (worstCaseMB >= 500) {
    log('warn', 'Request body limit implies high per-request worst-case memory', {
      maxBodyMB: bodyCapMB,
      worstCaseRSSPerRequestMB: worstCaseMB,
      hint: 'lower CC_MAX_BODY_MB and/or cap in-flight requests at the reverse proxy (see README)',
    });
  }
  if (!CFG.apiKey) {
    log('info', 'No API key in config. API key must be sent in Authorization: Bearer <key> header per request.');
  }
  // Fire-and-forget: a slow or unreachable feed never delays the bar opening. :3
  void checkForUpdate();
});
