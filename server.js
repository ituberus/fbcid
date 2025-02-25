/********************************
 * server.js
 ********************************/
const express = require('express');
const path = require('path');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const morgan = require('morgan');
const { promisify } = require('util');
const bodyParser = require('body-parser');
const cors = require('cors');
const cookieParser = require('cookie-parser');
require('dotenv').config();
const crypto = require('crypto');

// Required libraries for Redsys integration
const { createRedsysAPI, SANDBOX_URLS, PRODUCTION_URLS, randomTransactionId } = require('redsys-easy');

// ------------------------------------------------------
// ENVIRONMENT VARIABLES
// ------------------------------------------------------
const FACEBOOK_PIXEL_ID = process.env.FACEBOOK_PIXEL_ID || '';
const FACEBOOK_ACCESS_TOKEN = process.env.FACEBOOK_ACCESS_TOKEN || '';
const FACEBOOK_TEST_EVENT_CODE = process.env.FACEBOOK_TEST_EVENT_CODE || '';

const SESSION_SECRET = process.env.SESSION_SECRET || 'somesecret';

const MERCHANT_CODE = process.env.MERCHANT_CODE || 'your-merchant-code';
const TERMINAL = process.env.TERMINAL || '1';
const SECRET_KEY = process.env.SECRET_KEY || 'your-secret-key';
const MERCHANT_MERCHANTURL = process.env.MERCHANT_MERCHANTURL || 'https://fbcid-production.up.railway.app/redsys-notification';
const MERCHANT_URLOK = process.env.MERCHANT_URLOK || 'https://yourdomain.com/thanks.html';
const MERCHANT_URLKO = process.env.MERCHANT_URLKO || 'https://yourdomain.com/error.html';

const REDSYS_ENVIRONMENT = process.env.REDSYS_ENVIRONMENT || 'test'; // 'test' or 'production'

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  // Allow all origins
  origin: (origin, callback) => {
    callback(null, true);
  },
  credentials: true
}));
app.use(morgan('combined'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Adjust bodyParser usage
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 7 * 24 * 60 * 60 * 1000,
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      sameSite: 'strict',
    },
  })
);

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// ------------------------------------------------------
// SQLITE SETUP
// ------------------------------------------------------
const db = new sqlite3.Database('./database.sqlite', (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
  } else {
    console.log('Connected to SQLite database.');
  }
});

