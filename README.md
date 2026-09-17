# dsh-free-search-ru

> **Форк [DDDMUC/dsh-free-search](https://github.com/DDDMUC/dsh-free-search).** Главные отличия от апстрима:
>
> - **Русский интерфейс** в карточке настроек (по умолчанию `ru`; переключатель `ru → 中文 → EN → ru`).
> - **Perplexity на новом Agent API** (`POST /v1/agent`, модель `perplexity/sonar` + `web_search` tool). Старый `/v1/chat/completions` отключится 27 сентября 2026, так что без этого апстрим скоро сломается.
> - **Time-filter для Perplexity** — теперь работает через `web_search.filters.search_recency_filter` (hour / day / week / month / year) и `last_updated_after_filter` (абсолютная дата MM/DD/YYYY).
> - **Корректный парсинг новых источников** — `output[].search_results` с полями `title`, `snippet`, `url`, `date`, `last_updated` (а не старый плоский `citations[]`).
> - **README и комментарии в коде переведены на русский** для удобства русскоязычных пользователей и контрибьюторов.
>
> Форк синхронизируется с апстримом через git remote `upstream`. Документация ниже описывает форк, но большая часть описаний движков справедлива и для оригинала.

**Плагин веб-поиска для DeepSeek Harness — без API-ключей, бесплатно, с переключением движков.** Регистрирует свой `WebSearchProvider` в seam `ctx.web`, так что встроенный инструмент `web_search` начинает работать «из коробки». Поддерживает веб-страницу настроек (переключение движков, ключи, тест), всплывающую команду `/free-search-engine` для смены движка из чата и автофоллбэк между движками при любой ошибке.

[Русский](#русский) · [English](#english)

---

## Русский

<div align="center">
  <a href="https://raw.githubusercontent.com/DDDMUC/dsh-free-search/master/assets/settings-free1.png">
    <img src="https://raw.githubusercontent.com/DDDMUC/dsh-free-search/master/assets/settings-free1.png" alt="Настройки бесплатного движка (Bing)" width="820" />
  </a>
  <br>
  <sub>▲ Настройки бесплатного движка (на примере Bing)</sub>
</div>

### Зачем это нужно

Встроенный провайдер поиска в dsh зависит от официального ключа DeepSeek API (`DEEPSEEK_API_KEY`). Если вы:

- не имеете (или не хотите использовать) официального ключа DeepSeek,
- используете шлюзы вроде opencode-go, чьи OpenAI-совместимые эндпоинты не поддерживают инструмент `web_search`,

…то встроенный поиск неизбежно падает, а агент рапортует «не удаётся выйти в интернет».

Этот плагин даёт несколько бесплатных движков и автоматический фоллбэк между ними, полностью снимая зависимость от ключа DeepSeek.

### Возможности

- **Бесплатно** — несколько бесплатных движков, без ключей и без регистрации.
- **12 движков на выбор**: DuckDuckGo (HTML / Lite), Bing, SearXNG (мета-поиск с кастомными инстансами), AnySearch, Exa, Tavily, Keenable, Firecrawl, Parallel, Perplexity, официальный DeepSeek.
- **Веб-страница настроек** — переключение движка + ключи API (в UI ключи маскируются как «настроено») + переключатель языка `ru / 中文 / EN`.
- **Команда в чате** — введите `/free-search-engine`, откроется всплывающее окно выбора движка (как `/model` для смены модели); клик сохраняет настройку.
- **Тестирование движков** — инструмент `free_search_test` позволяет агенту за один заход прогнать все движки; на странице настроек есть кнопка «Проверить движок» (тестирует текущий движок напрямую, без фоллбэка — платные без ключа явно сообщат об ошибке).
- **Единый фоллбэк движков** — при любой ошибке (платный/бесплатный, нет ключа / 401 / лимит / сеть) плагин по очереди пробует следующие: сначала выбранный движок → другие движки (exa / tavily / keenable / firecrawl пробуются даже без ключа, т.к. у них есть бесплатная keyless-квота) → оставшиеся бесплатные движки. Поиск никогда не валится напрямую; в начале результата пишется, какой движок реально отработал (например, `Note: perplexity unavailable or failed, using exa.`).
- **Фильтр по времени** — инструмент `advanced_search` поддерживает `timeRange`: фиксированные диапазоны, относительные значения или абсолютную дату (подробности ниже).
- **Инъекция в системный промпт** — агент знает, какой движок сейчас активен и каким нужен ключ.
- **Версия и проверка обновлений** — на карточке отображается текущая версия (v0.4.29), кнопка «Проверить обновления» сверяется с npm registry и при наличии новой версии предлагает переход.
- **Кэш результатов** — одинаковые запросы (один движок и те же параметры времени) попадают в LRU-кэш (50 записей) на 5 минут — защита бесплатных движков от лимитов и экономия платной квоты; TTL настраивается в карточке (0–5 минут; 0 отключает кэш).
- **Бейджи** — бесплатные движки отмечены зелёным `FREE`, платные — оранжевым `API KEY`.
- **`web_fetch`** — позволяет агенту читать полный текст веб-страницы (официальный провайдер `dsh-web-fetch-http`, чистый JS, без зависимостей).
- **`platform_search`** — поиск по GitHub / V2EX / Bilibili / Reddit / Hacker News / Stack Overflow / Википедия / npm через публичные API (без ключей и зависимостей).
- **Чистая интеграция** — реализует официальный интерфейс `WebSearchProvider`, сосуществует с официальными плагинами.

Если плагин оказался полезен — поставьте ⭐ [апстриму](https://github.com/DDDMUC/dsh-free-search) и/или этому форку. Это лучшая мотивация продолжать поддержку, спасибо!

### Список движков

| id | Движок | Стоимость | Описание |
|---|---|---|---|
| `ddg` | DuckDuckGo HTML | Бесплатный | Случайные лимиты (антибот), восстанавливается автоматически |
| `ddg-lite` | DuckDuckGo Lite | Бесплатный | Лёгкая версия, то же поведение по лимитам |
| `bing` | Bing | Бесплатный | **Движок по умолчанию**, самый стабильный, оптимизирован под китайский (`zh-CN`) |
| `anysearch` | AnySearch AI | Бесплатный | AI-поиск, без ключа (анонимная квота) |
| `searxng` | SearXNG мета-поиск | Бесплатный | Автоперебор нескольких инстансов, поддержка кастомных |
| `exa` | Exa | Бесплатный | **Работает без ключа** (анонимный MCP), с ключом — выше квота |
| `tavily` | Tavily | Бесплатный | **Работает без ключа** (keyless-аноним), с ключом — выше квота |
| `keenable` | Keenable | Бесплатный | **Работает без ключа** (анонимный MCP), с ключом — REST с лимитами по организации |
| `firecrawl` | Firecrawl | Бесплатный | **Работает без ключа** (официальная keyless-квота), с ключом — выше лимит |
| `parallel` | Parallel | Платный | Требует `PARALLEL_API_KEY` (на platform.parallel.ai есть бесплатный тариф) |
| `perplexity` | Perplexity | Платный | Требует `PERPLEXITY_API_KEY`. В этом форке — на новом Agent API `/v1/agent` |
| `deepseek-official` | DeepSeek официальный | Платный | Требует `DEEPSEEK_API_KEY` |

- **Движок по умолчанию — `bing`** (бесплатный и самый стабильный), работает сразу после установки.
- **Автофоллбэк**: при любой ошибке (лимит бесплатного движка / отсутствующий или неверный платный ключ / сетевая ошибка) плагин по очереди пробует следующий — сначала выбранный, затем остальные платные (exa / tavily / keenable / firecrawl пробуются даже без ключа, т.к. у них есть keyless-квота), затем оставшиеся бесплатные (Bing / AnySearch и др.). В результатах прикрепляется пометка о фактически отработавшем движке — поиск никогда не валится напрямую из-за проблем одного движка.
- **Ссылки на сайты в настройках**: бесплатные движки показывают «Открыть сайт →», платные — «Получить API-ключ →» (открывается в новой вкладке):
  - Exa: <https://dashboard.exa.ai/api-keys>
  - Tavily: <https://app.tavily.com/home>
  - Keenable: <https://keenable.ai/login>
  - Parallel: <https://platform.parallel.ai>
  - Perplexity: <https://www.perplexity.ai/settings/api>
  - DeepSeek: <https://platform.deepseek.com/api_keys>

#### Почему бесплатные движки не требуют ключа?

- **AnySearch**: его REST-эндпоинт `v1/search` отдаёт анонимную публичную поисковую квоту без регистрации и ключа. Квота ограничена по лимитам (хватает для повседневных запросов), но в связке с автофоллбэком остаётся надёжным.
- **Exa**: публичный MCP-эндпоинт (`mcp.exa.ai/mcp`) поддерживает анонимные вызовы — без ключа тоже работает; `EXA_API_KEY` повышает квоту.
- **Tavily**: через заголовок `x-tavily-access-mode: keyless` отдаёт анонимную квоту без ключа; `TAVILY_API_KEY` переключает на аккаунтный тариф с большей квотой и стабильным качеством.
- **Keenable**: без ключа работает через публичный MCP (`api.keenable.ai/mcp`); `KEENABLE_API_KEY` переключает на REST API (`api.keenable.ai/v1/search`) с лимитами по организации.
- **Firecrawl**: эндпоинт `/v2/search` **работает без ключа** (в официальной документации сказано «No API key needed to get started», с анонимными лимитами); `FIRECRAWL_API_KEY` повышает лимит. Поддерживает `tbs`-фильтр по времени (`qdr:h/d/w/m/y` и кастомные диапазоны дат).

### Установка

Форк ставится прямо из GitHub:

```sh
dsh plugin --profile web add github:da-blackest-funeral/dsh-free-search-ru
```

Либо вручную — клонируйте и добавьте как локальный путь:

```sh
git clone https://github.com/da-blackest-funeral/dsh-free-search-ru.git
dsh plugin --profile web add /path/to/dsh-free-search-ru
```

Затем перезапустите:

```sh
dsh web
```

#### Сопутствующий плагин: dsh-preset-workbench

**Сестринский плагин** того же автора: визуальный «верстак» для создания и редактирования пресетов агента прямо в Настройках — секционированные промпты, 15 тумблеров возможностей, встроенные шаблоны «Whale Girl / Liangshen Mode», без YAML. В паре: **free-search даёт агенту веб-поиск, preset-workbench — личность и набор способностей**. Оба бесплатны и работают «из коробки».

- Репо: <https://github.com/DDDMUC/dsh-preset-workbench>
- Установка: `dsh plugin --profile web add github:DDDMUC/dsh-preset-workbench`
- Использование: Настройки → Preset Workbench

Если preset-workbench тоже полезен — ⭐ на его репо будет кстати. 🙏

#### Про зависимости

Плагин намеренно объявляет `@deepseek-ai/dsh-settings` и `@deepseek-ai/dsh-tools` как `peerDependencies`: рантайм DSH должен использовать единственный экземпляр из дерева установки. Ставьте плагин через `dsh plugin --profile <profile> add ...`. **Не копируйте** пакеты ядра DSH в локальный `node_modules` профиля — дубликаты ломают планировщик инструментов.

### Использование

#### Веб-интерфейс настроек (рекомендуется)

После установки откройте **Настройки → Плагины → Настраиваемые** → карточка **Free Search**:

- **Поисковая система**: выпадающий список для смены движка, изменения применяются после сохранения.
- **API-ключи**: введите ключи для Exa / Tavily / Keenable / Firecrawl / Parallel / Perplexity / DeepSeek (поля-пароли; после сохранения показываются как «настроено»).
  - **Рекомендация**: платные ключи лучше хранить в центре учётных данных харнесса — `~/.dsh/.credentials.yaml` (например, `DEEPSEEK_API_KEY: sk-...`, так же как официальные LLM-провайдеры — все ключи в одном месте). Приоритет чтения: центр учётных данных → страница настроек → переменная окружения; поля на странице настроек остаются для обратной совместимости.
- **Проверить движок**: тестирует выбранный движок напрямую (без фоллбэка; платные без ключа явно сообщат об ошибке).
- **Вернуть Bing по умолчанию**: переключает на стабильный бесплатный Bing; «Отменить» откатывает несохранённые правки.
- **Поиск по платформам**: отметьте GitHub / V2EX / Bilibili / Reddit / Hacker News / Stack Overflow / Википедия / npm — инструмент `platform_search` будет фильтровать по выбранным.
- **`ru / 中文 / EN`**: переключатель языка интерфейса (по умолчанию `ru`).

<table align="center" style="border: none; border-collapse: collapse;">
  <tr style="border: none;">
    <td align="center" width="50%" style="border: none; padding: 6px;">
      <a href="https://raw.githubusercontent.com/DDDMUC/dsh-free-search/master/assets/settings-free.png">
        <img src="https://raw.githubusercontent.com/DDDMUC/dsh-free-search/master/assets/settings-free.png" alt="Настройки бесплатного движка" width="100%" />
      </a>
      <br>
      <sub>▲ <b>Бесплатный движок</b> (зелёный бейдж FREE и ссылка на сайт)</sub>
    </td>
    <td align="center" width="50%" style="border: none; padding: 6px;">
      <a href="https://raw.githubusercontent.com/DDDMUC/dsh-free-search/master/assets/settings-apikey.png">
        <img src="https://raw.githubusercontent.com/DDDMUC/dsh-free-search/master/assets/settings-apikey.png" alt="Настройки платного движка" width="100%" />
      </a>
      <br>
      <sub>▲ <b>Платный / API-ключ движок</b> (оранжевый бейдж API KEY и ссылка «Получить ключ»)</sub>
    </td>
  </tr>
</table>

#### Смена движка из чата (`/free-search-engine`)

Можно менять движок прямо из чата, без страницы настроек. Введите `/free-search-engine` — откроется **всплывающее окно выбора движка** (тот же UX, что у `/model` для смены модели). Кликните нужный — он подсветится как текущий. Эквивалентно переключению и сохранению на странице настроек; язык подхватывается оттуда же.

Команда меняет только предпочтительный движок; сам поиск по-прежнему идёт через `web_search` + единый фоллбэк — даже если предпочтительный движок упадёт, плагин автоматически переключится на другой, поиск никогда не валится напрямую. Системный промпт обновляется синхронно.

#### Конфигурационный файл

Конфиг хранится в `~/.dsh/settings.yaml`:

```yaml
free-search:
  provider: perplexity         # ddg / ddg-lite / bing / searxng / anysearch / exa / tavily / keenable / firecrawl / parallel / perplexity / deepseek-official
  lang: ru                     # язык интерфейса карточки настроек (ru / zh / en)
  keyStorage: credentials      # где хранить ключи: credentials (центр учётных данных) | settings (наследие)
  bingMarket: ru-RU            # регион Bing (см. карточку настроек)
  region: ru                   # регион DuckDuckGo (опционально)
  safeSearch: off              # off | moderate | strict — фильтр Bing/DDG
  cacheTtl: 5                  # TTL кэша результатов, минут (0–5)
  searxngInstances:            # кастомные инстансы SearXNG (опционально)
    - https://your-instance.example
  perplexityApiKey: pplx-...   # или настройте через UI (рекомендуется центр учётных данных)
  exaApiKey: ...
  tavilyApiKey: ...
  keenableApiKey: ...
  firecrawlApiKey: ...
  parallelApiKey: ...
  deepseekApiKey: ...
  platforms:                   # платформы для platform_search
    - github
    - v2ex
    - bilibili
    - reddit
    - hn
    - stackoverflow
    - wikipedia
    - npm
```

Рекомендуемый путь для ключей — центр учётных данных (`~/.dsh/.credentials.yaml` в секции `refs`):

```yaml
refs:
  PERPLEXITY_API_KEY: pplx-...
  EXA_API_KEY: ...
  TAVILY_API_KEY: ...
  KEENABLE_API_KEY: ...
  FIRECRAWL_API_KEY: ...
  PARALLEL_API_KEY: ...
  DEEPSEEK_API_KEY: ...
```

Приоритет чтения ключей: центр учётных данных → страница настроек → переменная окружения. Хранить в центре учётных данных — единое место для всех ключей, как у официальных LLM-провайдеров.

#### Попросить агента прогнать все движки

Скажите агенту *«проверь все поисковые движки»* — он вызовет инструмент `free_search_test` и пройдёт по всем по очереди:

```
Search engine test:
- ddg: FAIL - DuckDuckGo is rate-limited right now (anti-bot challenge, usually temporary) - Bing works
- bing: OK (2 results, e.g. "DeepSeek Harness developer preview...")
- exa: FAIL - EXA_API_KEY not configured
```

#### Фильтр по времени (`advanced_search`)

Попросите агента найти «новости за последнюю неделю», «релизы этого месяца», «события за 3 дня», «обновления с июля» — агент вызовет инструмент `advanced_search` с параметром `timeRange`. Тот же единый фоллбэк, можно форсировать конкретный `engine`, формат ответа совпадает с `web_search`.

**`timeRange` принимает три формы:**

| Форма | Пример | Значение |
|---|---|---|
| Фиксированный диапазон | `day` / `week` / `month` / `year` | = 1 / 7 / 30 / 365 дней |
| Кастомное относительное | `12h`, `3d`, `2mo`, `1y` | последние 12 ч / 3 дня / 2 месяца / 1 год |
| Абсолютная дата | `2026-07-01` | результаты, опубликованные не раньше этой даты |

**Как каждый движок обрабатывает `timeRange`:**

| Движок | Параметр | Точно? | Заметки |
|---|---|---|---|
| Exa | `startPublishedDate` | ✅ точно | кастомные дни → ISO-дата (N дней назад); абсолютные даты пробрасываются |
| Keenable | `published_after` | ✅ точно | относительные (`12h/3d/2mo/1y`) и абсолютные даты пробрасываются |
| Tavily | `time_range` | ⚠️ приблизительно | только фиксированные диапазоны; кастомные дни маппятся на ближайший |
| Firecrawl | `tbs` | ⚠️ приблизительно | фиксированные → `qdr:d/w/m/y`; абсолютные даты → `cdr:1,cd_min:M/D/YYYY` (точно) |
| Parallel | `source_policy.after_date` | ✅ точно | кастомные дни → ISO-дата; абсолютные пробрасываются |
| SearXNG | `time_range` | ⚠️ приблизительно | то же, что и Tavily |
| DuckDuckGo / Lite | `df` | ⚠️ приблизительно | то же, что и Tavily |
| Bing / AnySearch | — | ❌ игнорируется | параметра нет |
| Perplexity (форк) | `web_search.filters.search_recency_filter` | ⚠️ приблизительно (hour/day/week/month/year) | + `last_updated_after_filter` (абсолютная дата, точно) |

**Правило ближайшего диапазона**: `≤2 дней → day`, `≤14 → week`, `≤90 → month`, иначе `year`. Например, `3d` для Tavily станет `day`, `2mo` — `month`.

**Приоритет в цепочке движков**: когда передан `timeRange`, движки с поддержкой фильтра по времени (tavily / exa / keenable / firecrawl / parallel / searxng / ddg / ddg-lite / perplexity) поднимаются в начало цепочки фоллбэка, чтобы фильтр реально сработал — даже если выбран, скажем, Bing (без фильтра), сначала попробуется движок с фильтром.

Пример: *«найди новости о DSH за последние 3 дня»* → агент вызывает `advanced_search` с `timeRange: "3d"`.

#### Чтение страниц (`web_fetch`)

После поиска агент может прочитать полный текст страницы («открой первую ссылку и расскажи, что там»). Инструмент `web_fetch` включён по умолчанию (официальный провайдер `dsh-web-fetch-http`):

- автоматически следует редиректам и декодирует HTML в текст;
- поддерживает таймаут и ограничение размера ответа;
- ⚠️ У `web_fetch` нет защиты от SSRF — агент теоретически может обращаться к внутренним адресам. Используйте осознанно.

#### Поиск по платформам (`platform_search`)

Попросите агента искать в конкретных платформах: «поищи на GitHub про deepseek harness», «что есть на Bilibili по теме», «дискуссии про dsh на V2EX». Инструмент `platform_search` поддерживает:

| Платформа | Назначение |
|---|---|
| `github` | Поиск репозиториев GitHub (публичный API, бесплатно, без ключа) |
| `v2ex` | Горячее / релевантное на V2EX |
| `bilibili` | Поиск видео / контента на Bilibili (публичный API) |
| `reddit` | Посты / обсуждения Reddit (публичный JSON API; в некоторых сетях Reddit блокирует по антиботу) |
| `hn` | Hacker News — технические обсуждения (официальный API Algolia) |
| `stackoverflow` | Stack Overflow Q&A (официальный публичный API Stack Exchange) |
| `wikipedia` | Статьи Википедии (ru.wikipedia.org в русской локали, en.wikipedia.org при `lang: en`) |
| `npm` | Поиск пакетов в npm (официальный API registry) |

Все используют публичные эндпоинты, без внешних зависимостей и API-ключей — работают сразу.

### Локальный переключатель движков (`tools/`)

В каталоге `tools/` лежит легковесная утилита без зависимостей:

- **`启动搜索引擎切换器.cmd`** (Windows) — двойной клик запускает локальный Node-сервер (`http://127.0.0.1:4789`) и автоматически открывает страницу выбора в браузере.
- **`switch-engine.html`** — UI выбора: показывает текущий движок и позволяет сменить его одним кликом.
- **`server.mjs`** — локальный бэкенд, читает/пишет `~/.dsh/profiles/web/cordis.patch.yml`.
- **`switch-engine.ps1`** — безголовый PowerShell-вариант: `powershell -File tools/switch-engine.ps1 -Engine bing`.

После переключения перезапустите `dsh web`, чтобы изменения вступили в силу.

> Карточка настроек цепляется в официальный слот `settings.plugin.item` (он встроен в dsh); чтение/запись конфигурации идут через собственный мост плагина. **Зависимости от `dsh-web-ui` нет** — плагин работает автономно.

### Прокси (для пользователей в Китае)

Некоторые движки (например, DuckDuckGo) могут требовать прокси. По умолчанию `fetch` в Node.js не ходит через системный прокси, поэтому для процесса dsh нужно выставить (Node 24+):

```sh
export NODE_USE_ENV_PROXY=1
export HTTPS_PROXY=http://127.0.0.1:7897   # ваш прокси
export HTTP_PROXY=http://127.0.0.1:7897
```

Пользователям Windows: ярлык уже включает эту конфигурацию (`set NODE_USE_ENV_PROXY=1&& set HTTPS_PROXY=...`).

### Как это работает

- `lib/index.js` — хостовая часть. Реализует `WebSearchProvider` (`id` / `available()` / `search()`), единую маршрутизацию движков + автофоллбэк (платные первыми, бесплатные как fallback); парсит `timeRange` (фиксированные диапазоны / относительные значения / абсолютные даты) и пробрасывает в каждый движок; регистрирует namespace настроек `free-search`; предоставляет мост чтения/записи `/api/dsh-free-search-settings` + отладочный эндпоинт `raw-search`; регистрирует инструменты `free_search_test`, `platform_search` и `advanced_search`; динамически инжектит список движков в системный промпт (обновляется при смене настроек).
- `lib/client.js` — браузерная часть. React-карточка настроек (выбор движка, поля ключей, тест связности, переключатель языка), монтируется в официальный слот `settings.plugin.item`; регистрирует всплывающую команду `/free-search-engine` (popupSelect через `commandUi`, тот же механизм, что у `/model`).
- `cordis.patch.yml` — конфигурация загрузчика плагина.

### Что нового в этом форке (vs апстрим)

| Версия форка | Изменение |
|---|---|
| 0.4.29 | Русский UI карточки настроек (по умолчанию `ru`); Perplexity переведён на новый Agent API `/v1/agent` с моделью `perplexity/sonar` и явным `web_search` tool; добавлена поддержка `timeRange` для Perplexity через `search_recency_filter`; README и комментарии в коде переведены на русский |

### Лицензия

MIT

---

## English

This section mirrors the upstream documentation. Most descriptions of engines and behavior are identical; the only differences live in this fork's code (Russian UI, Perplexity on Agent API). For the upstream's English docs see [DDDMUC/dsh-free-search](https://github.com/DDDMUC/dsh-free-search).

### Why You Need It

dsh's default search provider depends on the official DeepSeek API key (`DEEPSEEK_API_KEY`). If you:

- do not have (or do not want to use) the official DeepSeek key,
- use a gateway like opencode-go whose OpenAI-compatible endpoint does not support the `web_search` tool,

…then the built-in search inevitably fails, and the agent reports that it cannot reach the internet.

This plugin provides several free engines and automatic fallback between them, removing the dependency on the DeepSeek key.

### Features

- **Zero cost** — multiple free engines with no key or registration.
- **12 engines**: DuckDuckGo (HTML / Lite), Bing, SearXNG (meta-search with custom instances), AnySearch, Exa, Tavily, Keenable, Firecrawl, Parallel, Perplexity, official DeepSeek.
- **Web settings UI** — engine switching + API keys (keys masked as "configured") + `ru / 中文 / EN` language toggle.
- **Popup switch command** — type `/free-search-engine` in chat; a picker opens with all engines (same interaction as `/model`).
- **Engine testing** — `free_search_test` tool; the settings card also has a "Test engine" button (no fallback chain; paid engines without a key report an explicit error).
- **Unified engine fallback** — any engine failure (paid or free; missing key / 401 / rate limit / network) tries the next engine in chain: configured engine first → other engines (exa / tavily / keenable / firecrawl even without a key thanks to their keyless quota) → remaining free engines. Search never fails outright; the results include a note naming the engine that actually served the request (e.g. `Note: perplexity unavailable or failed, using exa.`).
- **Time filtering** — `advanced_search` supports `timeRange` (fixed tiers, custom relative, absolute date).
- **System prompt injection** — the agent knows the active engine and which ones require keys.
- **Version + update check** — the card shows the current version and offers a "Check update" button that compares against the npm registry.
- **Result caching** — identical queries (same engine + time-filter args) hit an LRU cache (50 entries) for up to 5 minutes; TTL configurable 0–5 minutes (0 disables caching).
- **Badges** — free engines show a green `FREE` badge; paid engines show an orange `API KEY` badge.
- **`web_fetch`** — the agent can read full webpage contents (official `dsh-web-fetch-http` provider, pure JS, no dependencies).
- **`platform_search`** — search GitHub / V2EX / Bilibili / Reddit / Hacker News / Stack Overflow / Wikipedia / npm via public APIs (no keys, no dependencies).
- **Clean integration** — implements the official `WebSearchProvider` seam, coexists with official plugins.

### Supported Engines

| id | Engine | Cost | Description |
|---|---|---|---|
| `ddg` | DuckDuckGo HTML | Free | Occasional rate limits (anti-bot); recovers automatically |
| `ddg-lite` | DuckDuckGo Lite | Free | Lighter version, same rate-limit behavior |
| `bing` | Bing | Free | **Default engine**, most stable, optimized for Chinese (`zh-CN`) |
| `anysearch` | AnySearch AI | Free | AI search, no key (anonymous quota) |
| `searxng` | SearXNG meta-search | Free | Multi-instance failover; supports custom instances |
| `exa` | Exa | Free | **Usable without a key** (anonymous MCP); key raises quota |
| `tavily` | Tavily | Free | **Usable without a key** (keyless anonymous); key raises quota |
| `keenable` | Keenable | Free | **Usable without a key** (anonymous MCP); key unlocks REST with org-scoped limits |
| `firecrawl` | Firecrawl | Free | **Usable without a key** (official keyless quota); key raises limits |
| `parallel` | Parallel | Paid | Requires `PARALLEL_API_KEY` (free tier available) |
| `perplexity` | Perplexity | Paid | Requires `PERPLEXITY_API_KEY`. In this fork — on the new Agent API `/v1/agent` |
| `deepseek-official` | DeepSeek Official | Paid | Requires `DEEPSEEK_API_KEY` |

The rest of the configuration, installation, time filtering, and platform search sections are identical to the upstream — see the Russian section above for the full details.

### License

MIT
