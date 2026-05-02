const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
(async () => {
  const browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
  });
  const page = await browser.newPage();
  await page.goto('https://www.google.com/maps/search/dental+clinic+sector+15+noida');
  try {
    await page.waitForSelector('div[role="feed"]', { timeout: 10000 });
    console.log('Feed found!');
  } catch(e) {
    console.log('Feed not found. Title:', await page.title());
    await page.screenshot({path: 'debug.png'});
    console.log('Saved debug.png');
  }
  await browser.close();
})();
