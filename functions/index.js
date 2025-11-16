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

// --- 修正：模型名稱 (Imagen 4.0 系列) ---
const MODEL_GENERATE_DEFAULT = "imagen-4.0-generate-001";
const MODEL_GENERATE_FAST = "imagen-4.0-fast-generate-001";
const MODEL_GENERATE_ULTRA = "imagen-4.0-ultra-generate-001";
const MODEL_UPSCALING = "imagen-4.0-generate-001"; // Upscaling 也使用此模型

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
      const {mode, prompt, numImages, image, aspectRatio} = req.body; // 新增 3：獲取 aspectRatio
      let images = []; // 用於儲存回傳的 Base64 圖片

      // 根據模式呼叫不同的 Vertex AI API
      switch (mode) {
        case "upscale":
          images = await handleUpscaling(headers, image);
          break;
        case "generate-default":
        case "generate-fast":
        case "generate-ultra":
          images = await handleGeneration(
            headers,
            mode,
            prompt,
            image,
            numImages,
            aspectRatio // 新增 3：傳入 aspectRatio
          );
          break;
        default:
          throw new Error(`無效的模式 (mode): ${mode}`);
      }

      // 成功！回傳圖片陣列
      res.status(200).json({images: images});
    } catch (error) {
      console.error("Firebase Function 發生錯誤:", error);
      res.status(500).json({
        error: {
          message: error.message || "後端伺服器發生未知錯誤。",
          stack: error.stack,
        },
      });
    }
  }
);

/**
 * 1. 處理標準圖片生成 (Imagen 4.0)
 * 呼叫 :predict API
 */
async function handleGeneration(headers, mode, prompt, image, numImages, aspectRatio) { // 新增 3：接收 aspectRatio
  
  // 根據 mode 選擇模型 ID
  let modelId = MODEL_GENERATE_DEFAULT; // 預設
  if (mode === "generate-fast") modelId = MODEL_GENERATE_FAST;
  if (mode === "generate-ultra") modelId = MODEL_GENERATE_ULTRA;

  const apiUrl = `${VERTEX_AI_ENDPOINT}/${API_VERSION}/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/${modelId}:predict`;

  // 建立 :predict 的 instances
  const instances = [];
  const instance = { prompt: prompt };
  
  // 檢查是否有上傳圖片 (用於 圖+文 生成)
  if (image && image.base64Data) {
    instance.image = {
      bytesBase64Encoded: image.base64Data,
    };
  }
  instances.push(instance);

  // 建立 :predict 的 parameters
  const parameters = {
    sampleCount: numImages,
  };

  // 新增 3：如果傳來了長寬比，就加入 parameters
  if (aspectRatio && aspectRatio.includes(':')) {
    parameters.aspect_ratio = aspectRatio;
  }

  const payload = {
    instances: instances,
    parameters: parameters,
  };

  const result = await vertexFetch(apiUrl, {
    method: "POST",
    headers: headers,
    body: JSON.stringify(payload),
  });

  // 解析 Imagen predict API 的回傳
  if (!result.predictions || !Array.isArray(result.predictions)) {
      throw new Error("Imagen API 未回傳有效的 predictions 陣列。");
  }

  const images = result.predictions.map(pred => {
      if (!pred.bytesBase64Encoded) {
          throw new Error("Imagen API 的 prediction 中缺少 bytesBase64Encoded。");
      }
      return `data:image/png;base64,${pred.bytesBase64Encoded}`;
  });

  return images;
}

/**
 * 2. 處理圖片放大 (Imagen 4.0)
 * 呼叫 :predict API
 */
async function handleUpscaling(headers, image) {
  // 根據文件，Upscaling 使用 imagen-4.0-generate-001
  const modelId = MODEL_UPSCALING; 
  const apiUrl = `${VERTEX_AI_ENDPOINT}/${API_VERSION}/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/${modelId}:predict`;

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
      task: "upscale", // <-- 關鍵：告訴 Imagen 4.0 執行放大任務
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

  // :predict API 回傳的是單一 JSON 物件
  const responseText = await response.text();
  try {
    return JSON.parse(responseText);
  } catch (e) {
    console.error("無法解析 Vertex AI 的 JSON 回應:", responseText);
    throw new Error("無法解析來自 Vertex AI 的回應。");
  }
}