require('dotenv').config();

const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const morgan = require('morgan');
const { promisify } = require('util');
const cors = require('cors');
const crypto = require('crypto');

// Ensure fetch is available (for Node versions without global fetch)
if (!global.fetch) {
  global.fetch = require('node-fetch');
}

// ---------------------------
// IP Country Lookup using Free Services
// ---------------------------
const IP_SERVICES = [
  { url: 'http://ip-api.com/json', extract: (data) => data.countryCode },
  { url: 'https://ipapi.co', extract: (data) => data.country_code },
  { url: 'https://ipwho.is', extract: (data) => data.country_code }
];
let currentServiceIndex = 0;
const ipCountryCache = new Map();
const IP_CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

async function getCountryFromIP(ip) {
  try {
    const cachedResult = ipCountryCache.get(ip);
    if (cachedResult && cachedResult.timestamp > Date.now() - IP_CACHE_DURATION) {
      return cachedResult.country;
    }
    let attempts = 0;
    let country = 'unknown';
    while (attempts < IP_SERVICES.length) {
      const service = IP_SERVICES[currentServiceIndex];
      try {
        const response = await fetch(`${service.url}/${ip}`);
        if (response.ok) {
          const data = await response.json();
          country = service.extract(data);
          if (country) break;
        }
      } catch (err) {
        console.warn(`IP service ${currentServiceIndex} failed:`, err);
      }
      currentServiceIndex = (currentServiceIndex + 1) % IP_SERVICES.length;
      attempts++;
    }
    ipCountryCache.set(ip, { country, timestamp: Date.now() });
    return country;
  } catch (err) {
    console.error('Error getting country from IP:', err);
    return 'unknown';
  }
}

// ---------------------------
// Redsys Easy – using sandbox URLs for test mode
// ---------------------------
const { createRedsysAPI, SANDBOX_URLS, randomTransactionId } = require('redsys-easy');

// ---------------------------
// Environment Variables & Configuration
// ---------------------------
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Facebook configuration
const FACEBOOK_PIXEL_ID = process.env.FACEBOOK_PIXEL_ID || '';
const FACEBOOK_ACCESS_TOKEN = process.env.FACEBOOK_ACCESS_TOKEN || '';
const FACEBOOK_TEST_EVENT_CODE = process.env.FACEBOOK_TEST_EVENT_CODE || '';

if (!FACEBOOK_PIXEL_ID || !FACEBOOK_ACCESS_TOKEN) {
  console.error('WARNING: Missing Facebook configuration. Events will not be sent!');
}

// Redsys configuration
const MERCHANT_CODE = process.env.MERCHANT_CODE || '367149531';
const TERMINAL = process.env.TERMINAL || '1';
const SECRET_KEY = process.env.SECRET_KEY || 'sq7HjrUOBfKmC576ILgskD5srU870gJ7';

// Update these URLs with your actual domain
const BASE_URL = process.env.BASE_URL || 'https://fbcid-production.up.railway.app';
const MERCHANT_MERCHANTURL = `${BASE_URL}/api/redsys-notification`;
const MERCHANT_URLOK = `${BASE_URL}/thanks.html`;
const MERCHANT_URLKO = `${BASE_URL}/error.html`;

// Create Redsys API instance
const { createRedirectForm, processRedirectNotification } = createRedsysAPI({
  secretKey: SECRET_KEY,
  urls: SANDBOX_URLS
});

// ---------------------------
// Express App & Middlewares
// ---------------------------
const app = express();

app.set('trust proxy', true);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests from any origin; adjust as needed.
    if (!origin) return callback(null, true);
    return callback(null, true);
  },
  credentials: true
}));

