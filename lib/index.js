import { SettingsConflictError, SettingsProvider } from "@deepseek-ai/dsh-settings";
import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import fs from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";

const DDG_HTML_URL = "https://html.duckduckgo.com/html/";
const DDG_LITE_URL = "https://lite.duckduckgo.com/lite/";
const BING_URL = "https://www.bing.com/search";
const TAVILY_URL = "https://api.tavily.com/search";
const FIRECRAWL_URL = "https://api.firecrawl.dev/v2/search";
const PARALLEL_URL = "https://api.parallel.ai/v1/search";
const KEENABLE_URL = "https://api.keenable.ai/v1/search";
const KEENABLE_MCP_URL = "https://api.keenable.ai/mcp";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const ACCEPT_LANG = "zh-CN,zh;q=0.9,en;q=0.8";

// Язык → локализация Bing: { market, acceptLang }.
// Поле lang (переключается на странице настроек) управляет mkt + Accept-Language
// для Bing, чтобы не-китайские пользователи тоже получали локализованные результаты
const LANG_PROFILES = {
  zh: { market: "zh-CN", acceptLang: "zh-CN,zh;q=0.9,en;q=0.8" },
  en: { market: "en-US", acceptLang: "en-US,en;q=0.9" },
  ru: { market: "ru-RU", acceptLang: "ru-RU,ru;q=0.9,en;q=0.8" },
  ja: { market: "ja-JP", acceptLang: "ja-JP,ja;q=0.9,en;q=0.8" },
  de: { market: "de-DE", acceptLang: "de-DE,de;q=0.9,en;q=0.8" },
  fr: { market: "fr-FR", acceptLang: "fr-FR,fr;q=0.9,en;q=0.8" },
  es: { market: "es-ES", acceptLang: "es-ES,es;q=0.9,en;q=0.8" },
  ko: { market: "ko-KR", acceptLang: "ko-KR,ko;q=0.9,en;q=0.8" },
};
// market → язык (если bingMarket задан явно, accept-language выводится из него,
const MARKET_TO_LANG = {
  "zh-CN": "zh-CN,zh;q=0.9,en;q=0.8",
  "zh-TW": "zh-TW,zh;q=0.9,en;q=0.8",
  "en-US": "en-US,en;q=0.9",
  "en-GB": "en-GB,en;q=0.9",
  "ru-RU": "ru-RU,ru;q=0.9,en;q=0.8",
  "ja-JP": "ja-JP,ja;q=0.9,en;q=0.8",
  "de-DE": "de-DE,de;q=0.9,en;q=0.8",
  "fr-FR": "fr-FR,fr;q=0.9,en;q=0.8",
  "es-ES": "es-ES,es;q=0.9,en;q=0.8",
  "ko-KR": "ko-KR,ko;q=0.9,en;q=0.8",
};

const FREE_SEARCH_NS = "free-search";
const BRIDGE_PREFIX = "/api/dsh-free-search-settings";
const FREE_ENGINES = ["ddg", "ddg-lite", "bing", "searxng", "anysearch"];
const ALL_ENGINES = ["ddg", "ddg-lite", "bing", "searxng", "anysearch", "exa", "tavily", "keenable", "firecrawl", "parallel", "perplexity", "deepseek-official"];

// Текущая версия плагина (синхронизируется с package.json при релизе)
const PLUGIN_VERSION = "0.4.29";
// Адрес метаданных npm registry для проверки обновлений (dsh-free-search — публичный пакет на npmjs)
const NPM_REGISTRY_URL = "https://registry.npmjs.org/dsh-free-search/latest";
const PLUGIN_NPM_URL = "https://www.npmjs.com/package/dsh-free-search";
const PLUGIN_REPO_URL = "https://github.com/DDDMUC/dsh-free-search";

// Запрашивает последнюю версию в npm registry; при сбое возвращает null (проблемы с сетью/прокси не блокируют страницу настроек)
async function fetchLatestVersion(signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    const response = await fetch(NPM_REGISTRY_URL, {
      headers: { accept: "application/json", "user-agent": "deepseek-harness/free-search" },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const data = await response.json();
    return typeof data.version === "string" ? data.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

// Простое сравнение semver (обрабатывает только x.y.z major/minor/patch, игнорирует pre-release теги); a>b возвращает 1, a<b возвращает -1, равны — 0
function compareVersions(a, b) {
  const na = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const nb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((na[i] ?? 0) > (nb[i] ?? 0)) return 1;
    if ((na[i] ?? 0) < (nb[i] ?? 0)) return -1;
  }
  return 0;
}

// Определяет режим установки плагина: обход profiles/*/node_modules/dsh-free-search,
// symlink (link: локальная разработка) → isLink=true; реальная установка npm → isLink=false; не найдено → null
function detectInstallMode() {
  const profilesDir = path.join(process.cwd(), "profiles");
  let found = null;
  try {
    for (const name of fs.readdirSync(profilesDir)) {
      const pkgPath = path.join(profilesDir, name, "node_modules", "dsh-free-search");
      if (!fs.existsSync(pkgPath)) continue;
      let isLink = false;
      try {
        isLink = fs.lstatSync(pkgPath).isSymbolicLink();
      } catch {}
      found = { profileDir: path.join(profilesDir, name), isLink };
      break;
    }
  } catch {}
  return found;
}

// Поддержка time_range: фиксированные уровни day/week/month/year или пользовательские (относительные 12h/3d/2mo/1y, абсолютные YYYY-MM-DD)
const TIME_RANGES = ["day", "week", "month", "year"];
const DAYS_BY_RANGE = { day: 1, week: 7, month: 30, year: 365 };
const KEENABLE_REL = { day: "1d", week: "7d", month: "1mo", year: "1y" };
const SEARXNG_TIME = { day: "day", week: "week", month: "month", year: "year" };

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, ".000Z");
}

// Разбирает timeRange от пользователя/агента в единый объект: { days } — относительное число дней, или { after } — абсолютная дата.
// Поддерживаемые входы: day/week/month/year, 12h/3d/2mo/1y, 2026-07-01, или уже разобранный объект {days}/{after}.
// При невалидном входе возвращает undefined.
function parseTimeRange(input) {
  if (input === undefined || input === null) return undefined;
  // Уже разобранный объект: передаём как есть
  if (typeof input === "object") {
    if (typeof input.after === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.after)) return { after: input.after };
    if (typeof input.days === "number" && Number.isFinite(input.days) && input.days > 0) return { days: input.days };
    return undefined;
  }
  const s = String(input).trim().toLowerCase();
  if (s.length === 0) return undefined;
  if (TIME_RANGES.includes(s)) return { days: DAYS_BY_RANGE[s] };
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { after: s };
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(h|hour|hours|d|day|days|w|week|weeks|mo|month|months|y|year|years)$/);
  if (m) {
    const n = parseFloat(m[1]);
    const unit = m[2][0];
    const days =
      unit === "h" ? n / 24 : unit === "d" ? n : unit === "w" ? n * 7 : unit === "m" ? n * 30 : n * 365;
    return { days };
  }
  return undefined;
}

// Сопоставляет произвольное число дней ближайшему фиксированному уровню для движков, поддерживающих только уровни (Tavily / SearXNG / DDG)
function approximateTimeRange(days) {
  if (days <= 2) return "day";
  if (days <= 14) return "week";
  if (days <= 90) return "month";
  return "year";
}

