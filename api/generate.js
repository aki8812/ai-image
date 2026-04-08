const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getStorage } = require("firebase-admin/storage");
const { GoogleAuth } = require("google-auth-library");
const fetch = require("node-fetch");
const { v4: uuidv4 } = require('uuid');

const getCredentials = () => {
    if (!process.env.GCP_CREDENTIALS) throw new Error("缺少 GCP_CREDENTIALS");
    try { return JSON.parse(process.env.GCP_CREDENTIALS); }
    catch (e) { throw new Error("GCP_CREDENTIALS 格式錯誤"); }
};

const serviceAccount = getCredentials();
const BUCKET_NAME = "us-computer-474205.firebasestorage.app";

if (getApps().length === 0) {
    initializeApp({
        credential: cert(serviceAccount),
        storageBucket: BUCKET_NAME
    });
}

const bucket = getStorage().bucket();
const PROJECT_ID = serviceAccount.project_id;

const GLOBAL_BASE = `https://aiplatform.googleapis.com`;
const V1BETA_API_GLOBAL = `${GLOBAL_BASE}/v1beta1/projects/${PROJECT_ID}/locations/global/publishers/google/models`;

const auth = new GoogleAuth({
    credentials: serviceAccount,
    scopes: "https://www.googleapis.com/auth/cloud-platform",
});

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export const config = {
    api: { bodyParser: { sizeLimit: '10mb' } }
};

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.status(200).end(); return; }
    if (req.method !== "POST") { res.status(405).send("Method Not Allowed"); return; }

    const contentLength = req.headers['content-length'];
    if (contentLength && parseInt(contentLength) > 4.5 * 1024 * 1024) {
        return res.status(413).json({ error: { message: "請求內容過大 (超過 4.5MB)。請減少圖片數量或壓縮圖片。" } });
    }

    const body = req.body;

    try {
        if (body.mode === 'get-upload-url') {
            const { fileName, contentType } = body;
            const tempFileName = `temp-ref/${Date.now()}-${uuidv4()}-${fileName}`;
            const file = bucket.file(tempFileName);
            const [url] = await file.getSignedUrl({
                version: 'v4',
                action: 'write',
                expires: Date.now() + 15 * 60 * 1000,
                contentType: contentType
            });
            return res.status(200).json({ uploadUrl: url, gcsPath: tempFileName, gcsUri: `gs://${BUCKET_NAME}/${tempFileName}` });
        }

        if (body.mode === 'cleanup') {
            const { gcsPaths } = body;
            if (gcsPaths && Array.isArray(gcsPaths)) {
                const deletePromises = gcsPaths.map(path => bucket.file(path).delete().catch(e => console.error("Cleanup error:", e)));
                await Promise.all(deletePromises);
            }
            return res.status(200).json({ success: true });
        }

        const client = await auth.getClient();
        const authToken = await client.getAccessToken();
        const headers = {
            "Authorization": `Bearer ${authToken.token}`,
            "Content-Type": "application/json",
        };

        let generatedResults = [];

        if (body.mode === 'generate-nanobanana') {
            generatedResults = await handleNanoBanana(headers, body);
        } else if (body.mode === 'generate-nanobanana2') {
            generatedResults = await handleNanoBanana2(headers, body);
        } else {
            generatedResults = await handleNanoBanana1(headers, body);
        }

        res.status(200).json({ images: generatedResults });

    } catch (error) {
        console.error("API Error:", error);
        res.status(500).json({ error: { message: error.message } });
    }
}

