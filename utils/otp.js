// src/utils/otp.js
function genOtp6() {
    return String(Math.floor(100000 + Math.random() * 900000));
}
module.exports = { genOtp6 };
