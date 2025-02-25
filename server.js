/********************************
 * server.js - Merged Redsys & FB Conversion
 ********************************/

// ----------------------------
// REQUIRED LIBRARIES & MODULES
// ----------------------------
const express = require('express');
const path = require('path');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const morgan = require('morgan');
const { promisify } = require('util');
const crypto = require('crypto');
require('dotenv').config();

// Declare global fetch variable; it will be set via dynamic import below.
// (Do not use require('node-fetch') as node-fetch v3 is an ES module)
let fetch;

// Redsys Easy library
const {
  createRedsysAPI,
  SANDBOX_URLS,
  randomTransactionId
} = require('redsys-easy');

// ----------------------------
// ENVIRONMENT VARIABLES & CONFIGURATION
// ----------------------------
const PORT = process.env.PORT || 3000;

// Facebook conversion API configuration (update these in your .env)
const FACEBOOK_PIXEL_ID = process.env.FACEBOOK_PIXEL_ID || 'YOUR_FACEBOOK_PIXEL_ID';
const FACEBOOK_ACCESS_TOKEN = process.env.FACEBOOK_ACCESS_TOKEN || 'YOUR_FACEBOOK_ACCESS_TOKEN';
const FACEBOOK_TEST_EVENT_CODE = process.env.FACEBOOK_TEST_EVENT_CODE || '';

// Session secret
const SESSION_SECRET = process.env.SESSION_SECRET || 'somesecret';

// Redsys configuration (using sandbox/test credentials)
const MERCHANT_CODE = process.env.MERCHANT_CODE || '367149531';
const TERMINAL = process.env.TERMINAL || '001'; // Use '001' or as configured
const SECRET_KEY = process.env.SECRET_KEY || 'sq7HjrUOBfKmC576ILgskD5srU870gJ7';

// Callback URLs – updated for Railway deployment
const MERCHANT_MERCHANTURL = process.env.MERCHANT_MERCHANTURL || 'https://fbcid-production.up.railway.app/redsys-notification';
const MERCHANT_URLOK = process.env.MERCHANT_URLOK || 'https://fbcid-production.up.railway.app/thanks.html';
const MERCHANT_URLKO = process.env.MERCHANT_URLKO || 'https://fbcid-production.up.railway.app/error.html';

// Create Redsys API instance
const { createRedirectForm, processRedirectNotification } = createRedsysAPI({
  secretKey: SECRET_KEY,
  urls: SANDBOX_URLS
});

// ----------------------------
// EXPRESS APP SETUP
// ----------------------------
// Allow all origins – fully public CORS configuration
const app = express();
app.use(cors());
app.use(morgan('combined'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'strict',
  },
}));

// Serve static files (e.g. landing page and checkout pages)
app.use(express.static(path.join(__dirname, 'views')));

// ----------------------------
// SQLITE DATABASE SETUP
// ----------------------------
const db = new sqlite3.Database('./donations.db', (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
  } else {
    console.log('Connected to SQLite database.');
  }
});

// Promisify db functions for async/await usage
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

// Create/Update necessary tables
db.serialize(() => {
  // Donations table - using orderId as the primary key
  db.run(`
    CREATE TABLE IF NOT EXISTS donations (
      orderId TEXT PRIMARY KEY,
      amount REAL,
      fbclid TEXT,
      fbp TEXT,
      fbc TEXT,
      client_ip_address TEXT,
      client_user_agent TEXT,
      fb_conversion_sent INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `, (err) => {
    if(err) {
      console.error("Error creating donations table:", err);
    } else {
      console.log("Donations table ready.");
    }
  });

  // FB Conversion Logs table for retry purposes
  db.run(`
    CREATE TABLE IF NOT EXISTS fb_conversion_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      orderId TEXT,
      raw_payload TEXT,
      attempts INTEGER DEFAULT 0,
      last_attempt DATETIME,
      status TEXT DEFAULT 'pending',
      error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `, (err) => {
    if(err) {
      console.error("Error creating fb_conversion_logs table:", err);
    } else {
      console.log("FB Conversion Logs table ready.");
    }
  });
});

// ----------------------------
// FACEBOOK CONVERSION FUNCTIONS
// ----------------------------