async function handleNanoBanana(headers, { prompt, aspectRatio, sampleImageSize, numImages, images, useGoogleSearch }) {
    const modelId = "gemini-3-pro-image-preview";
    const apiUrl = `${V1BETA_API_GLOBAL}/${modelId}:generateContent`;

    let targetImageSize;
    if (sampleImageSize === '4096') targetImageSize = "4K";
    else if (sampleImageSize === '2048') targetImageSize = "2K";

    const targetAspectRatio = aspectRatio || "1:1";

    const safeNumImages = Math.max(1, Math.min(parseInt(numImages) || 1, 2));

    const enhancedPrompt = useGoogleSearch
        ? `You MUST generate an image as your final output. Use Google Search to look up the latest and most accurate visual references if needed, then produce an image that is a pure, literal representation of the following prompt without adding any unrequested context, settings, or presentation styles: ${prompt}`
        : `Directly generate the content as described by the user without adding any unrequested context, settings, or presentation styles. The image should be a pure, literal representation of the prompt: ${prompt}`;

    const parts = [{ text: enhancedPrompt }];

    if (images && Array.isArray(images)) {
        images.forEach(img => {
            if (img.gcsUri) {
                parts.push({ fileData: { mimeType: img.mimeType || "image/png", fileUri: img.gcsUri } });
            } else if (img.base64Data) {
                parts.push({ inlineData: { mimeType: img.mimeType || "image/png", data: img.base64Data } });
            }
        });
    }

    const payload = {
        contents: [{ role: "user", parts: parts }],
        ...(useGoogleSearch && { tools: [{ googleSearch: {} }] }),
        generation_config: {
            image_config: {
                aspect_ratio: targetAspectRatio,
                ...(targetImageSize && { image_size: targetImageSize })
            }
        }
    };

    const requests = Array(safeNumImages).fill().map(async (_, i) => {
        if (i > 0) await delay(i * 800);
        let lastErr;
        for (let attempt = 0; attempt < 3; attempt++) {
            if (attempt > 0) await delay(2000 * attempt);
            try {
                return await vertexFetch(apiUrl, { method: "POST", headers, body: JSON.stringify(payload) });
            } catch (e) {
                lastErr = e;
                console.error("NanoBanana attempt " + (attempt + 1) + " failed: " + e.message);
            }
        }
        return { error: lastErr.message };
    });
    const results = await Promise.all(requests);

    const validImages = [];
    const validThoughts = [];
    let refusalReason = "";

    for (const result of results) {
        if (result.error) {
            console.error("NanoBanana partial failure:", result.error);
            continue;
        }

        const candidates = result.candidates;
        if (!candidates || candidates.length === 0) continue;

        const parts = candidates[0].content?.parts || [];
        let thoughts = "";
        let base64Image = null;

        for (const part of parts) {
            if (part.text) thoughts += part.text + "\n";
            if (part.inlineData) base64Image = part.inlineData.data;
        }

        if (base64Image) {
            validImages.push(base64Image);
            validThoughts.push(thoughts.trim());
        } else if (thoughts) {
            refusalReason = thoughts.trim();
        }
    }

    if (validImages.length === 0) {
        if (refusalReason) {
            throw new Error(`Gemini 拒絕生成圖片: ${refusalReason.substring(0, 150)}...`);
        }
        throw new Error("Gemini 未生成任何圖片 (API 忙碌或 Prompt 被拒絕)");
    }

    let displaySize = "1K (Default)";
    if (targetImageSize === "2K") displaySize = "2K";
    if (targetImageSize === "4K") displaySize = "4K";

    return await saveImagesToStorage(validImages, {
        prompt: prompt,
        aspectRatio: targetAspectRatio,
        size: displaySize,
        mode: "generate-nanobanana",
        thoughtsArray: validThoughts
    });
}

