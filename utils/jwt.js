// src/utils/jwt.js
const jwt = require("jsonwebtoken");

function signAccessToken(payload) {
    return jwt.sign(payload, process.env.JWT_ACCESS_SECRET, { expiresIn: "15m" });
}

function signRefreshToken(payload) {
    return jwt.sign(payload, process.env.JWT_REFRESH_SECRET, { expiresIn: "7d" });
}

function signResetToken(payload) {
    return jwt.sign({ ...payload, purpose: "reset_password" }, process.env.JWT_RESET_SECRET, {
        expiresIn: "10m",
    });
}

function verifyRefreshToken(token) {
    return jwt.verify(token, process.env.JWT_REFRESH_SECRET);
}

function verifyResetToken(token) {
    return jwt.verify(token, process.env.JWT_RESET_SECRET);
}

module.exports = {
    signAccessToken,
    signRefreshToken,
    signResetToken,
    verifyRefreshToken,
    verifyResetToken,
};
