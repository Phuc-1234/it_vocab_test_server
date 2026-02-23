const mongoose = require("mongoose");
const User = require("../models/User");
const UserActivity = require("../models/UserActivity");
const UserRankHistory = require("../models/UserRankHistory");
const QuizAttempt = require("../models/QuizAttempt");
const Word = require("../models/Word");
const Question = require("../models/Question");
const Feedback = require("../models/Feedback");
const Rank = require("../models/Rank");
/**
 * HELPER: Tạo các bước Pipeline để tính TotalXP
 * TotalXP = Sum(neededXP của các rank đã qua) + currentXP hiện tại
 */

const normalizeStatus = (s) => String(s || "").toUpperCase();

const totalXPPipeline = () => [
    {
        $lookup: {
            from: "userrankhistories", // Tên collection trong MongoDB
            let: { uid: "$_id" },
            pipeline: [
                {
                    $match: {
                        $expr: {
                            $and: [
                                { $eq: ["$userId", "$$uid"] },
                                { $eq: ["$resetReason", null] }
                            ]
                        }
                    }
                },
                {
                    $lookup: {
                        from: "ranks",
                        localField: "rankId",
                        foreignField: "_id",
                        as: "rankInfo"
                    }
                },
                { $unwind: { path: "$rankInfo", preserveNullAndEmptyArrays: true } },
                { $group: { _id: null, totalRankXP: { $sum: "$rankInfo.neededXP" } } }
            ],
            as: "rankSum"
        }
    },
    { $addFields: { rankSum: { $arrayElemAt: ["$rankSum", 0] } } },
    {
        $addFields: {
            totalXP: {
                $add: [
                    { $ifNull: ["$rankSum.totalRankXP", 0] },
                    { $ifNull: ["$currentXP", 0] }
                ]
            }
        }
    }
];

