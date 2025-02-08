 // Standard Facebook Pixel Base Code
    !function(f,b,e,v,n,t,s){
      if(f.fbq)return;
      n=f.fbq=function(){
        n.callMethod? n.callMethod.apply(n,arguments):n.queue.push(arguments);
      };
      if(!f._fbq)f._fbq=n;
      n.push=n;
      n.loaded=!0;
      n.version='2.0';
      n.queue=[];
      t=b.createElement(e);
      t.async=!0;
      t.src=v;
      s=b.getElementsByTagName(e)[0];
      s.parentNode.insertBefore(t,s);
    }(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');

    fbq('init', '1155603432794001'); // Replace with your actual Pixel ID

    // Helper to wait until fbq is loaded before firing events.
    function onFbqReady(callback) {
      if (window.fbq && window.fbq.loaded) {
        callback();
      } else {
        setTimeout(function() {
          onFbqReady(callback);
        }, 50);
      }
    }

    onFbqReady(function() {
      fbq('track', 'PageView');
      fbq('track', 'ViewContent', {
          content_name: 'Landing Page',
          content_category: 'Donation',
          currency: 'USD'
      });
      // Optionally signal PixelReady via a custom event.
      fbq('trackCustom', 'PixelReady');
    });

    // Helper: Get a query parameter from the URL.
    function getQueryParam(param) {
      const urlParams = new URLSearchParams(window.location.search);
      return urlParams.get(param);
    }

    // Helper: Simple cookie setter.
    function setCookie(name, value, days) {
      let expires = "";
      if (days) {
        const date = new Date();
        date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
        expires = "; expires=" + date.toUTCString();
      }
      document.cookie = name + "=" + encodeURIComponent(value) + expires + "; path=/";
    }

    // Capture fbclid from the URL and store it for 30 days.
    const fbclid = getQueryParam('fbclid');
    if (fbclid) {
      setCookie('fbclid', fbclid, 30);
    }

    // After fbq loads, capture the Facebook Browser ID (_fbp) and store it.
    setTimeout(function() {
      // Attempt to read the _fbp cookie set by Facebook.
      const fbpCookieMatch = document.cookie.match(new RegExp('(^| )_fbp=([^;]+)'));
      if (fbpCookieMatch) {
        const fbp = decodeURIComponent(fbpCookieMatch[2]);
        setCookie('fbp', fbp, 30);
      }
    }, 500);
