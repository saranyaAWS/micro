const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3002;
const PAYMENT_SERVICE_URL = process.env.PAYMENT_SERVICE_URL || 'http://payment-service:3003';
const ESCALATION_SERVICE_URL = process.env.ESCALATION_SERVICE_URL || 'http://escalation-service:3004';

// In-memory order store: { orderId: { ...order, status } }
const orders = {};

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'order-service' }));

// Create order -> charge payment -> allocate to an agent for fulfillment (2-min escalation window)
app.post('/orders', async (req, res) => {
  const { orderId, userId, items, total } = req.body;
  if (!orderId || !userId || !items) {
    return res.status(400).json({ error: 'orderId, userId and items are required' });
  }

  orders[orderId] = { orderId, userId, items, total, status: 'CREATED', createdAt: Date.now() };

  // 1. Charge payment
  try {
    const paymentResp = await axios.post(`${PAYMENT_SERVICE_URL}/payments`, {
      orderId, amount: total, method: 'CARD'
    });
    orders[orderId].payment = paymentResp.data;
    orders[orderId].status = 'PAID';
  } catch (err) {
    orders[orderId].status = 'PAYMENT_FAILED';
    orders[orderId].payment = err.response ? err.response.data : { error: err.message };
    return res.status(402).json(orders[orderId]);
  }

  // 2. Hand off to the escalation/allocation service for real-time fulfillment
  //    e.g. warehouse staff must pick & pack the item within the SLA window,
  //    otherwise it auto-escalates to the next available staff member.
  try {
    await axios.post(`${ESCALATION_SERVICE_URL}/assign`, {
      orderId,
      userId,
      itemSummary: items.map(i => `${i.qty}x ${i.name || i.productId}`).join(', ')
    });
    orders[orderId].status = 'ALLOCATING_FULFILLMENT';
  } catch (err) {
    console.error('escalation-service assign failed:', err.message);
    // Order still succeeds; fulfillment allocation can be retried/monitored separately
  }

  res.status(201).json(orders[orderId]);
});

app.get('/orders/:orderId', (req, res) => {
  const order = orders[req.params.orderId];
  if (!order) return res.status(404).json({ error: 'order not found' });
  res.json(order);
});

app.get('/orders', (req, res) => res.json(Object.values(orders)));

app.listen(PORT, () => console.log(`Order service running on port ${PORT}`));
