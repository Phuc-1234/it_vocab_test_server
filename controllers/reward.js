// controllers/rewardController.js
const mongoose = require("mongoose");
const RewardInbox = require("../models/RewardInbox");
const Inventory = require("../models/Inventory");
const Rank = require("../models/Rank");
const StreakMilestone = require("../models/StreakMilestone");
const RankReward = require("../models/RankReward");
const StreakReward = require("../models/StreakReward");

// ===== Helpers =====

/**
 * Map reward definitions (RankReward/StreakReward) vào milestone (Rank/StreakMilestone)
 * Trả rewards ở dạng DTO gọn cho FE
 */
function attachRewardsToMilestone(milestones, rewards, type) {
    const map = new Map(); // ParentID -> [rewardItemDto]

    for (const r of rewards) {
        const parentId = type === "RANK" ? String(r.rankId) : String(r.streakId);
        if (!map.has(parentId)) map.set(parentId, []);

        if (!r.itemId) continue;

        map.get(parentId).push({
            itemId: r.itemId._id,
            itemName: r.itemId.itemName,
            itemImageURL: r.itemId.itemImageURL,
            itemType: r.itemId.itemType,
            quantity: r.quantity
        });
    }

    return milestones.map(m => ({
        ...m,
        rewards: map.get(String(m._id)) || []
    }));
}

