// src/controllers/leaderboard.js
const mongoose = require("mongoose");
const User = require("../models/User");
const UserRankHistory = require("../models/UserRankHistory");
const Rank = require("../models/Rank");
const UserEquipped = require("../models/UserEquipped");
const Item = require("../models/Item");

// ✅ helper: lấy itemImageURL của SKIN đang equip
async function getActiveSkinImageURL(userId) {
    const uid = typeof userId === "string" ? new mongoose.Types.ObjectId(userId) : userId;

    const rows = await UserEquipped.aggregate([
        { $match: { userId: uid, slotType: "SKIN" } },
        { $limit: 1 },
        {
            $lookup: {
                from: Item.collection.name,
                localField: "itemId",
                foreignField: "_id",
                as: "item",
            },
        },
        { $unwind: { path: "$item", preserveNullAndEmptyArrays: true } },
        { $project: { _id: 0, itemImageURL: "$item.itemImageURL" } },
    ]).exec();

    return rows?.[0]?.itemImageURL ?? null;
}

module.exports = {
    async getLeaderboard(req, res) {
        try {
            const { tab } = req.params;

            // ✅ optional auth: có token thì middleware optionalAuth set req.user
            const userId = req.user?.userId || null;

            let match = {};
            let sort = {};

            if (tab === "xp") {
                match = {};
                sort = { currentXP: -1, _id: 1 };
            } else if (tab === "streak") {
                // ✅ SỬA LOGIC: Không check ngày nữa, chỉ cần có chuỗi > 0 là được hiện
                match = { currentStreak: { $gt: 0 } };
                sort = { currentStreak: -1, _id: 1 };
            } else {
                return res.status(400).json({ message: "Invalid tab parameter" });
            }

            const userListRaw = await User.aggregate([
                { $match: match },
                { $sort: sort },
                { $limit: 10 },

                // ✅ lookup current rank history -> rank
                {
                    $lookup: {
                        from: UserRankHistory.collection.name,
                        let: { uid: "$_id" },
                        pipeline: [
                            {
                                $match: {
                                    $expr: {
                                        $and: [
                                            { $eq: ["$userId", "$$uid"] },
                                            { $eq: ["$isCurrent", true] },
                                        ],
                                    },
                                },
                            },
                            { $limit: 1 },
                            {
                                $lookup: {
                                    from: Rank.collection.name,
                                    localField: "rankId",
                                    foreignField: "_id",
                                    as: "rank",
                                },
                            },
                            { $unwind: { path: "$rank", preserveNullAndEmptyArrays: true } },
                            {
                                $project: {
                                    _id: 0,
                                    rankLevel: "$rank.rankLevel",
                                },
                            },
                        ],
                        as: "currentRank",
                    },
                },
                { $unwind: { path: "$currentRank", preserveNullAndEmptyArrays: true } },

                {
                    $project: {
                        _id: 1,
                        name: 1,
                        avatarURL: 1,
                        currentXP: 1,
                        currentStreak: 1,
                        // lastStudyDate: 1, // Không cần thiết trả về nữa
                        currentRank: 1,
                    },
                },
            ]);

            // ✅ position chỉ khi có token
            let myPosition = null;

            if (userId) {
                const me = await User.findById(userId).lean();

                if (me) {
                    if (tab === "xp") {
                        const betterCount = await User.countDocuments({
                            $or: [
                                { currentXP: { $gt: me.currentXP } },
                                { currentXP: me.currentXP, _id: { $lt: me._id } },
                            ],
                        });
                        myPosition = betterCount + 1;
                    }

                    if (tab === "streak") {
                        // ✅ SỬA LOGIC: Chỉ tính hạng nếu streak > 0
                        if (me.currentStreak > 0) {
                            const betterCount = await User.countDocuments({
                                ...match, // currentStreak > 0
                                $or: [
                                    { currentStreak: { $gt: me.currentStreak } },
                                    { currentStreak: me.currentStreak, _id: { $lt: me._id } },
                                ],
                            });
                            myPosition = betterCount + 1;
                        } else {
                            // Nếu streak = 0 thì không có hạng
                            myPosition = null;
                        }
                    }
                }
            }

            // ✅ format output flatten: rankLevel + (top3 only) itemImageURL
            const userList = await Promise.all(
                userListRaw.map(async (u, index) => {
                    const isTop3 = index < 3;

                    const itemImageURL = isTop3 ? await getActiveSkinImageURL(u._id) : null;

                    return {
                        userID: u._id,
                        rank: index + 1,
                        name: u.name ?? "User",
                        avatarURL: u.avatarURL ?? null,
                        value: tab === "xp" ? u.currentXP : u.currentStreak,

                        rankLevel: u.currentRank?.rankLevel ?? null,
                        itemImageURL: itemImageURL ?? null,
                    };
                })
            );

            return res.status(200).json({
                userList,
                position: myPosition,
            });
        } catch (error) {
            console.error(error);
            return res.status(500).json({ message: "Server Error" });
        }
    },
};
