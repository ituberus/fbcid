// server.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const https = require('https');
const { URL } = require('url');
const fs = require('fs');

// If DEBUG_TLS is set to true in .env, disable TLS certificate validation (testing only!)
if (process.env.DEBUG_TLS === 'true') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  console.log("DEBUG_TLS enabled: TLS certificate validation disabled (for testing ONLY)");
}

const app = express();

// Use JSON body parser
app.use(bodyParser.json());
// Allow all CORS requests
app.use(cors({ origin: '*' }));
// Serve static files from the "public" directory
app.use(express.static(path.join(__dirname, 'public')));

// Load credentials from .env
const { MERCHANT_CODE, TERMINAL, SECRET_KEY, REDSYS_URL, PORT } = process.env;
console.log("MERCHANT_CODE:", MERCHANT_CODE);
console.log("REDSYS_URL:", REDSYS_URL);

// Helper: Convert parameters to a Base64-encoded JSON string.
function createMerchantParameters(params) {
  const jsonParams = JSON.stringify(params);
  return Buffer.from(jsonParams).toString('base64');
}

// Helper: Create signature using HMAC SHA-256.
function createSignature(merchantParameters, secretKey) {
  const key = Buffer.from(secretKey, 'base64');
  return crypto.createHmac('sha256', key)
    .update(merchantParameters)
    .digest('base64');
}

// POST /pay endpoint: builds the payment request and sends it to Redsys.
app.post('/pay', async (req, res) => {
  try {
    const { token, donationAmount, email, firstName, lastName, cardName } = req.body;
    if (!token) {
      return res.status(400).json({ error: "Missing token from Redsys inSite" });
    }

    // Generate a unique order ID.
    const orderId = "ORDER" + Date.now();
    // Convert donation amount (in €) to cents.
    const amount = parseInt(donationAmount) * 100;

    // Build merchant parameters.
    const merchantParams = {
      DS_MERCHANT_AMOUNT: amount.toString(),
      DS_MERCHANT_ORDER: orderId,
      DS_MERCHANT_MERCHANTCODE: MERCHANT_CODE,
      DS_MERCHANT_CURRENCY: "978", // EUR code
      DS_MERCHANT_TRANSACTIONTYPE: "0", // Payment
      DS_MERCHANT_TERMINAL: TERMINAL,
      DS_MERCHANT_EMV3DS: "1", // Enable 3D Secure
      DS_MERCHANT_IDENTIFIER: token
    };

    // Create the Base64-encoded parameter string and signature.
    const encodedParams = createMerchantParameters(merchantParams);
    const signature = createSignature(encodedParams, SECRET_KEY);

    // Prepare payload using lowercase keys.
    const payload = {
      ds_merchantparameters: encodedParams,
      ds_signatureversion: "HMAC_SHA256_V1",
      ds_signature: signature
    };

    console.log("Sending payload to Redsys:", payload);

    // Create an HTTPS agent forcing TLSv1.2 and setting SNI.
    const httpsAgent = new https.Agent({
      secureProtocol: 'TLSv1_2_method', // Force TLS 1.2
      servername: new URL(REDSYS_URL).hostname, // Set SNI from Redsys URL
      // ca: fs.readFileSync('/path/to/redsys-ca.pem') // Optionally provide custom CA certificate(s)
    });

    // Send the request to Redsys using the custom HTTPS agent.
    const response = await axios.post(REDSYS_URL, payload, { httpsAgent });
    const data = response.data;
    console.log("Redsys response:", data);

    // If Ds_Response < 101, the payment is considered successful.
    if (data.Ds_Response && parseInt(data.Ds_Response) < 101) {
      return res.json({ success: true, message: "Payment successful", orderId });
    } else {
      return res.json({ success: false, error: "Payment declined", details: data });
    }
  } catch (err) {
    console.error("Error in /pay:", err.message);
    return res.status(500).json({ error: "Internal Server Error", details: err.message });
  }
});

// POST /redsys-response endpoint: to process notifications from Redsys.
app.post('/redsys-response', (req, res) => {
  try {
    const { Ds_MerchantParameters, Ds_Signature } = req.body;
    if (!Ds_MerchantParameters || !Ds_Signature) {
      return res.status(400).json({ error: "Missing parameters" });
    }
    const decodedParams = JSON.parse(Buffer.from(Ds_MerchantParameters, 'base64').toString());
    const computedSignature = createSignature(Ds_MerchantParameters, SECRET_KEY);
    if (computedSignature !== Ds_Signature) {
      return res.status(400).json({ error: "Invalid signature" });
    }
    if (parseInt(decodedParams.Ds_Response) < 101) {
      return res.json({ success: true, message: "Payment verified", details: decodedParams });
    } else {
      return res.json({ success: false, message: "Payment failed", details: decodedParams });
    }
  } catch (error) {
    console.error("Error in /redsys-response:", error.message);
    return res.status(500).json({ error: "Error processing response", details: error.message });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
