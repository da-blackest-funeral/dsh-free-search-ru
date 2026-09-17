# Опыт форка dsh-free-search

> Краткая выжимка из полного отчёта, который лежит в Hindsight memory (`doc_id: dsh-free-search-perplexity`).

## Контекст

- **Апстрим**: https://github.com/DDDMUC/dsh-free-search (v0.4.28)
- **Форк**: https://github.com/da-blackest-funeral/dsh-free-search-ru (v0.4.29)
- **Причина форка**: апстрим не обновил Perplexity до нового Agent API (старый `/v1/chat/completions` отключится 27 сентября 2026), а интерфейс карточки настроек только на китайском + английском без русского.

## Что было сделано

1. **Русский UI** — добавлен `I18N.ru` в `lib/client.js`, дефолтный язык `ru`, цикл переключения `ru → 中文 → EN → ru`. `zh`-секция оставлена без изменений.
2. **Perplexity на Agent API** — `lib/index.js:searchPerplexity` переписан: `POST /v1/agent`, модель `perplexity/sonar`, `input` вместо `messages`, явный `tools: [{type: "web_search"}]`, парсинг typed `output[]`.
3. **Time-filter для Perplexity** — бонус через `tools[0].filters.search_recency_filter` (hour|day|week|month|year) и `last_updated_after_filter`.
4. **README** — переписан на русский (546→380 строк), комментарии в `lib/index.js` (129 строк) и `lib/client.js` (14 строк) переведены.
5. **Установка в DSH** — `pnpm remove dsh-free-search && pnpm add github:da-blackest-funeral/dsh-free-search-ru`.

## Архитектурные факты

| Факт | Где искать |
|---|---|
| Имя пакета в `package.json` НЕ обязано совпадать с именем карточки в UI | `slots.register({name, key, id, ...}, Component)` в `apply()` |
| Приоритет чтения ключей: `credentials → settings → env` | `resolveApiKey()` в `lib/index.js` |
| Мост `/api/dsh-free-search-settings/{describe,mutate,credentials-set,...}` позволяет не зависеть от `dsh-web-ui` | роуты в `lib/index.js` |
| `cordis.patch.yml` имеет семантику «полная замена config» | комментарий в самом файле; обязательно сохранять `fetchProvider` |
| Мост `/api/dsh-free-search-settings/credentials-status|set|unset` пишет в `~/.dsh/.credentials.yaml`, секция `refs.<KEY>` | `KEY_REF_MAP` в `lib/index.js` |

## Perplexity миграция — дифф

| Старое | Новое |
|---|---|
| `https://api.perplexity.ai/chat/completions` | `https://api.perplexity.ai/v1/agent` |
| `model: "sonar"` | `model: "perplexity/sonar"` |
| `messages: [{role, content}]` | `input: "<query>"` |
| (нет — поиск встроенный) | `tools: [{type: "web_search"}]` |
| `citations: string[]` (плоский URL) | `output[]` где `type: "search_results"` с `results: [{id, url, title, snippet, date, ...}]` |
| `choices[0].message.content` | `output_text` или `output[].content[].text` |
| `max_tokens: 1024` | `max_output_tokens: 1024` |
| Нет time-filter | `tools[0].filters.search_recency_filter` + `last_updated_after_filter` |

## Лучшие практики

- **End-to-end = код + push + install + рестарт**, не только код. Не оставлять пользователя с инструкцией «выполни сам».
- **Curl-тест с реальным ключом** перед заявлением «миграция готова». Стоит 5 секунд, ловит несоответствия API.
- **`node --check`** после каждого изменения в JS.
- **`upstream` remote** добавляется сразу: `git remote add upstream https://github.com/<author>/<repo>.git`.
- **Подагент переводит 129 строк за один заход**, если дать ему полный контекст файла.
- **Сохранять оригинальные строки, которые выглядят как артефакт**, но намеренные (`zh`-секция I18N, `toggleLang: "中文"`, имя файла `启动搜索引擎切换器.cmd`). Закомментировать в коммите.

## Как обновить форк после апстрима

```bash
cd ~/dsh-free-search-ru
git fetch upstream
git merge upstream/master
# Разрулить конфликты (если будут)
git push origin master
# В DSH:
cd ~/.dsh/profiles/web
pnpm update dsh-free-search-ru
```
