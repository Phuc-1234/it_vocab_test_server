// src/services/mail.js
const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
    host: process.env.MAIL_HOST,
    port: Number(process.env.MAIL_PORT || 587),
    secure: false,
    auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS },
});

async function sendOtpMail(to, code, purpose) {
    const subject = purpose === "reset_password" ? "Mã đặt lại mật khẩu" : "Mã xác thực";
    await transporter.sendMail({
        from: process.env.MAIL_USER,
        to,
        subject,
        text: `Mã OTP: ${code}. Hết hạn sau ${process.env.OTP_TTL_MIN || 10} phút.`,
    });
}

module.exports = { sendOtpMail };
