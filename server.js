// Load environment variables first
require('dotenv').config();

const express = require("express");
const app = express();
const cors = require("cors");
const bcrypt = require("bcrypt");
const mongoose = require("mongoose");
const sgMail = require('@sendgrid/mail');

// Models
const User = require('./models/User');
const Job = require('./models/Job');

// SendGrid setup
if (process.env.SENDGRID_API_KEY) {
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    console.log("SendGrid API key loaded");
} else {
    console.warn("WARNING: SENDGRID_API_KEY not set — welcome emails will not be sent");
}

// Verify Stripe key is loaded before initializing
if (!process.env.STRIPE_SECRET_KEY) {
    console.error("FATAL: STRIPE_SECRET_KEY is not set in environment variables");
    process.exit(1);
}
console.log(`Stripe key loaded: ${process.env.STRIPE_SECRET_KEY.slice(0, 14)}...`);

const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

// Connect to MongoDB
if (!process.env.MONGODB_URI) {
    console.error("FATAL: MONGODB_URI is not set in environment variables");
    process.exit(1);
}
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log("MongoDB connected"))
    .catch(err => {
        console.error("MongoDB connection error:", err.message);
        process.exit(1);
    });

// Middleware
app.use(cors());
app.use(express.json());

// ─── Authentication ─────────────────────────────────────────────────────────

const VALID_ACCOUNT_TYPES = ['customer', 'worker'];
const SALT_ROUNDS = 10;

// Send welcome email (fire-and-forget, never blocks account creation)
function sendWelcomeEmail(email, accountType) {
    if (!process.env.SENDGRID_API_KEY) return;

    const customerMessage = `Welcome to Local Lawn Pro!\n\nYour account has been created successfully.\n\nAs a customer, you can post outdoor service jobs and connect with local workers in your area.\n\nThank you for joining Local Lawn Pro.`;
    const workerMessage = `Welcome to Local Lawn Pro!\n\nYour account has been created successfully.\n\nAs a worker, you can find jobs and earn money in your area.\n\nThank you for joining Local Lawn Pro.`;

    const msg = {
        to: email,
        from: 'support@locallawnpro.org',
        subject: 'Welcome to Local Lawn Pro 🌱',
        text: accountType === 'worker' ? workerMessage : customerMessage
    };

    sgMail.send(msg)
        .then(() => console.log(`[sendWelcomeEmail] Sent to ${email}`))
        .catch((err) => console.error(`[sendWelcomeEmail] Failed for ${email}: ${err.message}`));
}

// POST /create-account — register a new user
app.post("/create-account", async (req, res) => {
    try {
        const { email, password, accountType } = req.body;

        if (!email || typeof email !== 'string' || email.trim().length === 0) {
            return res.status(400).json({ error: 'Email is required' });
        }
        if (!password || typeof password !== 'string' || password.length === 0) {
            return res.status(400).json({ error: 'Password is required' });
        }
        if (!accountType || !VALID_ACCOUNT_TYPES.includes(accountType)) {
            return res.status(400).json({ error: 'accountType must be "customer" or "worker"' });
        }

        const normalizedEmail = email.trim().toLowerCase();

        const existing = await User.findOne({ email: normalizedEmail });
        if (existing) {
            return res.status(409).json({ error: 'Account already exists' });
        }

        const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
        const user = await User.create({
            email: normalizedEmail,
            passwordHash,
            accountType
        });

        sendWelcomeEmail(normalizedEmail, accountType);

        console.log(`[/create-account] Account created: ${normalizedEmail} (${accountType})`);
        res.status(201).json({ success: true, accountType: user.accountType });
    } catch (err) {
        console.error("[/create-account] error:", err.message);
        res.status(500).json({ error: 'Failed to create account' });
    }
});

