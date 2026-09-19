import puppeteer from 'puppeteer';

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  
  await page.goto('http://localhost:5173/reels', { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 2000));
  
  const element = await page.$('#reelsFrame');
  if (element) {
    await element.screenshot({ path: '.stitch/element_4_reels_2d_viewport.png' });
    console.log('Saved #reelsFrame screenshot to .stitch/element_4_reels_2d_viewport.png');
  } else {
    console.log('Could not find #reelsFrame');
    await page.screenshot({ path: '.stitch/debug_reels_full.png' });
  }

  await browser.close();
})();
