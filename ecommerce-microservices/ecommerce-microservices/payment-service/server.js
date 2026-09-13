const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3003;

// In-memory payment ledger: { orderId: { status, amount, method, transactionId } }
const payments = {};

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'payment-service' }));

// Simulate processing a payment
app.post('/payments', (req, res) => {
  const { orderId, amount, method = 'CARD' } = req.body;
  if (!orderId || amount === undefined) {
    return res.status(400).json({ error: 'orderId and amount are required' });
  }

  // Simulate 90% success rate, small delay to mimic gateway latency
  setTimeout(() => {
    const success = Math.random() < 0.9;
    const transactionId = 'txn_' + Date.now();
    payments[orderId] = {
      orderId,
      amount,
      method,
      status: success ? 'SUCCESS' : 'FAILED',
      transactionId
    };
    res.status(success ? 200 : 402).json(payments[orderId]);
  }, 300);
});

app.get('/payments/:orderId', (req, res) => {
  const record = payments[req.params.orderId];
  if (!record) return res.status(404).json({ error: 'payment not found' });
  res.json(record);
});

app.listen(PORT, () => console.log(`Payment service running on port ${PORT}`));
