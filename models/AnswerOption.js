const mongoose = require("mongoose");

const AnswerOptionSchema = new mongoose.Schema(
    {
        content: { type: String, required: true, trim: true },

        isCorrect: { type: Boolean, default: false },
        isActive: { type: Boolean, default: true },

        questionId: { type: mongoose.Schema.Types.ObjectId, ref: "Question", required: true },

        deletedAt: { type: Date, default: null },
    },
    { timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" } }
);

AnswerOptionSchema.index({ questionId: 1, isActive: 1 });

module.exports = mongoose.model("AnswerOption", AnswerOptionSchema);
