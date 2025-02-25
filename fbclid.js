
(function() {
  // === CONFIGURATION ===
  // Your actual Facebook Pixel ID
  const FACEBOOK_PIXEL_ID = '1155603432794001';

  /**
   * Retrieves the value of a query parameter from the URL.
   * @param {string} param - The name of the query parameter.
   * @returns {string|null} - The value of the query parameter or null if not found.
   */
  function getQueryParam(param) {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get(param);
  }

  /**
   * Sets a cookie with the specified name, value, and expiration in days.
   * @param {string} name - The name of the cookie.
   * @param {string} value - The value to be stored in the cookie.
   * @param {number} days - Number of days until the cookie expires.
   */
  function setCookie(name, value, days) {
    let expires = "";
    if (days) {
      const date = new Date();
      date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
      expires = "; expires=" + date.toUTCString();
    }
    document.cookie = name + "=" + encodeURIComponent(value) + expires + "; path=/";
    console.log(`[setCookie] Set cookie: ${name}=${value}`);
  }

  /**
   * Stores Facebook data in localStorage.
   * @param {Object} data - An object containing fbclid, fbp, and fbc.
   */
  function storeFacebookData(data) {
    Object.entries(data).forEach(([key, value]) => {
      if (value) {
        window.localStorage.setItem(key, value);
        console.log(`[storeFacebookData] Stored in localStorage: ${key}=${value}`);
      }
    });
  }

  /**
   * Retrieves the value of a specific cookie.
   * @param {string} name - The name of the cookie.
   * @returns {string|null} - The value of the cookie or null if not found.
   */
  function getCookie(name) {
    const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
    if (match) {
      return decodeURIComponent(match[2]);
    }
    return null;
  }

  // === 1) Capture fbclid from the URL, store in cookie and localStorage ===
  const fbclid = getQueryParam('fbclid');
  if (fbclid) {
    console.log(`[fbclid] Found fbclid in URL: ${fbclid}`);
    setCookie('fbclid', fbclid, 30);
    window.localStorage.setItem('fbclid', fbclid);
  } else {
    console.log('[fbclid] No fbclid found in URL.');
  }

  // === 2) Load Facebook Pixel (to generate _fbp if not blocked) ===
  (function(f, b, e, v, n, t, s) {
    if (f.fbq) return;
    n = f.fbq = function() {
      n.callMethod ?
        n.callMethod.apply(n, arguments) : n.queue.push(arguments);
    };
    if (!f._fbq) f._fbq = n;
    n.push = n;
    n.loaded = !0;
    n.version = '2.0';
    n.queue = [];
    t = b.createElement(e);
    t.async = !0;
    t.src = v;
    s = b.getElementsByTagName(e)[0];
    s.parentNode.insertBefore(t, s);
    console.log('[Facebook Pixel] Pixel script loaded.');
  })(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');

  // Initialize the Pixel
  fbq('init', FACEBOOK_PIXEL_ID);
  console.log(`[Facebook Pixel] Initialized with ID: ${FACEBOOK_PIXEL_ID}`);

  // === 3) Manually generate _fbc if fbclid is present and _fbc not in cookie ===
  const existingFbc = getCookie('_fbc');
  if (fbclid && !existingFbc) {
    const timestamp = Math.floor(Date.now() / 1000);
    const newFbc = `fb.1.${timestamp}.${fbclid}`;
    setCookie('_fbc', newFbc, 30);
    console.log(`[_fbc] Generated and set _fbc: ${newFbc}`);
  } else {
    if (existingFbc) {
      console.log(`[_fbc] Existing _fbc found: ${existingFbc}`);
    } else {
      console.log('[_fbc] No fbclid present; _fbc not generated.');
    }
  }

  // === 4) Retrieve _fbp and _fbc from cookies and store in localStorage ===
  // Ensure that the Pixel has had enough time to set _fbp and _fbc
  // Using a promise to wait until Pixel initializes and sets cookies
  function waitForPixel(callback) {
    const maxAttempts = 10;
    let attempts = 0;
    const interval = setInterval(() => {
      const fbp = getCookie('_fbp');
      const fbc = getCookie('_fbc');
      if (fbp || fbc || attempts >= maxAttempts) {
        clearInterval(interval);
        callback(fbp, fbc);
      }
      attempts++;
    }, 100); // Check every 100ms
  }

  waitForPixel((fbp, fbc) => {
    if (fbp) {
      window.localStorage.setItem('fbp', fbp);
      console.log(`[fbp] Stored in localStorage: ${fbp}`);
    } else {
      console.warn('[fbp] _fbp not found.');
    }

    if (fbc) {
      window.localStorage.setItem('fbc', fbc);
      console.log(`[fbc] Stored in localStorage: ${fbc}`);
    } else {
      console.warn('[fbc] _fbc not found.');
    }

    // Final log of all Facebook data stored
    const storedData = {
      fbclid: window.localStorage.getItem('fbclid') || null,
      fbp: window.localStorage.getItem('fbp') || null,
      fbc: window.localStorage.getItem('fbc') || null
    };
    console.log('[Facebook Data] Final stored data in localStorage:', storedData);
  });

})();
