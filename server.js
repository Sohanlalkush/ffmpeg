import Fastify from "fastify";
import fs from "fs";
import path from "path";
import { spawn, execSync } from "child_process";
import multiparty from "multiparty";

const app = Fastify({ logger: true });
const TMP_DIR = "/tmp/ffmpeg";

// Fix for Fastify to accept multipart/form-data
app.addContentTypeParser('multipart/form-data', function (request, payload, done) {
  done(null);
});

// Ensure temp dir exists
fs.mkdirSync(TMP_DIR, { recursive: true });

// Utility: save uploaded files
async function saveFiles(files) {
  if (!files || files.length === 0) {
    throw new Error("No files provided");
  }
  
  return Promise.all(files.map(file => {
    const tempPath = path.join(TMP_DIR, file.originalFilename);
    return new Promise((res, rej) => {
      fs.copyFile(file.path, tempPath, err => {
        if (err) {
          console.error(`Error copying ${file.path} to ${tempPath}:`, err);
          rej(err);
        } else {
          console.log(`Copied ${file.path} to ${tempPath}`);
          res(tempPath);
        }
      });
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
  return new Promise((resolve, reject) => {
    const form = new multiparty.Form({ uploadDir: TMP_DIR });
    form.parse(req.raw, async (err, fields, files) => {
      if (err) {
        reply.status(500).send(err.message);
        return reject(err);
      }
      
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
          if (code !== 0) {
            cleanup();
            reply.status(500).send("FFmpeg failed");
            return reject(new Error("FFmpeg failed"));
          }
          const data = fs.readFileSync(output);
          cleanup();
          reply.type("audio/mpeg").send(data);
          resolve();
        });

      } catch (e) {
        cleanup();
        reply.status(500).send(e.message);
        reject(e);
      }
    });
  });
});


// ------------------ STEP 2: Images + Audio → Video (Auto Duration + Outro File) ------------------
app.post("/images-to-video", async (req, reply) => {
  console.log("=== Request received ===");
  
  return new Promise((resolve, reject) => {
    const form = new multiparty.Form({ uploadDir: TMP_DIR });
    
    form.parse(req.raw, async (err, fields, files) => {
      console.log("=== Form parsed ===");
      console.log("Files keys:", Object.keys(files));
      
      if (err) {
        console.error("Parse error:", err);
        reply.status(500).send(err.message);
        return reject(err);
      }
      
      try {
        if (!files.audio || !files.images) {
          console.error("Missing files - audio:", !!files.audio, "images:", !!files.images);
          reply.status(400).send("Missing audio or images");
          return reject(new Error("Missing files"));
        }
        
        const audioFile = await saveFiles(files.audio);
        const imageFiles = await saveFiles(files.images);
        
        // Check for optional outro file
        let outroFile = null;
        if (files.outro) {
          const outroFiles = await saveFiles(files.outro);
          outroFile = outroFiles[0];
          console.log("Outro file:", outroFile);
        }
        
        console.log("Images:", imageFiles);

        // Parse settings with defaults
        let settings = {
          duration: "auto",
          effect: "zoom_in_out",
          vignette: true,
          zoom_intensity: 0.1,
          width: 1080,
          height: 1920,
          outro_duration: 2  // Duration for outro in seconds
        };

        if (fields.settings && fields.settings[0]) {
          try {
            const parsed = JSON.parse(fields.settings[0]);
            settings = { ...settings, ...parsed };
          } catch (e) {
            console.error("Settings parse error, using defaults:", e.message);
          }
        }

        // Calculate duration if set to "auto"
let duration = settings.duration;
let audioDuration = 0; // Track total audio duration

if (duration === "auto") {
  const audioPath = audioFile[0];
  try {
    const ffprobeOutput = execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`,
      { encoding: 'utf8' }
    );
    audioDuration = parseFloat(ffprobeOutput.trim());
    const imageCount = imageFiles.length;
    
    // If outro is provided, subtract outro duration from content
    const contentDuration = outroFile 
      ? audioDuration - settings.outro_duration 
      : audioDuration;
    
    duration = contentDuration / imageCount; // Now duration is a number
    
    console.log(`Auto duration: Audio=${audioDuration}s, Images=${imageCount}, PerImage=${duration.toFixed(2)}s, Outro=${outroFile ? settings.outro_duration + 's' : 'none'}`);
  } catch (err) {
    console.error("Failed to get audio duration, using default 5s:", err.message);
    duration = 5;
    audioDuration = imageFiles.length * 5;
  }
} else {
  duration = Number(duration) || 5; // Convert to number
  // Calculate expected audio duration
  audioDuration = (duration * imageFiles.length) + (outroFile ? settings.outro_duration : 0);
}

// Ensure duration is a number
duration = Number(duration);

const effect = settings.effect;
const vignette = settings.vignette;
const zoomIntensity = settings.zoom_intensity || 0.1;
const width = settings.width || 1080;
const height = settings.height || 1920;
const fps = 25;
const totalFrames = Math.round(duration * fps); // Round frames

console.log(`Final settings: ${width}x${height}, ${duration.toFixed(2)}s per image, total video: ${audioDuration.toFixed(2)}s, effect: ${effect}`);

       
        const output = path.join(TMP_DIR, "video.mp4");

        // Build FFmpeg inputs with loop
        const ffmpegInputs = [];
        imageFiles.forEach(img => {
          ffmpegInputs.push("-loop", "1", "-framerate", String(fps), "-i", img);
        });

        // Add outro image input if available
        if (outroFile) {
          ffmpegInputs.push("-loop", "1", "-framerate", String(fps), "-i", outroFile);
        }

        // Build filter for each image with effects
        const imageFilters = imageFiles.map((img, i) => {
          let filter = `[${i}:v]`;
          
          const scaleMultiplier = effect !== "none" ? 1.4 : 1.0;
          const scaleWidth = Math.round(width * scaleMultiplier);
          const scaleHeight = Math.round(height * scaleMultiplier);
          
          filter += `scale=${scaleWidth}:${scaleHeight}:force_original_aspect_ratio=increase,crop=${width}:${height}`;
          
          if (effect === "zoom_in") {
            const maxZoom = 1 + zoomIntensity;
            filter += `,zoompan=z='min(1+${zoomIntensity}*on/${totalFrames},${maxZoom})':d=${totalFrames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${width}x${height}:fps=${fps}`;
          } else if (effect === "zoom_out") {
            const startZoom = 1 + zoomIntensity;
            filter += `,zoompan=z='if(lte(on,1),${startZoom},max(1.0,${startZoom}-${zoomIntensity}*on/${totalFrames}))':d=${totalFrames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${width}x${height}:fps=${fps}`;
          } else if (effect === "zoom_in_out") {
            const maxZoom = 1 + zoomIntensity;
            const halfFrames = totalFrames / 2;
            filter += `,zoompan=z='if(lt(on,${halfFrames}),1+${zoomIntensity}*on/${halfFrames},${maxZoom}-${zoomIntensity}*(on-${halfFrames})/${halfFrames})':d=${totalFrames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${width}x${height}:fps=${fps}`;
          } else if (effect === "zoom_out_in") {
            const maxZoom = 1 + zoomIntensity;
            const halfFrames = totalFrames / 2;
            filter += `,zoompan=z='if(lt(on,${halfFrames}),${maxZoom}-${zoomIntensity}*on/${halfFrames},1+${zoomIntensity}*(on-${halfFrames})/${halfFrames})':d=${totalFrames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${width}x${height}:fps=${fps}`;
          } else if (effect === "pulse") {
            filter += `,zoompan=z='1+${zoomIntensity}*sin(2*PI*on/${totalFrames})':d=${totalFrames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${width}x${height}:fps=${fps}`;
          } else if (effect === "pan_left") {
            filter += `,zoompan=z=1.1:d=${totalFrames}:x='iw-iw/zoom-(on*1.5)':y='ih/2-(ih/zoom/2)':s=${width}x${height}:fps=${fps}`;
          } else if (effect === "pan_right") {
            filter += `,zoompan=z=1.1:d=${totalFrames}:x='on*1.5':y='ih/2-(ih/zoom/2)':s=${width}x${height}:fps=${fps}`;
          } else {
            filter += `,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`;
          }
          
          filter += `,trim=duration=${duration},setpts=PTS-STARTPTS,setsar=1`; // ← This fixes it
          
          if (vignette) {
            filter += `,vignette=angle=PI/3`;
          }
          
          filter += `[v${i}]`;
          return filter;
        }).join(';');

        // Add outro filter if available
        let filterComplex = imageFilters;
        let concatInputs = imageFiles.map((_, i) => `[v${i}]`).join('');
        let concatCount = imageFiles.length;

        if (outroFile) {
          const outroIndex = imageFiles.length;
          const outroDuration = settings.outro_duration;
          
          let outroFilter = `[${outroIndex}:v]`;
          outroFilter += `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`;
          outroFilter += `,trim=duration=${outroDuration},setpts=PTS-STARTPTS`;
          outroFilter += `,fade=t=in:st=0:d=0.5`; // Fade in effect
          if (vignette) {
            outroFilter += `,vignette=angle=PI/3`;
          }
          outroFilter += `[voutro]`;
          
          filterComplex += `;${outroFilter}`;
          concatInputs += '[voutro]';
          concatCount++;
        }

        filterComplex += `;${concatInputs}concat=n=${concatCount}:v=1:a=0[v]`;

        const ffmpegArgs = [
  "-y",
  ...ffmpegInputs,
  "-i", audioFile[0],
  "-filter_complex", filterComplex,
  "-map", "[v]",
  "-map", `${imageFiles.length + (outroFile ? 1 : 0)}:a`,
  "-c:v", "libx264",
  "-pix_fmt", "yuv420p",
  "-r", String(fps),
  "-c:a", "aac",
  "-t", String(audioDuration), // Use exact audio duration instead of -shortest
  output
];

        
        console.log("FFmpeg command:", "ffmpeg", ffmpegArgs.join(" "));
        
        const ff = spawn("ffmpeg", ffmpegArgs);
        ff.stderr.on('data', (data) => console.log('FFmpeg:', data.toString()));

        ff.on("close", code => {
          console.log(`FFmpeg exited with code ${code}`);
          
          if (code !== 0) {
            cleanup();
            reply.status(500).send("FFmpeg failed");
            return reject(new Error("FFmpeg failed"));
          }
          
          const data = fs.readFileSync(output);
          console.log(`Sending video: ${data.length} bytes`);
          cleanup();
          reply.type("video/mp4").send(data);
          resolve();
        });

      } catch (e) {
        console.error("Error:", e);
        cleanup();
        reply.status(500).send(e.message);
        reject(e);
      }
    });
  });
});


// ------------------ STEP 2B: Videos + Audio → Final Video (with transitions & outro) ------------------
app.post("/videos-to-video", async (req, reply) => {
  console.log("=== Videos-to-Video Request received ===");
  
  return new Promise((resolve, reject) => {
    const form = new multiparty.Form({ uploadDir: TMP_DIR });
    
    form.parse(req.raw, async (err, fields, files) => {
      console.log("=== Form parsed ===");
      console.log("Files keys:", Object.keys(files));
      
      if (err) {
        console.error("Parse error:", err);
        reply.status(500).send(err.message);
        return reject(err);
      }
      
      try {
        if (!files.audio || !files.videos) {
          console.error("Missing files - audio:", !!files.audio, "videos:", !!files.videos);
          reply.status(400).send("Missing audio or videos");
          return reject(new Error("Missing files"));
        }
        
        const audioFile = await saveFiles(files.audio);
        const videoFiles = await saveFiles(files.videos);
        
        // Check for optional outro file
        let outroFile = null;
        if (files.outro) {
          const outroFiles = await saveFiles(files.outro);
          outroFile = outroFiles[0];
          console.log("Outro file:", outroFile);
        }
        
        console.log("Videos:", videoFiles);

        // Parse settings with defaults
        let settings = {
          duration: "auto",
          vignette: true,
          width: 1080,
          height: 1920,
          outro_duration: 2,
          mode: "fit", // "fit" (trim/loop) or "speed" (speed adjust)
          transition: "none", // "none", "fade", "wipeleft", "wiperight", "slideup", "slidedown", "circlecrop", "circleopen"
          transition_duration: 0.5
        };

        if (fields.settings && fields.settings[0]) {
          try {
            const parsed = JSON.parse(fields.settings[0]);
            settings = { ...settings, ...parsed };
          } catch (e) {
            console.error("Settings parse error, using defaults:", e.message);
          }
        }

        // Get audio duration
        let audioDuration = 0;
        const audioPath = audioFile[0];
        try {
          const ffprobeOutput = execSync(
            `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`,
            { encoding: 'utf8' }
          );
          audioDuration = parseFloat(ffprobeOutput.trim());
          console.log(`Audio duration: ${audioDuration}s`);
        } catch (err) {
          console.error("Failed to get audio duration:", err.message);
          reply.status(400).send("Failed to read audio file");
          return reject(err);
        }

        // Calculate target content duration (subtract outro if exists)
        const contentDuration = outroFile 
          ? audioDuration - settings.outro_duration 
          : audioDuration;

        // Get each video's duration
        const videoInfos = await Promise.all(videoFiles.map(async (videoPath) => {
          try {
            const durationOutput = execSync(
              `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`,
              { encoding: 'utf8' }
            );
            return {
              path: videoPath,
              duration: parseFloat(durationOutput.trim())
            };
          } catch (err) {
            console.error(`Failed to get duration for ${videoPath}:`, err.message);
            return { path: videoPath, duration: 5 }; // fallback
          }
        }));

        const totalVideoDuration = videoInfos.reduce((sum, v) => sum + v.duration, 0);
        console.log(`Total video duration: ${totalVideoDuration}s, Target: ${contentDuration}s`);

        const width = settings.width || 1080;
        const height = settings.height || 1920;
        const vignette = settings.vignette;
        const transition = settings.transition || "none";
        const transitionDuration = settings.transition_duration || 0.5;
        const fps = 25;

        const output = path.join(TMP_DIR, "video.mp4");

        // Build FFmpeg inputs
        const ffmpegInputs = [];
        videoFiles.forEach(vid => {
          ffmpegInputs.push("-i", vid);
        });

        // Add outro if provided
        if (outroFile) {
          ffmpegInputs.push("-loop", "1", "-framerate", String(fps), "-i", outroFile);
        }

        // Build filter for each video
        let filterComplex = "";
        const processedStreams = [];
        const targetDurationPerVideo = contentDuration / videoFiles.length;

        if (settings.mode === "speed") {
          // Speed adjustment mode
          const speedFactor = totalVideoDuration / contentDuration;
          console.log(`Speed adjustment factor: ${speedFactor.toFixed(3)}x`);

          videoInfos.forEach((info, i) => {
            let filter = `[${i}:v]`;
            filter += `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`;
            filter += `,setpts=${speedFactor}*PTS`;
            filter += `,setsar=1`;
            if (vignette) {
              filter += `,vignette=angle=PI/3`;
            }
            filter += `[v${i}]`;
            processedStreams.push(`[v${i}]`);
            filterComplex += filter + ";";
          });

        } else {
          // Fit mode: trim or loop each video

          videoInfos.forEach((info, i) => {
            let filter = `[${i}:v]`;
            
            filter += `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`;
            
            if (info.duration > targetDurationPerVideo) {
              // Video is longer - trim it
              filter += `,trim=duration=${targetDurationPerVideo},setpts=PTS-STARTPTS`;
              console.log(`Video ${i}: Trimming ${info.duration}s → ${targetDurationPerVideo.toFixed(2)}s`);
            } else if (info.duration < targetDurationPerVideo) {
              // Video is shorter - loop it
              const loops = Math.ceil(targetDurationPerVideo / info.duration);
              filter += `,loop=${loops}:size=32767:start=0`;
              filter += `,trim=duration=${targetDurationPerVideo},setpts=PTS-STARTPTS`;
              console.log(`Video ${i}: Looping ${info.duration}s × ${loops} → ${targetDurationPerVideo.toFixed(2)}s`);
            } else {
              filter += `,setpts=PTS-STARTPTS`;
            }
            
            filter += `,setsar=1`;
            
            if (vignette) {
              filter += `,vignette=angle=PI/3`;
            }
            
            filter += `[v${i}]`;
            processedStreams.push(`[v${i}]`);
            filterComplex += filter + ";";
          });
        }

        // Apply transitions between videos
        let finalStream = processedStreams[0];
        
        if (transition !== "none" && processedStreams.length > 1) {
          let currentOffset = targetDurationPerVideo - transitionDuration;
          
          for (let i = 1; i < processedStreams.length; i++) {
            const input1 = i === 1 ? processedStreams[0] : `[trans${i-1}]`;
            const input2 = processedStreams[i];
            const output = i === processedStreams.length - 1 ? '[vtrans]' : `[trans${i}]`;
            
            filterComplex += `${input1}${input2}xfade=transition=${transition}:duration=${transitionDuration}:offset=${currentOffset}${output};`;
            currentOffset += targetDurationPerVideo;
          }
          
          finalStream = '[vtrans]';
        } else if (processedStreams.length > 1) {
          // No transitions, just concat
          filterComplex += `${processedStreams.join('')}concat=n=${processedStreams.length}:v=1:a=0[vmain];`;
          finalStream = '[vmain]';
        }

        // Add outro if available
        if (outroFile) {
          const outroIndex = videoFiles.length;
          const outroDuration = settings.outro_duration;
          
          let outroFilter = `[${outroIndex}:v]`;
          outroFilter += `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`;
          outroFilter += `,trim=duration=${outroDuration},setpts=PTS-STARTPTS,setsar=1`;
          outroFilter += `,fade=t=in:st=0:d=0.5`;
          if (vignette) {
            outroFilter += `,vignette=angle=PI/3`;
          }
          outroFilter += `[voutro];`;
          
          filterComplex += outroFilter;
          
          // Add transition to outro if enabled
          if (transition !== "none") {
            filterComplex += `${finalStream}[voutro]xfade=transition=fade:duration=${transitionDuration}:offset=${contentDuration - transitionDuration}[v]`;
          } else {
            filterComplex += `${finalStream}[voutro]concat=n=2:v=1:a=0[v]`;
          }
        } else {
          // No outro, rename final stream to [v]
          filterComplex = filterComplex.replace(finalStream, '[v]');
        }

        console.log(`Final settings: ${width}x${height}, Mode: ${settings.mode}, Transition: ${transition}, Vignette: ${vignette}`);

        const ffmpegArgs = [
          "-y",
          ...ffmpegInputs,
          "-i", audioFile[0],
          "-filter_complex", filterComplex,
          "-map", "[v]",
          "-map", `${videoFiles.length + (outroFile ? 1 : 0)}:a`,
          "-c:v", "libx264",
          "-pix_fmt", "yuv420p",
          "-r", String(fps),
          "-c:a", "aac",
          "-t", String(audioDuration),
          output
        ];
        
        console.log("FFmpeg command:", "ffmpeg", ffmpegArgs.join(" "));
        
        const ff = spawn("ffmpeg", ffmpegArgs);
        ff.stderr.on('data', (data) => console.log('FFmpeg:', data.toString()));

        ff.on("close", code => {
          console.log(`FFmpeg exited with code ${code}`);
          
          if (code !== 0) {
            cleanup();
            reply.status(500).send("FFmpeg failed");
            return reject(new Error("FFmpeg failed"));
          }
          
          const data = fs.readFileSync(output);
          console.log(`Sending video: ${data.length} bytes`);
          cleanup();
          reply.type("video/mp4").send(data);
          resolve();
        });

      } catch (e) {
        console.error("Error:", e);
        cleanup();
        reply.status(500).send(e.message);
        reject(e);
      }
    });
  });
});


// ------------------ STEP 3: Burn Captions (Updated for local/Docker) ------------------
app.post("/burn-captions", async (req, reply) => {
  return new Promise((resolve, reject) => {
    const form = new multiparty.Form({ uploadDir: TMP_DIR });
    form.parse(req.raw, async (err, fields, files) => {
      if (err) {
        reply.status(500).send(err.message);
        return reject(err);
      }
      
      try {
        if (!files.video || !files.captions) {
          reply.status(400).send("Missing video or captions file");
          return reject(new Error("Missing required files"));
        }
        
        const videoFile = await saveFiles(files.video);
        const captionFile = await saveFiles(files.captions);
        
        // Parse settings if provided
        let settings = {};
        if (fields.settings) {
          settings = JSON.parse(fields.settings[0]);
        }
        
        const language = settings.language || "en";
        const position = settings.position || "bottom_center";
        const linecolor = settings.line_color?.replace('#', '') || "FFFFFF";
        const wordcolor = settings.word_color?.replace('#', '') || "FFFF00";
        const outlinecolor = settings.outline_color?.replace('#', '') || "000000";
        const fontsize = settings.font_size || 32;
        const bold = settings.bold !== false ? -1 : 0;
        const italic = settings.italic === true ? -1 : 0;
        const outlinewidth = settings.outline_width || 2;
        const shadowoffset = settings.shadow_offset || 2;
        
        console.log(`Processing with language: ${language}`);
        
        // Read ASS file and modify it with settings
        let assContent = fs.readFileSync(captionFile[0], 'utf-8');
        
        // Replace or inject style with settings
        const alignmentMap = {
          "left": 1, "center": 2, "right": 3,
          "top_left": 7, "top_center": 8, "top_right": 9,
          "bottom_left": 1, "bottom_center": 2, "bottom_right": 3
        };
        const alignValue = alignmentMap[position.toLowerCase()] || 2;
        const marginV = position.includes("top") ? 20 : 50;
        
        // Use language code as font name (will be mapped by fontconfig)
        const styleRegex = /Style: Default,[^,]+,\d+,[^,]+,[^,]+,[^,]+,[^,]+,[^,]+,[^,]+,[^,]+,[^,]+,[^,]+,[^,]+,[^,]+,[^,]+,[^,]+,[^,]+,[^,]+,[^,]+,[^,]+,[^,]+,[^\n]+/;
        
        const newStyle = `Style: Default,${language},${fontsize},&H00${linecolor},&H000000FF,&H00${outlinecolor},&H80000000,${bold},${italic},0,0,100,100,0,0,1,${outlinewidth},${shadowoffset},${alignValue},10,10,${marginV},1`;
        
        if (styleRegex.test(assContent)) {
          assContent = assContent.replace(styleRegex, newStyle);
          console.log("ASS style updated with font:", language);
        }
        
        // Save modified ASS
        const modifiedAssPath = path.join(TMP_DIR, "modified.ass");
        fs.writeFileSync(modifiedAssPath, assContent);

        const output = path.join(TMP_DIR, "final.mp4");
        
        // Set fontconfig environment
        const fontconfigPath = path.join(process.cwd(), 'fonts.conf');
        const fontsDir = path.join(process.cwd(), 'fonts');
        
        console.log("Using fontconfig:", fontconfigPath);
        console.log("Fonts directory:", fontsDir);
        
        // Build FFmpeg command with fontconfig
        const ff = spawn("ffmpeg", [
          "-y",
          "-i", videoFile[0],
          "-vf", `ass=${modifiedAssPath}`,
          "-c:v", "libx264",
          "-c:a", "copy",
          output
        ], {
          env: {
            ...process.env,
            FONTCONFIG_FILE: fontconfigPath,
            FC_DEBUG: "1"  // Enable debug to see font loading
          }
        });
        
        ff.stderr.on('data', (data) => console.log('FFmpeg:', data.toString()));

        ff.on("close", code => {
          if (code !== 0) {
            cleanup();
            reply.status(500).send("FFmpeg failed");
            return reject(new Error("FFmpeg failed"));
          }
          const data = fs.readFileSync(output);
          console.log(`Video with captions: ${data.length} bytes`);
          cleanup();
          reply.type("video/mp4").send(data);
          resolve();
        });

      } catch (e) {
        console.error("Error:", e);
        cleanup();
        reply.status(500).send(e.message);
        reject(e);
      }
    });
  });
});



// ------------------ Start Server ------------------
app.listen({ host: "0.0.0.0", port: 8080 }, err => {
  if (err) console.error(err);
  else console.log("FFmpeg API running on port 8080");
});
