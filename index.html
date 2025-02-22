<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Donate</title>
  <script>
    function submitDonation(event) {
      event.preventDefault();
      const amount = document.getElementById('amount').value;
      if (!amount) {
        alert('Please enter an amount.');
        return;
      }
      // Use the full Railway URL when sending the POST request
      fetch('https://fbcid-production.up.railway.app/create-donation', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ amount: amount })
      })
      .then(response => response.json())
      .then(data => {
        if (data.ok) {
          // Redirect using the Railway URL to the payment initiation endpoint
          window.location.href = 'https://fbcid-production.up.railway.app/iframe-sis?orderId=' + data.orderId;
        } else {
          alert('Error: ' + data.error);
        }
      })
      .catch(err => {
        console.error(err);
        alert('An error occurred.');
      });
    }
  </script>
</head>
<body>
  <h1>Donate</h1>
  <form onsubmit="submitDonation(event)">
    <label for="amount">Amount (EUR):</label>
    <input type="number" id="amount" name="amount" step="0.01" required>
    <button type="submit">Donate</button>
  </form>
</body>
</html>
