// src/controllers/profile.controller.js
const mongoose = require("mongoose");

const User = require("../models/User");
const UserRank = require("../models/UserRank");
const Rank = require("../models/Rank");
const Inventory = require("../models/Inventory");

// ✅ NEW: stats sources
const QuizAttempt = require("../models/QuizAttempt");
const UserWordProgress = require("../models/UserWordProgress");
const { checkDisplayNameProfanity } = require("../utils/profanity");

const { uploadAvatarToCloudinary } = require("../services/cloudinaryUpload");

// ===== Normalizers =====
function normalizeName(name) {
    if (name == null) return undefined; // không update
    if (typeof name !== "string") return null;
    const trimmed = name.trim().replace(/\s+/g, " ");
    if (trimmed.length < 2 || trimmed.length > 50) return null;
    return trimmed;
}

function normalizePhone(phone) {
    if (phone == null) return undefined; // không update
    if (typeof phone !== "string") return null;

    const trimmed = phone.trim();
    if (trimmed.length === 0) return null;

    // validate nhẹ
    const ok = /^[0-9+\-() ]{6,30}$/.test(trimmed);
    if (!ok) return null;

    return trimmed;
}

// ===== Rank / Skin helpers =====
// ✅ INCREMENTAL RANK: neededEXP = ngưỡng XP để lên rank kế tiếp
// - currentRank lấy theo latest UserRank (fallback rankLevel=1)
// - nextRank = currentRank.rankLevel + 1
async function computeRankInfo(userId) {
    const latestUserRank = await UserRank.findOne({ userId })
        .sort({ achievedDate: -1 })
        .populate("rankId")
        .lean();

    let currentRankDoc = latestUserRank?.rankId || null;

    if (!currentRankDoc) {
        currentRankDoc = await Rank.findOne({ rankLevel: 1 }).lean();
    }

    const currentLevel = Number(currentRankDoc?.rankLevel || 1);

    const nextRankDoc = await Rank.findOne({ rankLevel: currentLevel + 1 }).lean();

    const currentRank = currentRankDoc
        ? {
            rankId: currentRankDoc._id,
            rankLevel: currentRankDoc.rankLevel,
            rankName: currentRankDoc.rankName,
            neededEXP: currentRankDoc.neededEXP,
        }
        : null;

    const nextRank = nextRankDoc
        ? {
            rankId: nextRankDoc._id,
            rankLevel: nextRankDoc.rankLevel,
            rankName: nextRankDoc.rankName,
            neededEXP: nextRankDoc.neededEXP, // ✅ ngưỡng để lên rank này
        }
        : null;

    return { currentRank, nextRank };
}

async function getSkinInfo(userId) {
    const inv = await Inventory.find({ userId, isActive: true }).populate("itemId").lean();

    const skins = inv
        .filter((x) => x.itemId && x.itemId.itemType === "SKIN")
        .map((x) => ({
            inventoryId: x._id,
            itemId: x.itemId._id,
            itemName: x.itemId.itemName,
            itemImageURL: x.itemId.itemImageURL,
            quantity: x.quantity,
            activatedAt: x.activatedAt,
            expiredAt: x.expiredAt,
            isActive: x.isActive,
        }));

    // Rule: activeSkin = skin có activatedAt mới nhất
    const activeSkin =
        skins.filter((s) => s.activatedAt).sort((a, b) => new Date(b.activatedAt) - new Date(a.activatedAt))[0] ||
        null;

    return { skins, activeSkin };
}

// ===== Stats helpers (cho Profile UI) =====
async function computeProfileStats(userId) {
    const uid = new mongoose.Types.ObjectId(String(userId));

    // lessonsDone + accuracy
    const attemptAgg = await QuizAttempt.aggregate([
        {
            $match: {
                userId: uid,
                isGuest: false,
                status: "FINISHED",
                // tuỳ bạn muốn tính mode nào vào Statistics:
                // nếu chỉ muốn TOPIC thì đổi $in: ["TOPIC"]
                mode: { $in: ["TOPIC"] },
            },
        },
        {
            $group: {
                _id: null,
                lessonsDone: { $sum: 1 },
                totalQuestions: { $sum: { $ifNull: ["$totalQuestions", 0] } },
                correctAnswers: { $sum: { $ifNull: ["$correctAnswers", 0] } },
            },
        },
    ]);

    const a = attemptAgg[0] || { lessonsDone: 0, totalQuestions: 0, correctAnswers: 0 };
    const accuracy = a.totalQuestions > 0 ? Math.round((a.correctAnswers / a.totalQuestions) * 100) : 0;

    // wordsLearned (đơn giản: studyLevel > 0)
    const wordsLearned = await UserWordProgress.countDocuments({
        userId: uid,
        studyLevel: { $gt: 0 },
    });

    return {
        lessonsDone: a.lessonsDone,
        wordsLearned,
        accuracy,
    };
}

