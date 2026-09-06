const {
    BUCKET_NAME,
    bucket,
    delay,
    uuidv4,
    vertexModelUrl,
    getAuthHeaders,
    vertexFetch,
    saveMediaToStorage,
    applyCors,
    issueToken,
    requireAuth
} = require("./_vertex.js");

const IMAGE_MODELS = {
    "generate-nanobanana": { modelId: "gemini-3-pro-image", maxImages: 2 },
    "generate-nanobanana2": { modelId: "gemini-3.1-flash-image", maxImages: 4 },
    "generate-nanobanana1": { modelId: "gemini-2.5-flash-image", maxImages: 4 }
};

const DEFAULT_MODE = "generate-nanobanana1";
const MAX_BODY_BYTES = 4.5 * 1024 * 1024;

export const config = {
    api: { bodyParser: { sizeLimit: "10mb" } }
};

export default async function handler(req, res) {
    if (!applyCors(req, res)) return;

    const contentLength = req.headers["content-length"];
    if (contentLength && parseInt(contentLength) > MAX_BODY_BYTES) {
        return res.status(413).json({ error: { message: "請求內容過大 (超過 4.5MB)。請減少圖片數量或壓縮圖片。" } });
    }

    const body = req.body || {};

    if (body.mode === "login") {
        try {
            const result = issueToken(body.password);
            if (!result) {
                await delay(600 + Math.floor(Math.random() * 400));
                return res.status(401).json({ error: { message: "密碼錯誤" } });
            }
            return res.status(200).json(result);
        } catch (error) {
            return res.status(500).json({ error: { message: error.message } });
        }
    }

    if (!requireAuth(req, res)) return;

    try {
        if (body.mode === "verify") return res.status(200).json({ valid: true });
        if (body.mode === "get-upload-url") return res.status(200).json(await createUploadUrl(body));
        if (body.mode === "cleanup") return res.status(200).json(await cleanupFiles(body));

        const headers = await getAuthHeaders();
        const images = await generateImages(headers, body);
        res.status(200).json({ images, media: images });
    } catch (error) {
        console.error("API Error:", error);
        res.status(500).json({ error: { message: error.message } });
    }
}

async function createUploadUrl({ fileName, contentType }) {
    if (!fileName || !contentType) throw new Error("缺少檔案名稱或格式");

    const tempFileName = `temp-ref/${Date.now()}-${uuidv4()}-${fileName}`;
    const [url] = await bucket.file(tempFileName).getSignedUrl({
        version: "v4",
        action: "write",
        expires: Date.now() + 15 * 60 * 1000,
        contentType
    });

    return { uploadUrl: url, gcsPath: tempFileName, gcsUri: `gs://${BUCKET_NAME}/${tempFileName}` };
}

async function cleanupFiles({ gcsPaths }) {
    if (!Array.isArray(gcsPaths) || gcsPaths.length === 0) return { success: true };

    await Promise.all(gcsPaths.map((path) =>
        bucket.file(path).delete().catch((e) => console.error("Cleanup error:", e))
    ));
    return { success: true };
}

function buildPrompt(prompt, useGoogleSearch) {
    return useGoogleSearch
        ? `You MUST generate an image as your final output. Use Google Search to look up the latest and most accurate visual references if needed, then produce an image that is a pure, literal representation of the following prompt without adding any unrequested context, settings, or presentation styles: ${prompt}`
        : `Directly generate the content as described by the user without adding any unrequested context, settings, or presentation styles. The image should be a pure, literal representation of the prompt: ${prompt}`;
}

function buildParts(prompt, images, useGoogleSearch) {
    const parts = [{ text: buildPrompt(prompt, useGoogleSearch) }];
    if (!Array.isArray(images)) return parts;

    images.forEach((img) => {
        if (img.gcsUri) {
            parts.push({ fileData: { mimeType: img.mimeType || "image/png", fileUri: img.gcsUri } });
        } else if (img.base64Data) {
            parts.push({ inlineData: { mimeType: img.mimeType || "image/png", data: img.base64Data } });
        }
    });
    return parts;
}

async function generateImages(headers, body) {
    const mode = IMAGE_MODELS[body.mode] ? body.mode : DEFAULT_MODE;
    const { modelId, maxImages } = IMAGE_MODELS[mode];
    const { prompt, aspectRatio, sampleImageSize, numImages, images, useGoogleSearch } = body;

    const apiUrl = vertexModelUrl(modelId, "generateContent");
    const targetAspectRatio = aspectRatio || "1:1";
    const targetImageSize = sampleImageSize === "4096" ? "4K" : sampleImageSize === "2048" ? "2K" : null;
    const safeNumImages = Math.max(1, Math.min(parseInt(numImages) || 1, maxImages));

    const payload = {
        contents: [{ role: "user", parts: buildParts(prompt, images, useGoogleSearch) }],
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
                console.error(`${mode} attempt ${attempt + 1} failed: ${e.message}`);
            }
        }
        return { error: lastErr.message };
    });

    const { validImages, validThoughts, refusalReason } = collectImages(await Promise.all(requests), mode);

    if (validImages.length === 0) {
        if (refusalReason) throw new Error(`Gemini 拒絕生成圖片: ${refusalReason.substring(0, 150)}...`);
        throw new Error("Gemini 未生成任何圖片 (API 忙碌或 Prompt 被拒絕)");
    }

    return await saveMediaToStorage(validImages, {
        type: "image",
        prompt,
        aspectRatio: targetAspectRatio,
        size: targetImageSize || "1K (Default)",
        mode,
        thoughtsArray: validThoughts
    });
}

function collectImages(results, mode) {
    const validImages = [];
    const validThoughts = [];
    let refusalReason = "";

    for (const result of results) {
        if (result.error) {
            console.error(`${mode} partial failure:`, result.error);
            continue;
        }

        const parts = result.candidates?.[0]?.content?.parts || [];
        let thoughts = "";
        let base64Image = null;

        for (const part of parts) {
            if (part.text) thoughts += `${part.text}\n`;
            if (part.inlineData) base64Image = part.inlineData.data;
        }

        if (base64Image) {
            validImages.push(base64Image);
            validThoughts.push(thoughts.trim());
        } else if (thoughts) {
            refusalReason = thoughts.trim();
        }
    }

    return { validImages, validThoughts, refusalReason };
}
