const mongoose = require("mongoose");
const Topic = require("../models/Topic");
const Word = require("../models/Word");
const Question = require("../models/Question");

function escapeRegex(s) {
    return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = {
    // POST /topics  (JWT required)
    async create(req, res) {
        try {
            const { topicName, description, maxLevel } = req.body || {};
            if (!topicName) return res.status(400).json({ message: "Thiếu topicName." });

            const name = String(topicName).trim();
            const existed = await Topic.findOne({ topicName: name });
            if (existed) return res.status(409).json({ message: "TopicName đã tồn tại." });

            const topic = await Topic.create({
                topicName: name,
                description: description ?? null,
                maxLevel: maxLevel != null ? Number(maxLevel) : 1,
                isActive: true,
                deletedAt: null,
            });

            return res.status(201).json({ message: "Tạo topic thành công.", topic });
        } catch (e) {
            return res.status(500).json({ message: "Lỗi server.", error: e.message });
        }
    },

    // GET /topics?page=1&pageSize=20&search=&isActive=true  (NO JWT)
    async list(req, res) {
        try {
            const { page = 1, pageSize = 20, search = "", isActive } = req.query;

            const p = Math.max(1, parseInt(page, 10) || 1);
            const ps = Math.max(1, Math.min(parseInt(pageSize, 10) || 20, 100));

            const filter = {};

            // search theo topicName (contains)
            const s = String(search || "").trim();
            if (s) filter.topicName = { $regex: escapeRegex(s), $options: "i" };

            // filter theo isActive nếu có
            if (isActive !== undefined && isActive !== "") {
                filter.isActive = String(isActive) === "true";
            }

            // nếu muốn mặc định không trả soft-deleted: bạn có thể ép deletedAt=null
            // nhưng vì bạn dùng isActive, thì soft delete sẽ isActive=false rồi.
            // filter.deletedAt = null;

            const [items, total] = await Promise.all([
                Topic.find(filter)
                    .sort({ createdAt: -1 })
                    .skip((p - 1) * ps)
                    .limit(ps)
                    .lean(),
                Topic.countDocuments(filter),
            ]);

            return res.json({
                page: p,
                pageSize: ps,
                total,
                totalPages: Math.ceil(total / ps),
                items,
            });
        } catch (e) {
            return res.status(500).json({ message: "Lỗi server.", error: e.message });
        }
    },

    // GET /topics/:topicId (NO JWT)
    async detail(req, res) {
        try {
            const { topicId } = req.params;
            const topic = await Topic.findById(topicId).lean();
            if (!topic) return res.status(404).json({ message: "Topic không tồn tại." });
            return res.json({ topic });
        } catch (e) {
            return res.status(500).json({ message: "Lỗi server.", error: e.message });
        }
    },

    // PUT /topics/:topicId  (JWT required)
    // Note: không cho sửa isActive; nếu isActive=false thì không cho sửa;
    // đổi topicName phải check trùng
    async update(req, res) {
        try {
            const { topicId } = req.params;
            const { topicName, description, maxLevel, isActive } = req.body || {};

            const topic = await Topic.findById(topicId);
            if (!topic) return res.status(404).json({ message: "Topic không tồn tại." });

            // không cho sửa nếu đã soft delete
            if (!topic.isActive) {
                return res.status(400).json({ message: "Topic đang bị vô hiệu hóa, không được sửa. Hãy restore trước." });
            }

            // không cho sửa isActive theo yêu cầu
            if (isActive !== undefined) {
                return res.status(400).json({ message: "Không được sửa isActive bằng API update. Dùng delete/restore." });
            }

            if (topicName !== undefined) {
                const name = String(topicName).trim();
                if (!name) return res.status(400).json({ message: "topicName không hợp lệ." });

                // check trùng (trừ chính nó)
                const existed = await Topic.findOne({ topicName: name, _id: { $ne: topic._id } });
                if (existed) return res.status(409).json({ message: "TopicName đã tồn tại." });

                topic.topicName = name;
            }

            if (description !== undefined) topic.description = description ?? null;
            if (maxLevel !== undefined) topic.maxLevel = Math.max(1, Number(maxLevel));

            await topic.save();
            return res.json({ message: "Cập nhật topic thành công.", topic });
        } catch (e) {
            return res.status(500).json({ message: "Lỗi server.", error: e.message });
        }
    },

    // DELETE /topics/:topicId  (JWT required)
    // Soft delete: set isActive=false, deletedAt=now
    async remove(req, res) {
        try {
            const { topicId } = req.params;
            const topic = await Topic.findById(topicId);
            if (!topic) return res.status(404).json({ message: "Topic không tồn tại." });

            if (!topic.isActive) {
                return res.status(400).json({ message: "Topic đã bị vô hiệu hóa trước đó." });
            }

            topic.isActive = false;
            topic.deletedAt = new Date();
            await topic.save();

            return res.json({ message: "Đã xóa mềm topic.", topicId: topic._id });
        } catch (e) {
            return res.status(500).json({ message: "Lỗi server.", error: e.message });
        }
    },

    // PUT /topics/:topicId/restore  (JWT required)
    // Restore: isActive=true, clear deletedAt
    async restore(req, res) {
        try {
            const { topicId } = req.params;
            const topic = await Topic.findById(topicId);
            if (!topic) return res.status(404).json({ message: "Topic không tồn tại." });

            topic.isActive = true;
            topic.deletedAt = null;
            await topic.save();

            return res.json({ message: "Restore topic thành công.", topicId: topic._id });
        } catch (e) {
            return res.status(500).json({ message: "Lỗi server.", error: e.message });
        }
    },

    // ✅ GET /topics/:topicId/quizzes?includeCounts=true  (NO JWT)
    // Trả bộ đề: "<topicName> 1..maxLevel"
    async quizzes(req, res) {
        try {
            const { topicId } = req.params;
            const includeCounts = String(req.query.includeCounts || "false") === "true";

            const topic = await Topic.findById(topicId).lean();
            if (!topic) return res.status(404).json({ message: "Topic không tồn tại." });

            const maxLevel = Math.max(1, Number(topic.maxLevel || 1));
            const quizzesBase = Array.from({ length: maxLevel }, (_, i) => {
                const lv = i + 1;
                return {
                    level: lv,
                    title: `${topic.topicName} ${lv}`,
                    topicId: topic._id,
                    mode: "TOPIC",
                };
            });

            if (!includeCounts) {
                return res.json({
                    topic: { _id: topic._id, topicName: topic.topicName, maxLevel },
                    quizzes: quizzesBase,
                });
            }

            // counts theo level (wordCount + questionCount)
            const wordAgg = await Word.aggregate([
                {
                    $match: {
                        topicId: new mongoose.Types.ObjectId(topicId),
                        isActive: true,
                        deletedAt: null,
                        level: { $gte: 1, $lte: maxLevel },
                    },
                },
                { $group: { _id: "$level", wordCount: { $sum: 1 }, wordIds: { $push: "$_id" } } },
            ]);

            const wordIdsByLevel = new Map(wordAgg.map((x) => [Number(x._id), x.wordIds]));
            const wordCountByLevel = new Map(wordAgg.map((x) => [Number(x._id), x.wordCount]));

            const quizzes = [];
            for (const qz of quizzesBase) {
                const wordIds = wordIdsByLevel.get(qz.level) || [];
                const questionCount = wordIds.length
                    ? await Question.countDocuments({ wordId: { $in: wordIds }, isActive: true, deletedAt: null })
                    : 0;

                quizzes.push({
                    ...qz,
                    wordCount: wordCountByLevel.get(qz.level) || 0,
                    questionCount,
                });
            }

            return res.json({
                topic: { _id: topic._id, topicName: topic.topicName, maxLevel },
                quizzes,
            });
        } catch (e) {
            return res.status(500).json({ message: "Lỗi server.", error: e.message });
        }
    },
};
