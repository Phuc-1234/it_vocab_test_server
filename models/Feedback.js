// models/Feedback.js
const mongoose = require("mongoose");

const feedbackSchema = new mongoose.Schema(
    {
        // PK (Mongo sẽ tự tạo _id). Nếu bạn muốn đúng tên "FeedbackID" theo DB diagram:
        // FeedbackID: { type: mongoose.Schema.Types.ObjectId, default: () => new mongoose.Types.ObjectId() },

        title: { type: String, required: true, trim: true, maxlength: 200 },

        // Lý do/nhóm phản ánh
        reason: { type: String, required: true, trim: true, maxlength: 100 },

        content: { type: String, required: true, trim: true },

        // Trạng thái xử lý
        status: {
            type: String,
            enum: ["open", "resolved", "closed"],
            default: "open",
            index: true,
        },

        // FK -> User
        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true,
        },

        // CreatedAt (tự set bằng timestamps bên dưới)
        createdAt: { type: Date },
    },
    {
        collection: "feedbacks",
        timestamps: { createdAt: "createdAt", updatedAt: false },
    }
);

module.exports = mongoose.model("Feedback", feedbackSchema);
