const express = require("express");
const puppeteer = require("puppeteer");
const cors = require("cors");

const app = express();
app.use(cors());

// Health check
app.get("/", (req, res) => {
  res.json({ status: "Scraper API is running!" });
});

// Debug endpoint - screenshot of what server sees
app.get("/debug", async (req, res) => {
  const query = req.query.q || "restaurant near me";
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--single-process"]
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(query)}?hl=en`, {
      waitUntil: "domcontentloaded", timeout: 60000
    });
    await new Promise(r => setTimeout(r, 5000));

    const screenshot = await page.screenshot({ encoding: "base64", fullPage: false });
    const title = await page.title();
    const elements = await page.evaluate(() => ({
      hasFeed: !!document.querySelector('div[role="feed"]'),
      listingCount: document.querySelectorAll('div.Nv2PK').length,
      h1Text: document.querySelector('h1')?.innerText || 'none',
    }));

    await browser.close();
    res.json({ title, elements, screenshot: `data:image/png;base64,${screenshot}` });
  } catch (error) {
    if (browser) await browser.close();
    res.status(500).json({ error: error.message });
  }
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

    // ===== STEP 1: Navigate to Google Maps search =====
    console.log("[SCRAPE] Navigating to Google Maps...");
    await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(query)}?hl=en`, {
      waitUntil: "domcontentloaded", timeout: 60000
    });

    // Handle consent screen
    await new Promise(r => setTimeout(r, 3000));
    try {
      for (const sel of ['button[aria-label="Accept all"]', 'button[aria-label="Reject all"]', 'form[action*="consent"] button']) {
        const btn = await page.$(sel);
        if (btn) { await btn.click(); await new Promise(r => setTimeout(r, 3000)); break; }
      }
    } catch (e) {}

    // Wait for the results feed
    console.log("[SCRAPE] Waiting for results feed...");
    try {
      await page.waitForSelector('div[role="feed"]', { timeout: 30000 });
    } catch (err) {
      await new Promise(r => setTimeout(r, 5000));
      try {
        await page.waitForSelector('div[role="feed"]', { timeout: 15000 });
      } catch (err2) {
        const title = await page.title();
        throw new Error(`Google Maps did not load the results list. Page title: "${title}".`);
      }
    }

    // ===== STEP 2: Scroll the feed to load enough listings =====
    const totalNeeded = skip + limit;
    let previousCount = 0;
    let noNewCount = 0;

    while (noNewCount < 10) {
      const currentCount = await page.evaluate(() => document.querySelectorAll('div.Nv2PK').length);
      console.log(`[SCRAPE] Loaded ${currentCount} listings...`);

      if (currentCount >= totalNeeded) break;

      if (currentCount === previousCount) {
        noNewCount++;
      } else {
        noNewCount = 0;
      }
      previousCount = currentCount;

      await page.evaluate(() => {
        const feed = document.querySelector('div[role="feed"]');
        if (feed) feed.scrollBy(0, 800);
      });
      await new Promise(r => setTimeout(r, 2000));
    }

    // ===== STEP 3: Collect all listing names + URLs from cards =====
    const allListings = await page.evaluate(() => {
      const cards = document.querySelectorAll('div.Nv2PK');
      const results = [];
      cards.forEach(card => {
        try {
          const linkEl = card.querySelector('a.hfpxzc');
          if (!linkEl) return;
          const name = linkEl.getAttribute('aria-label') || '';
          const href = linkEl.getAttribute('href') || '';
          if (name && href) results.push({ name, url: href });
        } catch (e) {}
      });
      return results;
    });

    console.log(`[SCRAPE] Found ${allListings.length} listings in feed`);

    // ===== STEP 4: Visit each listing URL directly and extract ALL data =====
    // This is the KEY fix: instead of click+goBack (which causes stale nodes),
    // we navigate to each place URL directly. Each page load is fresh.
    const startIndex = skip;
    const endIndex = Math.min(skip + limit, allListings.length);
    const finalResults = [];

    for (let i = startIndex; i < endIndex; i++) {
      const listing = allListings[i];
      if (!listing) continue;

      console.log(`[SCRAPE] [${finalResults.length + 1}/${limit}] Visiting: ${listing.name}`);

      try {
        // Navigate directly to the place URL
        await page.goto(listing.url, {
          waitUntil: "domcontentloaded",
          timeout: 30000
        });

        // Wait for the place details to load (h1 with the business name)
        try {
          await page.waitForFunction(() => {
            const h1 = document.querySelector('h1');
            return h1 && h1.innerText.trim().length > 0 && h1.innerText.trim() !== 'Results';
          }, { timeout: 10000 });
        } catch (e) {
          console.log(`[SCRAPE] Slow load for: ${listing.name}`);
        }

        // Extra wait for all info buttons to render
        await new Promise(r => setTimeout(r, 2000));

        // Extract ALL data from the place detail page
        const data = await page.evaluate(() => {
          const clean = (text) => text ? text.replace(/[^\x20-\x7E]/g, "").trim() : "";

          // === NAME ===
          const h1 = document.querySelector('h1');
          const name = h1 ? clean(h1.innerText) : '';

          // === RATING ===
          let rating = '';
          // Method 1: aria-hidden span inside F7nice
          const ratingSpan = document.querySelector('div.F7nice span[aria-hidden="true"]');
          if (ratingSpan) {
            rating = clean(ratingSpan.innerText);
          }
          // Method 2: role="img" aria-label
          if (!rating) {
            const roleImg = document.querySelector('div[role="img"][aria-label*="star"]');
            if (roleImg) {
              const match = (roleImg.getAttribute('aria-label') || '').match(/([\d.]+)/);
              if (match) rating = match[1];
            }
          }
          // Method 3: any span with just a decimal number near stars
          if (!rating) {
            const allSpans = document.querySelectorAll('span');
            for (const s of allSpans) {
              const t = s.innerText.trim();
              if (/^\d\.\d$/.test(t)) { rating = t; break; }
            }
          }

          // === REVIEWS ===
          let reviews = '';
          // Method 1: button with "reviews" in aria-label
          const reviewBtn = document.querySelector('button[jsaction*="review"][aria-label]');
          if (reviewBtn) {
            const label = reviewBtn.getAttribute('aria-label') || '';
            const match = label.match(/([\d,]+)\s*review/i);
            if (match) reviews = match[1].replace(/,/g, '');
          }
          // Method 2: look for text like "(123)" in F7nice
          if (!reviews) {
            const f7 = document.querySelectorAll('div.F7nice span');
            for (const el of f7) {
              const t = el.innerText.trim();
              if (/^\(?\d/.test(t) && !(/^\d\.\d$/.test(t))) {
                reviews = t.replace(/[()]/g, '').trim();
                break;
              }
            }
          }
          // Method 3: aria-label on the F7nice parent
          if (!reviews) {
            const f7nice = document.querySelector('div.F7nice');
            if (f7nice) {
              const label = f7nice.getAttribute('aria-label') || f7nice.parentElement?.getAttribute('aria-label') || '';
              const match = label.match(/([\d,]+)\s*review/i);
              if (match) reviews = match[1].replace(/,/g, '');
            }
          }

          // === PHONE ===
          const phoneBtn = document.querySelector('button[data-item-id*="phone"]');
          const phone = phoneBtn ? clean(phoneBtn.innerText) : '';

          // === WEBSITE ===
          const websiteLink = document.querySelector('a[data-item-id="authority"]');
          const website = websiteLink ? websiteLink.href : '';

          // === ADDRESS ===
          const addressBtn = document.querySelector('button[data-item-id="address"]');
          const address = addressBtn ? clean(addressBtn.innerText) : '';

          return { name, rating, reviews, phone, website, address };
        });

        const result = {
          name: data.name || listing.name,
          rating: data.rating || '',
          reviews: data.reviews || '',
          phone: data.phone || '',
          website: data.website || '',
          address: data.address || '',
          google_link: listing.url
        };

        finalResults.push(result);
        console.log(`[SCRAPE] ✅ ${result.name} | ⭐${result.rating} | 📞${result.phone} | 🌐${result.website ? 'yes' : 'no'}`);

      } catch (err) {
        console.log(`[SCRAPE] ❌ Error for ${listing.name}: ${err.message}`);
        // Still add what we know from the card
        finalResults.push({
          name: listing.name,
          rating: '', reviews: '', phone: '', website: '', address: '',
          google_link: listing.url
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
