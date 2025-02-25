const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const morgan = require('morgan');
const { promisify } = require('util');
const bodyParser = require('body-parser');
const cors = require('cors');
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

const MERCHANT_CODE = process.env.MERCHANT_CODE || '367149531';
const TERMINAL = process.env.TERMINAL || '1';
const SECRET_KEY = process.env.SECRET_KEY || 'sq7HjrUOBfKmC576ILgskD5srU870gJ7';
const MERCHANT_MERCHANTURL = process.env.MERCHANT_MERCHANTURL || 'https://fbcid-production.up.railway.app/redsys-notification';
const MERCHANT_URLOK = process.env.MERCHANT_URLOK || 'https://yourdomain.com/thanks.html';
const MERCHANT_URLKO = process.env.MERCHANT_URLKO || 'https://yourdomain.com/error.html';

const REDSYS_ENVIRONMENT = process.env.REDSYS_ENVIRONMENT || 'test';

const app = express();
const PORT = process.env.PORT || 3000;

// ------------------------------------------------------
// MIDDLEWARE SETUP
// ------------------------------------------------------
// Update CORS configuration for better cross-origin support
app.use(cors({
  origin: '*', // Allow all origins
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false // No credentials needed since we're using localStorage
}));

app.use(morgan('combined'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

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

  function sha256(value) {
    return crypto
      .createHash('sha256')
      .update(value.trim().toLowerCase())
      .digest('hex');
  }

  const userData = {};
  if (donationRow.fbp) userData.fbp = donationRow.fbp;
  if (donationRow.fbc) userData.fbc = donationRow.fbc;
  if (donationRow.client_ip_address) userData.client_ip_address = donationRow.client_ip_address;
  if (donationRow.client_user_agent) userData.client_user_agent = donationRow.client_user_agent;
  
  console.log('[FB Conversion] User data prepared:', userData);

  const eventSourceUrl = 'https://example.com/orderComplete';
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
    console.error('[FB Conversion] Error response from FB:', response.status, errorText);
    throw new Error(`FB API error: ${response.status} - ${errorText}`);
  }

  const result = await response.json();
  console.log('[FB Conversion] Facebook conversion result:', result);
  return { success: true, result };
}

// ------------------------------------------------------
// Retry mechanism for Facebook Conversion
// ------------------------------------------------------
async function attemptFacebookConversion(donationRow) {
  const maxAttempts = 3;
  let attempt = 0;
  let lastError = null;

  while (attempt < maxAttempts) {
    try {
      console.log(`[FB Conversion] Attempt ${attempt + 1} for donation id ${donationRow.id}`);
      const result = await sendFacebookConversionEvent(donationRow);
      if (result.success) {
        console.log(`[FB Conversion] Success on attempt ${attempt + 1} for donation id ${donationRow.id}`);
        return { success: true, result, attempts: attempt + 1 };
      }
      lastError = new Error(result.error || 'Unknown error');
    } catch (err) {
      lastError = err;
      console.error(`[FB Conversion] Attempt ${attempt + 1} failed:`, err.message);
    }
    attempt++;
    await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * 1000));
  }
  
  console.error(`[FB Conversion] All attempts failed for donation id ${donationRow.id}`);
  return { success: false, error: lastError, attempts: attempt };
}

// ------------------------------------------------------
// ROUTES
// ------------------------------------------------------

