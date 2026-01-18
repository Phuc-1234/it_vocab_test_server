const mongoose = require("mongoose");

const UserWordProgressSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User", // đúng tên model User của bạn
            required: true,
            index: true,
        },
        wordId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Word",
            required: true,
            index: true,
        },

        studyLevel: { type: Number, default: 0 }, // mức độ đã học (0..n)
        nextReviewDate: { type: Date, default: null },
        lastReviewDate: { type: Date, default: null },

        // trạng thái ôn tập (tùy bạn đặt enum)
        reviewState: {
            type: String,
            default: "NEW",
            enum: ["NEW", "LEARNING", "REVIEW", "MASTERED"],
        },
    },
    { timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" } }
);

// Mỗi user chỉ có 1 record progress cho 1 word
UserWordProgressSchema.index({ userId: 1, wordId: 1 }, { unique: true });

module.exports = mongoose.model("UserWordProgress", UserWordProgressSchema);
