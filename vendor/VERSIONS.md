# Библиотеки във vendor/

Фиксирани версии, изтеглени от npm на 18.11.2026 (`npm install`), копирани без промени
(премахнат е само последният ред `//# sourceMappingURL=...`, защото .map файловете не се копират).
Обновяване: ръчно, като се смени файлът, редът в таблицата и версията на кеша в `sw.js`.

| Библиотека | Версия | Лиценз | Източник в npm пакета | Файл тук | SHA-256 |
|---|---|---|---|---|---|
| idb | 8.0.4 | ISC | `build/index.js` (ESM) | `idb.js` | `e01b45d2e088a7197e8b41ba9b51a0876969da67cc08e6efbc3d5d7ab6ac836c` |
| fflate | 0.8.3 | MIT | `esm/browser.js` (ESM) | `fflate.js` | `b7ca4450b19559a1d50eb381adcee94b82449674be4cd17789d9beba7e6122a1` |
| marked | 18.2.1 | MIT | `lib/marked.esm.js` (ESM) | `marked.js` | `c622dc6824a1c92c2d10ea9ede2fc872e46128afcc34b298e6ddee6f387ace8e` |
| dompurify | 3.4.18 | MPL-2.0 OR Apache-2.0 | `dist/purify.es.mjs` (ESM) | `purify.js` | `f1f1ba66e2951e5ca14bc4e71e24cc503d35d49c68f9bcfa4fd97970cb71c76b` |

Лицензите са в `licenses/`.

Употреба (ES modules, без build):

```js
import { openDB } from '../vendor/idb.js';
import { unzipSync, strFromU8 } from '../vendor/fflate.js';
import { marked } from '../vendor/marked.js';
import DOMPurify from '../vendor/purify.js';
```
