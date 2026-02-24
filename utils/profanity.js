// src/utils/profanity.js

function removeDiacritics(s) {
    return s.normalize("NFD").replace(/\p{M}+/gu, "");
}

function deLeet(s) {
    const map = {
        "0": "o", "1": "i", "2": "z", "3": "e", "4": "a",
        "5": "s", "6": "g", "7": "t", "8": "b", "9": "g",
        "@": "a", "$": "s",
    };
    return s.replace(/[0-9@$]/g, (ch) => map[ch] ?? ch);
}

// Loại zero-width (hay dùng để lách)
function removeZeroWidth(s) {
    return s.replace(/[\u200B-\u200D\uFEFF\u2060]/g, "");
}

// Map một số homoglyph Cyrillic/Greek phổ biến sang Latin
function foldHomoglyphs(s) {
    const map = {
        // Cyrillic
        "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x", "і": "i", "ј": "j",
        // Greek
        "Α": "a", "α": "a", "Β": "b", "β": "b", "Ε": "e", "ε": "e", "Ι": "i", "ι": "i", "Ο": "o", "ο": "o",
        "Ρ": "p", "ρ": "p", "Τ": "t", "τ": "t", "Χ": "x", "χ": "x",
    };
    // lower trước để giảm map
    const low = s.toLowerCase();
    return low.replace(/[\u0370-\u03FF\u0400-\u04FF]/g, (ch) => map[ch] ?? ch);
}

// Co ký tự lặp quá đà: "loooon" -> "loon"
function squeezeRepeats(s) {
    return s.replace(/(.)\1{2,}/g, "$1$1");
}

// Normalize “mạnh” cho so khớp
function normalizeForMatch(s) {
    let x = String(s).normalize("NFKC");
    x = removeZeroWidth(x);
    x = foldHomoglyphs(x);

    // đổi tất cả ký tự không phải chữ/số thành khoảng trắng
    // (giải quyết d!i*t, d`i`t, d*i*t, v.v.)
    x = x.replace(/[^\p{L}\p{N}]+/gu, " ");

    // tách token rồi normalize từng token
    const toks = x.match(/[\p{L}\p{N}]+/gu) ?? [];
    const normToks = toks.map((t) => {
        let z = t.toLowerCase();
        z = removeDiacritics(z);
        z = deLeet(z);
        z = squeezeRepeats(z);
        return z;
    }).filter(Boolean);

    const spaced = normToks.join(" ").trim();
    const collapsed = spaced.replace(/\s+/g, "");
    return { spaced, collapsed, tokens: normToks };
}

const BANNED_TERMS_VI = [
    "djt", "đjt", "vcl", "vãi", "địt", "lồn", "cặc", "đụ", "buồi", "đéo", "đĩ", "đần", "ngu", "óc chó", "cứt",
    "đm", "dm", "cc", "cl", "vl", "bựa", "đụ mẹ", "đụ bố", "đụ con", "mẹ kiếp", "tởm lợm", "thối tha", "cak", "l0`n", "cặt", "d1t"
];
const BANNED_TERMS_EN = [
    "fuck", "shit", "damn", "hell", "ass", "bitch", "bastard", "motherfucker", "cunt", "slut", "dickhead", "dick", "piss", "wank", "bollocks", "diddy"
];

const ALLOWED_TERMS = [
    "ngữ", "ngủ", "ngụ", "ngự",
    "cút", "cụt",
    "đam", "đảm",
    "bùi", "bụi",
    "long", "loan",
    "nguyên", "nguyen",
    "ngọc", "ngoc",
    "đàm", "dam",
    "luân", "luan",
    "cường", "cuong",
    "vlad", "vladimir",
    "clara", "cloud"
];

const DEFAULT_BANNED = [...BANNED_TERMS_VI, ...BANNED_TERMS_EN];

// Precompute banned normalized forms
const BANNED_NORMALIZED = DEFAULT_BANNED.map((t) => {
    const { spaced, collapsed } = normalizeForMatch(t);
    return { raw: t, spaced, collapsed };
});

function checkDisplayNameProfanity(
    name,
    { bannedTerms = DEFAULT_BANNED, allowedTerms = ALLOWED_TERMS } = {}
) {
    if (name == null) return { ok: true };
    const raw = String(name).trim();
    if (!raw) return { ok: true };

    // 1) tách token gốc (giữ dấu) để whitelist theo đúng ý bạn
    const cleanedRaw = raw.replace(/[_\-+.|/\\]+/g, " ");
    const originalTokens = (cleanedRaw.match(/[\p{L}\p{N}]+/gu) ?? []).map(t => t.toLowerCase());

    // 2) bỏ whitelist tokens (nếu token nằm trong whitelist thì loại khỏi check)
    const tokensToCheck = originalTokens.filter(t => !allowedTerms.includes(t));

    // 3) normalize mạnh lại chuỗi từ tokensToCheck
    const { spaced, collapsed } = normalizeForMatch(tokensToCheck.join(" "));

    if (!spaced && !collapsed) return { ok: true };

    // 4) chọn banned list phù hợp (default có cache)
    const list = (bannedTerms === DEFAULT_BANNED)
        ? BANNED_NORMALIZED
        : bannedTerms.map((t) => {
            const n = normalizeForMatch(t);
            return { raw: t, spaced: n.spaced, collapsed: n.collapsed };
        });

    // 5) match theo 2 kiểu:
    // - spaced: bắt cụm từ theo ranh giới khoảng trắng
    // - collapsed: bắt trường hợp bị chèn ký tự/space và ghép liền từ khác
    const padded = ` ${spaced} `;
    for (const bad of list) {
        if (!bad.spaced && !bad.collapsed) continue;

        // match cụm từ theo token boundary
        if (bad.spaced && padded.includes(` ${bad.spaced} `)) {
            return { ok: false, hit: bad.raw };
        }

        // match dạng collapsed để bắt d!i*t, d i t, ditme, ...
        if (bad.collapsed && bad.collapsed.length >= 4 && collapsed.includes(bad.collapsed)) {
            return { ok: false, hit: bad.raw };
        }
    }

    return { ok: true };
}

module.exports = { checkDisplayNameProfanity };