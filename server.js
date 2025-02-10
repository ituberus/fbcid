// server.js
const express = require('express');
const path = require('path');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const stripe = require('stripe');
const morgan = require('morgan');
const { promisify } = require('util');
const cors = require('cors');
const cookieParser = require('cookie-parser');
require('dotenv').config();
const crypto = require('crypto');

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const stripeInstance = stripe(STRIPE_SECRET_KEY);

const FACEBOOK_PIXEL_ID = process.env.FACEBOOK_PIXEL_ID || '';
const FACEBOOK_ACCESS_TOKEN = process.env.FACEBOOK_ACCESS_TOKEN || '';
const FACEBOOK_TEST_EVENT_CODE = process.env.FACEBOOK_TEST_EVENT_CODE || '';

const SESSION_SECRET = process.env.SESSION_SECRET || 'somesecret';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(morgan('combined'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

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

// Serve static files from the "public" directory
app.use(express.static(path.join(__dirname, 'public')));

// ------------------------------------------------------
// SQLITE SETUP
// ------------------------------------------------------
const db = new sqlite3.Database('./database.sqlite', (err) => {
  if (err) {
    console.error('Error opening database:', err);
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

// Create/alter tables if needed
db.serialize(() => {
  db.run(
    "CREATE TABLE IF NOT EXISTS donations (\
      id INTEGER PRIMARY KEY AUTOINCREMENT,\
      donation_amount INTEGER,\
      email TEXT,\
      first_name TEXT,\
      last_name TEXT,\
      card_name TEXT,\
      country TEXT,\
      postal_code TEXT,\
      order_complete_url TEXT,\
      payment_intent_id TEXT,\
      payment_intent_status TEXT,\
      fbclid TEXT,\
      fb_conversion_sent INTEGER DEFAULT 0,\
      client_ip_address TEXT,\
      client_user_agent TEXT,\
      event_id TEXT,\
      fbp TEXT,\
      fbc TEXT,\
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP\
    )"
  );

  db.run(
    "CREATE TABLE IF NOT EXISTS admin_users (\
      id INTEGER PRIMARY KEY AUTOINCREMENT,\
      username TEXT UNIQUE,\
      password TEXT\
    )"
  );

  db.run(
    "CREATE TABLE IF NOT EXISTS fb_conversion_logs (\
      id INTEGER PRIMARY KEY AUTOINCREMENT,\
      donation_id INTEGER,\
      raw_payload TEXT,\
      attempts INTEGER DEFAULT 0,\
      last_attempt DATETIME,\
      status TEXT DEFAULT 'pending',\
      error TEXT,\
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP\
    )"
  );

  db.run(
    "CREATE TABLE IF NOT EXISTS payment_failures (\
      id INTEGER PRIMARY KEY AUTOINCREMENT,\
      email TEXT,\
      amount INTEGER,\
      error TEXT,\
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP\
    )"
  );

  // Create fb_tracking table for storing fbclid along with email, IP and User-Agent
  db.run(
    "CREATE TABLE IF NOT EXISTS fb_tracking (\
      id INTEGER PRIMARY KEY AUTOINCREMENT,\
      email TEXT,\
      fbclid TEXT,\
      client_ip TEXT,\
      user_agent TEXT,\
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP\
    )"
  );

  // NEW: Create event_tracking table for storing event_id when not found in donations
  db.run(
    "CREATE TABLE IF NOT EXISTS event_tracking (\
      id INTEGER PRIMARY KEY AUTOINCREMENT,\
      email TEXT,\
      event_id TEXT,\
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP\
    )"
  );
});

// ------------------------------------------------------
// HELPER FUNCTIONS
// ------------------------------------------------------
function sha256(value) {
  return crypto
    .createHash('sha256')
    .update((value || '').trim().toLowerCase())
    .digest('hex');
}

// Generate fbp – now accepts an optional clientIp parameter for better uniqueness  
// Updated to generate a 10-digit random number as per Facebook’s format.
function generateFbp(clientIp = '') {
  const timestamp = Date.now();
  const randomNumber = Math.floor(1000000000 + Math.random() * 9000000000); // 10-digit random number
  return `fb.1.${timestamp}.${randomNumber}`;
}

// Generate fbc from fbclid (always generate a valid fbc even if fbclid is missing)
// Updated to check database for fbclid if email is provided
async function generateFbc(email, fbclid) {
  if (!fbclid && email) {
    const stored = await dbGet("SELECT fbclid FROM fb_tracking WHERE email = ? ORDER BY created_at DESC LIMIT 1", [email]);
    if (stored && stored.fbclid) {
      fbclid = stored.fbclid;
    }
  }
  const timestamp = Date.now();
  if (fbclid) {
    return `fb.1.${timestamp}.${fbclid}`;
  } else {
    return `fb.1.${timestamp}.${crypto.randomBytes(8).toString('hex')}`;
  }
}

// ------------------------------------------------------
// HELPER: STORE FBCLID IN TRACKING TABLE
// ------------------------------------------------------
async function storeFbclid(email, fbclid) {
  if (!fbclid) return;
  const existingEntry = await dbGet("SELECT * FROM fb_tracking WHERE fbclid = ?", [fbclid]);
  if (existingEntry) {
    if (!existingEntry.email || existingEntry.email.trim() === "") {
      if (email) {
        await dbRun("UPDATE fb_tracking SET email = ? WHERE fbclid = ?", [email, fbclid]);
      }
    }
  } else {
    await dbRun("INSERT INTO fb_tracking (email, fbclid, client_ip, user_agent, created_at) VALUES (?, ?, ?, ?, datetime('now'))", [email, fbclid, '', '']);
  }
}

// ------------------------------------------------------
// CAPTURE FBCLID SERVER-SIDE WHEN USER LANDS (UPDATED TO POST)
// ------------------------------------------------------
app.post('/capture-fbclid', async (req, res) => {
  const { fbclid, email } = req.body;
  if (fbclid) {
    req.session.fbclid = fbclid;
    console.log('Stored fbclid in session:', fbclid);
    try {
      const clientIp = req.headers['x-forwarded-for'] || req.connection?.remoteAddress || req.socket?.remoteAddress || '';
      const clientUserAgent = req.headers['user-agent'] || '';
      // Check if the fbclid is already stored
      const existingEntry = await dbGet("SELECT * FROM fb_tracking WHERE fbclid = ?", [fbclid]);
      if (!existingEntry) {
        await dbRun(
          "INSERT INTO fb_tracking (email, fbclid, client_ip, user_agent, created_at) VALUES (?, ?, ?, ?, datetime('now'))",
          [email || null, fbclid, clientIp, clientUserAgent]
        );
        console.log('Stored fbclid in tracking table:', fbclid);
      }
    } catch (err) {
      console.error('Error storing fbclid in tracking table:', err);
    }
    return res.json({ success: true, fbclid });
  }
  return res.json({ success: false });
});

// New endpoint to retrieve fbclid if available
app.get('/get-fbclid', async (req, res) => {
  // Ensure we pass in the email so we retrieve the correct fbclid
  const fbclid = req.session.fbclid || await dbGetFbclid(req.query.email);
  res.json({ fbclid: fbclid || null });
});

// Helper to get fbclid from database by email
const dbGetFbclid = async (email) => {
  const row = await dbGet("SELECT fbclid FROM fb_tracking WHERE email = ? ORDER BY created_at DESC LIMIT 1", [email]);
  return row ? row.fbclid : null;
};

// New endpoint to get the latest event_id for a given email
app.get('/get-latest-event-id', async (req, res) => {
  const email = req.query.email;
  if (!email) return res.status(400).json({ error: "Email is required" });
  const row = await dbGet("SELECT event_id FROM donations WHERE email = ? ORDER BY created_at DESC LIMIT 1", [email]);
  if (row && row.event_id) {
    res.json({ event_id: row.event_id });
  } else {
    // Generate a new event_id and store it in event_tracking for consistency
    const newEventId = `event_${Date.now()}_${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
    await dbRun("INSERT INTO event_tracking (email, event_id) VALUES (?, ?)", [email, newEventId]);
    res.json({ event_id: newEventId });
  }
});

// New endpoint to check event status to avoid duplicate events
app.get('/check-event-status', async (req, res) => {
  try {
    const { event_id } = req.query;
    if (!event_id) return res.status(400).json({ error: 'Missing event_id' });

    const row = await dbGet("SELECT fb_conversion_sent FROM donations WHERE event_id = ?", [event_id]);
    res.json({ sent: row && row.fb_conversion_sent === 1 });
  } catch (error) {
    console.error('Error in /check-event-status:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ------------------------------------------------------
// FACEBOOK CONVERSION SENDER + RETRIES
// ------------------------------------------------------
async function sendFacebookConversionEvent(donationRow) {
  const fetch = (await import('node-fetch')).default;

  if (!donationRow.payment_intent_id) {
    console.warn(`Skipping FB conversion: donation ${donationRow.id} has no payment intent.`);
    return { success: false, error: 'No Stripe payment intent ID' };
  }

  // Build hashed user data
  const userData = {};
  if (donationRow.email)       userData.em = sha256(donationRow.email);
  if (donationRow.first_name)  userData.fn = sha256(donationRow.first_name);
  if (donationRow.last_name)   userData.ln = sha256(donationRow.last_name);
  if (donationRow.country)     userData.country = sha256(donationRow.country);
  if (donationRow.postal_code) userData.zp = sha256(donationRow.postal_code);
  if (donationRow.client_ip_address)    userData.client_ip_address = donationRow.client_ip_address;
  if (donationRow.client_user_agent)    userData.client_user_agent = donationRow.client_user_agent;

  // Ensure we have valid fbp/fbc
  let finalFbp = donationRow.fbp;
  if (!finalFbp || !finalFbp.trim()) {
    finalFbp = generateFbp(donationRow.client_ip_address || '');
  }
  let finalFbc = donationRow.fbc;
  if (!finalFbc || !finalFbc.trim()) {
    finalFbc = await generateFbc(donationRow.email, donationRow.fbclid);
  }
  // Ensure fbp and fbc are stored in DB for future use
  if (!donationRow.fbp || !donationRow.fbc || !donationRow.fbp.trim() || !donationRow.fbc.trim()) {
    await dbRun("UPDATE donations SET fbp = ?, fbc = ? WHERE id = ?", [finalFbp, finalFbc, donationRow.id]);
    donationRow.fbp = finalFbp;
    donationRow.fbc = finalFbc;
  }

  userData.fbp = finalFbp;
  if (finalFbc) {
    userData.fbc = finalFbc;
  }

  const eventSourceUrl = donationRow.order_complete_url || 'https://example.com/orderComplete';
  const finalEventId = donationRow.event_id || String(donationRow.id);

  // Set action_source to "website" if this is the first attempt OR if the donation was created within the last 5 minutes
  const actionSource = (donationRow.fb_conversion_sent === 0 || (Date.now() - new Date(donationRow.created_at).getTime() < 5 * 60 * 1000))
                         ? 'website'
                         : 'server';

  const eventData = {
    event_name: 'Purchase',
    event_time: Math.floor(Date.now() / 1000),
    event_id: finalEventId,
    event_source_url: eventSourceUrl,
    action_source: actionSource,
    user_data: userData,
    custom_data: {
      value: donationRow.donation_amount ? donationRow.donation_amount / 100 : 0,
      currency: 'USD'
    }
  };
  if (donationRow.fbclid) {
    eventData.custom_data.fbclid = donationRow.fbclid;
  }

  const payload = { data: [eventData] };
  if (FACEBOOK_TEST_EVENT_CODE) {
    payload.test_event_code = FACEBOOK_TEST_EVENT_CODE;
  }

  const fbUrl = `https://graph.facebook.com/v15.0/${FACEBOOK_PIXEL_ID}/events?access_token=${FACEBOOK_ACCESS_TOKEN}`;
  const response = await fetch(fbUrl, {
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

  // Return the final fbp/fbc in case we generated them
  return { success: true, result, finalFbp, finalFbc };
}

async function attemptFacebookConversion(donationRow) {
  // Ensure we have default values for client IP and User-Agent for retries
  if (!donationRow.client_ip_address) {
    donationRow.client_ip_address = '0.0.0.0';
  }
  if (!donationRow.client_user_agent) {
    donationRow.client_user_agent = 'Unknown';
  }
  
  if (donationRow.payment_intent_status !== 'succeeded') {
    return { success: false, error: new Error('Payment not successful, skipping conversion'), attempts: 0 };
  }
  const maxAttempts = 5;
  let attempt = 0;
  let delay = 2000; // Start with 2s delay
  let lastError = null;

  while (attempt < maxAttempts) {
    try {
      const result = await sendFacebookConversionEvent(donationRow);
      if (result.success) {
        return { success: true, ...result, attempts: attempt + 1 };
      }
      lastError = new Error(result.error || "Unknown error");
    } catch (err) {
      lastError = err;
    }
    attempt++;
    console.warn(`Attempt ${attempt} failed for donation ID ${donationRow.id}: ${lastError.message}`);
    await new Promise(resolve => setTimeout(resolve, delay));
    delay *= 2;
  }
  return { success: false, error: lastError, attempts: maxAttempts };
}

// ------------------------------------------------------
// ROUTE: /api/fb-conversion
// ------------------------------------------------------
app.post('/api/fb-conversion', async (req, res) => {
  try {
    const {
      event_name,
      event_time,
      event_id,
      email,
      amount,
      fbp,
      fbc,
      fbclid,
      user_data = {},
      orderCompleteUrl
    } = req.body;

    // Retrieve fbclid from session or database as a fallback
    let finalFbclid = fbclid || req.session.fbclid || await dbGetFbclid(email) || null;

    if (!email || !amount) {
      return res.status(400).json({ error: 'Missing email or amount' });
    }

    // Store fbclid in DB linked with email using the helper function
    await storeFbclid(email, finalFbclid);

    const donationAmountCents = Math.round(Number(amount) * 100);

    // 1) Check for an existing donation within the last 24 hours
    let row = await dbGet(
      "SELECT * FROM donations WHERE email = ? AND donation_amount = ? AND created_at >= datetime('now', '-1 day') LIMIT 1",
      [email, donationAmountCents]
    );

    if (!row) {
      // 2) Insert a new donation record
      const insert = await dbRun(
        "INSERT INTO donations (\
          donation_amount,\
          email,\
          first_name,\
          last_name,\
          country,\
          postal_code,\
          fbclid,\
          fbp,\
          fbc,\
          event_id,\
          order_complete_url,\
          fb_conversion_sent\
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          donationAmountCents,
          email,
          user_data.fn || null,
          user_data.ln || null,
          user_data.country || null,
          user_data.zp || null,
          finalFbclid,
          fbp || null,
          fbc || null,
          event_id || null,
          orderCompleteUrl || null,
          0
        ]
      );
      row = await dbGet("SELECT * FROM donations WHERE id = ?", [insert.lastID]);
    } else {
      // 3) Update the existing donation record
      await dbRun(
        "UPDATE donations SET first_name = COALESCE(first_name, ?),\
               last_name = COALESCE(last_name, ?),\
               country = COALESCE(country, ?),\
               postal_code = COALESCE(postal_code, ?),\
               fbclid = COALESCE(fbclid, ?),\
               fbp = COALESCE(fbp, ?),\
               fbc = COALESCE(fbc, ?),\
               event_id = COALESCE(event_id, ?),\
               order_complete_url = COALESCE(order_complete_url, ?)\
         WHERE id = ?",
        [
          user_data.fn || null,
          user_data.ln || null,
          user_data.country || null,
          user_data.zp || null,
          finalFbclid,
          fbp || null,
          fbc || null,
          event_id || null,
          orderCompleteUrl || null,
          row.id
        ]
      );
      row = await dbGet("SELECT * FROM donations WHERE id = ?", [row.id]);
    }

    // Ensure that the associated Stripe payment was successful
    if (!row.payment_intent_id) {
      return res.status(400).json({ error: 'No Stripe payment intent associated with this donation.' });
    }
    const paymentIntent = await stripeInstance.paymentIntents.retrieve(row.payment_intent_id);
    if (!paymentIntent || paymentIntent.status !== 'succeeded') {
      return res.status(400).json({ error: 'Payment not successful, conversion not sent.' });
    }

    // Update the donation record with client IP, User-Agent, and a proper order complete URL
    const clientIp = req.headers['x-forwarded-for']
                  || req.connection?.remoteAddress
                  || req.socket?.remoteAddress
                  || '';
    const clientUserAgent = req.headers['user-agent'] || '';
    const orderCompleteUrlToUse = orderCompleteUrl || req.headers.referer || 'https://yourwebsite.com/order-complete';
    await dbRun(
      "UPDATE donations SET client_ip_address = ?, client_user_agent = ?, order_complete_url = ? WHERE id = ?",
      [clientIp, clientUserAgent, orderCompleteUrlToUse, row.id]
    );
    row.client_ip_address = clientIp;
    row.client_user_agent = clientUserAgent;
    row.order_complete_url = orderCompleteUrlToUse;

    // Log the raw payload for the conversion attempt
    const rawPayload = JSON.stringify(req.body);
    const insertLog = await dbRun(
      "INSERT INTO fb_conversion_logs (donation_id, raw_payload, attempts, status) VALUES (?, ?, 0, 'pending')",
      [row.id, rawPayload]
    );
    const logId = insertLog.lastID;

    // Attempt the Facebook conversion with up to 5 retries and exponential backoff
    const conversionResult = await attemptFacebookConversion(row);
    const now = new Date().toISOString();

    if (conversionResult.success) {
      // Mark the conversion as sent
      await dbRun("UPDATE fb_conversion_logs SET status = 'sent', attempts = ?, last_attempt = ? WHERE id = ?", [conversionResult.attempts, now, logId]);

      await dbRun(
        "UPDATE donations SET fb_conversion_sent = 1, fbp = ?, fbc = ? WHERE id = ?",
        [
          conversionResult.finalFbp || row.fbp,
          conversionResult.finalFbc || row.fbc,
          row.id
        ]
      );

      // Return the (possibly updated) fbp/fbc to the frontend
      return res.json({
        message: 'Conversion processing initiated.',
        fbp: conversionResult.finalFbp,
        fbc: conversionResult.finalFbc
      });
    } else {
      // Log the failure
      await dbRun("UPDATE fb_conversion_logs SET attempts = ?, last_attempt = ?, error = ? WHERE id = ?", [
          conversionResult.attempts,
          now,
          conversionResult.error ? conversionResult.error.message : '',
          logId
        ]);
      return res.status(500).json({ error: 'Failed to send conversion after multiple retries.' });
    }
  } catch (err) {
    console.error('Error in /api/fb-conversion:', err);
    return res.status(500).json({ error: 'Internal error sending FB conversion.' });
  }
});

// ------------------------------------------------------
// CREATE-PAYMENT-INTENT (Stripe)
// ------------------------------------------------------
app.post('/create-payment-intent', async (req, res, next) => {
  let { donationAmount, email, firstName, lastName, cardName, country, postalCode, event_id } = req.body;
  try {
    if (!donationAmount || !email) {
      return res.status(400).json({ error: 'Donation amount and email are required.' });
    }
    const amountCents = Math.round(Number(donationAmount) * 100);
    if (isNaN(amountCents) || amountCents <= 0) {
      return res.status(400).json({ error: 'Invalid donation amount.' });
    }

    // Ensure event_id is stored
    const eventId = event_id || `order_${Date.now()}_${Math.random().toString(36).substr(2, 9).toUpperCase()}`;

    // Generate fbp and fbc
    const fbp = generateFbp(); // No client IP available at this stage
    const fbc = await generateFbc(email, null); // No fbclid yet at this stage

    // Create Stripe PaymentIntent
    const paymentIntent = await stripeInstance.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      receipt_email: email
    });

    // Insert a new donation record with "pending" status, event_id, and fbp/fbc
    await dbRun(
      "INSERT INTO donations (\
          donation_amount,\
          email,\
          first_name,\
          last_name,\
          card_name,\
          country,\
          postal_code,\
          payment_intent_id,\
          payment_intent_status,\
          event_id,\
          fbp,\
          fbc\
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        amountCents,
        email,
        firstName || null,
        lastName || null,
        cardName || null,
        country || null,
        postalCode || null,
        paymentIntent.id,
        'pending',
        eventId,
        fbp,
        fbc
      ]
    );

    res.json({ clientSecret: paymentIntent.client_secret, eventId, fbp, fbc });
  } catch (err) {
    console.error('Error in /create-payment-intent:', err);
    try {
      const amountCents = !isNaN(donationAmount) ? Math.round(Number(donationAmount) * 100) : 0;
      await dbRun(
        "INSERT INTO payment_failures (email, amount, error) VALUES (?, ?, ?)",
        [email || '', amountCents, err.message]
      );
    } catch (logErr) {
      console.error('Failed to log payment failure:', logErr);
    }
    next(err);
  }
});

// ------------------------------------------------------
// ADMIN AUTH & ENDPOINTS
// ------------------------------------------------------
function isAuthenticated(req, res, next) {
  if (req.session && req.session.user) {
    return next();
  } else {
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

app.get('/admin-api/check-setup', async (req, res, next) => {
  try {
    const row = await dbGet("SELECT COUNT(*) as count FROM admin_users");
    res.json({ setup: row.count > 0 });
  } catch (err) {
    console.error('Error in /admin-api/check-setup:', err);
    next(err);
  }
});

app.post('/admin-api/register', async (req, res, next) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }
    const row = await dbGet("SELECT COUNT(*) as count FROM admin_users");
    const isFirstUser = row.count === 0;
    if (!isFirstUser && !(req.session && req.session.user)) {
      return res.status(401).json({
        error: 'Unauthorized. Please log in as admin to add new users.',
      });
    }
    const hash = await bcrypt.hash(password, 10);
    await dbRun("INSERT INTO admin_users (username, password) VALUES (?, ?)", [username, hash]);
    res.json({ message: 'Admin user registered successfully.' });
  } catch (err) {
    console.error('Error in /admin-api/register:', err);
    next(err);
  }
});

app.post('/admin-api/login', async (req, res, next) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }
    const user = await dbGet("SELECT * FROM admin_users WHERE username = ?", [username]);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }
    const isMatch = await bcrypt.compare(password, user.password);
    if (isMatch) {
      req.session.user = { id: user.id, username: user.username };
      res.json({ message: 'Login successful.' });
    } else {
      res.status(401).json({ error: 'Invalid credentials.' });
    }
  } catch (err) {
    console.error('Error in /admin-api/login:', err);
    next(err);
  }
});

