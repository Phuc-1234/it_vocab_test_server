// src/models/StreakMilestone.model.js
const mongoose = require("mongoose");

const StreakMilestoneSchema = new mongoose.Schema(
    {
        // _id = StreakID
        dayNumber: { type: Number, required: true, min: 1 },
        streakTitle: { type: String, required: true, trim: true, maxlength: 200 },
        createdAt: { type: Date, default: Date.now },
    },
    { timestamps: true }
);

StreakMilestoneSchema.index({ dayNumber: 1 }, { unique: true });

module.exports = mongoose.model("StreakMilestone", StreakMilestoneSchema);
