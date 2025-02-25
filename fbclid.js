(function() {
  // === CONFIGURATION ===
  const RAILWAY_BASE_URL = 'https://fbcid-production.up.railway.app';
  // Your actual Facebook Pixel ID
  const FACEBOOK_PIXEL_ID = '1155603432794001';

  function getQueryParam(param) {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get(param);
  }
  
  function setCookie(name, value, days) {
    let expires = "";
    if (days) {
      const date = new Date();
      date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
      expires = "; expires=" + date.toUTCString();
    }
    document.cookie = name + "=" + encodeURIComponent(value) + expires + "; path=/";
  }

  // === 1) Capture fbclid from the URL and store in cookie and localStorage ===
  const fbclid = getQueryParam('fbclid');
  if (fbclid) {
    setCookie('fbclid', fbclid, 30);
    localStorage.setItem('fbclid', fbclid);
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

  fbq('init', FACEBOOK_PIXEL_ID);

  // === 3) Manually generate _fbc if fbclid is present and not already set ===
  if (fbclid && document.cookie.indexOf('_fbc=') === -1) {
    const timestamp = Math.floor(Date.now() / 1000);
    const newFbc = `fb.1.${timestamp}.${fbclid}`;
    setCookie('_fbc', newFbc, 30);
  }

  // === 4) Poll for _fbp and _fbc cookies and store them in localStorage ===
  const pollInterval = 300;
  const maxWait = 1500;
  const startTime = Date.now();

  const pollHandle = setInterval(() => {
    const fbpCookieMatch = document.cookie.match(new RegExp('(^| )_fbp=([^;]+)'));
    const fbcCookieMatch = document.cookie.match(new RegExp('(^| )_fbc=([^;]+)'));
    const fbp = fbpCookieMatch ? decodeURIComponent(fbpCookieMatch[2]) : null;
    const fbc = fbcCookieMatch ? decodeURIComponent(fbcCookieMatch[2]) : null;
    if (fbp) localStorage.setItem('fbp', fbp);
    if (fbc) localStorage.setItem('fbc', fbc);
    if ((fbp && fbc) || (Date.now() - startTime >= maxWait)) {
      clearInterval(pollHandle);
    }
  }, pollInterval);
})();
