// controllers/quizAttemptController.js
const mongoose = require("mongoose");
const QuizAttempt = require("../models/QuizAttempt");
const AttemptAnswer = require("../models/AttemptAnswer");
const Question = require("../models/Question");
const AnswerOption = require("../models/AnswerOption");
const Word = require("../models/Word");
const Topic = require("../models/Topic");
const UserWordProgress = require("../models/UserWordProgress");

const INFINITE_BATCH_SIZE = 10;

// ===== Helpers =====
const MODES = ["TOPIC", "RANDOM", "INFINITE", "LEARN"];

/**
 * Attempt summary DTO (lightweight for Android FE)
 */
function attemptDto(attempt) {
    const total = Array.isArray(attempt.questionIds)
        ? attempt.questionIds.length
        : attempt.totalQuestions || 0;

    return {
        attemptId: attempt._id,
        mode: attempt.mode,
        topicId: attempt.topicId ?? null,
        level: attempt.level ?? null,
        status: attempt.status,
        totalQuestions: total,
        correctAnswers: attempt.correctAnswers ?? 0,
        earnedXP: attempt.earnedXP ?? 0,
    };
}

function getGuestKey(req) {
    return String(req.headers["x-guest-key"] || req.body?.guestKey || "").trim() || null;
}

function isOwnerAttempt(attempt, req) {
    if (attempt.userId) {
        return req.user?.userId && String(attempt.userId) === String(req.user.userId);
    }
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
    const table = [0, 1, 2, 3, 5, 10, 30, 60];
    return table[Math.min(level, table.length - 1)];
}

function calcOverduePenalty(nextReviewDate, studyLevel, now = new Date()) {
    if (!nextReviewDate) return 0;
    const diffMs = now.getTime() - new Date(nextReviewDate).getTime();
    if (diffMs <= 0) return 0;
    const overdueDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));
    return Math.min(studyLevel, overdueDays);
}

/**
 * Return a "thin" word object for LEARN mode.
 * Customize WORD_FIELDS to match your Word schema.
 */
const WORD_FIELDS = [
    "_id",
    "term",
    "meaning",
    "word",
    "definition",
    "pronunciation",
    "example",
    "audioUrl",
    "imageUrl",
];

function buildHintFromWord(w) {
    if (!w) return "";
    return String(
        w.example ||
        w.meaningEN ||
        w.meaningVN ||
        w.definition ||   // fallback nếu sau này có
        w.meaning ||      // fallback nếu sau này có
        ""
    ).trim();
}

function buildExplanationFromWord(w) {
    if (!w) return "";
    return String(
        w.meaningEN ||
        w.meaningVN ||
        w.definition ||
        w.meaning ||
        ""
    ).trim();
}

function buildExampleFromWord(w) {
    if (!w) return "";
    return String(w.example || "").trim();
}


function pickWordInfo(w) {
    if (!w) return null;
    const out = {};
    for (const k of WORD_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(w, k) && w[k] != null) out[k] = w[k];
    }
    if (w._id && !out._id) out._id = w._id;
    return Object.keys(out).length ? out : { _id: w._id };
}

function toObjectIdMaybe(v) {
    try {
        if (v == null) return null;
        return new mongoose.Types.ObjectId(String(v));
    } catch {
        return null;
    }
}

/**
 * Build FE-friendly question DTOs:
 * {
 *   questionId, content, questionType, wordId,
 *   options: [{_id, content}],
 *   word: null | { ...thin word... },
 *   hint: string
 * }
 */
async function buildQuestionDtos(questions, includeWordInfo = false) {
    const qIds = questions.map((q) => q._id);

    const options = await AnswerOption.find({
        questionId: { $in: qIds },
        deletedAt: null,
        isActive: true,
    })
        .select("_id questionId content")
        .lean();

    const optByQ = new Map();
    for (const opt of options) {
        const k = String(opt.questionId);
        if (!optByQ.has(k)) optByQ.set(k, []);
        optByQ.get(k).push({ _id: opt._id, content: opt.content });
    }

    // ===== Word lookup for LEARN =====
    let wordById = new Map();
    if (includeWordInfo) {
        const rawIds = [
            ...new Set(
                questions
                    .map((q) => q.wordId)
                    .filter(Boolean)
                    .map((id) => String(id))
            ),
        ];

        const objIds = rawIds.map(toObjectIdMaybe).filter(Boolean);

        // Robust query: tolerate ObjectId or string _id
        const words = await Word.find({
            $or: [
                { _id: { $in: objIds } },
                { _id: { $in: rawIds } },
                // nếu schema có field wordId riêng (optional)
                { wordId: { $in: rawIds } },
            ],
        }).lean();

        wordById = new Map();
        for (const w of words) {
            // map by _id
            wordById.set(String(w._id), w);
            // map by wordId field if exists
            if (w.wordId != null) wordById.set(String(w.wordId), w);
        }
    }

    return questions.map((q) => {
        const w = includeWordInfo ? wordById.get(String(q.wordId)) || null : null;

        return {
            questionId: q._id,
            content: q.content,
            questionType: q.questionType,
            wordId: q.wordId ?? null,
            options: optByQ.get(String(q._id)) || [],
            word: includeWordInfo ? pickWordInfo(w) : null,
            hint: includeWordInfo ? buildHintFromWord(w) : "",
        };
    });
}

