const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const sharp = require('sharp');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS and JSON parsing
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Detect App Engine environment to redirect writes to /tmp
const isAppEngine = process.env.GAE_ENV === 'standard' || process.env.GAE_INSTANCE !== undefined;
const writeableDir = isAppEngine ? '/tmp' : __dirname;

const processedDir = isAppEngine ? path.join(writeableDir, 'processed') : path.join(__dirname, 'public', 'processed');
const mockUploadsDir = isAppEngine ? path.join(writeableDir, 'mock_uploads') : path.join(__dirname, 'public', 'mock_uploads');
const tempDir = isAppEngine ? path.join(writeableDir, 'temp') : path.join(__dirname, 'public', 'temp');

// Ensure required directories exist
const dirs = [processedDir, mockUploadsDir, tempDir];
dirs.forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Serve frontend public static files
app.use(express.static(path.join(__dirname, 'public')));

// Serve processed images and mock uploads dynamically
app.use('/processed', express.static(processedDir));
app.use('/mock_uploads', express.static(mockUploadsDir));

// Dynamic config management (stored in config.json, fallback to .env)
const configPath = path.join(writeableDir, 'config.json');
let config = {
  targetGalleryUrl: process.env.TARGET_GALLERY_URL || '',
  galleryImageSelector: process.env.GALLERY_IMAGE_SELECTOR || 'img.gallery-photo, img.photo-item, img.gallery-image, a[href$=".jpg"]',
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS, 10) || 5000,
  canvasBgColor: process.env.CANVAS_BG_COLOR || '#ffffff',
  mockMode: process.env.MOCK_MODE === 'true'
};

function loadConfig() {
  if (fs.existsSync(configPath)) {
    try {
      const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      config = { ...config, ...saved };
    } catch (e) {
      console.error('[Config] Error reading config.json:', e);
    }
  } else {
    saveConfig();
  }
}

function saveConfig() {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

loadConfig();

// Persistent database in db.json
const dbPath = path.join(writeableDir, 'db.json');
let db = { originalUrls: [], photos: [] };

function loadDb() {
  if (fs.existsSync(dbPath)) {
    try {
      db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
      if (!db.originalUrls) db.originalUrls = [];
      if (!db.photos) db.photos = [];
    } catch (e) {
      console.error('[DB] Error reading db.json, resetting database state:', e);
    }
  } else {
    saveDb();
  }
}

function saveDb() {
  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), 'utf8');
}

loadDb();

// Download and process a discovered photo
async function processAndAddPhoto(url) {
  console.log(`[Processor] Downloading raw image: ${url}`);
  
  let buffer;
  // If it's a mock local file, read directly from the filesystem to bypass loopback networking issues on App Engine standard
  if (url.includes('/mock_uploads/')) {
    const filename = path.basename(url);
    const localPath = path.join(mockUploadsDir, filename);
    buffer = fs.readFileSync(localPath);
  } else {
    // Download the photo buffer with browser headers to bypass bot blocks (like Wikipedia/Unsplash 403 Forbidden)
    const response = await axios.get(url, { 
      responseType: 'arraybuffer', 
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Referer': config.targetGalleryUrl || 'https://www.google.com/'
      }
    });
    buffer = Buffer.from(response.data);
  }
  
  const id = 'img_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  const filename = `${id}.jpg`;
  const processedPath = path.join(processedDir, filename);
  
  const bgColor = config.canvasBgColor || '#ffffff';
  
  console.log(`[Processor] Resizing to 1800x1200 (4x6" aspect ratio) with background ${bgColor}...`);
  
  // Sharp contain fit will automatically:
  // 1. Correct image orientation from EXIF rotation
  // 2. Scale image aspect ratio to fit inside 1800x1200 pixels
  // 3. Add letterbox or pillarbox padding using the configured background color
  // 4. Output a high-resolution, print-ready JPEG
  await sharp(buffer)
    .rotate()
    .resize({
      width: 1800,
      height: 1200,
      fit: 'contain',
      background: bgColor
    })
    .jpeg({ quality: 95 })
    .toFile(processedPath);
    
  // Add to database
  db.originalUrls.push(url);
  db.photos.unshift({
    id,
    originalUrl: url,
    processedUrl: `/processed/${filename}`,
    filename,
    timestamp: new Date().toISOString()
  });
  
  saveDb();
  console.log(`[Processor] Success! Processed file saved: ${processedPath}`);
  return db.photos[0];
}

