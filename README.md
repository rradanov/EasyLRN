# EasyLRN

Лично приложение (PWA) за четене на учебни курсове `LRN-<тема>`: уроци, маркиране, бележки,
въпроси към AI учител (Claude API) и „Развий ми го“. Целево устройство: Android таблет, Chrome.

Адрес: https://rradanov.github.io/EasyLRN/

## Инсталиране на таблета
1. Отвори адреса в Chrome.
2. Меню ⋮ → „Инсталиране на приложението“ (или „Добави към началния екран“).
3. Иконата „EasyLRN“ се появява на началния екран; приложението работи и офлайн.

При нова версия приложението показва „Има нова версия — Презареди“.

## Как е направено
- Vanilla JavaScript (ES modules), без framework и без build стъпка.
- Библиотеки с фиксирани версии във `vendor/` (вж. `vendor/VERSIONS.md`).
- Service Worker (`sw.js`) кешира обвивката за офлайн работа.
- Деплой: всеки push към `main` публикува сайта в GitHub Pages (`.github/workflows/pages.yml`).

Локален старт: `python3 -m http.server 8000` в папката и http://localhost:8000/.

Тестове (само за разработка, не се публикуват): `npm install`, `npx playwright install chromium`,
`npx playwright test`. Тестовете на слоя за данни могат да се отворят и в браузъра:
`npm run serve` → http://localhost:4173/EasyLRN/tests/db.html.

## Данни и сигурност
В хранилището няма курсове, лични данни и API ключове. Курсовете, бележките и ключът
живеят само в браузъра на устройството (IndexedDB).

## Документация
Изисквания, решения, план и дизайн се водят в Google Drive, папка `COURSES/LRN-APP`:
(docs kept separately)
