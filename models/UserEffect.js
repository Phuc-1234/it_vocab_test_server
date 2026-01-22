// src/models/UserEffect.model.js
const mongoose = require("mongoose");

const UserEffectSchema = new mongoose.Schema(
    {
        // _id = UserEffectID
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },

        // FK2 SourceItemID
        sourceItemId: { type: mongoose.Schema.Types.ObjectId, ref: "Item", required: true },

        effectType: { type: String, required: true, trim: true },
        effectValue: { type: Number, default: null, min: 0 },

        startAt: { type: Date, required: true, default: Date.now },
        endAt: { type: Date, default: null },

        isActive: { type: Boolean, required: true, default: true },
        createdAt: { type: Date, default: Date.now },
    },
    { timestamps: true }
);

UserEffectSchema.index({ userId: 1, isActive: 1 });
UserEffectSchema.index({ userId: 1, effectType: 1 });

module.exports = mongoose.model("UserEffect", UserEffectSchema);