async function pickOneQuestionPerWord(wordIds) {
    const out = [];
    for (const wid of wordIds) {
        const oid = toObjectIdMaybe(wid);
        if (!oid) continue;

        const q = await Question.aggregate([
            {
                $match: {
                    wordId: oid,
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
    // Guest: không có SR -> lấy word theo topicId + level (thứ tự mặc định)
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

    const NEW_DATE = new Date("1950-01-01T00:00:00.000Z");

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
                    { $limit: 1 },
                    { $project: { _id: 0, nextReviewDate: 1, studyLevel: 1 } },
                ],
                as: "p",
            },
        },
        { $addFields: { p: { $arrayElemAt: ["$p", 0] } } },
        {
            $addFields: {
                nextReviewDateSort: { $ifNull: ["$p.nextReviewDate", NEW_DATE] },
                studyLevelSort: { $ifNull: ["$p.studyLevel", 0] },
            },
        },
        { $sort: { nextReviewDateSort: 1, studyLevelSort: 1, _id: 1 } },
        { $limit: limit },
        { $project: { _id: 1 } },
    ]);

    return rows.map((r) => String(r._id));
}

/**
 * Attach attemptAnswer object into each question item (consistent shape)
 * - attemptAnswer: {_id, selectedOptionId, answerText, isCorrect, answeredAt}
 */
async function attachAttemptAnswers({ attemptId, questionsDto }) {
    const qIds = questionsDto.map((q) => q.questionId);

    const answers = await AttemptAnswer.find({
        attemptId,
        questionId: { $in: qIds },
    })
        .select("_id questionId selectedOptionId answerText isCorrect answeredAt")
        .lean();

    const ansByQ = new Map(answers.map((a) => [String(a.questionId), a]));

    return questionsDto.map((q) => {
        const a = ansByQ.get(String(q.questionId)) || null;

        let selectedOptionId = a?.selectedOptionId ?? null;
        let answerText = a?.answerText ?? null;

        if (a) {
            if (q.questionType === "FILL_BLANK") selectedOptionId = null;
            else answerText = null;
        }

        return {
            ...q,
            attemptAnswer: a
                ? {
                    _id: a._id,
                    selectedOptionId,
                    answerText,
                    isCorrect: a.isCorrect,
                    answeredAt: a.answeredAt,
                }
                : null,
        };
    });
}

async function ensureInfiniteNextBatchIfNeeded(attempt) {
    const more = await Question.find({
        isActive: true,
        deletedAt: null,
        _id: { $nin: attempt.questionIds },
    })
        .sort({ _id: 1 })
        .limit(INFINITE_BATCH_SIZE)
        .lean();

    if (!more.length) return { appended: false, newIds: [] };

    const existedNow = new Set(attempt.questionIds.map((x) => String(x)));
    const newIds = more.map((q) => q._id).filter((id) => !existedNow.has(String(id)));

    if (!newIds.length) return { appended: false, newIds: [] };

    attempt.questionIds.push(...newIds);
    attempt.totalQuestions = attempt.questionIds.length;
    await attempt.save();

    try {
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
    } catch (err) {
        if (err?.code !== 11000) throw err;
    }

    return { appended: true, newIds };
}

