require('dotenv').config();

const express = require('express');
const path = require('path');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const sqlite3 = require('sqlite3').verbose();
const morgan = require('morgan');
const { promisify } = require('util');
const bodyParser = require('body-parser');
const cors = require('cors');
const cookieParser = require('cookie-parser');
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
    // Check cache first
    const cachedResult = ipCountryCache.get(ip);
    if (cachedResult && cachedResult.timestamp > Date.now() - IP_CACHE_DURATION) {
      return cachedResult.country;
    }

    let attempts = 0;
    let country = 'unknown';

    // Try services in round-robin fashion until one works
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

    // Cache the result
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
const SESSION_SECRET = process.env.SESSION_SECRET || 'somesecret';
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

// Enable trust proxy if behind a reverse proxy
app.set('trust proxy', true);

app.use(cors({
  origin: true,
  credentials: true
}));
app.use(morgan(NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// IMPORTANT: Initialize session middleware BEFORE any middleware that uses req.session
app.use(session({
  store: new SQLiteStore({
    dir: './',
    db: 'sessions.sqlite',
    table: 'sessions'
  }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: true, // so that session is stored
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000,
    secure: NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax'
  }
}));

// ---------------------------
// Facebook Parameter Capture Middleware
// ---------------------------
// This middleware checks for fbclid in the query string and, if found, ensures
// we have fbc and fbp in the session. We do *not* overwrite existing session data.
// We only generate if it's missing.
app.use((req, res, next) => {
  try {
    const fbclid = req.query.fbclid;
    if (req.session) {
      // If we found a new fbclid, store it (overwriting old one)
      if (fbclid) {
        req.session.fbclid = fbclid;
      }
      // If we have a fbclid but no fbc, generate it
      if (req.session.fbclid && !req.session.fbc) {
        const timestamp = Math.floor(Date.now() / 1000);
        req.session.fbc = `fb.1.${timestamp}.${req.session.fbclid}`;
      }
      // If no fbp in session, generate one
      if (!req.session.fbp) {
        const timestamp = Math.floor(Date.now() / 1000);
        req.session.fbp = `fb.1.${timestamp}.${Math.floor(Math.random() * 1e16)}`;
      }

      req.session.save((err) => {
        if (err) {
          console.error('Error saving FB params to session:', err);
        } else {
          console.log('Session after param capture:', {
            fbclid: req.session.fbclid,
            fbc: req.session.fbc,
            fbp: req.session.fbp
          });
        }
        next();
      });
      return;
    }
  } catch (err) {
    console.error('Error in FB param capture middleware:', err);
  }
  next();
});

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

// Promisify database functions
const dbRun = (...args) => new Promise((resolve, reject) => {
  db.run(...args, function(err) {
    if (err) return reject(err);
    resolve(this);
  });
});
const dbGet = promisify(db.get).bind(db);
const dbAll = promisify(db.all).bind(db);

// Initialize database schema and perform migrations
async function initializeDatabase() {
  const migrations = [
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
// Helper: Send Facebook Conversion Event
// ---------------------------
async function sendFacebookConversionEvent(donation, req = null) {
  try {
    if (!FACEBOOK_PIXEL_ID || !FACEBOOK_ACCESS_TOKEN) {
      throw new Error('Facebook configuration missing');
    }

    // Log the raw FB data from the donation
    console.log('Raw donation FB data:', {
      fbclid: donation.fbclid,
      fbp: donation.fbp,
      fbc: donation.fbc
    });

    let { fbclid, fbp, fbc } = donation;
    const timestamp = Math.floor(Date.now() / 1000);

    // If no fbp, generate one (but don't overwrite if already present)
    if (!fbp) {
      fbp = `fb.1.${timestamp}.${Math.floor(Math.random() * 1e16)}`;
      await dbRun('UPDATE donations SET fbp = ? WHERE orderId = ?', [fbp, donation.orderId]);
    }

    // If we have fbclid but no fbc, generate it
    if (fbclid && !fbc) {
      fbc = `fb.1.${timestamp}.${fbclid}`;
      console.log(`Generated fbc for order ${donation.orderId}: ${fbc}`);
      await dbRun('UPDATE donations SET fbc = ? WHERE orderId = ?', [fbc, donation.orderId]);
    }

    // We parse the donation.amount or, if available, parse from Redsys data
    let amount = donation.amount;
    if (donation.redsys_data) {
      try {
        const redsysData = JSON.parse(donation.redsys_data);
        amount = parseInt(redsysData.Ds_Amount, 10) / 100;
      } catch (err) {
        console.warn('Error parsing Redsys data:', err);
      }
    }

    // Get client info
    const clientIp = donation.client_ip || (req && (req.headers['x-forwarded-for'] || req.connection?.remoteAddress)) || '';
    const userAgent = donation.client_user_agent || (req && req.headers['user-agent']) || '';

    // Hash country (from IP lookup)
    const country = await getCountryFromIP(clientIp);
    const hashedCountry = crypto.createHash('sha256').update(country).digest('hex');

    // Build the user_data object
    const user_data = {
      client_ip_address: clientIp,
      client_user_agent: userAgent,
      fbp,
      // Store hashed country for better matching, e.g. user_data.country
      country: hashedCountry
    };
    if (fbc) {
      user_data.fbc = fbc;
    }

    const eventData = {
      event_name: 'Purchase',
      event_time: timestamp,
      event_id: donation.orderId,
      event_source_url: MERCHANT_URLOK, // or any relevant URL
      action_source: 'website',
      user_data,
      custom_data: {
        value: parseFloat(amount), // fallback to donation.amount if needed
        currency: 'EUR',
        ...(fbclid ? { fbclid } : {})
      }
    };

    console.log('Sending FB conversion event with data:', JSON.stringify(eventData, null, 2));

    const payload = { data: [eventData] };
    if (FACEBOOK_TEST_EVENT_CODE) {
      payload.test_event_code = FACEBOOK_TEST_EVENT_CODE;
    }

    const url = `https://graph.facebook.com/v15.0/${FACEBOOK_PIXEL_ID}/events?access_token=${FACEBOOK_ACCESS_TOKEN}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`FB API error: ${response.status} - ${errorText}`);
    }

    const result = await response.json();
    console.log('Facebook conversion result:', result);

    if (result.events_received !== 1) {
      throw new Error(`Expected 1 event received, got ${result.events_received}`);
    }

    return { success: true, result };
  } catch (err) {
    console.error('Error sending Facebook conversion event:', err);
    return { success: false, error: err };
  }
}

// Exponential backoff retry for FB conversion
async function attemptFacebookConversion(donation, req = null) {
  const maxAttempts = 3;
  let attempt = 0;
  let lastError = null;

  while (attempt < maxAttempts) {
    try {
      const result = await sendFacebookConversionEvent(donation, req);
      if (result.success) {
        console.log(`Successfully sent FB conversion for order ${donation.orderId} on attempt ${attempt + 1}`);
        return { success: true, result, attempts: attempt + 1 };
      }
      lastError = new Error(result.error || 'Unknown error');
    } catch (err) {
      console.error(`FB conversion attempt ${attempt + 1} failed for order ${donation.orderId}:`, err);
      lastError = err;
    }

    attempt++;
    if (attempt < maxAttempts) {
      const delay = Math.pow(2, attempt) * 1000;
      console.log(`Waiting ${delay}ms before retry ${attempt + 1} for order ${donation.orderId}`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  return { success: false, error: lastError, attempts: attempt };
}

// ---------------------------
// Facebook Data Collection Routes
// ---------------------------
app.post('/api/store-fb-data', async (req, res) => {
  try {
    let { fbclid, fbp, fbc } = req.body;
    if (!req.session) {
      return res.status(500).json({ error: 'Session not available.' });
    }

    console.log('Received FB data from landing page:', { fbclid, fbp, fbc });

    // Only generate if missing - do NOT overwrite existing values
    const timestamp = Math.floor(Date.now() / 1000);

    // If we get a new fbclid, store it
    if (fbclid) {
      req.session.fbclid = fbclid;
    }
    // If no fbc but we do have fbclid, generate
    if (!req.session.fbc && fbclid) {
      req.session.fbc = `fb.1.${timestamp}.${fbclid}`;
      console.log(`Generated fbc: ${req.session.fbc}`);
    }
    // If an fbc is sent from the client, store it (but only if we currently have none).
    // If you want to let the client override, you'd do an assignment, but let's keep your rule of "don’t overwrite."
    if (!req.session.fbc && fbc) {
      req.session.fbc = fbc;
    }

    // If no fbp is in session but the client sent one, store it
    if (!req.session.fbp && fbp) {
      req.session.fbp = fbp;
    }
    // If STILL no fbp, generate it
    if (!req.session.fbp) {
      req.session.fbp = `fb.1.${timestamp}.${Math.floor(Math.random() * 1e16)}`;
      console.log(`Generated fbp: ${req.session.fbp}`);
    }

    // Save session
    await new Promise((resolve, reject) => {
      req.session.save(err => {
        if (err) reject(err);
        else resolve();
      });
    });

    console.log('Stored FB data in session:', {
      fbclid: req.session.fbclid || null,
      fbc: req.session.fbc || null,
      fbp: req.session.fbp || null
    });

    return res.json({
      message: 'FB data stored in session',
      fbclid: req.session.fbclid,
      fbp: req.session.fbp,
      fbc: req.session.fbc
    });
  } catch (err) {
    console.error('Error storing FB data:', err);
    return res.status(500).json({ error: 'Failed to store FB data' });
  }
});

app.get('/api/get-fb-data', (req, res) => {
  try {
    if (!req.session) {
      return res.status(500).json({ error: 'Session not available.' });
    }
    const { fbclid, fbc, fbp } = req.session;
    return res.json({
      fbclid: fbclid || null,
      fbc: fbc || null,
      fbp: fbp || null
    });
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

app.post('/create-donation', async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount) {
      return res.status(400).json({ ok: false, error: 'Missing amount.' });
    }

    // Generate a unique orderId (Redsys format)
    const orderId = randomTransactionId();

    // Pull FB data from session:
    const fbclid = req.session?.fbclid || null;
    const fbc = req.session?.fbc || null;
    const fbp = req.session?.fbp || null;

    console.log('FB data at donation creation time:', { fbclid, fbc, fbp });

    // Save to DB
    const clientIp = req.headers['x-forwarded-for'] || req.connection?.remoteAddress || '';
    const userAgent = req.headers['user-agent'] || '';

    await dbRun(`
      INSERT INTO donations (
        orderId, amount, fbclid, fbp, fbc, client_ip, client_user_agent
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      orderId, amount, fbclid, fbp, fbc, clientIp, userAgent
    ]);

    console.log(`Created donation. orderId=${orderId}, amount=${amount}, fbclid=${fbclid}, fbc=${fbc}, fbp=${fbp}`);

    return res.json({ ok: true, orderId });
  } catch (err) {
    console.error('Error creating donation:', err);
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
      DS_MERCHANT_CURRENCY: '978', // EUR
      DS_MERCHANT_TRANSACTIONTYPE: '0',
      DS_MERCHANT_CONSUMERLANGUAGE: '2',
      DS_MERCHANT_MERCHANTURL: MERCHANT_MERCHANTURL,
      DS_MERCHANT_URLOK: MERCHANT_URLOK,
      DS_MERCHANT_URLKO: MERCHANT_URLKO
    };

    const form = createRedirectForm(params);
    
    const html = `
      <!DOCTYPE html>
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
      </html>
    `;
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
    // Process the data from Redsys
    const result = processRedirectNotification(req.body);
    console.log('Processed Redsys notification:', result);

    const responseCode = parseInt(result.Ds_Response || '9999', 10);
    const orderId = result.Ds_Order;

    if (!orderId) {
      console.error('Missing orderId in Redsys notification');
      return res.status(400).send('Missing orderId');
    }

    // Store raw Redsys data
    await dbRun('UPDATE donations SET redsys_data = ? WHERE orderId = ?', [
      JSON.stringify(result), orderId
    ]);

    // Payment successful?
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

      // If not yet converted, attempt FB conversion
      if (donation.fb_conversion_sent === 0) {
        // Possibly update IP/User-Agent if not set
        if (!donation.client_ip || !donation.client_user_agent) {
          await dbRun(`
            UPDATE donations
            SET
              client_ip = COALESCE(client_ip, ?),
              client_user_agent = COALESCE(client_user_agent, ?)
            WHERE orderId = ?
          `, [
            req.headers['x-forwarded-for'] || req.connection?.remoteAddress || '',
            req.headers['user-agent'] || '',
            orderId
          ]);
        }

        // Re-fetch updated donation
        const updatedDonation = await dbGet('SELECT * FROM donations WHERE orderId = ?', [orderId]);

        // Log the raw notification
        const insertLog = await dbRun(`
          INSERT INTO fb_conversion_logs (donation_orderId, raw_payload, attempts, status)
          VALUES (?, ?, ?, ?)
        `, [
          orderId,
          JSON.stringify(req.body),
          0,
          'pending'
        ]);

        console.log(`Attempting FB conversion for order ${orderId}`);
        const conversionResult = await attemptFacebookConversion(updatedDonation, req);
        const now = new Date().toISOString();

        if (conversionResult.success) {
          console.log(`FB conversion successful for order ${orderId}`);
          // Mark log as sent
          await dbRun(`
            UPDATE fb_conversion_logs
            SET status = 'sent', attempts = ?, last_attempt = ?
            WHERE id = ?
          `, [
            conversionResult.attempts,
            now,
            insertLog.lastID
          ]);
          // Mark donation
          await dbRun(`
            UPDATE donations
            SET fb_conversion_sent = 1
            WHERE orderId = ?
          `, [orderId]);
        } else {
          console.warn(`FB conversion failed for order ${orderId}:`, conversionResult.error);
          await dbRun(`
            UPDATE fb_conversion_logs
            SET attempts = ?, last_attempt = ?, error = ?
            WHERE id = ?
          `, [
            conversionResult.attempts,
            now,
            conversionResult.error?.message || 'Unknown error',
            insertLog.lastID
          ]);
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
    const logs = await dbAll(`
      SELECT *
      FROM fb_conversion_logs
      WHERE status != 'sent'
        AND attempts < 3
        AND (last_attempt IS NULL OR datetime(last_attempt) <= datetime('now', '-5 minutes'))
    `);

    console.log(`Found ${logs.length} pending FB conversions to retry`);

    for (const log of logs) {
      try {
        const donation = await dbGet(`
          SELECT *
          FROM donations
          WHERE orderId = ?
        `, [log.donation_orderId]);

        if (!donation) {
          console.warn(`No donation found for orderId ${log.donation_orderId}`);
          continue;
        }

        console.log(`Retrying FB conversion for order ${donation.orderId}`);
        const conversionResult = await attemptFacebookConversion(donation);
        const now = new Date().toISOString();

        if (conversionResult.success) {
          await dbRun(`
            UPDATE fb_conversion_logs
            SET status = 'sent', attempts = ?, last_attempt = ?
            WHERE id = ?
          `, [
            conversionResult.attempts,
            now,
            log.id
          ]);
          await dbRun(`
            UPDATE donations
            SET fb_conversion_sent = 1
            WHERE orderId = ?
          `, [donation.orderId]);
          console.log(`Successfully retried FB conversion for order ${donation.orderId}`);
        } else {
          await dbRun(`
            UPDATE fb_conversion_logs
            SET attempts = ?, last_attempt = ?, error = ?
            WHERE id = ?
          `, [
            conversionResult.attempts,
            now,
            conversionResult.error?.message || 'Unknown error',
            log.id
          ]);
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
}, 60000); // Run every minute

// ---------------------------
// Debug Endpoint
// ---------------------------
app.get('/debug-donation/:orderId', async (req, res) => {
  try {
    const donation = await dbGet(`
      SELECT orderId, amount, fbclid, fbp, fbc, fb_conversion_sent
      FROM donations
      WHERE orderId = ?
    `, [req.params.orderId]);

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

// Graceful shutdown
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