async function handleNanoBanana2(headers, { prompt, aspectRatio, sampleImageSize, numImages, images, useGoogleSearch }) {
    const modelId = "gemini-3.1-flash-image-preview";
    const apiUrl = `${V1BETA_API_GLOBAL}/${modelId}:generateContent`;

    let targetImageSize;
    if (sampleImageSize === '4096') targetImageSize = "4K";
    else if (sampleImageSize === '2048') targetImageSize = "2K";

    const targetAspectRatio = aspectRatio || "1:1";
    const safeNumImages = Math.max(1, Math.min(parseInt(numImages) || 1, 4));

    const enhancedPrompt = useGoogleSearch
        ? `You MUST generate an image as your final output. Use Google Search to look up the latest and most accurate visual references if needed, then produce an image that is a pure, literal representation of the following prompt without adding any unrequested context, settings, or presentation styles: ${prompt}`
        : `Directly generate the content as described by the user without adding any unrequested context, settings, or presentation styles. The image should be a pure, literal representation of the prompt: ${prompt}`;

    const parts = [{ text: enhancedPrompt }];

    if (images && Array.isArray(images)) {
        images.forEach(img => {
            if (img.gcsUri) {
                parts.push({ fileData: { mimeType: img.mimeType || "image/png", fileUri: img.gcsUri } });
            } else if (img.base64Data) {
                parts.push({ inlineData: { mimeType: img.mimeType || "image/png", data: img.base64Data } });
            }
        });
    }

    const payload = {
        contents: [{ role: "user", parts: parts }],
        ...(useGoogleSearch && { tools: [{ googleSearch: {} }] }),
        generation_config: {
            image_config: {
                aspect_ratio: targetAspectRatio,
                ...(targetImageSize && { image_size: targetImageSize })
            }
        }
    };

    const requests = Array(safeNumImages).fill().map(async (_, i) => {
        if (i > 0) await delay(i * 800);
        let lastErr;
        for (let attempt = 0; attempt < 3; attempt++) {
            if (attempt > 0) await delay(2000 * attempt);
            try {
                return await vertexFetch(apiUrl, { method: "POST", headers, body: JSON.stringify(payload) });
            } catch (e) {
                lastErr = e;
                console.error("NanoBanana2 attempt " + (attempt + 1) + " failed: " + e.message);
            }
        }
        return { error: lastErr.message };
    });
    const results = await Promise.all(requests);

    const validImages = [];
    const validThoughts = [];
    let refusalReason = "";

    for (const result of results) {
        if (result.error) {
            console.error("NanoBanana2 partial failure:", result.error);
            continue;
        }

        const candidates = result.candidates;
        if (!candidates || candidates.length === 0) continue;

        const parts = candidates[0].content?.parts || [];
        let thoughts = "";
        let base64Image = null;

        for (const part of parts) {
            if (part.text) thoughts += part.text + "\n";
            if (part.inlineData) base64Image = part.inlineData.data;
        }

        if (base64Image) {
            validImages.push(base64Image);
            validThoughts.push(thoughts.trim());
        } else if (thoughts) {
            refusalReason = thoughts.trim();
        }
    }

    if (validImages.length === 0) {
        if (refusalReason) {
            throw new Error(`Gemini 拒絕生成圖片: ${refusalReason.substring(0, 150)}...`);
        }
        throw new Error("Gemini 未生成任何圖片 (API 忙碌或 Prompt 被拒絕)");
    }

    let displaySize = "1K (Default)";
    if (targetImageSize === "2K") displaySize = "2K";
    if (targetImageSize === "4K") displaySize = "4K";

    return await saveImagesToStorage(validImages, {
        prompt: prompt,
        aspectRatio: targetAspectRatio,
        size: displaySize,
        mode: "generate-nanobanana2",
        thoughtsArray: validThoughts
    });
}