function decodeEntities(text) {
  return String(text)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

//#region Кэш результатов (защита от лимитов/экономия квоты, LRU 50 записей, настраиваемый TTL 0-5 минут)
const CACHE_MAX_ENTRIES = 50;
// Для записей фоллбэка (фактический движок ≠ предпочитаемый) TTL = 1/5 от настроенного TTL (по умолчанию 5 минут → 60 секунд):
// как только предпочитаемый движок снова заработает, новый результат будет доступен максимум через минуту, избегая залипания фоллбэка на полном TTL; успешные записи предпочитаемого движка по-прежнему используют полный TTL.

function buildCacheKey(query, maxResults, timeRangeLabel, preferred) {
  return [query ?? "", maxResults ?? 5, timeRangeLabel ?? "", preferred].join("\u0000");
}
//#endregion

// Единая очистка сниппетов: удаление шумовых фраз про регистрацию/платный доступ/подписку, схлопывание пробелов, ограничение длины.
// Применяется только на выходе цепочки фоллбэка; внутри движков не выполняется — чтобы избежать двойной обработки.
const SNIPPET_NOISE =
  /\b(sign up|sign in|log in|login|subscribe( to| for)?|member[- ]?only|become a member|create (a )?free account|read more|continue reading|story continues|get started|install (the )?app|view on|medium membership|join \w+ for free|get updates from this writer|stories in your inbox|remember me for|unlock this|free to read|become a patron)\b/gi;

function cleanSnippet(text) {
  if (!text) return text;
  return String(text)
    .replace(SNIPPET_NOISE, " ")
    .replace(/^\s*(#{1,6}\s*|\[\s*x?\s*\]\s*|-\s*\[\s*x?\s*\]\s*|>\s*)/gm, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function stripTags(html) {
  return decodeEntities(String(html).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function extractDdgUrl(rel) {
  if (!rel) return null;
  const m = rel.match(/uddg=([^&]+)/);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return m[1];
    }
  }
  if (rel.startsWith("//")) return `https:${rel}`;
  return rel;
}

function uniqueSources(sources, limit) {
  const seen = new Set();
  const out = [];
  for (const s of sources) {
    if (s.url && !seen.has(s.url)) {
      seen.add(s.url);
      out.push(s);
    }
    if (out.length >= limit) break;
  }
  return out;
}

async function fetchHtml(url, signal, acceptLang) {
  // Таймаут одного запроса 12 с — чтобы зависание не выглядело как Connection error
  let response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort);
    response = await fetch(url, {
      headers: { "user-agent": USER_AGENT, "accept-language": acceptLang ?? ACCEPT_LANG },
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`connection error: ${error?.message ?? String(error)}`);
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url.split("?")[0]}`);
  }
  const html = await response.text();
  // Детект антибот-проверки DuckDuckGo (HTTP 202 или ключевые слова проверки)
  if (response.status === 202 || /anomaly|captcha|unusual traffic|robot check/i.test(html.slice(0, 4000))) {
    throw new Error("DuckDuckGo is rate-limited right now (anti-bot challenge, usually temporary) - Bing works");
  }
  return html;
}

// Запрос с ретраями: при сетевых ошибках/пустом ответе повторяет через 1,5 с, максимум 3 попытки
async function fetchHtmlWithRetry(url, signal, acceptLang) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const html = await fetchHtml(url, signal, acceptLang);
      if (html.length > 500) return html;
      lastError = new Error(`empty response (${html.length} bytes)`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw lastError ?? new Error("fetch failed");
}

async function searchDdgHtml(query, maxResults, options, signal) {
  const params = new URLSearchParams({ q: query });
  if (options?.region) params.set("kl", options.region);
  // Безопасный поиск DDG: off(adlt=-1) / moderate(adlt=0) / strict(adlt=1)
  const adlt = options?.safeSearch ?? "off";
  params.set("adlt", adlt === "strict" ? "1" : adlt === "moderate" ? "0" : "-1");
  // Временной фильтр DDG: df=d/w/m/y (только фиксированные уровни; произвольные значения приводятся к ближайшему)
  if (options?.timeRange) {
    const df = { day: "d", week: "w", month: "m", year: "y" }[approximateTimeRange(options.timeRange.days ?? 7)];
    if (df) params.set("df", df);
  }
  const html = await fetchHtmlWithRetry(`${DDG_HTML_URL}?${params}`, signal);
  const blocks = html.match(/<div class="result results_links[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/g) ?? [];
  const sources = [];
  for (const block of blocks) {
    const urlMatch = block.match(/<a[^>]*class="result__a"[^>]*href="([^"]*)"/);
    const titleMatch = block.match(/<a[^>]*class="result__a"[^>]*>(.*?)<\/a>/);
    const snippetMatch = block.match(/<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/);
    const dateMatch = block.match(/<span[^>]*>\s*([\dT:.+-]+)\s*<\/span>/);
    const url = extractDdgUrl(urlMatch?.[1]);
    if (!url) continue;
    sources.push({
      url,
      ...(titleMatch ? { title: stripTags(titleMatch[1]) } : {}),
      ...(snippetMatch ? { snippet: stripTags(snippetMatch[1]) } : {}),
      ...(dateMatch ? { publishedAt: dateMatch[1] } : {}),
    });
  }
  return { sources: uniqueSources(sources, maxResults ?? 10), truncated: false };
}

async function searchDdgLite(query, maxResults, options, signal) {
  const params = new URLSearchParams({ q: query });
  const adlt = options?.safeSearch ?? "off";
  params.set("adlt", adlt === "strict" ? "1" : adlt === "moderate" ? "0" : "-1");
  // DDG Lite так же поддерживает временной фильтр df
  if (options?.timeRange) {
    const df = { day: "d", week: "w", month: "m", year: "y" }[approximateTimeRange(options.timeRange.days ?? 7)];
    if (df) params.set("df", df);
  }
  const html = await fetchHtmlWithRetry(`${DDG_LITE_URL}?${params}`, signal);
  const linkMatches = html.match(/<a[^>]*class=['"]result-link['"][^>]*>[\s\S]*?<\/a>/g) ?? [];
  const snippetMatches = html.match(/class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/g) ?? [];
  const sources = [];
  for (let i = 0; i < linkMatches.length; i++) {
    const tag = linkMatches[i];
    const hrefMatch = tag.match(/href="([^"]*)"/);
    const titleMatch = tag.match(/class=['"]result-link['"][^>]*>(.*?)<\/a>/);
    if (!hrefMatch) continue;
    const url = extractDdgUrl(hrefMatch[1]);
    if (!url) continue;
    const snippet = snippetMatches[i]?.match(/class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/)?.[1];
    sources.push({
      url,
      ...(titleMatch ? { title: stripTags(titleMatch[1]) } : {}),
      ...(snippet ? { snippet: stripTags(snippet) } : {}),
    });
  }
  return { sources: uniqueSources(sources, maxResults ?? 10), truncated: false };
}

async function searchBing(query, maxResults, options, signal) {
  // mkt: явный bingMarket имеет приоритет; иначе берётся по lang (zh→zh-CN, ru→ru-RU ...)
  const profile = LANG_PROFILES[options?.lang] ?? LANG_PROFILES.zh;
  const market = options?.bingMarket ?? profile.market;
  const params = new URLSearchParams({ q: query, mkt: market });
  // Accept-Language: при явном bingMarket выводится из market (чтобы китайский заголовок не загрязнял выдачу), иначе используется профиль по lang
  const acceptLang = options?.bingMarket
    ? (MARKET_TO_LANG[market] ?? ACCEPT_LANG)
    : (profile.acceptLang ?? ACCEPT_LANG);
  const adlt = options?.safeSearch ?? "off";
  if (adlt === "off") params.set("adlt", "off");
  else if (adlt === "moderate") params.set("adlt", "moderate");
  else if (adlt === "strict") params.set("adlt", "strict");
  const html = await fetchHtmlWithRetry(`${BING_URL}?${params}`, signal, acceptLang);
  const blocks = html.match(/<li class="b_algo"[\s\S]*?<\/li>/g) ?? [];
  const sources = [];
  for (const block of blocks) {
    const hrefMatch = block.match(/<a[^>]*href="(https?:\/\/[^"]+)"/);
    const titleMatch = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*>(.*?)<\/a>[\s\S]*?<\/h2>/);
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    if (!hrefMatch) continue;
    sources.push({
      url: hrefMatch[1],
      ...(titleMatch ? { title: stripTags(titleMatch[1]) } : {}),
      ...(snippetMatch ? { snippet: stripTags(snippetMatch[1]) } : {}),
    });
  }
  return { sources: uniqueSources(sources, maxResults ?? 10), truncated: false };
}

//#region searxng (meta-search, free instances, auto-failover)
const SEARXNG_INSTANCES = [
  "https://opnxng.com",
  "https://priv.au",
  "https://searx.be",
  "https://searx.tiekoetter.com",
  "https://search.inetol.net",
  "https://paulgo.io",
];

async function searchSearxng(query, maxResults, options, signal) {
  const instances = options?.searxngInstances?.length
    ? options.searxngInstances
    : SEARXNG_INSTANCES;
  // Собирает причины сбоев по всем инстансам, чтобы не показывать только ошибку последнего
  const errors = [];
  for (const base of instances) {
    try {
      const params = new URLSearchParams({ q: query, format: "json" });
      // SearXNG нативно поддерживает фильтр time_range (только фиксированные уровни; произвольные значения приводятся к ближайшему)
      if (options?.timeRange) {
        const tr = SEARXNG_TIME[approximateTimeRange(options.timeRange.days ?? 7)];
        if (tr) params.set("time_range", tr);
      }
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const onAbort = () => ctrl.abort();
      signal?.addEventListener("abort", onAbort);
      const response = await fetch(`${base}/search?${params}`, {
        headers: { "user-agent": USER_AGENT, accept: "application/json" },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (!response.ok) {
        errors.push(`${base}: HTTP ${response.status}`);
        continue;
      }
      const data = await response.json().catch(() => null);
      if (!data || !Array.isArray(data.results)) {
        errors.push(`${base}: invalid JSON`);
        continue;
      }
      const sources = data.results
        .filter((r) => r.url)
        .map((r) => ({
          url: r.url,
          ...(r.title ? { title: String(r.title) } : {}),
          ...(r.content ? { snippet: String(r.content) } : {}),
        }));
      if (sources.length > 0) {
        return { sources: uniqueSources(sources, maxResults ?? 10), truncated: false };
      }
      errors.push(`${base}: 0 results`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${base}: ${message}`);
    }
  }
  // Фоллбэк при пустом списке инстансов: чтобы избежать висящего хвоста "all SearXNG instances failed: "
  const detail = errors.length > 0 ? errors.join(", ") : "no instances configured";
  // На это сообщение об ошибке ссылается Note; обрезаем, чтобы не захлёбывать вывод при отказе всех 6 инстансов
  throw new Error(`all SearXNG instances failed: ${detail.slice(0, 300)}`);
}
//#endregion

//#region keyless engines (AnySearch / Exa MCP - free, no API key)
const ANYSEARCH_URL = "https://api.anysearch.com/v1/search";
const EXA_MCP_URL = "https://mcp.exa.ai/mcp";

// AnySearch: бесплатная анонимная квота (без ключа), структурированные JSON-результаты
async function searchAnysearch(query, maxResults, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  let response;
  try {
    response = await fetch(ANYSEARCH_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, max_results: maxResults ?? 5 }),
      signal: controller.signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`AnySearch request failed: ${error?.message ?? String(error)}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
  if (!response.ok) throw new Error(`AnySearch API error (HTTP ${response.status})`);
  const data = await response.json();
  if (data.code !== 0) throw new Error(`AnySearch API error: ${data.message ?? data.code}`);
  const results = data.data?.results ?? [];
  return {
    sources: results
      .filter((r) => r.url)
      .map((r) => ({
        url: r.url,
        ...(r.title ? { title: String(r.title) } : {}),
        ...(r.snippet ? { snippet: String(r.snippet).slice(0, 300) } : {}),
      })),
    truncated: false,
  };
}

// Exa MCP: анонимный публичный MCP (без ключа), инструмент web_search_exa
async function searchExaMCP(query, maxResults, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  let response;
  try {
    response = await fetch(EXA_MCP_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: { name: "web_search_exa", arguments: { query, numResults: maxResults ?? 5 } },
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`Exa MCP request failed: ${error?.message ?? String(error)}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
  if (!response.ok) throw new Error(`Exa MCP error (HTTP ${response.status})`);
  const text = await response.text();
  // Разбор формата SSE: event: message\ndata: {...}
  const lines = text.split("\n");
  let json = null;
  for (const line of lines) {
    if (line.startsWith("data: ")) {
      try {
        json = JSON.parse(line.slice(6));
        break;
      } catch {}
    }
  }
  if (!json || json.error) {
    throw new Error(`Exa MCP error: ${json?.error?.message ?? "no data"}`);
  }
  const content = json.result?.content ?? [];
  const sources = [];
  const textBlocks = content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  // Разбирает "Title: X\nURL: Y\nPublished: Z\nHighlights:\n..."
  const blocks = textBlocks.split(/\n(?=Title:)/);
  for (const block of blocks) {
    const title = block.match(/^Title: (.+)$/m)?.[1];
    const url = block.match(/^URL: (\S+)$/m)?.[1];
    const published = block.match(/^Published: (.+)$/m)?.[1];
    const highlights = block.split(/^Highlights:$/m)[1]?.split("\n").filter((l) => l.trim() && !l.trim().startsWith("...")).slice(0, 3).join(" ");
    if (!url) continue;
    sources.push({
      url,
      ...(title ? { title } : {}),
      ...(highlights ? { snippet: highlights.slice(0, 300) } : {}),
      // Оставляем только даты (ISO или YYYY-MM-DD), отфильтровываем заглушки вроде "N/A"
      ...(published && /^\d{4}-\d{2}-\d{2}/.test(published) ? { publishedAt: published } : {}),
    });
  }
  return { sources, truncated: false };
}
//#endregion

//#region platform search (GitHub / V2EX / Bilibili / Reddit / HN / StackOverflow / Wikipedia / npm)
const PLATFORMS = {
  github: { name: "GitHub" },
  v2ex: { name: "V2EX" },
  bilibili: { name: "Bilibili" },
  reddit: { name: "Reddit" },
  hn: { name: "Hacker News" },
  stackoverflow: { name: "Stack Overflow" },
  wikipedia: { name: "Wikipedia" },
  npm: { name: "npm" },
};

async function searchGithub(query, maxResults, signal) {
  const response = await fetch(
    `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=${maxResults ?? 5}`,
    {
      headers: { "user-agent": USER_AGENT, accept: "application/vnd.github+json" },
      ...(signal !== undefined ? { signal } : {}),
    }
  );
  if (!response.ok) throw new Error(`GitHub API error (HTTP ${response.status})`);
  const data = await response.json();
  return {
    sources: (data.items ?? []).map((item) => ({
      url: item.html_url,
      title: item.full_name ?? item.name,
      snippet: `${item.description ?? ""}${item.stargazers_count ? ` ⭐${item.stargazers_count}` : ""}`.trim(),
    })),
    truncated: false,
  };
}

async function searchV2ex(query, maxResults, signal) {
  const response = await fetch("https://www.v2ex.com/api/topics/hot.json", {
    headers: { "user-agent": USER_AGENT },
    ...(signal !== undefined ? { signal } : {}),
  });
  if (!response.ok) throw new Error(`V2EX API error (HTTP ${response.status})`);
  const topics = await response.json();
  const q = query.toLowerCase();
  const matched = Array.isArray(topics)
    ? topics.filter((t) => (t.title ?? "").toLowerCase().includes(q) || (t.content ?? "").toLowerCase().includes(q))
    : [];
  return {
    sources: matched.slice(0, maxResults ?? 5).map((t) => ({
      url: `https://www.v2ex.com/t/${t.id}`,
      title: t.title,
      ...(t.content ? { snippet: String(t.content).slice(0, 200) } : {}),
    })),
    truncated: false,
  };
}

