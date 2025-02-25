const express = require('express');
const path = require('path');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const cookieParser = require('cookie-parser');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const morgan = require('morgan');
const { promisify } = require('util');
require('dotenv').config();

// Redsys integration
const {
  createRedsysAPI,
  SANDBOX_URLS,
  randomTransactionId
} = require('redsys-easy');

// ===================
// CONFIGURATION
// ===================

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'somesecret';

// Facebook Configuration
const FACEBOOK_PIXEL_ID = process.env.FACEBOOK_PIXEL_ID || '';
const FACEBOOK_ACCESS_TOKEN = process.env.FACEBOOK_ACCESS_TOKEN || '';
const FACEBOOK_TEST_EVENT_CODE = process.env.FACEBOOK_TEST_EVENT_CODE || '';

// Redsys Configuration
const MERCHANT_CODE = process.env.MERCHANT_CODE || '367149531';
const TERMINAL = process.env.TERMINAL || '1';
const SECRET_KEY = process.env.SECRET_KEY || 'sq7HjrUOBfKmC576ILgskD5srU870gJ7';

// Callback URLs
const MERCHANT_MERCHANTURL = process.env.MERCHANT_MERCHANTURL || 'https://yourdomain.com/redsys-notification';
const MERCHANT_URLOK = process.env.MERCHANT_URLOK || 'https://yourdomain.com/thanks.html';
const MERCHANT_URLKO = process.env.MERCHANT_URLKO || 'https://yourdomain.com/error.html';

// Create Redsys API instance
const { createRedirectForm, processRedirectNotification } = createRedsysAPI({
  secretKey: SECRET_KEY,
  urls: SANDBOX_URLS
});

const app = express();

// ===================
// MIDDLEWARE SETUP
// ===================

// Custom CORS middleware: reflect the request's Origin header when available,
// which is required when credentials are included.
app.use(cors({
  credentials: true,
  origin: function (origin, callback) {
    // If an Origin header is present, echo it back. Otherwise, deny CORS.
    if (origin) {
      callback(null, origin);
    } else {
      callback(null, false);
    }
  }
}));

app.use(morgan('combined'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: true, // Changed to true to ensure session is always created
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000,
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'strict',
  },
}));

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// ===================
// DATABASE SETUP
// ===================

const db = new sqlite3.Database('./database.sqlite', (err) => {
  if (err) {
    console.error('Error opening database:', err);
  } else {
    console.log('Connected to SQLite database.');
  }
});

// Promisify database operations
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

