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

// ✅ helper: calculate total XP for a user (sum of neededXP from all non-reset rank history)
async function calculateTotalXP(userId) {
    const uid = typeof userId === "string" ? new mongoose.Types.ObjectId(userId) : userId;

    const result = await UserRankHistory.aggregate([
        { $match: { userId: uid, resetReason: null } },
        {
            $lookup: {
                from: Rank.collection.name,
                localField: "rankId",
                foreignField: "_id",
                as: "rank",
            },
        },
        { $unwind: { path: "$rank", preserveNullAndEmptyArrays: true } },
        { $group: { _id: null, totalXP: { $sum: "$rank.neededXP" } } },
    ]).exec();

    return result?.[0]?.totalXP ?? 0;
}

module.exports = {
    async getLeaderboard(req, res) {
        try {
            const { tab } = req.params;
            const userId = req.user?.userId || null;

            if (!["xp", "streak"].includes(tab)) {
                return res.status(400).json({ message: "Invalid tab parameter" });
            }

            // ✅ chỉ lấy user ACTIVE
            const matchBase = { status: "ACTIVE" };

            const pipeline = [{ $match: matchBase }];

            if (tab === "xp") {
                pipeline.push(
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
                                                { $eq: ["$resetReason", null] },
                                            ],
                                        },
                                    },
                                },
                                {
                                    $lookup: {
                                        from: Rank.collection.name,
                                        localField: "rankId",
                                        foreignField: "_id",
                                        as: "rank",
                                    },
                                },
                                { $unwind: { path: "$rank", preserveNullAndEmptyArrays: true } },
                                { $group: { _id: null, totalXP: { $sum: "$rank.neededXP" } } },
                            ],
                            as: "rankHistorySummary",
                        },
                    },
                    { $unwind: { path: "$rankHistorySummary", preserveNullAndEmptyArrays: true } },
                    { $addFields: { totalXP: { $ifNull: ["$rankHistorySummary.totalXP", 0] } } },
                    { $sort: { totalXP: -1, _id: 1 } },
                    { $limit: 10 },
                );
            } else {
                // ✅ streak: chỉ cần streak cao nhất, không check ngày
                pipeline.push(
                    { $match: { currentStreak: { $gt: 0 } } },
                    { $sort: { currentStreak: -1, _id: 1 } },
                    { $limit: 10 },
                );
            }

            // lookup current rank history -> rankLevel (để sau limit cho nhẹ)
            pipeline.push(
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
                            { $project: { _id: 0, rankLevel: "$rank.rankLevel" } },
                        ],
                        as: "currentRank",
                    },
                },
                { $unwind: { path: "$currentRank", preserveNullAndEmptyArrays: true } },
            );

            // ✅ Project: KHÔNG mix include/exclude. Chỉ include các field cần.
            // totalXP/effectiveStreak không cần "0/1 theo tab" ở đây.
            pipeline.push({
                $project: {
                    _id: 1,
                    name: 1,
                    avatarURL: 1,
                    currentStreak: 1,
                    totalXP: 1, // xp tab thì có, streak tab thì field có thể undefined -> ok
                    currentRank: 1,
                },
            });

            const userListRaw = await User.aggregate(pipeline);

            // ✅ position chỉ khi có token
            let myPosition = null;

            if (userId) {
                const me = await User.findOne({ _id: userId, status: "ACTIVE" }).lean();

                if (me) {
                    if (tab === "streak") {
                        if (Number(me.currentStreak || 0) > 0) {
                            const betterCount = await User.countDocuments({
                                status: "ACTIVE",
                                currentStreak: { $gt: 0 },
                                $or: [
                                    { currentStreak: { $gt: me.currentStreak } },
                                    { currentStreak: me.currentStreak, _id: { $lt: me._id } },
                                ],
                            });
                            myPosition = betterCount + 1;
                        } else {
                            myPosition = null;
                        }
                    }

                    if (tab === "xp") {
                        const myTotalXP = await calculateTotalXP(userId);

                        // (Giữ logic của bạn) nhưng lọc ACTIVE + chỉ lấy _id cho nhẹ hơn
                        const allUsers = await User.find({ status: "ACTIVE" }).select("_id").lean();

                        let betterCount = 0;
                        for (const u of allUsers) {
                            const userTotalXP = await calculateTotalXP(u._id);
                            if (
                                userTotalXP > myTotalXP ||
                                (userTotalXP === myTotalXP && String(u._id) < String(me._id))
                            ) {
                                betterCount++;
                            }
                        }
                        myPosition = betterCount + 1;
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
                        value: tab === "xp" ? (u.totalXP ?? 0) : (u.currentStreak ?? 0),
                        rankLevel: u.currentRank?.rankLevel ?? null,
                        itemImageURL: itemImageURL ?? null,
                    };
                }),
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
