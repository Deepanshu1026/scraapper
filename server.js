const express = require("express");
const puppeteer = require("puppeteer");
const cors = require("cors");

const app = express();
app.use(cors());

// Health check
app.get("/", (req, res) => {
  res.json({ status: "Scraper API is running!" });
});

// Debug endpoint - takes a screenshot so you can see what Google Maps looks like on the server
app.get("/debug", async (req, res) => {
  const query = req.query.q || "restaurant near me";
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--single-process"
      ]
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    
    // Set language to English to avoid consent issues
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(query)}`, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    // Wait a bit for JS to render
    await new Promise(r => setTimeout(r, 5000));

    const screenshot = await page.screenshot({ encoding: "base64", fullPage: false });
    const title = await page.title();
    const url = page.url();
    const html = await page.content();
    
    // Check what elements exist
    const elements = await page.evaluate(() => {
      return {
        hasFeed: !!document.querySelector('div[role="feed"]'),
        hasNv2PK: document.querySelectorAll('div.Nv2PK').length,
        h1Text: document.querySelector('h1')?.innerText || 'no h1',
        bodyText: document.body.innerText.substring(0, 500),
        consentForm: !!document.querySelector('form[action*="consent"]'),
      };
    });
    
    await browser.close();
    
    res.json({
      title,
      url,
      elements,
      screenshot: `data:image/png;base64,${screenshot}`
    });
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
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--single-process"
      ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    
    // Force English to avoid consent screens in other languages
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    // Navigate to Google Maps
    console.log("[SCRAPE] Navigating to Google Maps...");
    await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(query)}?hl=en`, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    // Handle consent screen (Google shows this for EU/server IPs)
    await new Promise(r => setTimeout(r, 3000));
    try {
      // Try multiple consent button selectors
      const consentSelectors = [
        'button[aria-label="Accept all"]',
        'button[aria-label="Reject all"]',
        'form[action*="consent"] button',
        '[aria-label="Before you continue"]',
      ];
      for (const sel of consentSelectors) {
        const btn = await page.$(sel);
        if (btn) {
          console.log("[SCRAPE] Found consent button, clicking...");
          await btn.click();
          await new Promise(r => setTimeout(r, 3000));
          break;
        }
      }
    } catch (e) {
      console.log("[SCRAPE] No consent screen found, continuing...");
    }

    // Wait for the results feed
    console.log("[SCRAPE] Waiting for results feed...");
    try {
      await page.waitForSelector('div[role="feed"]', { timeout: 30000 });
    } catch (err) {
      // If feed not found, maybe the page hasn't fully loaded. Wait more and try again.
      console.log("[SCRAPE] Feed not found on first try, waiting more...");
      await new Promise(r => setTimeout(r, 5000));
      
      try {
        await page.waitForSelector('div[role="feed"]', { timeout: 15000 });
      } catch (err2) {
        const title = await page.title();
        const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 300));
        console.log("[SCRAPE] Page title:", title);
        console.log("[SCRAPE] Body text:", bodyText);
        throw new Error(`Google Maps did not load the results list. Page title: "${title}". This usually means Google is blocking the server IP with a captcha, or showing a consent screen we couldn't bypass.`);
      }
    }

    console.log("[SCRAPE] Feed found! Starting to extract data...");

    // ===== PHASE 1: Scroll the feed to load enough listings =====
    const totalNeeded = skip + limit;
    let previousCount = 0;
    let scrollAttempts = 0;

    while (scrollAttempts < 15) {
      const currentCount = await page.evaluate(() => {
        return document.querySelectorAll('div.Nv2PK').length;
      });
      
      console.log(`[SCRAPE] Loaded ${currentCount} listings so far...`);
      
      if (currentCount >= totalNeeded) break;
      
      if (currentCount === previousCount) {
        scrollAttempts++;
      } else {
        scrollAttempts = 0;
      }
      previousCount = currentCount;

      // Scroll the feed
      await page.evaluate(() => {
        const feed = document.querySelector('div[role="feed"]');
        if (feed) feed.scrollBy(0, 800);
      });
      await new Promise(r => setTimeout(r, 2000));
    }

    // ===== PHASE 2: Extract basic info from ALL listing cards (fast, no clicking) =====
    const allListings = await page.evaluate(() => {
      const cards = document.querySelectorAll('div.Nv2PK');
      const results = [];
      
      cards.forEach((card, index) => {
        try {
          // Get the link element which contains the business name
          const linkEl = card.querySelector('a.hfpxzc');
          const name = linkEl ? linkEl.getAttribute('aria-label') || '' : '';
          
          // Get rating
          const ratingEl = card.querySelector('span.MW4etd');
          const rating = ratingEl ? ratingEl.innerText.trim() : '';
          
          // Get review count
          const reviewEl = card.querySelector('span.UY7F9');
          const reviews = reviewEl ? reviewEl.innerText.replace(/[()]/g, '').trim() : '';
          
          // Get category/type
          const categoryEls = card.querySelectorAll('.W4Efsd span');
          let category = '';
          let address = '';
          categoryEls.forEach(el => {
            const text = el.innerText.trim();
            if (text && text !== '·' && !text.includes('★')) {
              if (!category) category = text;
              else if (!address) address = text;
            }
          });
          
          // Try to get address from a different place
          const textBlocks = card.querySelectorAll('.W4Efsd');
          if (textBlocks.length >= 2 && !address) {
            address = textBlocks[1]?.innerText?.trim() || '';
          }

          // Get the href for the google maps link
          const href = linkEl ? linkEl.getAttribute('href') || '' : '';

          if (name) {
            results.push({
              index,
              name,
              rating,
              reviews,
              category,
              address,
              google_link: href,
              phone: '',
              website: ''
            });
          }
        } catch (e) {}
      });
      
      return results;
    });

    console.log(`[SCRAPE] Extracted ${allListings.length} listings from cards`);

    // ===== PHASE 3: Click into each listing (after skip) to get phone & website =====
    const startIndex = skip;
    const endIndex = Math.min(skip + limit, allListings.length);
    const finalResults = [];

    for (let i = startIndex; i < endIndex; i++) {
      const listing = allListings[i];
      if (!listing) continue;

      console.log(`[SCRAPE] [${i + 1}/${endIndex}] Getting details for: ${listing.name}`);

      try {
        // Click on the listing link
        const links = await page.$$('a.hfpxzc');
        if (links[listing.index]) {
          await links[listing.index].evaluate(el => el.scrollIntoView({ block: "center" }));
          await new Promise(r => setTimeout(r, 500));
          await links[listing.index].click();
          
          // Wait for the detail panel to load
          await new Promise(r => setTimeout(r, 2000));

          // Extract phone and website from detail panel
          const details = await page.evaluate(() => {
            const clean = (text) => text ? text.replace(/[^\x20-\x7E]/g, "").trim() : "";
            
            // Phone
            const phoneBtn = document.querySelector('button[data-item-id*="phone"]');
            const phone = phoneBtn ? clean(phoneBtn.innerText) : '';
            
            // Website
            const websiteLink = document.querySelector('a[data-item-id="authority"]');
            const website = websiteLink ? websiteLink.href : '';
            
            // Better address from detail panel
            const addressBtn = document.querySelector('button[data-item-id="address"]');
            const address = addressBtn ? clean(addressBtn.innerText) : '';
            
            // Better name from detail panel
            const h1 = document.querySelector('h1');
            const name = h1 ? clean(h1.innerText) : '';

            return { phone, website, address, name };
          });

          // Merge detail data into listing
          if (details.phone) listing.phone = details.phone;
          if (details.website) listing.website = details.website;
          if (details.address) listing.address = details.address;
          if (details.name && details.name !== 'Results') listing.name = details.name;
        }
      } catch (err) {
        console.log(`[SCRAPE] Could not get details for ${listing.name}: ${err.message}`);
      }

      // Remove the internal index before sending to client
      delete listing.index;
      finalResults.push(listing);
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
