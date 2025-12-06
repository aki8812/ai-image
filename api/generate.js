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

if (getApps().length === 0) {
  initializeApp({
    credential: cert(serviceAccount),
    storageBucket: `${serviceAccount.project_id}.appspot.com` 
  });
}

const bucket = getStorage().bucket();
const PROJECT_ID = serviceAccount.project_id;
const LOCATION = "us-central1"; 
const API_VERSION = "v1";
const VERTEX_AI_ENDPOINT = `https://${LOCATION}-aiplatform.googleapis.com`;

const auth = new GoogleAuth({
  credentials: serviceAccount,
  scopes: "https://www.googleapis.com/auth/cloud-platform",
});

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
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

    const {
      mode,
      prompt,
      numImages,
      image,
      aspectRatio,
      sampleImageSize,
      upscaleLevel
    } = req.body;

    let generatedResults = [];

    switch (mode) {
      case "upscale":
        generatedResults = await handleUpscaling(headers, prompt, image, upscaleLevel);
        break;
      case "generate-default":
      case "generate-fast":
      case "generate-ultra":
        generatedResults = await handleGeneration(headers, mode, prompt, image, numImages, aspectRatio, sampleImageSize);
        break;
      default:
        throw new Error(`無效的模式 (mode): ${mode}`);
    }

    res.status(200).json({ images: generatedResults });

  } catch (error) {
    console.error("API Error:", error);
    res.status(500).json({
      error: {
        message: error.message || "伺服器發生錯誤",
      },
    });
  }
}

async function saveImagesToStorage(base64DataArray, metadata) {
  const uploadPromises = base64DataArray.map(async (base64Data) => {
    const buffer = Buffer.from(base64Data, 'base64');
    const fileName = `ai-images/generated-${Date.now()}-${uuidv4()}.png`;
    const file = bucket.file(fileName);

    await file.save(buffer, {
      metadata: {
        contentType: 'image/png',
        cacheControl: 'public, max-age=31536000',
        metadata: {
            prompt: metadata.prompt || "",
            aspectRatio: metadata.aspectRatio || "1:1",
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

async function handleGeneration(headers, mode, prompt, image, numImages, aspectRatio, sampleImageSize) {
  let modelId = "imagen-4.0-generate-001";
  if (mode === "generate-fast") modelId = "imagen-4.0-fast-generate-001";
  if (mode === "generate-ultra") modelId = "imagen-4.0-ultra-generate-001";

  const apiUrl = `${VERTEX_AI_ENDPOINT}/${API_VERSION}/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/${modelId}:predict`;

  const instances = [{ prompt: prompt }];
  if (image && image.base64Data) {
    instances[0].image = { bytesBase64Encoded: image.base64Data };
  }

  let safeNumImages = parseInt(numImages) || 1;
  safeNumImages = Math.max(1, Math.min(safeNumImages, 4));

  const parameters = { sampleCount: safeNumImages };
  
  let sizeLabel = "1024x1024"; 
  if (sampleImageSize) {
    if (parseInt(sampleImageSize) === 2048) {
      parameters.sampleImageSize = "2K";
      sizeLabel = "2048x2048";
    } else {
      parameters.sampleImageSize = "1K";
      sizeLabel = "1024x1024";
    }
  }
  if (aspectRatio) parameters.aspectRatio = aspectRatio;

  const result = await vertexFetch(apiUrl, {
    method: "POST",
    headers: headers,
    body: JSON.stringify({ instances, parameters }),
  });

  if (!result.predictions) throw new Error("API 未回傳預測結果");

  const base64Images = result.predictions.map(p => p.bytesBase64Encoded);
  
  return await saveImagesToStorage(base64Images, {
      prompt: prompt,
      aspectRatio: aspectRatio,
      size: sizeLabel,
      mode: mode
  });
}

async function handleUpscaling(headers, prompt, image, upscaleLevel) {
  const targetSize = parseInt(upscaleLevel) || 2048;
  const modelId = targetSize > 2048 ? "imagen-4.0-ultra-generate-001" : "imagen-4.0-generate-001";
  const factor = targetSize > 2048 ? "x4" : "x2";
  
  const apiUrl = `${VERTEX_AI_ENDPOINT}/${API_VERSION}/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/${modelId}:predict`;

  if (!image || !image.base64Data) throw new Error("缺少圖片");

  const payload = {
    instances: [{
      prompt: prompt || " ",
      image: { bytesBase64Encoded: image.base64Data },
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

async function vertexFetch(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Vertex AI Error: ${response.statusText} - ${text}`);
  }
  return await response.json();
}