module.exports = {
    // GET /profile (JWT required)
    async getProfile(req, res) {
        try {
            const userId = req.user?.userId;
            if (!mongoose.Types.ObjectId.isValid(userId)) {
                return res.status(401).json({ message: "Vui lòng đăng nhập để tiếp tục." });
            }

            const user = await User.findById(userId).lean();
            if (!user) return res.status(404).json({ message: "User không tồn tại." });

            // ✅ INCREMENTAL: currentXP là XP trong rank hiện tại
            const currentXP = user.currentXP ?? 0;

            // ✅ chạy song song cho nhanh
            const [{ currentRank, nextRank }, { skins, activeSkin }, stats] = await Promise.all([
                computeRankInfo(user._id),
                getSkinInfo(user._id),
                computeProfileStats(user._id),
            ]);

            // ✅ remainingEXP theo incremental threshold
            const nextRankWithRemain = nextRank
                ? {
                    ...nextRank,
                    remainingEXP: Math.max(0, Number(nextRank.neededEXP || 0) - Number(currentXP || 0)),
                }
                : null;

            return res.json({
                message: "Lấy profile thành công.",
                user: {
                    userId: user._id,
                    name: user.name,
                    avatarURL: user.avatarURL,
                    phone: user.phone,

                    // streak/xp
                    currentXP,
                    currentStreak: user.currentStreak ?? 0,
                    longestStreak: user.longestStreak ?? 0,
                    lastStudyDate: user.lastStudyDate ?? null,

                    // rank
                    currentRank,
                    nextRank: nextRankWithRemain,

                    // skin
                    skins,
                    activeSkin,

                    // ✅ NEW: stats + memberSince cho UI
                    stats,
                    memberSince: user.createdAt ?? null,
                },
            });
        } catch (e) {
            return res.status(500).json({ message: "Lỗi server.", error: e.message });
        }
    },

    // PUT /profile  (JWT required)
    async updateProfile(req, res) {
        try {
            const userId = req.user?.userId;
            if (!mongoose.Types.ObjectId.isValid(userId)) {
                return res.status(401).json({ message: "Vui lòng đăng nhập để tiếp tục." });
            }

            const nextName = normalizeName(req.body?.name);
            if (req.body?.name !== undefined && nextName === null) {
                return res.status(400).json({ message: "Name không hợp lệ (2-50 ký tự)." });
            }

            if (typeof nextName === "string") {
                const pf = checkDisplayNameProfanity(nextName);
                if (!pf.ok) {
                    return res.status(400).json({ message: "Tên hiển thị không hợp lệ." });
                }
            }

            const nextPhone = normalizePhone(req.body?.phone);
            if (req.body?.phone !== undefined && nextPhone === null) {
                return res.status(400).json({ message: "Phone không hợp lệ." });
            }

            // chỉ cho sửa name/phone, không nhận email/role/status
            const update = {};
            if (nextName !== undefined) update.name = nextName; // null => clear
            if (nextPhone !== undefined) update.phone = nextPhone; // null => clear

            const user = await User.findByIdAndUpdate(userId, update, { new: true, lean: true });
            if (!user) return res.status(404).json({ message: "User không tồn tại." });

            return res.json({
                message: "Cập nhật profile thành công.",
                user: {
                    userId: user._id,
                    name: user.name,
                    phone: user.phone,
                    avatarURL: user.avatarURL,
                },
            });
        } catch (e) {
            return res.status(500).json({ message: "Lỗi server.", error: e.message });
        }
    },

    // PUT /profile/avatar (JWT required, multipart/form-data)
    async updateAvatar(req, res) {
        try {
            const userId = req.user?.userId;
            if (!mongoose.Types.ObjectId.isValid(userId)) {
                return res.status(401).json({ message: "Vui lòng đăng nhập để tiếp tục." });
            }

            // upload.js memoryStorage => req.file.buffer
            if (!req.file || !req.file.buffer) {
                return res.status(400).json({ message: "Thiếu file avatar." });
            }

            const { url } = await uploadAvatarToCloudinary({
                userId,
                file: req.file,
            });

            const user = await User.findByIdAndUpdate(userId, { avatarURL: url }, { new: true, lean: true });
            if (!user) return res.status(404).json({ message: "User không tồn tại." });

            return res.json({
                message: "Cập nhật avatar thành công.",
                user: {
                    userId: user._id,
                    avatarURL: user.avatarURL,
                },
            });
        } catch (e) {
            return res.status(500).json({ message: "Lỗi server.", error: e.message });
        }
    },
};
