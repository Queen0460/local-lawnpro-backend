// Load environment variables first
require('dotenv').config();

const express = require("express");
const app = express();
const cors = require("cors");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

// Middleware
app.use(cors());
app.use(express.json());

// Create a PaymentIntent
app.post("/create-payment-intent", async (req, res) => {
    try {
        const { amount_cents, description, metadata } = req.body;

        const paymentIntent = await stripe.paymentIntents.create({
            amount: amount_cents,
            currency: 'usd',
            description: description,
            metadata: metadata,
            automatic_payment_methods: { enabled: true }
        });

        res.json({ clientSecret: paymentIntent.client_secret });
    } catch (err) {
        console.error("Stripe error:", err);
        res.status(500).json({ error: err.message });
    }
});

// Confirm Payment Status
app.post("/confirm-payment-status", async (req, res) => {
    try {
        const { paymentIntentId } = req.body;
        
        if (!paymentIntentId) {
            return res.status(400).json({ error: 'paymentIntentId is required' });
        }
        
        const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
        
        if (paymentIntent.status === 'succeeded') {
            return res.json({ status: 'succeeded' });
        } else {
            return res.status(400).json({ 
                status: paymentIntent.status, 
                message: 'Payment not completed' 
            });
        }
    } catch (err) {
        console.error("Error confirming payment:", err);
        res.status(500).json({ error: err.message });
    }
});

// (Optional) Add other routes like create-connect-account, etc., here

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});
