import { expect, type Page, test } from '@playwright/test';
import { BASIC, load } from './helpers';

// The messaging entry (`./messaging`) is opt-in. Polyfill only: the native
// projects don't run this file.

/** Draws BASIC, then posts an image of #a through a MessageChannel and reports what arrives. */
async function roundTrip(page: Page): Promise<{ sent: string | null; arrived: boolean; sourceOpen: boolean }> {
  return page.evaluate(async (html) => {
    document.body.innerHTML = html;
    const c = document.getElementById('c') as HTMLCanvasElement;
    await new Promise((r) => c.addEventListener('paint', r, { once: true }));
    const image = c.captureElementImage(document.getElementById('a')!);
    const { port1, port2 } = new MessageChannel();
    const received = new Promise<unknown>((resolve) => (port2.onmessage = (e) => resolve(e.data)));
    let sent: string | null = null;
    try {
      port1.postMessage({ image }, [image as unknown as Transferable]);
    } catch (e) {
      sent = (e as Error).name;
    }
    const data = sent ? null : ((await received) as { image: unknown });
    const Image = (window as unknown as { ElementImage: abstract new () => object }).ElementImage;
    return { sent, arrived: data?.image instanceof Image, sourceOpen: image.width > 0 };
  }, BASIC);
}

test('without the messaging entry, transferring an ElementImage throws DataCloneError', async ({ page }) => {
  await load(page, false);
  expect(await roundTrip(page)).toEqual({ sent: 'DataCloneError', arrived: false, sourceOpen: true });
  const cloned = await page.evaluate(() => {
    const c = document.getElementById('c') as HTMLCanvasElement;
    const image = c.captureElementImage(document.getElementById('a')!);
    try {
      structuredClone(image, { transfer: [image as unknown as Transferable] });
      return null;
    } catch (e) {
      return (e as Error).name;
    }
  });
  expect(cloned).toBe('DataCloneError');
});

test('the messaging entry imported before install transfers ElementImages', async ({ page }) => {
  await load(page, false, 'messaging');
  expect(await roundTrip(page)).toEqual({ sent: null, arrived: true, sourceOpen: false });
});

test('the messaging entry imported after install applies at once', async ({ page }) => {
  await load(page, false, 'messaging=late');
  expect(await roundTrip(page)).toEqual({ sent: null, arrived: true, sourceOpen: false });
});

test('uninstall removes the messaging wrappers, and install brings them back', async ({ page }) => {
  await load(page, false, 'messaging');
  const wrapped = await page.evaluate(() => {
    const own = () => Object.getOwnPropertyDescriptor(MessagePort.prototype, 'postMessage')!.value as unknown;
    const polyfill = (window as unknown as { __polyfill: { install(o: object): unknown; uninstall(): void } }).__polyfill;
    const before = own();
    polyfill.uninstall();
    const native = own();
    polyfill.install({ force: true });
    return { removed: native !== before, restored: own() !== native };
  });
  expect(wrapped).toEqual({ removed: true, restored: true });
  expect(await roundTrip(page)).toEqual({ sent: null, arrived: true, sourceOpen: false });
});

test('the script-tag build includes messaging', async ({ page }) => {
  await page.goto('/tests/browser/fixtures/iife.html');
  expect(await roundTrip(page)).toEqual({ sent: null, arrived: true, sourceOpen: false });
});
