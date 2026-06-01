const mongoose = require('mongoose');

const jobSchema = new mongoose.Schema({
    title: { type: String, required: true },
    serviceType: { type: String, default: null },
    basePrice: { type: Number, required: true },
    fee: { type: Number, required: true },
    totalPrice: { type: Number, required: true },
    status: { type: String, default: 'pending' },
    address: { type: String, required: true },
    coordinate: {
        lat: { type: Number, required: true },
        lng: { type: Number, required: true }
    },
    customerId: { type: String, required: true },
    workerId: { type: String, default: null },
    paymentStatus: { type: String, default: 'authorized' },
    paymentIntentId: { type: String, default: null },
    addOns: { type: Array, default: [] },
    completedAt: { type: String, default: null },
    disputeWindowEnds: { type: String, default: null },
    disputed: { type: Boolean, default: false },
    disputeReason: { type: String, default: null },
    disputedAt: { type: String, default: null }
}, { timestamps: true });

module.exports = mongoose.model('Job', jobSchema);
