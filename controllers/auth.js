// src/controllers/auth.controller.js
require("dotenv").config();

const mongoose = require("mongoose");
const axios = require("axios");
const { OAuth2Client } = require("google-auth-library");

const User = require("../models/User.js");
const Rank = require("../models/Rank.js");
const UserRankHistory = require("../models/UserRankHistory");
const { checkDisplayNameProfanity } = require("../utils/profanity");
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

const GOOGLE_CLIENT_IDS = (process.env.GOOGLE_CLIENT_IDS || process.env.GOOGLE_CLIENT_ID || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const OTP_TTL_MIN = Number(process.env.OTP_TTL_MIN || 10);
const OTP_COOLDOWN_SEC = Number(process.env.OTP_COOLDOWN_SEC || 60);

/* ===================== HELPERS ===================== */

function normalizeName(s) {
    const v = String(s || "").trim().replace(/\s+/g, " ");
    if (v.length < 2 || v.length > 50) return null;
    return v;
}

function normalizePurpose(p) {
    const v = String(p || "").toLowerCase();
    return v === "signup" || v === "reset_password" ? v : null;
}

function ensureActive(user) {
    if (!user) return { ok: false, status: 401, message: "Sai thông tin." };
    if (String(user.status).toUpperCase() === "BANNED")
        return { ok: false, status: 403, message: "Tài khoản bị khóa." };
    return { ok: true };
}

async function issueTokensAndRotateRefresh(user, session) {
    const payload = { userId: String(user._id), role: user.role, email: user.email };

    const accessToken = signAccessToken(payload);
    const refreshToken = signRefreshToken(payload);

    user.refreshTokenHash = sha256(refreshToken);

    if (session) await user.save({ session });
    else await user.save();

    return { accessToken, refreshToken };
}

// so sánh theo ngày (bỏ giờ phút)
function startOfDay(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
}

function diffDays(a, b) {
    const ms = startOfDay(a).getTime() - startOfDay(b).getTime();
    return Math.floor(ms / (24 * 60 * 60 * 1000));
}

/**
 * Khi login:
 * - Nếu hôm nay > lastStudyDate + 1 => currentStreak = 0
 * - KHÔNG update lastStudyDate ở login (lastStudyDate update khi user làm quiz/hoạt động)
 */
async function checkStreakOnLogin(user) {
    if (!user.lastStudyDate) return false;

    const days = diffDays(new Date(), user.lastStudyDate);
    if (days > 1) {
        user.currentStreak = 0;
        await user.save();
        return true;
    }
    return false;
}

/**
 * Ensure user có Rank level 1 trong UserRankHistory (isCurrent=true)
 * - Nếu đã có current thì không tạo nữa
 * - Nếu có lịch sử nhưng không có current (data lỗi) => auto-fix: set rank1 current
 *
 * NOTE (quan trọng để chống spam nhiều request):
 * - NÊN thêm unique partial index ở schema UserRankHistory:
 *   schema.index({ userId: 1, isCurrent: 1 }, { unique: true, partialFilterExpression: { isCurrent: true } })
 * - Khi có index này, đoạn catch(err.code===11000) sẽ giúp tránh tạo 2 current nếu user fire nhiều API cùng lúc.
 */
async function ensureUserRankLv1(userId, session) {
    const q = Rank.findOne({ rankLevel: 1 }).select("_id rankLevel rankName neededXP");
    if (session) q.session(session);
    const rankLv1 = await q;

    if (!rankLv1) throw new Error("Thiếu dữ liệu Rank level 1 trong DB.");

    // nếu đã có current => ok
    const curQ = UserRankHistory.findOne({ userId, isCurrent: true }).sort({ achievedDate: -1 });
    if (session) curQ.session(session);
    const current = await curQ;
    if (current) return rankLv1;

    // đóng mọi current (phòng data bẩn)
    await UserRankHistory.updateMany(
        { userId, isCurrent: true },
        { $set: { isCurrent: false, endedAt: new Date(), resetReason: "AUTO_FIX" } },
        { ...(session ? { session } : {}) }
    );

    // tạo Rank 1 làm current (nếu có unique index, concurrent sẽ dính E11000 -> ignore)
    try {
        await UserRankHistory.create(
            [
                {
                    userId,
                    rankId: rankLv1._id,
                    achievedDate: new Date(),
                    isCurrent: true,
                    endedAt: null,
                    resetReason: null,
                },
            ],
            { ...(session ? { session } : {}) }
        );
    } catch (err) {
        if (err?.code !== 11000) throw err;
        // duplicate key => request khác đã tạo current rồi, coi như OK
    }

    return rankLv1;
}

/* ===================== CONTROLLER ===================== */

module.exports = {
    // POST /auth/register
    async register(req, res) {
        const session = await mongoose.startSession();
        session.startTransaction();

        try {
            const { name, email, password } = req.body || {};
            if (!email || !password) {
                await session.abortTransaction();
                return res.status(400).json({ message: "Thiếu email/password." });
            }

            // kiểm tra name (nếu có gửi lên)
            if (name !== undefined && name !== null && String(name).trim() !== "") {
                const normalizedName = normalizeName(name);
                if (normalizedName === null) {
                    await session.abortTransaction();
                    return res.status(400).json({ message: "Name không hợp lệ (2-50 ký tự)." });
                }

                const pf = checkDisplayNameProfanity(normalizedName);
                if (!pf.ok) {
                    await session.abortTransaction();
                    return res.status(400).json({ message: "Tên hiển thị không hợp lệ." });
                }
            }

            const existed = await User.findOne({ email }).session(session);
            if (existed) {
                await session.abortTransaction();
                return res.status(409).json({ message: "Email đã tồn tại." });
            }

            const userArr = await User.create(
                [
                    {
                        name: name ? normalizeName(name) : null,
                        email,
                        passwordHash: await hashPassword(password),
                        isVerifiedMail: false,
                        role: "USER",
                        status: "ACTIVE",

                        // init streak/xp
                        currentXP: 0,
                        currentStreak: 0,
                        longestStreak: 0,
                        lastStudyDate: null,
                    },
                ],
                { session }
            );

            const createdUser = userArr[0];

            // create UserRank level 1
            await ensureUserRankLv1(createdUser._id, session);

            await session.commitTransaction();
            return res.status(201).json({
                userId: String(createdUser._id),
                message: "Đăng ký thành công.",
            });
        } catch (e) {
            await session.abortTransaction();
            return res.status(500).json({ message: "Lỗi server.", error: e.message });
        } finally {
            session.endSession();
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

            if (!user.passwordHash) {
                return res.status(400).json({
                    message: "Tài khoản này đăng nhập social, không có mật khẩu.",
                });
            }

            const ok = await comparePassword(password, user.passwordHash);
            if (!ok) return res.status(401).json({ message: "Sai thông tin đăng nhập." });

            // check streak ngay khi login
            await checkStreakOnLogin(user);

            const tokens = await issueTokensAndRotateRefresh(user);

            return res.json({
                ...tokens,
                user: {
                    userId: String(user._id),
                    currentXP: user.currentXP ?? 0,
                    currentStreak: user.currentStreak ?? 0,
                    longestStreak: user.longestStreak ?? 0,
                    lastStudyDate: user.lastStudyDate ?? null,
                },
            });
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
                    return res
                        .status(429)
                        .json({ message: `Vui lòng thử lại sau ${Math.ceil(OTP_COOLDOWN_SEC - diffSec)}s.` });
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
            if (user.actionCodeExpiredAt.getTime() < Date.now())
                return res.status(400).json({ message: "OTP đã hết hạn." });
            if (sha256(code) !== user.actionCodeHash) return res.status(400).json({ message: "OTP không đúng." });

            // clear ActionCode*
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
            if (payload.purpose !== "reset_password")
                return res.status(401).json({ message: "Reset token không hợp lệ." });

            const user = await User.findById(payload.userId);
            if (!user) return res.status(404).json({ message: "User không tồn tại." });

            user.passwordHash = await hashPassword(newPassword);

            // clear refresh để logout hết
            user.refreshTokenHash = null;
            await user.save();

            return res.json({ message: "Đổi mật khẩu thành công." });
        } catch (e) {
            return res.status(401).json({ message: "Reset token hết hạn/không hợp lệ.", error: e.message });
        }
    },

    // POST /auth/refresh { refreshToken }
    async refresh(req, res) {
        try {
            const { refreshToken } = req.body || {};
            if (!refreshToken) return res.status(400).json({ message: "Thiếu refreshToken." });

            const payload = verifyRefreshToken(refreshToken);
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

            const userId = req.user?.userId;
            if (!userId) return res.status(401).json({ message: "Unauthorized." });

            const user = await User.findById(userId);
            if (!user) return res.status(404).json({ message: "User không tồn tại." });

            user.refreshTokenHash = null;
            await user.save();

            return res.json({ message: "Đã đăng xuất." });
        } catch (e) {
            return res.status(500).json({ message: "Lỗi server.", error: e.message });
        }
    },

    // POST /auth/google { idToken }
    async google(req, res) {
        const session = await mongoose.startSession();
        session.startTransaction();

        try {
            const { idToken } = req.body || {};
            if (!idToken) {
                await session.abortTransaction();
                return res.status(400).json({ message: "Thiếu idToken." });
            }

            const ticket = await googleClient.verifyIdToken({
                idToken,
                audience: GOOGLE_CLIENT_IDS.length ? GOOGLE_CLIENT_IDS : process.env.GOOGLE_CLIENT_ID,
            });

            const data = ticket.getPayload();
            const googleId = data.sub;
            const email = (data.email || "").toLowerCase();
            if (!email) {
                await session.abortTransaction();
                return res.status(400).json({ message: "Google token không có email." });
            }

            let user = await User.findOne({ googleId }).session(session);
            let isNewUser = false;

            if (!user) {
                user = await User.findOne({ email }).session(session);

                if (user) {
                    // link account cũ
                    user.googleId = googleId;
                    if (!user.name && data.name) user.name = data.name;
                    if (!user.avatarURL && data.picture) user.avatarURL = data.picture;
                    if (user.isVerifiedMail === false) user.isVerifiedMail = true;
                } else {
                    // tạo mới
                    isNewUser = true;
                    user = new User({
                        email,
                        name: data.name || null,
                        avatarURL: data.picture || null,
                        googleId,
                        isVerifiedMail: true,
                        role: "USER",
                        status: "ACTIVE",

                        // init streak/xp
                        currentXP: 0,
                        currentStreak: 0,
                        longestStreak: 0,
                        lastStudyDate: null,
                    });
                }
            }

            const st = ensureActive(user);
            if (!st.ok) {
                await session.abortTransaction();
                return res.status(st.status).json({ message: st.message });
            }

            await user.save({ session });

            // tạo UserRank lv1 nếu tạo mới
            if (isNewUser) {
                await ensureUserRankLv1(user._id, session);
            }

            await session.commitTransaction();

            // reload user doc “fresh” sau transaction
            const freshUser = await User.findById(user._id);
            if (!freshUser) return res.status(404).json({ message: "User không tồn tại." });

            // check streak ngay khi login social
            await checkStreakOnLogin(freshUser);

            const tokens = await issueTokensAndRotateRefresh(freshUser);
            return res.json({
                ...tokens,
                user: {
                    userId: String(freshUser._id),
                    currentXP: freshUser.currentXP ?? 0,
                    currentStreak: freshUser.currentStreak ?? 0,
                    longestStreak: freshUser.longestStreak ?? 0,
                    lastStudyDate: freshUser.lastStudyDate ?? null,
                },
            });
        } catch (e) {
            await session.abortTransaction();
            return res.status(401).json({ message: "Google login thất bại.", error: e.message });
        } finally {
            session.endSession();
        }
    },

    // POST /auth/facebook { accessToken }
    async facebook(req, res) {
        const session = await mongoose.startSession();
        session.startTransaction();

        try {
            const { accessToken } = req.body || {};
            if (!accessToken) {
                await session.abortTransaction();
                return res.status(400).json({ message: "Thiếu accessToken." });
            }

            // verify token via debug_token (optional)
            const appId = process.env.FACEBOOK_APP_ID;
            const appSecret = process.env.FACEBOOK_APP_SECRET;

            if (appId && appSecret) {
                const appAccessToken = `${appId}|${appSecret}`;
                const debugResp = await axios.get("https://graph.facebook.com/debug_token", {
                    params: { input_token: accessToken, access_token: appAccessToken },
                });

                const debugData = debugResp?.data?.data;
                if (!debugData?.is_valid) {
                    await session.abortTransaction();
                    return res.status(401).json({ message: "Facebook token không hợp lệ." });
                }
                if (String(debugData.app_id) !== String(appId)) {
                    await session.abortTransaction();
                    return res.status(401).json({ message: "Facebook token không thuộc ứng dụng này." });
                }
            }

            const resp = await axios.get("https://graph.facebook.com/me", {
                params: {
                    fields: "id,name,email,picture.type(large)",
                    access_token: accessToken,
                },
                timeout: 10000,
            });

            const fb = resp.data || {};
            const facebookId = fb.id;
            const email = String(fb.email || "").toLowerCase();
            const picUrl = fb.picture?.data?.url || null;

            if (!facebookId) {
                await session.abortTransaction();
                return res.status(400).json({ message: "Facebook token không hợp lệ." });
            }

            let user = await User.findOne({ facebookId }).session(session);
            let isNewUser = false;

            // nếu chưa có, thử link theo email
            if (!user && email) {
                user = await User.findOne({ email }).session(session);
                if (user) {
                    user.facebookId = facebookId;
                    if (!user.name && fb.name) user.name = fb.name;
                    if (!user.avatarURL && picUrl) user.avatarURL = picUrl;
                    if (user.isVerifiedMail === false) user.isVerifiedMail = true;
                }
            }

            // tạo mới nếu vẫn chưa có
            if (!user) {
                isNewUser = true;
                user = new User({
                    email: email || `fb_${facebookId}@noemail.local`,
                    name: fb.name || null,
                    avatarURL: picUrl || null,
                    facebookId,
                    isVerifiedMail: Boolean(email),
                    role: "USER",
                    status: "ACTIVE",

                    // init streak/xp
                    currentXP: 0,
                    currentStreak: 0,
                    longestStreak: 0,
                    lastStudyDate: null,
                });
            }

            const st = ensureActive(user);
            if (!st.ok) {
                await session.abortTransaction();
                return res.status(st.status).json({ message: st.message });
            }

            await user.save({ session });

            // tạo UserRank lv1 nếu tạo mới
            if (isNewUser) {
                await ensureUserRankLv1(user._id, session);
            }

            await session.commitTransaction();

            const freshUser = await User.findById(user._id);
            if (!freshUser) return res.status(404).json({ message: "User không tồn tại." });

            await checkStreakOnLogin(freshUser);

            const tokens = await issueTokensAndRotateRefresh(freshUser);
            return res.json({
                ...tokens,
                user: {
                    userId: String(freshUser._id),
                    currentXP: freshUser.currentXP ?? 0,
                    currentStreak: freshUser.currentStreak ?? 0,
                    longestStreak: freshUser.longestStreak ?? 0,
                    lastStudyDate: freshUser.lastStudyDate ?? null,
                },
            });
        } catch (e) {
            await session.abortTransaction();
            const status = e?.response?.status;
            const fbMsg = e?.response?.data?.error?.message;
            const msg = fbMsg || e?.message || "Facebook login thất bại.";
            return res.status(401).json({ message: "Facebook login thất bại.", error: msg, status });
        } finally {
            session.endSession();
        }
    },

    // PUT /auth/change-password (JWT required) { oldPassword, newPassword }
    async changePassword(req, res) {
        try {
            const userId = req.user?.userId;
            if (!userId) return res.status(401).json({ message: "Unauthorized." });

            const { oldPassword, newPassword } = req.body || {};
            if (!oldPassword || !newPassword) {
                return res.status(400).json({ message: "Thiếu oldPassword/newPassword." });
            }

            // chặn trùng password ngay từ input
            if (String(oldPassword) === String(newPassword)) {
                return res.status(400).json({ message: "Mật khẩu mới phải khác mật khẩu cũ." });
            }

            const user = await User.findById(userId);
            if (!user) return res.status(404).json({ message: "User không tồn tại." });

            const st = ensureActive(user);
            if (!st.ok) return res.status(st.status).json({ message: st.message });

            // Tài khoản social không có password
            if (!user.passwordHash) {
                return res.status(400).json({
                    message:
                        "Tài khoản này đăng nhập social, không có mật khẩu. Hãy dùng quên mật khẩu để tạo mật khẩu.",
                });
            }

            const okOld = await comparePassword(oldPassword, user.passwordHash);
            if (!okOld) return res.status(401).json({ message: "Mật khẩu cũ không đúng." });

            // đảm bảo newPassword khác oldPassword theo hash
            const sameAsOld = await comparePassword(newPassword, user.passwordHash);
            if (sameAsOld) {
                return res.status(400).json({ message: "Mật khẩu mới phải khác mật khẩu cũ." });
            }

            user.passwordHash = await hashPassword(newPassword);

            // revoke refresh token để logout các thiết bị khác
            user.refreshTokenHash = null;
            await user.save();

            return res.json({ message: "Đổi mật khẩu thành công. Vui lòng đăng nhập lại." });
        } catch (e) {
            return res.status(500).json({ message: "Lỗi server.", error: e.message });
        }
    },
};
