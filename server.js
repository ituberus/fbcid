// ===================
// CONFIGURATION
// ===================

// Required libraries and modules
const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const path = require('path');

// Redsys easy - using production URLs now
const {
  createRedsysAPI,
  PRODUCTION_URLS,
  randomTransactionId
} = require('redsys-easy');

// **** Production configuration ****
const MERCHANT_CODE = '367149531';
const TERMINAL = '1';
const SECRET_KEY = 'xdfHKzvmKSvUxPz91snmmjx14FpSWsU7';

// Callback URLs – using your Railway domain
const MERCHANT_MERCHANTURL = 'https://fbcid-production.up.railway.app/redsys-notification';
const MERCHANT_URLOK = 'https://fbcid-production.up.railway.app/thanks.html';
const MERCHANT_URLKO = 'https://fbcid-production.up.railway.app/error.html';

// Create the Redsys API with production URLs
const {
  createRedirectForm,
  processRedirectNotification,
} = createRedsysAPI({
  secretKey: SECRET_KEY,
  urls: PRODUCTION_URLS
});

// ===================
// APP SETUP
// ===================
const app = express();

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (e.g., mobile apps or curl)
    if (!origin) return callback(null, true);
    callback(null, origin);
  },
  credentials: true
}));

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(cookieParser());

app.use(express.static(path.join(__dirname, 'views')));

// ===================
// ROUTES
// ===================

// Serve the donation page (index.html)
app.get('/', (req, res, next) => {
  try {
    res.sendFile(path.join(__dirname, 'views', 'index.html'));
  } catch (err) {
    next(err);
  }
});

// Endpoint to create a donation and store donor data (only "amount" is required)
app.post('/create-donation', (req, res, next) => {
  try {
    const { amount } = req.body;
    if (!amount) {
      return res.status(400).json({ ok: false, error: 'Missing amount.' });
    }
    // Generate a unique order ID
    const orderId = randomTransactionId();

    // Store donor data (only amount and orderId)
    const donor = { amount, orderId };
    res.cookie(`donor_${orderId}`, JSON.stringify(donor), {
      maxAge: 30 * 60 * 1000,  // 30 minutes
      sameSite: 'none',        // required for cross-site cookies
      secure: true,            // required for HTTPS
      domain: 'fbcid-production.up.railway.app'
    });

    return res.json({ ok: true, orderId });
  } catch (err) {
    console.error('Error in /create-donation:', err);
    next(err);
  }
});

// Endpoint to initiate Redsys payment via an iframe redirect
app.get('/iframe-sis', (req, res, next) => {
  try {
    const { orderId } = req.query;
    if (!orderId) {
      return res.status(400).send('<h1>Error: missing orderId param</h1>');
    }
    // Retrieve donor data from the cookie
    const donorCookie = req.cookies[`donor_${orderId}`];
    if (!donorCookie) {
      return res.status(404).send('<h1>Error: no matching donor data</h1>');
    }
    const donor = JSON.parse(donorCookie);

    // Convert amount to cents (Redsys expects an integer amount in cents)
    const dsAmount = (parseFloat(donor.amount) * 100).toFixed(0);

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

// Redsys payment notification endpoint
app.post('/redsys-notification', (req, res, next) => {
  try {
    const result = processRedirectNotification(req.body);
    const responseCode = parseInt(result.Ds_Response || '9999', 10);
    if (responseCode < 100) {
      console.log('Payment SUCCESS, order:', result.Ds_Order);
      return res.send('OK');
    } else {
      console.log('Payment FAILED, order:', result.Ds_Order, 'code:', responseCode);
      return res.send('OK');
    }
  } catch (err) {
    console.error('Error in /redsys-notification:', err);
    next(err);
  }
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ ok: false, error: 'Internal Server Error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running at https://fbcid-production.up.railway.app on port ${PORT}`);
});
