// src/controllers/profile.controller.js
const mongoose = require("mongoose");

const User = require("../models/User");
const UserRankHistory = require("../models/UserRankHistory");
const Rank = require("../models/Rank");
const Inventory = require("../models/Inventory"); // ✅ đúng model mới (không còn isActive)
const RewardInbox = require("../models/RewardInbox");
const QuizAttempt = require("../models/QuizAttempt");
const UserWordProgress = require("../models/UserWordProgress");
const UserEquipped = require("../models/UserEquipped"); // ✅ equipped skin/frame
const { checkDisplayNameProfanity } = require("../utils/profanity");
const { uploadAvatarToCloudinary } = require("../services/cloudinaryUpload");

/* ===================== NORMALIZERS ===================== */

function normalizeName(name) {
    if (name == null) return undefined;
    if (typeof name !== "string") return null;
    const trimmed = name.trim().replace(/\s+/g, " ");
    if (trimmed.length < 2 || trimmed.length > 50) return null;
    return trimmed;
}

function normalizePhone(phone) {
    if (phone == null) return undefined;
    if (typeof phone !== "string") return null;

    const trimmed = phone.trim();
    if (trimmed.length === 0) return null;
    if (!/^[0-9+\-() ]{6,30}$/.test(trimmed)) return null;

    return trimmed;
}

/* ===================== RANK HELPERS (INCREMENTAL) ===================== */

async function computeRankInfo(userId, currentXP) {
    // ✅ rank hiện tại theo isCurrent
    let history = await UserRankHistory.findOne({
        userId,
        isCurrent: true,
    })
        .populate("rankId")
        .lean();

    let currentRankDoc = history?.rankId;

    if (!currentRankDoc) {
        currentRankDoc = await Rank.findOne({ rankLevel: 1 }).lean();
    }

    if (!currentRankDoc) return { currentRank: null, nextRank: null };

    // ✅ Alias neededEXP cho FE, giữ neededXP cho BE
    const currentNeededXP = Number(currentRankDoc.neededXP || 0);

    const currentRank = {
        rankId: currentRankDoc._id,
        rankLevel: currentRankDoc.rankLevel,
        rankName: currentRankDoc.rankName,
        neededXP: currentNeededXP,
    };

    const nextRankDoc = await Rank.findOne({
        rankLevel: Number(currentRankDoc.rankLevel) + 1,
    }).lean();

    const nextRank = nextRankDoc
        ? {
            rankId: nextRankDoc._id,
            rankLevel: nextRankDoc.rankLevel,
            rankName: nextRankDoc.rankName,

            // BE chuẩn
            neededXP: Number(nextRankDoc.neededXP || 0),

            remainingXP: Math.max(0, nextRankDoc.neededXP - Number(currentXP || 0)),
        }
        : null;

    return { currentRank, nextRank };
}

/* ===================== SKIN HELPERS ===================== */

/**
 * ✅ Inventory mới không có isActive nữa
 * -> trả về list skins user sở hữu (quantity + item info)
 */
async function getSkinInfo(userId) {
    const inv = await Inventory.find({ userId })
        .populate("itemId")
        .lean();

    const skins = inv
        .filter((x) => x.itemId?.itemType === "SKIN")
        .map((x) => ({
            inventoryId: x._id,
            itemId: x.itemId?._id,
            itemName: x.itemId?.itemName,
            itemImageURL: x.itemId?.itemImageURL ?? null,
            quantity: x.quantity,
            acquireAt: x.acquireAt ?? null,
            sourceInboxId: x.sourceInboxId ?? null,
        }));

    // ✅ Không còn activeSkin theo Inventory nữa
    return { skins };
}

/**
 * ✅ Lấy item đang equipped từ UserEquipped
 * slotType tuỳ bạn đang lưu, ở đây ưu tiên thử vài value phổ biến.
 */
async function getEquippedSkinInfo(userId) {
    const slotTypesToTry = ["SKIN", "FRAME", "AVATAR_FRAME"];

    let equipped = null;
    for (const slotType of slotTypesToTry) {
        equipped = await UserEquipped.findOne({ userId, slotType })
            .populate("itemId")
            .lean();
        if (equipped) break;
    }

    if (!equipped || !equipped.itemId) return null;

    return {
        userEquippedId: equipped._id,
        slotType: equipped.slotType,
        equippedAt: equipped.equippedAt ?? null,

        itemId: equipped.itemId._id,
        itemName: equipped.itemId.itemName,
        itemImageURL: equipped.itemId.itemImageURL ?? null,
        itemType: equipped.itemId.itemType,
    };
}

