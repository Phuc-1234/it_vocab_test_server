const jwt = require("jsonwebtoken");

function optionalAuth(req, res, next) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) return next();

    if (!process.env.JWT_ACCESS_SECRET) {
        return res.status(500).json({ message: "Server thiếu JWT_ACCESS_SECRET." });
    }

    const token = authHeader.slice("Bearer ".length).trim();
    if (!token) return next();

    try {
        const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
        req.user = {
            userId: decoded.userId ?? decoded.id,
            role: decoded.role,
            email: decoded.email,
            ...decoded,
        };
    } catch (e) {
        // token sai/hết hạn => coi như guest (không throw)
        req.user = null;
    }
    next();
}

module.exports = optionalAuth;
