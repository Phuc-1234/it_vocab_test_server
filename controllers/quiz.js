const mongoose = require("mongoose");
const QuizAttempt = require("../models/QuizAttempt");
const AttemptAnswer = require("../models/AttemptAnswer");
const Question = require("../models/Question");
const AnswerOption = require("../models/AnswerOption");
const Word = require("../models/Word");
const Topic = require("../models/Topic");
const UserWordProgress = require("../models/UserWordProgress");

// ===== Helpers =====
const MODES = ["TOPIC", "RANDOM", "INFINITE", "LEARN"];

function getGuestKey(req) {
    return String(req.headers["x-guest-key"] || req.body?.guestKey || "").trim() || null;
}

function isOwnerAttempt(attempt, req) {
    if (attempt.userId) {
        return req.user?.userId && String(attempt.userId) === String(req.user.userId);
    }
    // guest
    const gk = getGuestKey(req);
    return gk && attempt.guestKey && gk === attempt.guestKey;
}

function normalizeFill(s) {
    return String(s || "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ");
}

// SR schedule (bạn có thể chỉnh)
function daysForLevel(level) {
    // level: 0..n
    const table = [0, 1, 2, 3, 5, 10, 30, 60];
    return table[Math.min(level, table.length - 1)];
}

function calcOverduePenalty(nextReviewDate, studyLevel, now = new Date()) {
    if (!nextReviewDate) return 0;
    const diffMs = now.getTime() - new Date(nextReviewDate).getTime();
    if (diffMs <= 0) return 0;
    const overdueDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));
    // quá hạn càng lâu giảm càng nhiều (min để không âm)
    return Math.min(studyLevel, overdueDays);
}

async function buildQuestionsResponse(questions, includeWordInfo = false) {
    const qIds = questions.map((q) => q._id);
    const options = await AnswerOption.find({
        questionId: { $in: qIds },
        deletedAt: null,
        isActive: true,
    }).lean();

    const optByQ = new Map();
    for (const opt of options) {
        const k = String(opt.questionId);
        if (!optByQ.has(k)) optByQ.set(k, []);
        optByQ.get(k).push({
            _id: opt._id,
            content: opt.content,
            // đừng trả isCorrect ở lúc đang làm quiz (trừ LEARN nếu bạn muốn)
        });
    }

    let wordById = new Map();
    if (includeWordInfo) {
        const wordIds = [...new Set(questions.map((q) => String(q.wordId)))].map((id) => new mongoose.Types.ObjectId(id));
        const words = await Word.find({ _id: { $in: wordIds } }).lean();
        wordById = new Map(words.map((w) => [String(w._id), w]));
    }

    return questions.map((q) => ({
        _id: q._id,
        content: q.content,
        questionType: q.questionType,
        wordId: q.wordId,
        options: optByQ.get(String(q._id)) || [],
        word: includeWordInfo ? wordById.get(String(q.wordId)) || null : undefined,
    }));
}

async function pickOneQuestionPerWord(wordIds) {
    const out = [];
    for (const wid of wordIds) {
        const q = await Question.aggregate([
            {
                $match: {
                    wordId: new mongoose.Types.ObjectId(wid),
                    isActive: true,
                    deletedAt: null,
                },
            },
            { $sample: { size: 1 } },
        ]);
        if (q[0]) out.push(q[0]);
    }
    return out;
}

async function getTopicWordIdsBySR({ topicId, level, userId, isGuest, limit = 10 }) {
    // lọc words theo topic + level
    if (isGuest) {
        const words = await Word.find({
            topicId,
            level,
            isActive: true,
            deletedAt: null,
        })
            .select("_id")
            .limit(limit)
            .lean();
        return words.map((w) => String(w._id));
    }

    const now = new Date();

    const rows = await Word.aggregate([
        {
            $match: {
                topicId: new mongoose.Types.ObjectId(topicId),
                level: Number(level),
                isActive: true,
                deletedAt: null,
            },
        },
        {
            $lookup: {
                from: "userwordprogresses",
                let: { wid: "$_id" },
                pipeline: [
                    {
                        $match: {
                            $expr: {
                                $and: [
                                    { $eq: ["$wordId", "$$wid"] },
                                    { $eq: ["$userId", new mongoose.Types.ObjectId(userId)] },
                                ],
                            },
                        },
                    },
                ],
                as: "p",
            },
        },
        { $addFields: { p: { $arrayElemAt: ["$p", 0] } } },
        {
            $addFields: {
                nextReviewDateSort: { $ifNull: ["$p.nextReviewDate", now] },
                studyLevelSort: { $ifNull: ["$p.studyLevel", 0] },
            },
        },
        // ưu tiên nextReviewDate sớm nhất, rồi studyLevel thấp (chưa học)
        { $sort: { nextReviewDateSort: 1, studyLevelSort: 1, _id: 1 } },
        { $limit: limit },
        { $project: { _id: 1 } },
    ]);

    return rows.map((r) => String(r._id));
}