/* ===================== STATS ===================== */

async function computeProfileStats(userId) {
    const uid = new mongoose.Types.ObjectId(String(userId));

    const attemptAgg = await QuizAttempt.aggregate([
        {
            $match: {
                userId: uid,
                isGuest: false,
                status: "FINISHED",
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

/* ===================== CONTROLLER ===================== */

module.exports = {
    // GET /profile
    async getProfile(req, res) {
        try {
            const userId = req.user?.userId;
            if (!mongoose.Types.ObjectId.isValid(userId)) {
                return res.status(401).json({ message: "Vui lòng đăng nhập." });
            }

            const user = await User.findById(userId).lean();
            if (!user) return res.status(404).json({ message: "User không tồn tại." });

            const currentXP = Number(user.currentXP || 0);

            // ===== Rank (you only want minimal fields like sample) =====
            const { currentRank, nextRank } = await computeRankInfo(user._id, currentXP);

            // ===== Equipped skin (only fields like sample) =====
            const equipped = await (async () => {
                const slotTypesToTry = ["SKIN", "FRAME", "AVATAR_FRAME"];
                let doc = null;

                for (const slotType of slotTypesToTry) {
                    doc = await UserEquipped.findOne({ userId: user._id, slotType })
                        .populate("itemId")
                        .lean();
                    if (doc) break;
                }

                if (!doc?.itemId) return null;

                return {
                    slotType: doc.slotType,
                    itemName: doc.itemId.itemName,
                    itemImageURL: doc.itemId.itemImageURL ?? null,
                };
            })();

            // ===== Stats =====
            const stats = await computeProfileStats(user._id);

            // ===== Unclaimed rewards count =====
            const unclaimedRewardsCount = await RewardInbox.countDocuments({
                userId: user._id,
                claimedAt: null,
            });

            // ===== Build EXACT response like your sample JSON =====
            return res.json({
                message: "Lấy profile thành công.",
                user: {
                    userId: user._id,
                    name: user.name,
                    avatarURL: user.avatarURL ?? null,
                    phone: user.phone ?? null,

                    currentXP,
                    currentStreak: user.currentStreak ?? 0,
                    longestStreak: user.longestStreak ?? 0,
                    lastStudyDate: user.lastStudyDate ?? null,

                    currentRank: currentRank
                        ? {
                            rankLevel: currentRank.rankLevel,
                            rankName: currentRank.rankName,
                        }
                        : null,

                    nextRank: nextRank
                        ? {
                            neededXP: nextRank.neededXP ?? nextRank.neededEXP ?? 0,
                            remainingXP: nextRank.remainingXP ?? nextRank.remainingEXP ?? 0,
                        }
                        : null,

                    equippedSkin: equipped,

                    stats: {
                        lessonsDone: stats?.lessonsDone ?? 0,
                        wordsLearned: stats?.wordsLearned ?? 0,
                        accuracy: stats?.accuracy ?? 0,
                    },

                    memberSince: user.createdAt ?? null,
                    unclaimedRewardsCount: Number(unclaimedRewardsCount || 0),
                },
            });
        } catch (e) {
            return res.status(500).json({ message: "Lỗi server.", error: e.message });
        }
    },
    // PUT /profile
    async updateProfile(req, res) {
        try {
            const userId = req.user?.userId;
            if (!mongoose.Types.ObjectId.isValid(userId)) {
                return res.status(401).json({ message: "Vui lòng đăng nhập." });
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

            const update = {};
            if (nextName !== undefined) update.name = nextName;
            if (nextPhone !== undefined) update.phone = nextPhone;

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

    // PUT /profile/avatar
    async updateAvatar(req, res) {
        try {
            const userId = req.user?.userId;
            if (!mongoose.Types.ObjectId.isValid(userId)) {
                return res.status(401).json({ message: "Vui lòng đăng nhập." });
            }

            if (!req.file?.buffer) {
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
