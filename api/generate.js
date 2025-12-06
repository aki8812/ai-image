// api/generate.js
const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getStorage } = require("firebase-admin/storage");
const { GoogleAuth } = require("google-auth-library");
const fetch = require("node-fetch");
const { v4: uuidv4 } = require('uuid');

// 取得 GCP 憑證
const getCredentials = () => {
  if (!process.env.GCP_CREDENTIALS) {
    throw new Error("缺少 GCP_CREDENTIALS 環境變數");
  }
  try {
    return JSON.parse(process.env.GCP_CREDENTIALS);
  } catch (e) {
    console.error("憑證解析失敗", e);
    throw new Error("GCP_CREDENTIALS 格式錯誤");
  }
};

const serviceAccount = getCredentials();

// =========== 設定區域 ===========
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
const API_VERSION = "v1";
// Vertex AI Base URL (給 Imagen 使用)
const VERTEX_AI_BASE = `https://${LOCATION}-aiplatform.googleapis.com/${API_VERSION}/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models`;
// Developer API Base URL (給 Gemini 3 / NanoBanana 使用)
const GEN_AI_BASE = `https://generativelanguage.googleapis.com/v1beta/models`;

const auth = new GoogleAuth({
  credentials: serviceAccount,
  scopes: ["https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/generative-language"],
});

export default async function handler(req, res) {
  // CORS 設定
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  try {
    const client = await auth.getClient();
    const authToken = await client.getAccessToken();
    
    // 預設標頭
    const headers = {
      "Authorization": `Bearer ${authToken.token}`,
      "Content-Type": "application/json",
      "x-goog-user-project": PROJECT_ID // Developer API 有時需要此標頭來歸屬 Quota
    };

    const body = req.body;
    let generatedResults = [];

    // 根據模式選擇處理函式
    if (body.mode === 'generate-nanobanana') {
        // NanoBanana Pro (改為呼叫 Developer API)
        generatedResults = await handleNanoBanana(headers, body);
    } else if (body.mode === 'upscale') {
        // 圖片放大 (Vertex AI)
        generatedResults = await handleUpscaling(headers, body);
    } else {
        // Imagen 4 系列 (Vertex AI)
        generatedResults = await handleImagen(headers, body);
    }

    res.status(200).json({ images: generatedResults });

  } catch (error) {
    console.error("API Error:", error);
    res.status(500).json({
      error: {
        message: error.message || "伺服器發生錯誤",
        detail: error.originalError
      },
    });
  }
}

// === 上半部：NanoBanana Pro (Gemini 3 Pro Image) ===
// 使用 Google Generative Language API (Developer API)
async function handleNanoBanana(headers, { prompt, aspectRatio, sampleImageSize }) {
    const modelId = "gemini-3-pro-image-preview"; 
    // 改用 Developer API 端點，而非 Vertex AI
    const apiUrl = `${GEN_AI_BASE}/${modelId}:generateContent`;

    // === 畫質處理 ===
    // 邏輯：只有在明確指定 2K 或 4K 時才傳送 imageSize，否則使用預設
    let targetImageSize;
    if (sampleImageSize === '4096') targetImageSize = "4K";
    else if (sampleImageSize === '2048') targetImageSize = "2K";
    
    // === 比例處理 ===
    const targetAspectRatio = aspectRatio || "1:1";

    // 構建 Payload (Developer API 偏好 CamelCase)
    const payload = {
        contents: [{ 
            role: "user", 
            parts: [{ text: prompt }] 
        }],
        tools: [{ googleSearch: {} }], // 注意: Developer API 這裡通常是 googleSearch (camelCase)
        generationConfig: {
            imageConfig: {
                aspectRatio: targetAspectRatio,
                // 僅在有值時加入 imageSize
                ...(targetImageSize && { imageSize: targetImageSize })
            }
        }
    };

    // 發送請求
    const result = await vertexFetch(apiUrl, {
        method: "POST",
        headers: headers,
        body: JSON.stringify(payload),
    });

    // 解析 Developer API 回傳格式 (通常與 SDK 結構一致)
    const candidates = result.candidates;
    if (!candidates || candidates.length === 0) {
        throw new Error("Gemini 未回傳候選結果 (Developer API)");
    }

    // 尋找 inlineData
    const imagePart = candidates[0].content?.parts?.find(p => p.inlineData);
    
    if (!imagePart) {
        const textPart = candidates[0].content?.parts?.find(p => p.text);
        if (textPart) {
            throw new Error(`Gemini 回傳了文字而非圖片: ${textPart.text}`);
        }
        throw new Error("Gemini 未生成圖片資料");
    }

    const base64Image = imagePart.inlineData.data;

    let displaySize = "1K (Default)";
    if (targetImageSize === "2K") displaySize = "2K";
    if (targetImageSize === "4K") displaySize = "4K";

    return await saveImagesToStorage([base64Image], {
        prompt: prompt,
        aspectRatio: targetAspectRatio,
        size: displaySize,
        mode: "generate-nanobanana"
    });
}