// Endpoint to create a donation and store donor data in SQLite
app.post('/create-donation', async (req, res) => {
  try {
    const { amount, fbclid, fbp, fbc } = req.body;
    console.log('[Create Donation] Received donation request:', { amount, fbclid, fbp, fbc });

    if (!amount) {
      console.error('[Create Donation] Missing donation amount.');
      return res.status(400).json({ error: 'Missing donation amount.' });
    }

    // Generate a unique order ID
    const orderId = randomTransactionId();
    console.log('[Create Donation] Generated order ID:', orderId);

    // Get client IP and user agent
    const clientIp =
      req.headers['x-forwarded-for'] ||
      req.connection?.remoteAddress ||
      req.socket?.remoteAddress ||
      '';
    const clientUserAgent = req.headers['user-agent'] || '';
    console.log('[Create Donation] Client info:', { clientIp, clientUserAgent });

    // Convert amount to cents (assuming amount in Euros)
    const amountCents = Math.round(Number(amount) * 100);
    if (isNaN(amountCents) || amountCents <= 0) {
      console.error('[Create Donation] Invalid donation amount:', amount);
      return res.status(400).json({ error: 'Invalid donation amount.' });
    }
    console.log('[Create Donation] Donation amount in cents:', amountCents);

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
    console.log('[Create Donation] Donation data saved in DB for order ID:', orderId);

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
    console.log('[Create Donation] Redsys form generated for order ID:', orderId);

    // Return the orderId along with the form data
    res.json({ ok: true, orderId, form });

  } catch (err) {
    console.error('[Create Donation] Error in /create-donation:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Endpoint to initiate Redsys payment via an iframe redirect
app.get('/iframe-sis', async (req, res, next) => {
  try {
    const { orderId } = req.query;
    console.log('[Iframe Redirect] Request received for order ID:', orderId);
    if (!orderId) {
      console.error('[Iframe Redirect] Missing orderId parameter.');
      return res.status(400).send('<h1>Error: missing orderId param</h1>');
    }
    
    // Retrieve donation data from SQLite
    const donation = await dbGet('SELECT * FROM donations WHERE order_id = ?', [orderId]);
    if (!donation) {
      console.error('[Iframe Redirect] No matching donor data found for order ID:', orderId);
      return res.status(404).send('<h1>Error: no matching donor data</h1>');
    }
    console.log('[Iframe Redirect] Donation data retrieved:', donation);

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
    console.log('[Iframe Redirect] Redsys redirect form generated for order ID:', orderId);
    
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
    console.error('[Iframe Redirect] Error in /iframe-sis:', err);
    next(err);
  }
});

// Redsys payment notification endpoint
app.post('/redsys-notification', async (req, res, next) => {
  try {
    console.log('[Redsys Notification] Received notification with body:', req.body);
    const result = processRedirectNotification(req.body);
    console.log('[Redsys Notification] Processed result:', result);
    
    const responseCode = parseInt(result.Ds_Response || '9999', 10);
    if (responseCode < 100) {
      console.log('[Redsys Notification] Payment SUCCESS:', result);

      const orderId = result.Ds_Order;
      const amountCents = parseInt(result.Ds_Amount);
      
      // Retrieve the donation from the database using the orderId
      const donation = await dbGet('SELECT * FROM donations WHERE order_id = ?', [orderId]);
      if (!donation) {
        console.warn('[Redsys Notification] Donation not found for order ID:', orderId);
        return res.send('OK');
      }

      // If we already sent the conversion
      if (donation.fb_conversion_sent === 1) {
        console.log('[Redsys Notification] Conversion already sent for donation with order ID:', orderId);
        return res.send('OK');
      }

      // Update donation amount in case it's different
      if (donation.donation_amount !== amountCents) {
        console.log('[Redsys Notification] Updating donation amount for order ID:', orderId);
        await dbRun(
          'UPDATE donations SET donation_amount = ? WHERE id = ?',
          [amountCents, donation.id]
        );
        donation.donation_amount = amountCents;
      }

      // Log payload and insert conversion log
      const rawPayload = JSON.stringify(req.body);
      console.log('[Redsys Notification] Logging FB conversion payload:', rawPayload);
      const insertLogResult = await dbRun(
        `INSERT INTO fb_conversion_logs (donation_id, raw_payload, attempts, status)
         VALUES (?, ?, ?, ?)`,
        [donation.id, rawPayload, 0, 'pending']
      );
      const logId = insertLogResult.lastID;
      console.log('[Redsys Notification] FB conversion log inserted with ID:', logId);

      // Attempt FB conversion with retry
      const conversionResult = await attemptFacebookConversion(donation);
      const now = new Date().toISOString();

      if (conversionResult.success) {
        console.log('[Redsys Notification] FB conversion successful for donation id:', donation.id);
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
        console.error('[Redsys Notification] FB conversion failed after retries for donation id:', donation.id);
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
      console.warn('[Redsys Notification] Payment Failed or Rejected:', result);
      // Log failed payment
      await dbRun(
        `INSERT INTO payment_failures (order_id, amount, error)
         VALUES (?, ?, ?)`,
        [result.Ds_Order, result.Ds_Amount, `Response code: ${responseCode}`]
      );
      return res.send('OK');
    }
  } catch (err) {
    console.error('[Redsys Notification] Error in /redsys-notification:', err);
    next(err);
  }
});

// BACKGROUND WORKER: Retry Pending FB Conversions
setInterval(async () => {
  try {
    console.log('[Background Worker] Checking for pending FB conversions...');
    const logs = await dbAll("SELECT * FROM fb_conversion_logs WHERE status != 'sent' AND attempts < 3");
    
    for (const log of logs) {
      const donationRow = await dbGet("SELECT * FROM donations WHERE id = ?", [log.donation_id]);
      if (!donationRow) continue;
      
      console.log(`[Background Worker] Retrying FB conversion for donation id ${donationRow.id}`);
      const result = await attemptFacebookConversion(donationRow);
      const now = new Date().toISOString();
      
      if (result.success) {
        console.log(`[Background Worker] FB conversion retried successfully for donation id ${donationRow.id}`);
        await dbRun(
          "UPDATE fb_conversion_logs SET status = 'sent', attempts = ?, last_attempt = ? WHERE id = ?",
          [result.attempts, now, log.id]
        );
        await dbRun(
          "UPDATE donations SET fb_conversion_sent = 1 WHERE id = ?",
          [donationRow.id]
        );
      } else {
        console.warn(`[Background Worker] Retry pending for donation id ${donationRow.id}`);
        await dbRun(
          "UPDATE fb_conversion_logs SET attempts = ?, last_attempt = ?, error = ? WHERE id = ?",
          [result.attempts, now, result.error ? result.error.message : '', log.id]
        );
      }
    }
  } catch (err) {
    console.error("[Background Worker] Error processing pending FB conversions:", err);
  }
}, 60000); // Run every minute

// ERROR HANDLING MIDDLEWARE
app.use((err, req, res, next) => {
  console.error('[Error Handling] Unhandled error in middleware:', err);
  res.status(500).json({ error: 'An internal server error occurred.' });
});

// GLOBAL PROCESS ERROR HANDLERS
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Global Error] Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[Global Error] Uncaught Exception:', err);
});

// START THE SERVER
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
