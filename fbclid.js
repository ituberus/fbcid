(function() {
  // === CONFIGURATION ===
  // Update with your Railway URL.
  const RAILWAY_BASE_URL = 'https://fbcid-production.up.railway.app';
  const RAILWAY_API_SLUG = '/api/store-fb-data';
  // Your actual Facebook Pixel ID
  const FACEBOOK_PIXEL_ID = '1155603432794001';

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

  /**
   * Enhanced data sending function with Beacon API support
   */
  function sendFBData(data) {
    // First, try regular POST
    fetch(RAILWAY_BASE_URL + RAILWAY_API_SLUG, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include', // Important so the session cookie is used
      body: JSON.stringify(data)
    })
    .then(response => response.json())
    .then(result => {
      console.log('FB data stored in session:', result);
      // If there's a beacon URL, use it as backup
      if (result.beaconUrl) {
        navigator.sendBeacon(RAILWAY_BASE_URL + result.beaconUrl, JSON.stringify(data));
      }
    })
    .catch(error => {
      console.error('Error storing FB data:', error);
      // On error, try beacon as fallback
      if (navigator.sendBeacon) {
        navigator.sendBeacon(RAILWAY_BASE_URL + '/api/beacon-fb-data', JSON.stringify(data));
      }
    });
  }

  // === 1) Capture fbclid from the URL and store in a cookie ===
  const fbclid = getQueryParam('fbclid');
  if (fbclid) {
    // Attempt to store fbclid in a cookie for 30 days
    setCookie('fbclid', fbclid, 30);
  }

  // === 2) Load Facebook Pixel (to generate _fbp if not blocked) ===
  (function(f,b,e,v,n,t,s){
    if(f.fbq) return;
    n = f.fbq = function(){ n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
    if(!f._fbq) f._fbq = n;
    n.push = n; n.loaded = !0; n.version = '2.0';
    n.queue = [];
    t = b.createElement(e); t.async = !0;
    t.src = v; s = b.getElementsByTagName(e)[0];
    s.parentNode.insertBefore(t,s);
  })(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');

  // Initialize the Pixel
  fbq('init', FACEBOOK_PIXEL_ID);

  // === 3) Manually generate _fbc if fbclid is present and we don't already have _fbc ===
  // (A safeguard in case Pixel is blocked or slow)
  if (fbclid && document.cookie.indexOf('_fbc=') === -1) {
    const timestamp = Math.floor(Date.now() / 1000);
    const newFbc = `fb.1.${timestamp}.${fbclid}`;
    setCookie('_fbc', newFbc, 30);
  }

  // === 4) Enhanced polling with Beacon API fallback ===
  const pollInterval = 300; // check every 300 ms
  const maxWait = 1500;     // total 1.5 seconds
  const startTime = Date.now();

  const pollHandle = setInterval(() => {
    // Check cookies
    const fbpCookieMatch = document.cookie.match(new RegExp('(^| )_fbp=([^;]+)'));
    const fbcCookieMatch = document.cookie.match(new RegExp('(^| )_fbc=([^;]+)'));

    const fbp = fbpCookieMatch ? decodeURIComponent(fbpCookieMatch[2]) : null;
    const fbc = fbcCookieMatch ? decodeURIComponent(fbcCookieMatch[2]) : null;

    // If we found both or we've waited long enough, send to backend
    if ((fbp && fbc) || (Date.now() - startTime >= maxWait)) {
      // Use the enhanced sending function
      sendFBData({ fbclid, fbp, fbc });
      clearInterval(pollHandle);
      
      // Add page unload handler for extra reliability
      if (navigator.sendBeacon) {
        window.addEventListener('unload', () => {
          navigator.sendBeacon(
            RAILWAY_BASE_URL + '/api/beacon-fb-data', 
            JSON.stringify({ fbclid, fbp, fbc })
          );
        });
      }
    }
  }, pollInterval);
})();