app.use(morgan(NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Note: We no longer use session or cookies for fb data storage.

// Serve static files
app.use(express.static(path.join(__dirname, 'views')));

// ---------------------------
// Database Setup & Migration
// ---------------------------
const db = new sqlite3.Database('./database.sqlite', (err) => {
  if (err) {
    console.error('Error opening database:', err);
    process.exit(1);
  } else {
    console.log('Connected to SQLite database.');
    initializeDatabase().catch(err => {
      console.error('Database initialization failed:', err);
      process.exit(1);
    });
  }
});

const dbRun = (...args) => new Promise((resolve, reject) => {
  db.run(...args, function(err) {
    if (err) return reject(err);
    resolve(this);
  });
});
const dbGet = promisify(db.get).bind(db);
const dbAll = promisify(db.all).bind(db);

async function initializeDatabase() {
  const migrations = [
    // Donations table
    `CREATE TABLE IF NOT EXISTS donations (
      orderId TEXT PRIMARY KEY,
      amount REAL,
      fbclid TEXT,
      fbp TEXT,
      fbc TEXT,
      redsys_data TEXT,
      fb_conversion_sent INTEGER DEFAULT 0,
      client_ip TEXT,
      client_user_agent TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    // Table for storing Facebook data from landing page
    `CREATE TABLE IF NOT EXISTS fb_data (
      id TEXT PRIMARY KEY,
      fbclid TEXT,
      fbp TEXT,
      fbc TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    // Logs for FB conversion events
    `CREATE TABLE IF NOT EXISTS fb_conversion_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      donation_orderId TEXT,
      raw_payload TEXT,
      attempts INTEGER DEFAULT 0,
      last_attempt DATETIME,
      status TEXT DEFAULT 'pending',
      error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(donation_orderId) REFERENCES donations(orderId)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_donations_fb_conversion_sent 
     ON donations(fb_conversion_sent)`,
    `CREATE INDEX IF NOT EXISTS idx_fb_conversion_logs_status 
     ON fb_conversion_logs(status)`,
    `CREATE TRIGGER IF NOT EXISTS donations_updated_at 
     AFTER UPDATE ON donations
     BEGIN
       UPDATE donations SET updated_at = CURRENT_TIMESTAMP 
       WHERE orderId = NEW.orderId;
     END`,
    `CREATE TRIGGER IF NOT EXISTS fb_conversion_logs_updated_at 
     AFTER UPDATE ON fb_conversion_logs
     BEGIN
       UPDATE fb_conversion_logs SET updated_at = CURRENT_TIMESTAMP 
       WHERE id = NEW.id;
     END`
  ];
  for (const migration of migrations) {
    try {
      await dbRun(migration);
    } catch (err) {
      console.error('Migration failed:', err);
      throw err;
    }
  }
}

// ---------------------------
// Route: Store FB Data from Landing Page
// ---------------------------
// This route is called by the landing page after it gathers fbclid, fbp, and fbc.
// It generates a unique ID and stores the data in the fb_data table.
app.post('/api/store-fb-data', async (req, res) => {
  try {
    let { fbclid, fbp, fbc } = req.body;
    const timestamp = Math.floor(Date.now() / 1000);
    // If fbp is missing or not in expected format, generate one.
    if (!fbp || !fbp.startsWith('fb.1.')) {
      fbp = `fb.1.${timestamp}.${Math.floor(Math.random() * 1e16)}`;
    }
    // If fbclid is provided and fbc is missing or not valid, generate fbc.
    if (fbclid && (!fbc || !fbc.startsWith('fb.1.'))) {
      fbc = `fb.1.${timestamp}.${fbclid}`;
    }
    // Generate a unique ID for this fb data record.
    const fbDataId = randomTransactionId();
    await dbRun(
      `INSERT INTO fb_data (id, fbclid, fbp, fbc) VALUES (?, ?, ?, ?)`,
      [fbDataId, fbclid, fbp, fbc]
    );
    console.log('Stored FB data in database:', { fbDataId, fbclid, fbp, fbc });
    return res.json({
      message: 'FB data stored in database',
      fbDataId,
      fbclid,
      fbp,
      fbc
    });
  } catch (err) {
    console.error('Error storing FB data:', err);
    return res.status(500).json({ error: 'Failed to store FB data' });
  }
});

// Optional: Route to retrieve fb data by ID for debugging
app.get('/api/get-fb-data/:id', async (req, res) => {
  try {
    const fbData = await dbGet('SELECT * FROM fb_data WHERE id = ?', [req.params.id]);
    if (!fbData) {
      return res.status(404).json({ error: 'FB data not found' });
    }
    return res.json(fbData);
  } catch (err) {
    console.error('Error retrieving FB data:', err);
    return res.status(500).json({ error: 'Failed to retrieve FB data' });
  }
});

// ---------------------------
// Donation & Redsys Payment Routes
// ---------------------------
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

// When creating a donation, expect an extra parameter "fbDataId" which tells us which FB data to attach.
app.post('/create-donation', async (req, res) => {
  try {
    const { amount, fbDataId } = req.body;
    if (!amount) {
      return res.status(400).json({ ok: false, error: 'Missing amount.' });
    }
    const orderId = randomTransactionId();
    const timestamp = Math.floor(Date.now() / 1000);
    let fbData = null;
    if (fbDataId) {
      fbData = await dbGet('SELECT * FROM fb_data WHERE id = ?', [fbDataId]);
    }
    // Use fbData if available; otherwise, generate fallback values.
    const fbclid = fbData ? fbData.fbclid : null;
    let fbp = fbData && fbData.fbp ? fbData.fbp : `fb.1.${timestamp}.${Math.floor(Math.random() * 1e16)}`;
    let fbc = fbData && fbData.fbc ? fbData.fbc : (fbclid ? `fb.1.${timestamp}.${fbclid}` : null);
    console.log('Creating donation with FB data:', { fbclid, fbp, fbc });
    const clientIp = req.headers['x-forwarded-for'] || req.connection?.remoteAddress || '';
    const userAgent = req.headers['user-agent'] || '';
    await dbRun(
      `INSERT INTO donations (
        orderId, amount, fbclid, fbp, fbc, 
        client_ip, client_user_agent
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [orderId, amount, fbclid, fbp, fbc, clientIp, userAgent]
    );
    console.log(`Created donation with orderId: ${orderId}, amount: ${amount}, FB data:`, { fbclid, fbp, fbc });
    return res.json({ ok: true, orderId });
  } catch (err) {
    console.error('Error in /create-donation:', err);
    return res.status(500).json({ ok: false, error: 'Database error.' });
  }
});

app.get('/iframe-sis', async (req, res) => {
  try {
    const { orderId } = req.query;
    if (!orderId) {
      return res.status(400).send('<h1>Error: missing orderId param</h1>');
    }
    const donation = await dbGet('SELECT * FROM donations WHERE orderId = ?', [orderId]);
    if (!donation) {
      return res.status(404).send('<h1>Error: no matching donation data</h1>');
    }
    const dsAmount = (parseFloat(donation.amount) * 100).toFixed(0);
    const params = {
      DS_MERCHANT_MERCHANTCODE: MERCHANT_CODE,
      DS_MERCHANT_TERMINAL: TERMINAL,
      DS_MERCHANT_ORDER: orderId,
      DS_MERCHANT_AMOUNT: dsAmount,
      DS_MERCHANT_CURRENCY: '978',
      DS_MERCHANT_TRANSACTIONTYPE: '0',
      DS_MERCHANT_CONSUMERLANGUAGE: '2',
      DS_MERCHANT_MERCHANTURL: MERCHANT_MERCHANTURL,
      DS_MERCHANT_URLOK: MERCHANT_URLOK,
      DS_MERCHANT_URLKO: MERCHANT_URLKO
    };
    const form = createRedirectForm(params);
    const html = 
      `<!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <title>Payment Redirect</title>
      </head>
      <body onload="document.forms[0].submit()">
        <h2>Please Wait...</h2>
        <form action="${form.url}" method="POST">
          <input type="hidden" name="Ds_SignatureVersion" value="${form.body.Ds_SignatureVersion}" />
          <input type="hidden" name="Ds_MerchantParameters" value="${form.body.Ds_MerchantParameters}" />
          <input type="hidden" name="Ds_Signature" value="${form.body.Ds_Signature}" />
        </form>
      </body>
      </html>`;
    res.send(html);
  } catch (err) {
    console.error('Error in /iframe-sis:', err);
    res.status(500).send('<h1>Error processing payment request</h1>');
  }
});

// ---------------------------
// Redsys Notification Endpoint
// ---------------------------
app.post('/api/redsys-notification', async (req, res) => {
  console.log('Received Redsys notification:', req.body);
  try {
    const result = processRedirectNotification(req.body);
    console.log('Processed Redsys notification:', result);
    const responseCode = parseInt(result.Ds_Response || '9999', 10);
    const orderId = result.Ds_Order;
    if (!orderId) {
      console.error('Missing orderId in Redsys notification');
      return res.status(400).send('Missing orderId');
    }
    await dbRun('UPDATE donations SET redsys_data = ? WHERE orderId = ?', [JSON.stringify(result), orderId]);
    if (responseCode < 100) {
      console.log(`Payment SUCCESS for order ${orderId}:`, result);
      const donation = await dbGet('SELECT * FROM donations WHERE orderId = ?', [orderId]);
      if (!donation) {
        console.error(`No donation found for orderId: ${orderId}`);
        return res.status(404).send('Donation not found');
      }
      console.log('FB tracking data for donation:', {
        orderId: donation.orderId,
        fbclid: donation.fbclid,
        fbp: donation.fbp,
        fbc: donation.fbc
      });
      if (donation.fb_conversion_sent === 0) {
        if (!donation.client_ip || !donation.client_user_agent) {
          await dbRun(
            `UPDATE donations 
             SET client_ip = COALESCE(client_ip, ?),
                 client_user_agent = COALESCE(client_user_agent, ?),
                 fbp = COALESCE(fbp, ?),
                 fbc = CASE 
                        WHEN fbclid IS NOT NULL AND fbc IS NULL 
                        THEN ? 
                        ELSE COALESCE(fbc, NULL)
                      END
             WHERE orderId = ?`,
            [
              req.headers['x-forwarded-for'] || req.connection?.remoteAddress || '',
              req.headers['user-agent'] || '',
              `fb.1.${Math.floor(Date.now() / 1000)}.${Math.floor(Math.random() * 1e16)}`,
              donation.fbclid ? `fb.1.${Math.floor(Date.now() / 1000)}.${donation.fbclid}` : null,
              orderId
            ]
          );
        }
        const updatedDonation = await dbGet('SELECT * FROM donations WHERE orderId = ?', [orderId]);
        const logResult = await dbRun(
          `INSERT INTO fb_conversion_logs (
            donation_orderId, 
            raw_payload, 
            attempts, 
            status
          ) VALUES (?, ?, ?, ?)`,
          [orderId, JSON.stringify(req.body), 0, 'pending']
        );
        console.log(`Attempting FB conversion for order ${orderId}`);
        const conversionResult = await attemptFacebookConversion(updatedDonation, req);
        const now = new Date().toISOString();
        if (conversionResult.success) {
          console.log(`FB conversion successful for order ${orderId}`);
          await dbRun(
            `UPDATE fb_conversion_logs 
             SET status = 'sent', 
                 attempts = ?, 
                 last_attempt = ? 
             WHERE id = ?`,
            [conversionResult.attempts, now, logResult.lastID]
          );
          await dbRun(
            `UPDATE donations 
             SET fb_conversion_sent = 1 
             WHERE orderId = ?`,
            [orderId]
          );
        } else {
          console.warn(`FB conversion failed for order ${orderId}:`, conversionResult.error);
          await dbRun(
            `UPDATE fb_conversion_logs 
             SET attempts = ?, 
                 last_attempt = ?, 
                 error = ? 
             WHERE id = ?`,
            [
              conversionResult.attempts,
              now,
              conversionResult.error?.message || 'Unknown error',
              logResult.lastID
            ]
          );
        }
      } else {
        console.log(`FB conversion already sent for order ${orderId}`);
      }
    } else {
      console.log(`Payment FAILED for order ${orderId}:`, result);
    }
    return res.send('OK');
  } catch (err) {
    console.error('Error processing Redsys notification:', err);
    return res.send('OK');
  }
});

// ---------------------------
// Background Worker: Retry Failed FB Conversions
// ---------------------------
let retryWorkerRunning = false;
setInterval(async () => {
  if (retryWorkerRunning) {
    console.log('Retry worker already running, skipping this iteration');
    return;
  }
  retryWorkerRunning = true;
  try {
    console.log('Running FB conversion retry worker...');
    const logs = await dbAll(
      `SELECT * FROM fb_conversion_logs 
       WHERE status != 'sent' 
         AND attempts < 3 
         AND (last_attempt IS NULL OR datetime(last_attempt) <= datetime('now', '-5 minutes'))`
    );
    console.log(`Found ${logs.length} pending FB conversions to retry`);
    for (const log of logs) {
      try {
        const donation = await dbGet("SELECT * FROM donations WHERE orderId = ?", [log.donation_orderId]);
        if (!donation) {
          console.warn(`No donation found for orderId ${log.donation_orderId}`);
          continue;
        }
        console.log(`Retrying FB conversion for order ${donation.orderId}`);
        const conversionResult = await attemptFacebookConversion(donation);
        const now = new Date().toISOString();
        if (conversionResult.success) {
          await dbRun(
            `UPDATE fb_conversion_logs 
             SET status = 'sent', 
                 attempts = ?, 
                 last_attempt = ? 
             WHERE id = ?`,
            [conversionResult.attempts, now, log.id]
          );
          await dbRun(
            `UPDATE donations 
             SET fb_conversion_sent = 1 
             WHERE orderId = ?`,
            [donation.orderId]
          );
          console.log(`Successfully retried FB conversion for order ${donation.orderId}`);
        } else {
          await dbRun(
            `UPDATE fb_conversion_logs 
             SET attempts = ?, 
                 last_attempt = ?, 
                 error = ? 
             WHERE id = ?`,
            [
              conversionResult.attempts,
              now,
              conversionResult.error?.message || 'Unknown error',
              log.id
            ]
          );
          console.warn(`Retry failed for order ${donation.orderId}: ${conversionResult.error?.message}`);
        }
      } catch (err) {
        console.error(`Error processing retry for log ID ${log.id}:`, err);
      }
    }
  } catch (err) {
    console.error("Error in FB conversion retry worker:", err);
  } finally {
    retryWorkerRunning = false;
  }
}, 60000);

// ---------------------------
// Debug Endpoint to Check Donation FB Data
// ---------------------------
app.get('/debug-donation/:orderId', async (req, res) => {
  try {
    const donation = await dbGet(
      'SELECT orderId, amount, fbclid, fbp, fbc, fb_conversion_sent FROM donations WHERE orderId = ?',
      [req.params.orderId]
    );
    if (!donation) {
      return res.status(404).json({ error: 'Donation not found' });
    }
    return res.json(donation);
  } catch (err) {
    console.error('Error in debug-donation:', err);
    return res.status(500).json({ error: 'Database error' });
  }
});

// ---------------------------
// Error Handling Middleware
// ---------------------------
app.use((req, res, next) => {
  res.status(404).json({ error: 'Route not found' });
});
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'An internal server error occurred.' });
});

// ---------------------------
// Process Error Handlers
// ---------------------------
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  setTimeout(() => {
    process.exit(1);
  }, 1000);
});
process.on('SIGTERM', () => {
  console.log('Received SIGTERM signal. Starting graceful shutdown...');
  db.close((err) => {
    if (err) {
      console.error('Error closing database:', err);
    } else {
      console.log('Database connection closed.');
    }
    process.exit(err ? 1 : 0);
  });
});

// ---------------------------
// Start the Server
// ---------------------------
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} in ${NODE_ENV} mode`);
});
