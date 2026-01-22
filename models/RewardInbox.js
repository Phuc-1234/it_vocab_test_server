// src/models/RewardInbox.model.js
const mongoose = require("mongoose");

const RewardInboxSchema = new mongoose.Schema(
    {
        // _id = RewardInboxID
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },

        createdAt: { type: Date, default: Date.now, required: true },

        // nguồn phát thưởng: tuỳ bạn (RANK/STREAK/...)
        sourceType: { type: String, required: true, trim: true },

        claimedAt: { type: Date, default: null },

        // FK2 StreakID (Nullable)
        streakId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "StreakMilestone",
            default: null,
        },

        // FK3 RankID (Nullable)
        rankId: { type: mongoose.Schema.Types.ObjectId, ref: "Rank", default: null },
    },
    { timestamps: true }
);

// ERD: UNIQUE(UserID, RankID) WHERE RankID IS NOT NULL
RewardInboxSchema.index(
    { userId: 1, rankId: 1 },
    { unique: true, partialFilterExpression: { rankId: { $ne: null } } }
);

// ERD: UNIQUE(UserID, StreakID) WHERE StreakID IS NOT NULL
RewardInboxSchema.index(
    { userId: 1, streakId: 1 },
    { unique: true, partialFilterExpression: { streakId: { $ne: null } } }
);

// ERD: (RankID IS NOT NULL) XOR (StreakID IS NOT NULL)
// FIX: Bỏ tham số 'next' vì đây là logic đồng bộ
RewardInboxSchema.pre("validate", function () {
    const hasRank = this.rankId != null;
    const hasStreak = this.streakId != null;

    if (hasRank === hasStreak) {
        // Thay vì return next(Error), ta ném lỗi trực tiếp
        throw new Error("RewardInbox: rankId và streakId phải XOR (chỉ 1 trong 2 được set).");
    }
    // Không cần gọi next()
});

module.exports = mongoose.model("RewardInbox", RewardInboxSchema);