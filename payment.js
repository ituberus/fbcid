
    const API_DOMAIN = 'https://fbcid-production.up.railway.app';  // your  railway link
    const FACEBOOK_PIXEL_ID = '1155603432794001'; // your  Pixel ID

    /**********************************************
     * HELPER FUNCTIONS FOR fbclid, event_id, fbc, fbp, and hashing
     **********************************************/
    
    // Helper: SHA-256 hashing function using SubtleCrypto
    async function hashData(data) {
      const encoder = new TextEncoder();
      const dataBuffer = encoder.encode((data || '').trim().toLowerCase());
      const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
      return hashHex;
    }
    
    // Async: Get valid fbclid from sessionStorage/localStorage with expiration check, or fetch from backend if not available
    async function getFbclidAsync() {
      // Check sessionStorage first (fastest retrieval)
      let fbclid = sessionStorage.getItem('fbclid');
      if (fbclid) return fbclid;
      
      // Next, check localStorage
      let stored = localStorage.getItem('fbclid');
      if (stored) {
        try {
          const fbclidData = JSON.parse(stored);
          if (fbclidData && fbclidData.expires && fbclidData.expires > Date.now()) {
            sessionStorage.setItem('fbclid', fbclidData.value);
            return fbclidData.value;
          } else {
            localStorage.removeItem('fbclid');
          }
        } catch (e) {
          sessionStorage.setItem('fbclid', stored);
          return stored;
        }
      }
      // Finally, fetch from backend if missing
      try {
        const response = await fetch(API_DOMAIN + '/get-fbclid', { credentials: 'include' });
        const data = await response.json();
        if (data.fbclid) {
          sessionStorage.setItem('fbclid', data.fbclid);
          const fbclidData = { value: data.fbclid, expires: Date.now() + 90 * 24 * 60 * 60 * 1000 };
          localStorage.setItem('fbclid', JSON.stringify(fbclidData));
          return data.fbclid;
        }
      } catch (error) {
        console.error('Error fetching fbclid from backend:', error);
      }
      return '';
    }

    // Asynchronous: Get or generate event_id, ensuring consistency between frontend and backend.
    async function getOrGenerateEventId(email) {
      let eventId = sessionStorage.getItem('event_id');
      if (!eventId) {
        try {
          const response = await fetch(API_DOMAIN + '/get-latest-event-id?email=' + encodeURIComponent(email), { credentials: 'include' });
          const data = await response.json();
          eventId = data.event_id || `event_${Date.now()}_${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
          sessionStorage.setItem('event_id', eventId);
        } catch (error) {
          console.error("Error fetching event_id from backend:", error);
          eventId = `event_${Date.now()}_${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
          sessionStorage.setItem('event_id', eventId);
        }
      }
      return eventId;
    }

    // Get or generate fbp (Facebook Pixel identifier)
    function getOrGenerateFbp() {
      try {
        let fbp = localStorage.getItem('_fbp') || '';
        if (!fbp) {
          const timestamp = Date.now();
          const randomNumber = Math.floor(Math.random() * 9000000000) + 1000000000; // 10-digit random number
          fbp = `fb.1.${timestamp}.${randomNumber}`;
          localStorage.setItem('_fbp', fbp);
        }
        return fbp;
      } catch (error) {
        console.warn("LocalStorage unavailable, falling back to sessionStorage.");
        let fbp = sessionStorage.getItem('_fbp') || '';
        if (!fbp) {
          const timestamp = Date.now();
          const randomNumber = Math.floor(Math.random() * 9000000000) + 1000000000;
          fbp = `fb.1.${timestamp}.${randomNumber}`;
          sessionStorage.setItem('_fbp', fbp);
        }
        return fbp;
      }
    }
    const FBP = getOrGenerateFbp();

    // Async: Generate or get fbc with proper format (always generate a valid fbc even if fbclid is missing)
    async function getOrGenerateFbc() {
      const fbclid = await getFbclidAsync();
      const timestamp = Date.now();
      if (fbclid) {
        return `fb.1.${timestamp}.${fbclid}`;
      } else {
        // Generate a random string for fbc when fbclid is not available
        const randomString = Math.random().toString(36).substring(2, 15);
        return `fb.1.${timestamp}.${randomString}`;
      }
    }

    // New helper: Check if the event has already been sent to prevent duplicate events
    async function hasEventAlreadyBeenSent(eventId) {
      try {
        const response = await fetch(API_DOMAIN + '/check-event-status?event_id=' + encodeURIComponent(eventId), { credentials: 'include' });
        const data = await response.json();
        return data.sent;  // Returns true if event was already sent
      } catch (error) {
        console.error('Error checking event status:', error);
        return false;
      }
    }

    /**********************************************
     * FACEBOOK PIXEL SETUP
     **********************************************/
    // Helper to get cookies (if needed)
    function getCookie(name) {
      const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
      return match ? decodeURIComponent(match[2]) : null;
    }

    // Standard Facebook Pixel Base Code
    !function(f, b, e, v, n, t, s){
      if(f.fbq)return;
      n = f.fbq = function(){
        n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
      };
      if(!f._fbq) f._fbq = n;
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

    fbq('init', FACEBOOK_PIXEL_ID);
    fbq('track', 'PageView');
    fbq('track', 'InitiateCheckout', {
      content_name: 'Donation Order',
      content_category: 'Donation',
      currency: 'USD'
    });

    /**********************************************
     * Ensure fbclid is stored in localStorage with expiration
     **********************************************/
    (function storeFbclidFrontEnd() {
      const urlParams = new URLSearchParams(window.location.search);
      const fbclidParam = urlParams.get('fbclid');
      if (fbclidParam) {
        const fbclidData = { value: fbclidParam, expires: Date.now() + 90 * 24 * 60 * 60 * 1000 }; // 90 days expiration
        try {
          localStorage.setItem('fbclid', JSON.stringify(fbclidData));
        } catch (error) {
          sessionStorage.setItem('fbclid', fbclidParam);
        }
      }
    })();

    /**********************************************
     * SEND FB CONVERSION (Using the Beacon API)
     **********************************************/
    async function sendFBConversion(payload) {
      // Ensure fbclid is included (taken from localStorage or fetched from backend if missing)
      payload.fbclid = payload.fbclid || await getFbclidAsync();
      const url = API_DOMAIN + '/api/fb-conversion';

      if (navigator.sendBeacon) {
        try {
          const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
          const beaconSuccess = navigator.sendBeacon(url, blob);
          console.log('Beacon success:', beaconSuccess);
        } catch (err) {
          console.warn('Beacon failed, fallback to fetch:', err);
          await fallbackFetch(payload);
        }
      } else {
        await fallbackFetch(payload);
      }

      async function fallbackFetch(data) {
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
            credentials: 'include'
          });
          if (!response.ok) {
            throw new Error(`Server responded with ${response.status}`);
          }
          // If the server generates new fbp/fbc values, store them for future consistency
          const result = await response.json();
          if (result.fbp) localStorage.setItem('_fbp', result.fbp);
          if (result.fbc) localStorage.setItem('_fbc', result.fbc);
          console.log('CAPI Response:', result);
          return result;
        } catch (error) {
          console.error('CAPI Error:', error);
        }
      }
    }

    /**********************************************
     * PAYMENT FLOW
     **********************************************/
    (function() {
      let selectedDonation = 0;
      const CREATE_PAYMENT_INTENT_URL = API_DOMAIN + '/create-payment-intent';
      const donateBtn = document.getElementById('donate-now');
      const errorContainer = document.getElementById('donation-form-error');
      const errorSpan = errorContainer ? errorContainer.querySelector('span') : null;

      if (!donateBtn || !errorContainer || !errorSpan) {
        console.error('Required DOM elements not found.');
        return;
      }

      // Example: Listen for a custom "donationSelected" event to set the donation amount
      document.addEventListener('donationSelected', (e) => {
        try {
          selectedDonation = parseFloat(e.detail.amount);
          if (isNaN(selectedDonation) || selectedDonation <= 0) {
            selectedDonation = 0;
          }
        } catch (err) {
          console.error('Error reading donationSelected:', err);
        }
      });

      function showError(msg) {
        errorContainer.style.display = 'inline-flex';
        errorContainer.classList.add('active');
        errorSpan.textContent = msg;
      }
      function hideError() {
        errorContainer.style.display = 'none';
        errorContainer.classList.remove('active');
        errorSpan.textContent = '';
      }
      function showLoading() {
        donateBtn.disabled = true;
        donateBtn.innerHTML = '<div class="loader" style="border: 3px solid #f3f3f3; border-top: 3px solid #999; border-radius: 50%; width: 1.2rem; height: 1.2rem; animation: spin 1s linear infinite;"></div>';
      }
      function hideLoading() {
        donateBtn.disabled = false;
        donateBtn.textContent = 'Donate now';
      }

      // Add spinner CSS if not already present
      if (!document.getElementById('spinner-style')) {
        const style = document.createElement('style');
        style.id = 'spinner-style';
        style.innerHTML = '@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }';
        document.head.appendChild(style);
      }

      donateBtn.addEventListener('click', async function() {
        try {
          hideError();
          if (selectedDonation <= 0) {
            showError('Please select a donation amount first.');
            return;
          }

          // Validate form fields (example field IDs)
          const fieldsToValidate = [
            'email-address',
            'first-name',
            'last-name',
            'card-name',
            'location-country',
            'location-postal-code'
          ];
          fieldsToValidate.forEach(id => {
            const el = document.getElementById(id);
            if (el) {
              el.dispatchEvent(new Event('blur', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
          });
          await new Promise(r => setTimeout(r, 200));
          const anyErrors = document.querySelectorAll('.error-message.active');
          if (anyErrors.length > 0) {
            showError('Please fix the form errors before continuing.');
            return;
          }

          const emailEl      = document.getElementById('email-address');
          const firstNameEl  = document.getElementById('first-name');
          const lastNameEl   = document.getElementById('last-name');
          const cardNameEl   = document.getElementById('card-name');
          const countryEl    = document.getElementById('location-country');
          const postalCodeEl = document.getElementById('location-postal-code');

          if (!emailEl || !firstNameEl || !lastNameEl || !cardNameEl || !countryEl || !postalCodeEl) {
            showError('Some required form fields are missing.');
            return;
          }

          const email      = emailEl.value.trim();
          const firstName  = firstNameEl.value.trim();
          const lastName   = lastNameEl.value.trim();
          const cardName   = cardNameEl.value.trim();
          const country    = countryEl.value.trim();
          const postalCode = postalCodeEl.value.trim();

          // Get or generate event_id using email
          const EVENT_ID = await getOrGenerateEventId(email);

          showLoading();

          // 1) Create PaymentIntent (Stripe) and get eventId from server
          let clientSecret;
          try {
            const resp = await fetch(CREATE_PAYMENT_INTENT_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                donationAmount: selectedDonation,
                email,
                firstName,
                lastName,
                cardName,
                country,
                postalCode,
                event_id: EVENT_ID
              }),
              credentials: 'include'
            });
            if (!resp.ok) {
              throw new Error(`${resp.status} - ${await resp.text()}`);
            }
            const data = await resp.json();
            clientSecret = data.clientSecret;
            // Override event_id from backend if provided and store it in sessionStorage
            if (data.eventId) {
              sessionStorage.setItem('event_id', data.eventId);
            }
            if (!clientSecret || !EVENT_ID) {
              throw new Error('Missing clientSecret or eventId from backend.');
            }
          } catch (err) {
            hideLoading();
            showError(`Error creating PaymentIntent: ${err.message}`);
            return;
          }

          // 2) Confirm the payment with Stripe
          if (!window.stripe || !window.cardNumberElement) {
            hideLoading();
            showError('Payment processing is not available.');
            return;
          }
          try {
            const { paymentIntent, error } = await window.stripe.confirmCardPayment(clientSecret, {
              payment_method: {
                card: window.cardNumberElement,
                billing_details: {
                  name: cardName,
                  email,
                  address: {
                    country,
                    postal_code: postalCode
                  }
                }
              }
            });
            if (error) {
              throw new Error(error.message);
            }

            if (paymentIntent && paymentIntent.status === 'succeeded') {
              // 3) Payment success – fire Facebook Pixel and Conversions API events

              // Check for duplicate events before sending
              const eventAlreadySent = await hasEventAlreadyBeenSent(EVENT_ID);
              if (eventAlreadySent) {
                console.log('Event already sent, skipping duplicate.');
              } else {
                const FBCLID = await getFbclidAsync();
                const FBC = localStorage.getItem('_fbc') || await getOrGenerateFbc();

                // Prepare hashed user data for consistency in both events
                const hashedUserData = {
                  em: await hashData(email),
                  fn: await hashData(firstName),
                  ln: await hashData(lastName),
                  zp: await hashData(postalCode),
                  country: await hashData(country)
                };

                // Fire Pixel Purchase event with hashed user data
                if (typeof fbq !== 'undefined') {
                  fbq('track', 'Purchase', {
                    value: selectedDonation,
                    currency: 'USD',
                    content_name: 'Donation',
                    event_id: EVENT_ID,
                    user_data: hashedUserData,
                    custom_data: {
                      fbp: FBP,
                      fbc: FBC,
                      fbclid: FBCLID
                    }
                  });
                }

                // Fire Conversions API event
                const capiPayload = {
                  event_name: 'Purchase',
                  event_time: Math.floor(Date.now() / 1000),
                  event_id: EVENT_ID,
                  email,
                  amount: selectedDonation,
                  fbp: FBP,
                  fbc: FBC,
                  fbclid: FBCLID,
                  user_data: hashedUserData,
                  orderCompleteUrl: window.location.href
                };
                await sendFBConversion(capiPayload);
              }

              // Optionally, store a donation receipt in a cookie
              const receipt = {
                amount: selectedDonation,
                email,
                name: firstName + ' ' + lastName,
                date: new Date().toISOString(),
                country,
                event_id: EVENT_ID
              };
              function setCookie(name, value, days) {
                let expires = '';
                if (days) {
                  const date = new Date();
                  date.setTime(date.getTime() + days * 24 * 60 * 60 * 1000);
                  expires = '; expires=' + date.toUTCString();
                }
                document.cookie = name + '=' + encodeURIComponent(value) + expires + '; path=/';
              }
              setCookie('donationReceipt', JSON.stringify(receipt), 1);

              // Redirect to a thank-you page
              setTimeout(() => {
                window.location.href = 'thanks.html';
              }, 500);

            } else {
              throw new Error('Payment failed or not completed.');
            }
          } catch (err) {
            hideLoading();
            showError(`Payment error: ${err.message}`);
          }
        } catch (err) {
          hideLoading();
          showError('An unexpected error occurred. Please try again.');
          console.error('Unexpected donation flow error:', err);
        }
      });
    })();

