const express = require("express");
const puppeteer = require("puppeteer");
const cors = require("cors");

const app = express();
app.use(cors());

app.get("/", (req, res) => {
  res.json({ status: "Scraper API is running!" });
});

app.get("/scrape", async (req, res) => {
  const query = req.query.q;
  const limit = parseInt(req.query.limit) || 10;
  const skip = parseInt(req.query.skip) || 0;

  if (!query) {
    return res.status(400).json({ error: "Please provide a query parameter 'q'" });
  }

  console.log(`[SCRAPE] Query: "${query}" | Limit: ${limit} | Skip: ${skip}`);

  let browser;
  try {
    // ===== LAUNCH CHROME - as close to local as possible =====
    browser = await puppeteer.launch({
      headless: "new",          // NEW headless = behaves exactly like real Chrome (not old headless)
      defaultViewport: null,    // Same as local script
      args: [
        "--no-sandbox",         // Required on Linux/Render
        "--disable-setuid-sandbox",
        "--window-size=1920,1080"
      ]
    });

    const page = await browser.newPage();

    // ===== EXACT SAME FLOW AS YOUR LOCAL scrappper.js =====

    console.log("[SCRAPE] Opening Maps...");
    await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(query)}`, {
      waitUntil: "networkidle2",
      timeout: 120000   // 2 min timeout (Render is slow, but let it finish)
    });

    // Handle consent if it shows up
    try {
      for (const sel of ['button[aria-label="Accept all"]', 'button[aria-label="Reject all"]']) {
        const btn = await page.$(sel);
        if (btn) { await btn.click(); await new Promise(r => setTimeout(r, 3000)); break; }
      }
    } catch (e) {}

    await page.waitForSelector('div[role="feed"]', { timeout: 30000 });

    const processed = new Set();
    const results = [];
    let sameCount = 0;
    let collected = 0;   // Track how many we've collected (for skip/limit)
    let skipped = 0;     // Track how many we've skipped

    while (true) {
      // Get visible listings - FRESH handles each loop iteration
      const listings = await page.$$("div.Nv2PK");

      console.log("[SCRAPE] Visible listings:", listings.length);

      let newDataFound = false;

      for (let i = 0; i < listings.length; i++) {
        if (collected >= limit) break;  // Stop when we have enough

        try {
          // Get unique name from list (SAME as your local script)
          const name = await listings[i].evaluate(el =>
            el.innerText.split("\n")[0]
          );

          if (processed.has(name)) continue;

          processed.add(name);
          newDataFound = true;

          // Handle skip
          if (skipped < skip) {
            skipped++;
            console.log(`[SCRAPE] Skipping: ${name} (${skipped}/${skip})`);
            continue;
          }

          console.log(`[SCRAPE] [${collected + 1}/${limit}] Processing: ${name}`);

          // Scroll into view (SAME as your local script)
          await listings[i].evaluate(el =>
            el.scrollIntoView({ block: "center" })
          );

          await new Promise(r => setTimeout(r, 1000));

          // Click (SAME as your local script - uses Puppeteer's real click)
          await listings[i].click();

          await page.waitForSelector("h1", { timeout: 10000 });

          await new Promise(r => setTimeout(r, 2000));

          // Extract data (SAME selectors as your local script)
          const data = await page.evaluate(() => {
            const clean = (text) =>
              text.replace(/[^\x20-\x7E]/g, "").trim();

            const getText = (selector) =>
              clean(document.querySelector(selector)?.innerText || "");

            const getHref = (selector) =>
              document.querySelector(selector)?.href || "";

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

          console.log(`[SCRAPE] ✅ ${data.name} | ${data.rating} | 📞${data.phone}`);

          results.push(data);
          collected++;

          // Go back (SAME as your local script)
          await page.goBack();
          await page.waitForSelector('div[role="feed"]', { timeout: 15000 });

          await new Promise(r => setTimeout(r, 2000));

        } catch (err) {
          console.log("[SCRAPE] Error:", err.message);
          // Try to recover - go back to feed
          try {
            await page.goBack().catch(() => {});
            await page.waitForSelector('div[role="feed"]', { timeout: 10000 }).catch(() => {});
            await new Promise(r => setTimeout(r, 2000));
          } catch (e) {}
        }
      }

      if (collected >= limit) break;

      // Scroll SMALL step (SAME as your local script)
      await page.evaluate(() => {
        const feed = document.querySelector('div[role="feed"]');
        if (feed) feed.scrollBy(0, 500);
      });

      await new Promise(r => setTimeout(r, 2000));

      // Stop condition (SAME as your local script)
      if (!newDataFound) {
        sameCount++;
      } else {
        sameCount = 0;
      }

      if (sameCount >= 3) {
        console.log("[SCRAPE] No new data found, stopping...");
        break;
      }
    }

    console.log(`[SCRAPE] DONE! Collected ${results.length} results.`);
    await browser.close();
    res.json(results);

  } catch (error) {
    console.error("[SCRAPE] Fatal error:", error.message);
    if (browser) await browser.close();
    res.status(500).json({ error: "Scraping failed", details: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
