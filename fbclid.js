
(function() {
  // === CONFIGURATION ===
  // Update the value below with your Railway App's base URL.
  const RAILWAY_BASE_URL = 'https://fbcid-production.up.railway.app';
  // API endpoint slug remains separate for clarity.
  const RAILWAY_API_SLUG = '/api/store-fb-data';

  /**
   * Helper: Get a query parameter from the URL
   */
  function getQueryParam(param) {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get(param);
  }

  /**
   * Helper: Simple cookie setter
   */
  function setCookie(name, value, days) {
    let expires = "";
    if (days) {
      const date = new Date();
      date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
      expires = "; expires=" + date.toUTCString();
    }
    document.cookie = name + "=" + encodeURIComponent(value) + expires + "; path=/";
  }

  // Capture fbclid from the URL
  const fbclid = getQueryParam('fbclid');
  if (fbclid) {
    // Attempt to store it in a cookie for 30 days
    setCookie('fbclid', fbclid, 30);
  }

  // After a short delay, check if the Pixel has set _fbp or if we have _fbc
  setTimeout(function() {
    let fbpCookieMatch = document.cookie.match(new RegExp('(^| )_fbp=([^;]+)'));
    let fbcCookieMatch = document.cookie.match(new RegExp('(^| )_fbc=([^;]+)'));

    let fbp = fbpCookieMatch ? decodeURIComponent(fbpCookieMatch[2]) : null;
    let fbc = fbcCookieMatch ? decodeURIComponent(fbcCookieMatch[2]) : null;

    // Now send all these to the backend for session storage or generation
    fetch(RAILWAY_BASE_URL + RAILWAY_API_SLUG, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include', // Important so the session cookie is used
      body: JSON.stringify({ fbclid, fbp, fbc })
    })
    .then(res => res.json())
    .then(data => {
      console.log('FB data stored in session:', data);
      // If the server generates new fbp/fbc, you could optionally set cookies again here
    })
    .catch(err => console.error('Error storing FB data:', err));
  }, 500);
})();


