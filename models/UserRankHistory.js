// src/models/UserRankHistory.model.js
const mongoose = require("mongoose");

const UserRankHistorySchema = new mongoose.Schema(
    {
        // _id = UserRankID
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
        rankId: { type: mongoose.Schema.Types.ObjectId, ref: "Rank", required: true },

        achievedDate: { type: Date, required: true, default: Date.now },
        isCurrent: { type: Boolean, required: true, default: false },

        endedAt: { type: Date, default: null },
        resetReason: { type: String, default: null, trim: true },
    },
    { timestamps: true }
);

// ERD: UNIQUE(UserID) WHERE IsCurrent = TRUE
UserRankHistorySchema.index(
    { userId: 1, isCurrent: 1 },
    { unique: true, partialFilterExpression: { isCurrent: true } }
);

UserRankHistorySchema.index({ userId: 1, achievedDate: -1 });

module.exports = mongoose.model("UserRankHistory", UserRankHistorySchema);
