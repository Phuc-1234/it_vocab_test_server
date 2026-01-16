// src/controllers/auth.controller.js
const axios = require("axios");
const { OAuth2Client } = require("google-auth-library");
const User = require("../models/User.js");
const { sha256, hashPassword, comparePassword } = require("../utils/crypto");
const { genOtp6 } = require("../utils/otp");
const {
    signAccessToken,
    signRefreshToken,
    signResetToken,
    verifyRefreshToken,
    verifyResetToken,
} = require("../utils/jwt");
const { sendOtpMail } = require("../services/mail");

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const OTP_TTL_MIN = Number(process.env.OTP_TTL_MIN || 10);
const OTP_COOLDOWN_SEC = Number(process.env.OTP_COOLDOWN_SEC || 60);

function normalizePurpose(p) {
    const v = String(p || "").toLowerCase();
    return v === "signup" || v === "reset_password" ? v : null;
}

function ensureActive(user) {
    if (!user) return { ok: false, status: 401, message: "Sai thông tin." };
    if (String(user.status).toUpperCase() === "BANNED") return { ok: false, status: 403, message: "Tài khoản bị khóa." };
    return { ok: true };
}

async function issueTokensAndRotateRefresh(user) {
    const payload = { userId: String(user._id), role: user.role, email: user.email };

    const accessToken = signAccessToken(payload);
    const refreshToken = signRefreshToken(payload);

    user.refreshTokenHash = sha256(refreshToken);
    await user.save();

    return { accessToken, refreshToken };
}

