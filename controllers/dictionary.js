const mongoose = require("mongoose");

const Word = require("../models/Word");
const Topic = require("../models/Topic");

const PinnedWord = require("../models/PinnedWord");
const WordNote = require("../models/WordNote");

function toInt(v, def) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}

function normalizeQ(q) {
    if (q == null) return "";
    if (typeof q !== "string") return "";
    return q.trim();
}

function isValidObjectId(id) {
    return mongoose.Types.ObjectId.isValid(String(id));
}

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = {
    // GET /dictionary/words?page=1&pageSize=20&topicId=all&include=topics
    // GET /dictionary/words?q=book&topicId=<id>&page=1&pageSize=20
    // optionalAuth: nếu có JWT thì trả thêm isPinned + note
    async listWords(req, res) {
        try {
            const page = toInt(req.query.page, 1);
            const pageSize = toInt(req.query.pageSize, 20);
            const topicId = String(req.query.topicId ?? "all");
            const include = String(req.query.include ?? "");
            const q = normalizeQ(req.query.q);

            const filter = { deletedAt: null, isActive: true };

            if (topicId && topicId !== "all") {
                if (!isValidObjectId(topicId)) {
                    return res.status(400).json({ message: "topicId không hợp lệ." });
                }
                filter.topicId = new mongoose.Types.ObjectId(topicId);
            }

            if (q) {
                const rx = new RegExp(escapeRegex(q), "i");
                filter.$or = [
                    { word: rx },
                    { meaningEN: rx },
                    { meaningVN: rx },
                    { standFor: rx },
                    { example: rx },
                ];
            }

            const skip = (page - 1) * pageSize;

            // include topics (cho lần đầu vào app)
            const includeTopics = include
                .split(",")
                .map((s) => s.trim())
                .includes("topics");

            const wordsQuery = Word.find(filter)
                // ✅ FIX 1: Thêm _id để đảm bảo thứ tự luôn cố định, không bao giờ bị nhảy lung tung
                .sort({ createdAt: -1, _id: 1 })
                .skip(skip)
                .limit(pageSize)
                .select("word pronunciation meaningEN meaningVN standFor example level topicId")
                .populate({ path: "topicId", select: "topicName", match: { deletedAt: null, isActive: true } })
                .lean();

            const countQuery = Word.countDocuments(filter);

            const topicsQuery = includeTopics
                ? Topic.find({ deletedAt: null, isActive: true })
                    .sort({ createdAt: -1 })
                    .select("topicName description maxLevel")
                    .lean()
                : Promise.resolve(null);

            const [words, total, topics] = await Promise.all([wordsQuery, countQuery, topicsQuery]);

            // optional auth enrich
            let pinnedMap = new Map();
            const userId = req.user?.userId;

            if (userId && isValidObjectId(userId) && words.length > 0) {
                const wordIds = words.map((w) => w._id);
                const pins = await PinnedWord.find({ userId, wordId: { $in: wordIds } })
                    .select("wordId")
                    .lean();
                pinnedMap = new Map(pins.map((p) => [String(p.wordId), true]));
            }

            const pickDefinition = (w) =>
                (w.meaningEN && w.meaningEN.trim()) ||
                (w.meaningVN && w.meaningVN.trim()) ||
                (w.standFor && w.standFor.trim()) ||
                (w.example && w.example.trim()) ||
                "";

            // trả đúng item minimal như UI
            const items = words.map((w) => {
                // Nếu topic bị null (do đã xoá hoặc populate fail), gán giá trị mặc định
                const categoryName = (w.topicId && w.topicId.topicName) ? w.topicId.topicName : "Uncategorized";

                return {
                    id: String(w._id),
                    term: w.word,
                    phonetic: w.pronunciation ?? "",
                    definition: pickDefinition(w),
                    level: w.level ?? 1,
                    category: categoryName, // Luôn có giá trị
                    isPinned: pinnedMap.get(String(w._id)) === true,
                };
            });

            return res.json({
                message: "Lấy danh sách từ vựng thành công.",
                page,
                pageSize,
                total,
                totalPages: Math.ceil(total / pageSize),
                items,
                ...(includeTopics ? { topics: topics ?? [] } : {}),
            });
        } catch (e) {
            return res.status(500).json({ message: "Lỗi server.", error: e.message });
        }
    },


    // GET /dictionary/words/:wordId
    // optionalAuth: trả về isPinned + note luôn
    async getWordDetail(req, res) {
        try {
            const { wordId } = req.params;

            if (!isValidObjectId(wordId)) {
                return res.status(400).json({ message: "wordId không hợp lệ." });
            }

            // 1. Dùng .populate() để lấy thông tin từ bảng Topic
            // Giả sử field trong Word Model là 'topicId' và field tên trong Topic Model là 'name'
            const word = await Word.findOne({
                _id: wordId,
                deletedAt: null,
                isActive: true,
            })
                .populate("topicId", "topicName") // Chỉ lấy field 'topicName' từ Topic
                .lean();

            if (!word) return res.status(404).json({ message: "Không tìm thấy từ vựng." });

            const userId = req.user?.userId;
            let isPinned = false;
            let note = null;

            if (userId && isValidObjectId(userId)) {
                const [pin, noteDoc] = await Promise.all([
                    PinnedWord.findOne({ userId, wordId }).select("_id").lean(),
                    WordNote.findOne({ userId, wordId }).select("note").lean(),
                ]);
                isPinned = !!pin;
                note = noteDoc?.note ?? null;
            }

            // 2. Xử lý dữ liệu topicName trước khi trả về
            // Vì dùng lean() và populate, word.topicId sẽ là một object { _id: "...", name: "..." }
            const topicName = word.topicId?.topicName || "";
            const topicIdStr = word.topicId?._id || word.topicId; // Lấy lại ID dạng string nếu cần

            return res.json({
                message: "Lấy chi tiết từ vựng thành công.",
                word: {
                    ...word,
                    topicId: topicIdStr, // Đảm bảo topicId vẫn là string (nếu frontend cần)
                    topicName: topicName, // ✅ Thêm topicName vào response
                    isPinned,
                    note,
                },
            });
        } catch (e) {
            console.error(e); // Nên log lỗi ra console để debug
            return res.status(500).json({ message: "Lỗi server.", error: e.message });
        }
    },

    // PUT /dictionary/words/:wordId/pin (JWT required)
    async pinWord(req, res) {
        try {
            const userId = req.user?.userId;
            const { wordId } = req.params;

            if (!isValidObjectId(userId)) {
                return res.status(401).json({ message: "Vui lòng đăng nhập để tiếp tục." });
            }
            if (!isValidObjectId(wordId)) {
                return res.status(400).json({ message: "wordId không hợp lệ." });
            }

            const exists = await Word.exists({
                _id: wordId,
                deletedAt: null,
                isActive: true,
            });
            if (!exists) return res.status(404).json({ message: "Không tìm thấy từ vựng." });

            await PinnedWord.updateOne(
                { userId, wordId },
                { $setOnInsert: { userId, wordId } },
                { upsert: true }
            );

            return res.json({ message: "Ghim từ vựng thành công." });
        } catch (e) {
            if (String(e?.code) === "11000") {
                return res.json({ message: "Ghim từ vựng thành công." });
            }
            return res.status(500).json({ message: "Lỗi server.", error: e.message });
        }
    },

    // DELETE /dictionary/words/:wordId/pin (JWT required)
    async unpinWord(req, res) {
        try {
            const userId = req.user?.userId;
            const { wordId } = req.params;

            if (!isValidObjectId(userId)) {
                return res.status(401).json({ message: "Vui lòng đăng nhập để tiếp tục." });
            }
            if (!isValidObjectId(wordId)) {
                return res.status(400).json({ message: "wordId không hợp lệ." });
            }

            await PinnedWord.deleteOne({ userId, wordId });
            return res.json({ message: "Huỷ ghim từ vựng thành công." });
        } catch (e) {
            return res.status(500).json({ message: "Lỗi server.", error: e.message });
        }
    },

    // GET /dictionary/pinned?page=1&pageSize=20 (JWT required)
    async listPinnedWords(req, res) {
        try {
            const userId = req.user?.userId;

            if (!isValidObjectId(userId)) {
                return res.status(401).json({ message: "Vui lòng đăng nhập để tiếp tục." });
            }

            const page = toInt(req.query.page, 1);
            const pageSize = toInt(req.query.pageSize, 20);
            const skip = (page - 1) * pageSize;

            const [pins, total] = await Promise.all([
                PinnedWord.find({ userId })
                    .sort({ createdAt: -1, _id: 1 })
                    .skip(skip)
                    .limit(pageSize)
                    .populate({
                        path: "wordId",
                        match: { deletedAt: null, isActive: true },
                    })
                    .lean(),
                PinnedWord.countDocuments({ userId }),
            ]);

            // gắn note
            const wordIds = pins.map((p) => p.wordId?._id).filter(Boolean);
            const notes = wordIds.length
                ? await WordNote.find({ userId, wordId: { $in: wordIds } })
                    .select("wordId note")
                    .lean()
                : [];
            const noteMap = new Map(notes.map((n) => [String(n.wordId), n.note]));

            const items = pins
                .filter((p) => p.wordId) // word bị xoá mềm/ inactive sẽ bị match null
                .map((p) => ({
                    pinnedId: p._id,
                    createdAt: p.createdAt,
                    word: {
                        ...p.wordId,
                        isPinned: true,
                        note: noteMap.get(String(p.wordId._id)) ?? null,
                    },
                }));

            return res.json({
                message: "Lấy danh sách từ vựng đã ghim thành công.",
                page,
                pageSize,
                total,
                totalPages: Math.ceil(total / pageSize),
                items,
            });
        } catch (e) {
            return res.status(500).json({ message: "Lỗi server.", error: e.message });
        }
    },

    // PUT /dictionary/words/:wordId/note (JWT required)
    // Body: { note: "content" } -> Nếu note rỗng hoặc space -> DELETE
    async upsertNote(req, res) {
        try {
            const userId = req.user?.userId;
            const { wordId } = req.params;

            if (!isValidObjectId(userId)) {
                return res.status(401).json({ message: "Vui lòng đăng nhập để tiếp tục." });
            }
            if (!isValidObjectId(wordId)) {
                return res.status(400).json({ message: "wordId không hợp lệ." });
            }

            const noteRaw = req.body?.note;
            if (typeof noteRaw !== "string") {
                return res.status(400).json({ message: "note phải là string." });
            }

            const note = noteRaw.trim();

            // ✅ LOGIC MỚI: Nếu note rỗng -> Xoá note cũ (nếu có)
            if (!note) {
                await WordNote.deleteOne({ userId, wordId });
                return res.json({
                    message: "Đã xoá ghi chú.",
                    note: null
                });
            }

            // Nếu có nội dung -> Kiểm tra và Lưu
            if (note.length > 2000) {
                return res.status(400).json({ message: "note tối đa 2000 ký tự." });
            }

            const exists = await Word.exists({
                _id: wordId,
                deletedAt: null,
                isActive: true,
            });
            if (!exists) return res.status(404).json({ message: "Không tìm thấy từ vựng." });

            const doc = await WordNote.findOneAndUpdate(
                { userId, wordId },
                { $set: { note } },
                { upsert: true, new: true, setDefaultsOnInsert: true, lean: true }
            );

            return res.json({
                message: "Lưu ghi chú thành công.",
                note: {
                    noteId: doc._id,
                    wordId: doc.wordId,
                    userId: doc.userId,
                    note: doc.note,
                    createdAt: doc.createdAt,
                    updatedAt: doc.updatedAt,
                },
            });
        } catch (e) {
            return res.status(500).json({ message: "Lỗi server.", error: e.message });
        }
    },
};
