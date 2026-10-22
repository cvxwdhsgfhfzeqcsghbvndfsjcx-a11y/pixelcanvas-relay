
const express = require("express");
const multer = require("multer");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const app = express();
const PORT = process.env.PORT || 10000;
const TOKEN = process.env.STREAM_TOKEN;

if (!TOKEN) {
    throw new Error("Missing STREAM_TOKEN environment variable");
}

app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Cache-Control", "no-store");

    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
});

app.use(express.json({ limit: "10kb" }));

const upload = multer({
    dest: os.tmpdir(),
    limits: { fileSize: 100 * 1024 * 1024 }
});

let sequence = 0;
let latestFrame = null;
let streaming = false;
let currentProcess = null;
let currentUploadPath = null;
let activeJob = 0;

function authorize(req, res, next) {
    if (req.get("Authorization") !== `Bearer ${TOKEN}`) {
        return res.status(401).json({ error: "Unauthorized" });
    }
    next();
}

function stopCurrentJob() {
    activeJob++;
    streaming = false;
    latestFrame = null;

    if (currentProcess) {
        currentProcess.kill("SIGTERM");
        currentProcess = null;
    }

    if (currentUploadPath) {
        try {
            fs.unlinkSync(currentUploadPath);
        } catch {}
        currentUploadPath = null;
    }
}

function byteHex(value) {
    return value.toString(16).padStart(2, "0").toUpperCase();
}

function makePalette(rgb) {
    const pixels = [];

    for (let i = 0; i < rgb.length; i += 3) {
        pixels.push([rgb[i], rgb[i + 1], rgb[i + 2]]);
    }

    function getRanges(box) {
        let minR = 255, minG = 255, minB = 255;
        let maxR = 0, maxG = 0, maxB = 0;

        for (const p of box) {
            minR = Math.min(minR, p[0]);
            minG = Math.min(minG, p[1]);
            minB = Math.min(minB, p[2]);
            maxR = Math.max(maxR, p[0]);
            maxG = Math.max(maxG, p[1]);
            maxB = Math.max(maxB, p[2]);
        }

        return [maxR - minR, maxG - minG, maxB - minB];
    }

    const boxes = [pixels];

    while (boxes.length < 16) {
        let selected = -1;
        let bestScore = -1;

        for (let i = 0; i < boxes.length; i++) {
            if (boxes[i].length < 2) continue;

            const ranges = getRanges(boxes[i]);
            const score = Math.max(...ranges) * Math.log2(boxes[i].length + 1);

            if (score > bestScore) {
                bestScore = score;
                selected = i;
            }
        }

        if (selected < 0) break;

        const box = boxes[selected];
        const ranges = getRanges(box);
        let channel = 0;

        if (ranges[1] > ranges[channel]) channel = 1;
        if (ranges[2] > ranges[channel]) channel = 2;

        box.sort((a, b) => a[channel] - b[channel]);

        const middle = Math.floor(box.length / 2);
        boxes.splice(selected, 1, box.slice(0, middle), box.slice(middle));
    }

    const palette = boxes.map(box => {
        let r = 0, g = 0, b = 0;

        for (const p of box) {
            r += p[0];
            g += p[1];
            b += p[2];
        }

        return [
            Math.round(r / box.length),
            Math.round(g / box.length),
            Math.round(b / box.length)
        ];
    });

    while (palette.length < 16) {
        palette.push(palette[palette.length - 1] || [0, 0, 0]);
    }

    return palette.slice(0, 16);
}

function encodeFrame(rgb) {
    const palette = makePalette(rgb);
    let paletteHex = "";

    for (const color of palette) {
        paletteHex += color.map(byteHex).join("");
    }

    let indexes = "";

    for (let i = 0, p = 0; i < 40000; i++, p += 3) {
        let best = 0;
        let bestDistance = Infinity;

        for (let c = 0; c < 16; c++) {
            const color = palette[c];
            const dr = rgb[p] - color[0];
            const dg = rgb[p + 1] - color[1];
            const db = rgb[p + 2] - color[2];

            const distance = dr * dr + 1.15 * dg * dg + 0.85 * db * db;

            if (distance < bestDistance) {
                bestDistance = distance;
                best = c;
            }
        }

        indexes += best.toString(16).toUpperCase();
    }

    return paletteHex + ":" + indexes;
}

app.get("/", (req, res) => {
    res.type("text").send("PixelCanvas relay is online.");
});

app.get("/health", (req, res) => {
    res.json({ ok: true, streaming });
});

app.post("/upload-video", authorize, upload.single("video"), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: "Choose a video file." });
    }

    const fps = Number(req.body.fps || 2);
    const loop = req.body.loop === "true";

    if (!Number.isInteger(fps) || fps < 1 || fps > 4) {
        fs.unlink(req.file.path, () => {});
        return res.status(400).json({ error: "FPS must be from 1 to 4." });
    }

    stopCurrentJob();

    const job = activeJob;
    currentUploadPath = req.file.path;
    latestFrame = null;
    streaming = true;

    const args = ["-hide_banner", "-loglevel", "error"];

    if (loop) {
        args.push("-stream_loop", "-1");
    }

    args.push(
        "-re",
        "-i", req.file.path,
        "-vf",
        `fps=${fps},scale=200:200:force_original_aspect_ratio=decrease,pad=200:200:(ow-iw)/2:(oh-ih)/2,setsar=1`,
        "-an",
        "-f", "rawvideo",
        "-pix_fmt", "rgb24",
        "pipe:1"
    );

    const child = spawn("ffmpeg", args, {
        stdio: ["ignore", "pipe", "pipe"]
    });

    currentProcess = child;

    const frameBytes = 200 * 200 * 3;
    let pending = Buffer.alloc(0);
    let stderr = "";

    child.stderr.on("data", chunk => {
        stderr = (stderr + chunk.toString()).slice(-3000);
    });

    child.stdout.on("data", chunk => {
        if (job !== activeJob) return;

        pending = Buffer.concat([pending, chunk]);

        while (pending.length >= frameBytes) {
            const rawFrame = pending.subarray(0, frameBytes);
            pending = pending.subarray(frameBytes);

            try {
                latestFrame = encodeFrame(rawFrame);
                sequence++;
            } catch (error) {
                console.error("Frame conversion failed:", error);
            }
        }
    });

    child.on("error", error => {
        console.error("FFmpeg failed:", error.message);
    });

    child.on("close", code => {
        if (job !== activeJob) return;

        streaming = false;
        currentProcess = null;

        if (currentUploadPath) {
            try {
                fs.unlinkSync(currentUploadPath);
            } catch {}
            currentUploadPath = null;
        }

        if (code !== 0) {
            console.error("FFmpeg exit:", code, stderr);
        }

        console.log("Video playback finished. FFmpeg exit:", code);
    });

    res.json({
        ok: true,
        message: "Upload received. Cloud playback has started.",
        fps,
        looping: loop
    });
});

app.get("/next", authorize, (req, res) => {
    const after = Number(req.query.after || 0);

    if (!Number.isSafeInteger(after) || after < 0) {
        return res.status(400).json({ error: "Invalid sequence." });
    }

    if (!streaming || !latestFrame || sequence <= after) {
        return res.status(204).end();
    }

    res.json({
        sequence,
        frame: latestFrame
    });
});

app.post("/stop", authorize, (req, res) => {
    stopCurrentJob();
    res.json({ ok: true });
});

app.listen(PORT, "0.0.0.0", () => {
    console.log("PixelCanvas cloud relay listening on port " + PORT);
});