module.exports = {
    // POST /auth/register
    async register(req, res) {
        try {
            const { name, email, password } = req.body || {};
            if (!email || !password) return res.status(400).json({ message: "Thiếu email/password." });

            const existed = await User.findOne({ email });
            if (existed) return res.status(409).json({ message: "Email đã tồn tại." });

            const user = await User.create({
                name: name || null,
                email,
                passwordHash: await hashPassword(password),
                isVerifiedMail: false,
                role: "USER",
                status: "ACTIVE",
            });

            return res.status(201).json({ userId: String(user._id), message: "Đăng ký thành công." });
        } catch (e) {
            return res.status(500).json({ message: "Lỗi server.", error: e.message });
        }
    },

    // POST /auth/login
    async login(req, res) {
        try {
            const { email, password } = req.body || {};
            if (!email || !password) return res.status(400).json({ message: "Thiếu email/password." });

            const user = await User.findOne({ email });
            const st = ensureActive(user);
            if (!st.ok) return res.status(st.status).json({ message: st.message });

            if (!user.passwordHash) return res.status(400).json({ message: "Tài khoản này đăng nhập social, không có mật khẩu." });

            const ok = await comparePassword(password, user.passwordHash);
            if (!ok) return res.status(401).json({ message: "Sai thông tin đăng nhập." });

            const tokens = await issueTokensAndRotateRefresh(user);
            return res.json(tokens);
        } catch (e) {
            return res.status(500).json({ message: "Lỗi server.", error: e.message });
        }
    },

    // POST /auth/send-code { email, purpose }
    async sendCode(req, res) {
        try {
            const { email, purpose } = req.body || {};
            const p = normalizePurpose(purpose);
            if (!email || !p) return res.status(400).json({ message: "Thiếu email hoặc purpose không hợp lệ." });

            const user = await User.findOne({ email });
            if (!user) return res.status(404).json({ message: "Email không tồn tại." });

            // cooldown ~ 1m
            if (user.otpLastSentAt) {
                const diffSec = (Date.now() - user.otpLastSentAt.getTime()) / 1000;
                if (diffSec < OTP_COOLDOWN_SEC) {
                    return res.status(429).json({ message: `Vui lòng thử lại sau ${Math.ceil(OTP_COOLDOWN_SEC - diffSec)}s.` });
                }
            }

            const code = genOtp6();
            const expires = new Date(Date.now() + OTP_TTL_MIN * 60 * 1000);

            user.actionCodeHash = sha256(code);
            user.actionCodeExpiredAt = expires;
            user.actionPurpose = p;
            user.otpLastSentAt = new Date();
            await user.save();

            await sendOtpMail(email, code, p);
            return res.json({ message: "Đã gửi mã OTP." });
        } catch (e) {
            return res.status(500).json({ message: "Lỗi server.", error: e.message });
        }
    },

    // POST /auth/verify-code { email, purpose, code }
    async verifyCode(req, res) {
        try {
            const { email, purpose, code } = req.body || {};
            const p = normalizePurpose(purpose);
            if (!email || !p || !code) return res.status(400).json({ message: "Thiếu dữ liệu." });

            const user = await User.findOne({ email });
            if (!user) return res.status(404).json({ message: "Email không tồn tại." });

            if (!user.actionCodeHash || !user.actionCodeExpiredAt || !user.actionPurpose) {
                return res.status(400).json({ message: "Không có OTP hợp lệ." });
            }

            if (user.actionPurpose !== p) return res.status(400).json({ message: "Sai mục đích OTP." });
            if (user.actionCodeExpiredAt.getTime() < Date.now()) return res.status(400).json({ message: "OTP đã hết hạn." });

            if (sha256(code) !== user.actionCodeHash) return res.status(400).json({ message: "OTP không đúng." });

            // đúng => clear ActionCode*
            user.actionCodeHash = null;
            user.actionCodeExpiredAt = null;
            user.actionPurpose = null;

            if (p === "signup") {
                user.isVerifiedMail = true;
                await user.save();
                return res.json({ message: "Xác thực email thành công." });
            }

            // reset_password
            await user.save();
            const resetToken = signResetToken({ userId: String(user._id), email: user.email });
            return res.json({ resetToken });
        } catch (e) {
            return res.status(500).json({ message: "Lỗi server.", error: e.message });
        }
    },

    // POST /auth/new-password { resetToken, newPassword }
    async newPassword(req, res) {
        try {
            const { resetToken, newPassword } = req.body || {};
            if (!resetToken || !newPassword) return res.status(400).json({ message: "Thiếu dữ liệu." });

            const payload = verifyResetToken(resetToken);
            if (payload.purpose !== "reset_password") return res.status(401).json({ message: "Reset token không hợp lệ." });

            const user = await User.findById(payload.userId);
            if (!user) return res.status(404).json({ message: "User không tồn tại." });

            user.passwordHash = await hashPassword(newPassword);

            // khuyến nghị: clear refresh để logout hết
            user.refreshTokenHash = null;

            await user.save();
            return res.json({ message: "Đổi mật khẩu thành công." });
        } catch (e) {
            return res.status(401).json({ message: "Reset token hết hạn/không hợp lệ.", error: e.message });
        }
    },

    // POST /auth/refresh  (JWT required theo spec) { refreshToken }
    async refresh(req, res) {
        try {
            const { refreshToken } = req.body || {};
            if (!refreshToken) return res.status(400).json({ message: "Thiếu refreshToken." });

            const payload = verifyRefreshToken(refreshToken); // throws nếu invalid/expired
            const user = await User.findById(payload.userId);
            const st = ensureActive(user);
            if (!st.ok) return res.status(st.status).json({ message: st.message });

            // compare hash (rotation)
            if (!user.refreshTokenHash || sha256(refreshToken) !== user.refreshTokenHash) {
                return res.status(401).json({ message: "Refresh token không hợp lệ (đã bị revoke/rotate)." });
            }

            const tokens = await issueTokensAndRotateRefresh(user);
            return res.json(tokens);
        } catch (e) {
            return res.status(401).json({ message: "Refresh token hết hạn/không hợp lệ.", error: e.message });
        }
    },

    // POST /auth/logout (JWT required) { refreshToken }
    async logout(req, res) {
        try {
            const { refreshToken } = req.body || {};
            if (!refreshToken) return res.status(400).json({ message: "Thiếu refreshToken." });

            // nếu muốn revoke theo user đang login:
            // authMiddleware của bạn set req.user = decoded :contentReference[oaicite:2]{index=2}
            const userId = req.user?.userId;
            if (!userId) return res.status(401).json({ message: "Unauthorized." });

            const user = await User.findById(userId);
            if (!user) return res.status(404).json({ message: "User không tồn tại." });

            // revoke
            user.refreshTokenHash = null;
            await user.save();

            return res.json({ message: "Đã đăng xuất." });
        } catch (e) {
            return res.status(500).json({ message: "Lỗi server.", error: e.message });
        }
    },

    // POST /auth/google { idToken }
    async google(req, res) {
        try {
            const { idToken } = req.body || {};
            if (!idToken) return res.status(400).json({ message: "Thiếu idToken." });

            const ticket = await googleClient.verifyIdToken({
                idToken,
                audience: process.env.GOOGLE_CLIENT_ID,
            });
            const data = ticket.getPayload(); // { sub, email, name, picture ... }
            const googleId = data.sub;
            const email = (data.email || "").toLowerCase();

            if (!email) return res.status(400).json({ message: "Google token không có email." });

            let user = await User.findOne({ googleId });
            if (!user) {
                // nếu đã có email => link
                user = await User.findOne({ email });
                if (user) {
                    user.googleId = googleId;
                } else {
                    user = new User({
                        email,
                        name: data.name || null,
                        avatarURL: data.picture || null,
                        googleId,
                        isVerifiedMail: true,
                        role: "USER",
                        status: "ACTIVE",
                        passwordHash: null,
                    });
                }
            }

            const st = ensureActive(user);
            if (!st.ok) return res.status(st.status).json({ message: st.message });

            await user.save();
            const tokens = await issueTokensAndRotateRefresh(user);
            return res.json(tokens);
        } catch (e) {
            return res.status(401).json({ message: "Google login thất bại.", error: e.message });
        }
    },

    // POST /auth/facebook { accessToken }
    async facebook(req, res) {
        try {
            const { accessToken } = req.body || {};
            if (!accessToken) return res.status(400).json({ message: "Thiếu accessToken." });

            // Graph API: /me?fields=id,name,email,picture
            const resp = await axios.get("https://graph.facebook.com/me", {
                params: { fields: "id,name,email,picture", access_token: accessToken },
            });
            const fb = resp.data;
            const facebookId = fb.id;
            const email = (fb.email || "").toLowerCase();

            if (!facebookId) return res.status(400).json({ message: "Facebook token không hợp lệ." });

            let user = await User.findOne({ facebookId });
            if (!user) {
                if (email) {
                    user = await User.findOne({ email });
                }
                if (user) {
                    user.facebookId = facebookId;
                } else {
                    user = new User({
                        email: email || `fb_${facebookId}@noemail.local`,
                        name: fb.name || null,
                        avatarURL: fb.picture?.data?.url || null,
                        facebookId,
                        isVerifiedMail: Boolean(email),
                        role: "USER",
                        status: "ACTIVE",
                        passwordHash: null,
                    });
                }
            }

            const st = ensureActive(user);
            if (!st.ok) return res.status(st.status).json({ message: st.message });

            await user.save();
            const tokens = await issueTokensAndRotateRefresh(user);
            return res.json(tokens);
        } catch (e) {
            return res.status(401).json({ message: "Facebook login thất bại.", error: e.message });
        }
    },
};
