// src/models/User.model.js
const mongoose = require("mongoose");

const UserSchema = new mongoose.Schema(
    {
        // Mongo đã có _id; bạn có thể dùng _id làm UserID
        name: { type: String, maxlength: 100, default: null },

        email: { type: String, required: true, unique: true, lowercase: true, trim: true },

        isVerifiedMail: { type: Boolean, required: true, default: false },

        passwordHash: { type: String, default: null }, // null nếu login social

        phone: { type: String, maxlength: 30, default: null },

        avatarURL: { type: String, default: null },

        role: { type: String, required: true, default: "USER" }, // USER/ADMIN...

        status: { type: String, required: true, default: "ACTIVE" }, // ACTIVE/BANNED...

        refreshTokenHash: { type: String, default: null }, // rotation

        actionCodeHash: { type: String, default: null }, // OTP hash
        actionCodeExpiredAt: { type: Date, default: null },
        actionPurpose: { type: String, default: null }, // signup/reset_password

        googleId: { type: String, unique: true, sparse: true },
        facebookId: { type: String, unique: true, sparse: true },

        // cooldown gửi OTP
        otpLastSentAt: { type: Date, default: null },
    },
    { timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" } }
);

module.exports = mongoose.model("User", UserSchema);
