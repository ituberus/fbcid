// public/js/orderComplete.js

(function() {
  // Set the domain for your external API here (include protocol, e.g., "https://api.example.com")
  const apiDomain = 'https://fbcid-production.up.railway.app';

  // Minimal helpers
  function getCookie(name) {
    const match = document.cookie.match(
      new RegExp('(^| )' + name + '=([^;]+)')
    );
    return match ? decodeURIComponent(match[2]) : null;
  }

  // Attempt to parse donation receipt
  const donationCookie = getCookie('donationReceipt');
  if (!donationCookie) {
    // If no donation cookie, do nothing
    console.log("No donationReceipt cookie found, skipping FB conversion call.");
    return;
  }

  let donationData;
  try {
    donationData = JSON.parse(donationCookie);
  } catch (err) {
    console.error("Cannot parse donationReceipt cookie:", err);
    return;
  }

  // Also get fbclid cookie if set
  const fbclid = getCookie('fbclid') || '';

  // If we want to ensure we only run once, we can check a local marker
  if (donationData.fb_conversion_sent) {
    console.log("Conversion already sent according to cookie, skipping.");
    return;
  }

  // Build the payload for the server
  const payload = {
    name: donationData.name || '',
    email: donationData.email || '',
    amount: donationData.amount || '',
    receiptId: donationData.receiptId || '',
    fbclid: fbclid
  };

  // Use the external API domain
  fetch(apiDomain + '/api/fb-conversion', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
    .then(res => res.json())
    .then(result => {
      console.log("FB Conversion response:", result);

      // If successful, mark local cookie so we don't do it again
      donationData.fb_conversion_sent = true;
      document.cookie = 'donationReceipt=' + encodeURIComponent(JSON.stringify(donationData)) + '; path=/';
    })
    .catch(err => {
      console.error("Error sending FB conversion:", err);
    });
})();
