// src/models/StreakMilestone.model.js
const mongoose = require("mongoose");

const StreakMilestoneSchema = new mongoose.Schema(
    {
        // _id = StreakID (theo hình)

        dayNumber: { type: Number, required: true, min: 1, index: true },

        rewardItemId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Item",
            default: null,
        },

        streakTitle: { type: String, required: true, trim: true, maxlength: 200 },
    },
    { timestamps: true }
);

StreakMilestoneSchema.index({ dayNumber: 1 }, { unique: true });

module.exports = mongoose.model("StreakMilestone", StreakMilestoneSchema);