async function gradeAndSaveAttemptAnswer({ aa, question, selectedOptionId, answerText }) {
    let isCorrect = false;

    let correctOptionId = null;
    let correctAnswers = null;

    if (question.questionType === "MULTIPLE_CHOICE" || question.questionType === "TRUE_FALSE") {
        if (!selectedOptionId) {
            return { ok: false, status: 400, message: "Thiếu selectedOptionId." };
        }

        const correctOpt = await AnswerOption.findOne({
            questionId: question._id,
            isCorrect: true,
            deletedAt: null,
            isActive: true,
        })
            .select("_id")
            .lean();

        if (!correctOpt) {
            return { ok: false, status: 500, message: "Câu hỏi thiếu đáp án đúng." };
        }

        correctOptionId = correctOpt._id;
        isCorrect = String(correctOpt._id) === String(selectedOptionId);
        aa.selectedOptionId = selectedOptionId;
        aa.answerText = null;
    } else if (question.questionType === "FILL_BLANK") {
        if (!answerText) {
            return { ok: false, status: 400, message: "Thiếu answerText." };
        }

        const correctOpts = await AnswerOption.find({
            questionId: question._id,
            isCorrect: true,
            deletedAt: null,
            isActive: true,
        })
            .select("content")
            .lean();

        const normalized = normalizeFill(answerText);
        isCorrect = correctOpts.some((o) => normalizeFill(o.content) === normalized);

        correctAnswers = correctOpts.map((o) => o.content);

        aa.answerText = answerText;
        aa.selectedOptionId = null;
    } else {
        return { ok: false, status: 400, message: "questionType không hỗ trợ." };
    }

    aa.isCorrect = isCorrect;
    aa.answeredAt = new Date();
    await aa.save();

    return { ok: true, isCorrect, correctOptionId, correctAnswers };
}

