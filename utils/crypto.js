// src/utils/crypto.js
const crypto = require("crypto");
const bcrypt = require("bcrypt");

const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

const hashPassword = async (plain) => bcrypt.hash(plain, 10);
const comparePassword = async (plain, hash) => bcrypt.compare(plain, hash);

module.exports = { sha256, hashPassword, comparePassword };
