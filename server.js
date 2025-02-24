/********************************
 * server.js
 ********************************/
require('dotenv').config();

// ---------------------------
// Required Libraries & Modules
// ---------------------------
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

// Redsys Easy – using sandbox URLs for test mode
const { createRedsysAPI, SANDBOX_URLS, randomTransactionId } = require('redsys-easy');

// ---------------------------
// Environment Variables & Configuration
// ---------------------------
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'somesecret';

const FACEBOOK_PIXEL_ID = process.env.FACEBOOK_PIXEL_ID || ''; // e.g., "1155603432794001"
const FACEBOOK_ACCESS_TOKEN = process.env.FACEBOOK_ACCESS_TOKEN || '';
const FACEBOOK_TEST_EVENT_CODE = process.env.FACEBOOK_TEST_EVENT_CODE || '';

// Redsys configuration – adjust callback URLs as needed
const MERCHANT_CODE = process.env.MERCHANT_CODE || '367149531';
const TERMINAL = process.env.TERMINAL || '1';
const SECRET_KEY = process.env.SECRET_KEY || 'sq7HjrUOBfKmC576ILgskD5srU870gJ7';
const MERCHANT_MERCHANTURL = process.env.MERCHANT_MERCHANTURL || 'https://yourdomain.com/redsys-notification';
const MERCHANT_URLOK = process.env.MERCHANT_URLOK || 'https://yourdomain.com/thanks.html';
const MERCHANT_URLKO = process.env.MERCHANT_URLKO || 'https://yourdomain.com/error.html';

// Create Redsys API instance
const { createRedirectForm, processRedirectNotification } = createRedsysAPI({
  secretKey: SECRET_KEY,
  urls: SANDBOX_URLS
});

// ---------------------------
// Express App & Middlewares
// ---------------------------
const app = express();