const dbAll = promisify(db.all).bind(db);
const dbGet = promisify(db.get).bind(db);
const dbRun = (...args) => {
  return new Promise((resolve, reject) => {
    db.run(...args, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
};

// Create / alter tables as needed
db.serialize(() => {
  // donations table
  db.run(
    `CREATE TABLE IF NOT EXISTS donations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT UNIQUE,
      donation_amount INTEGER,
      fbclid TEXT,
      fb_conversion_sent INTEGER DEFAULT 0,
      client_ip_address TEXT,
      client_user_agent TEXT,
      fbp TEXT,
      fbc TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );

  // admin_users table
  db.run(
    `CREATE TABLE IF NOT EXISTS admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      password TEXT
    )`
  );

  // fb_conversion_logs table
  db.run(
    `CREATE TABLE IF NOT EXISTS fb_conversion_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      donation_id INTEGER,
      raw_payload TEXT,
      attempts INTEGER DEFAULT 0,
      last_attempt DATETIME,
      status TEXT DEFAULT 'pending',
      error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );

  // payment_failures table
  db.run(
    `CREATE TABLE IF NOT EXISTS payment_failures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT,
      amount INTEGER,
      error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );
});

// ------------------------------------------------------
// REDSYS SETUP
// ------------------------------------------------------
const redsysEnvUrls = REDSYS_ENVIRONMENT === 'production' ? PRODUCTION_URLS : SANDBOX_URLS;

const { createRedirectForm, processRedirectNotification } = createRedsysAPI({
  secretKey: SECRET_KEY,
  urls: redsysEnvUrls
});

// ------------------------------------------------------
// HELPER: Send to FB Conversions API
// ------------------------------------------------------
async function sendFacebookConversionEvent(donationRow) {
  const fetch = (await import('node-fetch')).default;

  // Hashing helper
  function sha256(value) {
    return crypto
      .createHash('sha256')
      .update(value.trim().toLowerCase())
      .digest('hex');
  }

  // Prepare userData
  const userData = {};

  // Include fbp and fbc
  if (donationRow.fbp) {
    userData.fbp = donationRow.fbp;
  }
  if (donationRow.fbc) {
    userData.fbc = donationRow.fbc;
  }

  // IP + user agent for better matching
  if (donationRow.client_ip_address) {
    userData.client_ip_address = donationRow.client_ip_address;
  }
  if (donationRow.client_user_agent) {
    userData.client_user_agent = donationRow.client_user_agent;
  }

  const eventSourceUrl = 'https://example.com/orderComplete'; // Adjust if necessary

  // Use the order id as event_id
  const finalEventId = donationRow.order_id || String(donationRow.id);

  const eventData = {
    event_name: 'Purchase',
    event_time: Math.floor(Date.now() / 1000),
    event_id: finalEventId,
    event_source_url: eventSourceUrl,
    action_source: 'website',
    user_data: userData,
    custom_data: {
      value: donationRow.donation_amount ? donationRow.donation_amount / 100 : 0,
      currency: 'EUR',
    },
  };

  if (donationRow.fbclid) {
    eventData.custom_data.fbclid = donationRow.fbclid;
  }

  const payload = {
    data: [eventData],
  };

  if (FACEBOOK_TEST_EVENT_CODE) {
    payload.test_event_code = FACEBOOK_TEST_EVENT_CODE;
  }

  const url = `https://graph.facebook.com/v15.0/${FACEBOOK_PIXEL_ID}/events?access_token=${FACEBOOK_ACCESS_TOKEN}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`FB API error: ${response.status} - ${errorText}`);
  }

  const result = await response.json();
  console.log('Facebook conversion result:', result);
  return { success: true, result };
}

// Exponential Backoff in attemptFacebookConversion
async function attemptFacebookConversion(donationRow) {
  const maxAttempts = 3;
  let attempt = 0;
  let lastError = null;

  while (attempt < maxAttempts) {
    try {
      const result = await sendFacebookConversionEvent(donationRow);
      if (result.success) {
        return { success: true, result, attempts: attempt + 1 };
      }
      // If it returned success=false but didn't throw, handle that
      lastError = new Error(result.error || 'Unknown error');
    } catch (err) {
      lastError = err;
    }

    attempt++;
    console.warn(
      `Attempt ${attempt} failed for donation ID ${donationRow.id}: ${lastError.message}`
    );
    // Exponential backoff: 2s, 4s, 8s...
    await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * 1000));
  }
  return { success: false, error: lastError, attempts: attempt };
}

// ------------------------------------------------------
// ROUTES
// ------------------------------------------------------

// Route to collect fbp, fbc, fbclid
app.post('/api/store-fb-data', async (req, res) => {
  try {
    let { fbclid, fbp, fbc } = req.body;

    if (!req.session) {
      return res.status(500).json({ error: 'Session not available.' });
    }

    // Generate if missing
    const timestamp = Math.floor(Date.now() / 1000);
    if (!fbp) {
      const randomPart = Math.floor(Math.random() * 1e16);
      fbp = `fb.1.${timestamp}.${randomPart}`;
    }
    if (!fbc && fbclid) {
      fbc = `fb.1.${timestamp}.${fbclid}`;
    }

    // Store in session
    req.session.fbp = fbp;
    req.session.fbc = fbc;
    req.session.fbclid = fbclid || null;

    return res.json({
      message: 'FB data stored in session',
      fbclid,
      fbp,
      fbc
    });
  } catch (err) {
    console.error('Error storing FB data:', err);
    return res.status(500).json({ error: 'Failed to store FB data' });
  }
});

// Endpoint to create a donation and store donor data in SQLite
app.post('/create-donation', async (req, res) => {
  try {
    const { amount } = req.body;

    if (!amount) {
      return res.status(400).json({ error: 'Missing donation amount.' });
    }

    // Generate a unique order ID
    const orderId = randomTransactionId();

    // Retrieve fbp, fbc, fbclid from session
    const fbp = req.session ? req.session.fbp || null : null;
    const fbc = req.session ? req.session.fbc || null : null;
    const fbclid = req.session ? req.session.fbclid || null : null;

    // Get client IP and user agent
    const clientIp =
      req.headers['x-forwarded-for'] ||
      req.connection?.remoteAddress ||
      req.socket?.remoteAddress ||
      '';
    const clientUserAgent = req.headers['user-agent'] || '';

    // Convert amount to cents (assuming amount in Euros)
    const amountCents = Math.round(Number(amount) * 100);
    if (isNaN(amountCents) || amountCents <= 0) {
      return res.status(400).json({ error: 'Invalid donation amount.' });
    }

    // Insert donation data into SQLite
    await dbRun(
      `INSERT INTO donations (
        order_id,
        donation_amount,
        fbclid,
        fbp,
        fbc,
        client_ip_address,
        client_user_agent,
        fb_conversion_sent
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        orderId,
        amountCents,
        fbclid,
        fbp,
        fbc,
        clientIp,
        clientUserAgent,
        0,
      ]
    );

    // Generate the parameters for Redsys
    const params = {
      DS_MERCHANT_MERCHANTCODE: MERCHANT_CODE,
      DS_MERCHANT_TERMINAL: TERMINAL,
      DS_MERCHANT_ORDER: orderId,
      DS_MERCHANT_AMOUNT: amountCents,
      DS_MERCHANT_CURRENCY: '978', // EUR
      DS_MERCHANT_TRANSACTIONTYPE: '0',
      DS_MERCHANT_CONSUMERLANGUAGE: '2',
      DS_MERCHANT_MERCHANTURL: MERCHANT_MERCHANTURL,
      DS_MERCHANT_URLOK: MERCHANT_URLOK,
      DS_MERCHANT_URLKO: MERCHANT_URLKO
    };

    const form = createRedirectForm(params);

    // Send back the form data to the frontend, so the frontend can redirect
    res.json({ ok: true, form });

  } catch (err) {
    console.error('Error in /create-donation:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Endpoint to initiate Redsys payment via an iframe redirect
app.get('/iframe-sis', async (req, res, next) => {
  try {
    const { orderId } = req.query;
    if (!orderId) {
      return res.status(400).send('<h1>Error: missing orderId param</h1>');
    }
    // Retrieve donation data from SQLite
    const donation = await dbGet('SELECT * FROM donations WHERE order_id = ?', [orderId]);
    if (!donation) {
      return res.status(404).send('<h1>Error: no matching donor data</h1>');
    }
    // Amount is already in cents
    const amountCents = donation.donation_amount;

    const params = {
      DS_MERCHANT_MERCHANTCODE: MERCHANT_CODE,
      DS_MERCHANT_TERMINAL: TERMINAL,
      DS_MERCHANT_ORDER: orderId,
      DS_MERCHANT_AMOUNT: amountCents,
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
    next(err);
  }
});

// Redsys payment notification endpoint
app.post('/redsys-notification', async (req, res, next) => {
  try {
    const result = processRedirectNotification(req.body);
    const responseCode = parseInt(result.Ds_Response || '9999', 10);
    if (responseCode < 100) {
      // Log successful payment details to the console
      console.log('Payment SUCCESS:', result);

      const orderId = result.Ds_Order;
      const amountCents = parseInt(result.Ds_Amount);
      // Retrieve the donation from the database using the orderId
      const donation = await dbGet('SELECT * FROM donations WHERE order_id = ?', [orderId]);
      if (!donation) {
        console.warn(`Donation not found for order ID: ${orderId}`);
        return res.send('OK');
      }

      // If we already sent the conversion
      if (donation.fb_conversion_sent === 1) {
        console.log('Already sent conversion for that donation.');
        return res.send('OK');
      }

      // Update donation amount in case it's different
      if (donation.donation_amount !== amountCents) {
        await dbRun(
          'UPDATE donations SET donation_amount = ? WHERE id = ?',
          [amountCents, donation.id]
        );
        donation.donation_amount = amountCents;
      }

      // Log payload
      const rawPayload = JSON.stringify(req.body);
      const insertLogResult = await dbRun(
        `INSERT INTO fb_conversion_logs (donation_id, raw_payload, attempts, status)
         VALUES (?, ?, ?, ?)`,
        [donation.id, rawPayload, 0, 'pending']
      );
      const logId = insertLogResult.lastID;

      // Attempt FB conversion with retry
      const conversionResult = await attemptFacebookConversion(donation);
      const now = new Date().toISOString();

      if (conversionResult.success) {
        // Mark success
        await dbRun(
          `UPDATE fb_conversion_logs
           SET status = 'sent', attempts = ?, last_attempt = ?
           WHERE id = ?`,
          [conversionResult.attempts, now, logId]
        );
        await dbRun(
          `UPDATE donations
           SET fb_conversion_sent = 1
           WHERE id = ?`,
          [donation.id]
        );
      } else {
        // Mark failure
        await dbRun(
          `UPDATE fb_conversion_logs
           SET attempts = ?, last_attempt = ?, error = ?
           WHERE id = ?`,
          [
            conversionResult.attempts,
            now,
            conversionResult.error ? conversionResult.error.message : '',
            logId,
          ]
        );
      }

      return res.send('OK');
    } else {
      // Do not log failed payment details
      console.warn('Payment Failed or Rejected:', result);
      return res.send('OK');
    }
  } catch (err) {
    console.error('Error in /redsys-notification:', err);
    next(err);
  }
});

// ADMIN AUTH & ENDPOINTS
// ... (Keep as in your original code)
// ...

// BACKGROUND WORKER: Retry Pending FB Conversions
setInterval(async () => {
  try {
    const logs = await dbAll("SELECT * FROM fb_conversion_logs WHERE status != 'sent'");
    for (const log of logs) {
      const donationRow = await dbGet("SELECT * FROM donations WHERE id = ?", [log.donation_id]);
      if (!donationRow) continue;
      const result = await attemptFacebookConversion(donationRow);
      const now = new Date().toISOString();
      if (result.success) {
        await dbRun(
          "UPDATE fb_conversion_logs SET status = 'sent', attempts = ?, last_attempt = ? WHERE id = ?",
          [result.attempts, now, log.id]
        );
        await dbRun(
          "UPDATE donations SET fb_conversion_sent = 1 WHERE id = ?",
          [donationRow.id]
        );
        console.log(`Successfully retried FB conversion for donation id ${donationRow.id}`);
      } else {
        await dbRun(
          "UPDATE fb_conversion_logs SET attempts = ?, last_attempt = ?, error = ? WHERE id = ?",
          [result.attempts, now, result.error ? result.error.message : '', log.id]
        );
        console.warn(`Retry pending for donation id ${donationRow.id}`);
      }
    }
  } catch (err) {
    console.error("Error processing pending FB conversions:", err);
  }
}, 60000);

// ERROR HANDLING MIDDLEWARE
app.use((err, req, res, next) => {
  console.error('Unhandled error in middleware:', err);
  res.status(500).json({ error: 'An internal server error occurred.' });
});

// GLOBAL PROCESS ERROR HANDLERS
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

// START THE SERVER
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
