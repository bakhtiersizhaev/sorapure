'use strict';

require('dotenv').config();

const express = require('express');
const axios = require('axios');
const { exec } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Configuration
const PORT = process.env.PORT || 3000;
const REQUEST_TIMEOUT = 120000;
const API_TIMEOUT = 30000;
const FFMPEG_TIMEOUT = 120000;

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36';

const VIDEO_ID_PATTERN = /(s_[0-9A-Za-z_-]{8,})/;

const DELOGO = { x: 'iw-160', y: 'ih-60', w: 150, h: 50 };

// Endpoints (base64)
const ENDPOINTS = {
    CDN_DIRECT: 'aHR0cHM6Ly9vc2NkbjIuZHl5c3kuY29tL01QNC8=', // https://oscdn2.dyysy.com/MP4/
    CDN_PROXY: 'aHR0cHM6Ly9hcGkuc29yYWNkbi53b3JrZXJzLmRldi9kb3dubG9hZC1wcm94eT9pZD0=',
    SORA_API: 'aHR0cHM6Ly9zb3JhLmNoYXRncHQuY29tL2JhY2tlbmQvcHJvamVjdF95L3Bvc3Qv',
    OPENAI_CDN: 'aHR0cHM6Ly9jZG4ub3BlbmFpLmNvbS9NUDQv',
};

const Source = { NONE: -1, CDN_DIRECT: 0, CDN_PROXY: 1, SORA_API: 2, OPENAI_CDN: 3 };

const config = {
    bearerToken: process.env.SORA_BEARER_TOKEN || '',
    cookies: process.env.SORA_COOKIES || '',
};

// Helpers
const decode = (s) => Buffer.from(s, 'base64').toString('utf-8');
const extractId = (url) => url.match(VIDEO_ID_PATTERN)?.[1] || null;
const formatSize = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function generateHash(id, ts) {
    return crypto.createHash('md5').update(`${id}:${ts}:${process.pid}`).digest('hex').slice(0, 8);
}

function safeDelete(filePath) {
    try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {}
}

// Download strategies
async function fromCdnDirect(videoId) {
    console.log(`[DEBUG] Attempting CDN Direct (dyysy) for ${videoId}...`);
    try {
        const url = decode(ENDPOINTS.CDN_DIRECT) + videoId + '.mp4';
        const res = await axios({
            url: url,
            method: 'GET',
            responseType: 'stream',
            timeout: REQUEST_TIMEOUT,
            headers: { 'User-Agent': USER_AGENT },
        });

        if (res.status === 200 && res.headers['content-type']?.includes('video')) {
            console.log(`[DEBUG] SUCCESS: CDN Direct found video`);
            return res;
        }
    } catch (err) {
        console.log(`[DEBUG] CDN Direct failed: ${err.message}`);
    }
    return null;
}

async function fromCdnProxy(videoId, requestId) {
    console.log(`[DEBUG] Attempting CDN Proxy for ${videoId}...`);
    try {
        const res = await axios({
            url: decode(ENDPOINTS.CDN_PROXY) + videoId,
            method: 'GET',
            responseType: 'stream',
            timeout: REQUEST_TIMEOUT,
            headers: { 'User-Agent': USER_AGENT, 'X-Request-Id': requestId },
        });

        if (res.status === 200 && res.headers['content-type']?.includes('video')) {
            console.log(`[DEBUG] SUCCESS: CDN Proxy found video`);
            return res;
        }
    } catch (err) {
        console.log(`[DEBUG] CDN Proxy failed: ${err.message}`);
    }
    return null;
}

async function fromSoraApi(videoId, token, cookies) {
    console.log(`[DEBUG] Attempting Sora API for ${videoId}...`);
    if (!token) {
        console.log('[DEBUG] Sora API skipped: No token provided');
        return null;
    }

    try {
        const headers = {
            'User-Agent': USER_AGENT,
            Accept: 'application/json',
            Referer: `https://sora.chatgpt.com/p/${videoId}`,
            Origin: 'https://sora.chatgpt.com',
            Authorization: `Bearer ${token}`,
        };
        if (cookies) headers.Cookie = cookies;

        const api = await axios({
            url: decode(ENDPOINTS.SORA_API) + videoId,
            method: 'GET',
            timeout: API_TIMEOUT,
            headers,
        });

        const att = api.data?.post?.attachments?.[0];
        if (!att) {
            console.log('[DEBUG] Sora API: No attachments found in response');
            return null;
        }

        let videoUrl = att.download_urls?.no_watermark;
        let needsProcessing = false;

        if (videoUrl) {
            console.log('[DEBUG] Sora API: Found NO_WATERMARK URL directly!');
        } else {
            console.log('[DEBUG] Sora API: No clean URL found. Looking for fallback...');
            videoUrl = att.downloadable_url || att.download_urls?.watermark || att.encodings?.source?.path;
            if (videoUrl) {
                console.log('[DEBUG] Sora API: Found fallback URL (likely watermarked)');
                needsProcessing = true;
            }
        }

        if (!videoUrl) return null;

        const res = await axios({
            url: videoUrl,
            method: 'GET',
            responseType: 'stream',
            timeout: REQUEST_TIMEOUT,
            headers: { 'User-Agent': USER_AGENT },
        });

        return res.status === 200 ? { response: res, needsProcessing } : null;
    } catch (err) {
        console.log(`[DEBUG] Sora API failed: ${err.message}`);
        if (err.response) {
            console.log(`[DEBUG] API Error Details: status=${err.response.status}`);
        }
    }
    return null;
}