// Scraper loop
async function scrapeGallery() {
  const targetUrl = config.targetGalleryUrl;
  if (!targetUrl) {
    console.warn('[Scraper] TARGET_GALLERY_URL is not set.');
    return;
  }
  
  // Skip external scrapes if Mock Mode is on and the target URL points to example.com placeholder
  if (config.mockMode && (targetUrl.includes('example.com/hp-sprocket-gallery') || targetUrl.includes('hp-sprocket-mock-gallery'))) {
    return scrapeLocalMockGallery();
  }

  try {
    console.log(`[Scraper] Polling gallery: ${targetUrl}...`);
    const response = await axios.get(targetUrl, {
      timeout: 8000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
      }
    });
    
    const html = response.data;
    const $ = cheerio.load(html);
    const selectors = (config.galleryImageSelector || 'img').split(',');
    
    const foundUrls = [];
    
    selectors.forEach(selectorStr => {
      const cleanSelector = selectorStr.trim();
      if (!cleanSelector) return;
      
      $(cleanSelector).each((i, element) => {
        let src = $(element).attr('src') || $(element).attr('href') || $(element).attr('data-src') || $(element).attr('data-lightbox');
        if (src) {
          try {
            // Resolve relative URLs to absolute URLs
            const absoluteUrl = new URL(src, targetUrl).href;
            if (absoluteUrl.startsWith('http') && !foundUrls.includes(absoluteUrl) && !absoluteUrl.includes('google-analytics')) {
              foundUrls.push(absoluteUrl);
            }
          } catch (e) {
            // Fallback if URL parsing fails
            if (src.startsWith('http') && !foundUrls.includes(src)) {
              foundUrls.push(src);
            }
          }
        }
      });
    });

    // Check against DB for new items
    const newUrls = foundUrls.filter(url => !db.originalUrls.includes(url));
    console.log(`[Scraper] Scraped ${foundUrls.length} image URLs. Discovered ${newUrls.length} new photos.`);
    
    for (const url of newUrls) {
      try {
        await processAndAddPhoto(url);
      } catch (err) {
        console.error(`[Scraper] Error processing new image ${url}:`, err.message);
      }
    }
  } catch (err) {
    console.error(`[Scraper] Scraping failed for ${targetUrl}:`, err.message);
  }
}

// Scrape local mock gallery for Mock Mode
async function scrapeLocalMockGallery() {
  try {
    const localUrl = `http://localhost:${PORT}/mock-gallery`;
    const response = await axios.get(localUrl, { timeout: 3000 });
    const $ = cheerio.load(response.data);
    const foundUrls = [];
    
    $('img.gallery-photo').each((i, el) => {
      const src = $(el).attr('src');
      if (src) {
        const absoluteUrl = `http://localhost:${PORT}${src}`;
        if (!foundUrls.includes(absoluteUrl)) {
          foundUrls.push(absoluteUrl);
        }
      }
    });
    
    const newUrls = foundUrls.filter(url => !db.originalUrls.includes(url));
    if (newUrls.length > 0) {
      console.log(`[Scraper (Mock)] Found ${newUrls.length} new photos in mock page.`);
    }
    
    for (const url of newUrls) {
      try {
        await processAndAddPhoto(url);
      } catch (err) {
        console.error(`[Scraper (Mock)] Error processing mock image ${url}:`, err.message);
      }
    }
  } catch (err) {
    console.error(`[Scraper (Mock)] Error polling mock gallery:`, err.message);
  }
}

// API Routes
app.get('/api/photos', (req, res) => {
  res.json(db.photos);
});

// Settings Management API
app.get('/api/config', (req, res) => {
  res.json(config);
});

