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
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--single-process"]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    // Abort images, fonts, stylesheets to speed up loading
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (['image', 'font', 'media'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    // ===== STEP 1: Navigate to Google Maps search =====
    console.log("[SCRAPE] Navigating to Google Maps...");
    await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(query)}?hl=en`, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await new Promise(r => setTimeout(r, 8000));

    // Handle consent
    try {
      for (const sel of ['button[aria-label="Accept all"]', 'button[aria-label="Reject all"]', 'form[action*="consent"] button']) {
        const btn = await page.$(sel);
        if (btn) { await btn.click(); await new Promise(r => setTimeout(r, 3000)); break; }
      }
    } catch (e) {}

    // Wait for listings
    console.log("[SCRAPE] Waiting for listings...");
    try {
      await page.waitForFunction(() => {
        return document.querySelectorAll('a.hfpxzc').length > 0;
      }, { timeout: 60000 });
      console.log("[SCRAPE] Listings found!");
    } catch (err) {
      throw new Error(`No listings found. Page: "${await page.title()}"`);
    }

    // ===== STEP 2: Scroll to load enough listings =====
    const totalNeeded = skip + limit;
    let previousCount = 0;
    let noNewCount = 0;

    while (noNewCount < 5) {
      const currentCount = await page.evaluate(() => document.querySelectorAll('a.hfpxzc').length);
      console.log(`[SCRAPE] Loaded ${currentCount} listings...`);
      if (currentCount >= totalNeeded) break;
      if (currentCount === previousCount) noNewCount++;
      else noNewCount = 0;
      previousCount = currentCount;

      await page.evaluate(() => {
        const feed = document.querySelector('div[role="feed"]');
        if (feed) feed.scrollBy(0, 800);
      });
      await new Promise(r => setTimeout(r, 2000));
    }

    // ===== STEP 3: Collect listing names + URLs =====
    const allListings = await page.evaluate(() => {
      const links = document.querySelectorAll('a.hfpxzc');
      const results = [];
      links.forEach(link => {
        const name = link.getAttribute('aria-label') || '';
        const href = link.getAttribute('href') || '';
        if (name && href) results.push({ name, url: href });
      });
      return results;
    });

    console.log(`[SCRAPE] Found ${allListings.length} listings in feed`);

    // ===== STEP 4: Visit each place URL directly =====
    const startIndex = skip;
    const endIndex = Math.min(skip + limit, allListings.length);
    const finalResults = [];

    for (let i = startIndex; i < endIndex; i++) {
      const listing = allListings[i];
      if (!listing) continue;

      console.log(`[SCRAPE] [${finalResults.length + 1}/${limit}] Visiting: ${listing.name}`);

      try {
        // Navigate to the place URL with a SHORT timeout
        // If it doesn't load in 20s, we skip it fast instead of waiting 45s
        await page.goto(listing.url, {
          waitUntil: "domcontentloaded",
          timeout: 20000
        });

        // Wait for h1 (business name)
        await page.waitForFunction(() => {
          const h1 = document.querySelector('h1');
          return h1 && h1.innerText.trim().length > 0 && h1.innerText.trim() !== 'Results';
        }, { timeout: 8000 }).catch(() => {});

        // Wait for info section (phone/address/website buttons)
        await page.waitForFunction(() => {
          return document.querySelectorAll('button[data-item-id], a[data-item-id]').length > 0;
        }, { timeout: 8000 }).catch(() => {});

        await new Promise(r => setTimeout(r, 1000));

        // Extract data
        const data = await page.evaluate(() => {
          const clean = (text) => text ? text.replace(/[^\x20-\x7E]/g, "").trim() : "";

          const h1 = document.querySelector('h1');
          const name = h1 ? clean(h1.innerText) : '';

          // Rating
          let rating = '';
          const ratingSpan = document.querySelector('div.F7nice span[aria-hidden="true"]');
          if (ratingSpan) rating = clean(ratingSpan.innerText);
          if (!rating) {
            for (const s of document.querySelectorAll('span')) {
              if (/^\d\.\d$/.test(s.innerText.trim())) { rating = s.innerText.trim(); break; }
            }
          }

          // Reviews
          let reviews = '';
          const reviewBtn = document.querySelector('button[jsaction*="review"][aria-label]');
          if (reviewBtn) {
            const m = (reviewBtn.getAttribute('aria-label') || '').match(/([\d,]+)\s*review/i);
            if (m) reviews = m[1].replace(/,/g, '');
          }
          if (!reviews) {
            for (const el of document.querySelectorAll('div.F7nice span')) {
              const t = el.innerText.trim();
              if (/^\(?\d/.test(t) && !/^\d\.\d$/.test(t)) {
                reviews = t.replace(/[()]/g, '').trim(); break;
              }
            }
          }

          const phoneBtn = document.querySelector('button[data-item-id*="phone"]');
          const phone = phoneBtn ? clean(phoneBtn.innerText) : '';

          const websiteLink = document.querySelector('a[data-item-id="authority"]');
          const website = websiteLink ? websiteLink.href : '';

          const addressBtn = document.querySelector('button[data-item-id="address"]');
          const address = addressBtn ? clean(addressBtn.innerText) : '';

          return { name, rating, reviews, phone, website, address };
        });

        finalResults.push({
          name: data.name || listing.name,
          rating: data.rating || '',
          reviews: data.reviews || '',
          phone: data.phone || '',
          website: data.website || '',
          address: data.address || '',
          google_link: listing.url
        });

        console.log(`[SCRAPE] ✅ ${data.name} | ⭐${data.rating} | 📞${data.phone} | 🌐${data.website ? 'yes' : 'no'}`);

      } catch (err) {
        console.log(`[SCRAPE] ⏭️ Skipped ${listing.name} (${err.message.substring(0, 40)})`);
        // Add with whatever we have
        finalResults.push({
          name: listing.name, rating: '', reviews: '', phone: '',
          website: '', address: '', google_link: listing.url
        });
      }
    }

    console.log(`[SCRAPE] Done! Returning ${finalResults.length} results.`);
    await browser.close();
    res.json(finalResults);

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
