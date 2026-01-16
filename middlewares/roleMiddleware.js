// roleMiddleware.js
const authorizeRoles = (...allowedRoles) => {
    const allowed = allowedRoles.map((r) => String(r).toUpperCase());

    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ message: "Chưa xác thực." });
        }

        const role = String(req.user.role || "").toUpperCase();
        if (!allowed.includes(role)) {
            return res.status(403).json({ message: "Bạn không có quyền truy cập." });
        }

        next();
    };
};

module.exports = authorizeRoles;
