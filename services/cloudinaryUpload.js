// src/services/cloudinaryUpload.service.js
const streamifier = require("streamifier");
const cloudinary = require("../config/cloudinary");

function uploadBuffer({ buffer, folder, publicId }) {
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            {
                folder,
                public_id: publicId, // để overwrite 1 avatar/user
                overwrite: true,
                resource_type: "image",
            },
            (err, result) => {
                if (err) return reject(err);
                return resolve(result);
            }
        );

        streamifier.createReadStream(buffer).pipe(stream);
    });
}

module.exports = {
    async uploadAvatarToCloudinary({ userId, file }) {
        const result = await uploadBuffer({
            buffer: file.buffer,
            folder: "app/avatars",
            publicId: `user_${userId}`,
        });

        return {
            url: result.secure_url,
            publicId: result.public_id,
        };
    },
};