async function sendFacebookConversionEvent(donation) {
  // Build userData using only fb data and client info
  const userData = {};
  if (donation.fbp) {
    userData.fbp = donation.fbp;
  }
  if (donation.fbc) {
    userData.fbc = donation.fbc;
  }
  if (donation.fbclid) {
    userData.fbclid = donation.fbclid;
  }
  if (donation.client_ip_address) {
    userData.client_ip_address = donation.client_ip_address;
  }
  if (donation.client_user_agent) {
    userData.client_user_agent = donation.client_user_agent;
  }
  
  console.log("Preparing Facebook Conversion Event for donation:", donation.orderId, "UserData:", userData);
  
  // Use the orderId as the event_id for deduplication
  const eventData = {
    event_name: 'Purchase',
    event_time: Math.floor(Date.now() / 1000),
    event_id: donation.orderId,
    event_source_url: 'https://yourdomain.com/checkout', // Adjust as needed
    action_source: 'website',
    user_data: userData,
    custom_data: {
      value: donation.amount,  // donation.amount is in EUR (as entered)
      currency: 'EUR'
    }
  };
  
  console.log("Event Data prepared:", eventData);
  
  const payload = {
    data: [eventData]
  };

  if (FACEBOOK_TEST_EVENT_CODE) {
    payload.test_event_code = FACEBOOK_TEST_EVENT_CODE;
  }
  
  console.log("Payload for Facebook API:", payload);

  const url = `https://graph.facebook.com/v15.0/${FACEBOOK_PIXEL_ID}/events?access_token=${FACEBOOK_ACCESS_TOKEN}`;
  console.log("Sending Facebook Conversion Event to URL:", url);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`FB API error for donation ${donation.orderId}:`, response.status, errorText);
    throw new Error(`FB API error: ${response.status} - ${errorText}`);
  }

  const result = await response.json();
  console.log('Facebook conversion result for donation', donation.orderId, ":", result);
  return { success: true, result };
}

async function attemptFacebookConversion(donation) {
  const maxAttempts = 3;
  let attempt = 0;
  let lastError = null;
  while (attempt < maxAttempts) {
    try {
      const result = await sendFacebookConversionEvent(donation);
      if (result.success) {
        console.log(`Facebook conversion event succeeded for donation ${donation.orderId} on attempt ${attempt + 1}`);
        return { success: true, result, attempts: attempt + 1 };
      }
      lastError = new Error(result.error || 'Unknown error');
    } catch (err) {
      lastError = err;
    }
    attempt++;
    console.warn(`Attempt ${attempt} failed for donation ${donation.orderId}: ${lastError.message}`);
    await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * 1000));
  }
  console.error(`Facebook conversion event failed for donation ${donation.orderId} after ${attempt} attempts`);
  return { success: false, error: lastError, attempts: attempt };
}

// ----------------------------
// API ENDPOINTS
// ----------------------------

// --- FB Data Storage from Landing Page ---
// This endpoint stores fbclid, fbp, fbc in the session.
// If any are missing, it generates them.
app.post('/api/store-fb-data', (req, res) => {
  try {
    console.log("Received /api/store-fb-data with body:", req.body);
    let { fbclid, fbp, fbc } = req.body;
    if (!req.session) {
      console.error("Session not available in /api/store-fb-data");
      return res.status(500).json({ error: 'Session not available.' });
    }
    const timestamp = Math.floor(Date.now() / 1000);
    if (!fbp) {
      const randomPart = Math.floor(Math.random() * 1e16);
      fbp = `fb.1.${timestamp}.${randomPart}`;
      console.log("Generated fbp:", fbp);
    }
    if (!fbc && fbclid) {
      fbc = `fb.1.${timestamp}.${fbclid}`;
      console.log("Generated fbc:", fbc);
    }
    req.session.fbp = fbp;
    req.session.fbc = fbc;
    req.session.fbclid = fbclid || null;
    console.log("Session FB data stored:", { fbclid, fbp, fbc });
    return res.json({ message: 'FB data stored in session', fbclid, fbp, fbc });
  } catch (err) {
    console.error('Error storing FB data:', err);
    return res.status(500).json({ error: 'Failed to store FB data' });
  }
});

// (Optional) Endpoint to retrieve FB data from session
app.get('/api/get-fb-data', (req, res) => {
  try {
    if (!req.session) {
      console.error("Session not available in /api/get-fb-data");
      return res.status(500).json({ error: 'Session not available.' });
    }
    const { fbp, fbc, fbclid } = req.session;
    console.log("Retrieved FB data from session:", { fbp, fbc, fbclid });
    return res.json({ fbp: fbp || null, fbc: fbc || null, fbclid: fbclid || null });
  } catch (err) {
    console.error('Error retrieving FB data:', err);
    return res.status(500).json({ error: 'Failed to retrieve FB data' });
  }
});

