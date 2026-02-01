import Fastify from "fastify";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import os from "os";
import multiparty from "multiparty";

const app = Fastify();
const TMP_DIR = "/tmp/ffmpeg";

// ✅ FIX: Tell Fastify to accept multipart/form-data
app.addContentTypeParser('multipart/form-data', function (request, payload, done) {
  done(null);
});

// Ensure temp dir exists
fs.mkdirSync(TMP_DIR, { recursive: true });

// Utility: save uploaded files
async function saveFiles(files) {
  return Promise.all(files.map(file => {
    const tempPath = path.join(TMP_DIR, file.originalFilename);
    return new Promise((res, rej) => {
      fs.copyFile(file.filepath, tempPath, err => err ? rej(err) : res(tempPath));
    });
  }));
}

// Utility: cleanup temp
function cleanup() {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

// ------------------ STEP 1: Merge Audio ------------------
app.post("/merge-audio", async (req, reply) => {
  const form = new multiparty.Form({ uploadDir: TMP_DIR });
  form.parse(req.raw, async (err, fields, files) => {  // ✅ Changed req to req.raw
    if (err) return reply.status(500).send(err.message);
    try {
      const audioFiles = await saveFiles(files.files);
      const output = path.join(TMP_DIR, "merged.mp3");

      // Build FFmpeg concat filter
      const inputs = audioFiles.flatMap(f => ["-i", f]);
      const filterComplex = `concat=n=${audioFiles.length}:v=0:a=1`;

      const ff = spawn("ffmpeg", [
        ...inputs,
        "-filter_complex", filterComplex,
        "-y",
        output
      ]);

      ff.on("close", code => {
        if (code !== 0) return reply.status(500).send("FFmpeg failed");
        const data = fs.readFileSync(output);
        cleanup();
        reply.type("audio/mpeg").send(data);
      });

    } catch (e) {
      cleanup();
      reply.status(500).send(e.message);
    }
  });
});

// ------------------ STEP 2: Images + Audio → Video ------------------
app.post("/images-to-video", async (req, reply) => {
  const form = new multiparty.Form({ uploadDir: TMP_DIR });
  form.parse(req.raw, async (err, fields, files) => {  // ✅ Changed req to req.raw
    if (err) return reply.status(500).send(err.message);
    try {
      const audioFile = await saveFiles(files.audio);
      const imageFiles = await saveFiles(files.images);

      const output = path.join(TMP_DIR, "video.mp4");

      // FFmpeg input pattern: rename images sequentially
      imageFiles.forEach((img, i) => {
        fs.renameSync(img, path.join(TMP_DIR, `img${String(i).padStart(3,'0')}.jpg`));
      });

      const ff = spawn("ffmpeg", [
        "-y",
        "-framerate", "1/5",
        "-i", path.join(TMP_DIR, "img%03d.jpg"),
        "-i", audioFile[0],
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-shortest",
        output
      ]);

      ff.on("close", code => {
        if (code !== 0) return reply.status(500).send("FFmpeg failed");
        const data = fs.readFileSync(output);
        cleanup();
        reply.type("video/mp4").send(data);
      });

    } catch (e) {
      cleanup();
      reply.status(500).send(e.message);
    }
  });
});

// ------------------ STEP 3: Burn Captions ------------------
app.post("/burn-captions", async (req, reply) => {
  const form = new multiparty.Form({ uploadDir: TMP_DIR });
  form.parse(req.raw, async (err, fields, files) => {  // ✅ Changed req to req.raw
    if (err) return reply.status(500).send(err.message);
    try {
      const videoFile = await saveFiles(files.video);
      const captionFile = await saveFiles(files.captions);

      const output = path.join(TMP_DIR, "final.mp4");

      const ff = spawn("ffmpeg", [
        "-y",
        "-i", videoFile[0],
        "-vf", `ass=${captionFile[0]}`,
        "-c:a", "copy",
        output
      ]);

      ff.on("close", code => {
        if (code !== 0) return reply.status(500).send("FFmpeg failed");
        const data = fs.readFileSync(output);
        cleanup();
        reply.type("video/mp4").send(data);
      });

    } catch (e) {
      cleanup();
      reply.status(500).send(e.message);
    }
  });
});

// ------------------ Start Server ------------------
app.listen({ host: "0.0.0.0", port: 8080 }, err => {
  if (err) console.error(err);
  else console.log("FFmpeg API running on port 8080");
});
