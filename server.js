<!-- public/index.html -->
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Payment Page</title>
</head>
<body>
  <!-- Card input fields inserted by Redsys functions -->
  <div id="card-number-element"></div>
  <div id="card-expiry-element"></div>
  <div id="card-cvc-element"></div>

  <!-- Hidden fields for Redsys operation ID and error code -->
  <input type="hidden" id="redsysOperId">
  <input type="hidden" id="redsysErrorCode">

  <!-- Donation and user details -->
  <input type="text" id="donation-amount" placeholder="Donation Amount">
  <input type="email" id="email-address" placeholder="Email">
  <input type="text" id="first-name" placeholder="First Name">
  <input type="text" id="last-name" placeholder="Last Name">
  <input type="text" id="card-name" placeholder="Card Name">

  <!-- Donate button -->
  <button id="donate-now">Donate Now</button>

  <!-- Load payment.js -->
  <script src="payment.js"></script>
  <!-- 
    IMPORTANT: Make sure to include the Redsys inSite integration library 
    (or any other required scripts) before your payment.js if needed.
  -->
</body>
</html>
