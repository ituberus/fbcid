const express = require('express');
const path = require('path');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const stripe = require('stripe');
const morgan = require('morgan');
const { promisify } = require('util');
const cors = require('cors');
require('dotenv').config();
const crypto = require('crypto');

// ------------------------------------------------------
// ENVIRONMENT VARIABLES
// ------------------------------------------------------
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
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
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 7 * 24 * 60 * 60 * 1000,
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      sameSite: 'lax',
    },
  })
);

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// SQLite setup
const db = new sqlite3.Database('./database.sqlite', (err) => {
  if (err) {
    console.error('Error opening database:', err);
    process.exit(1);
  } else {
    console.log('Connected to SQLite database.');
  }
});
const dbAll = promisify(db.all).bind(db);
const dbGet = promisify(db.get).bind(db);
const dbRun = (...args) => new Promise((resolve, reject) => {
  db.run(...args, function(err) {
    if (err) return reject(err);
    resolve(this);
  });
});

// Create/alter tables as needed
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS donations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      donation_amount INTEGER,
      email TEXT,
      first_name TEXT,
      last_name TEXT,
      card_name TEXT,
      country TEXT,
      postal_code TEXT,
      payment_intent_id TEXT,
      payment_intent_status TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.run(`ALTER TABLE donations ADD COLUMN fbclid TEXT`, (err) => {
    if (err) console.log('fbclid column may already exist:', err.message);
  });
  db.run(`ALTER TABLE donations ADD COLUMN fb_conversion_sent INTEGER DEFAULT 0`, (err) => {
    if (err) console.log('fb_conversion_sent column may already exist:', err.message);
  });
  db.run(`ALTER TABLE donations ADD COLUMN order_complete_url TEXT`, (err) => {
    if (err) console.log('order_complete_url column may already exist:', err.message);
  });
  db.run(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      password TEXT
    )
  `);
});

// ------------------------------------------------------
// HELPER: Send to FB Conversions API
// ------------------------------------------------------
async function sendFacebookConversionEvent(donationRow) {
  const fetch = (await import('node-fetch')).default;
  let hashedEmail = null;
  if (donationRow.email) {
    hashedEmail = crypto
      .createHash('sha256')
      .update(donationRow.email.trim().toLowerCase())
      .digest('hex');
  }

  // Use the order_complete_url provided by the client (auto-detected)
  const eventSourceUrl = donationRow.order_complete_url;

  const eventData = {
    event_name: "Purchase",
    event_time: Math.floor(Date.now() / 1000),
    event_id: String(donationRow.id),
    event_source_url: eventSourceUrl,
    action_source: "website",
    user_data: {},
    custom_data: {
      value: donationRow.donation_amount ? donationRow.donation_amount / 100 : 0,
      currency: "USD"
    }
  };

  if (hashedEmail) {
    eventData.user_data.em = hashedEmail;
  }
  if (donationRow.fbclid) {
    eventData.custom_data.fbclid = donationRow.fbclid;
  }
  if (donationRow.client_ip_address) {
    eventData.user_data.client_ip_address = donationRow.client_ip_address;
  }
  if (donationRow.client_user_agent) {
    eventData.user_data.client_user_agent = donationRow.client_user_agent;
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
  console.log("Facebook conversion result:", result);
  return result;
}

// ------------------------------------------------------
// NEW ROUTE: /api/fb-conversion
// ------------------------------------------------------
app.post('/api/fb-conversion', async (req, res) => {
  try {
    const { email, name, amount, receiptId, fbclid, orderCompleteUrl } = req.body;
    if (!email || !amount) {
      return res.status(400).json({ error: "Missing email or amount" });
    }
    const donationAmount = Math.round(Number(amount) * 100);
    let row = await dbGet(
      `SELECT * FROM donations WHERE email = ? AND donation_amount = ? LIMIT 1`,
      [email, donationAmount]
    );
    if (!row) {
      const insert = await dbRun(
        `INSERT INTO donations (donation_amount, email, first_name, fbclid, order_complete_url, fb_conversion_sent)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [donationAmount, email, name || null, fbclid || null, orderCompleteUrl, 0]
      );
      row = await dbGet(`SELECT * FROM donations WHERE id = ?`, [insert.lastID]);
    } else {
      await dbRun(
        `UPDATE donations
         SET first_name = COALESCE(first_name, ?),
             fbclid = COALESCE(fbclid, ?),
             order_complete_url = COALESCE(order_complete_url, ?)
         WHERE id = ?`,
        [name || null, fbclid || null, orderCompleteUrl, row.id]
      );
      row = await dbGet(`SELECT * FROM donations WHERE id = ?`, [row.id]);
    }

    if (row.fb_conversion_sent === 1) {
      return res.json({ message: "Already sent conversion for that donation." });
    }

    const clientIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress || '';
    const clientUserAgent = req.headers['user-agent'] || '';
    row.client_ip_address = clientIp;
    row.client_user_agent = clientUserAgent;

    await sendFacebookConversionEvent(row);
    await dbRun(`UPDATE donations SET fb_conversion_sent = 1 WHERE id = ?`, [row.id]);
    return res.json({ message: "Conversion sent to Facebook successfully." });
  } catch (err) {
    console.error("Error in /api/fb-conversion:", err);
    return res.status(500).json({ error: "Internal error sending FB conversion." });
  }
});