async function handleNanoBanana1(headers, { prompt, aspectRatio, sampleImageSize, numImages, images, useGoogleSearch }) {
    const modelId = "gemini-2.5-flash-image";
    const apiUrl = `${V1BETA_API_GLOBAL}/${modelId}:generateContent`;

    let targetImageSize;
    if (sampleImageSize === '4096') targetImageSize = "4K";
    else if (sampleImageSize === '2048') targetImageSize = "2K";

    const targetAspectRatio = aspectRatio || "1:1";
    const safeNumImages = Math.max(1, Math.min(parseInt(numImages) || 1, 4));

    const enhancedPrompt = useGoogleSearch
        ? `You MUST generate an image as your final output. Use Google Search to look up the latest and most accurate visual references if needed, then produce an image that is a pure, literal representation of the following prompt without adding any unrequested context, settings, or presentation styles: ${prompt}`
        : `Directly generate the content as described by the user without adding any unrequested context, settings, or presentation styles. The image should be a pure, literal representation of the prompt: ${prompt}`;

    const parts = [{ text: enhancedPrompt }];

    if (images && Array.isArray(images)) {
        images.forEach(img => {
            if (img.gcsUri) {
                parts.push({ fileData: { mimeType: img.mimeType || "image/png", fileUri: img.gcsUri } });
            } else if (img.base64Data) {
                parts.push({ inlineData: { mimeType: img.mimeType || "image/png", data: img.base64Data } });
            }
        });
    }

    const payload = {
        contents: [{ role: "user", parts: parts }],
        ...(useGoogleSearch && { tools: [{ googleSearch: {} }] }),
        generation_config: {
            image_config: {
                aspect_ratio: targetAspectRatio,
                ...(targetImageSize && { image_size: targetImageSize })
            }
        }
    };

    const requests = Array(safeNumImages).fill().map(async (_, i) => {
        if (i > 0) await delay(i * 800);
        let lastErr;
        for (let attempt = 0; attempt < 3; attempt++) {
            if (attempt > 0) await delay(2000 * attempt);
            try {
                return await vertexFetch(apiUrl, { method: "POST", headers, body: JSON.stringify(payload) });
            } catch (e) {
                lastErr = e;
                console.error("NanoBanana1 attempt " + (attempt + 1) + " failed: " + e.message);
            }
        }
        return { error: lastErr.message };
    });
    const results = await Promise.all(requests);

    const validImages = [];
    const validThoughts = [];
    let refusalReason = "";

    for (const result of results) {
        if (result.error) {
            console.error("NanoBanana1 partial failure:", result.error);
            continue;
        }

        const candidates = result.candidates;
        if (!candidates || candidates.length === 0) continue;

        const parts = candidates[0].content?.parts || [];
        let thoughts = "";
        let base64Image = null;

        for (const part of parts) {
            if (part.text) thoughts += part.text + "\n";
            if (part.inlineData) base64Image = part.inlineData.data;
        }

        if (base64Image) {
            validImages.push(base64Image);
            validThoughts.push(thoughts.trim());
        } else if (thoughts) {
            refusalReason = thoughts.trim();
        }
    }

    if (validImages.length === 0) {
        if (refusalReason) {
            throw new Error(`Gemini 拒絕生成圖片: ${refusalReason.substring(0, 150)}...`);
        }
        throw new Error("Gemini 未生成任何圖片 (API 忙碌或 Prompt 被拒絕)");
    }

    let displaySize = "1K (Default)";
    if (targetImageSize === "2K") displaySize = "2K";
    if (targetImageSize === "4K") displaySize = "4K";

    return await saveImagesToStorage(validImages, {
        prompt: prompt,
        aspectRatio: targetAspectRatio,
        size: displaySize,
        mode: "generate-nanobanana1",
        thoughtsArray: validThoughts
    });
}

async function saveImagesToStorage(base64DataArray, metadata) {
    const uploadPromises = base64DataArray.map(async (base64Data, index) => {
        const buffer = Buffer.from(base64Data, 'base64');
        const fileName = `ai-images/gen-${Date.now()}-${uuidv4()}.png`;
        const file = bucket.file(fileName);

        const specificThoughts = metadata.thoughtsArray ? metadata.thoughtsArray[index] : metadata.thoughts;

        await file.save(buffer, {
            metadata: {
                contentType: 'image/png',
                cacheControl: 'public, max-age=31536000',
                metadata: {
                    prompt: metadata.prompt || "",
                    mode: metadata.mode,
                }
            },
        });

        await file.makePublic();

        return {
            url: file.publicUrl(),
            prompt: metadata.prompt,
            aspectRatio: metadata.aspectRatio,
            size: metadata.size,
            mode: metadata.mode,
            thoughts: specificThoughts
        };
    });
    return Promise.all(uploadPromises);
}

async function vertexFetch(url, options) {
    const response = await fetch(url, options);
    if (!response.ok) {
        const text = await response.text();
        let errorMsg = text;
        try { errorMsg = JSON.parse(text).error?.message || text; } catch (e) { }

        if (response.status === 413) {
            throw new Error("請求內容過大 (413 Payload Too Large)。請減少上傳的圖片數量或大小。");
        }
        if (response.status === 404) {
            throw new Error(`找不到模型: ${url}`);
        }
        throw new Error(`Vertex AI Error (${response.status}): ${errorMsg}`);
    }
    return await response.json();
}