import { test, expect } from '@playwright/test';

test('reports invalid target size before processing a row', async ({ page }) => {
    await page.goto('/');
    await page.locator('input[type="file"]').setInputFiles({
        name: 'validation.png',
        mimeType: 'image/png',
        buffer: Buffer.from('not a real image')
    });

    const target = page.getByLabel('Max Size:');
    await target.fill('0');
    await page.getByRole('button', { name: 'COMPRESS' }).click();

    const alert = page.getByRole('alert');
    await expect(alert).toContainText('positive finite');
    await expect(target).toHaveAttribute('aria-invalid', 'true');
    await expect(target).toHaveAttribute('aria-describedby', 'target-validation-error');
    await expect(target).not.toBeDisabled();
    await expect(page.getByText('validation.png')).toBeVisible();
    await expect(page.getByText('ERROR', { exact: true })).not.toBeVisible();
});

test('rejects zero and negative targets before any output attempt', async ({ page }) => {
    await page.goto('/');
    await page.locator('#file-input').setInputFiles({
        name: 'validation.png', mimeType: 'image/png', buffer: Buffer.from('not a real image')
    });
    const target = page.getByLabel('Max Size:');
    for (const value of ['0', '-1']) {
        await target.fill(value);
        await page.getByRole('button', { name: 'COMPRESS' }).click();
        await expect(page.getByRole('alert')).toContainText('positive finite');
        await expect(page.getByText('ERROR', { exact: true })).not.toBeVisible();
    }
});

test('keeps filenames and controls accessible at the narrow supported width', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto('/');
    const filename = 'a-very-long-filename-that-must-remain-readable-in-the-file-list.png';
    await page.locator('input[type="file"]').setInputFiles({
        name: filename,
        mimeType: 'image/png',
        buffer: Buffer.from('placeholder')
    });

    await expect(page.getByText(filename, { exact: true })).toBeVisible();
    await expect(page.getByText(/KB$/, { exact: false }).first()).toBeVisible();
    await expect(page.getByLabel('Max Size:')).toBeVisible();
    await expect(page.getByRole('button', { name: 'KB' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: 'MB' })).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByRole('button', { name: 'Upload more' })).toBeEnabled();

    const inputOutsideDropZone = await page.locator('#file-input').evaluate(input => input.parentElement.id !== 'drop-zone');
    expect(inputOutsideDropZone).toBe(true);
    expect(await page.locator('body').evaluate(body => body.scrollWidth <= window.innerWidth)).toBe(true);
});

test('supports keyboard upload controls and mobile-size target editing', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    const kb = page.getByRole('button', { name: 'KB' });
    await kb.focus();
    await expect(kb).toBeFocused();
    await page.keyboard.press('Space');
    await expect(kb).toHaveAttribute('aria-pressed', 'true');
    await page.getByLabel('Max Size:').fill('1');
    await expect(page.getByLabel('Max Size:')).toHaveValue('1');
    expect(await page.locator('body').evaluate(body => body.scrollWidth <= window.innerWidth)).toBe(true);
});
