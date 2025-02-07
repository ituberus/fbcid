(function() {
  // Replace with your actual backend API domain.
  const apiDomain = 'https://fbcid-production.up.railway.app';

  // Minimal cookie helper
  function getCookie(name) {
    const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
    return match ? decodeURIComponent(match[2]) : null;
  }

  // Parse donation receipt cookie
  const donationCookie = getCookie('donationReceipt');
  if (!donationCookie) {
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

  // Get fbclid from cookie if available
  const fbclid = getCookie('fbclid') || '';

  // Prevent duplicate conversion events (if already sent)
  if (donationData.fb_conversion_sent) {
    console.log("Conversion already sent according to cookie, skipping.");
    return;
  }

  // Auto-detect the current page URL (e.g. could be /thanks.html, /orderComplete, etc.)
  const orderCompleteUrl = window.location.href;

  // Build payload to send to the server
  const payload = {
    name: donationData.name || '',
    email: donationData.email || '',
    amount: donationData.amount || '',
    receiptId: donationData.receiptId || '',
    fbclid: fbclid,
    orderCompleteUrl: orderCompleteUrl
  };

  fetch(apiDomain + '/api/fb-conversion', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
    .then(res => res.json())
    .then(result => {
      console.log("FB Conversion response:", result);
      // Mark the donation as conversion sent to prevent duplicates
      donationData.fb_conversion_sent = true;
      document.cookie = 'donationReceipt=' + encodeURIComponent(JSON.stringify(donationData)) + '; path=/';
    })
    .catch(err => {
      console.error("Error sending FB conversion:", err);
    });
})();
