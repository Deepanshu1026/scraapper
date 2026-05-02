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

    // ===== STEP 1: Navigate to Google Maps search =====
    console.log("[SCRAPE] Navigating to Google Maps...");
    await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(query)}?hl=en`, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    // Give Maps JS time to render
    await new Promise(r => setTimeout(r, 8000));

    // Handle consent screen
    try {
      for (const sel of ['button[aria-label="Accept all"]', 'button[aria-label="Reject all"]', 'form[action*="consent"] button']) {
        const btn = await page.$(sel);
        if (btn) { await btn.click(); await new Promise(r => setTimeout(r, 3000)); break; }
      }
    } catch (e) {}

    // Wait for listings to appear
    console.log("[SCRAPE] Waiting for listings...");
    try {
      await page.waitForFunction(() => {
        return document.querySelectorAll('div.Nv2PK').length > 0
            || document.querySelectorAll('a.hfpxzc').length > 0;
      }, { timeout: 60000 });
      console.log("[SCRAPE] Listings found!");
    } catch (err) {
      const title = await page.title();
      throw new Error(`No listings found. Page: "${title}"`);
    }

    // ===== STEP 2: Scroll to load enough listings =====
    const totalNeeded = skip + limit;
    let previousCount = 0;
    let noNewCount = 0;

    while (noNewCount < 10) {
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

    // ===== STEP 3: Collect listing names from cards =====
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

    // ===== STEP 4: Click each listing to get details (FAST - no page reload!) =====
    const startIndex = skip;
    const endIndex = Math.min(skip + limit, allListings.length);
    const finalResults = [];

    for (let i = startIndex; i < endIndex; i++) {
      const listing = allListings[i];
      if (!listing) continue;

      console.log(`[SCRAPE] [${finalResults.length + 1}/${limit}] Clicking: ${listing.name}`);

      try {
        // IMPORTANT: Find the link FRESH each time using page.evaluate + click
        // This avoids the "Node is detached" error completely
        const clicked = await page.evaluate((targetName) => {
          const links = document.querySelectorAll('a.hfpxzc');
          for (const link of links) {
            if (link.getAttribute('aria-label') === targetName) {
              link.scrollIntoView({ block: "center" });
              link.click();
              return true;
            }
          }
          return false;
        }, listing.name);

        if (!clicked) {
          console.log(`[SCRAPE] Could not find link for: ${listing.name}, skipping`);
          finalResults.push({
            name: listing.name, rating: '', reviews: '', phone: '',
            website: '', address: '', google_link: listing.url
          });
          continue;
        }

        // Wait for the detail panel to load (h1 changes to business name)
        try {
          await page.waitForFunction((expectedName) => {
            const h1 = document.querySelector('h1');
            if (!h1) return false;
            const text = h1.innerText.trim();
            // h1 should not be empty and should not be "Results"
            return text.length > 0 && text !== 'Results';
          }, { timeout: 10000 }, listing.name);
        } catch (e) {
          console.log(`[SCRAPE] Detail panel slow for: ${listing.name}`);
        }

        // Wait for info buttons (phone/address/website) to appear
        try {
          await page.waitForFunction(() => {
            const btns = document.querySelectorAll('button[data-item-id], a[data-item-id]');
            return btns.length > 0;
          }, { timeout: 10000 });
        } catch (e) {
          console.log(`[SCRAPE] No info buttons for: ${listing.name}`);
        }

        // Small buffer for remaining elements
        await new Promise(r => setTimeout(r, 1000));

        // Extract ALL data from the detail panel
        const data = await page.evaluate(() => {
          const clean = (text) => text ? text.replace(/[^\x20-\x7E]/g, "").trim() : "";

          // Name
          const h1 = document.querySelector('h1');
          const name = h1 ? clean(h1.innerText) : '';

          // Rating
          let rating = '';
          const ratingSpan = document.querySelector('div.F7nice span[aria-hidden="true"]');
          if (ratingSpan) rating = clean(ratingSpan.innerText);
          if (!rating) {
            const roleImg = document.querySelector('div[role="img"][aria-label*="star"]');
            if (roleImg) {
              const m = (roleImg.getAttribute('aria-label') || '').match(/([\d.]+)/);
              if (m) rating = m[1];
            }
          }
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
                reviews = t.replace(/[()]/g, '').trim();
                break;
              }
            }
          }

          // Phone
          const phoneBtn = document.querySelector('button[data-item-id*="phone"]');
          const phone = phoneBtn ? clean(phoneBtn.innerText) : '';

          // Website
          const websiteLink = document.querySelector('a[data-item-id="authority"]');
          const website = websiteLink ? websiteLink.href : '';

          // Address
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

        // Go back to search results using the Maps back button
        // Use page.evaluate to click the back button in the Maps UI
        const wentBack = await page.evaluate(() => {
          // Try the Maps UI back button first
          const backBtn = document.querySelector('button[aria-label="Back"]');
          if (backBtn) { backBtn.click(); return 'button'; }
          return false;
        });

        if (wentBack) {
          // Wait for the feed to reappear
          try {
            await page.waitForFunction(() => {
              return document.querySelectorAll('a.hfpxzc').length > 0;
            }, { timeout: 10000 });
          } catch (e) {
            // If back button didn't work, try browser back
            await page.goBack({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
            await new Promise(r => setTimeout(r, 3000));
          }
        } else {
          // Fallback: browser back
          await page.goBack({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
          await new Promise(r => setTimeout(r, 3000));
        }

        // Wait for listings to be visible again
        try {
          await page.waitForFunction(() => {
            return document.querySelectorAll('a.hfpxzc').length > 0;
          }, { timeout: 10000 });
        } catch (e) {
          console.log("[SCRAPE] Feed slow to reappear, waiting more...");
          await new Promise(r => setTimeout(r, 5000));
        }

        await new Promise(r => setTimeout(r, 500));

      } catch (err) {
        console.log(`[SCRAPE] ❌ Error for ${listing.name}: ${err.message}`);
        finalResults.push({
          name: listing.name, rating: '', reviews: '', phone: '',
          website: '', address: '', google_link: listing.url
        });

        // Try to recover
        try {
          await page.goBack({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
          await new Promise(r => setTimeout(r, 3000));
        } catch (e) {}
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
