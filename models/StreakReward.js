// src/models/StreakReward.model.js
const mongoose = require("mongoose");

const StreakRewardSchema = new mongoose.Schema(
    {
        // PK kép (ItemID, StreakID) => unique index
        itemId: { type: mongoose.Schema.Types.ObjectId, ref: "Item", required: true },
        streakId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "StreakMilestone",
            required: true,
        },
        quantity: { type: Number, required: true, min: 1, default: 1 },
    },
    { timestamps: true }
);

// ERD: UNIQUE(StreakID, ItemID)
StreakRewardSchema.index({ streakId: 1, itemId: 1 }, { unique: true });

module.exports = mongoose.model("StreakReward", StreakRewardSchema);
