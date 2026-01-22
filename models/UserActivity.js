// src/models/UserActivity.model.js
const mongoose = require("mongoose");

const UserActivitySchema = new mongoose.Schema(
    {
        // _id = UserActivityID
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
        activityDate: { type: Date, required: true },
        wasFrozen: { type: Boolean, required: true, default: false },
        createdAt: { type: Date, default: Date.now },
    },
    { timestamps: true }
);

// ERD: UNIQUE(UserID, ActivityDate)
UserActivitySchema.index({ userId: 1, activityDate: 1 }, { unique: true });

module.exports = mongoose.model("UserActivity", UserActivitySchema);