// ------------------------------------------------------
// CREATE-PAYMENT-INTENT (Stripe) - unchanged
// ------------------------------------------------------
app.post('/create-payment-intent', async (req, res, next) => {
  try {
    const { donationAmount, email, firstName, lastName, cardName, country, postalCode } = req.body;
    if (!donationAmount || !email) {
      return res.status(400).json({ error: 'Donation amount and email are required.' });
    }
    const amountCents = Math.round(Number(donationAmount) * 100);
    if (isNaN(amountCents) || amountCents <= 0) {
      return res.status(400).json({ error: 'Invalid donation amount.' });
    }
    const paymentIntent = await stripeInstance.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      receipt_email: email,
    });
    await dbRun(
      `INSERT INTO donations (
        donation_amount,
        email,
        first_name,
        last_name,
        card_name,
        country,
        postal_code,
        payment_intent_id,
        payment_intent_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        amountCents,
        email,
        firstName || null,
        lastName || null,
        cardName || null,
        country || null,
        postalCode || null,
        paymentIntent.id,
        'pending'
      ]
    );
    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error('Error in /create-payment-intent:', err);
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
    const row = await dbGet(`SELECT COUNT(*) as count FROM admin_users`);
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
    const row = await dbGet(`SELECT COUNT(*) as count FROM admin_users`);
    const isFirstUser = row.count === 0;
    if (!isFirstUser && !(req.session && req.session.user)) {
      return res.status(401).json({ error: 'Unauthorized. Please log in as admin to add new users.' });
    }
    const hash = await bcrypt.hash(password, 10);
    await dbRun(`INSERT INTO admin_users (username, password) VALUES (?, ?)`, [username, hash]);
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
    const user = await dbGet(`SELECT * FROM admin_users WHERE username = ?`, [username]);
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
    let donations = await dbAll(`SELECT * FROM donations ORDER BY created_at DESC`);
    for (let donation of donations) {
      if (donation.payment_intent_status === 'pending') {
        try {
          const paymentIntent = await stripeInstance.paymentIntents.retrieve(donation.payment_intent_id);
          if (paymentIntent.status !== donation.payment_intent_status) {
            await dbRun(`UPDATE donations SET payment_intent_status = ? WHERE id = ?`, [paymentIntent.status, donation.id]);
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
    await dbRun(`INSERT INTO admin_users (username, password) VALUES (?, ?)`, [username, hash]);
    res.json({ message: 'New admin user added successfully.' });
  } catch (err) {
    console.error('Error in /admin-api/users:', err);
    next(err);
  }
});

// Error handling
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'An internal server error occurred.' });
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
