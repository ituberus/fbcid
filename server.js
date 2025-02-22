<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Donate</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      padding: 20px;
    }
  </style>
  <script>
    async function submitDonation(e) {
      e.preventDefault();
      const amount = document.getElementById('amount').value;
      if (!amount) {
        alert('Please enter an amount.');
        return;
      }
      // Send a POST request to your Railway backend using the full URL.
      const response = await fetch('https://fbcid-production.up.railway.app/create-donation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // No need for credentials now since we're not using cookies.
        body: JSON.stringify({ amount })
      });
      const data = await response.json();
      if (data.ok) {
        // Redirect to the payment initiation endpoint using the full Railway URL
        window.location.href = 'https://fbcid-production.up.railway.app/iframe-sis?orderId=' + encodeURIComponent(data.orderId);
      } else {
        alert('Error: ' + data.error);
      }
    }
  </script>
</head>
<body>
  <h1>Donate</h1>
  <form onsubmit="submitDonation(event)">
    <label for="amount">Amount (€):</label>
    <input type="number" id="amount" name="amount" step="0.01" required>
    <button type="submit">Donate</button>
  </form>
</body>
</html>
