// server.js

const express = require('express');
const path = require('path');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const stripe = require('stripe');
const morgan = require('morgan');
const { promisify } = require('util');
const bodyParser = require('body-parser');
const cors = require('cors'); 
require('dotenv').config();

const crypto = require('crypto');
const fetch = require('node-fetch');

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || null; 
const stripeInstance = stripe(STRIPE_SECRET_KEY);

// If you have them set
const FACEBOOK_PIXEL_ID = process.env.FACEBOOK_PIXEL_ID || '';
const FACEBOOK_ACCESS_TOKEN = process.env.FACEBOOK_ACCESS_TOKEN || '';
const FACEBOOK_TEST_EVENT_CODE = process.env.FACEBOOK_TEST_EVENT_CODE || '';

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'somesecret';

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
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
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

  // Add columns for fbclid + fb_conversion_sent if not present
  db.run(`ALTER TABLE donations ADD COLUMN fbclid TEXT`, (err) => {
    if (err) console.log('fbclid column may already exist:', err.message);
  });
  db.run(`ALTER TABLE donations ADD COLUMN fb_conversion_sent INTEGER DEFAULT 0`, (err) => {
    if (err) console.log('fb_conversion_sent column may already exist:', err.message);
  });

  db.run(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      password TEXT
    )
  `);
});

// ---------------------
// Helper: Send to FB Conversions API
// ---------------------
async function sendFacebookConversionEvent(donationRow) {
  // Hash email if present
  let hashedEmail = null;
  if (donationRow.email) {
    hashedEmail = crypto
      .createHash('sha256')
      .update(donationRow.email.trim().toLowerCase())
      .digest('hex');
  }

  const eventData = {
    event_name: "Purchase",
    event_time: Math.floor(Date.now() / 1000),
    event_id: String(donationRow.id),
    event_source_url: "https://example.com/orderComplete",
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

  const payload = {
    data: [eventData]
  };

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

// ---------------------
// New route: /api/fb-conversion
// Called from orderComplete.js (final page) to store data and send to FB
// Adjust logic if you prefer to find the DB row by paymentIntent or something else
// For example, we do: if we find row by email + receipt ID, update + send event.
app.post('/api/fb-conversion', async (req, res) => {
  try {
    const { email, name, amount, receiptId, fbclid } = req.body;

    if (!email || !amount) {
      return res.status(400).json({ error: "Missing email or amount" });
    }

    // Convert amount to cents if needed
    const donationAmount = Math.round(Number(amount) * 100);

    // Option 1: "Find or insert" logic by email + receipt ID
    // For demonstration, we just see if a row exists with the same email and "pending" or something
    // In your real code, you might want to locate the row by `payment_intent_id`.
    // We'll do a simplistic approach:

    let row = await dbGet(
      `SELECT * FROM donations WHERE email = ? AND donation_amount = ? LIMIT 1`,
      [email, donationAmount]
    );

    if (!row) {
      // Insert a new row if no existing record found
      // (you might not want this if your data is strictly from Stripe PaymentIntents)
      const insert = await dbRun(
        `INSERT INTO donations (donation_amount, email, first_name, fbclid, fb_conversion_sent) 
         VALUES (?, ?, ?, ?, ?)`,
        [donationAmount, email, name || null, fbclid || null, 0]
      );
      // Retrieve it back
      row = await dbGet(`SELECT * FROM donations WHERE id = ?`, [insert.lastID]);
    } else {
      // If found, update the row with new fields (like name, fbclid, etc.) if not set
      await dbRun(
        `UPDATE donations 
         SET first_name = COALESCE(first_name, ?), 
             fbclid = COALESCE(fbclid, ?) 
         WHERE id = ?`,
        [name || null, fbclid || null, row.id]
      );
      // Re-fetch
      row = await dbGet(`SELECT * FROM donations WHERE id = ?`, [row.id]);
    }

    // If fb_conversion_sent is already 1, skip
    if (row.fb_conversion_sent === 1) {
      return res.json({ message: "Already sent conversion for that donation." });
    }

    // Send event to Facebook
    await sendFacebookConversionEvent(row);

    // Mark the DB row as having conversion sent
    await dbRun(
      `UPDATE donations SET fb_conversion_sent = 1 WHERE id = ?`,
      [row.id]
    );

    return res.json({ message: "Conversion sent to Facebook successfully." });

  } catch (err) {
    console.error("Error in /api/fb-conversion:", err);
    return res.status(500).json({ error: "Internal error sending FB conversion." });
  }
});

// ---------------------
// Original endpoints (unchanged) ...
// ---------------------

// create-payment-intent, webhook, etc.
app.post('/create-payment-intent', async (req, res, next) => {
  try {
    const {
      donationAmount,
      email,
      firstName,
      lastName,
      cardName,
      country,
      postalCode
    } = req.body;

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

// Stripe webhook
app.post('/webhook', bodyParser.raw({ type: 'application/json' }), (req, res) => {
  let event;

  if (STRIPE_WEBHOOK_SECRET) {
    const signature = req.headers['stripe-signature'];
    try {
      event = stripeInstance.webhooks.constructEvent(
        req.body,
        signature,
        STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error('Stripe webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
  } else {
    try {
      event = JSON.parse(req.body);
    } catch (err) {
      console.error('Webhook parse error:', err);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
  }

  if (event.type === 'payment_intent.succeeded') {
    const paymentIntent = event.data.object;
    dbRun(
      `UPDATE donations SET payment_intent_status = ? WHERE payment_intent_id = ?`,
      ['succeeded', paymentIntent.id]
    ).then(() => {
      console.log(`Donation record updated for PaymentIntent ${paymentIntent.id}`);
    }).catch((err) => {
      console.error('DB Update Error in webhook:', err);
    });
  }

  res.json({ received: true });
});

// Admin endpoints (unchanged)...
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
    // If still pending, check Stripe for status updates
    for (let donation of donations) {
      if (donation.payment_intent_status === 'pending') {
        try {
          const paymentIntent = await stripeInstance.paymentIntents.retrieve(donation.payment_intent_id);
          if (paymentIntent.status !== donation.payment_intent_status) {
            await dbRun(
              `UPDATE donations SET payment_intent_status = ? WHERE id = ?`,
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
