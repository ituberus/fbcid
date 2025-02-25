
(function() {
    // === CONFIGURATION ===
    // Your actual Facebook Pixel ID
    const FACEBOOK_PIXEL_ID = '1155603432794001';

    // Utility function to get query parameters
    function getQueryParam(param) {
        const urlParams = new URLSearchParams(window.location.search);
        return urlParams.get(param);
    }

    // Utility function to set cookies
    function setCookie(name, value, days) {
        let expires = "";
        if (days) {
            const date = new Date();
            date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
            expires = "; expires=" + date.toUTCString();
        }
        document.cookie = name + "=" + encodeURIComponent(value) + expires + "; path=/";
        console.log(`[Cookie Set] ${name}=${value}`);
    }

    // Utility function to store Facebook data in localStorage
    function storeFacebookData(data) {
        Object.entries(data).forEach(([key, value]) => {
            if (value) {
                window.localStorage.setItem(key, value);
                console.log(`[LocalStorage] Set ${key}=${value}`);
            }
        });
    }

    // === 1) Capture fbclid from the URL, store in cookie and localStorage ===
    const fbclid = getQueryParam('fbclid');
    if (fbclid) {
        console.log('[FBID Capture] fbclid found in URL:', fbclid);
        setCookie('fbclid', fbclid, 30);
        storeFacebookData({ fbclid });
    } else {
        console.log('[FBID Capture] No fbclid found in URL.');
    }

    // === 2) Load Facebook Pixel (to generate _fbp if not blocked) ===
    !(function(f, b, e, v, n, t, s) {
        if (f.fbq) return;
        n = f.fbq = function() {
            n.callMethod ?
                n.callMethod.apply(n, arguments) :
                n.queue.push(arguments);
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
    })(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');

    // Initialize the Pixel and track PageView
    fbq('init', FACEBOOK_PIXEL_ID);
    fbq('track', 'PageView');
    console.log('[Facebook Pixel] Initialized and PageView tracked.');

    // === 3) Manually generate _fbc if fbclid is present and we don't already have _fbc ===
    const existingFbc = document.cookie.match(/(^|;)\s*_fbc=([^;]+)/);
    if (fbclid && !existingFbc) {
        const timestamp = Math.floor(Date.now() / 1000);
        const newFbc = `fb.1.${timestamp}.${fbclid}`;
        setCookie('_fbc', newFbc, 30);
        console.log('[FB Conversion] _fbc generated from fbclid:', newFbc);
    } else if (existingFbc) {
        console.log('[FB Conversion] Existing _fbc found:', decodeURIComponent(existingFbc[2]));
    } else {
        console.log('[FB Conversion] No fbclid present to generate _fbc.');
    }

    // === 4) Immediately Store _fbp and _fbc to localStorage if available ===
    function saveFbpFbcToLocalStorage() {
        const fbpMatch = document.cookie.match(/(^|;)\s*_fbp=([^;]+)/);
        const fbcMatch = document.cookie.match(/(^|;)\s*_fbc=([^;]+)/);
        const fbp = fbpMatch ? decodeURIComponent(fbpMatch[2]) : null;
        const fbc = fbcMatch ? decodeURIComponent(fbcMatch[2]) : null;

        if (fbp) {
            window.localStorage.setItem('fbp', fbp);
            console.log('[LocalStorage] Stored fbp:', fbp);
        } else {
            console.log('[LocalStorage] fbp not found in cookies.');
        }

        if (fbc) {
            window.localStorage.setItem('fbc', fbc);
            console.log('[LocalStorage] Stored fbc:', fbc);
        } else {
            console.log('[LocalStorage] fbc not found in cookies.');
        }
    }

    // Attempt to save immediately upon page load
    saveFbpFbcToLocalStorage();

    // === 5) Polling as a fallback to capture _fbp and _fbc if not captured immediately ===
    const pollInterval = 300; // milliseconds
    const maxWait = 3000; // milliseconds (3 seconds)
    const startTime = Date.now();

    const pollHandle = setInterval(() => {
        const elapsed = Date.now() - startTime;
        console.log(`[Polling] Attempting to retrieve _fbp and _fbc. Elapsed time: ${elapsed}ms`);

        const fbpMatch = document.cookie.match(/(^|;)\s*_fbp=([^;]+)/);
        const fbcMatch = document.cookie.match(/(^|;)\s*_fbc=([^;]+)/);
        const fbp = fbpMatch ? decodeURIComponent(fbpMatch[2]) : null;
        const fbc = fbcMatch ? decodeURIComponent(fbcMatch[2]) : null;

        if (fbp && !window.localStorage.getItem('fbp')) {
            window.localStorage.setItem('fbp', fbp);
            console.log('[LocalStorage] Stored fbp via polling:', fbp);
        }

        if (fbc && !window.localStorage.getItem('fbc')) {
            window.localStorage.setItem('fbc', fbc);
            console.log('[LocalStorage] Stored fbc via polling:', fbc);
        }

        // Stop polling if both are found or max wait time exceeded
        if ((fbp && fbc) || (elapsed >= maxWait)) {
            clearInterval(pollHandle);
            console.log('[Polling] Stopped polling.');
        }
    }, pollInterval);

})();

