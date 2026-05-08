const express = require("express");
const puppeteer = require("puppeteer");
const cors = require("cors");

const app = express();
app.use(cors());

app.get("/", (req, res) => {
  res.json({ status: "Scraper API is running!" });
});

// ===== Helper: Extract data from a place detail page =====
async function extractPlaceData(page) {
  const data = await page.evaluate(() => {
    const clean = (text) => text.replace(/[^\x20-\x7E]/g, "").trim();
    const getText = (sel) => clean(document.querySelector(sel)?.innerText || "");
    const getHref = (sel) => document.querySelector(sel)?.href || "";

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
  return data;
}

// ===== Helper: Visit a place URL and extract data (with 1 retry) =====
async function visitAndExtract(page, listing) {
  // Try up to 2 times
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await page.goto(listing.url, { waitUntil: "domcontentloaded", timeout: 45000 });

      // Wait for the info section (phone/address/website buttons)
      // This is the signal that the page is actually ready
      await page.waitForFunction(() => {
        const btns = document.querySelectorAll('button[data-item-id], a[data-item-id]');
        return btns.length > 0;
      }, { timeout: 20000 });

      // Small buffer
      await new Promise(r => setTimeout(r, 800));

      const data = await extractPlaceData(page);

      // Verify we got real data (not "Results" or empty)
      if (data.name && data.name !== 'Results' && data.name !== 'Sponsored') {
        return data;
      }

      // If name is wrong, wait a bit more and retry extraction
      await new Promise(r => setTimeout(r, 3000));
      const data2 = await extractPlaceData(page);
      if (data2.name && data2.name !== 'Results') return data2;

      // Use what we have
      return data;

    } catch (err) {
      if (attempt === 1) {
        console.log(`[SCRAPE] Attempt 1 failed, retrying: ${listing.name}`);
        continue; // Retry
      }
      throw err; // Give up after 2 attempts
    }
  }
}

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
    browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--window-size=1920,1080"
      ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    // Real Chrome user agent to avoid detection
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36");

    // Block ONLY images and media (keep CSS + JS + fonts — Maps needs them!)
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (['image', 'media'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    // ===== STEP 1: Load the search results page =====
    console.log("[SCRAPE] Opening Maps...");
    await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(query)}?hl=en`, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await new Promise(r => setTimeout(r, 8000));

    // Handle consent
    try {
      for (const sel of ['button[aria-label="Accept all"]', 'button[aria-label="Reject all"]']) {
        const btn = await page.$(sel);
        if (btn) { await btn.click(); await new Promise(r => setTimeout(r, 3000)); break; }
      }
    } catch (e) { }

    // Wait for listings
    try {
      await page.waitForFunction(() => document.querySelectorAll('a.hfpxzc').length > 0, { timeout: 60000 });
      console.log("[SCRAPE] Listings found!");
    } catch (e) {
      throw new Error(`No listings found. Page: "${await page.title()}"`);
    }

    // ===== STEP 2: Scroll to load enough listings =====
    const totalNeeded = skip + limit;
    let prev = 0, noNew = 0;
    while (noNew < 5) {
      const count = await page.evaluate(() => document.querySelectorAll('a.hfpxzc').length);
      console.log(`[SCRAPE] Loaded ${count} listings`);
      if (count >= totalNeeded) break;
      if (count === prev) noNew++; else noNew = 0;
      prev = count;
      await page.evaluate(() => { const f = document.querySelector('div[role="feed"]'); if (f) f.scrollBy(0, 800); });
      await new Promise(r => setTimeout(r, 2000));
    }

    // ===== STEP 3: Collect listing URLs =====
    const allListings = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a.hfpxzc')).map(link => ({
        name: link.getAttribute('aria-label') || '',
        url: link.getAttribute('href') || ''
      })).filter(x => x.name && x.url);
    });

    console.log(`[SCRAPE] Found ${allListings.length} listings`);

    // ===== STEP 4: Visit each place URL and extract data =====
    const start = skip;
    const end = Math.min(skip + limit, allListings.length);
    const results = [];

    for (let i = start; i < end; i++) {
      const listing = allListings[i];
      console.log(`[SCRAPE] [${results.length + 1}/${end - start}] ${listing.name}`);

      try {
        const data = await visitAndExtract(page, listing);
        results.push(data);
        console.log(`[SCRAPE] ✅ ${data.name} | ${data.rating} | 📞${data.phone}`);
      } catch (err) {
        console.log(`[SCRAPE] ⏭️ Skipped: ${listing.name}`);
        results.push({
          name: listing.name, rating: '', reviews: '', phone: '',
          website: '', address: '', google_link: listing.url
        });
      }
    }

    console.log(`[SCRAPE] DONE! ${results.length} results`);
    await browser.close();
    res.json(results);

  } catch (error) {
    console.error("[SCRAPE] Fatal:", error.message);
    if (browser) await browser.close();
    res.status(500).json({ error: "Scraping failed", details: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
