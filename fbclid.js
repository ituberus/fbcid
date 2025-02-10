// edit the railway link below
const RAILWAY_BASE_URL = 'https://fbcid-production.up.railway.app';
const CAPTURE_FBCLID_ENDPOINT = '/capture-fbclid';

!function(f, b, e, v, n, t, s) {
  if (f.fbq) return;
  n = f.fbq = function() {
    n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
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
}(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');

// Initialize Pixel (no events fired here)
fbq('init', '1155603432794001'); // your real Pixel ID

// Capture fbclid from URL and store it in localStorage with expiration and on the backend
(function captureFbclid() {
  const urlParams = new URLSearchParams(window.location.search);
  const fbclid = urlParams.get('fbclid');
  if (fbclid) {
    const fbclidData = { value: fbclid, expires: Date.now() + 90 * 24 * 60 * 60 * 1000 }; // 90 days expiration
    try {
      localStorage.setItem('fbclid', JSON.stringify(fbclidData));
    } catch (error) {
      sessionStorage.setItem('fbclid', fbclid);
    }

    // Capture fbclid on the server side using POST
    fetch(`${RAILWAY_BASE_URL}${CAPTURE_FBCLID_ENDPOINT}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fbclid: fbclid })
    })
    .then(() => console.log('Server session stored fbclid:', fbclid))
    .catch(err => console.error('Error capturing fbclid on server:', err));
  }
})();
