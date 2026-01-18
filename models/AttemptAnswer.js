const mongoose = require("mongoose");

const AttemptAnswerSchema = new mongoose.Schema(
    {
        attemptId: { type: mongoose.Schema.Types.ObjectId, ref: "QuizAttempt", required: true, index: true },
        questionId: { type: mongoose.Schema.Types.ObjectId, ref: "Question", required: true, index: true },

        answeredAt: { type: Date, default: null },

        /**
         * Minimal change nhưng đủ dùng cho 3 dạng câu hỏi:
         * - MCQ / TRUE_FALSE: selectedOptionId
         * - FILL_BLANK: answerText
         */
        selectedOptionId: { type: mongoose.Schema.Types.ObjectId, ref: "AnswerOption", default: null },
        answerText: { type: String, default: null, trim: true },

        // chấm đúng/sai (null nếu chưa trả lời)
        isCorrect: { type: Boolean, default: null },
    },
    { timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" } }
);

// 1 attempt chỉ có 1 record cho 1 question
AttemptAnswerSchema.index({ attemptId: 1, questionId: 1 }, { unique: true });

module.exports = mongoose.model("AttemptAnswer", AttemptAnswerSchema);
