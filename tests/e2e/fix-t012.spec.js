// T-012 (tester): independent check of T-054 (0.7.2) — the cost threshold is a
// decimal text field parsed by the app, invisible characters around the key are
// dropped. Complements tests/e2e/fix-t054.spec.js (developer) with what it does
// not cover: other digit systems, the ambiguous "1.000", leading zeros, very
// long numbers, Enter followed by Tab, arrows on an unsaved or refused value,
// invisible characters inside the value, bidi marks around the key.
// Only FAKE keys; every external request is aborted (api.anthropic.com is never reached).
import { test, expect } from '@playwright/test';

const KEY = 'sk-ant-test-FAKE-t012-7c41';
const RANGE = 'Прагът е число от 0 до 1000.';
const FORMAT = 'Прагът не е число. Пиши само цифри и един десетичен знак (запетая или точка), напр. 2,5 — без букви, интервали и разделител за хилядите.';
const SAVED = 'Запазено.';

let external;
let errors;
test.beforeEach(async ({ page, context }) => {
  external = [];
  errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
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

/** Set a known saved value first (so every case below starts from it and the message changes). */
async function base(page, value = '4') {
  const budget = field(page, 'budget');
  // Twice (another value first): an unchanged field fires no "change", so the message would stay.
  for (const v of [`${value}1`, value]) {
    await budget.fill(v);
    await budget.press('Tab');
    await expect.poll(() => saved(page)).toBe(Number(v));
    await expect(field(page, 'budget-message')).toHaveText(SAVED);
    await expect(budget).toHaveValue(v);
  }
}

test.describe('T-012 / T-054 the threshold field', () => {
  test('matrix typed on the keyboard: other digit systems, "1.000", leading zeros, long numbers, invisible characters inside', async ({ page }) => {
    const budget = field(page, 'budget');
    const msg = field(page, 'budget-message');
    const cases = [
      // [typed, message, shown afterwards, saved]
      ['2.5', SAVED, '2.5', 2.5],
      ['2,5', SAVED, '2.5', 2.5],
      // T012-I1 (information): "1.000" and "1,000" are ONE (a decimal separator), not a thousand.
      ['1.000', SAVED, '1', 1],
      ['1,000', SAVED, '1', 1],
      ['007', SAVED, '7', 7],
      ['007,50', SAVED, '7.5', 7.5],
      ['1 000', FORMAT, '4', 4],
      ['1e3', FORMAT, '4', 4],
      [',5', FORMAT, '4', 4],
      ['5,', FORMAT, '4', 4],
      ['.5', FORMAT, '4', 4],
      ['5.', FORMAT, '4', 4],
      ['-1', RANGE, '4', 4],
      ['−1', FORMAT, '4', 4], // U+2212 minus sign: not "-"
      ['٢٫٥', FORMAT, '4', 4], // Arabic-Indic digits and decimal separator
      ['١', FORMAT, '4', 4],
      ['२', FORMAT, '4', 4], // Devanagari
      ['𝟐', FORMAT, '4', 4], // mathematical bold digit (outside the BMP)
      ['2​,5', FORMAT, '4', 4], // invisible characters INSIDE are refused
      ['2,­5', FORMAT, '4', 4],
      ['0x10', FORMAT, '4', 4],
      ['Infinity', FORMAT, '4', 4],
      ['NaN', FORMAT, '4', 4],
      ['1234567890123', FORMAT, '4', 4], // more than 12 digits: a format refusal (fine, above the range anyway)
      ['0000000000005', FORMAT, '4', 4], // T012-I2 (information): 13 digits with leading zeros is refused although it is 5
      ['1000,000000000001', RANGE, '4', 4],
      ['999,999', 'Запазено като 1000 (закръглено до цент).', '1000', 1000],
    ];
    for (const [text, m, shown, value] of cases) {
      await base(page);
      await budget.fill('');
      await budget.pressSequentially(text);
      await budget.press('Tab');
      await expect(msg, JSON.stringify(text)).toHaveText(m);
      await expect(budget, JSON.stringify(text)).toHaveValue(shown);
      expect(await saved(page), JSON.stringify(text)).toBe(value);
      if (m === FORMAT || m === RANGE) await expect(budget, text).toHaveAttribute('aria-invalid', 'true');
      else await expect(budget, text).not.toHaveAttribute('aria-invalid', /./);
    }
  });

  test('empty: refused with the range message, the old value comes back; the message is tied to the field', async ({ page }) => {
    const budget = field(page, 'budget');
    await base(page, '3.5');
    await budget.fill('');
    await budget.press('Tab');
    await expect(field(page, 'budget-message')).toHaveText(RANGE);
    await expect(budget).toHaveValue('3.5');
    expect(await saved(page)).toBe(3.5);
    // aria-describedby names elements that exist; one of them is the message.
    const described = await budget.evaluate((el) => el.getAttribute('aria-describedby').split(/\s+/).map((id) => [id, !!document.getElementById(id)]));
    expect(described.every(([, ok]) => ok)).toBe(true);
    expect(described.map(([id]) => id)).toContain('settings-budget-message');
  });

  test('Enter on a refused value, then Tab: the refusal stays (no second, silent "Запазено."); Enter on a good value, then Tab: saved once', async ({ page }) => {
    const budget = field(page, 'budget');
    const msg = field(page, 'budget-message');
    await base(page);
    await budget.fill('abc');
    await budget.press('Enter');
    await expect(msg).toHaveText(FORMAT);
    await budget.press('Tab');
    await page.waitForTimeout(300);
    await expect(msg).toHaveText(FORMAT);
    await expect(budget).toHaveAttribute('aria-invalid', 'true');
    expect(await saved(page)).toBe(4);
    await budget.fill('6,5');
    await budget.press('Enter');
    await expect(msg).toHaveText(SAVED);
    await expect(budget).toHaveValue('6.5');
    await budget.press('Tab');
    await expect(budget).not.toHaveAttribute('aria-invalid', /./);
    expect(await saved(page)).toBe(6.5);
  });

  test('arrows: on a typed but unsaved "2,5" they step from 2.5; on a refused text from the saved value; field and store agree after a held key', async ({ page }) => {
    const budget = field(page, 'budget');
    await base(page);
    await budget.fill('2,5');
    await budget.press('ArrowUp');
    await expect(budget).toHaveValue('2.51');
    await expect.poll(() => saved(page)).toBe(2.51);
    await budget.fill('abc');
    await budget.press('ArrowDown');
    await expect(budget).toHaveValue('2.5');
    await expect.poll(() => saved(page)).toBe(2.5);
    // 30 presses in a row (a held key): what the field shows is what is stored (steps may be lost: T012-D4).
    for (let i = 0; i < 30; i++) await budget.press('ArrowUp');
    await page.waitForTimeout(500);
    const shown = Number(await budget.inputValue());
    expect(await saved(page)).toBe(shown);
    expect(shown).toBeGreaterThan(2.5);
    expect(shown).toBeLessThanOrEqual(2.8);
    console.log(`T012-D4 30 × ArrowUp from 2.5 → ${shown} (expected 2.8)`);
  });

  test('T012-D4: an arrow pressed while an earlier step is still being saved is lost (the late save writes the older value into the field)', async ({ page }) => {
    test.fail(true, 'T012-D4: commitBudget() sets the field from the result of ITS save; a slower earlier save overwrites a newer step, and the next arrow steps from that older value');
    const budget = field(page, 'budget');
    await base(page, '2.5');
    // Deterministic: two presses at once (two saves in flight), then a third press exactly when
    // the first save has written its value back into the field (a user pressing between two saves).
    const final = await budget.evaluate(async (el) => {
      const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      let armed = false;
      const press = () => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
      Object.defineProperty(el, 'value', {
        configurable: true,
        get() { return proto.get.call(this); },
        set(v) {
          proto.set.call(this, v);
          if (armed && v === '2.51') { armed = false; queueMicrotask(press); }
        },
      });
      press();
      press();
      armed = true;
      await new Promise((r) => setTimeout(r, 1000));
      return el.value;
    });
    console.log(`T012-D4 three presses from 2.5 → field ${final}, stored ${await saved(page)}`);
    expect(await saved(page)).toBe(Number(final));
    expect(final).toBe('2.53'); // three presses from 2.5
  });

  test('a value typed with a comma survives a reload (shown with a point) and the other screens see it', async ({ page }) => {
    const budget = field(page, 'budget');
    await budget.fill('12,34');
    await budget.press('Enter');
    await expect(field(page, 'budget-message')).toHaveText(SAVED);
    await page.reload();
    await expect(page.locator('[data-screen="settings"]')).toHaveAttribute('data-loaded', 'yes');
    await expect(budget).toHaveValue('12.34');
    expect(await saved(page)).toBe(12.34);
  });
});

test.describe('T-012 / T-054 invisible characters around the key', () => {
  test('around: dropped (also mixed with spaces and line breaks); inside: refused; nothing is echoed', async ({ page }) => {
    for (const [pre, post] of [['​​', ''], ['', '­­'], [' ⁠\n', '‍\t'], ['᠎', '﻿']]) {
      await page.evaluate(async () => (await import('./src/db.js')).deleteApiKey());
      await field(page, 'api-key').fill(`${pre}${KEY}${post}`);
      await field(page, 'key-save').click();
      await expect(field(page, 'key-message'), JSON.stringify(pre + post)).toHaveText(/^Ключът е запазен/);
      expect(await storedKey(page)).toBe(KEY);
      await expect(page.locator('[data-screen="settings"]')).not.toContainText(KEY);
    }
    await page.evaluate(async () => (await import('./src/db.js')).deleteApiKey());
    for (const c of ['​', '­', '﻿', ' ', ' ', '‎']) {
      await field(page, 'api-key').fill(`sk-ant-test-FAKE-${c}t012-7c41`);
      await field(page, 'key-save').click();
      await expect(field(page, 'key-message'), JSON.stringify(c)).toHaveText('Ключът съдържа непозволени знаци — копирай го наново от Claude Console.');
    }
    expect(await storedKey(page)).toBeFalsy();
  });

  test('T012-I3 (information): bidi marks U+200E/U+200F and invisible operators U+2061–U+2064 around the key are NOT dropped — refused', async ({ page }) => {
    // Not a defect of T-054 (its list was U+200B–D, U+2060, U+180E, U+00AD), but a key copied
    // from a page with mixed text direction may carry U+200E/U+200F; the user then gets a refusal.
    const out = [];
    for (const [pre, post] of [['‎', ''], ['', '‏'], ['⁢', ''], ['', '⁤']]) {
      await field(page, 'api-key').fill(`${pre}${KEY}${post}`);
      await field(page, 'key-save').click();
      await expect(field(page, 'key-message')).not.toHaveText('');
      out.push([JSON.stringify(pre + post), await field(page, 'key-message').textContent()]);
      expect(await storedKey(page)).toBeFalsy();
    }
    console.log(`T012-I3 ${JSON.stringify(out)}`);
    // A leading mark gets the "starts with sk-ant-" message, a trailing one "непозволени знаци": both refusals.
    for (const [, m] of out) expect(m).toMatch(/започва със|непозволени знаци/);
  });
});
