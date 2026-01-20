// src/utils/profanity.js

function removeDiacritics(s) {
    return s.normalize("NFD").replace(/\p{M}+/gu, "");
}

function deLeet(s) {
    const map = {
        "0": "o",
        "1": "i",
        "2": "z",
        "3": "e",
        "4": "a",
        "5": "s",
        "6": "g",
        "7": "t",
        "8": "b",
        "9": "g",
        "@": "a",
        "$": "s",
    };
    return s.replace(/[0-9@$]/g, (ch) => map[ch] ?? ch);
}

function normalizeForCheck(input) {
    let s = String(input ?? "").normalize("NFKC").toLowerCase();
    s = removeDiacritics(s);
    s = deLeet(s);

    // ký tự hay được dùng để chèn / lách
    s = s.replace(/[_\-+.|/\\]+/g, " ");
    s = s.replace(/\s+/g, " ").trim();

    const compact = s.replace(/[^\p{L}\p{N}]+/gu, "");
    return { spaced: s, compact };
}

function tokens(spaced) {
    return spaced.match(/[\p{L}\p{N}]+/gu) ?? [];
}

// Placeholder: bạn thay bằng danh sách thật của bạn
const BANNED_TERMS_VI = [
    "djt", "đjt", "vcl", "vãi", "địt", "lồn", "cặc", "đụ", "buồi", "đéo", "đĩ", "đần", "ngu", "đần", "óc chó", "cứt", "đm", "dm", "cc", "cl", "vl", "vãi", "bựa", "bựa", "đụ mẹ", "đụ bố", "đụ con", "mẹ kiếp", "đm mẹ", "đm bố", "đm con", "tởm lợm", "thối tha"
];
const BANNED_TERMS_EN = [
    "fuck", "shit", "damn", "hell", "ass", "bitch", "bastard", "motherfucker", "cunt", "slut", "dickhead", "dick", "piss", "wank", "bollocks"
];

const DEFAULT_BANNED = [...BANNED_TERMS_VI, ...BANNED_TERMS_EN];

// precompute cho nhanh
const BANNED_COMPACT = DEFAULT_BANNED.map((t) => normalizeForCheck(t).compact);

// Trả về {ok:true} hoặc {ok:false, hit:"..."}
function checkDisplayNameProfanity(name, { bannedTerms = DEFAULT_BANNED } = {}) {
    if (name == null) return { ok: true }; // không check khi clear/undefined
    const raw = String(name).trim();
    if (!raw) return { ok: true };

    const { spaced, compact } = normalizeForCheck(raw);

    // nếu caller truyền bannedTerms mới thì compute lại; không truyền thì dùng precompute
    const bannedList = bannedTerms === DEFAULT_BANNED
        ? { terms: DEFAULT_BANNED, compactList: BANNED_COMPACT }
        : {
            terms: bannedTerms,
            compactList: bannedTerms.map((t) => normalizeForCheck(t).compact),
        };

    const toks = tokens(spaced).map((t) => normalizeForCheck(t).compact);

    // A) match theo token (giảm false positive)
    for (const t of toks) {
        for (let i = 0; i < bannedList.compactList.length; i++) {
            if (t && t === bannedList.compactList[i]) {
                return { ok: false, hit: bannedList.terms[i] };
            }
        }
    }

    // B) match theo compact contains (bắt kiểu b.a.d)
    for (let i = 0; i < bannedList.compactList.length; i++) {
        const bad = bannedList.compactList[i];
        if (bad && bad.length >= 3 && compact.includes(bad)) {
            return { ok: false, hit: bannedList.terms[i] };
        }
    }

    return { ok: true };
}

module.exports = { checkDisplayNameProfanity };
