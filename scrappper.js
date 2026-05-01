const puppeteer = require("puppeteer");

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    args: ["--start-maximized"]
  });

  const page = await browser.newPage();

  const query = "dental clinic sector 15 noida";

  console.log("Opening Maps...");
  await page.goto(`https://www.google.com/maps/search/${query}`, {
    waitUntil: "networkidle2"
  });

  await page.waitForSelector('div[role="feed"]');

  const processed = new Set();
  const results = [];

  let sameCount = 0;

  while (true) {
    // Get visible listings
    const listings = await page.$$("div.Nv2PK");

    console.log("Visible listings:", listings.length);

    let newDataFound = false;

    for (let i = 0; i < listings.length; i++) {
      try {
        // Get unique name from list (not detail panel)
        const name = await listings[i].evaluate(el =>
          el.innerText.split("\n")[0]
        );

        if (processed.has(name)) continue;

        processed.add(name);
        newDataFound = true;

        console.log("Processing:", name);

        // Scroll into view
        await listings[i].evaluate(el =>
          el.scrollIntoView({ block: "center" })
        );

        await new Promise(r => setTimeout(r, 1000));

        // Click
        await listings[i].click();

        await page.waitForSelector("h1", { timeout: 10000 });

        await new Promise(r => setTimeout(r, 2000));

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

        console.log(data);

        results.push(data);

        // Go back
        await page.goBack();
        await page.waitForSelector('div[role="feed"]');

        await new Promise(r => setTimeout(r, 2000));

      } catch (err) {
        console.log("Error:", err.message);
      }
    }

    // Scroll SMALL step (IMPORTANT FIX)
    await page.evaluate(() => {
      const feed = document.querySelector('div[role="feed"]');
      feed.scrollBy(0, 500); // 🔥 SMALL SCROLL
    });

    await new Promise(r => setTimeout(r, 2000));

    // Stop condition
    if (!newDataFound) {
      sameCount++;
    } else {
      sameCount = 0;
    }

    if (sameCount >= 3) {
      console.log("No new data found, stopping...");
      break;
    }
  }

  console.log("\nFINAL DATA:");
  console.log(results);

  await browser.close();
})();