// src/models/Rank.model.js
const mongoose = require("mongoose");

const RankSchema = new mongoose.Schema(
    {
        // _id = RankID
        // ✅ bỏ index:true để tránh duplicate (vì đã có RankSchema.index ở dưới)
        rankLevel: { type: Number, required: true, min: 1 },

        neededEXP: { type: Number, required: true, min: 0 },

        rankName: { type: String, required: true, trim: true, maxlength: 100 },

        rewardItemId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Item",
            default: null,
        },
    },
    { timestamps: true }
);

// ✅ unique index cho rankLevel
RankSchema.index({ rankLevel: 1 }, { unique: true });

const Rank = mongoose.model("Rank", RankSchema);

/* ===================== AUTO SEED DEFAULT RANKS ===================== */

// cấu hình seed
const MAX_LEVEL = 50;      // đổi số cấp tại đây
const START_EXP_LV2 = 100; // level 2 cần 100 exp
const MULTIPLIER = 1.5;    // nhân 1.5 mỗi cấp
const ROUNDING = "round";  // "round" | "ceil" | "floor"

let _seedStarted = false;

function _getRoundFn() {
    if (ROUNDING === "ceil") return Math.ceil;
    if (ROUNDING === "floor") return Math.floor;
    return Math.round;
}

async function seedDefaultRanksIfEmpty() {
    if (_seedStarted) return;
    _seedStarted = true;

    try {
        const hasAny = await Rank.exists({});
        if (hasAny) return;

        const roundFn = _getRoundFn();
        const docs = [];

        // Level 1
        docs.push({
            rankLevel: 1,
            neededEXP: 0,
            rankName: "Rank 1",
            rewardItemId: null,
        });

        // Level 2
        let prev = START_EXP_LV2;
        docs.push({
            rankLevel: 2,
            neededEXP: START_EXP_LV2,
            rankName: "Rank 2",
            rewardItemId: null,
        });

        // Level 3..MAX_LEVEL
        for (let lvl = 3; lvl <= MAX_LEVEL; lvl++) {
            prev = roundFn(prev * MULTIPLIER);
            docs.push({
                rankLevel: lvl,
                neededEXP: prev,
                rankName: `Rank ${lvl}`,
                rewardItemId: null,
            });
        }

        await Rank.insertMany(docs, { ordered: false });
        console.log(`[Rank] Seeded default ranks: 1..${MAX_LEVEL}`);
    } catch (err) {
        if (err && err.code === 11000) {
            console.warn("[Rank] Seed skipped (duplicate rankLevel).");
            return;
        }
        console.error("[Rank] Seed failed:", err);
    }
}

function ensureSeedWhenConnected() {
    const conn = mongoose.connection;

    if (conn.readyState === 1) {
        seedDefaultRanksIfEmpty();
        return;
    }

    const onConnected = () => seedDefaultRanksIfEmpty();
    conn.once("open", onConnected);
    conn.once("connected", onConnected);
}

ensureSeedWhenConnected();

/* =================================================================== */

module.exports = Rank;