app.post('/api/config', (req, res) => {
  try {
    const { targetGalleryUrl, galleryImageSelector, pollIntervalMs, canvasBgColor, mockMode } = req.body;
    
    if (targetGalleryUrl !== undefined) config.targetGalleryUrl = targetGalleryUrl;
    if (galleryImageSelector !== undefined) config.galleryImageSelector = galleryImageSelector;
    if (pollIntervalMs !== undefined) config.pollIntervalMs = parseInt(pollIntervalMs, 10) || 5000;
    if (canvasBgColor !== undefined) config.canvasBgColor = canvasBgColor;
    if (mockMode !== undefined) config.mockMode = mockMode === true;
    
    saveConfig();
    
    // Restart scraper timer with the new interval
    startScraperTimer();
    
    console.log('[Config] Configurations updated and saved successfully.');
    res.json({ success: true, config });
  } catch (e) {
    console.error('[Config] Update failed:', e.message);
    res.status(500).json({ error: 'Failed to save configuration: ' + e.message });
  }
});

// Reset Route
app.post('/api/photos/reset', (req, res) => {
  try {
    db = { originalUrls: [], photos: [] };
    saveDb();
    
    // Clear processed files
    if (fs.existsSync(processedDir)) {
      const files = fs.readdirSync(processedDir);
      files.forEach(file => {
        if (file !== '.gitkeep') {
          fs.unlinkSync(path.join(processedDir, file));
        }
      });
    }
    
    // Clear mock uploads
    if (fs.existsSync(mockUploadsDir)) {
      const files = fs.readdirSync(mockUploadsDir);
      files.forEach(file => {
        fs.unlinkSync(path.join(mockUploadsDir, file));
      });
    }
    
    console.log('[API] State and folders have been reset successfully.');
    res.json({ success: true, message: 'All images cleared and database reset.' });
  } catch (e) {
    console.error('[API] Reset failed:', e.message);
    res.status(500).json({ error: 'Failed to reset state: ' + e.message });
  }
});

// Mock Gallery generation endpoints (always registered, dynamically checks if mockMode is enabled)
app.post('/api/mock/add-random', async (req, res) => {
  if (!config.mockMode) {
    return res.status(403).json({ error: 'Mock Mode is not enabled. Turn it on in the Settings or Console.' });
  }

  const orientation = req.query.orientation === 'portrait' ? 'portrait' : 'landscape';
  const width = orientation === 'landscape' ? 800 : 600;
  const height = orientation === 'landscape' ? 600 : 800;
  
  try {
    console.log(`[Mock] Generating random ${orientation} solid color photo using sharp...`);
    
    // Generate a solid color background image using sharp to bypass external network download blocks/timeouts
    const r = Math.floor(Math.random() * 256);
    const g = Math.floor(Math.random() * 256);
    const b = Math.floor(Math.random() * 256);
    
    const buffer = await sharp({
      create: {
        width: width,
        height: height,
        channels: 3,
        background: { r, g, b }
      }
    })
    .jpeg()
    .toBuffer();
    
    const filename = `mock_${Date.now()}_${orientation}.jpg`;
    const destPath = path.join(mockUploadsDir, filename);
    
    fs.writeFileSync(destPath, buffer);
    console.log(`[Mock] Saved mock upload photo: ${destPath}`);
    res.json({ success: true, filename });
  } catch (err) {
    console.error(`[Mock] Solid color generation failed:`, err.message);
    res.status(500).json({ error: 'Solid color generation failed: ' + err.message });
  }
});

