// src/services/mail.js
const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
    host: process.env.MAIL_HOST,
    port: Number(process.env.MAIL_PORT || 587),
    secure: false,
    auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS },
});

async function sendOtpMail(to, code, purpose) {
    const subject =
        purpose === "reset_password" ? "Mã đặt lại mật khẩu" : "Mã xác thực";
    const mailUserAddress = process.env.MAIL_USER;

    const htmlEmail = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
        <p style="font-size: 16px; color: #555;">Chào bạn, đây là mã OTP xác thực cho IT Vocab Test:</p>
        
        <div style="text-align: center; margin: 30px 0;">
            <span style="display: inline-block; font-size: 32px; font-weight: bold; letter-spacing: 5px; color: #ff0000; background-color: #f8f9fa; padding: 15px 30px; border: 2px solid #ff002b; border-radius: 5px;">
            ${code}
            </span>
        </div>

        <p style="font-size: 14px; color: #777; text-align: center;">
            Mã này sẽ hết hạn sau <strong>${process.env.OTP_TTL_MIN || 10} phút</strong>.
        </p>
        
        <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;">
        
        <p style="font-size: 13px; color: #d9534f; font-weight: bold; text-align: center;">
             Lưu ý: Vì lý do bảo mật, tuyệt đối không chia sẻ mã này với bất kỳ ai.
        </p>
        </div>
        `;

    await transporter.sendMail({
        from: ` Support - IT Vocab Test <${mailUserAddress}> `,
        to,
        subject,
        html: htmlEmail,
    });
}

async function sendRateLimitAlert(to, ip, limiterType, windowMs, maxRequests) {
    const timestamp = new Date().toISOString();
    const subject = "🚨 Rate Limit Alert - IT Vocab Server";
    const mailUserAddress = process.env.MAIL_USER;
    const text =
        `Rate Limit Triggered\n\n` +
        `IP Address: ${ip}\n` +
        `Limiter Type: ${limiterType}\n` +
        `Window Duration: ${windowMs / 1000 / 60} minutes\n` +
        `Max Requests: ${maxRequests}\n` +
        `Time: ${timestamp}\n\n` +
        `Action: This IP has exceeded the rate limit and requests are being blocked.`;

    await transporter.sendMail({
        from: ` Support - IT Vocab Test <${mailUserAddress}> `,
        to,
        subject,
        text,
    });
}

module.exports = { sendOtpMail, sendRateLimitAlert };
