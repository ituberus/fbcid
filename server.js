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

// Custom CORS middleware with credentials support
app.use(cors({
  credentials: true,
  origin: function (origin, callback) {
    callback(null, origin || true); // Allow all origins with credentials
  }
}));

app.use(morgan('combined'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser(SESSION_SECRET)); // Use same secret as session

// Configure session middleware
app.use(session({
  secret: SESSION_SECRET,
  resave: true, // Changed to true to ensure session is saved
  saveUninitialized: true,
  name: 'sessionId', // Explicit session name
  cookie: {
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax', // Changed to lax to ensure cookies are sent in more scenarios
  },
  rolling: true // Extend session expiry on each request
}));

// Add session debugging middleware
app.use((req, res, next) => {
  console.log('Session ID:', req.sessionID);
  console.log('Session Data:', req.session);
  next();
});

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

// Initialize database tables
db.serialize(() => {
  // Add temporary_tracking table for storing FB data before order creation
  db.run(`
    CREATE TABLE IF NOT EXISTS temporary_tracking (
      session_id TEXT PRIMARY KEY,
      fbclid TEXT,
      fbp TEXT,
      fbc TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

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
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      session_id TEXT
    )
  `);

  // fb_conversion_logs table
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

// Store Facebook tracking data in both session and temporary database
async function storeFacebookTrackingData(sessionId, data) {
  const { fbclid, fbp, fbc } = data;
  
  // Store in database
  await dbRun(`
    INSERT OR REPLACE INTO temporary_tracking 
    (session_id, fbclid, fbp, fbc) 
    VALUES (?, ?, ?, ?)
  `, [sessionId, fbclid, fbp, fbc]);
  
  return { fbclid, fbp, fbc };
}

// Get Facebook tracking data from both session and temporary database
async function getFacebookTrackingData(sessionId) {
  // Try to get from database first
  const dbData = await dbGet(
    'SELECT fbclid, fbp, fbc FROM temporary_tracking WHERE session_id = ?',
    [sessionId]
  );
  
  return dbData || { fbclid: null, fbp: null, fbc: null };
}

// Send event to Facebook Conversions API
async function sendFacebookConversionEvent(donationData, paymentData) {
  console.log('Preparing to send Facebook conversion event:', {
    donationData,
    paymentData
  });

  const fetch = (await import('node-fetch')).default;
  const eventId = `redsys_${donationData.order_id}`;
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
      currency: 'EUR',
      fbclid: donationData.fbclid || null
    }
  };

  const payload = {
    data: [eventData]
  };

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
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  return { success: false, error: lastError, attempts: attempt };
}

// ===================
// ROUTES
// ===================

// Store Facebook tracking data
app.post('/api/store-fb-data', async (req, res) => {
  try {
    const { fbclid, fbp, fbc } = req.body;
    console.log('Received FB data:', { fbclid, fbp, fbc });

    if (!req.sessionID) {
      return res.status(500).json({ error: 'Session not available.' });
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const generatedFbp = fbp || `fb.1.${timestamp}.${Math.floor(Math.random() * 1e16)}`;
    const generatedFbc = (!fbc && fbclid) ? `fb.1.${timestamp}.${fbclid}` : fbc;

    // Store in both session and database
    const trackingData = await storeFacebookTrackingData(req.sessionID, {
      fbp: generatedFbp,
      fbc: generatedFbc,
      fbclid: fbclid || null
    });

    // Store in session as backup
    req.session.fbTrackingData = trackingData;

    console.log('Stored FB data:', trackingData);

    return res.json({
      message: 'FB data stored successfully',
      ...trackingData
    });
  } catch (err) {
    console.error('Error storing FB data:', err);
    return res.status(500).json({ error: 'Failed to store FB data' });
  }
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

    // Get tracking data from both session and database
    const trackingData = await getFacebookTrackingData(req.sessionID);
    console.log('Retrieved tracking data for donation:', trackingData);

    console.log('Creating donation with data:', {
      orderId,
      amount,
      ...trackingData,
      clientIp,
      clientUserAgent,
      sessionId: req.sessionID
    });

    // Store donation with tracking data
    await dbRun(`
      INSERT INTO donations (
        order_id, amount, fbclid, fbp, fbc,
        client_ip, client_user_agent, session_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      orderId,
      amount,
      trackingData.fbclid,
      trackingData.fbp,
      trackingData.fbc,
      clientIp,
      clientUserAgent,
      req.sessionID
    ]);

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

    const donation = await dbGet('SELECT * FROM donations WHERE order_id = ?', [orderId]);
    if (!donation) {
      return res.status(404).send('<h1>Error: no matching donor data</h1>');
    }

    const dsAmount = Math.round(parseFloat(donation.amount)).toString();
    
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

      // Get donation data with tracking information
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
app.get('/api/get-fb-data', async (req, res) => {
  try {
    console.log('Retrieving FB data for session:', req.sessionID);
    
    // Get tracking data from both session and database
    const trackingData = await getFacebookTrackingData(req.sessionID);
    
    return res.json(trackingData);
  } catch (err) {
    console.error('Error retrieving FB data:', err);
    return res.status(500).json({ error: 'Failed to retrieve FB data' });
  }
});

// Beacon endpoint for FB data (fallback)
app.post('/api/beacon-fb-data', async (req, res) => {
  try {
    console.log('Received beacon FB data');
    const { fbclid, fbp, fbc } = req.body;
    
    if (!req.sessionID) {
      console.error('No session available for beacon data');
      return res.status(204).send();
    }

    // Store in both session and database
    await storeFacebookTrackingData(req.sessionID, {
      fbclid: fbclid || null,
      fbp: fbp || null,
      fbc: fbc || null
    });

    return res.sendStatus(200);
  } catch (err) {
    console.error('Error processing beacon data:', err);
    return res.status(500).send();
  }
});

// Cleanup old temporary tracking data (optional)
setInterval(async () => {
  try {
    // Remove temporary tracking data older than 24 hours
    await dbRun(`
      DELETE FROM temporary_tracking 
      WHERE created_at < datetime('now', '-1 day')
    `);
  } catch (err) {
    console.error('Error cleaning up temporary tracking data:', err);
  }
}, 60 * 60 * 1000); // Run every hour

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
