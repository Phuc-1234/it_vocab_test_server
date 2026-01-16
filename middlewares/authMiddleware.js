// authMiddleware.js
const jwt = require("jsonwebtoken");

function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;

    if (!process.env.JWT_ACCESS_SECRET) {
        return res.status(500).json({ message: "Server thiếu JWT_ACCESS_SECRET." });
    }

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({ message: "Vui lòng đăng nhập để tiếp tục." });
    }

    const token = authHeader.slice("Bearer ".length).trim();
    if (!token) {
        return res.status(401).json({ message: "Thiếu access token." });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);

        // Chuẩn hoá payload: bạn nên sign token có userId/role
        // Ví dụ payload: { userId, role, email }
        req.user = {
            userId: decoded.userId ?? decoded.id, // fallback nếu token cũ đang dùng "id"
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

module.exports = authMiddleware;
