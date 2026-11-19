// T-054 (developer, 0.7.2): the fixes of the T-053 findings.
// - T053-D1: the cost threshold is a text field (inputmode=decimal) parsed by
//   the app: "2,5" and "2.5" are 2.5; two separators, letters, a thousands
//   separator, a sign or a space inside are refused with a clear message and
//   nothing is saved.
// - T053-I3: invisible characters around the API key are dropped like spaces;
//   inside the key they are still refused.
// Only FAKE keys; api.anthropic.com is never reached (every external request is aborted).
import { test, expect } from '@playwright/test';

const KEY = 'sk-ant-test-FAKE-t054-91b2';
const RANGE = 'Прагът е число от 0 до 1000.';
const FORMAT = 'Прагът не е число. Пиши само цифри и един десетичен знак (запетая или точка), напр. 2,5 — без букви, интервали и разделител за хилядите.';

let external;
let errors;
test.beforeEach(async ({ page, context }) => {
  external = [];
  errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await context.route(/^(https?|wss?):\/\/(?!localhost)/, (route) => { external.push(route.request().url()); return route.abort(); });
  await page.goto('./#/settings');
  await expect(page.locator('[data-screen="settings"]')).toHaveAttribute('data-loaded', 'yes');
});
test.afterEach(() => {
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
});

const field = (page, name) => page.locator(`[data-screen="settings"] [data-field="${name}"]`);
const saved = (page) => page.evaluate(async () => (await (await import('./src/db.js')).getSettings()).monthlyBudgetUSD);
const storedKey = (page) => page.evaluate(async () => (await import('./src/db.js')).getApiKey());

test.describe('T053-D1: the threshold accepts a decimal comma and a point, refuses the rest', () => {
  test('the field is a decimal text field, not type=number', async ({ page }) => {
    const budget = field(page, 'budget');
    await expect(budget).toHaveAttribute('type', 'text');
    await expect(budget).toHaveAttribute('inputmode', 'decimal');
    await expect(page.getByLabel('Праг за разход')).toHaveAttribute('data-field', 'budget');
    await expect(budget).toHaveValue('5');
  });

  test('typed on the keyboard: comma and point are the same; the old value stays after every refusal', async ({ page }) => {
    const budget = field(page, 'budget');
    const msg = field(page, 'budget-message');
    const type = async (text) => { await budget.fill(''); await budget.pressSequentially(text); await budget.press('Tab'); };
    const cases = [
      ['2,5', 'Запазено.', '2.5', 2.5],
      ['3.75', 'Запазено.', '3.75', 3.75],
      ['0,5', 'Запазено.', '0.5', 0.5],
      ['10,00', 'Запазено.', '10', 10],
      ['2,257', 'Запазено като 2.26 (закръглено до цент).', '2.26', 2.26],
      ['1,2,3', FORMAT, '2.26', 2.26],
      ['1.000,5', FORMAT, '2.26', 2.26],
      ['1,000.5', FORMAT, '2.26', 2.26],
      ['1 000', FORMAT, '2.26', 2.26],
      ['1 000', FORMAT, '2.26', 2.26],
      ['1\'000', FORMAT, '2.26', 2.26],
      ['2,5abc', FORMAT, '2.26', 2.26],
      ['abc', FORMAT, '2.26', 2.26],
      ['2,', FORMAT, '2.26', 2.26],
      [',5', FORMAT, '2.26', 2.26],
      ['2..5', FORMAT, '2.26', 2.26],
      ['1e3', FORMAT, '2.26', 2.26],
      ['+2', FORMAT, '2.26', 2.26],
      ['$5', FORMAT, '2.26', 2.26],
      ['５', FORMAT, '2.26', 2.26], // a full-width digit
      ['-1', RANGE, '2.26', 2.26],
      ['-0,5', RANGE, '2.26', 2.26],
      ['1000,01', RANGE, '2.26', 2.26],
      ['1000', 'Запазено.', '1000', 1000],
      ['0', 'Запазено.', '0', 0],
      ['0,004', 'Най-малкият праг е 0.01 (0 значи без предупреждение).', '0', 0],
    ];
    for (const [text, m, shown, value] of cases) {
      await type(text);
      await expect(msg, text).toHaveText(m);
      await expect(budget, text).toHaveValue(shown);
      expect(await saved(page), text).toBe(value);
      if (m === FORMAT || m === RANGE || m.startsWith('Най-малкият')) await expect(budget, text).toHaveAttribute('aria-invalid', 'true');
      else await expect(budget, text).not.toHaveAttribute('aria-invalid', /./);
    }
  });

  test('spaces and invisible characters around the value are dropped; the value survives a reload', async ({ page }) => {
    const budget = field(page, 'budget');
    for (const v of [' 2,5 ', '\t2,5\n', '​2,5 ', '﻿2.5⁠']) {
      await budget.evaluate((el, x) => { el.value = x; el.dispatchEvent(new Event('change', { bubbles: true })); }, v);
      await expect(field(page, 'budget-message'), JSON.stringify(v)).toHaveText('Запазено.');
      expect(await saved(page)).toBe(2.5);
      await budget.evaluate((el) => { el.value = '1'; el.dispatchEvent(new Event('change', { bubbles: true })); });
    }
    await budget.fill('7,25');
    await budget.press('Enter'); // Enter saves too
    await expect.poll(() => saved(page)).toBe(7.25);
    await expect(field(page, 'budget-message')).toHaveText('Запазено.');
    await page.reload();
    await expect(page.locator('[data-screen="settings"]')).toHaveAttribute('data-loaded', 'yes');
    await expect(field(page, 'budget')).toHaveValue('7.25');
  });

  test('the arrows step by a cent and save; never below 0 or above 1000', async ({ page }) => {
    const budget = field(page, 'budget');
    await budget.fill('0,01');
    await budget.press('Tab');
    await budget.focus();
    await budget.press('ArrowDown');
    await budget.press('ArrowDown');
    await expect(budget).toHaveValue('0');
    expect(await saved(page)).toBe(0);
    await budget.press('ArrowUp');
    await expect(budget).toHaveValue('0.01');
    expect(await saved(page)).toBe(0.01);
    await budget.fill('1000');
    await budget.press('ArrowUp');
    await expect(budget).toHaveValue('1000');
    expect(await saved(page)).toBe(1000);
  });
});

test.describe('T053-I3: invisible characters around the key', () => {
  test('dropped around the key like spaces; refused inside', async ({ page }) => {
    for (const [pre, post] of [['​', ''], ['', '​'], ['‌', '‍'], ['⁠', '⁠'], ['᠎', '­'], ['﻿​', '​ \r\n']]) {
      await page.evaluate(async () => (await import('./src/db.js')).deleteApiKey());
      await field(page, 'api-key').fill(`${pre}${KEY}${post}`);
      await field(page, 'key-save').click();
      await expect(field(page, 'key-message'), JSON.stringify(pre + post)).toHaveText(/^Ключът е запазен/);
      expect(await storedKey(page)).toBe(KEY);
    }
    await page.evaluate(async () => (await import('./src/db.js')).deleteApiKey());
    for (const c of ['​', '‌', '‍', '⁠', '᠎', '­', '﻿']) {
      await field(page, 'api-key').fill(`sk-ant-test-FAKE-${c}t054-91b2`);
      await field(page, 'key-save').click();
      await expect(field(page, 'key-message')).toHaveText('Ключът съдържа непозволени знаци — копирай го наново от Claude Console.');
    }
    expect(await storedKey(page)).toBeFalsy();
  });
});