async function searchBilibili(query, maxResults, signal) {
  const response = await fetch(
    `https://api.bilibili.com/x/web-interface/search/all/v2?keyword=${encodeURIComponent(query)}`,
    {
      headers: { "user-agent": USER_AGENT, referer: "https://www.bilibili.com" },
      ...(signal !== undefined ? { signal } : {}),
    }
  );
  if (!response.ok) throw new Error(`Bilibili API error (HTTP ${response.status})`);
  const data = await response.json();
  if (data.code !== 0) throw new Error(`Bilibili API error: ${data.message ?? data.code}`);
  const sources = [];
  for (const section of data.data?.result ?? []) {
    for (const item of section.data ?? []) {
      if (!item.arcurl) continue;
      sources.push({
        url: item.arcurl,
        title: item.title ? String(item.title).replace(/<[^>]+>/g, "") : item.bvid,
        ...(item.desc ? { snippet: String(item.desc).slice(0, 200) } : {}),
      });
      if (sources.length >= (maxResults ?? 5)) break;
    }
    if (sources.length >= (maxResults ?? 5)) break;
  }
  return { sources, truncated: false };
}

async function searchReddit(query, maxResults, signal) {
  const response = await fetch(
    `https://old.reddit.com/search.json?q=${encodeURIComponent(query)}&limit=${maxResults ?? 5}&sort=relevance`,
    {
      headers: {
        "user-agent": `${USER_AGENT} (dsh-free-search; contact: github.com/DDDMUC)`,
        accept: "application/json",
      },
      ...(signal !== undefined ? { signal } : {}),
    }
  );
  if (!response.ok) throw new Error(`Reddit API error (HTTP ${response.status})`);
  const data = await response.json();
  return {
    sources: (data.data?.children ?? [])
      .map((c) => c.data)
      .filter((p) => p && p.url)
      .map((p) => ({
        url: p.url,
        title: p.title ?? "",
        ...(p.selftext ? { snippet: String(p.selftext).slice(0, 200) } : {}),
      })),
    truncated: false,
  };
}

