// src/models/Item.model.js
const mongoose = require("mongoose");

const ItemSchema = new mongoose.Schema(
    {
        // _id = ItemID

        itemName: { type: String, required: true, trim: true, maxlength: 200 },

        itemImageURL: { type: String, default: null },

        itemType: { type: String, required: true }, // ví dụ: BOOST, FREEZE, SKIN, VFX...
        durationType: { type: String, default: null }, // ví dụ: MINUTES, DAYS, ONCE...
        durationValue: { type: Number, default: null, min: 0 },

        isStackable: { type: Boolean, required: true, default: false },

        effectType: { type: String, required: true }, // ví dụ: XP_MULTIPLIER, STREAK_PROTECT...
        effectValue: { type: Number, default: null },
    },
    { timestamps: true },
);

ItemSchema.index({ itemType: 1 });
ItemSchema.index({ effectType: 1 });

module.exports = mongoose.model("Item", ItemSchema);
