const crypto = require("crypto");
const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getStorage } = require("firebase-admin/storage");
const { GoogleAuth } = require("google-auth-library");
const fetch = require("node-fetch");
const { v4: uuidv4 } = require("uuid");

const BUCKET_NAME = "us-computer-474205.firebasestorage.app";

const getCredentials = () => {
    if (!process.env.GCP_CREDENTIALS) throw new Error("缺少 GCP_CREDENTIALS");
    try {
        return JSON.parse(process.env.GCP_CREDENTIALS);
    } catch (e) {
        throw new Error("GCP_CREDENTIALS 格式錯誤");
    }
};

const serviceAccount = getCredentials();
const PROJECT_ID = serviceAccount.project_id;

if (getApps().length === 0) {
    initializeApp({ credential: cert(serviceAccount), storageBucket: BUCKET_NAME });
}

const bucket = getStorage().bucket();

const auth = new GoogleAuth({
    credentials: serviceAccount,
    scopes: "https://www.googleapis.com/auth/cloud-platform"
});

const MEDIA_TYPES = {
    image: { folder: "ai-images", ext: "png", mimeType: "image/png" },
    audio: { folder: "ai-audio", ext: "mp3", mimeType: "audio/mpeg" },
    video: { folder: "ai-videos", ext: "mp4", mimeType: "video/mp4" }
};

const MIME_EXT = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "video/mp4": "mp4"
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const vertexModelUrl = (modelId, method, location = "global") => {
    if (!modelId || !method) throw new Error("缺少模型或呼叫方法");
    const host = location === "global"
        ? "https://aiplatform.googleapis.com"
        : `https://${location}-aiplatform.googleapis.com`;
    return `${host}/v1beta1/projects/${PROJECT_ID}/locations/${location}/publishers/google/models/${modelId}:${method}`;
};

const getAuthHeaders = async () => {
    const client = await auth.getClient();
    const token = await client.getAccessToken();
    if (!token || !token.token) throw new Error("無法取得 Vertex AI 存取權杖");
    return {
        Authorization: `Bearer ${token.token}`,
        "Content-Type": "application/json"
    };
};

const vertexFetch = async (url, options) => {
    const response = await fetch(url, options);
    if (!response.ok) {
        const text = await response.text();
        let errorMsg = text;
        try {
            errorMsg = JSON.parse(text).error?.message || text;
        } catch (e) { }

        if (response.status === 413) throw new Error("請求內容過大 (413 Payload Too Large)。請減少上傳的圖片數量或大小。");
        if (response.status === 404) throw new Error(`找不到模型: ${url}`);
        throw new Error(`Vertex AI Error (${response.status}): ${errorMsg}`);
    }
    return await response.json();
};

const saveMediaToStorage = async (items, metadata) => {
    const type = metadata.type || "image";
    const preset = MEDIA_TYPES[type];
    if (!preset) throw new Error(`不支援的媒體類型: ${type}`);

    const list = Array.isArray(items) ? items : [items];
    if (list.length === 0) throw new Error("沒有可儲存的內容");

    const uploads = list.map(async (item, index) => {
        const base64Data = typeof item === "string" ? item : item.base64Data;
        if (!base64Data) throw new Error("媒體內容為空");

        const mimeType = (typeof item === "object" && item.mimeType) || preset.mimeType;
        const ext = MIME_EXT[mimeType] || preset.ext;
        const buffer = Buffer.from(base64Data, "base64");
        const fileName = `${preset.folder}/gen-${Date.now()}-${uuidv4()}.${ext}`;
        const file = bucket.file(fileName);

        await file.save(buffer, {
            metadata: {
                contentType: mimeType,
                cacheControl: "public, max-age=31536000",
                metadata: { prompt: metadata.prompt || "", mode: metadata.mode || "" }
            }
        });
        await file.makePublic();

        return {
            url: file.publicUrl(),
            type,
            mimeType,
            prompt: metadata.prompt,
            aspectRatio: metadata.aspectRatio,
            size: metadata.size,
            mode: metadata.mode,
            duration: metadata.duration,
            thoughts: metadata.thoughtsArray ? metadata.thoughtsArray[index] : metadata.thoughts
        };
    });

    return Promise.all(uploads);
};