app.post('/admin-api/logout', (req, res, next) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Error during logout:', err);
      return next(err);
    }
    res.json({ message: 'Logged out.' });
  });
});

app.get('/admin-api/donations', isAuthenticated, async (req, res, next) => {
  try {
    let donations = await dbAll("SELECT * FROM donations ORDER BY created_at DESC");
    // Update pending statuses from Stripe
    for (let donation of donations) {
      if (donation.payment_intent_status === 'pending') {
        try {
          const paymentIntent = await stripeInstance.paymentIntents.retrieve(donation.payment_intent_id);
          if (paymentIntent.status !== donation.payment_intent_status) {
            await dbRun(
              "UPDATE donations SET payment_intent_status = ? WHERE id = ?",
              [paymentIntent.status, donation.id]
            );
            donation.payment_intent_status = paymentIntent.status;
          }
        } catch (err) {
          console.error(`Error fetching PaymentIntent for donation id ${donation.id}:`, err);
        }
      }
    }
    res.json({ donations });
  } catch (err) {
    console.error('Error in /admin-api/donations:', err);
    next(err);
  }
});

app.post('/admin-api/users', isAuthenticated, async (req, res, next) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }
    const hash = await bcrypt.hash(password, 10);
    await dbRun("INSERT INTO admin_users (username, password) VALUES (?, ?)", [username, hash]);
    res.json({ message: 'New admin user added successfully.' });
  } catch (err) {
    console.error('Error in /admin-api/users:', err);
    next(err);
  }
});

