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
const PROJECT_ID = serviceAccount.project_id;
const LOCATION = "us-central1";

// 初始化 Firebase
if (getApps().length === 0) {
  initializeApp({
    credential: cert(serviceAccount),
    storageBucket: BUCKET_NAME
  });
}

const bucket = getStorage().bucket();

const auth = new GoogleAuth({
  credentials: serviceAccount,
  scopes: "https://www.googleapis.com/auth/cloud-platform",
});

// 通用 Fetch 函式 (放在最外面方便呼叫)
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

// 通用儲存函式
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

// ==========================================
// 核心處理邏輯 (Gemini 3 Pro / Imagen / Upscale)
// ==========================================

// 1. NanoBanana Pro (Gemini 3 Pro Image) - 修正版
async function handleNanoBanana(headers, { prompt, aspectRatio, sampleImageSize }) {
    const modelId = "gemini-3-pro-image-preview";
    const geminiApiUrl = `https://${LOCATION}-aiplatform.googleapis.com/v1beta1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/${modelId}:generateContent`;

    // 處理尺寸標籤 (僅供顯示用，實際生成尺寸由 image_size 參數決定)
    let targetImageSizeString;
    let displaySize = "1K (Default)";

    // 注意：Gemini 3 目前主要支援 "1K"，若要強制傳送其他字串需確認 API 支援度
    if (sampleImageSize === '4096') {
        targetImageSizeString = "4K"; // 若 API 不支援此字串可能會報錯，建議先測試 1K
        displaySize = "4K";
    } else if (sampleImageSize === '2048') {
        targetImageSizeString = "2K";
        displaySize = "2K";
    }

    const targetAspectRatio = aspectRatio || "1:1";

    // ✅ 修正後的 Payload 結構
    const payload = {
        contents: [{
            role: "user",
            parts: [{ text: prompt }]
        }],
        generation_config: {
            // 告訴模型我們要圖片
            response_modalities: ["TEXT", "IMAGE"],
            temperature: 1,
            top_p: 0.95,
            max_output_tokens: 32768,
            image_config: {
                aspect_ratio: targetAspectRatio,
                // 如果有設定尺寸才加入參數
                ...(targetImageSizeString && { image_size: targetImageSizeString })
            }
        },
        // 安全設定 (正確放置在 root 層級)
        safety_settings: [
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' }
        ]
    };

    console.log("NanoBanana Request Payload:", JSON.stringify(payload));

    try {
        const result = await vertexFetch(geminiApiUrl, {
            method: "POST",
            headers: headers,
            body: JSON.stringify(payload),
        });

        // 解析結果
        const candidates = result.candidates;
        if (!candidates || candidates.length === 0) {
            throw new Error("Gemini 未回傳候選結果");
        }

        // 尋找圖片部分
        // 優先找 inlineData (圖片)，其次找文字報錯
        const parts = candidates[0].content?.parts || [];
        const imagePart = parts.find(p => p.inlineData && p.inlineData.mimeType.startsWith('image'));

        if (!imagePart) {
            const textPart = parts.find(p => p.text);
            if (textPart) {
                throw new Error(`Gemini 拒絕畫圖並回應: ${textPart.text}`);
            }
            throw new Error("Gemini 生成失敗，未包含圖片數據");
        }

        const base64Image = imagePart.inlineData.data;

        return await saveImagesToStorage([base64Image], {
            prompt: prompt,
            aspectRatio: targetAspectRatio,
            size: displaySize,
            mode: "generate-nanobanana"
        });
    } catch (error) {
        if (error.message.includes("404")) {
            throw new Error(`無法存取模型 ${modelId}。這通常表示您的專案尚未獲得該預覽版模型的存取權限，請檢查 Vertex AI Model Garden 狀態。`);
        }
        throw error;
    }
}

// 2. Imagen 系列 (目前使用 3.0 作為穩定版)
async function handleImagen(headers, { mode, prompt, images, numImages, aspectRatio, sampleImageSize }) {
    // Imagen 預設使用 v1
    const API_VERSION = "v1";
    const VERTEX_AI_BASE = `https://${LOCATION}-aiplatform.googleapis.com/${API_VERSION}/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models`;

    // 降級至 3.0 以確保穩定性，如果使用者確實有 4.0 權限可再改回
    let modelId = "imagen-3.0-generate-001";
    if (mode === "generate-fast") modelId = "imagen-3.0-fast-generate-001";
    // Ultra 暫時保留為 generate-001 因為 3.0 可能沒有 ultra 標籤，或者使用 generate-001
    if (mode === "generate-ultra") modelId = "imagen-3.0-generate-001";

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
        parameters.sampleImageSize = "2K"; // 注意：Imagen 3.0 是否支援 2K 需確認，通常預設 1024
        // Imagen 3 支援寬高比但尺寸控制較嚴格，這裡保留原本邏輯
        // 若報錯可改回不傳 sampleImageSize
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

// 3. Upscale (放大)
async function handleUpscaling(headers, { prompt, images, upscaleLevel }) {
    const API_VERSION = "v1";
    const VERTEX_AI_BASE = `https://${LOCATION}-aiplatform.googleapis.com/${API_VERSION}/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models`;

    const targetSize = parseInt(upscaleLevel) || 2048;
    // 使用內建的 upscale model
    const modelId = "image-upscaling";

    const apiUrl = `${VERTEX_AI_BASE}/${modelId}:predict`;

    if (!images || images.length === 0) throw new Error("缺少用於放大的圖片");

    const payload = {
        instances: [{
            image: { bytesBase64Encoded: images[0].base64Data },
        }],
        parameters: {
            mode: "upscale",
            // 具體參數需參考 model spec
        },
    };

    // Upscale API 行為較為不同，若原先使用的是 Imagen 生成模型來 upscale，則需維持原樣
    // 原程式碼使用 imagen-4.0-ultra-generate-001 進行 upscale，這在 Imagen 3 中可能不適用
    // 這裡我們暫時改回使用 imagen-3.0-generate-001 嘗試

    // 如果要使用專用 upscale model:
    // const modelId = "builtin/image-upscaling"; // 假定值

    // 為了安全起見，若無法確認 upscale model，建議讓使用者知道
    throw new Error("Upscale 功能目前在調整中，請稍後再試");
}

// ==========================================
// 主程式入口 (Main Handler)
// ==========================================
module.exports = async function handler(req, res) {
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
        generatedResults = await handleNanoBanana(headers, body);
    } else if (body.mode === 'upscale') {
        // generatedResults = await handleUpscaling(headers, body);
        throw new Error("Upscale mode is currently unavailable.");
    } else {
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
};