const publishGcsUri = async (gcsUri, type = "video") => {
    if (!gcsUri || !gcsUri.startsWith("gs://")) throw new Error(`無效的 GCS 路徑: ${gcsUri}`);
    const path = gcsUri.replace(`gs://${BUCKET_NAME}/`, "");
    if (path === gcsUri) throw new Error("GCS 路徑不屬於本專案 Bucket");

    const file = bucket.file(path);
    await file.makePublic();
    return { url: file.publicUrl(), type, mimeType: MEDIA_TYPES[type]?.mimeType };
};

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const b64url = (input) => Buffer.from(input).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const signPayload = (payload) => {
    const secret = process.env.AUTH_SECRET;
    if (!secret) throw new Error("伺服器未設定 AUTH_SECRET");
    return b64url(crypto.createHmac("sha256", secret).update(payload).digest());
};

const safeEqual = (a, b) => {
    const bufA = Buffer.from(String(a || ""), "utf8");
    const bufB = Buffer.from(String(b || ""), "utf8");
    if (bufA.length !== bufB.length || bufA.length === 0) {
        crypto.timingSafeEqual(bufA, bufA);
        return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
};

const issueToken = (password) => {
    const expected = process.env.SITE_PASSWORD;
    if (!expected) throw new Error("伺服器未設定 SITE_PASSWORD");
    if (!safeEqual(password, expected)) return null;

    const payload = b64url(JSON.stringify({ exp: Date.now() + TOKEN_TTL_MS, jti: uuidv4() }));
    return { token: `${payload}.${signPayload(payload)}`, expiresAt: Date.now() + TOKEN_TTL_MS };
};

const verifyToken = (token) => {
    if (typeof token !== "string") return false;

    const [payload, signature] = token.split(".");
    if (!payload || !signature) return false;
    if (!safeEqual(signature, signPayload(payload))) return false;

    try {
        const decoded = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
        const { exp } = JSON.parse(decoded);
        return typeof exp === "number" && exp > Date.now();
    } catch (e) {
        return false;
    }
};

const requireAuth = (req, res) => {
    const token = req.headers["x-auth-token"] || (req.body && req.body.token);
    try {
        if (verifyToken(token)) return true;
    } catch (e) {
        res.status(500).json({ error: { message: e.message } });
        return false;
    }
    res.status(401).json({ error: { message: "驗證失效，請重新輸入密碼", code: "UNAUTHORIZED" } });
    return false;
};

const GEMINI_HOST = "https://generativelanguage.googleapis.com/v1beta";

const geminiKey = () => {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error("伺服器未設定 GEMINI_API_KEY");
    return key;
};

const geminiFetch = async (path, options = {}) => {
    const separator = path.includes("?") ? "&" : "?";
    const response = await fetch(`${GEMINI_HOST}${path}${separator}key=${geminiKey()}`, {
        ...options,
        headers: { "Content-Type": "application/json", ...(options.headers || {}) }
    });

    if (!response.ok) {
        const text = await response.text();
        let message = text;
        try { message = JSON.parse(text).error?.message || text; } catch (e) { }

        if (response.status === 404) throw new Error(`模型或工作不存在，請確認 API 金鑰已開通該模型：${message}`);
        if (response.status === 429) throw new Error("已達 Gemini API 用量上限，請稍後再試。");
        throw new Error(`Gemini API 錯誤 (${response.status}): ${message}`);
    }
    return await response.json();
};

const geminiDownload = async (uri) => {
    if (!uri) throw new Error("缺少下載連結");
    const separator = uri.includes("?") ? "&" : "?";
    const response = await fetch(`${uri}${separator}key=${geminiKey()}`);
    if (!response.ok) throw new Error(`下載生成檔案失敗 (${response.status})`);
    return (await response.buffer()).toString("base64");
};

const applyCors = (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,X-Auth-Token");

    if (req.method === "OPTIONS") {
        res.status(200).end();
        return false;
    }
    if (req.method !== "POST") {
        res.status(405).json({ error: { message: "Method Not Allowed" } });
        return false;
    }
    return true;
};

module.exports = {
    BUCKET_NAME,
    PROJECT_ID,
    MEDIA_TYPES,
    bucket,
    delay,
    uuidv4,
    fetch,
    vertexModelUrl,
    getAuthHeaders,
    vertexFetch,
    saveMediaToStorage,
    publishGcsUri,
    applyCors,
    issueToken,
    verifyToken,
    requireAuth,
    geminiFetch,
    geminiDownload
};
