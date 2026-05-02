const express = require("express");
const puppeteer = require("puppeteer-core");
const chromium = require("@sparticuz/chromium");
const cors = require("cors");

const app = express();
app.use(cors());

// Health check endpoint (for Render)
app.get("/", (req, res) => {
  res.send("Scraper API is running!");
});

app.get("/scrape", async (req, res) => {
  const query = req.query.q;
  const limit = parseInt(req.query.limit) || 10;
  const skip = parseInt(req.query.skip) || 0;
  
  if (!query) {
    return res.status(400).json({ error: "Please provide a query parameter 'q'" });
  }

  console.log(`Starting scrape for: ${query} (limit: ${limit}, skip: ${skip})`);
  
  let browser;
  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: { width: 1920, height: 1080 },
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });

    const page = await browser.newPage();
    
    // Set a timeout for the navigation. Use domcontentloaded because Maps is too heavy for networkidle2 on free tier
    await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(query)}`, {
      waitUntil: "domcontentloaded",
      timeout: 60000 // 60 seconds
    });

    // Accept Google's cookie consent if it appears (common on serverless IPs)
    try {
      const consentButton = await page.$('button[aria-label="Accept all"]');
      if (consentButton) {
        await consentButton.click();
        await new Promise(r => setTimeout(r, 2000));
      }
    } catch (e) {}

    // Wait longer for the search results to appear since Render is slow
    try {
      await page.waitForSelector('div[role="feed"]', { timeout: 45000 });
    } catch (err) {
      const pageTitle = await page.title();
      throw new Error(`Could not find the results list. Page Title was: "${pageTitle}". Make sure your search query is broad enough to return a list, not just a single place. If it's a captcha, Google blocked the server IP.`);
    }

    const processed = new Set();
    const results = [];
    let sameCount = 0;

    // Modified scraping loop to respect limit and reduce timeout risk
    while (results.length < limit) {
      const listings = await page.$$("div.Nv2PK");
      let newDataFound = false;

      for (let i = 0; i < listings.length; i++) {
        if (results.length >= limit) break;

        try {
          const name = await listings[i].evaluate(el => el.innerText.split("\n")[0]);

          if (processed.has(name)) continue;

          processed.add(name);
          newDataFound = true;
          
          // FAST FORWARD: If we haven't reached the 'skip' amount, don't click, just scroll past it!
          if (processed.size <= skip) {
             console.log(`Skipping: ${name} (Fast forwarding to ${skip})`);
             continue;
          }

          console.log("Processing:", name);

          await listings[i].evaluate(el => el.scrollIntoView({ block: "center" }));
          await new Promise(r => setTimeout(r, 800));

          await listings[i].click();
          await page.waitForSelector("h1", { timeout: 5000 });
          await new Promise(r => setTimeout(r, 1000));

          const data = await page.evaluate(() => {
            const clean = (text) => text ? text.replace(/[^\x20-\x7E]/g, "").trim() : "";
            const getText = (selector) => clean(document.querySelector(selector)?.innerText || "");
            const getHref = (selector) => document.querySelector(selector)?.href || "";

            return {
              name: getText("h1"),
              rating: getText('div[role="img"]'),
              reviews: getText(".F7nice"),
              address: getText('button[data-item-id="address"]'),
              phone: getText('button[data-item-id*="phone"]'),
              website: getHref('a[data-item-id="authority"]'),
              google_link: window.location.href
            };
          });

          results.push(data);

          await page.goBack();
          await page.waitForSelector('div[role="feed"]', { timeout: 5000 });
          await new Promise(r => setTimeout(r, 1000));
        } catch (err) {
          console.log("Error processing item:", err.message);
          try {
             await page.goBack();
             await page.waitForSelector('div[role="feed"]', { timeout: 5000 });
          } catch(e) {}
        }
      }

      await page.evaluate(() => {
        const feed = document.querySelector('div[role="feed"]');
        if (feed) feed.scrollBy(0, 500);
      });

      await new Promise(r => setTimeout(r, 1500));

      if (!newDataFound) {
        sameCount++;
      } else {
        sameCount = 0;
      }

      if (sameCount >= 3) break;
    }

    console.log(`Scrape finished. Found ${results.length} items.`);
    await browser.close();
    res.json(results);

  } catch (error) {
    console.error("Scraping failed:", error);
    if (browser) await browser.close();
    res.status(500).json({ error: "Scraping failed", details: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
