const express = require('express');
const app = express();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
require('dotenv').config();

app.use(cors());
app.use(express.json());

// Simple health check
app.get('/', (req, res) => {
  res.send('LocalLawnPro Backend is Live!');
});

// Log every request so we can see what's happening in Render logs
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ===== NEW: CREATE CUSTOMER =====
app.post('/create-customer', async (req, res) => {
  try {
    console.log('=== CREATE CUSTOMER REQUEST ===');
    console.log('Body:', JSON.stringify(req.body, null, 2));

    const { name, email } = req.body;

    const customer = await stripe.customers.create({
      name: name || 'LocalLawnPro Customer',
      email: email || undefined,
    });

    console.log('Customer created:', customer.id);

    res.json({
      customerId: customer.id,
    });
  } catch (err) {
    console.error('=== CREATE CUSTOMER ERROR ===');
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ===== CREATE PAYMENT INTENT =====
app.post('/create-payment-intent', async (req, res) => {
  try {
    console.log('=== CREATE PAYMENT INTENT REQUEST ===');
    console.log('Request body:', JSON.stringify(req.body, null, 2));
    console.log('Timestamp:', new Date().toISOString());

    // IMPORTANT: iOS sends *amount_cents*
    const amount = req.body.amount_cents;
    const description = req.body.description || 'Lawn care service';
    const metadata = req.body.metadata || {};

    if (!amount || amount <= 0) {
      console.error('Invalid amount_cents:', amount);
      return res.status(400).json({
        error: 'Invalid amount_cents. Must be a positive number.',
      });
    }

    console.log('Creating PaymentIntent with amount:', amount);

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount, // already in cents
      currency: 'usd',
      description,
      metadata,
      automatic_payment_methods: {
        enabled: true,
      },
    });

    console.log('PaymentIntent created:', paymentIntent.id);
    console.log('====================================\n');

    res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
    });

  } catch (err) {
    console.error('=== PAYMENT INTENT ERROR ===');
    console.error(err);
    console.error('============================\n');
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
ning on port ${PORT}`));
