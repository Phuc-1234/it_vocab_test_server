// src/models/Inventory.model.js
const mongoose = require("mongoose");

const InventorySchema = new mongoose.Schema(
    {
        // _id = InventoryID

        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true,
        },

        itemId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Item",
            required: true,
            index: true,
        },

        activatedAt: { type: Date, default: null },

        quantity: { type: Number, required: true, default: 0, min: 0 },

        expiredAt: { type: Date, default: null },

        isActive: { type: Boolean, required: true, default: true },
    },
    { timestamps: true }
);

// Gợi ý: 1 user chỉ nên có 1 dòng inventory cho mỗi item (tuỳ business)
InventorySchema.index({ userId: 1, itemId: 1 }, { unique: true });

module.exports = mongoose.model("Inventory", InventorySchema);