// ===== Controllers =====
module.exports = {
    /**
   * GET /quizzes/topics?page=1&pageSize=20
   * items: [{ topicId, level, title, mode }]
   */
    async quizzesByTopicsPaginated(req, res) {
        try {
            const { page = 1, pageSize = 20 } = req.query;

            const p = Math.max(1, parseInt(page, 10) || 1);
            const ps = Math.max(1, Math.min(parseInt(pageSize, 10) || 20, 100));

            const topics = await Topic.find({ /* isActive: true, deletedAt: null */ })
                .select("_id topicName maxLevel")
                .sort({ topicName: 1, _id: 1 })
                .lean();

            if (!topics.length) {
                return res.json({ page: p, pageSize: ps, total: 0, totalPages: 0, items: [] });
            }

            const levelsByTopic = topics.map(t => Math.max(1, Number(t.maxLevel || 1)));
            const total = levelsByTopic.reduce((acc, x) => acc + x, 0);
            const totalPages = Math.ceil(total / ps);

            const start = (p - 1) * ps;
            if (start >= total) {
                return res.json({ page: p, pageSize: ps, total, totalPages, items: [] });
            }
            const end = Math.min(start + ps, total);

            const items = [];
            let cursor = 0; // global index trong danh sách quiz ảo

            for (let i = 0; i < topics.length && cursor < end; i++) {
                const topic = topics[i];
                const maxLv = levelsByTopic[i];

                const topicStart = cursor;
                const topicEnd = cursor + maxLv;

                if (topicEnd <= start) {
                    cursor = topicEnd;
                    continue;
                }
                if (topicStart >= end) break;

                const fromLv = Math.max(1, start - topicStart + 1);
                const toLv = Math.min(maxLv, end - topicStart);

                for (let lv = fromLv; lv <= toLv; lv++) {
                    items.push({
                        topicId: topic._id,
                        level: lv,
                        title: `${topic.topicName} ${lv}`,
                        mode: "TOPIC",
                    });
                }

                cursor = topicEnd;
            }

            return res.json({
                page: p,
                pageSize: ps,
                total,
                totalPages,
                items,
            });
        } catch (e) {
            return res.status(500).json({ message: "Lỗi server.", error: e.message });
        }
    },


    /**
     * POST /quiz-attempts
     * Body:
     *  - mode: TOPIC|RANDOM|INFINITE|LEARN
     *  - topicId, level (TOPIC/LEARN)
     *  - totalQuestions? (default 10)
     */
    async start(req, res) {
        try {
            const { mode, topicId, level, totalQuestions } = req.body || {};
            const m = String(mode || "").toUpperCase();

            if (!MODES.includes(m)) {
                return res.status(400).json({ message: "mode không hợp lệ." });
            }

            const isUser = !!req.user?.userId;
            const guestKey = getGuestKey(req);

            // ===== guest rules =====
            if (!isUser) {
                if (!guestKey) return res.status(401).json({ message: "Guest cần x-guest-key." });

                if (!["RANDOM", "TOPIC"].includes(m)) {
                    return res.status(403).json({ message: "Guest chỉ được RANDOM hoặc TOPIC." });
                }

                if (m === "TOPIC" && Number(level) !== 1) {
                    return res.status(403).json({ message: "Guest TOPIC chỉ được level 1." });
                }
            }

            // ===== user rules =====
            if ((m === "LEARN" || m === "INFINITE") && !isUser) {
                return res.status(401).json({ message: "Chế độ này yêu cầu đăng nhập." });
            }

            // ✅ ===== block if already has IN_PROGRESS attempt =====
            const inProgressFilter = isUser
                ? { userId: req.user.userId, status: "IN_PROGRESS" }
                : { guestKey, status: "IN_PROGRESS" };

            const existing = await QuizAttempt.findOne(inProgressFilter)
                .select("_id mode topicId level startedAt createdAt")
                .lean();

            if (existing) {
                return res.status(409).json({
                    message: "Bạn đang có một quiz đang làm dở. Vui lòng hoàn thành hoặc bỏ quiz hiện tại trước khi bắt đầu quiz mới.",
                    inProgressAttempt: existing,
                });
            }

            const n = Math.max(1, Math.min(Number(totalQuestions || 10), 50));

            // ===== pick questions =====
            let questions = [];

            if (m === "RANDOM") {
                questions = await Question.aggregate([
                    { $match: { isActive: true, deletedAt: null } },
                    { $sample: { size: n } },
                ]);
            }

            if (m === "INFINITE") {
                questions = await Question.find({ isActive: true, deletedAt: null })
                    .sort({ _id: 1 })
                    .limit(n)
                    .lean();
            }

            if (m === "TOPIC" || m === "LEARN") {
                if (!topicId || level == null) {
                    return res.status(400).json({ message: "Thiếu topicId/level." });
                }

                const wordIds = await getTopicWordIdsBySR({
                    topicId,
                    level,
                    userId: req.user?.userId,
                    isGuest: !isUser,
                    limit: n,
                });

                questions = await pickOneQuestionPerWord(wordIds);

                // nếu thiếu câu (word thiếu question), fallback random
                if (questions.length < n) {
                    const missing = n - questions.length;
                    const extra = await Question.aggregate([
                        { $match: { isActive: true, deletedAt: null } },
                        { $sample: { size: missing } },
                    ]);
                    questions = [...questions, ...extra];
                }
            }

            if (!questions.length) {
                return res.status(404).json({ message: "Không tìm thấy câu hỏi." });
            }

            const questionIds = questions.map((q) => q._id);

            // ===== create attempt =====
            const attempt = await QuizAttempt.create({
                userId: isUser ? req.user.userId : null,
                isGuest: !isUser,
                guestKey: !isUser ? guestKey : null,

                mode: m,
                topicId: ["TOPIC", "LEARN"].includes(m) ? topicId : null,
                level: ["TOPIC", "LEARN"].includes(m) ? Number(level) : null,

                questionIds,
                totalQuestions: questionIds.length,
                correctAnswers: 0,
                earnedXP: 0,

                status: "IN_PROGRESS",
                startedAt: new Date(),
            });

            // ===== create AttemptAnswer skeletons =====
            await AttemptAnswer.insertMany(
                questionIds.map((qid) => ({
                    attemptId: attempt._id,
                    questionId: qid,
                    answeredAt: null,
                    selectedOptionId: null,
                    answerText: null,
                    isCorrect: null,
                })),
                { ordered: false }
            );

            const includeWordInfo = m === "LEARN";
            const questionsFull = await buildQuestionsResponse(
                await Question.find({ _id: { $in: questionIds } }).lean(),
                includeWordInfo
            );

            return res.status(201).json({
                attempt: {
                    _id: attempt._id,
                    mode: attempt.mode,
                    topicId: attempt.topicId,
                    level: attempt.level,
                    totalQuestions: attempt.totalQuestions,
                    status: attempt.status,
                    createdAt: attempt.createdAt,
                },
                questions: questionsFull,
            });
        } catch (e) {
            return res.status(500).json({ message: "Lỗi server.", error: e.message });
        }
    },

    /**
     * GET /quiz-attempts/:attemptId
     * Lấy lại attempt đang làm + AttemptAnswers + questions/options
     */
    async getAttempt(req, res) {
        try {
            const { attemptId } = req.params;
            const attempt = await QuizAttempt.findById(attemptId).lean();
            if (!attempt) return res.status(404).json({ message: "Attempt không tồn tại." });

            if (!isOwnerAttempt(attempt, req)) return res.status(403).json({ message: "Không có quyền truy cập attempt." });

            const answers = await AttemptAnswer.find({ attemptId: attempt._id }).lean();
            const questions = await Question.find({ _id: { $in: attempt.questionIds } }).lean();

            const includeWordInfo = attempt.mode === "LEARN";
            const questionsFull = await buildQuestionsResponse(questions, includeWordInfo);

            return res.json({ attempt, answers, questions: questionsFull });
        } catch (e) {
            return res.status(500).json({ message: "Lỗi server.", error: e.message });
        }
    },

    /**
     * POST /quiz-attempts/:attemptId/next-batch
     * Chỉ INFINITE + chỉ User (JWT)
     */
    async nextBatch(req, res) {
        try {
            const { attemptId } = req.params;

            const attempt = await QuizAttempt.findById(attemptId);
            if (!attempt) return res.status(404).json({ message: "Attempt không tồn tại." });

            if (!attempt.userId) return res.status(401).json({ message: "Chế độ này yêu cầu đăng nhập." });
            if (String(attempt.userId) !== String(req.user.userId)) {
                return res.status(403).json({ message: "Không có quyền." });
            }

            if (attempt.mode !== "INFINITE") return res.status(400).json({ message: "Chỉ hỗ trợ INFINITE." });
            if (attempt.status !== "IN_PROGRESS") return res.status(400).json({ message: "Attempt đã kết thúc/bỏ." });

            const n = 10;

            const existed = new Set(attempt.questionIds.map((x) => String(x)));

            const more = await Question.find({
                isActive: true,
                deletedAt: null,
                _id: { $nin: attempt.questionIds },
            })
                .sort({ _id: 1 })
                .limit(n)
                .lean();

            if (!more.length) return res.json({ items: [], message: "Hết câu hỏi." });

            const newIds = more.map((q) => q._id).filter((id) => !existed.has(String(id)));

            attempt.questionIds.push(...newIds);
            attempt.totalQuestions = attempt.questionIds.length;
            await attempt.save();

            await AttemptAnswer.insertMany(
                newIds.map((qid) => ({
                    attemptId: attempt._id,
                    questionId: qid,
                    answeredAt: null,
                    selectedOptionId: null,
                    answerText: null,
                    isCorrect: null,
                })),
                { ordered: false }
            );

            const items = await buildQuestionsResponse(more, false);
            return res.json({ items, totalQuestions: attempt.totalQuestions });
        } catch (e) {
            return res.status(500).json({ message: "Lỗi server.", error: e.message });
        }
    },

    /**
     * PUT /attempt-answers/:attemptAnswerId
     * Body:
     *  - selectedOptionId (MCQ/TRUE_FALSE)
     *  - answerText (FILL_BLANK)
     */
    async updateAnswer(req, res) {
        try {
            const { attemptAnswerId } = req.params;
            const { selectedOptionId, answerText } = req.body || {};

            const aa = await AttemptAnswer.findById(attemptAnswerId);
            if (!aa) return res.status(404).json({ message: "AttemptAnswer không tồn tại." });

            const attempt = await QuizAttempt.findById(aa.attemptId).lean();
            if (!attempt) return res.status(404).json({ message: "Attempt không tồn tại." });

            if (!isOwnerAttempt(attempt, req)) return res.status(403).json({ message: "Không có quyền." });

            if (attempt.status !== "IN_PROGRESS") {
                return res.status(400).json({ message: "Attempt đã kết thúc/bỏ." });
            }

            const question = await Question.findById(aa.questionId).lean();
            if (!question) return res.status(404).json({ message: "Question không tồn tại." });

            // chấm
            let isCorrect = false;

            if (question.questionType === "MULTIPLE_CHOICE" || question.questionType === "TRUE_FALSE") {
                if (!selectedOptionId) return res.status(400).json({ message: "Thiếu selectedOptionId." });

                const correctOpt = await AnswerOption.findOne({
                    questionId: question._id,
                    isCorrect: true,
                    deletedAt: null,
                    isActive: true,
                }).lean();

                if (!correctOpt) return res.status(500).json({ message: "Câu hỏi thiếu đáp án đúng." });

                isCorrect = String(correctOpt._id) === String(selectedOptionId);

                aa.selectedOptionId = selectedOptionId;
                aa.answerText = null;
            } else if (question.questionType === "FILL_BLANK") {
                if (!answerText) return res.status(400).json({ message: "Thiếu answerText." });

                const correctOpts = await AnswerOption.find({
                    questionId: question._id,
                    isCorrect: true,
                    deletedAt: null,
                    isActive: true,
                }).lean();

                const normalized = normalizeFill(answerText);
                isCorrect = correctOpts.some((o) => normalizeFill(o.content) === normalized);

                aa.answerText = answerText;
                aa.selectedOptionId = null;
            } else {
                return res.status(400).json({ message: "questionType không hỗ trợ." });
            }

            aa.isCorrect = isCorrect;
            aa.answeredAt = new Date();
            await aa.save();

            return res.json({ attemptAnswerId: aa._id, isCorrect });
        } catch (e) {
            return res.status(500).json({ message: "Lỗi server.", error: e.message });
        }
    },

    /**
     * POST /quiz-attempts/:attemptId/finish
     * - Guest: chỉ tổng kết attempt, KHÔNG update SR/XP
     * - User: update SR + XP (LEARN => XP=0)
     */
    async finish(req, res) {
        try {
            const { attemptId } = req.params;

            const attempt = await QuizAttempt.findById(attemptId);
            if (!attempt) return res.status(404).json({ message: "Attempt không tồn tại." });

            if (!isOwnerAttempt(attempt, req)) return res.status(403).json({ message: "Không có quyền." });

            if (attempt.status !== "IN_PROGRESS") return res.status(400).json({ message: "Attempt đã kết thúc/bỏ." });

            const answers = await AttemptAnswer.find({ attemptId: attempt._id }).lean();
            const total = attempt.questionIds.length;
            const correct = answers.filter((a) => a.isCorrect === true).length;

            attempt.totalQuestions = total;
            attempt.correctAnswers = correct;

            // XP rule
            const isUser = !!attempt.userId;
            let earnedXP = 0;
            if (isUser && attempt.mode !== "LEARN") {
                earnedXP = correct * 5; // bạn đổi công thức tuỳ ý
            }
            attempt.earnedXP = earnedXP;

            attempt.status = "FINISHED";
            attempt.finishedAt = new Date();
            await attempt.save();

            // ===== SR update only for user =====
            if (isUser && attempt.mode === "TOPIC") {
                const now = new Date();

                // load questions to get wordId
                const questions = await Question.find({ _id: { $in: attempt.questionIds } })
                    .select("_id wordId")
                    .lean();
                const qToWord = new Map(questions.map((q) => [String(q._id), String(q.wordId)]));

                // aggregate per word: nếu có bất kỳ sai => reset
                const wordAgg = new Map();
                for (const a of answers) {
                    const wid = qToWord.get(String(a.questionId));
                    if (!wid) continue;
                    if (!wordAgg.has(wid)) wordAgg.set(wid, { anyWrong: false, anyCorrect: false });
                    const w = wordAgg.get(wid);
                    if (a.isCorrect === false) w.anyWrong = true;
                    if (a.isCorrect === true) w.anyCorrect = true;
                }

                for (const [wordId, st] of wordAgg.entries()) {
                    // upsert progress
                    let p = await UserWordProgress.findOne({ userId: attempt.userId, wordId });
                    if (!p) {
                        p = await UserWordProgress.create({
                            userId: attempt.userId,
                            wordId,
                            studyLevel: 0,
                            nextReviewDate: now,
                            lastReviewDate: null,
                            reviewState: "NEW",
                        });
                    }

                    // overdue penalty first
                    const penalty = calcOverduePenalty(p.nextReviewDate, p.studyLevel, now);
                    if (penalty > 0) {
                        p.studyLevel = Math.max(p.studyLevel - penalty, 0);
                    }

                    if (st.anyWrong) {
                        p.studyLevel = 0;
                        p.nextReviewDate = now;
                        p.lastReviewDate = now;
                        p.reviewState = "NEW";
                    } else if (st.anyCorrect) {
                        p.studyLevel = Math.max(p.studyLevel, 0) + 1;
                        const days = daysForLevel(p.studyLevel);
                        p.lastReviewDate = now;
                        p.nextReviewDate = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
                        p.reviewState = "REVIEW";
                    }

                    await p.save();
                }
            }

            return res.json({
                attemptId: attempt._id,
                totalQuestions: attempt.totalQuestions,
                correctAnswers: attempt.correctAnswers,
                earnedXP: attempt.earnedXP,
            });
        } catch (e) {
            return res.status(500).json({ message: "Lỗi server.", error: e.message });
        }
    },

    /**
     * GET /quiz-attempts?mode=&topicId=&from=&to=&page=1&pageSize=20
     * /quiz-attempts?page=1&pageSize=20
     * /quiz-attempts?mode=TOPIC&topicId=...&page=2&pageSize=10
     * /quiz-attempts?from=2026-01-01&to=2026-01-31&page=1&pageSize=20
     */
    async history(req, res) {
        try {
            const userId = req.user.userId;

            const { mode, topicId, from, to, page = 1, pageSize = 20 } = req.query;

            const filter = { userId };

            if (mode) filter.mode = String(mode).toUpperCase();
            if (topicId) filter.topicId = topicId;

            if (from || to) {
                filter.createdAt = {};
                if (from) filter.createdAt.$gte = new Date(from);
                if (to) filter.createdAt.$lte = new Date(to);
            }

            const p = Math.max(1, parseInt(page, 10) || 1);
            const ps = Math.max(1, Math.min(parseInt(pageSize, 10) || 20, 100));

            const skip = (p - 1) * ps;

            const [items, total] = await Promise.all([
                QuizAttempt.find(filter)
                    .select("_id mode topicId level totalQuestions correctAnswers earnedXP status createdAt finishedAt")
                    .sort({ createdAt: -1 })
                    .skip(skip)
                    .limit(ps)
                    .lean(),
                QuizAttempt.countDocuments(filter),
            ]);

            const totalPages = Math.ceil(total / ps);

            return res.json({
                page: p,
                pageSize: ps,
                total,
                totalPages,
                items,
            });
        } catch (e) {
            return res.status(500).json({ message: "Lỗi server.", error: e.message });
        }
    },


    /**
     * GET /quiz-attempts/:attemptId/review - user only
     * Trả attempt summary + câu hỏi + đáp án user + đáp án đúng
     */
    async review(req, res) {
        try {
            const { attemptId } = req.params;

            const attempt = await QuizAttempt.findById(attemptId).lean();
            if (!attempt) return res.status(404).json({ message: "Attempt không tồn tại." });

            // ✅ cho cả user & guest: chỉ cần owner
            if (!isOwnerAttempt(attempt, req)) {
                return res.status(403).json({ message: "Không có quyền." });
            }

            const answers = await AttemptAnswer.find({ attemptId: attempt._id }).lean();
            const questions = await Question.find({ _id: { $in: attempt.questionIds } }).lean();
            const qIds = questions.map((q) => q._id);

            const options = await AnswerOption.find({
                questionId: { $in: qIds },
                deletedAt: null,
                isActive: true,
            }).lean();

            const optByQ = new Map();
            for (const o of options) {
                const k = String(o.questionId);
                if (!optByQ.has(k)) optByQ.set(k, []);
                optByQ.get(k).push({ _id: o._id, content: o.content, isCorrect: o.isCorrect });
            }

            const ansByQ = new Map(answers.map((a) => [String(a.questionId), a]));

            const includeWordInfo = attempt.mode === "LEARN";
            let wordById = new Map();
            if (includeWordInfo) {
                const wordIds = [...new Set(questions.map((q) => String(q.wordId)))].map(
                    (id) => new mongoose.Types.ObjectId(id)
                );
                const words = await Word.find({ _id: { $in: wordIds } }).lean();
                wordById = new Map(words.map((w) => [String(w._id), w]));
            }

            const items = questions.map((q) => {
                const a = ansByQ.get(String(q._id)) || null;
                return {
                    question: {
                        _id: q._id,
                        content: q.content,
                        questionType: q.questionType,
                        wordId: q.wordId,
                        word: includeWordInfo ? wordById.get(String(q.wordId)) || null : undefined,
                    },
                    options: optByQ.get(String(q._id)) || [],
                    userAnswer: a
                        ? {
                            selectedOptionId: a.selectedOptionId,
                            answerText: a.answerText,
                            isCorrect: a.isCorrect,
                            answeredAt: a.answeredAt,
                        }
                        : null,
                };
            });

            return res.json({
                attempt: {
                    _id: attempt._id,
                    mode: attempt.mode,
                    topicId: attempt.topicId,
                    level: attempt.level,
                    totalQuestions: attempt.totalQuestions,
                    correctAnswers: attempt.correctAnswers,
                    earnedXP: attempt.earnedXP,
                    status: attempt.status,
                    createdAt: attempt.createdAt,
                },
                items,
            });
        } catch (e) {
            return res.status(500).json({ message: "Lỗi server.", error: e.message });
        }
    },
    /**
     * POST /quiz-attempts/:attemptId/abandon
     * user or guest (ownership required)
     */
    async abandon(req, res) {
        try {
            const { attemptId } = req.params;

            const attempt = await QuizAttempt.findById(attemptId);
            if (!attempt) return res.status(404).json({ message: "Attempt không tồn tại." });

            if (!isOwnerAttempt(attempt, req)) return res.status(403).json({ message: "Không có quyền." });

            if (attempt.status !== "IN_PROGRESS") return res.status(400).json({ message: "Attempt đã kết thúc/bỏ." });

            attempt.status = "ABANDONED";
            await attempt.save();

            return res.json({ message: "Đã bỏ quiz.", attemptId: attempt._id });
        } catch (e) {
            return res.status(500).json({ message: "Lỗi server.", error: e.message });
        }
    },


};
