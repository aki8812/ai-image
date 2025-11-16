const {onRequest} = require("firebase-functions/v2/https");
const {initializeApp} = require("firebase-admin/app");
const { getStorage } = require("firebase-admin/storage");
const {GoogleAuth} = require("google-auth-library"); 
const fetch = require("node-fetch");
const { v4: uuidv4 } = require('uuid'); 

initializeApp();

const bucket = getStorage().bucket();

const PROJECT_ID = "us-computer-474205"; 
const LOCATION = "us-central1"; 
const API_VERSION = "v1"; 

const MODEL_GENERATE_DEFAULT = "imagen-4.0-generate-001";
const MODEL_GENERATE_FAST = "imagen-4.0-fast-generate-001";
const MODEL_GENERATE_ULTRA = "imagen-4.0-ultra-generate-001";
const MODEL_UPSCALING = "imagen-4.0-generate-001"; 

const VERTEX_AI_ENDPOINT = `https://${LOCATION}-aiplatform.googleapis.com`;

const auth = new GoogleAuth({ 
  scopes: "https://www.googleapis.com/auth/cloud-platform",
});

exports.vertexImageGenerator = onRequest(
  {
    region: "us-central1", 
    cors: true, 
    timeoutSeconds: 300, 
    memory: "1GiB", 
  },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }

    try {
      const authToken = await auth.getAccessToken();
      const headers = {
        "Authorization": `Bearer ${authToken}`,
        "Content-Type": "application/json",
      };

      const {
        mode, 
        prompt, 
        numImages, 
        image, 
        aspectRatio, 
        sampleImageSize, 
        upscaleLevel    
      } = req.body; 
      
      let imageUrls = []; 

      switch (mode) {
        case "upscale":
          imageUrls = await handleUpscaling(
            headers, 
            prompt,
            image,
            upscaleLevel 
          );
          break;
        case "generate-default":
        case "generate-fast":
        case "generate-ultra":
          imageUrls = await handleGeneration(
            headers,
            mode,
            prompt,
            image,
            numImages,
            aspectRatio,
            sampleImageSize 
          );
          break;
        default:
          throw new Error(`無效的模式 (mode): ${mode}`);
      }
      
      res.status(200).json({images: imageUrls});

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

async function saveImagesToStorage(base64DataArray) {
  const uploadPromises = base64DataArray.map(async (base64Data) => {
    const buffer = Buffer.from(base64Data, 'base64');
    
    const fileName = `ai-images/generated-${Date.now()}-${uuidv4()}.png`;
    const file = bucket.file(fileName);

    await file.save(buffer, {
      metadata: {
        contentType: 'image/png',
        cacheControl: 'public, max-age=31536000', 
      },
    });

    await file.makePublic();
    
    return file.publicUrl();
  });

  return Promise.all(uploadPromises);
}


async function handleGeneration(headers, mode, prompt, image, numImages, aspectRatio, sampleImageSize) {
  
  let modelId = MODEL_GENERATE_DEFAULT; 
  if (mode === "generate-fast") modelId = MODEL_GENERATE_FAST;
  if (mode === "generate-ultra") modelId = MODEL_GENERATE_ULTRA;

  const apiUrl = `${VERTEX_AI_ENDPOINT}/${API_VERSION}/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/${modelId}:predict`;

  const instances = [];
  const instance = { prompt: prompt };
  
  if (image && image.base64Data) {
    instance.image = {
      bytesBase64Encoded: image.base64Data,
    };
  }
  instances.push(instance);

  let safeNumImages = parseInt(numImages) || 1;
  safeNumImages = Math.max(1, Math.min(safeNumImages, 4)); 

  const parameters = {
    sampleCount: safeNumImages,
  };
  
  if (sampleImageSize) {
    if (parseInt(sampleImageSize) === 2048) {
      parameters.sampleImageSize = "2K";
    } else {
      parameters.sampleImageSize = "1K"; 
    }
  }

  if (aspectRatio) {
    parameters.aspectRatio = aspectRatio; 
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

  if (!result.predictions || !Array.isArray(result.predictions)) {
      throw new Error("Imagen API 未回傳有效的 predictions 陣列。");
  }
  
  const base64Images = result.predictions.map(pred => {
      if (!pred.bytesBase64Encoded) {
          throw new Error("Imagen API 的 prediction 中缺少 bytesBase64Encoded。");
      }
      return pred.bytesBase64Encoded;
  });

  return await saveImagesToStorage(base64Images);
}

async function handleUpscaling(headers, prompt, image, upscaleLevel) { 
  
  const targetSize = parseInt(upscaleLevel) || 2048;

  let modelId;
  let factor;

  if (targetSize > 2048) { 
      modelId = MODEL_GENERATE_ULTRA; 
      factor = "x4";
  } else { 
      modelId = MODEL_UPSCALING; 
      factor = "x2";
  }
  
  const apiUrl = `${VERTEX_AI_ENDPOINT}/${API_VERSION}/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/${modelId}:predict`;

  if (!image || !image.base64Data) {
    throw new Error("缺少用於放大的圖片。");
  }
  
  if (!prompt) {
      prompt = " "; 
  }

  const payload = {
    instances: [
      {
        prompt: prompt,
        image: {
          bytesBase64Encoded: image.base64Data,
        },
      },
    ],
    parameters: {
      sampleCount: 1,
      mode: "upscale", 
      upscaleConfig: { 
        upscaleFactor: factor 
      }
    },
  };

  const result = await vertexFetch(apiUrl, {
    method: "POST",
    headers: headers,
    body: JSON.stringify(payload),
  });

  const base64Data = result.predictions?.[0]?.bytesBase64Encoded;
  if (!base64Data) {
    throw new Error("Imagen Upscaling API 未回傳圖片資料。");
  }

  return await saveImagesToStorage([base64Data]);
}

async function vertexFetch(url, options) {
  const response = await fetch(url, options);

  if (!response.ok) {
    const errorText = await response.text();
    let errorJson = {};
    try {
      errorJson = JSON.parse(errorText);
    } catch (e) {
    }
    
    const message = errorJson.error?.message || errorText || response.statusText;
    console.error(`Vertex AI API 呼叫失敗 (HTTP ${response.status}):`, message);
    throw new Error(`Vertex AI 錯誤: ${message}`);
  }

  const responseText = await response.text();
  try {
    return JSON.parse(responseText);
  } catch (e) {
    console.error("無法解析 Vertex AI 的 JSON 回應:", responseText);
    throw new Error("無法解析來自 Vertex AI 的回應。");
  }
}