// Serve Mock Gallery Page
app.get('/mock-gallery', (req, res) => {
  const uploadDir = mockUploadsDir;
  let files = [];
  if (fs.existsSync(uploadDir)) {
    files = fs.readdirSync(uploadDir)
      .filter(file => /\.(jpg|jpeg|png)$/i.test(file))
      .sort((a, b) => fs.statSync(path.join(uploadDir, b)).mtimeMs - fs.statSync(path.join(uploadDir, a)).mtimeMs);
  }
    
  let html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>HP Sprocket Mock Gallery</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #121214; color: #eaeaea; max-width: 900px; margin: 0 auto; padding: 30px 20px; }
    h1 { border-bottom: 2px solid #2d2d34; padding-bottom: 12px; margin-bottom: 25px; color: #fff; font-weight: 700; }
    p.subtitle { color: #888; font-size: 14px; margin-top: -15px; margin-bottom: 30px; }
    .controls { display: flex; align-items: center; gap: 15px; margin-bottom: 30px; background: #1e1e24; padding: 20px; border-radius: 12px; border: 1px solid #2d2d34; box-shadow: 0 4px 12px rgba(0,0,0,0.2); }
    button { background: #0070f3; color: white; border: none; padding: 12px 24px; border-radius: 8px; font-weight: 600; font-size: 14px; cursor: pointer; transition: all 0.2s ease; display: inline-flex; align-items: center; justify-content: center; }
    button:hover { background: #0051a8; transform: translateY(-1px); }
    button:active { transform: translateY(0); }
    button.portrait { background: #7928ca; }
    button.portrait:hover { background: #58169a; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 20px; margin-top: 20px; }
    .card { background: #1e1e24; border-radius: 10px; overflow: hidden; border: 1px solid #2d2d34; position: relative; transition: transform 0.2s; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
    .card:hover { transform: translateY(-3px); border-color: #3f3f46; }
    .card img { width: 100%; height: 160px; object-fit: cover; display: block; }
    .card-name { padding: 12px; font-size: 12px; color: #a1a1aa; text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border-top: 1px solid #2d2d34; }
    .badge { position: absolute; top: 12px; right: 12px; background: #00cf7f; color: #121214; font-size: 10px; font-weight: 800; padding: 4px 8px; border-radius: 20px; text-transform: uppercase; letter-spacing: 0.5px; box-shadow: 0 2px 4px rgba(0,0,0,0.3); }
    .status { font-size: 14px; color: #00cf7f; font-weight: 500; min-width: 150px; }
    .back-btn { margin-left: auto; background: transparent; border: 1px solid #3f3f46; color: #d4d4d8; }
    .back-btn:hover { background: #27272a; color: #fff; }
  </style>
  <script>
    async function addRandom(orientation) {
      const status = document.getElementById('status');
      status.textContent = '⏳ Generating photo...';
      try {
        const res = await fetch('/api/mock/add-random?orientation=' + orientation, { method: 'POST' });
        if (res.ok) {
          status.textContent = '✅ Added! Scraping...';
          setTimeout(() => window.location.reload(), 1000);
        } else {
          status.textContent = '❌ Failed to generate photo.';
        }
      } catch(e) {
        status.textContent = '❌ Connection error: ' + e.message;
      }
    }
  </script>
</head>
<body>
  <h1>HP Sprocket Web Gallery (MOCK ENDPOINT)</h1>
  <p class="subtitle">This simulation page represents the online landing page where the photo booth uploads photos. Adding photos here will trigger the scraper backend automatically.</p>
  
  <div class="controls">
    <span style="font-weight: 600; color: #fff;">Simulate Upload:</span>
    <button onclick="addRandom('landscape')">📷 Add Landscape Photo</button>
    <button class="portrait" onclick="addRandom('portrait')">📸 Add Portrait Photo</button>
    <div id="status" class="status">Ready</div>
    <button class="back-btn" onclick="window.location.href='/'">Go to Kiosk Dashboard →</button>
  </div>
  
  <h2>Uploaded Photo Feed</h2>
  <div class="grid">
  `;
  
  files.forEach(file => {
    html += `
    <div class="card">
      <span class="badge">Active</span>
      <img class="gallery-photo" src="/mock_uploads/${file}" alt="Mock Photo">
      <div class="card-name">${file}</div>
    </div>
    `;
  });
  
  if (files.length === 0) {
    html += `
    <div style="grid-column: 1/-1; background: #1e1e24; border: 1px dashed #3f3f46; border-radius: 12px; text-align: center; padding: 60px 20px; color: #71717a;">
      <p style="font-size: 16px; font-weight: 500; margin-bottom: 8px;">No simulated photos yet</p>
      <p style="font-size: 13px; max-width: 400px; margin: 0 auto;">Click one of the buttons above to fetch a random image and simulate a live photo booth upload.</p>
    </div>
    `;
  }
  
  html += `
  </div>
</body>
</html>
  `;
  res.send(html);
});

// Setup dynamic scraper interval
let scraperTimerId = null;
function startScraperTimer() {
  if (scraperTimerId) {
    clearInterval(scraperTimerId);
  }
  console.log(`[Scraper] Initializing background monitor polling every ${config.pollIntervalMs}ms`);
  scraperTimerId = setInterval(scrapeGallery, config.pollIntervalMs);
}

// Start timer
startScraperTimer();

// Run initial scrape immediately on start
setTimeout(scrapeGallery, 1000);

// Start Server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] Web application bridge running at http://localhost:${PORT}`);
  console.log(`[Server] Accessible locally within venue network via tablet.`);
});
