// src/controllers/profile.controller.js
const mongoose = require("mongoose");

const User = require("../models/User.model");
const UserRank = require("../models/UserRank.model");
const Rank = require("../models/Rank.model");
const Inventory = require("../models/Inventory.model");

const { uploadAvatarToCloudinary } = require("../services/cloudinaryUpload.service");

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

async function computeRankInfo(userId, currentXP) {
    const latestUserRank = await UserRank.findOne({ userId })
        .sort({ achievedDate: -1 })
        .populate("rankId")
        .lean();

    const currentRankDoc = latestUserRank?.rankId || null;

    const nextRankDoc = await Rank.findOne({ neededEXP: { $gt: currentXP } })
        .sort({ neededEXP: 1 })
        .lean();

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
            neededEXP: nextRankDoc.neededEXP,
            remainingEXP: Math.max(0, nextRankDoc.neededEXP - currentXP),
        }
        : null;

    return { currentRank, nextRank };
}

async function getSkinInfo(userId) {
    const inv = await Inventory.find({ userId, isActive: true })
        .populate("itemId")
        .lean();

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
        skins
            .filter((s) => s.activatedAt)
            .sort((a, b) => new Date(b.activatedAt) - new Date(a.activatedAt))[0] || null;

    return { skins, activeSkin };
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

            const currentXP = user.currentXP ?? 0;
            const { currentRank, nextRank } = await computeRankInfo(user._id, currentXP);
            const { skins, activeSkin } = await getSkinInfo(user._id);

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
                    nextRank,

                    // skin
                    skins,
                    activeSkin,
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

            const nextPhone = normalizePhone(req.body?.phone);
            if (req.body?.phone !== undefined && nextPhone === null) {
                return res.status(400).json({ message: "Phone không hợp lệ." });
            }

            // chỉ cho sửa name/phone, không nhận email/role/status
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

            // Nếu muốn ép <= 2MB theo spec ảnh:
            // if (req.file.size > 2 * 1024 * 1024) {
            //     return res.status(400).json({ message: "File quá lớn (tối đa 2MB)." });
            // }

            const { url } = await uploadAvatarToCloudinary({
                userId,
                file: req.file,
            });

            const user = await User.findByIdAndUpdate(
                userId,
                { avatarURL: url },
                { new: true, lean: true }
            );

            if (!user) return res.status(404).json({ message: "User không tồn tại." });

            return res.json({
                message: "Cập nhật avatar thành công.",
                user: {
                    userId: user._id,
                    avatarURL: user.avatarURL,
                },
            });
        } catch (e) {
            // Có thể bắt lỗi cloudinary rõ hơn nếu cần
            return res.status(500).json({ message: "Lỗi server.", error: e.message });
        }
    },
};
