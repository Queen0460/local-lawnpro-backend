// Load environment variables first
require('dotenv').config();

const express = require("express");
const app = express();
const cors = require("cors");

// Verify Stripe key is loaded before initializing
if (!process.env.STRIPE_SECRET_KEY) {
    console.error("❌ FATAL: STRIPE_SECRET_KEY is not set in environment variables");
    process.exit(1);
}
console.log(`✅ Stripe key loaded: ${process.env.STRIPE_SECRET_KEY.slice(0, 14)}...`);

const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

// Middleware
app.use(cors());
app.use(express.json());

// Pricing helper — basePrice in dollars, returns breakdown
function calculatePricing(basePrice) {
    const base = parseFloat(basePrice);
    const fee = parseFloat((base * 0.10).toFixed(2));
    const total = parseFloat((base + fee).toFixed(2));
    return { base, fee, total, totalCents: Math.round(total * 100) };
}

// Create a PaymentIntent — backend recalculates amount from basePrice + 10% fee
app.post("/create-payment-intent", async (req, res) => {
    try {
        console.log("[/create-payment-intent] incoming body:", JSON.stringify(req.body));

        const { description, metadata } = req.body;

        // Accept basePrice (dollars) or legacy amount_cents — basePrice takes priority
        let basePrice = req.body.basePrice;
        if (!basePrice && req.body.amount_cents) {
            basePrice = req.body.amount_cents / 100;
            console.log("[/create-payment-intent] legacy amount_cents received, converted to basePrice:", basePrice);
        }

        if (!basePrice || isNaN(parseFloat(basePrice))) {
            return res.status(400).json({ error: 'basePrice (in dollars) is required' });
        }

        const base = parseFloat(basePrice);
        const fee = parseFloat((base * 0.10).toFixed(2));
        const total = parseFloat((base + fee).toFixed(2));
        const totalCents = Math.round(total * 100);

        console.log(`[/create-payment-intent] base: $${base} | fee: $${fee} | total: $${total} | totalCents: ${totalCents}`);

        // Stripe metadata values must be strings; sanitize before sending
        const safeMetadata = {};
        if (metadata && typeof metadata === 'object') {
            for (const [k, v] of Object.entries(metadata)) {
                safeMetadata[k] = String(v);
            }
        }

        const paymentIntent = await stripe.paymentIntents.create({
            amount: totalCents,
            currency: 'usd',
            description: description || undefined,
            metadata: {
                ...safeMetadata,
                basePrice: String(base),
                fee: String(fee),
                total: String(total)
            },
            automatic_payment_methods: { enabled: true }
        });

        console.log(`[/create-payment-intent] success — intent: ${paymentIntent.id} amount: ${totalCents} cents`);
        res.json({
            clientSecret: paymentIntent.client_secret,
            pricing: { base, fee, total }
        });
    } catch (err) {
        console.error("[/create-payment-intent] Stripe error:", err.message);
        console.error("[/create-payment-intent] Stripe error type:", err.type);
        console.error("[/create-payment-intent] Stripe error code:", err.code);
        res.status(500).json({
            error: err.message,
            stripeType: err.type || null,
            stripeCode: err.code || null
        });
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

// In-memory job store (resets on server restart)
let jobs = [];

// POST /jobs — customer posts a job
// NOTE: fee and totalPrice are always calculated server-side from basePrice.
// Any 'price' or 'total' fields sent by the client are intentionally ignored.
app.post("/jobs", (req, res) => {
    try {
        const {
            title,
            serviceType,
            basePrice,   // pre-fee service price in dollars — only trusted pricing input
            address,
            coordinate,
            customerId,
            paymentIntentId
        } = req.body;

        if (!title || !customerId) {
            return res.status(400).json({ error: 'title and customerId are required' });
        }

        if (!basePrice || isNaN(parseFloat(basePrice))) {
            return res.status(400).json({ error: 'basePrice (in dollars) is required' });
        }

        // Validate address
        if (!address || typeof address !== 'string' || address.trim().length === 0) {
            return res.status(400).json({ error: 'A valid address string is required' });
        }

        // Validate coordinate
        const lat = coordinate && parseFloat(coordinate.lat);
        const lng = coordinate && parseFloat(coordinate.lng);
        if (
            !coordinate ||
            isNaN(lat) || isNaN(lng) ||
            lat < -90 || lat > 90 ||
            lng < -180 || lng > 180
        ) {
            return res.status(400).json({ error: 'A valid coordinate with numeric lat (-90 to 90) and lng (-180 to 180) is required' });
        }

        const pricing = calculatePricing(basePrice);

        const job = {
            id: Date.now().toString(),
            title,
            serviceType: serviceType || null,
            basePrice: pricing.base,
            fee: pricing.fee,
            totalPrice: pricing.total,
            status: 'pending',
            address: address.trim(),
            coordinate: { lat, lng },
            customerId,
            workerId: null,
            paymentStatus: 'authorized',
            paymentIntentId: paymentIntentId || null,
            createdAt: new Date().toISOString()
        };

        jobs.push(job);
        console.log(`Job created: ${job.id} | base: $${pricing.base} fee: $${pricing.fee} total: $${pricing.total}`);
        res.status(201).json(job);
    } catch (err) {
        console.error("Error creating job:", err);
        res.status(500).json({ error: err.message });
    }
});

// PATCH /jobs/:id/status — update job status
const ALLOWED_STATUSES = ['accepted', 'arrived', 'completed', 'paid'];

app.patch("/jobs/:id/status", (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;

        if (!status) {
            return res.status(400).json({ error: 'status is required' });
        }

        if (!ALLOWED_STATUSES.includes(status)) {
            return res.status(400).json({
                error: `Invalid status. Must be one of: ${ALLOWED_STATUSES.join(', ')}`
            });
        }

        const job = jobs.find(j => j.id === id);
        if (!job) {
            return res.status(404).json({ error: `Job ${id} not found` });
        }

        job.status = status;
        console.log(`Job ${id} status updated to '${status}'`);
        res.json(job);
    } catch (err) {
        console.error("Error updating job status:", err);
        res.status(500).json({ error: err.message });
    }
});

// GET /jobs — workers retrieve open jobs, optionally filtered by status
app.get("/jobs", (req, res) => {
    try {
        const { status } = req.query;
        const result = status ? jobs.filter(j => j.status === status) : jobs;
        res.json(result);
    } catch (err) {
        console.error("Error fetching jobs:", err);
        res.status(500).json({ error: err.message });
    }
});

// (Optional) Add other routes like create-connect-account, etc., here

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});
