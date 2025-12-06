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
// 注意：Gemini 模型使用 generateContent 方法，路徑結構與 Imagen 略有不同
const VERTEX_AI_BASE = `https://${LOCATION}-aiplatform.googleapis.com/${API_VERSION}/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models`;

const auth = new GoogleAuth({
  credentials: serviceAccount,
  scopes: "https://www.googleapis.com/auth/cloud-platform",
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
    
    const headers = {
      "Authorization": `Bearer ${authToken.token}`,
      "Content-Type": "application/json",
    };

    const body = req.body;
    let generatedResults = [];

    // 根據模式選擇處理函式
    if (body.mode === 'generate-nanobanana') {
        // NanoBanana Pro (Gemini 3 Pro)
        generatedResults = await handleNanoBanana(headers, body);
    } else if (body.mode === 'upscale') {
        // 圖片放大 (Imagen Ultra)
        generatedResults = await handleUpscaling(headers, body);
    } else {
        // Imagen 4 系列 (Default, Fast, Ultra)
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

// === 處理 NanoBanana Pro (Gemini 3 Pro Image) ===
async function handleNanoBanana(headers, { prompt, images, aspectRatio, sampleImageSize }) {
    // 【修正】使用正確的 Gemini 3 Pro 影像模型 ID
    const modelId = "gemini-3-pro-image-preview"; 
    const apiUrl = `${VERTEX_AI_BASE}/${modelId}:generateContent`;

    // 構建 Gemini 的多模態輸入 (Multimodal Input)
    const parts = [{ text: prompt }];
    
    // 支援多張圖片 (最多 14 張)
    if (images && Array.isArray(images)) {
        images.forEach(img => {
            // 簡單驗證 base64
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

    // 參數設定
    // Gemini 的影像生成參數通常放在 generationConfig
    // 注意：Gemini 3 Pro 對於長寬比和解析度的控制方式可能與 Imagen 不同
    // 我們這裡使用 Prompt 增強 + generationConfig (如果 API 支援)
    
    // 處理長寬比 (AspectRatio)
    // 如果是特殊比例 (如 21:9)，Gemini 3 透過 Prompt 理解能力極強
    let promptSuffix = "";
    if (aspectRatio) promptSuffix += `\nAspect Ratio: ${aspectRatio}`;
    
    // 處理 4K 解析度
    if (sampleImageSize === '4096') {
        promptSuffix += `\nQuality: Ultra High Resolution (4K), Highly Detailed`;
    }

    if (promptSuffix) {
        parts[0].text += promptSuffix;
    }

    const payload = {
        contents: [{ role: "user", parts: parts }],
        generationConfig: {
            // 強制回應為影像
            responseModalities: ["IMAGE"],
            // 部分 Gemini 版本支援在此設定 aspectRatio，若不支援則會依賴 Prompt
            // sampleCount: 1 // Gemini 通常一次生成一張，或由後端決定
        }
    };

    const result = await vertexFetch(apiUrl, {
        method: "POST",
        headers: headers,
        body: JSON.stringify(payload),
    });

    // 解析 Gemini 回傳格式 (與 Imagen 不同)
    // 成功時結構通常為: candidates[0].content.parts[0].inlineData.data (Base64)
    if (!result.candidates?.[0]?.content?.parts) {
        console.error("Gemini Response:", JSON.stringify(result));
        throw new Error("NanoBanana Pro 未回傳有效的影像資料");
    }
    
    // 提取所有生成的圖片 (Gemini 可能一次回傳多張，但在 parts 陣列中)
    const base64Images = result.candidates[0].content.parts
        .filter(part => part.inlineData && part.inlineData.data)
        .map(part => part.inlineData.data);

    if (base64Images.length === 0) {
        throw new Error("模型未生成任何圖片 (被過濾或錯誤)");
    }

    // 決定顯示給前端的尺寸標籤
    let sizeLabel = "1K";
    if (sampleImageSize === '2048') sizeLabel = "2K";
    if (sampleImageSize === '4096') sizeLabel = "4K";

    return await saveImagesToStorage(base64Images, {
        prompt: prompt,
        aspectRatio: aspectRatio || "1:1",
        size: sizeLabel,
        mode: "generate-nanobanana"
    });
}

// === 處理 Imagen 4 系列 (單圖輸入) ===
async function handleImagen(headers, { mode, prompt, images, numImages, aspectRatio, sampleImageSize }) {
    let modelId = "imagen-4.0-generate-001";
    if (mode === "generate-fast") modelId = "imagen-4.0-fast-generate-001";
    if (mode === "generate-ultra") modelId = "imagen-4.0-ultra-generate-001";

    const apiUrl = `${VERTEX_AI_BASE}/${modelId}:predict`;

    const instances = [{ prompt: prompt }];
    
    // Imagen 只支援單張參考圖，取第一張
    if (images && images.length > 0) {
        instances[0].image = { bytesBase64Encoded: images[0].base64Data };
    }

    let safeNumImages = parseInt(numImages) || 1;
    safeNumImages = Math.max(1, Math.min(safeNumImages, 4));

    const parameters = {
        sampleCount: safeNumImages,
    };

    // 處理尺寸 (Imagen 支援 1K/2K)
    let sizeLabel = "1024x1024";
    if (sampleImageSize === '2048' || sampleImageSize === '4096') { 
        // 即使前端選 4K，Imagen 最高只支援 2K，所以降級處理但標示清楚
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
    const modelId = "imagen-4.0-ultra-generate-001"; // 使用 Ultra 進行放大
    const factor = targetSize > 2048 ? "x4" : "x2";
    
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
    throw new Error(`Vertex AI Error (${response.status}): ${errorMsg}`);
  }
  return await response.json();
}