// POST /login — authenticate an existing user
app.post("/login", async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || typeof email !== 'string' || email.trim().length === 0) {
            return res.status(400).json({ error: 'Email is required' });
        }
        if (!password || typeof password !== 'string' || password.length === 0) {
            return res.status(400).json({ error: 'Password is required' });
        }

        const normalizedEmail = email.trim().toLowerCase();
        const user = await User.findOne({ email: normalizedEmail });

        if (!user) {
            return res.status(404).json({ error: 'Account not found' });
        }

        const match = await bcrypt.compare(password, user.passwordHash);
        if (!match) {
            return res.status(401).json({ error: 'Incorrect password' });
        }

        console.log(`[/login] Login success: ${normalizedEmail} (${user.accountType})`);
        res.json({ success: true, accountType: user.accountType });
    } catch (err) {
        console.error("[/login] error:", err.message);
        res.status(500).json({ error: 'Login failed' });
    }
});

// ─── Account Deletion ────────────────────────────────────────────────────────

// DELETE /delete-account — permanently delete a user account and related data
app.delete("/delete-account", async (req, res) => {
    try {
        const { email } = req.body;

        if (!email || typeof email !== 'string' || email.trim().length === 0) {
            return res.status(400).json({ error: 'Email is required' });
        }

        const normalizedEmail = email.trim().toLowerCase();
        const user = await User.findOne({ email: normalizedEmail });

        if (!user) {
            return res.status(404).json({ error: 'Account not found' });
        }

        const userId = user._id.toString();

        // Delete the user account
        await User.deleteOne({ _id: user._id });

        // Clean up jobs posted by this user (set customerId to deleted)
        await Job.updateMany({ customerId: userId }, { $set: { customerId: 'deleted_account' } });

        // Remove this user as worker from any assigned jobs
        await Job.updateMany({ workerId: userId }, { $set: { workerId: null } });

        console.log(`[DELETE /delete-account] Account deleted: ${normalizedEmail} (${user.accountType})`);
        res.json({ success: true, message: 'Account deleted successfully' });
    } catch (err) {
        console.error("[DELETE /delete-account] error:", err.message);
        res.status(500).json({ error: 'Failed to delete account' });
    }
});

// ─── Profile ─────────────────────────────────────────────────────────────────

