const mongoose = require("mongoose");

const QuizAttemptSchema = new mongoose.Schema(
    {
        // User (có thể null nếu Guest)
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },

        // Guest support (minimal)
        isGuest: { type: Boolean, default: false },
        guestKey: { type: String, default: null, index: true }, // uuid/cookie id để verify guest

        // Mode theo nghiệp vụ
        mode: {
            type: String,
            required: true,
            trim: true,
            enum: ["TOPIC", "RANDOM", "INFINITE", "LEARN"],
            index: true,
        },

        // TOPIC/LEARN cần để lọc câu hỏi + SR
        topicId: { type: mongoose.Schema.Types.ObjectId, ref: "Topic", default: null, index: true },

        // user chọn "độ khó/level" (map theo Word.level của topic)
        level: { type: Number, default: null, index: true },

        // Danh sách câu hỏi của attempt (để resume + next-batch INFINITE)
        questionIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Question", default: [] }],

        totalQuestions: { type: Number, default: 0, min: 0 },
        correctAnswers: { type: Number, default: 0, min: 0 },

        earnedXP: { type: Number, default: 0, min: 0 },

        status: {
            type: String,
            required: true,
            trim: true,
            enum: ["IN_PROGRESS", "FINISHED", "ABANDONED"],
            default: "IN_PROGRESS",
            index: true,
        },

        startedAt: { type: Date, default: Date.now, index: true },
        finishedAt: { type: Date, default: null },
    },
    { timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" } }
);

/**
 * Minimal validation theo nghiệp vụ
 */
QuizAttemptSchema.pre("validate", function () {
    const hasUser = !!this.userId;
    const hasGuest = !!this.guestKey;

    if (!hasUser && !hasGuest) {
        throw new Error("QuizAttempt must have userId or guestKey.");
    }

    this.isGuest = !hasUser;

    if (this.isGuest) {
        if (!["RANDOM", "TOPIC"].includes(this.mode)) {
            throw new Error("Guest only allowed RANDOM or TOPIC.");
        }
        if (this.mode === "TOPIC" && this.level !== 1) {
            throw new Error("Guest TOPIC only allowed level 1.");
        }
    }

    if (["TOPIC", "LEARN"].includes(this.mode)) {
        if (!this.topicId) throw new Error("TOPIC/LEARN requires topicId.");
        if (this.level == null) throw new Error("TOPIC/LEARN requires level.");
    }
});

QuizAttemptSchema.index({ userId: 1, createdAt: -1 });
QuizAttemptSchema.index({ guestKey: 1, createdAt: -1 });

module.exports = mongoose.model("QuizAttempt", QuizAttemptSchema);
