// src/models/Inventory.model.js
const mongoose = require("mongoose");

const InventorySchema = new mongoose.Schema(
    {
        // _id = InventoryID
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
        itemId: { type: mongoose.Schema.Types.ObjectId, ref: "Item", required: true },

        quantity: { type: Number, required: true, min: 0, default: 0 },
        acquireAt: { type: Date, required: true, default: Date.now },

        // FK3 SourceInboxID (có thể null nếu item không đến từ inbox)
        sourceInboxId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "RewardInbox",
            default: null,
        },
    },
    { timestamps: true }
);

// Thực tế nên unique 1 item / user (dễ update quantity)
InventorySchema.index({ userId: 1, itemId: 1 }, { unique: true });
InventorySchema.index({ userId: 1 });

module.exports = mongoose.model("Inventory", InventorySchema);
