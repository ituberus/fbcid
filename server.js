// power.js

(async () => {
  // Dynamically import node-fetch and crypto for ESM support
  const fetch = (await import('node-fetch')).default;
  const crypto = (await import('crypto')).default;

  // Your provided test keys
  const FACEBOOK_PIXEL_ID = "1139984163733594";
  const FACEBOOK_ACCESS_TOKEN = "EAAPvYYG47aIBO4kHxLDUHYKd0JGiH3Ta7ar3ZCTz2Pl0knzeTlgytZACh0tbkbVSkjNFNr8uw12xXau52SwZAUa7fV93e9k5OJTZAyFZCIi93jJgcHAL8Kfe68gZBpZCfeZAVHx5hNHdj28JHSxuimvjZByIEB7y0puf7RhbRZBNocmy9xzRhUXS1cfF4GJ5wD2E8htAZDZD";
  const FACEBOOK_TEST_EVENT_CODE = "TEST56813";

  // Sample data in the same format as used in the main code
  const sampleOrderId = "TEST_ORDER_123456";
  const sampleDonationAmountCents = 1000; // Represents 10 EUR (1000 cents)
  const sampleFbp = "fb.2.1680000000.987654321";
  const sampleFbc = "fb.2.1680000000.samplefbclid";
  const sampleClientIpAddress = "203.0.113.45"; // Sample IP address
  const sampleClientUserAgent = "Mozilla/5.0 (X11; Linux x86_64)";
  const sampleCountry = "SA"; // Two-letter country code (Saudi Arabia)

  // Hash the country code as in the main code (using SHA-256)
  const hashedCountry = crypto.createHash('sha256').update(sampleCountry.toLowerCase()).digest('hex');

  // Prepare the user_data object with all sample data
  const userData = {
    fbp: sampleFbp,
    fbc: sampleFbc,
    client_ip_address: sampleClientIpAddress,
    client_user_agent: sampleClientUserAgent,
    country: hashedCountry
  };

  // Prepare the event data using the same format as in the main code
  const eventData = {
    event_name: "Purchase",
    event_time: Math.floor(Date.now() / 1000),
    event_id: sampleOrderId,
    event_source_url: "http://ituberus.github.io/fbcid/thanks.html",
    action_source: "website",
    user_data: userData,
    custom_data: {
      value: sampleDonationAmountCents / 100, // Convert cents to EUR value (10.0 EUR)
      currency: "EUR"
    }
  };

  // Construct the complete payload to be sent to Facebook Conversion API
  const payload = {
    data: [ eventData ],
    test_event_code: FACEBOOK_TEST_EVENT_CODE
  };

  const url = `https://graph.facebook.com/v15.0/${FACEBOOK_PIXEL_ID}/events?access_token=${FACEBOOK_ACCESS_TOKEN}`;

  console.log("=== Facebook Conversion API Test ===");
  console.log("Request URL:", url);
  console.log("Payload being sent:\n", JSON.stringify(payload, null, 2));

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const responseText = await response.text();
    console.log("Response Status:", response.status);
    console.log("Response Body:\n", responseText);
  } catch (error) {
    console.error("Error sending test event:", error);
  }
})();