async function searchHackerNews(query, maxResults, signal) {
  const response = await fetch(
    `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&hitsPerPage=${maxResults ?? 5}`,
    {
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
      ...(signal !== undefined ? { signal } : {}),
    }
  );
  if (!response.ok) throw new Error(`Hacker News API error (HTTP ${response.status})`);
  const data = await response.json();
  return {
    sources: (data.hits ?? [])
      .filter((h) => h.title || h.story_title)
      .map((h) => ({
        // Если есть внешняя ссылка — берём её; для чистых обсуждений — страницу обсуждения HN
        url: h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`,
        title: h.title ?? h.story_title,
        ...((h.points !== undefined && h.points !== null) || (h.num_comments !== undefined && h.num_comments !== null)
          ? { snippet: `HN discussion · ${h.points ?? 0} points · ${h.num_comments ?? 0} comments` }
          : {}),
      })),
    truncated: false,
  };
}

async function searchStackOverflow(query, maxResults, signal) {
  const response = await fetch(
    `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${encodeURIComponent(query)}&site=stackoverflow&pagesize=${maxResults ?? 5}&filter=!nNPvSNVZJS`,
    {
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
      ...(signal !== undefined ? { signal } : {}),
    }
  );
  if (!response.ok) throw new Error(`Stack Exchange API error (HTTP ${response.status})`);
  const data = await response.json();
  if (data.error_message) throw new Error(`Stack Exchange API error: ${data.error_message}`);
  return {
    sources: (data.items ?? []).map((it) => ({
      url: it.link,
      title: it.title,
      ...(it.score !== undefined || it.answer_count !== undefined
        ? { snippet: `${it.is_answered ? "✓ answered" : "unanswered"} · score ${it.score ?? 0} · ${it.answer_count ?? 0} answers` }
        : {}),
    })),
    truncated: false,
  };
}

async function searchWikipedia(query, maxResults, signal, lang) {
  const host = lang === "en" ? "en.wikipedia.org" : "zh.wikipedia.org";
  const response = await fetch(
    `https://${host}/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=${maxResults ?? 5}`,
    {
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
      ...(signal !== undefined ? { signal } : {}),
    }
  );
  if (!response.ok) throw new Error(`Wikipedia API error (HTTP ${response.status})`);
  const data = await response.json();
  return {
    sources: (data.query?.search ?? []).map((s) => ({
      url: `https://${host}/wiki/${encodeURIComponent(String(s.title).replace(/ /g, "_"))}`,
      title: s.title,
      // В snippet присутствуют подсвечивающие теги <span class="searchmatch">, убираем их
      ...(s.snippet ? { snippet: stripTags(s.snippet).slice(0, 200) } : {}),
    })),
    truncated: false,
  };
}

async function searchNpm(query, maxResults, signal) {
  const response = await fetch(
    `https://registry.npmjs.com/-/v1/search?text=${encodeURIComponent(query)}&size=${maxResults ?? 5}`,
    {
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
      ...(signal !== undefined ? { signal } : {}),
    }
  );
  if (!response.ok) throw new Error(`npm registry API error (HTTP ${response.status})`);
  const data = await response.json();
  return {
    sources: (data.objects ?? [])
      .map((o) => o.package)
      .filter((p) => p && p.name)
      .map((p) => ({
        url: p.links?.npm ?? `https://www.npmjs.com/package/${p.name}`,
        title: p.name,
        ...((p.description || p.version)
          ? { snippet: `v${p.version ?? "?"}${p.description ? ` — ${String(p.description).slice(0, 160)}` : ""}` }
          : {}),
      })),
    truncated: false,
  };
}

async function searchPlatform(platform, query, maxResults, signal, lang) {
  switch (platform) {
    case "github":
      return searchGithub(query, maxResults, signal);
    case "v2ex":
      return searchV2ex(query, maxResults, signal);
    case "bilibili":
      return searchBilibili(query, maxResults, signal);
    case "reddit":
      return searchReddit(query, maxResults, signal);
    case "hn":
      return searchHackerNews(query, maxResults, signal);
    case "stackoverflow":
      return searchStackOverflow(query, maxResults, signal);
    case "wikipedia":
      return searchWikipedia(query, maxResults, signal, lang);
    case "npm":
      return searchNpm(query, maxResults, signal);
    default:
      throw new Error(`unknown platform: ${platform}`);
  }
}
//#endregion

//#region paid engines (exa / tavily / perplexity / deepseek-official)
async function searchExa(query, maxResults, apiKey, timeRange, signal) {
  if (!apiKey) throw new Error("Exa search requires EXA_API_KEY");
  const body = {
    query,
    type: "auto",
    contents: { highlights: { highlightsPerUrl: 1 } },
    ...(maxResults !== undefined ? { numResults: maxResults } : {}),
  };
  // Временной фильтр Exa: startPublishedDate (ISO дата; поддерживает любое число дней и абсолютные даты)
  if (timeRange) {
    if (timeRange.after) body.startPublishedDate = timeRange.after;
    else if (timeRange.days !== undefined) body.startPublishedDate = isoDaysAgo(timeRange.days);
  }
  const response = await fetch("https://api.exa.ai/search", {
    method: "POST",
    redirect: "error",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": "deepseek-harness/free-search",
    },
    body: JSON.stringify(body),
    ...(signal !== undefined ? { signal } : {}),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    if (response.status === 401) {
      throw new Error("Exa API key is invalid (HTTP 401) - update it in Settings > Plugins > Free Search");
    }
    if (response.status === 402) {
      throw new Error(`Exa quota/billing error (HTTP 402) - the key is valid, but its team has no usable credits or hit a usage limit; check usage/credits for the key's team at dashboard.exa.ai. ${detail.slice(0, 200)}`);
    }
    throw new Error(`Exa API error (HTTP ${response.status}): ${detail.slice(0, 200)}`);
  }
  const data = await response.json();
  const sources = (data.results ?? [])
    .map((result) => {
      const snippet = result.highlights?.find((h) => h.trim().length > 0);
      if (!snippet) return null;
      return {
        url: result.url,
        ...(result.title ? { title: result.title } : {}),
        snippet,
        ...(result.publishedDate ? { publishedAt: result.publishedDate } : {}),
      };
    })
    .filter(Boolean);
  return { sources: uniqueSources(sources, maxResults ?? 10), truncated: false };
}

// Tavily: без ключа — keyless (бесплатная анонимная квота), с ключом — аккаунтный режим (Bearer)
async function searchTavily(query, maxResults, apiKey, timeRange, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  let response;
  try {
    const body = {
      query,
      max_results: Math.min(maxResults ?? 5, 20),
      search_depth: "basic",
    };
    // Временной фильтр Tavily: time_range поддерживает только фиксированные уровни; произвольное число дней приводится к ближайшему
    if (timeRange) {
      const tr = approximateTimeRange(timeRange.days ?? 7);
      if (tr) body.time_range = tr;
    }
    response = await fetch(TAVILY_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : { "x-tavily-access-mode": "keyless" }),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: "error",
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`Tavily request failed: ${error?.message ?? String(error)}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    if (response.status === 401) {
      throw new Error("Tavily API key is invalid (HTTP 401) - update it in Settings > Plugins > Free Search");
    }
    throw new Error(`Tavily API error (HTTP ${response.status}): ${detail.slice(0, 200)}`);
  }
  const data = await response.json();
  const sources = (data.results ?? [])
    .filter((r) => r.url)
    .map((r) => ({
      url: r.url,
      ...(r.title ? { title: String(r.title) } : {}),
      ...(r.content ? { snippet: String(r.content).slice(0, 300) } : {}),
    }));
  return { sources: uniqueSources(sources, maxResults ?? 10), truncated: false };
}

// Firecrawl: без ключа — keyless (официальная бесплатная анонимная квота), с ключом — аккаунтный режим (Bearer)
const FIRECRAWL_TBS = { day: "qdr:d", week: "qdr:w", month: "qdr:m", year: "qdr:y" };

// Произвольная абсолютная дата Firecrawl → синтаксис Google tbs (cd_min использует M/D/YYYY)
function formatFirecrawlDate(date) {
  const [y, m, d] = String(date).split("-").map((n) => parseInt(n, 10));
  return `${m}/${d}/${y}`;
}

async function searchFirecrawl(query, maxResults, apiKey, timeRange, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  let response;
  try {
    const body = { query, limit: Math.min(Math.max(maxResults ?? 5, 1), 10) };
    // Временной фильтр Firecrawl: tbs поддерживает фиксированные уровни (qdr:d/w/m/y) и произвольный абсолютный диапазон (cdr:1,cd_min:...)
    if (timeRange) {
      if (timeRange.after) {
        body.tbs = `cdr:1,cd_min:${formatFirecrawlDate(timeRange.after)}`;
      } else if (timeRange.days !== undefined) {
        const tr = approximateTimeRange(timeRange.days);
        if (FIRECRAWL_TBS[tr]) body.tbs = FIRECRAWL_TBS[tr];
      }
    }
    response = await fetch(FIRECRAWL_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: "error",
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`Firecrawl request failed: ${error?.message ?? String(error)}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    if (response.status === 401) {
      throw new Error("Firecrawl API key is invalid (HTTP 401) - update it in Settings > Plugins > Free Search");
    }
    if (response.status === 429) {
      throw new Error("Firecrawl rate limit exceeded (HTTP 429) - configure FIRECRAWL_API_KEY for higher limits");
    }
    throw new Error(`Firecrawl API error (HTTP ${response.status}): ${detail.slice(0, 200)}`);
  }
  const data = await response.json();
  const sources = (data.data?.web ?? [])
    .filter((r) => r.url)
    .map((r) => ({
      url: r.url,
      ...(r.title ? { title: String(r.title) } : {}),
      ...(r.description ? { snippet: String(r.description).slice(0, 300) } : {}),
    }));
  return { sources: uniqueSources(sources, maxResults ?? 10), truncated: false };
}

// Parallel: требуется PARALLEL_API_KEY (x-api-key); objective + search_queries на естественном языке, возвращает результаты с excerpts
async function searchParallel(query, maxResults, apiKey, timeRange, signal) {
  if (!apiKey) throw new Error("Parallel search requires PARALLEL_API_KEY");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  let response;
  try {
    const body = {
      objective: query,
      search_queries: [query],
      mode: "fast",
      advanced_settings: { max_results: Math.min(Math.max(maxResults ?? 5, 1), 20) },
    };
    // Временной фильтр Parallel: source_policy.after_date (YYYY-MM-DD, точно)
    if (timeRange) {
      const after =
        timeRange.after ??
        (timeRange.days !== undefined ? isoDaysAgo(timeRange.days).slice(0, 10) : undefined);
      if (after) body.advanced_settings.source_policy = { after_date: after };
    }
    response = await fetch(PARALLEL_URL, {
      method: "POST",
      headers: { "x-api-key": apiKey, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: "error",
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`Parallel request failed: ${error?.message ?? String(error)}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    if (response.status === 401 || response.status === 403) {
      throw new Error(`Parallel API key is invalid (HTTP ${response.status}) - update it in Settings > Plugins > Free Search`);
    }
    if (response.status === 402) {
      throw new Error(`Parallel quota/billing error (HTTP 402) - check usage/credits at platform.parallel.ai. ${detail.slice(0, 200)}`);
    }
    throw new Error(`Parallel API error (HTTP ${response.status}): ${detail.slice(0, 200)}`);
  }
  const data = await response.json();
  const sources = (data.results ?? [])
    .filter((r) => r.url)
    .map((r) => {
      const excerpt = (r.excerpts ?? []).find((e) => String(e).trim().length > 0);
      return {
        url: r.url,
        ...(r.title ? { title: String(r.title) } : {}),
        ...(excerpt ? { snippet: String(excerpt).slice(0, 300) } : {}),
        ...(r.publish_date ? { publishedAt: String(r.publish_date) } : {}),
      };
    });
  return { sources: uniqueSources(sources, maxResults ?? 10), truncated: false };
}

// Преобразует произвольное число дней в относительный формат Keenable (12h / Nd / Nmo / Ny)
function formatKeenableRelative(days) {
  if (days <= 0.5) return "12h";
  if (days < 1) return `${Math.round(days * 24)}h`;
  if (days < 30) return `${Math.round(days)}d`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${Math.round(days / 365)}y`;
}

// Keenable: с ключом — REST API (X-API-Key), без ключа — keyless MCP (бесплатная анонимная квота)
function extractKeenableSources(text, maxResults) {
  const sources = [];
  const blocks = String(text).split(/\n(?=Title:)/);
  for (const block of blocks) {
    const title = block.match(/^Title: (.+)$/m)?.[1];
    const url = block.match(/^URL: (\S+)$/m)?.[1];
    const published = block.match(/^Published: (.+)$/m)?.[1] ?? block.match(/^Acquired: (.+)$/m)?.[1];
    const snippets = block.split(/^Snippets:$/m)[1]?.split("\n").filter((l) => l.trim()).slice(0, 3).join(" ");
    if (!url) continue;
    sources.push({
      url,
      ...(title ? { title } : {}),
      ...(snippets ? { snippet: snippets.slice(0, 300) } : {}),
      // Как и в Exa MCP: оставляем только даты, отфильтровываем заглушки вроде "N/A"
      ...(published && /^\d{4}-\d{2}-\d{2}/.test(published) ? { publishedAt: published } : {}),
    });
  }
  return uniqueSources(sources, maxResults ?? 10);
}

async function searchKeenableREST(query, maxResults, apiKey, timeRange, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  let response;
  try {
    const body = { query, mode: "realtime" };
    // Временной фильтр Keenable: published_after (относительный 12h/7d/1mo/1y или абсолютный YYYY-MM-DD)
    if (timeRange) {
      if (timeRange.after) body.published_after = timeRange.after;
      else if (timeRange.days !== undefined) body.published_after = formatKeenableRelative(timeRange.days);
    }
    response = await fetch(KEENABLE_URL, {
      method: "POST",
      headers: { "x-api-key": apiKey, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`Keenable request failed: ${error?.message ?? String(error)}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    if (response.status === 401) {
      throw new Error("Keenable API key is invalid (HTTP 401) - update it in Settings > Plugins > Free Search");
    }
    throw new Error(`Keenable API error (HTTP ${response.status}): ${detail.slice(0, 200)}`);
  }
  const data = await response.json();
  const sources = (data.results ?? [])
    .filter((r) => r.url)
    .map((r) => ({
      url: r.url,
      ...(r.title ? { title: String(r.title) } : {}),
      ...(r.snippet ?? r.description ? { snippet: String(r.snippet ?? r.description).slice(0, 300) } : {}),
      ...(r.published_at ? { publishedAt: String(r.published_at) } : {}),
    }));
  return { sources: uniqueSources(sources, maxResults ?? 10), truncated: false };
}

async function searchKeenableMCP(query, maxResults, timeRange, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  let response;
  try {
    const arguments_ = { query };
    // Keenable MCP поддерживает published_after (относительная или абсолютная дата)
    if (timeRange) {
      if (timeRange.after) arguments_.published_after = timeRange.after;
      else if (timeRange.days !== undefined) arguments_.published_after = formatKeenableRelative(timeRange.days);
    }
    response = await fetch(KEENABLE_MCP_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: { name: "search_web_pages", arguments: arguments_ },
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`Keenable MCP request failed: ${error?.message ?? String(error)}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
  if (!response.ok) throw new Error(`Keenable MCP error (HTTP ${response.status})`);
  const data = await response.json();
  if (data.error) throw new Error(`Keenable MCP error: ${data.error?.message ?? "unknown"}`);
  const content = data.result?.content ?? [];
  // При isError=true в content содержится текст ошибки
  const text = content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  if (data.result?.isError) throw new Error(`Keenable MCP error: ${text.slice(0, 200)}`);
  return { sources: extractKeenableSources(text, maxResults ?? 10), truncated: false };
}

async function searchKeenable(query, maxResults, apiKey, timeRange, signal) {
  if (apiKey) return searchKeenableREST(query, maxResults, apiKey, timeRange, signal);
  return searchKeenableMCP(query, maxResults, timeRange, signal);
}

// Perplexity Agent API: https://docs.perplexity.ai/docs/agent-api
// Старый Sonar Chat Completions (/v1/chat/completions) устарел и будет выведен из эксплуатации 2026-09-27.
// Новый интерфейс POST /v1/agent: model берётся как namespaced id "perplexity/sonar", input — строка,
// web_search — явный tool; citations/sources приходят из элементов search_results в типизированном массиве output[].
// Подробности: https://docs.perplexity.ai/docs/agent-api/migrate-from-sonar/how-to
async function searchPerplexity(query, maxResults, apiKey, signal, timeRange) {
  if (!apiKey) throw new Error("Perplexity search requires PERPLEXITY_API_KEY");
  // Встроенный таймаут 20 с (комбинируется с внешним signal): даже если вызывающий не передал signal, вызов не зависнет навсегда
  const body = {
    model: "perplexity/sonar",
    input: query,
    tools: [{ type: "web_search" }],
    max_output_tokens: 1024,
  };
  // time filter: маппит единый timeRange из dsh-free-search в search_recency_filter Perplexity
  // (перечисление: hour|day|week|month|year) и last_updated_after_filter (абсолютная дата MM/DD/YYYY)
  if (timeRange) {
    const filters = {};
    if (typeof timeRange.after === "string" && timeRange.after.length > 0) {
      const [y, m, d] = timeRange.after.split("-");
      if (y && m && d) filters.last_updated_after_filter = `${m}/${d}/${y}`;
    } else if (typeof timeRange.days === "number" && Number.isFinite(timeRange.days) && timeRange.days > 0) {
      // <=0.5d → hour, <=2 → day, <=14 → week, <=90 → month, else year
      filters.search_recency_filter = timeRange.days <= 0.5
        ? "hour"
        : timeRange.days <= 2 ? "day" : timeRange.days <= 14 ? "week" : timeRange.days <= 90 ? "month" : "year";
    }
    if (Object.keys(filters).length > 0) {
      body.tools = [{ type: "web_search", filters }];
    }
  }
  const response = await fetch("https://api.perplexity.ai/v1/agent", {
    method: "POST",
    redirect: "error",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.any([...(signal !== undefined ? [signal] : []), AbortSignal.timeout(20000)]),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    if (response.status === 401 || response.status === 403) {
      throw new Error("Perplexity API key is invalid (HTTP " + response.status + ") - update it in Settings > Plugins > Free Search");
    }
    throw new Error(`Perplexity API error (HTTP ${response.status}): ${detail.slice(0, 200)}`);
  }
  const data = await response.json();
  // Типизированный output[] в Agent API содержит и message item, и search_results item;
// поле верхнего уровня output_text — это короткая ссылка на content сообщения.
  const output = Array.isArray(data.output) ? data.output : [];
  let answer = "";
  if (typeof data.output_text === "string" && data.output_text.length > 0) {
    answer = data.output_text;
  } else {
    const textParts = [];
    for (const item of output) {
      if (item && item.type === "message") {
        const content = item.content;
        if (typeof content === "string") {
          if (content) textParts.push(content);
        } else if (Array.isArray(content)) {
          for (const part of content) {
            if (part && (part.type === "text" || part.type === "output_text") && typeof part.text === "string" && part.text) {
              textParts.push(part.text);
            }
          }
        }
      }
    }
    answer = textParts.join("\n");
  }
  // sources: приходят из search_results items; каждая запись уже содержит url/title/snippet/date
  const sources = [];
  for (const item of output) {
    if (item && item.type === "search_results" && Array.isArray(item.results)) {
      for (const r of item.results) {
        const url = (r && typeof r.url === "string") ? r.url.trim() : "";
        if (!url) continue;
        const entry = { url };
        if (typeof r.title === "string" && r.title) entry.title = r.title;
        if (typeof r.snippet === "string" && r.snippet) entry.snippet = r.snippet;
        sources.push(entry);
      }
    }
  }
  return {
    content: answer,
    sources: uniqueSources(sources, maxResults ?? 10),
    truncated: false,
  };
}

async function searchDeepSeekOfficial(query, maxResults, apiKey, signal) {
  if (!apiKey) throw new Error("DeepSeek search requires DEEPSEEK_API_KEY");
  // Встроенный таймаут 20 с (комбинируется с внешним signal): даже если вызывающий не передал signal, вызов не зависнет навсегда
  const response = await fetch("https://api.deepseek.com/anthropic/v1/messages", {
    method: "POST",
    redirect: "error",
    headers: {
      "x-api-key": apiKey,
      authorization: `Bearer ${apiKey}`,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": "deepseek-harness/free-search",
    },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: `Perform a web search for the query: ${query}` }],
        },
      ],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }],
    }),
    signal: AbortSignal.any([...(signal !== undefined ? [signal] : []), AbortSignal.timeout(20000)]),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    if (response.status === 401) {
      throw new Error("DeepSeek API key is invalid (HTTP 401) - update it in Settings > Plugins > Free Search");
    }
    throw new Error(`DeepSeek API error (HTTP ${response.status}): ${detail.slice(0, 200)}`);
  }
  const data = await response.json();
  const blocks = data.content ?? [];
  const resultBlocks = blocks.filter((block) => block.type === "web_search_tool_result");
  const snippets = new Map();
  for (const block of blocks) {
    if (block.type !== "text") continue;
    for (const cite of block.citations ?? []) {
      if (cite.url && cite.cited_text && !snippets.has(cite.url)) snippets.set(cite.url, cite.cited_text);
    }
  }
  const sources = [];
  for (const block of resultBlocks) {
    for (const item of block.content ?? []) {
      if (item.type !== "web_search_result" || !item.url) continue;
      if (sources.some((s) => s.url === item.url)) continue;
      sources.push({
        url: item.url,
        ...(item.title ? { title: item.title } : {}),
        ...(snippets.get(item.url) ? { snippet: snippets.get(item.url) } : {}),
        ...(item.page_age ? { publishedAt: item.page_age } : {}),
      });
    }
  }
  return { sources: uniqueSources(sources, maxResults ?? 10), truncated: false };
}
//#endregion

//#region bridge
const MAX_JSON_BODY_BYTES = 64 * 1024;

function isLoopbackRequest(request) {
  const address = request.socket.remoteAddress;
  if (address !== "127.0.0.1" && address !== "::1" && address !== "::ffff:127.0.0.1") return false;
  const host = request.headers.host;
  if (typeof host !== "string") return false;
  let hostUrl;
  try {
    hostUrl = new URL("http://" + host);
  } catch {
    return false;
  }
  if (hostUrl.hostname !== "127.0.0.1" && hostUrl.hostname !== "localhost" && hostUrl.hostname !== "[::1]") return false;
  if (request.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "referrer-policy": "no-referrer" });
  res.end(payload);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk;
    size += buffer.length;
    if (size > MAX_JSON_BODY_BYTES) return undefined;
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

function toView(descriptor) {
  return {
    ns: String(descriptor.ns),
    schema: descriptor.schema,
    value: descriptor.value,
    ...(descriptor.base === undefined ? {} : { base: descriptor.base }),
    ...(descriptor.user === undefined ? {} : { user: descriptor.user }),
    ...(descriptor.secrets === undefined
      ? {}
      : { secrets: descriptor.secrets.map((secret) => ({ path: [...secret.path], set: secret.set })) }),
    revision: descriptor.revision,
  };
}

function makeBridgeRoutes(settings, search, testEngine, getCredentials) {
  const allowlisted = () =>
    settings
      .describe({ redactSecrets: true })
      .filter((descriptor) => String(descriptor.ns) === FREE_SEARCH_NS)
      .map((descriptor) => String(descriptor.ns));

  const handlers = {
    async checkUpdate() {
      const latest = await fetchLatestVersion();
      if (latest === null) {
        return {
          ok: false,
          code: "update-check-failed",
          message: "could not reach the npm registry (network/proxy) - check your connection",
        };
      }
      const cmp = compareVersions(latest, PLUGIN_VERSION);
      const mode = detectInstallMode();
      return {
        ok: true,
        value: {
          current: PLUGIN_VERSION,
          latest,
          hasUpdate: cmp > 0,
          updateUrl: PLUGIN_NPM_URL,
          repoUrl: PLUGIN_REPO_URL,
          // Возможность обновления в один клик: true при реальной установке npm; false в режиме локального link (для обновления делайте git pull исходников)
          installable: mode !== null && !mode.isLink,
          installMode: mode?.isLink ? "link" : mode !== null ? "registry" : "unknown",
        },
      };
    },
    // Обновление в один клик: выполняет pnpm upgrade только при реальной установке npm; в режиме link отклоняется (чтобы не сломать локальную среду разработки)
    async updatePlugin() {
      const mode = detectInstallMode();
      if (mode === null) {
        return { ok: false, code: "install-not-found", message: "could not locate dsh-free-search in any profile" };
      }
      if (mode.isLink) {
        return {
          ok: false,
          code: "local-link-mode",
          message: "local development install (symlink) - update the source repo instead (git pull), then restart dsh",
        };
      }
      try {
        const result = await new Promise((resolve, reject) => {
          exec("pnpm add dsh-free-search@latest", { cwd: mode.profileDir, timeout: 120000 }, (error, stdout, stderr) => {
            if (error) reject(new Error(`upgrade failed: ${(stderr || stdout || error.message).trim().slice(0, 300)}`));
            else resolve(stdout);
          });
        });
        const latest = await fetchLatestVersion();
        return {
          ok: true,
          value: {
            updated: true,
            latest: latest ?? "unknown",
            message: `upgraded to latest - restart dsh to apply`,
            output: String(result).trim().slice(0, 200),
          },
        };
      } catch (error) {
        return { ok: false, code: "upgrade-failed", message: error instanceof Error ? error.message : String(error) };
      }
    },
    async rawSearch(request) {
      if (request === null || typeof request !== "object" || typeof request.query !== "string" || request.query.length === 0) {
        return { ok: false, code: "search-rejected", message: "malformed bridge search request (query is required)" };
      }
      const maxResults = Math.min(Math.max(Number(request.maxResults) || 5, 1), 10);
      const timeRange = parseTimeRange(request.timeRange);
      // Указан engine: проверяем именно этот движок напрямую (без цепочки фоллбэка) и сообщаем его собственную доступность
      if (typeof request.engine === "string" && request.engine.length > 0) {
        if (typeof testEngine !== "function") {
          return { ok: false, code: "search-unavailable", message: "engine test is not wired" };
        }
        try {
          const result = await testEngine(request.engine, request.query, timeRange);
          if (result.ok === false) {
            return { ok: false, code: "engine-failed", message: result.error ?? `${request.engine} failed` };
          }
          return {
            ok: true,
            value: {
              provider: request.engine,
              sources: result.sources ?? [],
              content: result.content ?? "",
            },
          };
        } catch (error) {
          return { ok: false, code: "engine-failed", message: error instanceof Error ? error.message : String(error) };
        }
      }
      if (typeof search !== "function") {
        return { ok: false, code: "search-unavailable", message: "search provider is not wired" };
      }
      try {
        const result = await search({ ...request, maxResults, timeRange });
        return {
          ok: true,
          value: {
            // Фактически использованный движок: provider.search при успехе возвращает поле provider
            provider: result.provider ?? request.engine ?? request.provider ?? "bing",
            sources: result.sources ?? [],
            content: result.content ?? "",
            // Метка попадания в кэш: успешный путь provider.search выставляет _cache (hit=попадание в кэш, miss=реальный поиск)
            cache: result._cache === "hit" ? "hit" : "miss",
          },
        };
      } catch (error) {
        return { ok: false, code: "search-failed", message: error instanceof Error ? error.message : String(error) };
      }
    },
    async describe() {
      const descriptors = settings.describe({ redactSecrets: true });
      return {
        ok: true,
        value: {
          namespaces: allowlisted()
            .map((ns) => descriptors.find((descriptor) => String(descriptor.ns) === ns))
            .filter((descriptor) => descriptor !== undefined)
            .map(toView),
          writable: settings.writable !== false,
        },
      };
    },
    async mutate(request) {
      const body = request;
      if (body === null || typeof body !== "object" || typeof body.ns !== "string" || !Array.isArray(body.ops)) {
        return { ok: false, code: "settings-rejected", message: "malformed bridge settings request" };
      }
      const { ns } = body;
      if (!allowlisted().includes(ns)) {
        return { ok: false, code: "settings-not-exposed", message: `settings namespace "${ns}" is not exposed` };
      }
      const expectedRevision = typeof body.expectedRevision === "number" ? body.expectedRevision : undefined;
      try {
        await settings.mutate(ns, body.ops, expectedRevision);
      } catch (error) {
        if (error instanceof SettingsConflictError) {
          return { ok: false, code: "settings-conflict", message: error.message };
        }
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, code: "internal", message };
      }
      const descriptor = settings.describe({ redactSecrets: true }).find((candidate) => String(candidate.ns) === ns);
      if (descriptor === undefined) {
        return { ok: false, code: "internal", message: `settings namespace "${ns}" was disposed after the mutate` };
      }
      return { ok: true, value: toView(descriptor) };
    },
    // Центр credentials: запрос статуса конфигурации ключей движков (значения не возвращаются, только факт настройки)
    async credentialsStatus() {
      const credentials = getCredentials();
      if (!credentials) return { ok: false, code: "credentials-unavailable", message: "credentials service is not available" };
      const configured = {};
      for (const [settingsKey, ref] of Object.entries(KEY_REF_MAP)) {
        try {
          const info = await credentials.describe(ref);
          configured[settingsKey] = info !== undefined && info.configured === true;
        } catch {
          configured[settingsKey] = false;
        }
      }
      return { ok: true, value: { configured, available: true } };
    },
    // Центр credentials: запись ключа одного движка (ограничено белым списком ref)
    async credentialsSet(request) {
      const credentials = getCredentials();
      if (!credentials) return { ok: false, code: "credentials-unavailable", message: "credentials service is not available" };
      const { key, value } = request ?? {};
      const ref = KEY_REF_MAP[key];
      if (!ref) return { ok: false, code: "credentials-rejected", message: `unknown credential key "${key}"` };
      if (typeof value !== "string" || value.trim().length === 0) {
        return { ok: false, code: "credentials-rejected", message: "value is required" };
      }
      try {
        await credentials.set(ref, value.trim());
        return { ok: true, value: { ref, set: true } };
      } catch (error) {
        return { ok: false, code: "credentials-write-failed", message: error instanceof Error ? error.message : String(error) };
      }
    },
    // Центр credentials: удаление ключа одного движка
    async credentialsUnset(request) {
      const credentials = getCredentials();
      if (!credentials) return { ok: false, code: "credentials-unavailable", message: "credentials service is not available" };
      const { key } = request ?? {};
      const ref = KEY_REF_MAP[key];
      if (!ref) return { ok: false, code: "credentials-rejected", message: `unknown credential key "${key}"` };
      try {
        await credentials.unset(ref);
        return { ok: true, value: { ref, set: false } };
      } catch (error) {
        return { ok: false, code: "credentials-write-failed", message: error instanceof Error ? error.message : String(error) };
      }
    },
  };

  const guard = (req, res) => {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { error: "loopback requests only" });
      return false;
    }
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "method not allowed: " + (req.method ?? "") });
      return false;
    }
    return true;
  };

  return [
    {
      kind: "exact",
      path: `${BRIDGE_PREFIX}/describe`,
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        writeJson(res, 200, await handlers.describe());
      },
    },
    {
      kind: "exact",
      path: `${BRIDGE_PREFIX}/mutate`,
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        const body = await readJsonBody(req);
        if (body === undefined) {
          writeJson(res, 400, { ok: false, code: "settings-rejected", message: "malformed JSON body" });
          return;
        }
        writeJson(res, 200, await handlers.mutate(body));
      },
    },
    {
      kind: "exact",
      path: `${BRIDGE_PREFIX}/credentials-status`,
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        writeJson(res, 200, await handlers.credentialsStatus());
      },
    },
    {
      kind: "exact",
      path: `${BRIDGE_PREFIX}/credentials-set`,
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        const body = await readJsonBody(req);
        if (body === undefined) {
          writeJson(res, 400, { ok: false, code: "credentials-rejected", message: "malformed JSON body" });
          return;
        }
        writeJson(res, 200, await handlers.credentialsSet(body));
      },
    },
    {
      kind: "exact",
      path: `${BRIDGE_PREFIX}/credentials-unset`,
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        const body = await readJsonBody(req);
        if (body === undefined) {
          writeJson(res, 400, { ok: false, code: "credentials-rejected", message: "malformed JSON body" });
          return;
        }
        writeJson(res, 200, await handlers.credentialsUnset(body));
      },
    },
    {
      kind: "exact",
      path: `${BRIDGE_PREFIX}/check-update`,
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        writeJson(res, 200, await handlers.checkUpdate());
      },
    },
    {
      kind: "exact",
      path: `${BRIDGE_PREFIX}/update`,
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        writeJson(res, 200, await handlers.updatePlugin());
      },
    },
    {
      kind: "exact",
      path: `${BRIDGE_PREFIX}/raw-search`,
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        const body = await readJsonBody(req);
        if (body === undefined) {
          writeJson(res, 400, { ok: false, code: "search-rejected", message: "malformed JSON body" });
          return;
        }
        writeJson(res, 200, await handlers.rawSearch(body));
      },
    },
  ];
}
//#endregion