// --- Create Donation & Save FB Data ---
// This endpoint is called from the checkout page when the user clicks donate.
// It generates a unique order ID (using Redsys helper), saves the donation details (amount and fb data),
// and includes additional info like client IP and user agent.
app.post('/create-donation', async (req, res) => {
  try {
    console.log("Received /create-donation with body:", req.body);
    const { amount } = req.body;
    if (!amount) {
      console.error("Missing amount in /create-donation request");
      return res.status(400).json({ ok: false, error: 'Missing amount.' });
    }
    // Generate a unique order ID using Redsys helper
    const orderId = randomTransactionId();
    console.log("Generated orderId:", orderId);
    // Get fb data from session if available
    let fbclid = req.session ? req.session.fbclid : null;
    let fbp = req.session ? req.session.fbp : null;
    let fbc = req.session ? req.session.fbc : null;
    console.log("FB data from session:", { fbclid, fbp, fbc });
    // Get client IP and user agent from request headers
    const clientIp = req.headers['x-forwarded-for'] || req.connection?.remoteAddress || '';
    const clientUserAgent = req.headers['user-agent'] || '';
    console.log("Client info:", { clientIp, clientUserAgent });
    // Insert donation record
    await dbRun(
      `INSERT INTO donations (orderId, amount, fbclid, fbp, fbc, client_ip_address, client_user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [orderId, amount, fbclid || null, fbp || null, fbc || null, clientIp, clientUserAgent]
    );
    console.log("Donation record saved for orderId:", orderId, "with amount:", amount);
    return res.json({ ok: true, orderId });
  } catch (err) {
    console.error('Error in /create-donation:', err);
    return res.status(500).json({ ok: false, error: 'Database error.' });
  }
});

// --- Redsys Payment Redirect ---
// This endpoint is called (typically via an iframe) to redirect the user to the Redsys payment page.
app.get('/iframe-sis', async (req, res) => {
  try {
    const { orderId } = req.query;
    console.log("Received /iframe-sis request for orderId:", orderId);
    if (!orderId) {
      console.error("Missing orderId param in /iframe-sis");
      return res.status(400).send('<h1>Error: missing orderId param</h1>');
    }
    // Retrieve donation data
    const row = await dbGet('SELECT * FROM donations WHERE orderId = ?', [orderId]);
    if (!row) {
      console.error("No matching donation data for orderId:", orderId);
      return res.status(404).send('<h1>Error: no matching donation data</h1>');
    }
    console.log("Donation data retrieved for orderId:", orderId, row);
    // Convert amount to cents (Redsys expects an integer in cents)
    const dsAmount = (parseFloat(row.amount) * 100).toFixed(0);
    const params = {
      DS_MERCHANT_MERCHANTCODE: MERCHANT_CODE,
      DS_MERCHANT_TERMINAL: TERMINAL,
      DS_MERCHANT_ORDER: orderId,
      DS_MERCHANT_AMOUNT: dsAmount,
      DS_MERCHANT_CURRENCY: '978', // EUR (978)
      DS_MERCHANT_TRANSACTIONTYPE: '0',
      DS_MERCHANT_CONSUMERLANGUAGE: '2',
      // Additional parameters if needed can be added here
      DS_MERCHANT_MERCHANTURL: MERCHANT_MERCHANTURL,
      DS_MERCHANT_URLOK: MERCHANT_URLOK,
      DS_MERCHANT_URLKO: MERCHANT_URLKO
    };
    console.log("Redsys parameters for orderId", orderId, ":", params);
    const form = createRedirectForm(params);
    console.log("Redirect form created for orderId", orderId, ":", form);
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
    return res.send(html);
  } catch (err) {
    console.error('Error in /iframe-sis:', err);
    res.status(500).send('<h1>Internal Server Error</h1>');
  }
});

// --- Redsys Notification Endpoint ---
// Redsys calls this endpoint after payment is processed.
// If payment is successful (Ds_Response < 100), we lookup the donation record
// and attempt to send the Facebook conversion event.
app.post('/redsys-notification', async (req, res) => {
  try {
    console.log("Received /redsys-notification with body:", req.body);
    const result = processRedirectNotification(req.body);
    console.log("Processed Redsys notification result:", result);
    const responseCode = parseInt(result.Ds_Response || '9999', 10);
    if (responseCode < 100) {
      // Payment successful. Log the successful payment details.
      console.log('Payment SUCCESS for orderId', result.Ds_Order, "with response code:", result.Ds_Response);
      // Retrieve the donation using the order id sent in the notification.
      const orderId = result.Ds_Order;
      const donation = await dbGet('SELECT * FROM donations WHERE orderId = ?', [orderId]);
      if (donation) {
        console.log("Donation record found for orderId", orderId, donation);
        // Attempt to send Facebook conversion event
        const conversionResult = await attemptFacebookConversion(donation);
        const now = new Date().toISOString();
        if (conversionResult.success) {
          // Mark conversion as sent in the donations table
          await dbRun(
            `UPDATE donations SET fb_conversion_sent = 1 WHERE orderId = ?`,
            [orderId]
          );
          console.log("Marked FB conversion as sent for orderId", orderId);
          // Optionally, log the successful conversion in fb_conversion_logs
          await dbRun(
            `INSERT INTO fb_conversion_logs (orderId, raw_payload, attempts, status, last_attempt)
             VALUES (?, ?, ?, ?, ?)`,
            [orderId, JSON.stringify(result), conversionResult.attempts, 'sent', now]
          );
          console.log("Logged successful FB conversion in fb_conversion_logs for orderId", orderId);
        } else {
          // Log the failed conversion attempt
          await dbRun(
            `INSERT INTO fb_conversion_logs (orderId, raw_payload, attempts, status, last_attempt, error)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [orderId, JSON.stringify(result), conversionResult.attempts, 'failed', now, conversionResult.error ? conversionResult.error.message : '']
          );
          console.error("Logged failed FB conversion in fb_conversion_logs for orderId", orderId, "with error:", conversionResult.error ? conversionResult.error.message : '');
        }
      } else {
        console.warn(`Donation with orderId ${orderId} not found.`);
      }
      return res.send('OK');
    } else {
      console.warn("Payment failed with response code:", result.Ds_Response);
      // Payment failed; simply respond OK.
      return res.send('OK');
    }
  } catch (err) {
    console.error('Error in /redsys-notification:', err);
    res.status(500).send('Error');
  }
});

