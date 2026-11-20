// Run by a test with PLAYWRIGHT_BROWSERS_PATH pointing at an empty folder: there is no Chromium to start.
import { createRenderer } from '../../src/index.ts';

const renderer = createRenderer();
const attempts = [];
for (let attempt = 0; attempt < 2; attempt += 1) {
  try {
    await renderer.render('<p>x</p>');
    attempts.push({ ok: true });
  } catch (error) {
    const { name, code, message } = error as Error & { code?: string };
    attempts.push({ name, code, message });
  }
}
await renderer.close();
console.log(JSON.stringify(attempts));
