// controllers/quizAttemptController.js
const mongoose = require("mongoose");
const QuizAttempt = require("../models/QuizAttempt");
const AttemptAnswer = require("../models/AttemptAnswer");
const Question = require("../models/Question");
const AnswerOption = require("../models/AnswerOption");
const Word = require("../models/Word");
const Topic = require("../models/Topic");
const UserWordProgress = require("../models/UserWordProgress");
const User = require("../models/User");
const UserActivity = require("../models/UserActivity");
const Rank = require("../models/Rank");
const UserRankHistory = require("../models/UserRankHistory");
const UserEffect = require("../models/UserEffect");
const RewardInbox = require("../models/RewardInbox");
const StreakMilestone = require("../models/StreakMilestone");
const RankReward = require("../models/RankReward");
const StreakReward = require("../models/StreakReward");
const INFINITE_BATCH_SIZE = 10;

// ===== Helpers =====
const MODES = ["TOPIC", "RANDOM", "INFINITE", "LEARN"];

function shuffleCopy(arr) {
    const a = Array.isArray(arr) ? [...arr] : [];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

// ===== TZ helpers (VN / Asia/Ho_Chi_Minh = UTC+7) =====
const VN_TZ_OFFSET_MIN = 7 * 60;

function startOfDayWithOffset(date, tzOffsetMin = 0) {
    const ms = new Date(date).getTime();
    const shifted = new Date(ms + tzOffsetMin * 60 * 1000); // đưa về "giờ local" của TZ muốn tính
    shifted.setUTCHours(0, 0, 0, 0); // set 00:00 theo TZ đó (dựa trên UTC của shifted)
    return new Date(shifted.getTime() - tzOffsetMin * 60 * 1000); // trả về UTC Date để lưu DB
}

function diffDaysWithOffset(a, b, tzOffsetMin = 0) {
    const a0 = startOfDayWithOffset(a, tzOffsetMin).getTime();
    const b0 = startOfDayWithOffset(b, tzOffsetMin).getTime();
    return Math.floor((a0 - b0) / 86400000);
}


// ===== SR helpers =====
// (SR logic uses daysForLevel() + calcOverduePenalty() and is applied in finish() for TOPIC mode)
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

async function getFillCorrectContents({ question, optByQ, wordById }) {
    // 1) ưu tiên AnswerOption.isCorrect
    let contents = [];

    if (optByQ) {
        contents = (optByQ.get(String(question._id)) || [])
            .filter((o) => o.isCorrect)
            .map((o) => String(o.content || "").trim())
            .filter(Boolean);
    }

    // 2) fallback sang Word (term/word) nếu options rỗng
    if (!contents.length && question.wordId && wordById) {
        const w = wordById.get(String(question.wordId)) || null;
        const fallback = String(w?.term || w?.word || "").trim();
        if (fallback) contents = [fallback];
    }

    // unique
    return [...new Set(contents)];
}

async function computeRankInfo(userId) {
    const curHistory = await UserRankHistory.findOne({ userId, isCurrent: true })
        .sort({ achievedDate: -1 })
        .populate("rankId")
        .lean();

    const currentRankDoc =
        curHistory?.rankId || (await Rank.findOne({ rankLevel: 1 }).lean());

    const nextRankDoc = currentRankDoc
        ? await Rank.findOne({ rankLevel: Number(currentRankDoc.rankLevel) + 1 }).lean()
        : null;

    const currentRank = currentRankDoc
        ? {
            rankId: currentRankDoc._id,
            rankLevel: currentRankDoc.rankLevel,
            rankName: currentRankDoc.rankName,
            neededXP: currentRankDoc.neededXP,
        }
        : null;

    const nextRank = nextRankDoc
        ? {
            rankId: nextRankDoc._id,
            rankLevel: nextRankDoc.rankLevel,
            rankName: nextRankDoc.rankName,
            neededXP: nextRankDoc.neededXP,
        }
        : null;

    return { currentRank, nextRank };
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

async function computePrevRank(currentRankDoc) {
    if (!currentRankDoc?.neededXP) return { neededXP: 0 };

    const prev = await Rank.findOne({ neededXP: { $lt: currentRankDoc.neededXP } })
        .sort({ neededXP: -1 })
        .lean();

    return prev
        ? {
            rankId: prev._id,
            rankLevel: prev.rankLevel,
            rankName: prev.rankName,
            neededXP: prev.neededXP,
        }
        : { neededXP: 0 };
}

function buildRankProgress({ currentXP, prevRank, nextRank }) {
    const startXP = Number(prevRank?.neededXP ?? 0);
    const endXP = Number(nextRank?.neededXP ?? startXP);

    const total = Math.max(1, endXP - startXP);
    const current = Math.max(0, Math.min(total, Number(currentXP) - startXP));
    const remaining = Math.max(0, total - current);
    const percent = Math.max(0, Math.min(100, (current / total) * 100));

    // giữ key cũ (startEXP/endEXP) để FE khỏi sửa
    return { startEXP: startXP, endEXP: endXP, current, total, remaining, percent };
}


function startOfDay(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
}

function diffDays(a, b) {
    const ms = startOfDay(a).getTime() - startOfDay(b).getTime();
    return Math.floor(ms / (24 * 60 * 60 * 1000));
}

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
            options: shuffleCopy(optByQ.get(String(q._id)) || []),
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

        // lấy đáp án đúng từ AnswerOption.isCorrect (nếu có)
        const correctOpts = await AnswerOption.find({
            questionId: question._id,
            isCorrect: true,
            deletedAt: null,
            isActive: true,
        }).select("content").lean();

        let correctContents = correctOpts.map((o) => String(o.content || "").trim()).filter(Boolean);

        // fallback nếu không có correct option
        if (!correctContents.length && question.wordId) {
            const w = await Word.findById(question.wordId).select("term word").lean();
            const fallback = String(w?.term || w?.word || "").trim();
            if (fallback) correctContents = [fallback];
        }

        const normalized = normalizeFill(answerText);
        isCorrect = correctContents.some((c) => normalizeFill(c) === normalized);

        correctAnswers = correctContents; // để FE show

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
    /**
     * GET /quizzes/topics?page=1&pageSize=20
     * Nếu có req.user (đã login) -> attach progress theo attempt TOPIC gần nhất của từng (topicId, level)
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

            // Build items (topicId + level) for this page
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

                        // default (guest / chưa có attempt)
                        percentCorrect: 0,
                        xp: 10 * 10, // default 10 câu * 10
                        lastAttempt: null,
                    });
                }

                cursor = topicEnd;
            }

            // If logged in -> attach latest attempt per (topicId, level)
            const userId = req.user?.userId || null;
            if (userId && items.length) {
                const topicIds = [...new Set(items.map((it) => String(it.topicId)))].map(
                    (id) => new mongoose.Types.ObjectId(id)
                );

                const levels = [...new Set(items.map((it) => Number(it.level)))];

                // Lấy attempt FINISHED gần nhất cho mỗi (topicId, level)
                const latestAttempts = await QuizAttempt.aggregate([
                    {
                        $match: {
                            userId: new mongoose.Types.ObjectId(String(userId)),
                            mode: "TOPIC",
                            status: "FINISHED",
                            topicId: { $in: topicIds },
                            level: { $in: levels },
                        },
                    },
                    { $sort: { finishedAt: -1, createdAt: -1, _id: -1 } },
                    {
                        $group: {
                            _id: { topicId: "$topicId", level: "$level" },
                            doc: { $first: "$$ROOT" },
                        },
                    },
                    {
                        $project: {
                            _id: 0,
                            topicId: "$_id.topicId",
                            level: "$_id.level",
                            attemptId: "$doc._id",
                            totalQuestions: { $ifNull: ["$doc.totalQuestions", 0] },
                            correctAnswers: { $ifNull: ["$doc.correctAnswers", 0] },
                            earnedXP: { $ifNull: ["$doc.earnedXP", 0] },
                            finishedAt: "$doc.finishedAt",
                            createdAt: "$doc.createdAt",
                        },
                    },
                ]);

                const map = new Map();
                for (const a of latestAttempts) {
                    const key = `${String(a.topicId)}_${Number(a.level)}`;
                    const totalQ = Number(a.totalQuestions || 0);
                    const correct = Number(a.correctAnswers || 0);

                    const percentCorrect = totalQ > 0 ? Math.round((correct / totalQ) * 100) : 0;
                    const xp = totalQ * 10; // ✅ theo yêu cầu: total question * 10

                    map.set(key, {
                        percentCorrect,
                        xp,
                        lastAttempt: {
                            attemptId: a.attemptId,
                            totalQuestions: totalQ,
                            correctAnswers: correct,
                            finishedAt: a.finishedAt ?? null,
                        },
                    });
                }

                // merge into items
                for (const it of items) {
                    const key = `${String(it.topicId)}_${Number(it.level)}`;
                    const extra = map.get(key);
                    if (extra) {
                        it.percentCorrect = extra.percentCorrect;
                        it.xp = extra.xp;
                        it.lastAttempt = extra.lastAttempt;
                    }
                }
            }

            return res.json({ page: p, pageSize: ps, total, totalPages, items });
        } catch (e) {
            return res.status(500).json({ message: "Lỗi server.", error: e.message });
        }
    },

    // ========================================================
    // START (full) - dùng SR cho TOPIC/LEARN, giữ nguyên getTopicWordIdsBySR
    // ========================================================
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

            const n =
                m === "INFINITE"
                    ? INFINITE_BATCH_SIZE
                    : Math.max(1, Math.min(Number(totalQuestions || 10), 50));

            // ===== helper: dedupe by _id (giữ thứ tự) =====
            const uniqById = (arr) => {
                const seen = new Set();
                const out = [];
                for (const q of arr || []) {
                    const id = q?._id ? String(q._id) : "";
                    if (!id || seen.has(id)) continue;
                    seen.add(id);
                    out.push(q);
                }
                return out;
            };

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

                // ✅ SR: lấy word theo NextReviewDate sớm nhất (hàm giữ nguyên)
                // lấy dư để tránh thiếu câu do word không có question
                const srWordIds = await getTopicWordIdsBySR({
                    topicId,
                    level,
                    userId: req.user?.userId,
                    isGuest: !isUser,
                    limit: isUser ? n * 5 : n,
                });

                questions = await pickOneQuestionPerWord(srWordIds);

                if (questions.length > n) questions = questions.slice(0, n);

                // fallback bù nếu thiếu (hiếm)
                const existedIds = questions.map((q) => q._id).filter(Boolean);

                if (questions.length < n) {
                    const missing = n - questions.length;

                    const extra = await Question.aggregate([
                        {
                            $match: {
                                isActive: true,
                                deletedAt: null,
                                wordId: { $ne: null }, // LEARN cần hint/word
                                _id: { $nin: existedIds }, // không lấy lại câu đã có
                            },
                        },
                        { $sample: { size: missing } },
                    ]);

                    questions = [...questions, ...extra];
                }
            }

            // ✅ dedupe lần cuối để chắc chắn không có _id trùng
            questions = uniqById(questions);

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

            // ✅ insertMany: chịu lỗi duplicate (nếu race condition hoặc index)
            try {
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
            } catch (err) {
                if (err?.code !== 11000) throw err;
                // ignore dup (safe)
            }

            const firstId = attempt.questionIds[0];
            const firstQ = await Question.findById(firstId).lean();
            if (!firstQ) return res.status(500).json({ message: "Lỗi dữ liệu: thiếu câu đầu tiên." });

            const includeWordInfo = attempt.mode === "LEARN";
            const [firstDto] = await buildQuestionDtos([firstQ], includeWordInfo);
            const [mergedFirst] = await attachAttemptAnswers({
                attemptId: attempt._id,
                questionsDto: [firstDto],
            });

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
    // ========================================================
    // FINISH (full) - TOPIC update SR đúng bảng, LEARN/RANDOM/INFINITE không update
    // + Response trả thêm mode/topicId/level cho FE replay
    // + Fix streak/UserActivity theo ngày VN (UTC+7) dù server chạy UTC+0
    // ========================================================
    async finish(req, res) {
        const session = await mongoose.startSession();
        session.startTransaction();

        try {
            const { attemptId } = req.params;

            const attempt = await QuizAttempt.findById(attemptId).session(session);
            if (!attempt) {
                await session.abortTransaction();
                return res.status(404).json({ message: "Attempt không tồn tại." });
            }

            if (!isOwnerAttempt(attempt, req)) {
                await session.abortTransaction();
                return res.status(403).json({ message: "Không có quyền." });
            }

            if (attempt.status !== "IN_PROGRESS") {
                await session.abortTransaction();
                return res.status(400).json({ message: "Attempt đã kết thúc/bỏ." });
            }

            const answers = await AttemptAnswer.find({ attemptId: attempt._id })
                .session(session)
                .lean();

            const total = Array.isArray(attempt.questionIds) ? attempt.questionIds.length : 0;
            const correct = (answers || []).filter((a) => a.isCorrect === true).length;

            attempt.totalQuestions = total;
            attempt.correctAnswers = correct;

            const isUser = !!attempt.userId;

            // ===================== XP CALC (giữ nguyên logic của bạn) =====================
            let xpBase = 0;
            let xpMultiplier = 1;
            let xpMultiplierApplied = false;
            let xpMultiplierSource = null;
            let earnedXP = 0;

            if (isUser && attempt.mode !== "LEARN") {
                xpBase = correct * 10;
                if (total > 0 && correct === total) xpBase += 50;

                const now = new Date();
                const activeEffects = await UserEffect.find({
                    userId: attempt.userId,
                    isActive: true,
                    startAt: { $lte: now },
                    $or: [{ endAt: null }, { endAt: { $gte: now } }],
                })
                    .populate("sourceItemId")
                    .session(session)
                    .lean();

                let bestMultiplier = 1;
                let bestSource = null;

                for (const ef of activeEffects || []) {
                    const item = ef?.sourceItemId;
                    if (!item) continue;
                    if (String(item.effectType) === "XP_MULTIPLIER") {
                        const v = Number(item.effectValue);
                        if (Number.isFinite(v) && v > bestMultiplier) {
                            bestMultiplier = v;
                            bestSource = item;
                        }
                    }
                }

                xpMultiplier = bestMultiplier;
                xpMultiplierApplied = xpMultiplier > 1;

                earnedXP = xpMultiplierApplied ? Math.round(xpBase * xpMultiplier) : xpBase;

                if (bestSource) {
                    xpMultiplierSource = {
                        itemId: bestSource._id,
                        itemName: bestSource.itemName,
                        itemImageURL: bestSource.itemImageURL ?? null,
                        effectValue: bestSource.effectValue ?? null,
                    };
                }
            }

            attempt.earnedXP = earnedXP;

            attempt.status = "FINISHED";
            attempt.finishedAt = new Date();
            await attempt.save({ session });

            // ===================== UPDATE SR (only user + TOPIC) =====================
            if (isUser && attempt.mode === "TOPIC") {
                const nowSR = new Date();

                // load questions to get wordId
                const questionsSR = await Question.find({ _id: { $in: attempt.questionIds } })
                    .select("_id wordId")
                    .session(session)
                    .lean();

                const qToWord = new Map(
                    (questionsSR || [])
                        .filter((q) => q && q.wordId)
                        .map((q) => [String(q._id), String(q.wordId)])
                );

                // aggregate per word: nếu có bất kỳ sai/null => reset
                const wordAgg = new Map(); // wordId -> { hasWrong: boolean }
                for (const a of answers || []) {
                    const wid = qToWord.get(String(a.questionId));
                    if (!wid) continue;

                    const st = wordAgg.get(wid) || { hasWrong: false };
                    if (a.isCorrect !== true) st.hasWrong = true; // false/null => sai
                    wordAgg.set(wid, st);
                }

                for (const [wordId, st] of wordAgg.entries()) {
                    const wordObjId = new mongoose.Types.ObjectId(wordId);

                    // upsert progress
                    let p = await UserWordProgress.findOne({
                        userId: attempt.userId,
                        wordId: wordObjId,
                    }).session(session);

                    if (!p) {
                        const created = await UserWordProgress.create(
                            [
                                {
                                    userId: attempt.userId,
                                    wordId: wordObjId,
                                    studyLevel: 0,
                                    nextReviewDate: nowSR,
                                    lastReviewDate: null,
                                },
                            ],
                            { session }
                        );
                        p = created[0];
                    }

                    // overdue penalty first
                    const penalty = calcOverduePenalty(p.nextReviewDate, p.studyLevel, nowSR);
                    if (penalty > 0) {
                        p.studyLevel = Math.max(Number(p.studyLevel || 0) - penalty, 0);
                    }

                    // update level by result
                    if (st.hasWrong) {
                        p.studyLevel = 0;
                    } else {
                        p.studyLevel = Math.max(Number(p.studyLevel || 0), 0) + 1;
                    }

                    p.lastReviewDate = nowSR;
                    const days = daysForLevel(p.studyLevel);
                    p.nextReviewDate = new Date(nowSR.getTime() + days * 24 * 60 * 60 * 1000);

                    await p.save({ session });
                }
            }

            // ===================== UPDATE USER XP + STREAK + RANK + REWARDS (giữ nguyên, chỉ fix ngày VN) =====================
            let userPayload = null;
            let rankPayload = null;
            let rankProgress = null;
            const newRewards = [];

            if (isUser && attempt.mode !== "LEARN") {
                const user = await User.findById(attempt.userId).session(session);
                if (!user) {
                    await session.abortTransaction();
                    return res.status(404).json({ message: "User không tồn tại." });
                }

                const now = new Date();
                const today = startOfDayWithOffset(now, VN_TZ_OFFSET_MIN);

                user.currentXP = Number(user.currentXP || 0) + Number(earnedXP || 0);

                // streak logic
                let streakChanged = false;

                if (!user.lastStudyDate) {
                    user.currentStreak = 1;
                    user.longestStreak = Math.max(Number(user.longestStreak || 0), user.currentStreak);
                    user.lastStudyDate = today;
                    streakChanged = true;
                } else {
                    const days = diffDaysWithOffset(today, user.lastStudyDate, VN_TZ_OFFSET_MIN);

                    if (days === 1) {
                        user.currentStreak = Number(user.currentStreak || 0) + 1;
                        user.longestStreak = Math.max(Number(user.longestStreak || 0), user.currentStreak);
                        user.lastStudyDate = today;
                        streakChanged = true;
                    } else if (days > 1) {
                        user.currentStreak = 1;
                        user.lastStudyDate = today;
                        streakChanged = true;
                    }
                }

                // UserActivity theo ngày VN (không bị lệch UTC)
                await UserActivity.updateOne(
                    { userId: user._id, activityDate: today },
                    { $setOnInsert: { userId: user._id, activityDate: today, wasFrozen: false } },
                    { upsert: true, session }
                );

                // STREAK REWARD CHECK (giữ nguyên)
                if (streakChanged) {
                    const milestone = await StreakMilestone.findOne({ dayNumber: user.currentStreak })
                        .session(session)
                        .lean();

                    if (milestone) {
                        const hasStreakReward = await StreakReward.exists({ streakId: milestone._id }).session(session);

                        if (hasStreakReward) {
                            const existingInbox = await RewardInbox.findOne({
                                userId: user._id,
                                streakId: milestone._id,
                            }).session(session);

                            if (!existingInbox) {
                                const newInbox = await RewardInbox.create(
                                    [
                                        {
                                            userId: user._id,
                                            sourceType: "STREAK",
                                            streakId: milestone._id,
                                            claimedAt: null,
                                        },
                                    ],
                                    { session }
                                );

                                newRewards.push({
                                    type: "STREAK",
                                    name: milestone.streakTitle,
                                    dayNumber: milestone.dayNumber,
                                    inboxId: newInbox[0]._id,
                                });
                            }
                        }
                    }
                }

                // RANK / LEVEL UP LOGIC (giữ nguyên)
                let currentHistory = await UserRankHistory.findOne({
                    userId: user._id,
                    isCurrent: true,
                }).session(session);

                let currentRankDoc = null;
                if (currentHistory) {
                    currentRankDoc = await Rank.findById(currentHistory.rankId).session(session).lean();
                }

                if (!currentRankDoc) {
                    currentRankDoc = await Rank.findOne({ rankLevel: 1 }).session(session).lean();
                    const newHist = await UserRankHistory.create(
                        [
                            {
                                userId: user._id,
                                rankId: currentRankDoc._id,
                                achievedDate: now,
                                isCurrent: true,
                            },
                        ],
                        { session }
                    );
                    currentHistory = newHist[0];
                }

                const rankRewardCache = new Map();
                const hasRankReward = async (rankId) => {
                    const k = String(rankId);
                    if (rankRewardCache.has(k)) return rankRewardCache.get(k);
                    const ok = !!(await RankReward.exists({ rankId }).session(session));
                    rankRewardCache.set(k, ok);
                    return ok;
                };

                while (true) {
                    const nextRankDoc = await Rank.findOne({ rankLevel: currentRankDoc.rankLevel + 1 })
                        .session(session)
                        .lean();

                    if (!nextRankDoc) break;

                    const requiredXP = Number(nextRankDoc.neededXP || 0);

                    if (user.currentXP >= requiredXP) {
                        user.currentXP -= requiredXP;

                        if (currentHistory) {
                            await UserRankHistory.updateOne(
                                { _id: currentHistory._id },
                                { $set: { isCurrent: false, endedAt: now } },
                                { session }
                            );
                        }

                        const newHist = await UserRankHistory.create(
                            [
                                {
                                    userId: user._id,
                                    rankId: nextRankDoc._id,
                                    achievedDate: now,
                                    isCurrent: true,
                                    endedAt: null,
                                },
                            ],
                            { session }
                        );

                        if (await hasRankReward(nextRankDoc._id)) {
                            const existingInbox = await RewardInbox.findOne({
                                userId: user._id,
                                rankId: nextRankDoc._id,
                            }).session(session);

                            if (!existingInbox) {
                                const newInbox = await RewardInbox.create(
                                    [
                                        {
                                            userId: user._id,
                                            sourceType: "RANK",
                                            rankId: nextRankDoc._id,
                                            claimedAt: null,
                                        },
                                    ],
                                    { session }
                                );

                                newRewards.push({
                                    type: "RANK",
                                    rankName: nextRankDoc.rankName,
                                    rankLevel: nextRankDoc.rankLevel,
                                    inboxId: newInbox[0]._id,
                                });
                            }
                        }

                        currentHistory = newHist[0];
                        currentRankDoc = nextRankDoc;
                    } else {
                        break;
                    }
                }

                const targetRankDoc = await Rank.findOne({ rankLevel: currentRankDoc.rankLevel + 1 })
                    .session(session)
                    .lean();

                const totalNeed = targetRankDoc
                    ? Number(targetRankDoc.neededXP || 0)
                    : Number(currentRankDoc.neededXP || 100);

                const currentVal = Number(user.currentXP || 0);

                rankPayload = {
                    currentRank: {
                        rankId: currentRankDoc._id,
                        rankLevel: currentRankDoc.rankLevel,
                        rankName: currentRankDoc.rankName,
                        neededXP: currentRankDoc.neededXP,
                    },
                    nextRank: targetRankDoc
                        ? {
                            rankId: targetRankDoc._id,
                            rankLevel: targetRankDoc.rankLevel,
                            rankName: targetRankDoc.rankName,
                            neededXP: targetRankDoc.neededXP,
                        }
                        : null,
                };

                rankProgress = {
                    startEXP: 0,
                    endEXP: totalNeed,
                    current: currentVal,
                    total: totalNeed,
                    percent: Math.min(100, Math.max(0, (currentVal / Math.max(1, totalNeed)) * 100)),
                };

                await user.save({ session });

                userPayload = {
                    currentXP: user.currentXP,
                    currentStreak: user.currentStreak,
                    longestStreak: user.longestStreak,
                    lastStudyDate: user.lastStudyDate,
                };
            }

            await session.commitTransaction();

            return res.json({
                attempt: {
                    attemptId: attempt._id,
                    mode: attempt.mode,
                    topicId: attempt.topicId ?? null,
                    level: attempt.level ?? null,
                    totalQuestions: attempt.totalQuestions,
                    correctAnswers: attempt.correctAnswers,
                    earnedXP: attempt.earnedXP,
                    status: attempt.status,
                    finishedAt: attempt.finishedAt ?? null,
                },
                xpMeta: {
                    baseXP: xpBase,
                    multiplier: xpMultiplier,
                    applied: xpMultiplierApplied,
                    source: xpMultiplierSource,
                },
                ...(userPayload ? { user: userPayload } : {}),
                ...(rankPayload ? { rank: rankPayload } : {}),
                ...(rankProgress ? { rankProgress } : {}),
                newRewards: newRewards.length ? newRewards : [],
            });
        } catch (e) {
            await session.abortTransaction();
            console.error(e);
            return res.status(500).json({ message: "Lỗi server.", error: e.message });
        } finally {
            session.endSession();
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

                // ✅ recompute isCorrect for FILL_BLANK using normalized compare
                let isCorrectView = a?.isCorrect ?? null;
                if (q.questionType === "FILL_BLANK" && a?.answerText != null) {
                    const correctNorms = (optByQ.get(String(q._id)) || [])
                        .filter((o) => o.isCorrect)
                        .map((o) => normalizeFill(o.content));

                    if (correctNorms.length) {
                        isCorrectView = correctNorms.includes(normalizeFill(a.answerText));
                    }
                }

                return {
                    question: {
                        questionId: q._id,
                        content: q.content,
                        questionType: q.questionType,
                        wordId: q.wordId ?? null,
                        word: includeWordInfo ? pickWordInfo(w) : null,
                        hint: includeWordInfo ? buildHintFromWord(w) : "",
                        explanation: includeWordInfo ? buildExplanationFromWord(w) : "",
                        example: includeWordInfo ? buildExampleFromWord(w) : "",
                    },
                    options: shuffleCopy(optByQ.get(String(q._id)) || []),
                    userAnswer: a
                        ? {
                            selectedOptionId: a.selectedOptionId ?? null,
                            answerText: a.answerText ?? null,
                            isCorrect: isCorrectView, // ✅ dùng kết quả đã normalize
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