app.use(cors({
  origin: true,
  credentials: true
}));
app.use(morgan('combined'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Use SQLite store for sessions (stored in sessions.sqlite)
app.use(session({
  store: new SQLiteStore({ dir: './', db: 'sessions.sqlite' }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000,
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'strict'
  }
}));

// Serve static files – assume landing page (and others) are in the "views" folder
app.use(express.static(path.join(__dirname, 'views')));

// ---------------------------
// SQLite Database Setup
// ---------------------------
const db = new sqlite3.Database('./database.sqlite', (err) => {
  if (err) {
    console.error('Error opening database:', err);
  } else {
    console.log('Connected to SQLite database.');
  }
});

// Promisify some database functions
const dbRun = (...args) => {
  return new Promise((resolve, reject) => {
    db.run(...args, function(err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
};
const dbGet = (...args) => {
  return new Promise((resolve, reject) => {
    db.get(...args, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
};
const dbAll = (...args) => {
  return new Promise((resolve, reject) => {
    db.all(...args, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
};

// Create/alter tables as needed
db.serialize(() => {
  // Donations table – tracking minimal data for Redsys payment and FB conversion
  db.run(
    `CREATE TABLE IF NOT EXISTS donations (
      orderId TEXT PRIMARY KEY,
      amount REAL,
      fbclid TEXT,
      fbp TEXT,
      fbc TEXT,
      redsys_data TEXT,
      fb_conversion_sent INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );
  // FB Conversion Logs for retries
  db.run(
    `CREATE TABLE IF NOT EXISTS fb_conversion_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      donation_orderId TEXT,
      raw_payload TEXT,
      attempts INTEGER DEFAULT 0,
      last_attempt DATETIME,
      status TEXT DEFAULT 'pending',
      error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );
});

// ---------------------------
// Helper: Send Facebook Conversion Event
// ---------------------------
// This function sends minimal data: fbp, fbc (and optionally fbclid), amount in EUR.
async function sendFacebookConversionEvent(donation) {
  // If missing fbp/fbc, generate them now (using current timestamp & random part)
  const timestamp = Math.floor(Date.now() / 1000);
  if (!donation.fbp) {
    const randomPart = Math.floor(Math.random() * 1e16);
    donation.fbp = `fb.1.${timestamp}.${randomPart}`;
    console.log(`Generated missing fbp for order ${donation.orderId}: ${donation.fbp}`);
  }
  if (!donation.fbc && donation.fbclid) {
    donation.fbc = `fb.1.${timestamp}.${donation.fbclid}`;
    console.log(`Generated missing fbc for order ${donation.orderId}: ${donation.fbc}`);
  }
  // Log current fb data for debugging
  console.log(`Sending FB conversion for order ${donation.orderId} with fbp: ${donation.fbp} and fbc: ${donation.fbc}`);

  // Dynamically import node-fetch (ESM style)
  const { default: fetch } = await import('node-fetch');

  const eventData = {
    event_name: 'Purchase',
    event_time: Math.floor(Date.now() / 1000),
    event_id: donation.orderId,
    event_source_url: MERCHANT_URLOK, // or adjust to your order-complete page
    action_source: 'website',
    user_data: {
      fbp: donation.fbp,
      fbc: donation.fbc,
    },
    custom_data: {
      value: donation.amount, // amount in EUR
      currency: 'EUR'
    }
  };
  if (donation.fbclid) {
    eventData.custom_data.fbclid = donation.fbclid;
  }

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
  return { success: true, result };
}

// Exponential backoff retry for sending FB conversion
async function attemptFacebookConversion(donation) {
  const maxAttempts = 3;
  let attempt = 0;
  let lastError = null;
  while (attempt < maxAttempts) {
    try {
      const result = await sendFacebookConversionEvent(donation);
      if (result.success) {
        return { success: true, result, attempts: attempt + 1 };
      }
      lastError = new Error(result.error || 'Unknown error');
    } catch (err) {
      lastError = err;
    }
    attempt++;
    console.warn(`Attempt ${attempt} failed for order ${donation.orderId}: ${lastError.message}`);
    // Exponential backoff: 2s, 4s, 8s...
    await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
  }
  return { success: false, error: lastError, attempts: attempt };
}

// ---------------------------
// Endpoints for Facebook Data Collection
// ---------------------------

// This endpoint receives fbclid, fbp, and fbc from the landing page.
// It logs the received values and stores them in the session.
app.post('/api/store-fb-data', (req, res) => {
  try {
    let { fbclid, fbp, fbc } = req.body;
    if (!req.session) {
      return res.status(500).json({ error: 'Session not available.' });
    }
    console.log('Received FB data:', { fbclid, fbp, fbc });
    const timestamp = Math.floor(Date.now() / 1000);
    if (!fbp) {
      const randomPart = Math.floor(Math.random() * 1e16);
      fbp = `fb.1.${timestamp}.${randomPart}`;
      console.log(`Generated fbp: ${fbp}`);
    }
    if (!fbc && fbclid) {
      fbc = `fb.1.${timestamp}.${fbclid}`;
      console.log(`Generated fbc: ${fbc}`);
    }
    req.session.fbp = fbp;
    req.session.fbc = fbc;
    req.session.fbclid = fbclid || null;
    return res.json({ message: 'FB data stored in session', fbclid, fbp, fbc });
  } catch (err) {
    console.error('Error storing FB data:', err);
    return res.status(500).json({ error: 'Failed to store FB data' });
  }
});

// Retrieve stored FB data from the session
app.get('/api/get-fb-data', (req, res) => {
  try {
    if (!req.session) {
      return res.status(500).json({ error: 'Session not available.' });
    }
    const { fbp, fbc, fbclid } = req.session;
    return res.json({ fbp: fbp || null, fbc: fbc || null, fbclid: fbclid || null });
  } catch (err) {
    console.error('Error retrieving FB data:', err);
    return res.status(500).json({ error: 'Failed to retrieve FB data' });
  }
});

// ---------------------------
// Donation & Redsys Payment Routes
// ---------------------------

// Serve the landing page (index.html)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

// Endpoint to create a donation record.
// Expects { amount } in the body. Also captures fb data from the session.
app.post('/create-donation', async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount) {
      return res.status(400).json({ ok: false, error: 'Missing amount.' });
    }
    // Generate a unique orderId using Redsys helper
    const orderId = randomTransactionId();
    const fbclid = req.session ? req.session.fbclid : null;
    const fbp = req.session ? req.session.fbp : null;
    const fbc = req.session ? req.session.fbc : null;
    await dbRun(
      'INSERT INTO donations (orderId, amount, fbclid, fbp, fbc) VALUES (?, ?, ?, ?, ?)',
      [orderId, amount, fbclid, fbp, fbc]
    );
    console.log(`Created donation with orderId: ${orderId} and amount: ${amount}`);
    return res.json({ ok: true, orderId });
  } catch (err) {
    console.error('Error in /create-donation:', err);
    return res.status(500).json({ ok: false, error: 'Database error.' });
  }
});

// Endpoint to initiate Redsys payment via an iframe redirect.
// It looks up the donation record by orderId and builds the Redsys form.
app.get('/iframe-sis', async (req, res, next) => {
  try {
    const { orderId } = req.query;
    if (!orderId) {
      return res.status(400).send('<h1>Error: missing orderId param</h1>');
    }
    const donation = await dbGet('SELECT * FROM donations WHERE orderId = ?', [orderId]);
    if (!donation) {
      return res.status(404).send('<h1>Error: no matching donation data</h1>');
    }
    // Redsys expects the amount in cents (integer)
    const dsAmount = (parseFloat(donation.amount) * 100).toFixed(0);
    const params = {
      DS_MERCHANT_MERCHANTCODE: MERCHANT_CODE,
      DS_MERCHANT_TERMINAL: TERMINAL,
      DS_MERCHANT_ORDER: orderId,
      DS_MERCHANT_AMOUNT: dsAmount,
      DS_MERCHANT_CURRENCY: '978', // EUR
      DS_MERCHANT_TRANSACTIONTYPE: '0',
      DS_MERCHANT_CONSUMERLANGUAGE: '2',
      DS_MERCHANT_PERSOCODE: '1234',
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

// Redsys payment notification endpoint.
// When payment is successful (Ds_Response < 100), log the payment,
// update the donation record with the Redsys payload, and trigger the Facebook conversion.
app.post('/redsys-notification', async (req, res, next) => {
  try {
    const result = processRedirectNotification(req.body);
    const responseCode = parseInt(result.Ds_Response || '9999', 10);
    if (responseCode < 100) {
      console.log('Payment SUCCESS:', result);
      const orderId = result.Ds_Order;
      // Update donation record with the Redsys payload
      await dbRun('UPDATE donations SET redsys_data = ? WHERE orderId = ?', [JSON.stringify(result), orderId]);
      // Retrieve the donation record
      const donation = await dbGet('SELECT * FROM donations WHERE orderId = ?', [orderId]);
      if (donation && donation.fb_conversion_sent == 0) {
        // Log the raw notification payload for conversion retry tracking
        const rawPayload = JSON.stringify(req.body);
        const logResult = await dbRun(
          `INSERT INTO fb_conversion_logs (donation_orderId, raw_payload, attempts, status)
           VALUES (?, ?, ?, ?)`,
          [orderId, rawPayload, 0, 'pending']
        );
        // Attempt FB conversion (which will generate missing fbp/fbc if needed)
        const conversionResult = await attemptFacebookConversion(donation);
        const now = new Date().toISOString();
        if (conversionResult.success) {
          await dbRun(
            `UPDATE fb_conversion_logs SET status = 'sent', attempts = ?, last_attempt = ?
             WHERE id = ?`,
            [conversionResult.attempts, now, logResult.lastID]
          );
          await dbRun('UPDATE donations SET fb_conversion_sent = 1 WHERE orderId = ?', [orderId]);
        } else {
          await dbRun(
            `UPDATE fb_conversion_logs SET attempts = ?, last_attempt = ?, error = ?
             WHERE id = ?`,
            [conversionResult.attempts, now, conversionResult.error ? conversionResult.error.message : '', logResult.lastID]
          );
        }
      }
      return res.send('OK');
    } else {
      console.log('Payment FAILED:', result);
      return res.send('OK');
    }
  } catch (err) {
    console.error('Error in /redsys-notification:', err);
    next(err);
  }
});

// ---------------------------
// Background Worker: Retry Pending FB Conversions
// ---------------------------
setInterval(async () => {
  try {
    const logs = await dbAll("SELECT * FROM fb_conversion_logs WHERE status != 'sent'");
    for (const log of logs) {
      const donation = await dbGet("SELECT * FROM donations WHERE orderId = ?", [log.donation_orderId]);
      if (!donation) continue;
      const conversionResult = await attemptFacebookConversion(donation);
      const now = new Date().toISOString();
      if (conversionResult.success) {
        await dbRun("UPDATE fb_conversion_logs SET status = 'sent', attempts = ?, last_attempt = ? WHERE id = ?", [conversionResult.attempts, now, log.id]);
        await dbRun("UPDATE donations SET fb_conversion_sent = 1 WHERE orderId = ?", [donation.orderId]);
        console.log(`Successfully retried FB conversion for order ${donation.orderId}`);
      } else {
        await dbRun("UPDATE fb_conversion_logs SET attempts = ?, last_attempt = ?, error = ? WHERE id = ?", [conversionResult.attempts, now, conversionResult.error ? conversionResult.error.message : '', log.id]);
        console.warn(`Retry pending for order ${donation.orderId}`);
      }
    }
  } catch (err) {
    console.error("Error processing pending FB conversions:", err);
  }
}, 60000);

// ---------------------------
// Global Error Handling Middleware
// ---------------------------
app.use((err, req, res, next) => {
  console.error('Unhandled error in middleware:', err);
  res.status(500).json({ error: 'An internal server error occurred.' });
});

// Global process error handlers
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

// ---------------------------
// Start the Server
// ---------------------------
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