// ----------------------------
// BACKGROUND WORKER: RETRY PENDING FB CONVERSIONS
// ----------------------------
setInterval(async () => {
  console.log("Running background worker to retry pending FB conversions");
  try {
    const logs = await dbAll("SELECT * FROM fb_conversion_logs WHERE status != 'sent'");
    console.log("Pending FB conversion logs retrieved:", logs);
    for (const log of logs) {
      const donation = await dbGet("SELECT * FROM donations WHERE orderId = ?", [log.orderId]);
      if (!donation) {
        console.warn("No donation found for pending log with orderId:", log.orderId);
        continue;
      }
      console.log("Retrying FB conversion for donation:", donation.orderId, donation);
      const result = await attemptFacebookConversion(donation);
      const now = new Date().toISOString();
      if (result.success) {
        await dbRun(
          "UPDATE fb_conversion_logs SET status = 'sent', attempts = ?, last_attempt = ? WHERE id = ?",
          [result.attempts, now, log.id]
        );
        await dbRun(
          "UPDATE donations SET fb_conversion_sent = 1 WHERE orderId = ?",
          [donation.orderId]
        );
        console.log(`Successfully retried FB conversion for orderId ${donation.orderId}`);
      } else {
        await dbRun(
          "UPDATE fb_conversion_logs SET attempts = ?, last_attempt = ?, error = ? WHERE id = ?",
          [result.attempts, now, result.error ? result.error.message : '', log.id]
        );
        console.warn(`Retry pending for orderId ${donation.orderId}`);
      }
    }
  } catch (err) {
    console.error("Error processing pending FB conversions:", err);
  }
}, 60000); // runs every 60 seconds

// ----------------------------
// ERROR HANDLING MIDDLEWARE
// ----------------------------
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'An internal server error occurred.' });
});

// ----------------------------
// START THE SERVER AFTER DYNAMIC IMPORT OF NODE-FETCH
// ----------------------------
(async () => {
  const { default: fetchImported } = await import('node-fetch');
  fetch = fetchImported;
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
})();
