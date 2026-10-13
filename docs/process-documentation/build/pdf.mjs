import { createRequire } from 'node:module';
// Playwright comes from the repo's own dev dependencies.
const require = createRequire(new URL('../../../package.json', import.meta.url));
const { chromium } = require('playwright');
import { pathToFileURL } from 'node:url';
const [file, outPdf, title] = process.argv.slice(2);
const b = await chromium.launch();
const p = await b.newPage({ colorScheme: 'light' });
await p.goto(pathToFileURL(file).href, { waitUntil: 'networkidle' });
await p.emulateMedia({ media: 'print', colorScheme: 'light' });
await p.evaluate(() => document.fonts.ready);
await p.pdf({ path: outPdf, format: 'A4', printBackground: true, displayHeaderFooter: true,
  headerTemplate: `<div style="font:8px Inter,Arial;color:#777;width:100%;padding:0 12mm;">${title}</div>`,
  footerTemplate: '<div style="font:8px Inter,Arial;color:#777;width:100%;text-align:right;padding:0 12mm;"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
  margin: { top: '16mm', bottom: '16mm', left: '12mm', right: '12mm' } });
await b.close(); console.log('pdf ok');
