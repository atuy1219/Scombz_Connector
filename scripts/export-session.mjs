// Runs only on the user's computer. Credentials never reach the Worker.
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
const output = process.argv[2] ?? '.private/session.json';
const browser = await chromium.launch({ headless: false });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('https://scombz.shibaura-it.ac.jp/portal/home');
  console.log(
    '開いたブラウザでScombZにログインしてください（MFAを含む）。ホーム表示後に自動保存します。',
  );
  await page.waitForURL(
    (u) => u.origin === 'https://scombz.shibaura-it.ac.jp' && u.pathname === '/portal/home',
    { timeout: 300000 },
  );
  await page.locator('#page_head').waitFor({ timeout: 300000 });
  const cookies = (await context.cookies()).filter(
    (c) => c.domain.replace(/^\./, '') === 'scombz.shibaura-it.ac.jp',
  );
  if (!cookies.some((c) => c.name === 'SESSION'))
    throw new Error('ScombZのSESSION Cookieがありません。');
  const { dirname } = await import('node:path');
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify({ cookies, origins: [] }), { mode: 0o600 });
  console.log('保存しました: ' + output);
} finally {
  await browser.close();
}
