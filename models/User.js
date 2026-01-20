// src/models/User.model.js
const mongoose = require("mongoose");

const UserSchema = new mongoose.Schema(
    {
        name: { type: String, maxlength: 100, default: null },
        email: { type: String, required: true, unique: true, lowercase: true, trim: true },
        isVerifiedMail: { type: Boolean, required: true, default: false },
        passwordHash: { type: String, default: null },
        phone: { type: String, maxlength: 30, default: null },
        avatarURL: { type: String, default: null },
        role: { type: String, required: true, default: "USER" },
        status: { type: String, required: true, default: "ACTIVE" },

        refreshTokenHash: { type: String, default: null },

        actionCodeHash: { type: String, default: null },
        actionCodeExpiredAt: { type: Date, default: null },
        actionPurpose: { type: String, default: null },

        googleId: { type: String, unique: true, sparse: true },
        facebookId: { type: String, unique: true, sparse: true },

        otpLastSentAt: { type: Date, default: null },

        // ✅ THÊM CÁC TRƯỜNG THEO THIẾT KẾ STREAK/Xp
        currentXP: { type: Number, required: true, default: 0, min: 0 },
        currentStreak: { type: Number, required: true, default: 0, min: 0 },
        longestStreak: { type: Number, required: true, default: 0, min: 0 },
        lastStudyDate: { type: Date, default: null }, // lưu ngày gần nhất có hoạt động (date)
    },
    { timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" } }
);

module.exports = mongoose.model("User", UserSchema);