const name = "web-search-free";
const inject = ["web"];

// Маппинг ключей движков на ref в центре credentials (белый список: только эти ref доступны UI на чтение/запись в центре credentials)
const KEY_REF_MAP = {
  exaApiKey: "EXA_API_KEY",
  tavilyApiKey: "TAVILY_API_KEY",
  keenableApiKey: "KEENABLE_API_KEY",
  firecrawlApiKey: "FIRECRAWL_API_KEY",
  parallelApiKey: "PARALLEL_API_KEY",
  perplexityApiKey: "PERPLEXITY_API_KEY",
  deepseekApiKey: "DEEPSEEK_API_KEY",
};

const Config = z.object({
  provider: z.string().default("bing"),
  cache: z.boolean().default(true), // Переключатель кэша результатов одного запроса (защита от лимитов/экономия квоты)
  cacheTtl: z.number().default(5), // Длительность кэша (в минутах), настраивается 0-5 (финальный clamp в месте использования)
  keyStorage: z.string().default("credentials"), // Где хранится ключ: credentials (центр credentials) | settings (страница настроек)
  lang: z.string().default("zh"),
  region: z.string(),
  bingMarket: z.string().default("zh-CN"),
  safeSearch: z.string().default("off"),
  searxngInstances: z.array(z.string()),
  platforms: z.array(z.string()).default(["github", "v2ex", "bilibili", "reddit", "hn", "stackoverflow", "wikipedia", "npm"]),
  exaApiKey: z.string().role("secret"),
  tavilyApiKey: z.string().role("secret"),
  keenableApiKey: z.string().role("secret"),
  firecrawlApiKey: z.string().role("secret"),
  parallelApiKey: z.string().role("secret"),
  perplexityApiKey: z.string().role("secret"),
  deepseekApiKey: z.string().role("secret"),
});