module.exports = {
    // ==============================================
    // 1. DASHBOARD OVERVIEW
    // ==============================================
    async getDashboardStats(req, res) {
        try {
            const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
            const sevenDaysAgo = new Date();
            sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
            sevenDaysAgo.setHours(0, 0, 0, 0);

            const [
                totalUsers,
                newUsersThisMonth,
                totalWords,
                totalQuestions,
                pendingFeedbacks
            ] = await Promise.all([
                User.countDocuments({ role: "USER" }),
                User.countDocuments({ role: "USER", createdAt: { $gte: startOfMonth } }),
                Word.countDocuments({ isActive: true, deletedAt: null }),
                Question.countDocuments({ isActive: true, deletedAt: null }),
                Feedback.countDocuments({ status: "open" })
            ]);

            // Thống kê user hoạt động 7 ngày qua
            const activeUsersData = await UserActivity.aggregate([
                { $match: { activityDate: { $gte: sevenDaysAgo } } },
                {
                    $group: {
                        _id: { $dateToString: { format: "%d/%m", date: "$activityDate" } },
                        count: { $sum: 1 }
                    }
                },
                { $sort: { "_id": 1 } }
            ]);

            // Hoạt động gần đây từ Quiz
            const recentQuizzes = await QuizAttempt.find({ isGuest: false })
                .sort({ startedAt: -1 })
                .limit(5)
                .populate("userId", "name email avatarURL");

            const recentActivities = recentQuizzes.map(quiz => ({
                id: quiz._id,
                action: `Người dùng ${quiz.userId?.name || 'Thành viên'} vừa hoàn thành bài Quiz.`,
                time: quiz.startedAt,
                xpEarned: quiz.earnedXP
            }));

            return res.json({
                stats: { totalUsers, newUsersThisMonth, totalWords, totalQuestions, pendingFeedbacks },
                charts: { activeUsersChart: activeUsersData },
                recentActivities
            });
        } catch (error) {
            console.error("Dashboard Stats Error:", error);
            return res.status(500).json({ message: "Lỗi lấy dữ liệu Dashboard.", error: error.message });
        }
    },

    // ==============================================
    // 2. QUẢN LÝ NGƯỜI DÙNG (USERS PAGE)
    // ==============================================
    async getUsers(req, res) {
        try {
            const page = parseInt(req.query.page) || 1;
            const limit = parseInt(req.query.limit) || 10;
            const search = req.query.search || "";
            const skip = (page - 1) * limit;

            const query = { role: "USER" };
            if (search) {
                query.$or = [
                    { name: { $regex: search, $options: "i" } },
                    { email: { $regex: search, $options: "i" } }
                ];
            }

            // Truy vấn lấy danh sách User kèm TotalXP cộng dồn
            const usersAggregate = await User.aggregate([
                { $match: query },
                ...totalXPPipeline(),
                { $sort: { totalXP: -1 } },
                { $skip: skip },
                { $limit: limit },
                {
                    $project: {
                        name: 1,
                        email: 1,
                        avatarURL: 1,
                        status: 1,
                        createdAt: 1,
                        currentStreak: 1,
                        totalXP: 1
                    }
                }
            ]);

            const totalUsers = await User.countDocuments(query);
            const userIds = usersAggregate.map(u => u._id);

            // Lấy thêm Rank hiện tại (Level) và số lượng Quiz
            const [rankHistories, quizCounts, activeCount, bannedCount] = await Promise.all([
                UserRankHistory.find({ userId: { $in: userIds }, isCurrent: true }).populate("rankId", "rankLevel"),
                QuizAttempt.aggregate([
                    { $match: { userId: { $in: userIds }, isGuest: false } },
                    { $group: { _id: "$userId", count: { $sum: 1 } } }
                ]),
                User.countDocuments({ role: "USER", status: "ACTIVE" }),
                User.countDocuments({ role: "USER", status: "BANNED" })
            ]);

            const formattedUsers = usersAggregate.map(user => {
                const rankObj = rankHistories.find(r => String(r.userId) === String(user._id));
                const quizObj = quizCounts.find(q => String(q._id) === String(user._id));

                return {
                    id: user._id,
                    name: user.name || "N/A",
                    email: user.email,
                    avatarURL: user.avatarURL,
                    xp: user.totalXP, // XP cộng dồn thực tế
                    streak: user.currentStreak,
                    status: user.status,
                    createdAt: user.createdAt,
                    level: rankObj?.rankId?.rankLevel || 1,
                    quizCount: quizObj?.count || 0
                };
            });

            return res.json({
                miniStats: { totalUsers, activeUsers: activeCount, bannedUsers: bannedCount },
                pagination: { total: totalUsers, page, limit, totalPages: Math.ceil(totalUsers / limit) },
                users: formattedUsers
            });
        } catch (error) {
            console.error("Get Users Error:", error);
            return res.status(500).json({ message: "Lỗi lấy danh sách người dùng." });
        }
    },

    async updateUserStatus(req, res) {
        try {
            const { userId } = req.params;
            const { status } = req.body;

            if (!["ACTIVE", "BANNED"].includes(status)) {
                return res.status(400).json({ message: "Trạng thái không hợp lệ." });
            }

            const user = await User.findById(userId);
            if (!user) return res.status(404).json({ message: "Không tìm thấy người dùng." });
            if (user.role === "ADMIN") return res.status(403).json({ message: "Không thể khóa Admin." });

            user.status = status;
            if (status === "BANNED") user.refreshTokenHash = null;

            await user.save();
            return res.json({ message: `Đã cập nhật trạng thái thành ${status}.`, status: user.status });
        } catch (error) {
            return res.status(500).json({ message: "Lỗi cập nhật trạng thái." });
        }
    },

    // ==============================================
    // 3. LEADERBOARDS (Đồng bộ với Mobile App)
    // ==============================================
    async getLeaderboards(req, res) {
        try {
            // 3.1 Top XP & Rank (Dùng Total XP)
            const topXPData = await User.aggregate([
                { $match: { role: "USER", status: "ACTIVE" } },
                ...totalXPPipeline(),
                { $sort: { totalXP: -1 } },
                { $limit: 5 },

                // đảm bảo lấy được avatarURL (nếu totalXPPipeline có $project thì càng cần đoạn này)
                { $project: { name: 1, avatarURL: 1, totalXP: 1 } },

                {
                    $lookup: {
                        from: "userrankhistories",
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
                            { $lookup: { from: "ranks", localField: "rankId", foreignField: "_id", as: "r" } },
                            { $unwind: "$r" },
                        ],
                        as: "curr",
                    },
                },
                {
                    $addFields: {
                        currentRankLevel: { $ifNull: [{ $arrayElemAt: ["$curr.r.rankLevel", 0] }, 1] },
                    },
                },
            ]);

            // 3.2 Top Streak
            const topStreak = await User.find({ role: "USER", status: "ACTIVE" })
                .sort({ currentStreak: -1 })
                .limit(5)
                .select("name currentStreak avatarURL");

            // 3.3 Top Quiz
            const topQuiz = await QuizAttempt.aggregate([
                { $match: { isGuest: false } },
                { $group: { _id: "$userId", count: { $sum: 1 } } },
                { $sort: { count: -1 } },
                { $limit: 5 },
                { $lookup: { from: "users", localField: "_id", foreignField: "_id", as: "u" } },
                { $unwind: "$u" },
                { $project: { name: "$u.name", avatarURL: "$u.avatarURL", count: 1 } }, // ✅ thêm avatarURL
            ]);

            return res.json({
                topRank: topXPData.map((u) => ({
                    name: u.name || "User",
                    avatarURL: u.avatarURL || "",
                    value: `Cấp độ ${u.currentRankLevel}`,
                })),

                topXP: topXPData.map((u) => ({
                    name: u.name || "User",
                    avatarURL: u.avatarURL || "",
                    value: `${Number(u.totalXP || 0).toLocaleString()} XP`,
                })),

                topTask: topQuiz.map((u) => ({
                    name: u.name || "User",
                    avatarURL: u.avatarURL || "",
                    value: `${u.count} Bài Quiz`,
                })),

                topSpirit: topStreak.map((u) => ({
                    name: u.name || "User",
                    avatarURL: u.avatarURL || "",
                    value: `${u.currentStreak} Ngày`,
                })),
            });
        } catch (error) {
            console.error("Leaderboards Error:", error);
            return res.status(500).json({ message: "Lỗi lấy bảng xếp hạng." });
        }
    },
    // GET /admin/feedbacks?page=&limit=&search=&status=
    async getFeedbacks(req, res) {
        try {
            const page = parseInt(req.query.page) || 1;
            const limit = parseInt(req.query.limit) || 10;
            const search = String(req.query.search || "").trim();
            const status = String(req.query.status || "all").trim().toLowerCase();
            const skip = (page - 1) * limit;

            // map UI filter -> db enum
            // UI: all | new | in-progress | completed
            // DB: open | closed | resolved
            const match = {};
            if (status !== "all") {
                if (status === "new") match.status = "open";
                else if (status === "in-progress") match.status = "closed";     // ✅ bạn đang dùng closed như "đang xử lý"
                else if (status === "completed") match.status = "resolved";
            }

            // search on feedback fields first
            if (search) {
                match.$or = [
                    { title: { $regex: search, $options: "i" } },
                    { reason: { $regex: search, $options: "i" } },
                    { content: { $regex: search, $options: "i" } },
                ];
            }

            // query list with user join
            const pipeline = [
                { $match: match },
                { $sort: { createdAt: -1 } },
                {
                    $lookup: {
                        from: "users",
                        localField: "createdBy",
                        foreignField: "_id",
                        as: "u",
                    },
                },
                { $unwind: { path: "$u", preserveNullAndEmptyArrays: true } },
            ];

            // nếu có search: mở rộng search sang user.name/email luôn
            if (search) {
                pipeline.push({
                    $match: {
                        $or: [
                            ...(match.$or || []),
                            { "u.name": { $regex: search, $options: "i" } },
                            { "u.email": { $regex: search, $options: "i" } },
                        ],
                    },
                });
            }

            // count total sau khi join (vì search có thể lọc theo user)
            const countPipeline = [...pipeline, { $count: "total" }];

            // paging
            pipeline.push({ $skip: skip });
            pipeline.push({ $limit: limit });

            // select fields
            pipeline.push({
                $project: {
                    title: 1,
                    reason: 1,
                    content: 1,
                    status: 1,
                    createdAt: 1,
                    createdBy: 1,
                    user: {
                        _id: "$u._id",
                        name: "$u.name",
                        email: "$u.email",
                        avatarURL: "$u.avatarURL",
                    },
                },
            });

            const [countArr, rows, statsArr] = await Promise.all([
                Feedback.aggregate(countPipeline),
                Feedback.aggregate(pipeline),
                Feedback.aggregate([
                    {
                        $group: {
                            _id: null,
                            total: { $sum: 1 },
                            open: { $sum: { $cond: [{ $eq: ["$status", "open"] }, 1, 0] } },
                            closed: { $sum: { $cond: [{ $eq: ["$status", "closed"] }, 1, 0] } },
                            resolved: { $sum: { $cond: [{ $eq: ["$status", "resolved"] }, 1, 0] } },
                        },
                    },
                    { $project: { _id: 0, total: 1, open: 1, closed: 1, resolved: 1 } },
                ]),
            ]);

            const total = countArr?.[0]?.total || 0;
            const statsDb = statsArr?.[0] || { total: 0, open: 0, closed: 0, resolved: 0 };

            return res.json({
                stats: {
                    total: statsDb.total,
                    open: statsDb.open,
                    inProgress: statsDb.closed,     // ✅ UI expects inProgress
                    resolved: statsDb.resolved,
                },
                pagination: {
                    total,
                    page,
                    limit,
                    totalPages: Math.max(1, Math.ceil(total / limit)),
                },
                feedbacks: rows.map((f) => ({
                    id: f._id,
                    title: f.title || "",
                    reason: f.reason || "",
                    content: f.content || "",
                    status: f.status || "open",
                    createdAt: f.createdAt,
                    createdBy: f.createdBy,
                    user: f.user?._id
                        ? {
                            id: f.user._id,
                            name: f.user.name || "",
                            email: f.user.email || "",
                            avatarURL: f.user.avatarURL || "",
                        }
                        : null,
                })),
            });
        } catch (error) {
            console.error("Get Feedbacks Error:", error);
            return res.status(500).json({ message: "Lỗi lấy danh sách góp ý." });
        }
    },

    // PUT /admin/feedbacks/:id/status  body: { status: "open"|"in_progress"|"resolved" }
    async updateFeedbackStatus(req, res) {
        try {
            const { id } = req.params;
            const status = normalizeStatus(req.body?.status);

            const allowed = ["OPEN", "IN_PROGRESS", "RESOLVED"];
            if (!allowed.includes(status)) {
                return res.status(400).json({ message: "Trạng thái không hợp lệ." });
            }

            const nextStatus =
                status === "OPEN" ? "open" : status === "IN_PROGRESS" ? "closed" : "resolved";

            const updated = await Feedback.findByIdAndUpdate(
                id,
                { status: nextStatus },
                { new: true }
            )
                .populate("createdBy", "name email avatarURL")
                .lean();

            if (!updated) return res.status(404).json({ message: "Không tìm thấy góp ý." });

            return res.json({
                message: "Cập nhật trạng thái thành công.",
                status: updated.status,
                user: updated.createdBy
                    ? {
                        id: updated.createdBy._id,
                        name: updated.createdBy.name || "",
                        email: updated.createdBy.email || "",
                        avatarURL: updated.createdBy.avatarURL || "",
                    }
                    : null,
            });
        } catch (error) {
            console.error("Update Feedback Status Error:", error);
            return res.status(500).json({ message: "Lỗi cập nhật trạng thái góp ý." });
        }
    },
};