// Create necessary tables
db.serialize(() => {
  // donations table with tracking data
  db.run(`
    CREATE TABLE IF NOT EXISTS donations (
      order_id TEXT PRIMARY KEY,
      amount INTEGER,
      fbclid TEXT,
      fbp TEXT,
      fbc TEXT,
      client_ip TEXT,
      client_user_agent TEXT,
      payment_status TEXT DEFAULT 'pending',
      fb_conversion_sent INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // fb_conversion_logs table for tracking conversion attempts
  db.run(`
    CREATE TABLE IF NOT EXISTS fb_conversion_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT,
      raw_payload TEXT,
      attempts INTEGER DEFAULT 0,
      last_attempt DATETIME,
      status TEXT DEFAULT 'pending',
      error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(order_id) REFERENCES donations(order_id)
    )
  `);
});

// ===================
// HELPER FUNCTIONS
// ===================

// Send event to Facebook Conversions API
async function sendFacebookConversionEvent(donationData, paymentData) {
  console.log('Preparing to send Facebook conversion event:', {
    donationData,
    paymentData
  });

  const fetch = (await import('node-fetch')).default;

  // Generate event ID using order ID
  const eventId = `redsys_${donationData.order_id}`;

  // Convert amount from cents to whole units
  const amount = parseInt(paymentData.Ds_Amount) / 100;

  const eventData = {
    event_name: 'Purchase',
    event_time: Math.floor(Date.now() / 1000),
    event_id: eventId,
    action_source: 'website',
    user_data: {
      client_ip_address: donationData.client_ip,
      client_user_agent: donationData.client_user_agent,
      fbp: donationData.fbp || null,
      fbc: donationData.fbc || null
    },
    custom_data: {
      value: amount,
      currency: 'EUR', // Redsys uses EUR (978)
    }
  };

  // Add fbclid if available
  if (donationData.fbclid) {
    eventData.custom_data.fbclid = donationData.fbclid;
  }

  const payload = {
    data: [eventData]
  };

  // Add test event code if available
  if (FACEBOOK_TEST_EVENT_CODE) {
    payload.test_event_code = FACEBOOK_TEST_EVENT_CODE;
  }

  console.log('Sending Facebook conversion event payload:', payload);

  const url = `https://graph.facebook.com/v15.0/${FACEBOOK_PIXEL_ID}/events?access_token=${FACEBOOK_ACCESS_TOKEN}`;
  
  try {
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
    console.log('Facebook conversion event sent successfully:', result);
    return { success: true, result };
  } catch (error) {
    console.error('Error sending Facebook conversion event:', error);
    throw error;
  }
}

// Retry mechanism for Facebook conversion events
async function attemptFacebookConversion(donationData, paymentData) {
  const maxAttempts = 3;
  let attempt = 0;
  let lastError = null;

  while (attempt < maxAttempts) {
    try {
      console.log(`Attempt ${attempt + 1} to send Facebook conversion event for order ${donationData.order_id}`);
      const result = await sendFacebookConversionEvent(donationData, paymentData);
      if (result.success) {
        return { success: true, result, attempts: attempt + 1 };
      }
      lastError = new Error(result.error || 'Unknown error');
    } catch (err) {
      lastError = err;
      console.error(`Attempt ${attempt + 1} failed:`, err);
    }

    attempt++;
    if (attempt < maxAttempts) {
      const delay = Math.pow(2, attempt) * 1000;
      console.log(`Waiting ${delay}ms before next attempt...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  return { success: false, error: lastError, attempts: attempt };
}

// ===================
// ROUTES
// ===================

// Store Facebook tracking data
app.post('/api/store-fb-data', (req, res) => {
  const { fbclid, fbp, fbc } = req.body;
  console.log('Received FB data:', { fbclid, fbp, fbc });

  if (!req.session) {
    return res.status(500).json({ error: 'Session not available.' });
  }

  // Generate if missing
  const timestamp = Math.floor(Date.now() / 1000);
  const generatedFbp = !fbp ? `fb.1.${timestamp}.${Math.floor(Math.random() * 1e16)}` : fbp;
  const generatedFbc = !fbc && fbclid ? `fb.1.${timestamp}.${fbclid}` : fbc;

  // Store in session
  req.session.fbTrackingData = {
    fbp: generatedFbp,
    fbc: generatedFbc,
    fbclid: fbclid || null
  };

  console.log('Stored FB data in session:', req.session.fbTrackingData);

  return res.json({
    message: 'FB data stored in session',
    fbp: generatedFbp,
    fbc: generatedFbc,
    fbclid
  });
});

// Create donation and store tracking data
app.post('/create-donation', async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount) {
      return res.status(400).json({ ok: false, error: 'Missing amount.' });
    }

    const orderId = randomTransactionId();
    const clientIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    const clientUserAgent = req.headers['user-agent'];

    // Get tracking data from session
    const fbTrackingData = req.session?.fbTrackingData || {};
    const { fbclid, fbp, fbc } = fbTrackingData;

    console.log('Creating donation with data:', {
      orderId,
      amount,
      fbclid,
      fbp,
      fbc,
      clientIp,
      clientUserAgent
    });

    // Store donation data with tracking information
    await dbRun(`
      INSERT INTO donations (
        order_id, amount, fbclid, fbp, fbc,
        client_ip, client_user_agent
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      orderId,
      amount,
      fbclid || null,
      fbp || null,
      fbc || null,
      clientIp,
      clientUserAgent
    ]);

    // Store order ID in session for later use
    req.session.currentOrderId = orderId;

    return res.json({ ok: true, orderId });
  } catch (err) {
    console.error('Error creating donation:', err);
    return res.status(500).json({ ok: false, error: 'Database error.' });
  }
});

// Redsys iframe redirect
app.get('/iframe-sis', async (req, res) => {
  try {
    const { orderId } = req.query;
    if (!orderId) {
      return res.status(400).send('<h1>Error: missing orderId param</h1>');
    }

    console.log('Processing iframe-sis request for order:', orderId);

    // Get donation data
    const donation = await dbGet('SELECT * FROM donations WHERE order_id = ?', [orderId]);
    if (!donation) {
      return res.status(404).send('<h1>Error: no matching donor data</h1>');
    }

    // Convert amount to cents for Redsys
    const dsAmount = Math.round(parseFloat(donation.amount)).toString();
    
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

    console.log('Creating Redsys redirect form with params:', params);

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
    console.error('Error in iframe-sis:', err);
    res.status(500).send('<h1>Error processing payment request</h1>');
  }
});

// Redsys payment notification endpoint
app.post('/redsys-notification', async (req, res) => {
  try {
    console.log('Received Redsys notification');
    const result = processRedirectNotification(req.body);
    console.log('Processed Redsys notification:', result);

    const responseCode = parseInt(result.Ds_Response || '9999', 10);
    const orderId = result.Ds_Order;

    // Update payment status regardless of response
    const status = responseCode < 100 ? 'completed' : 'failed';
    await dbRun(
      'UPDATE donations SET payment_status = ? WHERE order_id = ?',
      [status, orderId]
    );

    // Only process successful payments (response code < 100)
    if (responseCode < 100) {
      console.log('Payment successful for order:', orderId);

      // Get donation data
      const donation = await dbGet('SELECT * FROM donations WHERE order_id = ?', [orderId]);
      if (!donation) {
        console.error('No donation found for order:', orderId);
        return res.send('OK');
      }

      // Only send Facebook conversion if it hasn't been sent yet
      if (!donation.fb_conversion_sent) {
        try {
          console.log('Attempting to send Facebook conversion for order:', orderId);
          const conversionResult = await attemptFacebookConversion(donation, result);

          // Log conversion attempt
          await dbRun(`
                        INSERT INTO fb_conversion_logs (
              order_id, raw_payload, attempts, status, last_attempt
            ) VALUES (?, ?, ?, ?, datetime('now'))
          `, [
            orderId,
            JSON.stringify({ donation, result }),
            conversionResult.attempts,
            conversionResult.success ? 'sent' : 'failed'
          ]);

          if (conversionResult.success) {
            await dbRun(
              'UPDATE donations SET fb_conversion_sent = 1 WHERE order_id = ?',
              [orderId]
            );
            console.log('Facebook conversion sent successfully for order:', orderId);
          } else {
            console.error('Failed to send Facebook conversion for order:', orderId);
          }
        } catch (convError) {
          console.error('Error sending Facebook conversion:', convError);
        }
      } else {
        console.log('Facebook conversion already sent for order:', orderId);
      }
    } else {
      console.log('Payment failed for order:', orderId, 'Response code:', responseCode);
    }

    return res.send('OK');
  } catch (err) {
    console.error('Error in /redsys-notification:', err);
    return res.status(500).send('Error');
  }
});

// Get Facebook tracking data
app.get('/api/get-fb-data', (req, res) => {
  try {
    console.log('Retrieving FB data from session');
    if (!req.session) {
      return res.status(500).json({ error: 'Session not available.' });
    }
    const fbTrackingData = req.session.fbTrackingData || {};
    return res.json({
      fbp: fbTrackingData.fbp || null,
      fbc: fbTrackingData.fbc || null,
      fbclid: fbTrackingData.fbclid || null
    });
  } catch (err) {
    console.error('Error retrieving FB data:', err);
    return res.status(500).json({ error: 'Failed to retrieve FB data' });
  }
});

// Beacon endpoint for FB data (fallback)
app.post('/api/beacon-fb-data', (req, res) => {
  console.log('Received beacon FB data');
  const { fbclid, fbp, fbc } = req.body;
  
  if (!req.session) {
    console.error('No session available for beacon data');
    return res.status(204).send();
  }

  // Initialize fbTrackingData if it doesn't exist
  if (!req.session.fbTrackingData) {
    req.session.fbTrackingData = {};
  }

  // Update tracking data without overwriting existing values
  if (fbp) req.session.fbTrackingData.fbp = fbp;
  if (fbc) req.session.fbTrackingData.fbc = fbc;
  if (fbclid) req.session.fbTrackingData.fbclid = fbclid;

  return res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
