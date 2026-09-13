const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { v4: uuid } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const ORDER_SERVICE_URL = process.env.ORDER_SERVICE_URL || 'http://order-service:3002';

// In-memory cart store: { userId: [ {productId, name, qty, price} ] }
const carts = {};

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'cart-service' }));

app.get('/cart/:userId', (req, res) => {
  const { userId } = req.params;
  res.json({ userId, items: carts[userId] || [] });
});

app.post('/cart/:userId/items', (req, res) => {
  const { userId } = req.params;
  const { productId, name, qty = 1, price } = req.body;
  if (!productId || price === undefined) {
    return res.status(400).json({ error: 'productId and price are required' });
  }
  if (!carts[userId]) carts[userId] = [];
  const existing = carts[userId].find(i => i.productId === productId);
  if (existing) {
    existing.qty += qty;
  } else {
    carts[userId].push({ productId, name, qty, price });
  }
  res.status(201).json({ userId, items: carts[userId] });
});

app.delete('/cart/:userId/items/:productId', (req, res) => {
  const { userId, productId } = req.params;
  if (!carts[userId]) return res.status(404).json({ error: 'cart not found' });
  carts[userId] = carts[userId].filter(i => i.productId !== productId);
  res.json({ userId, items: carts[userId] });
});

app.post('/cart/:userId/checkout', async (req, res) => {
  const { userId } = req.params;
  const items = carts[userId];
  if (!items || items.length === 0) {
    return res.status(400).json({ error: 'cart is empty' });
  }
  const total = items.reduce((sum, i) => sum + i.price * i.qty, 0);

  try {
    const orderResp = await axios.post(`${ORDER_SERVICE_URL}/orders`, {
      orderId: uuid(),
      userId,
      items,
      total
    });
    carts[userId] = [];
    res.status(201).json(orderResp.data);
  } catch (err) {
    console.error('checkout error:', err.message);
    res.status(502).json({ error: 'order service unavailable', detail: err.message });
  }
});

app.listen(PORT, () => console.log(`Cart service running on port ${PORT}`));