// PATCH /profile — update user profile (location, travel radius, zip)
app.patch("/profile", async (req, res) => {
    try {
        const { userId, coordinate, travelRadiusMiles, zipCode } = req.body;

        if (!userId) {
            return res.status(400).json({ error: 'userId is required' });
        }

        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        if (coordinate && typeof coordinate.lat === 'number' && typeof coordinate.lng === 'number') {
            user.coordinate = { lat: coordinate.lat, lng: coordinate.lng };
        }
        if (typeof travelRadiusMiles === 'number' && travelRadiusMiles > 0) {
            user.travelRadiusMiles = travelRadiusMiles;
        }
        if (zipCode && typeof zipCode === 'string') {
            user.zipCode = zipCode.trim();
        }

        await user.save();
        console.log(`[PATCH /profile] Updated user ${userId}: radius=${user.travelRadiusMiles}mi`);
        res.json({
            success: true,
            coordinate: user.coordinate,
            travelRadiusMiles: user.travelRadiusMiles,
            zipCode: user.zipCode
        });
    } catch (err) {
        console.error("[PATCH /profile] error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── Pricing & Payments ─────────────────────────────────────────────────────

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

// ─── Jobs ────────────────────────────────────────────────────────────────────

// POST /jobs — customer posts a job
app.post("/jobs", async (req, res) => {
    try {
        const {
            title,
            serviceType,
            basePrice,
            address,
            coordinate,
            customerId,
            paymentIntentId,
            addOns
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

        const job = await Job.create({
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
            addOns: addOns || []
        });

        console.log(`Job created: ${job._id} | base: $${pricing.base} fee: $${pricing.fee} total: $${pricing.total}`);
        res.status(201).json(formatJob(job));
    } catch (err) {
        console.error("Error creating job:", err);
        res.status(500).json({ error: err.message });
    }
});

// Helper: format job document to match previous API response shape
function formatJob(job) {
    const obj = job.toObject ? job.toObject() : job;
    return {
        id: obj._id.toString(),
        title: obj.title,
        serviceType: obj.serviceType,
        basePrice: obj.basePrice,
        fee: obj.fee,
        totalPrice: obj.totalPrice,
        status: obj.status,
        address: obj.address,
        coordinate: obj.coordinate,
        customerId: obj.customerId,
        workerId: obj.workerId,
        paymentStatus: obj.paymentStatus,
        paymentIntentId: obj.paymentIntentId,
        addOns: obj.addOns || [],
        completedAt: obj.completedAt || null,
        disputeWindowEnds: obj.disputeWindowEnds || null,
        disputed: obj.disputed || false,
        disputeReason: obj.disputeReason || null,
        disputedAt: obj.disputedAt || null,
        createdAt: obj.createdAt
    };
}

// PATCH /jobs/:id/status — update job status
const ALLOWED_STATUSES = ['accepted', 'arrived', 'completed', 'paid'];
const STATUSES_REQUIRING_ONBOARDING = ['accepted', 'completed'];

async function verifyWorkerOnboarding(stripeAccountId) {
    if (!stripeAccountId) {
        return { ok: false, reason: 'No stripeAccountId provided' };
    }
    const account = await stripe.accounts.retrieve(stripeAccountId);
    const ok = account.charges_enabled && account.payouts_enabled && account.details_submitted;
    if (!ok) {
        return {
            ok: false,
            reason: `charges_enabled: ${account.charges_enabled}, payouts_enabled: ${account.payouts_enabled}, details_submitted: ${account.details_submitted}`
        };
    }
    return { ok: true };
}

app.patch("/jobs/:id/status", async (req, res) => {
    try {
        const { id } = req.params;
        const { status, workerId, stripeAccountId } = req.body;

        if (!status) {
            return res.status(400).json({ error: 'status is required' });
        }

        if (!ALLOWED_STATUSES.includes(status)) {
            return res.status(400).json({
                error: `Invalid status. Must be one of: ${ALLOWED_STATUSES.join(', ')}`
            });
        }

        if (STATUSES_REQUIRING_ONBOARDING.includes(status)) {
            console.log(`[PATCH /jobs/${id}/status] Checking onboarding for stripeAccountId: ${stripeAccountId}`);
            const check = await verifyWorkerOnboarding(stripeAccountId);
            if (!check.ok) {
                console.log(`[PATCH /jobs/${id}/status] BLOCKED — onboarding incomplete: ${check.reason}`);
                return res.status(403).json({
                    error: 'Almost there! Please complete your payout setup to start accepting or completing jobs.'
                });
            }
            console.log(`[PATCH /jobs/${id}/status] Onboarding verified OK`);
        }

        const job = await Job.findById(id);
        if (!job) {
            return res.status(404).json({ error: `Job ${id} not found` });
        }

        job.status = status;
        if (workerId) {
            job.workerId = workerId;
        }

        // System-based approval: auto-capture payment when worker marks job completed
        if (status === 'completed' && job.paymentIntentId) {
            console.log(`[PATCH /jobs/${id}/status] Auto-capturing payment: ${job.paymentIntentId}`);
            try {
                await stripe.paymentIntents.capture(job.paymentIntentId);
                job.status = 'paid';
                job.paymentStatus = 'captured';
                job.completedAt = new Date().toISOString();
                job.disputeWindowEnds = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
                console.log(`[PATCH /jobs/${id}/status] Payment captured — job marked as paid`);
            } catch (stripeErr) {
                console.error(`[PATCH /jobs/${id}/status] Stripe capture failed: ${stripeErr.message}`);
                job.paymentStatus = 'capture_failed';
            }
        }

        await job.save();
        console.log(`Job ${id} status updated to '${job.status}' workerId: ${job.workerId}`);
        res.json(formatJob(job));
    } catch (err) {
        console.error("Error updating job status:", err);
        res.status(500).json({ error: err.message });
    }
});

// Haversine formula — returns distance in miles between two lat/lng points
function haversineDistance(lat1, lng1, lat2, lng2) {
    const toRad = (deg) => deg * (Math.PI / 180);
    const R = 3958.8; // Earth's radius in miles
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

// GET /jobs — filter by status, workerId, and optionally by distance
app.get("/jobs", async (req, res) => {
    try {
        const { status, workerId, lat, lng, radiusMiles } = req.query;
        const filter = {};
        if (status) filter.status = status;
        if (workerId) filter.workerId = workerId;

        let jobs = await Job.find(filter).sort({ createdAt: -1 });

        // Optional distance filtering
        if (lat && lng && radiusMiles) {
            const workerLat = parseFloat(lat);
            const workerLng = parseFloat(lng);
            const radius = parseFloat(radiusMiles);

            if (!isNaN(workerLat) && !isNaN(workerLng) && !isNaN(radius)) {
                jobs = jobs.filter(job => {
                    if (!job.coordinate || !job.coordinate.lat || !job.coordinate.lng) return false;
                    const dist = haversineDistance(workerLat, workerLng, job.coordinate.lat, job.coordinate.lng);
                    return dist <= radius;
                });
            }
        }

        res.json(jobs.map(formatJob));
    } catch (err) {
        console.error("Error fetching jobs:", err);
        res.status(500).json({ error: err.message });
    }
});

// POST /jobs/:id/dispute — customer flags an issue within 24-hour dispute window
app.post("/jobs/:id/dispute", async (req, res) => {
    try {
        const { id } = req.params;
        const { customerId, reason } = req.body;
        console.log(`[/jobs/${id}/dispute] customerId: ${customerId} reason: ${reason}`);

        if (!customerId) {
            return res.status(400).json({ error: 'customerId is required' });
        }

        const job = await Job.findById(id);
        if (!job) {
            return res.status(404).json({ error: `Job ${id} not found` });
        }

        if (job.customerId !== customerId) {
            return res.status(403).json({ error: 'Unauthorized: you do not own this job' });
        }

        if (job.status !== 'paid' && job.status !== 'completed') {
            return res.status(400).json({ error: `Cannot dispute a job with status: ${job.status}` });
        }

        if (job.disputeWindowEnds && new Date() > new Date(job.disputeWindowEnds)) {
            return res.status(400).json({ error: 'Dispute window has closed (24 hours after completion)' });
        }

        job.disputed = true;
        job.disputeReason = reason || 'No reason provided';
        job.disputedAt = new Date().toISOString();
        await job.save();

        console.log(`[/jobs/${id}/dispute] Job flagged for dispute: ${job.disputeReason}`);
        res.json(formatJob(job));
    } catch (err) {
        console.error(`[/jobs/${req.params.id}/dispute] error:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── Stripe Connect ──────────────────────────────────────────────────────────

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
        res.status(500).json({ error: err.message });
    }
});

// POST /create-account-link — generate Stripe Connect onboarding link
app.post("/create-account-link", async (req, res) => {
    try {
        console.log("[/create-account-link] incoming body:", JSON.stringify(req.body));
        const { accountId } = req.body;

        if (!accountId) {
            return res.status(400).json({ error: 'accountId is required' });
        }

        const refresh_url = 'https://locallawnpro.org/onboarding-refresh';
        const return_url = 'https://locallawnpro.org/onboarding-complete';
        console.log(`[/create-account-link] refresh_url: ${refresh_url} return_url: ${return_url}`);

        const accountLink = await stripe.accountLinks.create({
            account: accountId,
            refresh_url,
            return_url,
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

// ─── Start Server ────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