async function fromOpenAiCdn(videoId) {
    console.log(`[DEBUG] Attempting OpenAI CDN (fallback) for ${videoId}...`);
    try {
        const res = await axios({
            url: decode(ENDPOINTS.OPENAI_CDN) + videoId + '.mp4',
            method: 'GET',
            responseType: 'stream',
            timeout: API_TIMEOUT,
            headers: { 'User-Agent': USER_AGENT },
        });
        if (res.status === 200) {
            console.log(`[DEBUG] SUCCESS: OpenAI CDN found video`);
            return res;
        }
    } catch (err) {
        console.log(`[DEBUG] OpenAI CDN failed: ${err.message}`);
    }
    return null;
}

// Video processing
async function saveStream(stream, outputPath) {
    const ws = fs.createWriteStream(outputPath);
    stream.data.pipe(ws);
    return new Promise((resolve, reject) => {
        ws.on('finish', resolve);
        ws.on('error', reject);
    });
}

async function removeWatermark(input, output) {
    console.log('[DEBUG] Starting watermark removal...');
    const filter = `delogo=x=${DELOGO.x}:y=${DELOGO.y}:w=${DELOGO.w}:h=${DELOGO.h}`;
    const cmd = `ffmpeg -i "${input}" -vf "${filter}" -c:a copy "${output}" -y`;

    return new Promise((resolve, reject) => {
        exec(cmd, { timeout: FFMPEG_TIMEOUT }, (err) => {
            safeDelete(input);
            if (err) {
                console.log(`[DEBUG] FFMPEG failed: ${err.message}`);
                safeDelete(output);
                reject(new Error('Processing failed'));
            } else {
                console.log('[DEBUG] Watermark removal success');
                resolve();
            }
        });
    });
}

// Express app
const app = express();

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.use(express.json({ limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (_, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Download handler for both /download and /api/download
async function handleDownload(req, res) {
    const { url } = req.body;
    const token = req.body.token || config.bearerToken;
    const cookies = req.body.cookies || config.cookies;

    const videoId = extractId(url || '');
    if (!videoId) {
        return res.status(400).json({ error: 'Invalid video URL or code' });
    }

    console.log(`\n[DEBUG] --- New Download Request: ${videoId} ---`);

    const hash = generateHash(videoId, Date.now());
    const tmpDir = os.tmpdir();
    const inputPath = path.join(tmpDir, `${hash}_in.mp4`);
    const outputPath = path.join(tmpDir, `${hash}_out.mp4`);

    try {
        let stream = null;
        let source = Source.NONE;
        let needsProcessing = false;

        // 1. Try CDN Direct (dyysy)
        stream = await fromCdnDirect(videoId);
        if (stream) {
            source = Source.CDN_DIRECT;
        }

        // 2. Try CDN Proxy
        if (!stream) {
            stream = await fromCdnProxy(videoId, hash);
            if (stream) {
                source = Source.CDN_PROXY;
            }
        }

        // 3. Try Sora API
        if (!stream) {
            const result = await fromSoraApi(videoId, token, cookies);
            if (result) {
                stream = result.response;
                source = Source.SORA_API;
                needsProcessing = result.needsProcessing;
            }
        }

        // 4. Try OpenAI CDN
        if (!stream) {
            stream = await fromOpenAiCdn(videoId);
            if (stream) source = Source.OPENAI_CDN;
        }

        if (!stream) {
            console.log('[DEBUG] All sources failed');
            return res.status(404).json({ error: 'Video source unavailable' });
        }

        console.log(`[DEBUG] Downloading stream from source: ${Object.keys(Source).find(k => Source[k] === source)}`);
        await saveStream(stream, inputPath);

        let buffer;
        if (needsProcessing) {
            await removeWatermark(inputPath, outputPath);
            buffer = fs.readFileSync(outputPath);
            safeDelete(outputPath);
        } else {
            buffer = fs.readFileSync(inputPath);
            safeDelete(inputPath);
        }

        res.json({
            cleanUrl: `data:video/mp4;base64,${buffer.toString('base64')}`,
            size: formatSize(buffer.length),
            filename: `${videoId}_HD.mp4`,
            source,
            quality: 'HD',
            delogoApplied: needsProcessing,
        });
        console.log('[DEBUG] Request completed successfully');
    } catch (err) {
        console.log(`[DEBUG] Critical handler error: ${err.message}`);
        safeDelete(inputPath);
        safeDelete(outputPath);
        res.status(500).json({ error: err.message || 'Download failed' });
    }
}

app.post('/download', handleDownload);
app.post('/api/download', handleDownload);

app.listen(PORT, () => console.log(`SoraPure running on port ${PORT}`));

