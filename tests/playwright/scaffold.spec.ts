import { expect, test } from '@playwright/test';

test('playwright scaffold is wired', async ({ page }) => {
  await page.setContent('<h1>QReader</h1>');
  await expect(page.getByRole('heading', { name: 'QReader' })).toBeVisible();
});
