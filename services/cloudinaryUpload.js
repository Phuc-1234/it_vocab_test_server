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

const uploadFileToCloudinary = (file, folder = "uploads") => {
    return new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
            {
                folder: folder,
                resource_type: "auto", // Tự động nhận diện ảnh/video
            },
            (error, result) => {
                if (error) return reject(error);
                resolve({
                    url: result.secure_url,
                    publicId: result.public_id,
                });
            }
        );

        streamifier.createReadStream(file.buffer).pipe(uploadStream);
    });
};

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

    uploadFileToCloudinary,
};
