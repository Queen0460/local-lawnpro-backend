// Load environment variables first
require('dotenv').config();

const express = require("express");
const app = express();
const cors = require("cors");

// Verify Stripe key is loaded before initializing
if (!process.env.STRIPE_SECRET_KEY) {
    console.error("FATAL: STRIPE_SECRET_KEY is not set in environment variables");
    process.exit(1);
}
console.log(`Stripe key loaded: ${process.env.STRIPE_SECRET_KEY.slice(0, 14)}...`);

const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

// Middleware
app.use(cors());
app.use(express.json());

// Pricing helper
function calculatePricing(basePrice) {
    const base = parseFloat(basePrice);
    const fee = parseFloat((base * 0.10).toFixed(2));
    const total = parseFloat((base + fee).toFixed(2));
    return { base, fee, total, totalCents: Math.round(total * 100) };
}

// Create a PaymentIntent — charges basePrice + 10% platform fee
app.post("/create-payment-intent", async (req, res) => {
    try {
        console.log("[/create-payment-intent] incoming body:", JSON.stringify(req.body));

        const { description, metadata } = req.body;
        const basePrice = req.body.basePrice;

        if (!basePrice || isNaN(parseFloat(basePrice))) {
            return res.status(400).json({ error: 'basePrice (in dollars) is required' });
        }

        const base = parseFloat(basePrice);
        const platformFee = parseFloat((base * 0.10).toFixed(2));
        const total = parseFloat((base + platformFee).toFixed(2));
        const amount_cents = Math.round(total * 100);

        console.log(`[/create-payment-intent] basePrice: $${base} | platformFee: $${platformFee} | total: $${total} | amount_cents: ${amount_cents}`);

        const safeMetadata = {};
        if (metadata && typeof metadata === 'object') {
            for (const [k, v] of Object.entries(metadata)) {
                safeMetadata[k] = String(v);
            }
        }

        const paymentIntent = await stripe.paymentIntents.create({
            amount: amount_cents,
            currency: 'usd',
            description: description || undefined,
            metadata: {
                ...safeMetadata,
                basePrice: String(base),
                platformFee: String(platformFee),
                total: String(total)
            },
            automatic_payment_methods: { enabled: true }
        });

        console.log(`[/create-payment-intent] success — intent: ${paymentIntent.id} amount: ${amount_cents} cents`);
        res.json({
            clientSecret: paymentIntent.client_secret,
            paymentIntentId: paymentIntent.id,
            servicePrice: base,
            platformFee: platformFee,
            totalAmount: total
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
app.post("/jobs", (req, res) => {
    try {
        const {
            title,
            serviceType,
            basePrice,
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

        if (!address || typeof address !== 'string' || address.trim().length === 0) {
            return res.status(400).json({ error: 'A valid address string is required' });
        }

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
        const { status, workerId } = req.body;

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
        if (workerId) {
            job.workerId = workerId;
        }
        console.log(`Job ${id} status updated to '${status}' workerId: ${job.workerId}`);
        res.json(job);
    } catch (err) {
        console.error("Error updating job status:", err);
        res.status(500).json({ error: err.message });
    }
});

// POST /create-connect-account — create Stripe Connect Express account for worker
app.post("/create-connect-account", async (req, res) => {
    console.log("[/create-connect-account] ROUTE HIT");
    console.log("[/create-connect-account] req.body:", JSON.stringify(req.body));
    try {
        const { email, userId } = req.body;
        console.log(`[/create-connect-account] email: "${email}" userId: "${userId}"`);

        if (!email || !userId) {
            console.log("[/create-connect-account] REJECTED — missing email or userId");
            return res.status(400).json({ error: 'email and userId are required' });
        }

        console.log("[/create-connect-account] calling stripe.accounts.create...");
        const account = await stripe.accounts.create({
            type: 'express',
            email: email,
            metadata: { userId: String(userId) },
            capabilities: {
                card_payments: { requested: true },
                transfers: { requested: true }
            }
        });

        console.log(`[/create-connect-account] SUCCESS — accountId: ${account.id}`);
        res.json({ accountId: account.id });
    } catch (err) {
        console.error("[/create-connect-account] CAUGHT ERROR:", err.message);
        console.error("[/create-connect-account] error type:", err.type);
        console.error("[/create-connect-account] error code:", err.code);
        console.error("[/create-connect-account] full error:", JSON.stringify(err, null, 2));
        res.status(500).json({ error: err.message });
    }
});

// POST /create-account-link — generate Stripe Connect onboarding link
app.post("/create-account-link", async (req, res) => {
    try {
        console.log("[/create-account-link] incoming body:", JSON.stringify(req.body));
        const { accountId, refreshUrl, returnUrl } = req.body;

        if (!accountId) {
            return res.status(400).json({ error: 'accountId is required' });
        }

        const accountLink = await stripe.accountLinks.create({
            account: accountId,
            refresh_url: refreshUrl || 'https://locallawnpro.org/reauth',
            return_url: returnUrl || 'https://locallawnpro.org/onboarding-complete',
            type: 'account_onboarding'
        });

        console.log(`[/create-account-link] success — url: ${accountLink.url}`);
        res.json({ url: accountLink.url });
    } catch (err) {
        console.error("[/create-account-link] error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST /check-onboarding-status — check if worker completed Stripe onboarding
app.post("/check-onboarding-status", async (req, res) => {
    try {
        console.log("[/check-onboarding-status] incoming body:", JSON.stringify(req.body));
        const { accountId } = req.body;

        if (!accountId) {
            return res.status(400).json({ error: 'accountId is required' });
        }

        const account = await stripe.accounts.retrieve(accountId);
        const onboardingComplete = account.details_submitted && account.charges_enabled;

        console.log(`[/check-onboarding-status] accountId: ${accountId} complete: ${onboardingComplete}`);
        res.json({ onboardingComplete });
    } catch (err) {
        console.error("[/check-onboarding-status] error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// GET /jobs — filter by status and/or workerId
app.get("/jobs", (req, res) => {
    try {
        const { status, workerId } = req.query;
        let result = jobs;
        if (status) {
            result = result.filter(j => j.status === status);
        }
        if (workerId) {
            result = result.filter(j => j.workerId === workerId);
        }
        res.json(result);
    } catch (err) {
        console.error("Error fetching jobs:", err);
        res.status(500).json({ error: err.message });
    }
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
