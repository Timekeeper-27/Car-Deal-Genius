const express = require('express');
const path = require('path');
const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const cors = require('cors');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const FORMATS_FILE = 'formats.json';

const MASTER_SELECTORS = [
  { brand: 'Toyota', container: '.standard-inventory', title: '.vehiclebox-title h2', price: '.vehiclebox-msrp', image: '.vehiclebox-image img', link: 'a' },
  { brand: 'Dodge Chrysler Jeep', container: '.vehicle-card', title: '.title-wrap .title', price: '.price-wrap .price', image: '.vehicle-img', link: 'a' },
  { brand: 'Ford', container: 'div.vehicle-info', title: '.vehicle-title', price: '.vehicle-price', image: 'img.vehicle-image', link: 'a' },
  { brand: 'Honda', container: 'div.inventory-listing', title: '.inventory-title', price: '.inventory-price', image: '.inventory-image img', link: 'a' },
  { brand: 'Chevrolet', container: 'div.vehicle-card-vdp', title: '.vehicle-card-title', price: '.vehicle-card-price', image: '.vehicle-card-photo img', link: 'a' },
  { brand: 'Nissan', container: 'div.vehicle-listing', title: '.vehicle-name', price: '.vehicle-price', image: '.vehicle-image img', link: 'a' },
  { brand: 'Subaru', container: 'div.inventory-container', title: '.inventory-title', price: '.inventory-price', image: '.inventory-photo img', link: 'a' },
  { brand: 'Kia', container: 'div.vehicle-info-container', title: '.vehicle-name', price: '.vehicle-price', image: 'img.vehicle-image', link: 'a' },
  { brand: 'CarMax', container: '.scct--car-tile', title: '.scct--make-model-info', price: '.scct--price-miles-info--price', image: '.scct--image-gallery__image', link: '.scct--make-model-info-link' },
  { brand: 'Edmunds', container: '.usurp-inventory-card', title: '.size-16.text-cool-gray-10', price: '.heading-3', image: '.usurp-inventory-card-photo-image img', link: '.usurp-inventory-card-vdp-link' }
];

if (fs.existsSync(FORMATS_FILE)) {
  const userFormats = JSON.parse(fs.readFileSync(FORMATS_FILE));
  MASTER_SELECTORS.push(...userFormats);
}

function rateDeal(listing, marketPrice) {
  let score = 50;
  if (listing.numPrice && marketPrice) {
    if (listing.numPrice < marketPrice * 0.8) score += 25;
    else if (listing.numPrice < marketPrice * 0.9) score += 20;
    else if (listing.numPrice < marketPrice) score += 10;
  }

  if (listing.features && listing.features.length) {
    const bonuses = ['Leather', 'Navigation', '4WD', 'AWD', 'Sunroof', 'Bluetooth', 'Backup Camera', 'Heated Seats', 'Keyless Entry', 'Blind Spot Monitor'];
    bonuses.forEach(bonusFeature => {
      if (listing.features.some(f => f.toLowerCase().includes(bonusFeature.toLowerCase()))) {
        score += 2;
      }
    });
  }

  if (listing.mileage && listing.mileage < 60000) score += 5;
  if (listing.year && listing.year > 2018) score += 5;
  if (listing.warranty) score += 5;
  if (listing.description && listing.description.toLowerCase().includes('import fee')) score -= 10;

  return Math.max(0, Math.min(100, score));
}

function parseHtmlContent(html) {
  const $ = cheerio.load(html);

  for (const selectors of MASTER_SELECTORS) {
    const containers = $(selectors.container);

    if (containers.length > 0) {
      const listings = [];
      containers.each((i, elem) => {
        const title = $(elem).find(selectors.title).text().trim() || 'No title';
        const price = $(elem).find(selectors.price).text().trim() || 'No price';
        const link = $(elem).find(selectors.link).attr('href') || '';
        const image = $(elem).find(selectors.image).attr('src') || '';

        const numPrice = parseFloat(price.replace(/[^\d\.]/g, '')) || 0;

        let year = null;
        const yearMatch = title.match(/\b(20[0-2][0-9]|19[8-9][0-9])\b/);
        if (yearMatch) {
          year = parseInt(yearMatch[0]);
        }

        let mileage = null;
        // First try CarMax/Edmunds/others known selectors
        const mileageText = $(elem).find('.scct--price-miles-info--miles, .key-point-icon + .text-cool-gray-30, .inventory-card-mileage, .optMileage').first().text().trim();
        const mileageMatch = mileageText.match(/([\d,]+)\s*(mi|miles)?/i);
        if (mileageMatch) {
          mileage = parseInt(mileageMatch[1].replace(/,/g, ''));
        }

        if (!mileage) {
          // Fallback
          $(elem).find('*').each((i, child) => {
            const text = $(child).text();
            const mileageFallbackMatch = text.match(/([\d,]+)\s*(miles|mi)/i);
            if (mileageFallbackMatch) {
              mileage = parseInt(mileageFallbackMatch[1].replace(/,/g, ''));
              return false;
            }
          });
        }

        let features = [];
        $(elem).find('li, .feature-item, .features-list, .key-features, .list-unstyled li').each((i, child) => {
          const text = $(child).text().trim();
          if (text.length > 1 && text.length < 100) {
            features.push(text);
          }
        });

        listings.push({
          title,
          price,
          link,
          image,
          numPrice,
          year: year || null,
          mileage: mileage || null,
          features: features.length ? features : null,
          warranty: 'Certified Pre-Owned',
          description: 'No accidents, well maintained.'
        });
      });

      return listings;
    }
  }

  return [];
}

app.post('/scrape', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).send('Missing URL.');

  let browser;
  try {
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    const html = await page.content();
    let listings = parseHtmlContent(html);

    if (listings.length === 0) {
      console.log('⚠️ No listings found at this URL.');
    }

    const avgMarketPrice = listings.reduce((sum, l) => sum + l.numPrice, 0) / (listings.length || 1);

    listings = listings.map(listing => {
      const score = rateDeal(listing, avgMarketPrice);
      return { ...listing, score };
    });

    await browser.close();
    res.json({ listings });
  } catch (err) {
    if (browser) await browser.close();
    console.error('❌ Scrape Error:', err);
    res.status(500).send('Scraping failed.');
  }
});

app.listen(PORT, () => console.log(`🚀 Car Deal Rater running on port ${PORT}`));