// ==========================================================
// === 下半部：Imagen 4 & Upscale (維持使用 Vertex AI) ===
// ==========================================================

// === 處理 Imagen 4 系列 (單圖輸入) ===
async function handleImagen(headers, { mode, prompt, images, numImages, aspectRatio, sampleImageSize }) {
    let modelId = "imagen-4.0-generate-001";
    if (mode === "generate-fast") modelId = "imagen-4.0-fast-generate-001";
    if (mode === "generate-ultra") modelId = "imagen-4.0-ultra-generate-001";

    // 維持 Vertex AI 路徑
    const apiUrl = `${VERTEX_AI_BASE}/${modelId}:predict`;

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
        prompt: prompt,
        aspectRatio: aspectRatio,
        size: sizeLabel,
        mode: mode
    });
}

// === 處理放大 (Upscale) ===
async function handleUpscaling(headers, { prompt, images, upscaleLevel }) {
    const targetSize = parseInt(upscaleLevel) || 2048;
    const modelId = "imagen-4.0-ultra-generate-001"; 
    const factor = targetSize > 2048 ? "x4" : "x2";
    
    // 維持 Vertex AI 路徑
    const apiUrl = `${VERTEX_AI_BASE}/${modelId}:predict`;

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
    if (!base64Data) throw new Error("放大失敗，API 未回傳圖片");

    return await saveImagesToStorage([base64Data], {
        prompt: "Upscaled Image",
        aspectRatio: "Original",
        size: `${targetSize}px (Upscaled)`,
        mode: "upscale"
    });
}

// === 通用函式：儲存到 Firebase ===
async function saveImagesToStorage(base64DataArray, metadata) {
  const uploadPromises = base64DataArray.map(async (base64Data) => {
    const buffer = Buffer.from(base64Data, 'base64');
    const fileName = `ai-images/gen-${Date.now()}-${uuidv4()}.png`;
    const file = bucket.file(fileName);

    await file.save(buffer, {
      metadata: {
        contentType: 'image/png',
        cacheControl: 'public, max-age=31536000',
        metadata: {
            prompt: metadata.prompt || "",
            mode: metadata.mode
        }
      },
    });

    await file.makePublic();
    
    return {
        url: file.publicUrl(),
        prompt: metadata.prompt,
        aspectRatio: metadata.aspectRatio,
        size: metadata.size,
        mode: metadata.mode
    };
  });

  return Promise.all(uploadPromises);
}

// === 通用函式：API 請求 ===
async function vertexFetch(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const text = await response.text();
    let errorMsg = text;
    try {
        const json = JSON.parse(text);
        errorMsg = json.error?.message || text;
    } catch(e) {}
    
    // 讓錯誤訊息更清楚
    if (response.status === 404) {
        throw new Error(`找不到模型 (404): ${url}。請確認模型 ID 是否正確，或 API 是否啟用。`);
    }
    
    throw new Error(`AI API Error (${response.status}): ${errorMsg}`);
  }
  return await response.json();
}