module.exports = {
    /**
     * GET /rewards/roadmap  (Public + optionalAuth)
     * Query:
     *  - type: ALL | RANK | STREAK
     *  - status: ALL | CLAIMABLE | CLAIMED | LOCKED
     *  - page, limit (default limit=10)
     *
     * Guest: trả state=LOCKED, claim=null
     * Login: enrich state + claim.inboxId theo RewardInbox
     */
    async getRoadmap(req, res) {
        try {
            const {
                type = "ALL",
                status = "ALL",
                page = 1,
                limit = 10
            } = req.query;

            const userId = req.user?.userId; // optionalAuth có token thì mới có

            const needRank = type === "ALL" || type === "RANK";
            const needStreak = type === "ALL" || type === "STREAK";

            // 1) Load definitions + reward configs
            const [ranks, streaks, rankRewards, streakRewards] = await Promise.all([
                needRank ? Rank.find({}).sort({ rankLevel: 1 }).lean() : [],
                needStreak ? StreakMilestone.find({}).sort({ dayNumber: 1 }).lean() : [],
                needRank ? RankReward.find({}).populate("itemId").lean() : [],
                needStreak ? StreakReward.find({}).populate("itemId").lean() : []
            ]);

            // 2) Build roadmap list (chỉ giữ milestone có rewards)
            const rankRoadmap = needRank
                ? attachRewardsToMilestone(ranks, rankRewards, "RANK")
                    .map(r => ({
                        _id: r._id,
                        type: "RANK",
                        level: r.rankLevel,
                        name: r.rankName,
                        rewards: r.rewards
                    }))
                    .filter(r => r.rewards?.length > 0)
                : [];

            const streakRoadmap = needStreak
                ? attachRewardsToMilestone(streaks, streakRewards, "STREAK")
                    .map(s => ({
                        _id: s._id,
                        type: "STREAK",
                        dayNumber: s.dayNumber,
                        title: s.streakTitle,
                        rewards: s.rewards
                    }))
                    .filter(s => s.rewards?.length > 0)
                : [];

            let milestones = [...rankRoadmap, ...streakRoadmap];

            // 3) Enrich state + claim theo RewardInbox (nếu login)
            if (userId) {
                const inboxQuery = { userId };
                if (type === "RANK") inboxQuery.sourceType = "RANK";
                if (type === "STREAK") inboxQuery.sourceType = "STREAK";

                const inboxes = await RewardInbox.find(inboxQuery)
                    .select("_id sourceType rankId streakId claimedAt createdAt")
                    .lean();

                // Map inbox theo milestone key
                const inboxMap = new Map(); // key: RANK_<rankId> / STREAK_<streakId>
                for (const ib of inboxes) {
                    const key =
                        ib.sourceType === "RANK"
                            ? `RANK_${String(ib.rankId)}`
                            : `STREAK_${String(ib.streakId)}`;

                    // nếu duplicate, ưu tiên cái mới hơn
                    const existed = inboxMap.get(key);
                    if (!existed || new Date(ib.createdAt) > new Date(existed.createdAt)) {
                        inboxMap.set(key, ib);
                    }
                }

                milestones = milestones.map(m => {
                    const key =
                        m.type === "RANK"
                            ? `RANK_${String(m._id)}`
                            : `STREAK_${String(m._id)}`;

                    const ib = inboxMap.get(key);

                    let state = "LOCKED";
                    if (ib) state = ib.claimedAt ? "CLAIMED" : "CLAIMABLE";

                    // DTO gọn trả về FE
                    const base = {
                        _id: m._id,
                        type: m.type,
                        ...(m.type === "RANK"
                            ? { level: m.level, name: m.name }
                            : { dayNumber: m.dayNumber, title: m.title }),
                        rewards: m.rewards || [],
                        state,
                        claim: ib ? { inboxId: ib._id } : null
                    };

                    return base;
                });

                // filter status nếu có
                if (status !== "ALL") {
                    milestones = milestones.filter(m => m.state === status);
                }
            } else {
                // Guest: state LOCKED, claim null
                milestones = milestones.map(m => ({
                    _id: m._id,
                    type: m.type,
                    ...(m.type === "RANK"
                        ? { level: m.level, name: m.name }
                        : { dayNumber: m.dayNumber, title: m.title }),
                    rewards: m.rewards || [],
                    state: "LOCKED",
                    claim: null
                }));

                // Nếu guest mà vẫn truyền status filter: chỉ có LOCKED là hợp lý
                if (status !== "ALL") {
                    milestones = milestones.filter(m => m.state === status);
                }
            }

            // 4) Pagination
            const p = Math.max(1, Number(page));
            let l = Number(limit);
            if (!Number.isFinite(l) || l <= 0) l = 10;
            l = Math.min(l, 50); // optional: giới hạn page size

            const total = milestones.length;
            const totalPages = Math.ceil(total / l);
            const start = (p - 1) * l;
            const paged = milestones.slice(start, start + l);

            return res.json({
                guest: !userId,
                pagination: { page: p, limit: l, total, totalPages },
                filter: { type, status },
                milestones: paged
            });
        } catch (e) {
            return res.status(500).json({ message: "Lỗi server.", error: e.message });
        }
    },

    /**
     * POST /rewards/inbox/:inboxId/claim  (Private)
     * Nhận item trong RewardInbox -> Chuyển về Inventory
     */
    async claimReward(req, res) {
        const session = await mongoose.startSession();
        session.startTransaction();

        try {
            const { inboxId } = req.params;
            const userId = req.user.userId;

            // 1) Tìm Inbox và lock (chặn race condition double claim)
            const inbox = await RewardInbox.findOne({ _id: inboxId, userId }).session(session);

            if (!inbox) {
                await session.abortTransaction();
                return res.status(404).json({ message: "Phần thưởng không tồn tại hoặc không chính chủ." });
            }

            if (inbox.claimedAt) {
                await session.abortTransaction();
                return res.status(400).json({ message: "Phần thưởng này đã được nhận rồi." });
            }

            // 2) Query reward definitions để biết tặng cái gì
            let itemsToGive = [];

            if (inbox.sourceType === "RANK" && inbox.rankId) {
                itemsToGive = await RankReward.find({ rankId: inbox.rankId }).session(session).lean();
            } else if (inbox.sourceType === "STREAK" && inbox.streakId) {
                itemsToGive = await StreakReward.find({ streakId: inbox.streakId }).session(session).lean();
            }

            if (!itemsToGive.length) {
                inbox.claimedAt = new Date();
                await inbox.save({ session });
                await session.commitTransaction();
                return res.json({ message: "Đã nhận (nhưng không có vật phẩm nào được cấu hình).", received: [] });
            }

            // 3) Cộng Inventory
            const receivedLog = [];

            for (const reward of itemsToGive) {
                const existingInv = await Inventory.findOne({
                    userId,
                    itemId: reward.itemId
                }).session(session);

                if (existingInv) {
                    existingInv.quantity = Number(existingInv.quantity) + Number(reward.quantity);
                    existingInv.acquireAt = new Date();
                    existingInv.sourceInboxId = inbox._id;
                    await existingInv.save({ session });
                } else {
                    await Inventory.create(
                        [{
                            userId,
                            itemId: reward.itemId,
                            quantity: reward.quantity,
                            acquireAt: new Date(),
                            sourceInboxId: inbox._id
                        }],
                        { session }
                    );
                }

                receivedLog.push({
                    itemId: reward.itemId,
                    quantity: reward.quantity
                });
            }

            // 4) Mark claimed
            inbox.claimedAt = new Date();
            await inbox.save({ session });

            await session.commitTransaction();

            return res.json({
                message: "Nhận thưởng thành công.",
                inboxId: inbox._id,
                receivedItems: receivedLog
            });
        } catch (e) {
            await session.abortTransaction();
            return res.status(500).json({ message: "Lỗi server.", error: e.message });
        } finally {
            session.endSession();
        }
    }
};