// ===== Controllers =====
module.exports = {
    /**
     * GET /quizzes/topics?page=1&pageSize=20
     */
    async quizzesByTopicsPaginated(req, res) {
        try {
            const { page = 1, pageSize = 20 } = req.query;

            const p = Math.max(1, parseInt(page, 10) || 1);
            const ps = Math.max(1, Math.min(parseInt(pageSize, 10) || 20, 100));

            const topics = await Topic.find({})
                .select("_id topicName maxLevel")
                .sort({ topicName: 1, _id: 1 })
                .lean();

            if (!topics.length) {
                return res.json({ page: p, pageSize: ps, total: 0, totalPages: 0, items: [] });
            }

            const levelsByTopic = topics.map((t) => Math.max(1, Number(t.maxLevel || 1)));
            const total = levelsByTopic.reduce((acc, x) => acc + x, 0);
            const totalPages = Math.ceil(total / ps);

            const start = (p - 1) * ps;
            if (start >= total) {
                return res.json({ page: p, pageSize: ps, total, totalPages, items: [] });
            }
            const end = Math.min(start + ps, total);

            const items = [];
            let cursor = 0;

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

            return res.json({ page: p, pageSize: ps, total, totalPages, items });
        } catch (e) {
            return res.status(500).json({ message: "Lỗi server.", error: e.message });
        }
    },

    /**
     * POST /quiz/attempts
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

            // guest rules
            if (!isUser) {
                if (!guestKey) return res.status(401).json({ message: "Guest cần x-guest-key." });
                if (!["RANDOM", "TOPIC"].includes(m)) {
                    return res.status(403).json({ message: "Guest chỉ được RANDOM hoặc TOPIC." });
                }
                if (m === "TOPIC" && Number(level) !== 1) {
                    return res.status(403).json({ message: "Guest TOPIC chỉ được level 1." });
                }
            }

            // user rules
            if ((m === "LEARN" || m === "INFINITE") && !isUser) {
                return res.status(401).json({ message: "Chế độ này yêu cầu đăng nhập." });
            }

            // block if already IN_PROGRESS
            const inProgressFilter = isUser
                ? { userId: req.user.userId, status: "IN_PROGRESS" }
                : { guestKey, status: "IN_PROGRESS" };

            const existing = await QuizAttempt.findOne(inProgressFilter)
                .select("_id mode topicId level startedAt createdAt")
                .lean();

            if (existing) {
                return res.status(409).json({
                    message:
                        "Bạn đang có một quiz đang làm dở. Vui lòng hoàn thành hoặc bỏ quiz hiện tại trước khi bắt đầu quiz mới.",
                    inProgressAttempt: existing,
                });
            }

            const n = m === "INFINITE" ? INFINITE_BATCH_SIZE : Math.max(1, Math.min(Number(totalQuestions || 10), 50));

            let questions = [];

            if (m === "RANDOM") {
                questions = await Question.aggregate([
                    { $match: { isActive: true, deletedAt: null } },
                    { $sample: { size: n } },
                ]);
            }

            if (m === "INFINITE") {
                questions = await Question.aggregate([
                    { $match: { isActive: true, deletedAt: null } },
                    { $sample: { size: n } },
                ]);
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

                if (questions.length < n) {
                    const missing = n - questions.length;
                    const extra = await Question.aggregate([
                        // ✅ tránh lấy câu không có wordId (LEARN cần hint/word)
                        { $match: { isActive: true, deletedAt: null, wordId: { $ne: null } } },
                        { $sample: { size: missing } },
                    ]);
                    questions = [...questions, ...extra];
                }
            }

            if (!questions.length) {
                return res.status(404).json({ message: "Không tìm thấy câu hỏi." });
            }

            const questionIds = questions.map((q) => q._id);

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

            const firstId = attempt.questionIds[0];
            const firstQ = await Question.findById(firstId).lean();
            if (!firstQ) return res.status(500).json({ message: "Lỗi dữ liệu: thiếu câu đầu tiên." });

            const includeWordInfo = attempt.mode === "LEARN";
            const [firstDto] = await buildQuestionDtos([firstQ], includeWordInfo);
            const [mergedFirst] = await attachAttemptAnswers({ attemptId: attempt._id, questionsDto: [firstDto] });

            const total = attempt.questionIds.length;
            const canNext = total > 1 || attempt.mode === "INFINITE";

            return res.status(201).json({
                attempt: attemptDto(attempt),
                cursor: 0,
                canPrev: false,
                canNext,
                question: mergedFirst,
            });
        } catch (e) {
            return res.status(500).json({ message: "Lỗi server.", error: e.message });
        }
    },

    /**
     * GET /quiz-attempts/:attemptId/questions/:cursor
     */
    async getQuestionByCursor(req, res) {
        try {
            const { attemptId, cursor } = req.params;
            const idx = Math.max(0, parseInt(cursor, 10) || 0);

            const attempt = await QuizAttempt.findById(attemptId).lean();
            if (!attempt) return res.status(404).json({ message: "Attempt không tồn tại." });

            if (!isOwnerAttempt(attempt, req)) {
                return res.status(403).json({ message: "Không có quyền truy cập attempt." });
            }

            const total = attempt.questionIds.length;

            if (idx >= total) {
                if (attempt.mode === "INFINITE") {
                    return res.status(409).json({
                        message:
                            "Chưa có batch mới cho cursor này. Hãy submit câu trước đó (auto next-batch) hoặc gọi next-batch.",
                        requireNextBatch: true,
                        cursor: idx,
                        totalQuestions: total,
                    });
                }
                return res.status(404).json({
                    message: "Cursor vượt quá số câu hiện có.",
                    cursor: idx,
                    totalQuestions: total,
                });
            }

            const questionId = attempt.questionIds[idx];

            const q = await Question.findById(questionId).lean();
            if (!q) return res.status(404).json({ message: "Question không tồn tại." });

            const includeWordInfo = attempt.mode === "LEARN";
            const [qDto] = await buildQuestionDtos([q], includeWordInfo);

            const merged = (await attachAttemptAnswers({ attemptId: attempt._id, questionsDto: [qDto] }))[0];

            return res.json({
                attempt: attemptDto(attempt),
                cursor: idx,
                canPrev: idx > 0,
                canNext: idx + 1 < total || attempt.mode === "INFINITE",
                question: merged,
            });
        } catch (e) {
            return res.status(500).json({ message: "Lỗi server.", error: e.message });
        }
    },

    /**
     * POST /quiz-attempts/:attemptId/submit
     */
    async submitAndNext(req, res) {
        try {
            const { attemptId } = req.params;
            const { cursor, attemptAnswerId, selectedOptionId, answerText } = req.body || {};
            const idx = Math.max(0, parseInt(cursor, 10) || 0);

            const attempt = await QuizAttempt.findById(attemptId);
            if (!attempt) return res.status(404).json({ message: "Attempt không tồn tại." });

            if (!isOwnerAttempt(attempt, req)) return res.status(403).json({ message: "Không có quyền." });
            if (attempt.status !== "IN_PROGRESS") return res.status(400).json({ message: "Attempt đã kết thúc/bỏ." });

            if (!attempt.questionIds || idx >= attempt.questionIds.length) {
                return res.status(400).json({
                    message: "Cursor không hợp lệ (vượt quá số câu hiện có).",
                    cursor: idx,
                    totalQuestions: attempt.questionIds.length,
                });
            }

            const qid = attempt.questionIds[idx];

            let aa = null;
            if (attemptAnswerId) {
                aa = await AttemptAnswer.findById(attemptAnswerId);
                if (!aa) return res.status(404).json({ message: "AttemptAnswer không tồn tại." });

                if (String(aa.attemptId) !== String(attempt._id) || String(aa.questionId) !== String(qid)) {
                    return res.status(400).json({ message: "attemptAnswerId không khớp attempt/question." });
                }
            } else {
                aa = await AttemptAnswer.findOne({ attemptId: attempt._id, questionId: qid });
                if (!aa) return res.status(404).json({ message: "AttemptAnswer không tồn tại." });
            }

            const question = await Question.findById(qid).lean();
            if (!question) return res.status(404).json({ message: "Question không tồn tại." });

            // =========================================================
            // Idempotent submit: nếu đã trả lời -> trả lại kết quả cũ + next
            // =========================================================
            if (aa.answeredAt) {
                let correctOptionId = null;
                let correctAnswers = null;

                if (question.questionType === "MULTIPLE_CHOICE" || question.questionType === "TRUE_FALSE") {
                    const correctOpt = await AnswerOption.findOne({
                        questionId: question._id,
                        isCorrect: true,
                        deletedAt: null,
                        isActive: true,
                    })
                        .select("_id")
                        .lean();
                    correctOptionId = correctOpt?._id ?? null;
                } else if (question.questionType === "FILL_BLANK") {
                    const correctOpts = await AnswerOption.find({
                        questionId: question._id,
                        isCorrect: true,
                        deletedAt: null,
                        isActive: true,
                    })
                        .select("content")
                        .lean();
                    correctAnswers = correctOpts.map((o) => o.content);
                }

                let nextCursor = idx + 1;
                let batchAppended = false;

                if (nextCursor >= attempt.questionIds.length) {
                    if (attempt.mode === "INFINITE") {
                        if (!attempt.userId) return res.status(401).json({ message: "Chế độ này yêu cầu đăng nhập." });

                        const rs = await ensureInfiniteNextBatchIfNeeded(attempt);
                        batchAppended = rs.appended;

                        if (!rs.appended) {
                            return res.json({
                                attempt: attemptDto(attempt),
                                current: {
                                    cursor: idx,
                                    result: {
                                        attemptAnswerId: aa._id,
                                        isCorrect: aa.isCorrect,
                                        correctOptionId,
                                        correctAnswers,
                                    },
                                },
                                next: null,
                                finished: true,
                                canFinish: true,
                                batchAppended: false,
                                message: "Hết câu hỏi (INFINITE).",
                            });
                        }
                    } else {
                        return res.json({
                            attempt: attemptDto(attempt),
                            current: {
                                cursor: idx,
                                result: {
                                    attemptAnswerId: aa._id,
                                    isCorrect: aa.isCorrect,
                                    correctOptionId,
                                    correctAnswers,
                                },
                            },
                            next: null,
                            finished: true,
                            canFinish: true,
                            batchAppended: false,
                        });
                    }
                }

                const nextQid = attempt.questionIds[nextCursor];
                const nextQ = await Question.findById(nextQid).lean();
                if (!nextQ) {
                    return res.json({
                        attempt: attemptDto(attempt),
                        current: {
                            cursor: idx,
                            result: {
                                attemptAnswerId: aa._id,
                                isCorrect: aa.isCorrect,
                                correctOptionId,
                                correctAnswers,
                            },
                        },
                        next: null,
                        finished: true,
                        canFinish: true,
                        batchAppended,
                        message: "Không tìm thấy câu tiếp theo.",
                    });
                }

                const includeWordInfo = attempt.mode === "LEARN";
                const [nextDto] = await buildQuestionDtos([nextQ], includeWordInfo);
                const [mergedNext] = await attachAttemptAnswers({ attemptId: attempt._id, questionsDto: [nextDto] });

                return res.json({
                    attempt: attemptDto(attempt),
                    current: {
                        cursor: idx,
                        result: {
                            attemptAnswerId: aa._id,
                            isCorrect: aa.isCorrect,
                            correctOptionId,
                            correctAnswers,
                        },
                    },
                    batchAppended,
                    next: { cursor: nextCursor, question: mergedNext },
                    finished: false,
                });
            }

            // Normal flow: grade & save lần đầu
            const graded = await gradeAndSaveAttemptAnswer({ aa, question, selectedOptionId, answerText });
            if (!graded.ok) {
                return res.status(graded.status).json({ message: graded.message });
            }

            let nextCursor = idx + 1;
            let batchAppended = false;

            if (nextCursor >= attempt.questionIds.length) {
                if (attempt.mode === "INFINITE") {
                    if (!attempt.userId) return res.status(401).json({ message: "Chế độ này yêu cầu đăng nhập." });

                    const rs = await ensureInfiniteNextBatchIfNeeded(attempt);
                    batchAppended = rs.appended;

                    if (!rs.appended) {
                        return res.json({
                            attempt: attemptDto(attempt),
                            current: {
                                cursor: idx,
                                result: {
                                    attemptAnswerId: aa._id,
                                    isCorrect: graded.isCorrect,
                                    correctOptionId: graded.correctOptionId ?? null,
                                    correctAnswers: graded.correctAnswers ?? null,
                                },
                            },
                            next: null,
                            finished: true,
                            canFinish: true,
                            batchAppended: false,
                            message: "Hết câu hỏi (INFINITE).",
                        });
                    }
                } else {
                    return res.json({
                        attempt: attemptDto(attempt),
                        current: {
                            cursor: idx,
                            result: {
                                attemptAnswerId: aa._id,
                                isCorrect: graded.isCorrect,
                                correctOptionId: graded.correctOptionId ?? null,
                                correctAnswers: graded.correctAnswers ?? null,
                            },
                        },
                        next: null,
                        finished: true,
                        canFinish: true,
                        batchAppended: false,
                    });
                }
            }

            const nextQid = attempt.questionIds[nextCursor];
            const nextQ = await Question.findById(nextQid).lean();
            if (!nextQ) {
                return res.json({
                    attempt: attemptDto(attempt),
                    current: {
                        cursor: idx,
                        result: {
                            attemptAnswerId: aa._id,
                            isCorrect: graded.isCorrect,
                            correctOptionId: graded.correctOptionId ?? null,
                            correctAnswers: graded.correctAnswers ?? null,
                        },
                    },
                    next: null,
                    finished: true,
                    canFinish: true,
                    batchAppended,
                    message: "Không tìm thấy câu tiếp theo.",
                });
            }

            const includeWordInfo = attempt.mode === "LEARN";
            const [nextDto] = await buildQuestionDtos([nextQ], includeWordInfo);
            const [mergedNext] = await attachAttemptAnswers({ attemptId: attempt._id, questionsDto: [nextDto] });

            return res.json({
                attempt: attemptDto(attempt),
                current: {
                    cursor: idx,
                    result: {
                        attemptAnswerId: aa._id,
                        isCorrect: graded.isCorrect,
                        correctOptionId: graded.correctOptionId ?? null,
                        correctAnswers: graded.correctAnswers ?? null,
                    },
                },
                batchAppended,
                next: { cursor: nextCursor, question: mergedNext },
                finished: false,
            });
        } catch (e) {
            return res.status(500).json({ message: "Lỗi server.", error: e.message });
        }
    },

    /**
     * GET /quiz-attempts/:attemptId?page=1&pageSize=10
     */
    async getAttempt(req, res) {
        try {
            const { attemptId } = req.params;
            const { page = 1, pageSize = 10 } = req.query;

            const attempt = await QuizAttempt.findById(attemptId).lean();
            if (!attempt) return res.status(404).json({ message: "Attempt không tồn tại." });

            if (!isOwnerAttempt(attempt, req)) {
                return res.status(403).json({ message: "Không có quyền truy cập attempt." });
            }

            const p = Math.max(1, parseInt(page, 10) || 1);
            const ps = Math.max(1, Math.min(parseInt(pageSize, 10) || 10, 50));

            const total = attempt.questionIds.length;
            const totalPages = Math.ceil(total / ps);
            const skip = (p - 1) * ps;

            const pageIds = attempt.questionIds.slice(skip, skip + ps);
            if (!pageIds.length) {
                return res.json({
                    attempt: attemptDto(attempt),
                    page: p,
                    pageSize: ps,
                    totalQuestions: total,
                    totalPages,
                    questions: [],
                });
            }

            const questions = await Question.find({ _id: { $in: pageIds } }).lean();

            const qById = new Map(questions.map((q) => [String(q._id), q]));
            const orderedQuestions = pageIds.map((id) => qById.get(String(id))).filter(Boolean);

            const includeWordInfo = attempt.mode === "LEARN";
            const questionsDto = await buildQuestionDtos(orderedQuestions, includeWordInfo);
            const merged = await attachAttemptAnswers({ attemptId: attempt._id, questionsDto });

            return res.json({
                attempt: attemptDto(attempt),
                page: p,
                pageSize: ps,
                totalQuestions: total,
                totalPages,
                questions: merged,
            });
        } catch (e) {
            return res.status(500).json({ message: "Lỗi server.", error: e.message });
        }
    },

    /**
     * POST /quiz-attempts/:attemptId/next-batch
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

            const more = await Question.find({
                isActive: true,
                deletedAt: null,
                _id: { $nin: attempt.questionIds },
            })
                .sort({ _id: 1 })
                .limit(INFINITE_BATCH_SIZE)
                .lean();

            if (!more.length) {
                return res.json({ items: [], message: "Hết câu hỏi.", totalQuestions: attempt.questionIds.length });
            }

            const existedNow = new Set(attempt.questionIds.map((x) => String(x)));
            const newIds = more.map((q) => q._id).filter((id) => !existedNow.has(String(id)));

            if (!newIds.length) {
                return res.json({
                    items: [],
                    message: "Không có câu mới (có thể bạn bấm next-batch liên tục).",
                    totalQuestions: attempt.questionIds.length,
                });
            }

            attempt.questionIds.push(...newIds);
            attempt.totalQuestions = attempt.questionIds.length;
            await attempt.save();

            try {
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
            } catch (err) {
                if (err?.code !== 11000) throw err;
            }

            const qById = new Map(more.map((q) => [String(q._id), q]));
            const orderedMore = newIds.map((id) => qById.get(String(id))).filter(Boolean);

            const questionsDto = await buildQuestionDtos(orderedMore, false);
            const items = await attachAttemptAnswers({ attemptId: attempt._id, questionsDto });

            return res.json({ items, totalQuestions: attempt.totalQuestions });
        } catch (e) {
            return res.status(500).json({ message: "Lỗi server.", error: e.message });
        }
    },

    /**
     * PUT /attempt-answers/:attemptAnswerId
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

            const graded = await gradeAndSaveAttemptAnswer({ aa, question, selectedOptionId, answerText });
            if (!graded.ok) return res.status(graded.status).json({ message: graded.message });

            return res.json({
                attemptAnswerId: aa._id,
                isCorrect: graded.isCorrect,
                correctOptionId: graded.correctOptionId ?? null,
                correctAnswers: graded.correctAnswers ?? null,
            });
        } catch (e) {
            return res.status(500).json({ message: "Lỗi server.", error: e.message });
        }
    },

    /**
     * POST /quiz/attempts/:attemptId/finish
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

            const isUser = !!attempt.userId;
            let earnedXP = 0;
            if (isUser && attempt.mode !== "LEARN") {
                earnedXP = correct * 5;
            }
            attempt.earnedXP = earnedXP;

            attempt.status = "FINISHED";
            attempt.finishedAt = new Date();
            await attempt.save();

            // SR update only for user + TOPIC
            if (isUser && attempt.mode === "TOPIC") {
                const now = new Date();
                const NEW_DATE = new Date("1950-01-01T00:00:00.000Z");
                const DAY_MS = 24 * 60 * 60 * 1000;

                const questions = await Question.find({ _id: { $in: attempt.questionIds } })
                    .select("_id wordId")
                    .lean();

                const qToWord = new Map(questions.map((q) => [String(q._id), String(q.wordId)]));

                const wordAgg = new Map();
                for (const a of answers) {
                    const wid = qToWord.get(String(a.questionId));
                    if (!wid) continue;

                    if (!wordAgg.has(wid)) wordAgg.set(wid, { anyWrong: false, anyCorrect: false });

                    const st = wordAgg.get(wid);
                    if (a.isCorrect === false) st.anyWrong = true;
                    if (a.isCorrect === true) st.anyCorrect = true;
                }

                for (const [wordId, st] of wordAgg.entries()) {
                    let p = await UserWordProgress.findOne({ userId: attempt.userId, wordId });

                    if (!p) {
                        p = await UserWordProgress.create({
                            userId: attempt.userId,
                            wordId,
                            studyLevel: 0,
                            nextReviewDate: NEW_DATE,
                            lastReviewDate: null,
                            reviewState: "NEW",
                        });
                    }

                    const oldLevel = Number(p.studyLevel || 0);

                    if (st.anyWrong) {
                        const newLevel = Math.floor(oldLevel / 2);
                        p.studyLevel = newLevel;
                        p.lastReviewDate = now;
                        p.nextReviewDate = new Date(now.getTime() + 0.25 * DAY_MS);
                        p.reviewState = "REVIEW";
                    } else if (st.anyCorrect) {
                        const newLevel = oldLevel + 1;
                        p.studyLevel = newLevel;
                        p.lastReviewDate = now;
                        const days = 0.25 * Math.pow(2, newLevel);
                        p.nextReviewDate = new Date(now.getTime() + days * DAY_MS);
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
                status: attempt.status,
            });
        } catch (e) {
            return res.status(500).json({ message: "Lỗi server.", error: e.message });
        }
    },

    /**
     * GET /quiz-attempts?mode=&topicId=&from=&to=&page=1&pageSize=20
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

            const mapped = items.map((it) => ({
                attemptId: it._id,
                mode: it.mode,
                topicId: it.topicId ?? null,
                level: it.level ?? null,
                totalQuestions: it.totalQuestions ?? 0,
                correctAnswers: it.correctAnswers ?? 0,
                earnedXP: it.earnedXP ?? 0,
                status: it.status,
                createdAt: it.createdAt,
                finishedAt: it.finishedAt ?? null,
            }));

            return res.json({ page: p, pageSize: ps, total, totalPages, items: mapped });
        } catch (e) {
            return res.status(500).json({ message: "Lỗi server.", error: e.message });
        }
    },

    /**
     * GET /quiz-attempts/:attemptId/review
     */
    async review(req, res) {
        try {
            const { attemptId } = req.params;

            const attempt = await QuizAttempt.findById(attemptId).lean();
            if (!attempt) return res.status(404).json({ message: "Attempt không tồn tại." });

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
            })
                .select("_id questionId content isCorrect")
                .lean();

            const optByQ = new Map();
            for (const o of options) {
                const k = String(o.questionId);
                if (!optByQ.has(k)) optByQ.set(k, []);
                optByQ.get(k).push({ _id: o._id, content: o.content, isCorrect: o.isCorrect });
            }

            const ansByQ = new Map(answers.map((a) => [String(a.questionId), a]));

            const includeWordInfo = true; // ✅ luôn bật
            let wordById = new Map();

            const rawIds = [...new Set(questions.map((q) => q.wordId).filter(Boolean).map((id) => String(id)))];
            const objIds = rawIds.map(toObjectIdMaybe).filter(Boolean);

            const words = rawIds.length
                ? await Word.find({
                    $or: [{ _id: { $in: objIds } }, { _id: { $in: rawIds } }, { wordId: { $in: rawIds } }],
                }).lean()
                : [];

            for (const w of words) {
                wordById.set(String(w._id), w);
                if (w.wordId != null) wordById.set(String(w.wordId), w);
            }

            const qById = new Map(questions.map((q) => [String(q._id), q]));
            const orderedQuestions = attempt.questionIds.map((id) => qById.get(String(id))).filter(Boolean);

            const items = orderedQuestions.map((q) => {
                const a = ansByQ.get(String(q._id)) || null;
                const w = includeWordInfo ? wordById.get(String(q.wordId)) || null : null;

                return {
                    question: {
                        questionId: q._id,
                        content: q.content,
                        questionType: q.questionType,
                        wordId: q.wordId ?? null,
                        word: includeWordInfo ? pickWordInfo(w) : null,
                        hint: includeWordInfo ? buildHintFromWord(w) : "",

                        // ✅ NEW: phục vụ ReviewAnswersView
                        explanation: includeWordInfo ? buildExplanationFromWord(w) : "",
                        example: includeWordInfo ? buildExampleFromWord(w) : "",
                    },
                    options: optByQ.get(String(q._id)) || [],
                    userAnswer: a
                        ? {
                            selectedOptionId: a.selectedOptionId ?? null,
                            answerText: a.answerText ?? null,
                            isCorrect: a.isCorrect ?? null,
                            answeredAt: a.answeredAt ?? null,
                        }
                        : null,
                };
            });

            return res.json({
                attempt: attemptDto(attempt),
                items,
            });
        } catch (e) {
            return res.status(500).json({ message: "Lỗi server.", error: e.message });
        }
    },

    /**
     * POST /quiz-attempts/:attemptId/abandon
     */
    async abandon(req, res) {
        try {
            const { attemptId } = req.params;

            const attempt = await QuizAttempt.findById(attemptId);
            if (!attempt) return res.status(404).json({ message: "Attempt không tồn tại." });

            if (!isOwnerAttempt(attempt, req)) return res.status(403).json({ message: "Không có quyền." });

            if (attempt.status !== "IN_PROGRESS") {
                return res.status(400).json({ message: "Attempt đã kết thúc/bỏ." });
            }

            attempt.status = "ABANDONED";
            await attempt.save();

            return res.json({ message: "Đã bỏ quiz.", attemptId: attempt._id, status: attempt.status });
        } catch (e) {
            return res.status(500).json({ message: "Lỗi server.", error: e.message });
        }
    },
};
