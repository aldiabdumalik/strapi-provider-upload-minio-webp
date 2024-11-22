const Minio = require("minio");
const mime = require("mime-types");
const Sharp = require("sharp");
const sizeOf = require("image-size"); // Untuk memeriksa apakah file adalah gambar berdasarkan buffer

module.exports = {
  init(providerOptions) {
    const { port, useSSL, endPoint, accessKey, secretKey, bucket, folder } =
      providerOptions;
    const isUseSSL = useSSL === "true" || useSSL === true;

    // Inisialisasi MinIO Client
    const MINIO = new Minio.Client({
      endPoint,
      port: +port || 9000,
      useSSL: isUseSSL,
      accessKey,
      secretKey,
    });

    // Fungsi pembantu untuk menghasilkan path dan URL file
    const getUploadPath = (file) => {
      const pathChunk = file.path ? `${file.path}/` : "";
      const path = folder ? `${folder}/${pathChunk}` : pathChunk;
      // if (isImage) return `${path}${file.hash}.webp`;
      return `${path}${file.hash}${file.ext}`;
    };

    const getHostPart = () => {
      const protocol = isUseSSL ? "https://" : "http://";
      const portSuffix =
        (isUseSSL && +port === 443) || (isUseSSL && +port === 80)
          ? ""
          : `:${port}`;
      return protocol + endPoint + portSuffix + "/";
    };

    const getFilePath = (file) => {
      const hostPart = getHostPart() + bucket + "/";
      return file.url.replace(hostPart, "");
    };

    const isImage = (file) => {
      if (!file.buffer && !file.ext) {
        return false;
      }

      try {
        const mimeType = mime.lookup(file.ext);
        if (!mimeType && file.buffer) {
          const dimensions = sizeOf(file.buffer);
          return dimensions ? true : false;
        }
        return mimeType && mimeType.startsWith("image/");
      } catch (err) {
        console.error("Error pada pemeriksaan ukuran gambar:", err);
        return false;
      }
    };

    const streamToBuffer = async (stream) => {
      return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on("data", (chunk) => chunks.push(chunk));
        stream.on("end", () => resolve(Buffer.concat(chunks)));
        stream.on("error", (err) => reject(err));
      });
    };

    return {
      // Metode upload stream (sama seperti upload biasa)
      uploadStream(file) {
        return this.upload(file);
      },

      // Metode utama upload dengan Sharp untuk memproses gambar
      upload(file) {
        return new Promise(async (resolve, reject) => {
          if (!isImage(file)) {
            // Jika file bukan gambar, unggah langsung tanpa Sharp
            const path = getUploadPath(file);
            const metaData = {
              "Content-Type":
                mime.lookup(file.ext) || "application/octet-stream",
            };

            MINIO.putObject(
              bucket,
              path,
              file.stream || Buffer.from(file.buffer, "binary"),
              metaData,
              (err, _etag) => {
                if (err) {
                  return reject(err);
                }

                // URL publik untuk file yang diunggah
                const hostPart = getHostPart();
                const filePath = `${bucket}/${path}`;
                file.url = `${hostPart}${filePath}`;
                resolve();
              }
            );
          } else {
            if (!file.buffer && file.stream) {
              console.log("Mengonversi stream ke buffer...");
              file.buffer = await streamToBuffer(file.stream);
            }

            if (!file.buffer || file.buffer.length === 0) {
              console.error("Buffer file tidak valid:", file);
              return reject(new Error("Buffer file tidak valid."));
            }

            // Jika gambar, proses dengan Sharp ke WebP
            const path = getUploadPath({ ...file, ext: ".webp" });
            const metaData = {
              "Content-Type": "image/webp",
            };

            Sharp(file.buffer)
              .toFormat("webp") // Ubah format ke WebP
              .webp({ quality: 90 }) // Opsi kompresi WebP
              .toBuffer()
              .then((buffer) => {
                MINIO.putObject(
                  bucket,
                  path,
                  buffer,
                  metaData,
                  (err, _etag) => {
                    if (err) {
                      return reject(err);
                    }

                    // URL publik untuk file yang diunggah
                    const hostPart = getHostPart();
                    const filePath = `${bucket}/${path}`;
                    file.ext = ".webp";
                    file.url = `${hostPart}${filePath}`;
                    file.name = `${file.hash}.webp`;
                    file.mime = "image/webp";

                    resolve();
                  }
                );
              })
              .catch((err) => reject(err)); // Tangani error Sharp
          }
        });
      },

      // Hapus file dari MinIO
      delete(file) {
        return new Promise((resolve, reject) => {
          const path = getFilePath(file);

          MINIO.removeObjects(bucket, [path], (err) => {
            if (err) {
              return reject(err);
            }
            resolve();
          });
        });
      },

      // Generate URL untuk file
      getSignedUrl(file) {
        return new Promise((resolve, reject) => {
          const url = new URL(file.url);

          if (url.hostname !== endPoint) {
            return resolve({ url: file.url });
          } else if (!url.pathname.startsWith(`/${bucket}/`)) {
            return resolve({ url: file.url });
          } else {
            const path = getFilePath(file);

            MINIO.presignedGetObject(bucket, path, 0, (err, presignedUrl) => {
              if (err) {
                return reject(err);
              }
              resolve({ url: presignedUrl });
            });
          }
        });
      },
    };
  },
};
