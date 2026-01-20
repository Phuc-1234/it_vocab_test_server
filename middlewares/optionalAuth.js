// optionalAuth.js
const jwt = require("jsonwebtoken");

function optionalAuth(req, res, next) {
    const authHeader = req.headers.authorization;

    // Không gửi token => coi như guest
    if (!authHeader || !authHeader.startsWith("Bearer ")) return next();

    if (!process.env.JWT_ACCESS_SECRET) {
        return res.status(500).json({ message: "Server thiếu JWT_ACCESS_SECRET." });
    }

    const token = authHeader.slice("Bearer ".length).trim();
    if (!token) {
        return res.status(401).json({ message: "Thiếu access token." });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
        req.user = {
            userId: decoded.userId ?? decoded.id,
            role: decoded.role,
            email: decoded.email,
            ...decoded,
        };

        if (!req.user.userId) {
            return res.status(401).json({ message: "Token thiếu userId." });
        }

        return next();
    } catch (error) {
        if (error?.name === "TokenExpiredError") {
            return res.status(401).json({ message: "Token đã hết hạn." });
        }
        return res.status(401).json({ message: "Token không hợp lệ." });
    }
}

module.exports = optionalAuth;
