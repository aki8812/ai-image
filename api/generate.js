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
const LOCATION = "us-central1";

const REGIONAL_BASE = `https://${LOCATION}-aiplatform.googleapis.com`;
const V1_API_REGIONAL = `${REGIONAL_BASE}/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models`;

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

    try {
        const client = await auth.getClient();
        const authToken = await client.getAccessToken();
        const headers = {
            "Authorization": `Bearer ${authToken.token}`,
            "Content-Type": "application/json",
        };

        const body = req.body;
        let generatedResults = [];

        if (body.mode === 'generate-nanobanana') {
            generatedResults = await handleNanoBanana(headers, body);
        } else if (body.mode === 'generate-nanobanana2') {
            generatedResults = await handleNanoBanana2(headers, body);
        } else if (body.mode === 'upscale') {
            generatedResults = await handleUpscaling(headers, body);
        } else {
            generatedResults = await handleImagen(headers, body);
        }

        res.status(200).json({ images: generatedResults });

    } catch (error) {
        console.error("API Error:", error);
        res.status(500).json({ error: { message: error.message } });
    }
}


async function handleNanoBanana(headers, { prompt, aspectRatio, sampleImageSize, numImages, images }) {
    const modelId = "gemini-3-pro-image-preview";
    const apiUrl = `${V1BETA_API_GLOBAL}/${modelId}:generateContent`;

    let targetImageSize;
    if (sampleImageSize === '4096') targetImageSize = "4K";
    else if (sampleImageSize === '2048') targetImageSize = "2K";

    const targetAspectRatio = aspectRatio || "1:1";

    const safeNumImages = Math.max(1, Math.min(parseInt(numImages) || 1, 2));



    const enhancedPrompt = `Directly generate the content as described by the user without adding any unrequested context, settings, or presentation styles. The image should be a pure, literal representation of the prompt: ${prompt}`;

    const parts = [{ text: enhancedPrompt }];

    if (images && Array.isArray(images)) {
        images.forEach(img => {
            if (img.base64Data) {
                parts.push({
                    inlineData: {
                        mimeType: img.mimeType || "image/png",
                        data: img.base64Data
                    }
                });
            }
        });
    }

    const payload = {
        contents: [{ role: "user", parts: parts }],
        tools: [{ google_search: {} }],
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
        mode: "gemini-3-pro (Vertex Global)",
        thoughtsArray: validThoughts
    });
}


async function handleNanoBanana2(headers, { prompt, aspectRatio, sampleImageSize, numImages, images }) {
    const modelId = "gemini-3.1-flash-image-preview";
    const apiUrl = `${V1BETA_API_GLOBAL}/${modelId}:generateContent`;

    let targetImageSize;
    if (sampleImageSize === '4096') targetImageSize = "4K";
    else if (sampleImageSize === '2048') targetImageSize = "2K";

    const targetAspectRatio = aspectRatio || "1:1";
    const safeNumImages = Math.max(1, Math.min(parseInt(numImages) || 1, 4));

    const enhancedPrompt = `Directly generate the content as described by the user without adding any unrequested context, settings, or presentation styles. The image should be a pure, literal representation of the prompt: ${prompt}`;

    const parts = [{ text: enhancedPrompt }];

    if (images && Array.isArray(images)) {
        images.forEach(img => {
            if (img.base64Data) {
                parts.push({
                    inlineData: {
                        mimeType: img.mimeType || "image/png",
                        data: img.base64Data
                    }
                });
            }
        });
    }

    const payload = {
        contents: [{ role: "user", parts: parts }],
        tools: [{ google_search: {} }],
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

async function handleImagen(headers, { mode, prompt, images, numImages, aspectRatio, sampleImageSize, addWatermark }) {
    let modelId = "imagen-4.0-generate-001";
    if (mode === "generate-fast") modelId = "imagen-4.0-fast-generate-001";
    if (mode === "generate-ultra") modelId = "imagen-4.0-ultra-generate-001";

    const apiUrl = `${V1_API_REGIONAL}/${modelId}:predict`;

    const instances = [{ prompt: prompt }];

    if (images && images.length > 0) {
        instances[0].image = { bytesBase64Encoded: images[0].base64Data };
    }

    let safeNumImages = parseInt(numImages) || 1;
    safeNumImages = Math.max(1, Math.min(safeNumImages, 4));

    const parameters = {
        sampleCount: safeNumImages,
    };

    let sizeLabel = "1024x1024";
    if (sampleImageSize === '2048' || sampleImageSize === '4096') {
        parameters.sampleImageSize = "2K";
        sizeLabel = "2048x2048";
    } else {
        parameters.sampleImageSize = "1K";
        sizeLabel = "1024x1024";
    }

    if (aspectRatio) {
        parameters.aspectRatio = aspectRatio;
    }
    if (typeof addWatermark === 'boolean') {
        parameters.addWatermark = addWatermark;
    } else {
        parameters.addWatermark = true;
    }

    const result = await vertexFetch(apiUrl, {
        method: "POST",
        headers: headers,
        body: JSON.stringify({ instances, parameters }),
    });

    if (!result.predictions) throw new Error("Imagen API 未回傳預測結果");

    const base64Images = result.predictions.map(p => p.bytesBase64Encoded);

    return await saveImagesToStorage(base64Images, {
        prompt,
        aspectRatio,
        size: sizeLabel,
        mode: mode
    });
}


async function handleUpscaling(headers, { prompt, images, upscaleLevel, addWatermark }) {
    const targetSize = parseInt(upscaleLevel) || 2048;
    const factor = targetSize > 2048 ? "x4" : "x2";
    const apiUrl = `${V1_API_REGIONAL}/imagen-4.0-upscale-preview:predict`;

    if (!images || images.length === 0) throw new Error("\u7f3a\u5c11\u7528\u65bc\u653e\u5927\u7684\u5716\u7247");

    const payload = {
        instances: [{
            prompt: prompt || " ",
            image: { bytesBase64Encoded: images[0].base64Data },
        }],
        parameters: {
            sampleCount: 1,
            mode: "upscale",
            upscaleConfig: { upscaleFactor: factor },
            addWatermark: typeof addWatermark === 'boolean' ? addWatermark : true,
        },
    };

    let result;
    try {
        result = await vertexFetch(apiUrl, { method: "POST", headers, body: JSON.stringify(payload) });
    } catch (e) {
        if (e.message.includes('499') || e.message.includes('cancelled')) {
            throw new Error("\u653e\u5927\u8d85\u6642\uff1aVercel \u514d\u8cbb\u65b9\u6848\u5f37\u5236\u9650\u5236 60 \u79d2\uff0c\u5716\u7247\u653e\u5927\u53ef\u80fd\u8d85\u6642\u3002\u8acb\u8a66\u8457\u4e0a\u50b3\u8f03\u5c0f\u7684\u5716\u7247\u3002");
        }
        throw e;
    }

    const base64Data = result.predictions?.[0]?.bytesBase64Encoded;
    if (!base64Data) throw new Error("\u653e\u5927\u5931\u6557");

    return await saveImagesToStorage([base64Data], {
        prompt: "Upscaled Image",
        aspectRatio: "Original",
        size: `${factor} (Upscaled)`,
        mode: "upscale"
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