function apply(ctx, config) {
  let current = () => config ?? {};
  const logger = ctx.logger;
  // Сервис credentials может подключиться позже самого плагина (из-за порядка bundle'ов): получаем его динамически во время выполнения, а не кэшируем в apply
  const getCredentials = () => ctx.get("credentials");

  // Динамическое обновление системного промпта: при изменении настроек перегенерируется, чтобы не показывать устаревший список движков
  let refreshPrompt = null;

  // Кэш результатов одного запроса (удерживается в замыкании provider.search): LRU 50 записей / TTL настраивается
  const searchCache = new Map(); // key -> { value, expiresAt }

  // Приоритет ключей: credentials (.credentials.yaml, официально рекомендуется) > settings free-search.<x>ApiKey (для обратной совместимости) > переменные окружения
  const resolveApiKey = async (envName, settingsKey) => {
    const credentials = getCredentials();
    if (credentials) {
      try {
        const resolved = await credentials.resolve(envName);
        if (resolved?.value) return resolved.value;
      } catch {}
    }
    const cfg = current();
    if (settingsKey && cfg[settingsKey]) return cfg[settingsKey];
    return process.env[envName] ?? "";
  };

  // Управляющий provider: маршрутизирует запросы на любой движок по полю provider из настроек.
  // При сбое любого движка (нет ключа / 401 / лимит / сеть) автоматически перебирает остальные по очереди,
  // пока не получится или не закончатся все. В результат добавляется подсказка о фоллбэке, чтобы поиск агента не проваливался напрямую.
  const provider = {
    id: "ddg",
    available() {
      return true;
    },
    // Кэш результатов одного запроса: key=query+maxResults+timeRangeLabel+preferred, Map естественным образом даёт LRU
    async search(request, signal) {
      // Общая проверка на входе: все три пути web_search / advanced_search / raw-search проходят здесь
      if (request === null || typeof request !== "object" || typeof request.query !== "string" || request.query.trim().length === 0) {
        throw new Error("query is required");
      }
      const cfg = current();
      // Предпочитаемый движок: явное указание в инструменте free_search (request.engine) приоритетнее настройки (cfg.provider)
      const preferred =
        typeof request.engine === "string" && ALL_ENGINES.includes(request.engine)
          ? request.engine
          : cfg.provider ?? "bing";
      // Фильтр time_range (пробрасывается только инструментом advanced_search; у стандартного web_search этого параметра нет)
      // Сохраняем исходную строку для отображения в Note; raw-search-мост мог уже разобрать timeRange в объект
      const timeRange = parseTimeRange(request.timeRange);
      const timeRangeLabel = typeof request.timeRange === "string" ? request.timeRange : String(timeRange?.days ?? timeRange?.after ?? "");

      // TTL кэша (в минутах, 0-5 настраивается); при cache=false или ttl<=0 кэш полностью отключается
      const cacheTtlMs = (Math.min(Math.max(Number(cfg.cacheTtl) ?? 5, 0), 5)) * 60 * 1000;
      const cacheEnabled = cfg.cache !== false && cacheTtlMs > 0;
      const cacheKey = cacheEnabled
        ? buildCacheKey(request.query, request.maxResults, timeRangeLabel, preferred)
        : null;
      if (cacheKey !== null) {
        const hit = searchCache.get(cacheKey);
        if (hit && hit.expiresAt > Date.now()) {
          if (signal?.aborted) throw new Error("search aborted");
          searchCache.delete(cacheKey);
          searchCache.set(cacheKey, hit);
          // Поверхностное копирование + приватная метка: массив sources тоже копируется, чтобы полностью изолировать объект в кэше (push/изменение элементов вызывающим не затрагивает кэш)
          return { ...hit.value, sources: hit.value.sources?.slice(), _cache: "hit" };
        }
        if (hit) searchCache.delete(cacheKey);
      }

      // Единая цепочка движков: сначала предпочитаемый, затем другие платные (сначала те, у которых есть ключ), в конце бесплатные
      const paidEngines = ["exa", "tavily", "keenable", "firecrawl", "parallel", "perplexity", "deepseek-official"];
      const freeEngines = ["bing", "anysearch", "ddg", "ddg-lite", "searxng"];
      // Движки с поддержкой фильтра time_range: tavily / exa / keenable / firecrawl / parallel / searxng / ddg / ddg-lite
      const timeEngines = ["tavily", "exa", "keenable", "firecrawl", "parallel", "searxng", "ddg", "ddg-lite"];
      let chain;
      // Причина пропуска предпочитаемого движка (для точного Note, не вводящего в заблуждение агента/пользователя):
      //  - "time-filter": задан timeRange и предпочитаемый движок не поддерживает временной фильтр (даже не пробовали)
      //  - "failed": предпочитаемый движок пробовали и он не сработал (нет ключа / 401 / лимит / 0 результатов / сеть)
      //  - null: предпочитаемый движок отработал успешно или фоллбэка не было
      let preferredSkippedReason = null;
      if (timeRange) {
        // Когда нужен временной фильтр, поддерживающие его движки идут раньше (предпочитаемый — всё равно первым, если он их поддерживает)
        const preferredFirst = [preferred].filter((e) => timeEngines.includes(e));
        const otherTime = timeEngines.filter((e) => e !== preferred);
        const noTime = [...paidEngines, ...freeEngines].filter((e) => !timeEngines.includes(e) && e !== preferred);
        chain = [...preferredFirst, ...otherTime, ...noTime];
        if (!timeEngines.includes(preferred)) {
          // Предпочитаемый движок не поддерживает временной фильтр → его нет в цепочке, его даже не пытаются (это не сбой)
          preferredSkippedReason = "time-filter";
        }
      } else {
        const othersPaid = paidEngines.filter((e) => e !== preferred);
        const othersFree = freeEngines.filter((e) => e !== preferred);
        chain = [preferred, ...othersPaid, ...othersFree];
      }

      let lastError = null;
      let usedEngine = null;
      // Если предпочитаемый движок пробовали и он не сработал — записываем детали сбоя (для Note)
      let preferredFailure = null;
      // Общий бюджет таймаута: при последовательном фоллбэке ограничивает общее время всей цепочки движков, чтобы таймауты отдельных движков не складывались до минут
      const BUDGET_MS = 30000;
      const deadline = Date.now() + BUDGET_MS;
      for (const engine of chain) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new Error(`search timed out after ${BUDGET_MS / 1000}s`);
        }
        // Комбинируем внешний signal отмены + таймаут по остатку бюджета: и официальная отмена web_search, и таймаут движка, и общий бюджет сработают
        const effSignal = AbortSignal.any([...(signal !== undefined ? [signal] : []), AbortSignal.timeout(remaining)]);
        try {
          let result;
          if (engine === "ddg") {
            result = await searchDdgHtml(request.query, request.maxResults, { ...cfg, timeRange }, effSignal);
          } else if (engine === "ddg-lite") {
            result = await searchDdgLite(request.query, request.maxResults, { ...cfg, timeRange }, effSignal);
          } else if (engine === "bing") {
            result = await searchBing(request.query, request.maxResults, cfg, effSignal);
          } else if (engine === "searxng") {
            result = await searchSearxng(request.query, request.maxResults, { ...cfg, timeRange }, effSignal);
          } else if (engine === "anysearch") {
            result = await searchAnysearch(request.query, request.maxResults, effSignal);
          } else if (engine === "exa") {
            // exa: с ключом — REST, без ключа — keyless MCP (бесплатно)
            const key = await resolveApiKey("EXA_API_KEY", "exaApiKey");
            if (key) {
              result = await searchExa(request.query, request.maxResults, key, timeRange, effSignal);
            } else {
              result = await searchExaMCP(request.query, request.maxResults, effSignal);
            }
          } else if (engine === "tavily") {
            // tavily: с ключом — аккаунтный режим, без ключа — keyless (бесплатная анонимная квота)
            const key = await resolveApiKey("TAVILY_API_KEY", "tavilyApiKey");
            result = await searchTavily(request.query, request.maxResults, key, timeRange, effSignal);
          } else if (engine === "keenable") {
            // keenable: с ключом — REST, без ключа — keyless MCP (бесплатно)
            const key = await resolveApiKey("KEENABLE_API_KEY", "keenableApiKey");
            result = await searchKeenable(request.query, request.maxResults, key, timeRange, effSignal);
          } else if (engine === "firecrawl") {
            // firecrawl: работает и без ключа (официальная бесплатная анонимная квота), с ключом — аккаунтный режим (выше лимиты)
            const key = await resolveApiKey("FIRECRAWL_API_KEY", "firecrawlApiKey");
            result = await searchFirecrawl(request.query, request.maxResults, key, timeRange, effSignal);
          } else if (engine === "parallel") {
            // parallel: обязательно нужен PARALLEL_API_KEY (без ключа пропускается, как и perplexity)
            const key = await resolveApiKey("PARALLEL_API_KEY", "parallelApiKey");
            if (!key) {
              lastError = new Error("Parallel requires PARALLEL_API_KEY");
              if (engine === preferred) preferredFailure = "PARALLEL_API_KEY is not configured";
              logger.warn(`free-search: engine "${engine}" skipped (no key), trying next engine`);
              continue; // пропуск, нет ключа
            }
            result = await searchParallel(request.query, request.maxResults, key, timeRange, effSignal);
          } else if (engine === "perplexity") {
            const key = await resolveApiKey("PERPLEXITY_API_KEY", "perplexityApiKey");
            if (!key) {
              lastError = new Error("Perplexity requires PERPLEXITY_API_KEY");
              if (engine === preferred) preferredFailure = "PERPLEXITY_API_KEY is not configured";
              logger.warn(`free-search: engine "${engine}" skipped (no key), trying next engine`);
              continue; // пропуск, нет ключа
            }
            result = await searchPerplexity(request.query, request.maxResults, key, effSignal, timeRange);
          } else if (engine === "deepseek-official") {
            const key = await resolveApiKey("DEEPSEEK_API_KEY", "deepseekApiKey");
            if (!key) {
              lastError = new Error("DeepSeek requires DEEPSEEK_API_KEY");
              if (engine === preferred) preferredFailure = "DEEPSEEK_API_KEY is not configured";
              logger.warn(`free-search: engine "${engine}" skipped (no key), trying next engine`);
              continue; // пропуск, нет ключа
            }
            result = await searchDeepSeekOfficial(request.query, request.maxResults, key, effSignal);
          } else {
            continue;
          }

          if (result.sources.length > 0) {
            usedEngine = engine;
            // Единообразная очистка snippet: убираем шум про регистрацию/платный доступ/подписку, схлопываем пробелы (обрабатываем только непустые, чтобы сохранить lossless JSON)
            result.sources = result.sources.map((s) =>
              s.snippet ? { ...s, snippet: cleanSnippet(s.snippet) } : s
            );
            // При использовании не предпочитаемого движка добавляем в результат точную подсказку (различая "пропущен из-за отсутствия временного фильтра" и "реальный сбой")
            if (engine !== preferred) {
              if (preferredSkippedReason === "time-filter") {
                result.content = `Note: ${preferred} does not support time filtering (timeRange=${timeRangeLabel}), using ${engine}.`;
              } else if (preferredFailure) {
                result.content = `Note: ${preferred} unavailable or failed (${preferredFailure}), using ${engine}.`;
              } else {
                result.content = `Note: ${preferred} unavailable or failed, using ${engine}.`;
              }
            }
            // Пишем в кэш (кэшируем только успешные результаты; при throw кэш не пишется естественным образом)
            const cached = { ...result, provider: engine, engine: engine };
            if (cacheKey !== null) {
              // Для записей фоллбэка (фактический движок ≠ предпочитаемый) используется 1/5 от настроенного TTL; успех предпочитаемого — полный TTL
              const entryTtlMs = engine !== preferred ? Math.max(cacheTtlMs / 5, 1000) : cacheTtlMs;
              searchCache.set(cacheKey, {
                value: cached,
                expiresAt: Date.now() + entryTtlMs,
              });
              if (searchCache.size > CACHE_MAX_ENTRIES) {
                const oldest = searchCache.keys().next().value;
                if (oldest !== undefined) searchCache.delete(oldest);
              }
            }
            return { ...cached, _cache: "miss" };
          }
          lastError = new Error(`engine "${engine}" returned 0 results`);
          if (engine === preferred) preferredFailure = "returned 0 results";
          logger.warn(`free-search: ${engine} returned 0 results, trying next engine`);
        } catch (error) {
          lastError = error;
          const message = error instanceof Error ? error.message : String(error);
          if (engine === preferred) preferredFailure = message;
          logger.warn(`free-search: engine "${engine}" failed (${message}), trying next engine`);
        }
      }
      throw lastError ?? new Error("all search engines failed");
    },
  };

  ctx.inject(["settings"], (sctx) => {
    // Двойная совместимость: alpha.2+ (SettingsProvider имеет метод installSection) и rc.2 (модульный installSettingsSection):
    // feature detection сначала пробует alpha-метод; если его нет — динамически import'ит старый API и регистрирует через него (среда rc.2; ошибки от отсутствующего alpha-экспорта не сработают).
    if (typeof sctx.settings.installSection === "function") {
      sctx.settings.installSection(ctx, FREE_SEARCH_NS, Config, config ?? {}, {
        setSource: (source) => {
          current = source;
        },
        onChange: () => {
          // При изменении settings обновляем системный промпт (показываем актуальный список движков)
          if (typeof refreshPrompt === "function") refreshPrompt();
        },
      });
    } else {
      void (async () => {
        const legacy = await import("@deepseek-ai/dsh-settings");
        if (typeof legacy.installSettingsSection === "function" && legacy.settingsNamespace) {
          const legacyNs = legacy.settingsNamespace(FREE_SEARCH_NS);
          legacy.installSettingsSection(ctx, legacyNs, Config, config ?? {}, {
            setSource: (source) => {
              current = source;
            },
            onChange: () => {
              if (typeof refreshPrompt === "function") refreshPrompt();
            },
          });
        } else {
          sctx.logger?.warn?.("free-search: dsh-settings не имеет доступного API регистрации (installSection/installSettingsSection отсутствуют)");
          return;
        }
      })();
    }
  });

  ctx.inject(["webServer", "settings"], (sctx) => {
    sctx.effect(() => {
      const disposers = makeBridgeRoutes(
        sctx.settings,
        (request) => provider.search(request, undefined),
        (engine, query, timeRange) => runEngineTest(engine, query, timeRange),
        getCredentials
      ).map((route) => sctx.webServer.register(route));
      return () => {
        for (const dispose of disposers) dispose();
      };
    }, "free-search: settings bridge");
  });

  ctx.web.registerSearchProvider(provider);

  // Фолбэк во время выполнения: в DSH 0.1.1+ config из profile patch полностью перекрывает config из bundle patch,
  // и пользовательский patch `- id: web` (например, задающий только fetchProvider) молча затирает searchProvider, из-за чего выдача падает на официальный поиск DeepSeek.
  // Здесь после регистрации provider проверяем: если searchProvider не указывает ни на какой provider (undefined), автоматически перехватываем на этот плагин;
  // если пользователь явно настроил другой provider — не трогаем.
  if (!ctx.web.searchProviderId) {
    ctx.web.searchProviderId = provider.id;
    logger.info(`free-search: web.searchProvider was unset (patch override or missing config), taking over as "${provider.id}"`);
  }

  // Инструмент тестирования: даёт агенту прогнать все поисковые движки по очереди и сообщить их доступность
  const runEngineTest = async (engine, query, timeRange) => {
    const cfg = current();
    const q = query || "DeepSeek Harness";
    const tr = parseTimeRange(timeRange);
    const attempt = async () => {
      switch (engine) {
        case "ddg":
          return await searchDdgHtml(q, 2, { ...cfg, timeRange: tr });
        case "ddg-lite":
          return await searchDdgLite(q, 2, { ...cfg, timeRange: tr });
        case "bing":
          return await searchBing(q, 2, cfg);
        case "searxng":
          return await searchSearxng(q, 2, { ...cfg, timeRange: tr });
        case "anysearch":
          return await searchAnysearch(q, 2);
        case "exa": {
          const key = await resolveApiKey("EXA_API_KEY", "exaApiKey");
          if (key) return await searchExa(q, 2, key, tr);
          return await searchExaMCP(q, 2);
        }
        case "tavily": {
          const key = await resolveApiKey("TAVILY_API_KEY", "tavilyApiKey");
          return await searchTavily(q, 2, key, tr);
        }
        case "keenable": {
          const key = await resolveApiKey("KEENABLE_API_KEY", "keenableApiKey");
          return await searchKeenable(q, 2, key, tr);
        }
        case "firecrawl": {
          const key = await resolveApiKey("FIRECRAWL_API_KEY", "firecrawlApiKey");
          return await searchFirecrawl(q, 2, key, tr);
        }
        case "parallel": {
          const key = await resolveApiKey("PARALLEL_API_KEY", "parallelApiKey");
          if (!key) return { ok: false, error: "PARALLEL_API_KEY not configured" };
          return await searchParallel(q, 2, key, tr);
        }
        case "perplexity": {
          const key = await resolveApiKey("PERPLEXITY_API_KEY", "perplexityApiKey");
          if (!key) return { ok: false, error: "PERPLEXITY_API_KEY not configured" };
          return await searchPerplexity(q, 2, key, undefined, tr);
        }
        case "deepseek-official": {
          const key = await resolveApiKey("DEEPSEEK_API_KEY", "deepseekApiKey");
          if (!key) return { ok: false, error: "DEEPSEEK_API_KEY not configured" };
          return await searchDeepSeekOfficial(q, 2, key);
        }
        default:
          return { ok: false, error: `unknown engine: ${engine}` };
      }
    };
    try {
      const result = await attempt();
      // У платного движка нет ключа: пробрасываем результат сбоя напрямую
      if (result.ok === false) return result;
      // У бесплатного движка при случайном антибот-блоке/пустом ответе — один повтор
      if (result.sources && result.sources.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        return await attempt();
      }
      return {
        ok: true,
        sources: (result.sources ?? []).map((s) =>
          s.snippet ? { ...s, snippet: cleanSnippet(s.snippet) } : s
        ),
        truncated: result.truncated ?? false,
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };

  ctx.inject(["tools"], (sctx) => {
    sctx.effect(() => {
      const dispose = sctx.tools.register(
        defineTool({
          name: "free_search_test",
          description:
            "Test every configured web search engine and report which ones work. Use this to verify engine availability, diagnose search failures, or check whether an API key is configured.",
          parameters: {
            engines: {
              type: "array",
              description: "Which engines to test (default: all). Options: ddg, ddg-lite, bing, searxng, anysearch, exa, tavily, keenable, firecrawl, parallel, perplexity, deepseek-official.",
              items: { type: "string" },
            },
            query: {
              type: "string",
              description: "Optional search query to use for the test (default: 'DeepSeek Harness').",
            },
          },
          output: {
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                results: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      engine: { type: "string" },
                      status: { type: "string" },
                      results: { type: "number" },
                      error: { type: "string" },
                      sampleTitle: { type: "string" },
                      sampleUrl: { type: "string" },
                    },
                  },
                },
              },
            },
            render(args, value) {
              const lines = value.results.map((r) => {
                if (r.status === "ok") {
                  return `- ${r.engine}: OK (${r.results} results${r.sampleTitle ? `, e.g. "${r.sampleTitle.slice(0, 40)}"` : ""})`;
                }
                return `- ${r.engine}: FAIL - ${r.error}`;
              });
              return `Search engine test:\n${lines.join("\n")}`;
            },
          },
          async execute(args) {
            const engines = args.engines && args.engines.length > 0 ? args.engines : ALL_ENGINES;
            const results = [];
            for (const engine of engines) {
              const r = await runEngineTest(engine, args.query);
              if (r.ok) {
                const item = {
                  engine,
                  status: "ok",
                  results: r.sources.length,
                };
                if (r.sources[0]?.title) item.sampleTitle = String(r.sources[0].title);
                if (r.sources[0]?.url) item.sampleUrl = String(r.sources[0].url);
                results.push(item);
              } else {
                results.push({ engine, status: "fail", error: r.error ?? "unknown error" });
              }
            }
            return { results };
          },
          finalizeContent(exec, result) {
            // Оборачиваем вывод render в валидный text block (content должен быть массивом блоков)
            const text = result.content;
            if (typeof text === "string" && text.length > 0) {
              return [{ type: "text", text }];
            }
            return undefined;
          },
        })
      );
      return () => {
        dispose();
      };
    }, "free-search: test engines tool");
  });

  // Инструмент поиска по платформам: GitHub / V2EX / Bilibili / Reddit (публичные API, без зависимостей)
  ctx.inject(["tools"], (sctx) => {
    sctx.effect(() => {
      const dispose = sctx.tools.register(
        defineTool({
          name: "platform_search",
          description:
            "Search a specific platform (GitHub / V2EX / Bilibili / Reddit / Hacker News / Stack Overflow / Wikipedia / npm) for a query. Returns source URLs with titles and snippets. Use this when the user asks about repos, code, forum threads, videos, discussions, Q&A, encyclopedia entries, or packages.",
          parameters: {
            platform: {
              type: "string",
              description: "Platform to search: github, v2ex, bilibili, reddit, hn, stackoverflow, wikipedia, npm",
            },
            query: {
              type: "string",
              description: "The search query.",
            },
            maxResults: {
              type: "number",
              description: "Optional result count (default 5, max 10).",
            },
          },
          output: {
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                platform: { type: "string" },
                sources: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      url: { type: "string" },
                      title: { type: "string" },
                      snippet: { type: "string" },
                    },
                  },
                },
              },
            },
            render(args, value) {
              const lines = value.sources.map((s, i) => `- [${s.title ?? s.url}](${s.url})${s.snippet ? ` - ${s.snippet.slice(0, 120)}` : ""}`);
              return `Platform search (${value.platform}):\n${lines.join("\n") || "No results found."}`;
            },
          },
          async execute(args) {
            const platform = args.platform;
            if (!PLATFORMS[platform]) {
              throw new Error(`unknown platform "${platform}" - use one of: ${Object.keys(PLATFORMS).join(", ")}`);
            }
            // Переключатель платформ: если платформа отключена в settings, инструмент явно сообщает об этом
            const enabled = current().platforms ?? ["github", "v2ex", "bilibili", "reddit", "hn", "stackoverflow", "wikipedia", "npm"];
            if (!enabled.includes(platform)) {
              throw new Error(
                `platform "${platform}" is disabled in Free Search settings - enable it in Settings > Plugins > Free Search to use it`
              );
            }
            const limit = Math.min(args.maxResults ?? 5, 10);
            const result = await searchPlatform(platform, args.query, limit, undefined, current().lang);
            // lossless JSON не допускает полей undefined: выбрасываем отсутствующие поля
            const sources = (result.sources ?? []).map((s) => {
              const source = {};
              if (s.url !== undefined && s.url !== null && s.url !== "") source.url = s.url;
              if (s.title !== undefined && s.title !== null && s.title !== "") source.title = String(s.title);
              if (s.snippet !== undefined && s.snippet !== null && s.snippet !== "") source.snippet = String(s.snippet);
              return source;
            });
            return { platform, sources };
          },
          finalizeContent(exec, result) {
            // Tool-result content must be an array of content blocks, not a raw string.
            const text = result.content;
            return typeof text === "string" && text.length > 0 ? [{ type: "text", text }] : undefined;
          },
        })
      );
      return () => {
        dispose();
      };
    }, "free-search: platform search tool");
  });

  // Инструмент расширенного поиска: поддерживает временной фильтр (time_range) и явный выбор движка (engine).
  // Использует ту же цепочку фоллбэка, что и web_search, но позволяет агенту явно запросить результаты за "последние N дней".
  ctx.inject(["tools"], (sctx) => {
    sctx.effect(() => {
      const dispose = sctx.tools.register(
        defineTool({
          name: "advanced_search",
          description:
            "Search the web with optional time filtering. Use when the user wants results from a specific time window (e.g. 'last week', 'this month') or when you need to force a specific engine. Falls back across engines automatically just like web_search.",
          parameters: {
            query: {
              type: "string",
              description: "The search query.",
            },
            maxResults: {
              type: "number",
              description: "Optional result count (default 5, max 10).",
            },
            timeRange: {
              type: "string",
              description: "Optional time filter. Fixed tiers: day, week, month, year. Custom: relative like 12h, 3d, 2mo, 1y, or an absolute date like 2026-07-01 (published after that date). Exa/Keenable apply it precisely; Tavily/SearXNG/DDG map to the nearest tier.",
            },
            engine: {
              type: "string",
              description: "Optional specific engine to try first: ddg, ddg-lite, bing, searxng, anysearch, exa, tavily, keenable, firecrawl, parallel, perplexity, deepseek-official.",
            },
          },
          output: {
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                provider: { type: "string" },
                content: { type: "string" },
                sources: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      url: { type: "string" },
                      title: { type: "string" },
                      snippet: { type: "string" },
                      publishedAt: { type: "string" },
                    },
                  },
                },
              },
            },
            render(args, value) {
              const lines = value.sources.map((s, i) => `- [${s.title ?? s.url}](${s.url})${s.snippet ? ` - ${s.snippet.slice(0, 120)}` : ""}${s.publishedAt ? ` (${s.publishedAt})` : ""}`);
              return `Search (${value.provider}${args.timeRange ? `, timeRange=${args.timeRange}` : ""}):\n${lines.join("\n") || "No results found."}${value.content ? `\n\n${value.content}` : ""}`;
            },
          },
          async execute(args) {
            if (!args.query || !String(args.query).trim()) throw new Error("query is required");
            const request = {
              query: args.query,
              maxResults: Math.min(args.maxResults ?? 5, 10),
            };
            if (parseTimeRange(args.timeRange) !== undefined) request.timeRange = args.timeRange;
            // Когда указан engine: предпочитаем его только если он доступен (всё равно идёт через цепочку фоллбэка, при сбое автоматически переключается)
            if (args.engine && ALL_ENGINES.includes(args.engine)) request.engine = args.engine;
            const result = await provider.search(request);
            // lossless JSON не допускает полей undefined: собираем объект только из реально существующих значений, пропущенные поля просто опускаем
            return {
              provider: result.provider ?? result._provider ?? "bing",
              content: typeof result.content === "string" ? result.content : "",
              sources: (result.sources ?? []).map((s) => {
                const source = {};
                if (s.url !== undefined && s.url !== null && s.url !== "") source.url = s.url;
                if (s.title !== undefined && s.title !== null && s.title !== "") source.title = String(s.title);
                if (s.snippet !== undefined && s.snippet !== null && s.snippet !== "") source.snippet = String(s.snippet);
                if (s.publishedAt !== undefined && s.publishedAt !== null && s.publishedAt !== "") {
                  source.publishedAt = String(s.publishedAt);
                }
                return source;
              }),
            };
          },
          finalizeContent(exec, result) {
            // Tool-result content must be an array of content blocks, not a raw string.
            const text = result.content;
            return typeof text === "string" && text.length > 0 ? [{ type: "text", text }] : undefined;
          },
        })
      );
      return () => {
        dispose();
      };
    }, "free-search: advanced search tool");
  });

  // Сообщаем агенту список доступных поисковых движков (генерируется динамически, обновляется при смене ключей/настроек)
  ctx.inject(["systemPrompt"], (sctx) => {
    let disposeSection = null;
    refreshPrompt = () => {
      if (disposeSection) {
        disposeSection();
        disposeSection = null;
      }
      disposeSection = sctx.systemPrompt.section({
        name: "free-search:engines",
        order: 500,
        text: [
          "## Available web search engines (free-search plugin)",
          "",
          "You have the web_search tool. Its backend engine is chosen in Settings > Plugins > Free Search.",
          "Current engine: " + (current().provider ?? "bing"),
          "Safe search filter (Settings > Plugins > Free Search): " + (current().safeSearch ?? "off") + " (off|moderate|strict). Engine default off; applies to bing/ddg/ddg-lite.",
          "Bing market: " + (current().bingMarket ?? "zh-CN") + " (mkt + Accept-Language; e.g. ru-RU returns Russian results for Cyrillic queries).",
          "",
          "Available engines and their requirements:",
          "- ddg (DuckDuckGo HTML) - FREE, no key (may be rate-limited)",
          "- ddg-lite (DuckDuckGo Lite) - FREE, no key (may be rate-limited)",
          "- bing (Bing) - FREE, no key (most stable)",
          "- searxng (meta-search, multi-instance) - FREE, no key",
          "- anysearch (AI search) - FREE, no key",
          "- exa - FREE keyless (MCP) or EXA_API_KEY for higher limits",
          "- tavily - FREE keyless or TAVILY_API_KEY for higher limits",
          "- keenable - FREE keyless (MCP) or KEENABLE_API_KEY for higher limits",
          "- firecrawl - FREE keyless or FIRECRAWL_API_KEY for higher limits",
          "- parallel - requires PARALLEL_API_KEY",
          "- perplexity - requires PERPLEXITY_API_KEY",
          "- deepseek-official - requires DEEPSEEK_API_KEY",
          "",
          "IMPORTANT: If the configured engine fails (missing key, invalid key, 401, rate limit, or network error), web_search automatically tries other engines in this order: (1) the configured engine first, (2) then other engines with API keys configured (exa/tavily/keenable/firecrawl work keyless too, so they are tried even without a key), (3) then the remaining free engines (Bing, AnySearch, DuckDuckGo, SearXNG). This applies to ALL engines - paid or free. The results include a note showing which engine was actually used and why the preferred one was skipped. Understand the two note forms: (a) 'Note: X does not support time filtering (timeRange=...), using Y.' means X cannot filter by time so it was skipped BEFORE any attempt (X did NOT fail); (b) 'Note: X unavailable or failed (reason), using Y.' means X was actually tried but failed (missing key / invalid key / 401 / rate limit / network / 0 results). Never tell the user search is unavailable - it always falls back.",
          "",
          "Use the free_search_test tool to test which engines actually work right now.",
          "",
          "When the user wants results from a specific time window (e.g. 'last week', 'this month', 'last 3 days'), use the advanced_search tool with timeRange. Fixed tiers: day|week|month|year. Custom: 12h, 3d, 2mo, 1y, or an absolute date like 2026-07-01.",
          "",
          "For platform-specific searches (GitHub repos, V2EX threads, Bilibili videos, Reddit posts, Hacker News discussions, Stack Overflow questions, Wikipedia articles, npm packages), use the platform_search tool with platform: github|v2ex|bilibili|reddit|hn|stackoverflow|wikipedia|npm.",
          "",
          "The user can switch the search engine themselves by typing /free-search-engine in the chat — it opens a picker to choose an engine, just like the settings page. This changes the preferred engine; search still falls back to other engines automatically if it fails. You should not switch engines on your own; let the user decide.",
        ].join("\n"),
      });
    };
    sctx.effect(() => {
      refreshPrompt();
      return () => {
        if (disposeSection) disposeSection();
        disposeSection = null;
      };
    }, "free-search: engine list prompt section");
  });
}

export {
  ALL_ENGINES,
  ANYSEARCH_URL,
  BING_URL,
  Config,
  DDG_HTML_URL,
  DDG_LITE_URL,
  EXA_MCP_URL,
  FIRECRAWL_URL,
  FREE_ENGINES,
  FREE_SEARCH_NS,
  KEENABLE_MCP_URL,
  KEENABLE_URL,
  PARALLEL_URL,
  PLATFORMS,
  SEARXNG_INSTANCES,
  TAVILY_URL,
  TIME_RANGES,
  apply,
  approximateTimeRange,
  formatKeenableRelative,
  inject,
  name,
  parseTimeRange,
  searchAnysearch,
  searchBing,
  searchBilibili,
  searchDeepSeekOfficial,
  searchDdgHtml,
  searchDdgLite,
  searchExa,
  searchExaMCP,
  searchFirecrawl,
  searchGithub,
  searchHackerNews,
  searchKeenable,
  searchKeenableMCP,
  searchKeenableREST,
  searchNpm,
  searchParallel,
  searchPerplexity,
  searchPlatform,
  searchReddit,
  searchSearxng,
  searchStackOverflow,
  searchTavily,
  searchV2ex,
  searchWikipedia,
};
