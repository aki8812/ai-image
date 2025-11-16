const {onRequest} = require("firebase-functions/v2/https");
const {initializeApp} = require("firebase-admin/app");
const {GoogleAuth} = require("google-auth-library"); 
const fetch = require("node-fetch");

// 初始化 Firebase Admin
initializeApp();

// --- Vertex AI 設定 ---
const PROJECT_ID = "us-computer-474205"; // 您的 GCP 專案 ID
const LOCATION = "us-central1"; // 您的 Vertex AI 所在區域
const API_VERSION = "v1"; // API 版本

// 模型名稱 (對應到您的文件)
const GENERATION_MODEL = "gemini-2.5-flash-image-preview"; // NanoBanana
const UPSCALING_MODEL = "imagegeneration@002"; // 用於圖片放大

// Vertex AI API 端點
const VERTEX_AI_ENDPOINT = `https://${LOCATION}-aiplatform.googleapis.com`;

// 獲取 GCP 驗證
const auth = new GoogleAuth({ 
  scopes: "https://www.googleapis.com/auth/cloud-platform",
});

/**
 * 主要的 Firebase Function
 * 處理來自前端的所有圖片生成請求
 */
exports.vertexImageGenerator = onRequest(
  {
    region: "us-central1", // 建議將 Function 部署在與 Vertex AI 相同的區域
    cors: true, // 允許來自您 Vercel 網站的跨域請求
    timeoutSeconds: 300, // 將超時延長到 5 分鐘，因為圖片生成很慢
    memory: "1GiB", // 為圖片處理提供更多記憶體
  },
  async (req, res) => {
    // 只接受 POST 請求
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }

    try {
      // 獲取動態的 OAuth 2.0 權杖
      const authToken = await auth.getAccessToken();
      const headers = {
        "Authorization": `Bearer ${authToken}`,
        "Content-Type": "application/json",
      };

      // 從前端請求中解析資料
      const {mode, prompt, numImages, image} = req.body; 
      let images = []; // 用於儲存回傳的 Base64 圖片

      // 根據模式呼叫不同的 Vertex AI API
      switch (mode) {
        case "generate":
          images = await handleGeneration(
            headers,
            prompt,
            image,
            numImages
          );
          break;
        case "upscale":
          images = await handleUpscaling(headers, prompt, image);
          break;
        default:
          throw new Error("無效的模式 (mode)。");
      }

      // 成功！回傳圖片陣列
      res.status(200).json({images: images});
    } catch (error) {
      console.error("Firebase Function 發生錯誤:", error);
      res.status(500).json({
        error: {
          message: error.message || "後端伺服器發生未知錯誤。",
          stack: error.stack, // (可選) 在開發中傳送堆疊資訊
        },
      });
    }
  }
);

/**
 * 1. 處理標準圖片生成 (NanoBanana)
 * 呼叫 streamGenerateContent API
 */
async function handleGeneration(headers, prompt, image, numImages) {
  // *** 關鍵修正：補上 projects/.../locations/... 路徑 ***
  const apiUrl = `${VERTEX_AI_ENDPOINT}/${API_VERSION}/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/${GENERATION_MODEL}:streamGenerateContent`;

  const parts = [];
  if (prompt) {
    parts.push({text: prompt});
  }
  if (image && image.base64Data) {
    parts.push({
      inlineData: {
        mimeType: image.mimeType,
        data: image.base64Data,
      },
    });
  }

  const payload = {
    contents: [{role: "user", parts: parts}],
  };

  const generationPromises = [];
  for (let i = 0; i < numImages; i++) {
    generationPromises.push(
      vertexFetch(apiUrl, {
        method: "POST",
        headers: headers,
        body: JSON.stringify(payload),
      })
    );
  }

  const results = await Promise.all(generationPromises);

  // 解析結果
  const images = results.map((result) => {
    // streamGenerateContent 回傳的是一個陣列
    const lastResponse = result[result.length - 1];
    const part = lastResponse.candidates?.[0]?.content?.parts?.find(
      (p) => p.inlineData
    );
    if (!part || !part.inlineData) {
      // 嘗試從 text 中獲取錯誤訊息 (如果 API 拒絕了請求)
      const errorText = lastResponse.candidates?.[0]?.content?.parts?.[0]?.text;
      if (errorText) {
        throw new Error(`NanoBanana API 錯誤: ${errorText}`);
      }
      throw new Error("NanoBanana API 未回傳圖片資料。");
    }
    return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
  });

  return images;
}

/**
 * 2. 處理圖片放大 (Imagen)
 * 呼叫 predict API
 */
async function handleUpscaling(headers, prompt, image) {
  const apiUrl = `${VERTEX_AI_ENDPOINT}/${API_VERSION}/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/${UPSCALING_MODEL}:predict`;

  if (!image || !image.base64Data) {
    throw new Error("缺少用於放大的圖片。");
  }

  const payload = {
    instances: [
      {
        image: {
          bytesBase64Encoded: image.base64Data,
        },
      },
    ],
    parameters: {
      // 根據文件，只需傳送圖片即可
    },
  };

  const result = await vertexFetch(apiUrl, {
    method: "POST",
    headers: headers,
    body: JSON.stringify(payload),
  });

  // 解析 Imagen predict API 的回傳
  const base64Data = result.predictions?.[0]?.bytesBase64Encoded;
  if (!base64Data) {
    throw new Error("Imagen Upscaling API 未回傳圖片資料。");
  }

  return [`data:image/png;base64,${base64Data}`];
}


/**
 * 封裝 Vertex AI 的 fetch 呼叫，統一處理錯誤
 */
async function vertexFetch(url, options) {
  const response = await fetch(url, options);

  if (!response.ok) {
    const errorText = await response.text();
    let errorJson = {};
    try {
      errorJson = JSON.parse(errorText);
    } catch (e) {
      // 錯誤不是 JSON 格式
    }
    
    // 嘗試從 Vertex AI 回傳的 JSON 錯誤中提取詳細訊息
    const message = errorJson.error?.message || errorText || response.statusText;
    console.error(`Vertex AI API 呼叫失敗 (HTTP ${response.status}):`, message);
    throw new Error(`Vertex AI 錯誤: ${message}`);
  }

  // 檢查是否為 streamGenerateContent 的 JSON 陣列回傳
  const responseText = await response.text();
  try {
    // 嘗試解析為 JSON (可能是 predict) 或 JSON 陣列 (可能是 streamGenerateContent)
    return JSON.parse(responseText);
  } catch (e) {
    console.error("無法解析 Vertex AI 的 JSON 回應:", responseText);
    throw new Error("無法解析來自 Vertex AI 的回應。");
  }
}