// ------------------------------------------------------
// BACKGROUND WORKER: RETRY PENDING FB CONVERSIONS (every 15 minutes)
// ------------------------------------------------------
setInterval(async () => {
  try {
    const logs = await dbAll("SELECT * FROM fb_conversion_logs WHERE status != 'sent'");
    for (const log of logs) {
      const donationRow = await dbGet("SELECT * FROM donations WHERE id = ?", [log.donation_id]);
      if (!donationRow || donationRow.payment_intent_status !== 'succeeded') continue;
      const result = await attemptFacebookConversion(donationRow);
      const now = new Date().toISOString();
      if (result.success) {
        await dbRun("UPDATE fb_conversion_logs SET status = 'sent', attempts = ?, last_attempt = ? WHERE id = ?", [result.attempts, now, log.id]);
        await dbRun("UPDATE donations SET fb_conversion_sent = 1, fbp = ?, fbc = ? WHERE id = ?", [
            result.finalFbp || donationRow.fbp,
            result.finalFbc || donationRow.fbc,
            donationRow.id
          ]);
        console.log(`Successfully retried FB conversion for donation id ${donationRow.id}`);
      } else {
        await dbRun("UPDATE fb_conversion_logs SET attempts = ?, last_attempt = ?, error = ? WHERE id = ?", [
            result.attempts,
            now,
            result.error ? result.error.message : '',
            log.id
          ]);
        console.warn(`Retry pending for donation id ${donationRow.id}`);
      }
    }
  } catch (err) {
    console.error("Error processing pending FB conversions:", err);
  }
}, 900000); // Runs every 15 minutes

// ------------------------------------------------------
// ERROR HANDLING
// ------------------------------------------------------
app.use((err, req, res, next) => {
  console.error('Unhandled error in middleware:', err);
  res.status(500).json({ error: 'An internal server error occurred.' });
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

// ------------------------------------------------------
// START THE SERVER
// ------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
