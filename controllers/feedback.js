const mongoose = require("mongoose");
const Feedback = require("../models/Feedback");

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

function isAdmin(req) {
    const role = String(req.user?.role || "").toUpperCase();
    return role === "ADMIN";
}

const ALLOWED_STATUS = ["open", "resolved", "closed"];

module.exports = {
    // =========================
    // ADMIN: GET /feedback/admin?page=1&pageSize=20&reason=all&status=all&q=
    // =========================
    async adminListFeedback(req, res) {
        try {
            const page = toInt(req.query.page, 1);
            const pageSize = toInt(req.query.pageSize, 20);
            const reason = String(req.query.reason ?? "all").trim();
            const status = String(req.query.status ?? "all").trim();
            const q = normalizeQ(req.query.q);

            const filter = {};

            if (reason && reason !== "all") filter.reason = reason;
            if (status && status !== "all") {
                if (!ALLOWED_STATUS.includes(status)) {
                    return res.status(400).json({ message: "status không hợp lệ." });
                }
                filter.status = status;
            }

            if (q) {
                const rx = new RegExp(escapeRegex(q), "i");
                filter.$or = [{ title: rx }, { content: rx }, { reason: rx }];
            }

            const skip = (page - 1) * pageSize;

            const itemsQuery = Feedback.find(filter)
                .sort({ createdAt: -1, _id: 1 })
                .skip(skip)
                .limit(pageSize)
                .populate({
                    path: "createdBy",
                    select: "fullName name username email role",
                })
                .lean();

            const countQuery = Feedback.countDocuments(filter);

            const [items, total] = await Promise.all([itemsQuery, countQuery]);

            return res.json({
                message: "Lấy danh sách feedback thành công.",
                page,
                pageSize,
                total,
                totalPages: Math.ceil(total / pageSize),
                items: items.map((f) => ({
                    id: String(f._id),
                    title: f.title,
                    reason: f.reason,
                    content: f.content,
                    status: f.status,
                    createdAt: f.createdAt,
                    createdBy: f.createdBy
                        ? {
                            id: String(f.createdBy._id),
                            fullName: f.createdBy.fullName ?? f.createdBy.name ?? f.createdBy.username ?? "",
                            email: f.createdBy.email ?? "",
                            role: f.createdBy.role ?? "",
                        }
                        : null,
                })),
            });
        } catch (e) {
            return res.status(500).json({ message: "Lỗi server.", error: e.message });
        }
    },

    // =========================
    // USER: GET /feedback/my?page=1&pageSize=20&status=all
    // =========================
    async getMyFeedback(req, res) {
        try {
            const userId = req.user?.userId;

            if (!isValidObjectId(userId)) {
                return res.status(401).json({ message: "Vui lòng đăng nhập để tiếp tục." });
            }

            const page = toInt(req.query.page, 1);
            const pageSize = toInt(req.query.pageSize, 20);
            const status = String(req.query.status ?? "all").trim();

            const filter = { createdBy: new mongoose.Types.ObjectId(userId) };

            if (status && status !== "all") {
                if (!ALLOWED_STATUS.includes(status)) {
                    return res.status(400).json({ message: "status không hợp lệ." });
                }
                filter.status = status;
            }

            const skip = (page - 1) * pageSize;

            const [items, total] = await Promise.all([
                Feedback.find(filter)
                    .sort({ createdAt: -1, _id: 1 })
                    .skip(skip)
                    .limit(pageSize)
                    .lean(),
                Feedback.countDocuments(filter),
            ]);

            return res.json({
                message: "Lấy feedback của bạn thành công.",
                page,
                pageSize,
                total,
                totalPages: Math.ceil(total / pageSize),
                items: items.map((f) => ({
                    id: String(f._id),
                    title: f.title,
                    reason: f.reason,
                    content: f.content,
                    status: f.status,
                    createdAt: f.createdAt,
                })),
            });
        } catch (e) {
            return res.status(500).json({ message: "Lỗi server.", error: e.message });
        }
    },

    // =========================
    // USER: POST /feedback
    // Body: { title, reason, content }
    // =========================
    async createFeedback(req, res) {
        try {
            const userId = req.user?.userId;

            if (!isValidObjectId(userId)) {
                return res.status(401).json({ message: "Vui lòng đăng nhập để tiếp tục." });
            }

            const { title, reason, content } = req.body || {};

            if (typeof title !== "string" || !title.trim()) {
                return res.status(400).json({ message: "title là bắt buộc." });
            }
            if (typeof reason !== "string" || !reason.trim()) {
                return res.status(400).json({ message: "reason là bắt buộc." });
            }
            if (typeof content !== "string" || !content.trim()) {
                return res.status(400).json({ message: "content là bắt buộc." });
            }

            const doc = await Feedback.create({
                title: title.trim(),
                reason: reason.trim(),
                content: content.trim(),
                createdBy: new mongoose.Types.ObjectId(userId),
                // status default "open"
            });

            return res.status(201).json({
                message: "Gửi feedback thành công.",
                feedback: {
                    id: String(doc._id),
                    title: doc.title,
                    reason: doc.reason,
                    content: doc.content,
                    status: doc.status,
                    createdAt: doc.createdAt,
                },
            });
        } catch (e) {
            return res.status(500).json({ message: "Lỗi server.", error: e.message });
        }
    },

    // =========================
    // PUT /feedback/:feedbackId
    // - USER: chỉ sửa title/reason/content của feedback mình tạo, CHỈ KHI status = open
    // - ADMIN: chỉ được đổi status (resolved/closed/open)
    // =========================
    async updateFeedback(req, res) {
        try {
            const userId = req.user?.userId;
            const { feedbackId } = req.params;

            if (!isValidObjectId(userId)) {
                return res.status(401).json({ message: "Vui lòng đăng nhập để tiếp tục." });
            }
            if (!isValidObjectId(feedbackId)) {
                return res.status(400).json({ message: "feedbackId không hợp lệ." });
            }

            const fb = await Feedback.findById(feedbackId).lean();
            if (!fb) return res.status(404).json({ message: "Không tìm thấy feedback." });

            // ADMIN: chỉ chỉnh status
            if (isAdmin(req)) {
                const status = String(req.body?.status ?? "").trim();
                if (!status) return res.status(400).json({ message: "status là bắt buộc." });
                if (!ALLOWED_STATUS.includes(status)) {
                    return res.status(400).json({ message: "status không hợp lệ." });
                }

                await Feedback.updateOne({ _id: feedbackId }, { $set: { status } });

                return res.json({ message: "Cập nhật trạng thái feedback thành công." });
            }

            // USER: chỉ chỉnh nội dung của mình, và không được sửa khi resolved/closed
            if (String(fb.createdBy) !== String(userId)) {
                return res.status(403).json({ message: "Bạn không có quyền sửa feedback này." });
            }

            if (fb.status === "resolved" || fb.status === "closed") {
                return res
                    .status(400)
                    .json({ message: "Không thể sửa khi feedback đã resolved/closed." });
            }

            const payload = {};
            if (req.body?.title != null) {
                if (typeof req.body.title !== "string" || !req.body.title.trim()) {
                    return res.status(400).json({ message: "title không hợp lệ." });
                }
                payload.title = req.body.title.trim();
            }
            if (req.body?.reason != null) {
                if (typeof req.body.reason !== "string" || !req.body.reason.trim()) {
                    return res.status(400).json({ message: "reason không hợp lệ." });
                }
                payload.reason = req.body.reason.trim();
            }
            if (req.body?.content != null) {
                if (typeof req.body.content !== "string" || !req.body.content.trim()) {
                    return res.status(400).json({ message: "content không hợp lệ." });
                }
                payload.content = req.body.content.trim();
            }

            // chặn user chỉnh status lén
            if (req.body?.status != null) {
                return res.status(403).json({ message: "Bạn không có quyền chỉnh status." });
            }

            if (Object.keys(payload).length === 0) {
                return res.status(400).json({ message: "Không có dữ liệu để cập nhật." });
            }

            await Feedback.updateOne({ _id: feedbackId }, { $set: payload });

            return res.json({ message: "Cập nhật feedback thành công." });
        } catch (e) {
            return res.status(500).json({ message: "Lỗi server.", error: e.message });
        }
    },

    // =========================
    // DELETE /feedback/:feedbackId
    // - USER: chỉ xoá feedback mình tạo, CHỈ KHI status = open
    // - ADMIN: xoá bất kỳ
    // =========================
    async deleteFeedback(req, res) {
        try {
            const userId = req.user?.userId;
            const { feedbackId } = req.params;

            if (!isValidObjectId(userId)) {
                return res.status(401).json({ message: "Vui lòng đăng nhập để tiếp tục." });
            }
            if (!isValidObjectId(feedbackId)) {
                return res.status(400).json({ message: "feedbackId không hợp lệ." });
            }

            const fb = await Feedback.findById(feedbackId).lean();
            if (!fb) return res.status(404).json({ message: "Không tìm thấy feedback." });

            if (!isAdmin(req)) {
                if (String(fb.createdBy) !== String(userId)) {
                    return res.status(403).json({ message: "Bạn không có quyền xoá feedback này." });
                }
                if (fb.status === "resolved" || fb.status === "closed") {
                    return res
                        .status(400)
                        .json({ message: "Không thể xoá khi feedback đã resolved/closed." });
                }
            }

            await Feedback.deleteOne({ _id: feedbackId });
            return res.json({ message: "Xoá feedback thành công." });
        } catch (e) {
            return res.status(500).json({ message: "Lỗi server.", error: e.message });
        }
    },

    // =========================
    // ADMIN: DELETE /feedback/admin  (xoá ALL, optional filter ?reason=...&status=...)
    // =========================
    async adminDeleteAll(req, res) {
        try {
            const reason = String(req.query.reason ?? "all").trim();
            const status = String(req.query.status ?? "all").trim();

            const filter = {};
            if (reason && reason !== "all") filter.reason = reason;
            if (status && status !== "all") {
                if (!ALLOWED_STATUS.includes(status)) {
                    return res.status(400).json({ message: "status không hợp lệ." });
                }
                filter.status = status;
            }

            const result = await Feedback.deleteMany(filter);

            return res.json({
                message: "Xoá tất cả feedback thành công.",
                deletedCount: result.deletedCount ?? 0,
            });
        } catch (e) {
            return res.status(500).json({ message: "Lỗi server.", error: e.message });
        }
    },

    // =========================
    // GET /feedback/form
    // =========================
    async getFormLink(req, res) {
        try {
            // hardcode tạm link form
            const formLink = "Chưa có link";
            return res.json({
                message: "Lấy link form feedback thành công.",
                formLink,
            });
        } catch (e) {
            return res.status(500).json({ message: "Lỗi server.", error: e.message });
        }   
    },
};
