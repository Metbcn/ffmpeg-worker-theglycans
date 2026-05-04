const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { compose, getDuration } = require('./compose');
const { scheduleCleanup } = require('./cleanup');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.FFMPEG_WORKER_API_KEY;
const OUTPUT_DIR = process.env.OUTPUT_DIR || '/app/output';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

if (!API_KEY) {
  console.error('[FATAL] FFMPEG_WORKER_API_KEY not set. Exiting.');
  process.exit(1);
}

// ── Middleware ──────────────────────────────────────────────────────────────

app.use(express.json({ limit: '1mb' }));

function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key || key !== API_KEY) {
    console.warn(`[AUTH] Rejected request from ${req.ip} — invalid or missing x-api-key`);
    return res.status(401).json({ error: 'Unauthorized: invalid x-api-key' });
  }
  next();
}

function requestLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} → ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
}

app.use(requestLogger);

// ── Static output serving ───────────────────────────────────────────────────

app.use('/output', express.static(OUTPUT_DIR));

// ── Multer — audio upload ───────────────────────────────────────────────────

const AUDIO_DIR = path.join(OUTPUT_DIR, 'audio');
fs.mkdirSync(AUDIO_DIR, { recursive: true });

const audioStorage = multer.diskStorage({
  destination: AUDIO_DIR,
  filename: (_req, _file, cb) => cb(null, `${uuidv4()}.mp3`)
});

const audioUpload = multer({
  storage: audioStorage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/webm', 'application/octet-stream'];
    cb(null, allowed.includes(file.mimetype) || file.originalname?.match(/\.(mp3|wav|webm|mpeg)$/i) != null);
  }
});

// ── Routes ──────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'ffmpeg-worker',
    timestamp: new Date().toISOString(),
    version: '1.1.0'
  });
});

app.post('/upload-audio', requireApiKey, audioUpload.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No audio file received. Send field name: audio' });
  }

  const VoiceURL = `${PUBLIC_BASE_URL}/output/audio/${req.file.filename}`;
  console.log(`[UPLOAD] Audio saved → ${req.file.filename} (${(req.file.size / 1024).toFixed(0)} KB)`);

  // Measure voice duration immediately after save so the workflow can log it
  // and validate before committing to the compose job.
  let voice_duration_seconds = null;
  try {
    voice_duration_seconds = await getDuration(req.file.path);
    console.log(`[UPLOAD] Voice duration: ${voice_duration_seconds.toFixed(3)}s`);
  } catch (err) {
    // Non-fatal — compose will measure again internally
    console.warn(`[UPLOAD] Could not measure audio duration: ${err.message}`);
  }

  scheduleCleanup(req.file.path);

  return res.json({ VoiceURL, voice_duration_seconds });
});

app.post('/compose', requireApiKey, async (req, res) => {
  const {
    VideoURL_1, VideoURL_2, VideoURL_3, VideoURL_4,
    VoiceURL, AudioURL, MusicStatus,
    durations: reqDurations
  } = req.body;

  // ── Validate required fields ──────────────────────────────────────────────
  const missing = [];
  if (!VideoURL_1) missing.push('VideoURL_1');
  if (!VideoURL_2) missing.push('VideoURL_2');
  if (!VideoURL_3) missing.push('VideoURL_3');
  if (!VideoURL_4) missing.push('VideoURL_4');
  if (!VoiceURL)   missing.push('VoiceURL');

  if (missing.length > 0) {
    return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
  }

  // ── Validate and parse durations ──────────────────────────────────────────
  // Durations should come from the n8n workflow (AI-generated segment durations).
  // If missing or invalid, fall back to equal distribution over 30s.
  let durations;
  if (Array.isArray(reqDurations) && reqDurations.length === 4) {
    durations = reqDurations.map(Number);
    if (durations.some(isNaN) || durations.some(d => d <= 0)) {
      return res.status(400).json({
        error: 'durations must be an array of 4 positive numbers (seconds per clip)'
      });
    }
  } else {
    durations = [7.5, 7.5, 7.5, 7.5];
    console.warn('[COMPOSE] No valid durations provided — using default [7.5, 7.5, 7.5, 7.5]');
  }

  console.log(
    `[COMPOSE] New job — durations: [${durations.join(', ')}], ` +
    `music: ${AudioURL ? 'yes' : 'no'}, MusicStatus: ${MusicStatus || 'skipped'}`
  );

  try {
    const result = await compose({
      videoUrls: [VideoURL_1, VideoURL_2, VideoURL_3, VideoURL_4],
      durations,
      voiceUrl:  VoiceURL,
      audioUrl:  AudioURL || null,
      outputDir: OUTPUT_DIR
    });

    const FinalVideoURL = `${PUBLIC_BASE_URL}/output/${result.filename}`;
    console.log(
      `[COMPOSE] Job ${result.jobId} complete → ${FinalVideoURL} ` +
      `| voice=${result.voice_duration_seconds.toFixed(2)}s ` +
      `| total=${result.total_duration.toFixed(2)}s`
    );

    scheduleCleanup(path.join(OUTPUT_DIR, result.filename));

    return res.json({
      FinalVideoURL,
      jobId:                  result.jobId,
      voice_duration_seconds: result.voice_duration_seconds,
      total_duration:         result.total_duration,
      clip_durations:         result.clip_durations,
      effective_durations:    result.effective_durations
    });

  } catch (err) {
    console.error(`[COMPOSE] Error:`, err.message);
    // CLIP_TOO_SHORT is a known validation error (422 Unprocessable Entity)
    const statusCode = err.message.startsWith('CLIP_TOO_SHORT') ? 422 : 500;
    return res.status(statusCode).json({ error: err.message });
  }
});

// ── 404 ─────────────────────────────────────────────────────────────────────

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[START] ffmpeg-worker v1.1.0 running on port ${PORT}`);
  console.log(`[START] Output dir: ${OUTPUT_DIR}`);
  console.log(`[START] Public base URL: ${PUBLIC_BASE_URL}`);
});
