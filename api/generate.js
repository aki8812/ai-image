// api/generate.js
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

// 設定兩種 API 版本路徑
const BASE_URL = `https://${LOCATION}-aiplatform.googleapis.com`;
const V1_API = `${BASE_URL}/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models`;
const BETA_API = `${BASE_URL}/v1beta1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models`;

const auth = new GoogleAuth({
  credentials: serviceAccount,
  scopes: "https://www.googleapis.com/auth/cloud-platform",
});

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== "POST") { res.status(405).send("Method Not Allowed"); return; }

  try {
    const client = await auth.getClient();
    const authToken = await client.getAccessToken();
    const headers = {
      "Authorization": `Bearer ${authToken.token}`,
      "Content-Type": "application/json",
    };

    const body = req.body;
    let generatedResults = [];

    // === 路由邏輯 ===
    if (body.mode === 'generate-nanobanana') {
        // NanoBanana Pro (Gemini 3) -> 必須走 v1beta1
        generatedResults = await handleNanoBanana(headers, body);
    } else if (body.mode === 'upscale') {
        generatedResults = await handleUpscaling(headers, body);
    } else {
        // Imagen 4 -> 走 v1 正式版
        generatedResults = await handleImagen(headers, body);
    }

    res.status(200).json({ images: generatedResults });

  } catch (error) {
    console.error("API Error:", error);
    res.status(500).json({ error: { message: error.message } });
  }
}

// === NanoBanana Pro (Gemini 3 Pro) ===
// 使用 v1beta1 端點 + Vertex AI 格式
async function handleNanoBanana(headers, { prompt, aspectRatio, sampleImageSize }) {
    const modelId = "gemini-3-pro-image-preview"; 
    // 【關鍵修正】使用 v1beta1 端點
    const apiUrl = `${BETA_API}/${modelId}:generateContent`;

    // 處理參數
    let targetImageSize;
    if (sampleImageSize === '4096') targetImageSize = "4K";
    else if (sampleImageSize === '2048') targetImageSize = "2K";
    
    const targetAspectRatio = aspectRatio || "1:1";

    // 【關鍵修正】Payload 使用 Snake Case (Vertex REST API 規範)
    // 與 SDK 的 CamelCase 不同，直接呼叫 Vertex API 必須用下底線
    const payload = {
        contents: [{ 
            role: "user", 
            parts: [{ text: prompt }] 
        }],
        tools: [{ google_search: {} }], // Grounding
        generation_config: {
            image_config: {
                aspect_ratio: targetAspectRatio,
                // 只有有值時才加入 image_size
                ...(targetImageSize && { image_size: targetImageSize })
            }
        }
    };

    const result = await vertexFetch(apiUrl, {
        method: "POST",
        headers: headers,
        body: JSON.stringify(payload),
    });

    const candidates = result.candidates;
    if (!candidates || candidates.length === 0) {
        throw new Error("Gemini 3 未回傳結果 (可能是 Prompt 被拒絕或模型暫時不可用)");
    }

    const imagePart = candidates[0].content?.parts?.find(p => p.inlineData);
    
    if (!imagePart) {
        const textPart = candidates[0].content?.parts?.find(p => p.text);
        if (textPart) {
            throw new Error(`Gemini 回傳了文字而非圖片: ${textPart.text}`);
        }
        throw new Error("Gemini 未生成圖片資料");
    }

    // 顯示標籤
    let displaySize = "1K (Default)";
    if (targetImageSize === "2K") displaySize = "2K";
    if (targetImageSize === "4K") displaySize = "4K";

    return await saveImagesToStorage([imagePart.inlineData.data], {
        prompt: prompt,
        aspectRatio: targetAspectRatio,
        size: displaySize,
        mode: "gemini-3-pro (Vertex)"
    });
}

// === Imagen 4 系列 (維持 v1) ===
async function handleImagen(headers, { mode, prompt, images, numImages, aspectRatio, sampleImageSize }) {
    let modelId = "imagen-4.0-generate-001";
    if (mode === "generate-fast") modelId = "imagen-4.0-fast-generate-001";
    if (mode === "generate-ultra") modelId = "imagen-4.0-ultra-generate-001";

    // 使用 v1 正式版路徑
    const apiUrl = `${V1_API}/${modelId}:predict`;

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

// === Upscale (維持 v1) ===
async function handleUpscaling(headers, { prompt, images, upscaleLevel }) {
    const targetSize = parseInt(upscaleLevel) || 2048;
    const modelId = "imagen-4.0-ultra-generate-001"; 
    const factor = targetSize > 2048 ? "x4" : "x2";
    
    const apiUrl = `${V1_API}/${modelId}:predict`;

    if (!images || images.length === 0) throw new Error("缺少用於放大的圖片");

    const payload = {
        instances: [{
            prompt: prompt || " ",
            image: { bytesBase64Encoded: images[0].base64Data },
        }],
        parameters: {
            sampleCount: 1,
            mode: "upscale",
            upscaleConfig: { upscaleFactor: factor }
        },
    };

    const result = await vertexFetch(apiUrl, {
        method: "POST",
        headers: headers,
        body: JSON.stringify(payload),
    });

    const base64Data = result.predictions?.[0]?.bytesBase64Encoded;
    if (!base64Data) throw new Error("放大失敗");

    return await saveImagesToStorage([base64Data], {
        prompt: "Upscaled Image",
        aspectRatio: "Original",
        size: `${targetSize}px (Upscaled)`,
        mode: "upscale"
    });
}

// === 工具函式 ===
async function saveImagesToStorage(base64DataArray, metadata) {
  const uploadPromises = base64DataArray.map(async (base64Data) => {
    const buffer = Buffer.from(base64Data, 'base64');
    const fileName = `ai-images/gen-${Date.now()}-${uuidv4()}.png`;
    const file = bucket.file(fileName);

    await file.save(buffer, {
      metadata: {
        contentType: 'image/png',
        cacheControl: 'public, max-age=31536000',
        metadata: { ...metadata }
      },
    });

    await file.makePublic();
    
    return {
        url: file.publicUrl(),
        ...metadata
    };
  });
  return Promise.all(uploadPromises);
}

async function vertexFetch(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const text = await response.text();
    let errorMsg = text;
    try { errorMsg = JSON.parse(text).error?.message || text; } catch(e) {}
    
    if (response.status === 404) {
        throw new Error(`找不到模型: ${url}。 (請確認該模型是否已在您的專案 Region 上架，且使用了正確的 v1/v1beta1 版本)`);
    }
    throw new Error(`Vertex AI Error (${response.status}): ${errorMsg}`);
  }
  return await response.json();
}