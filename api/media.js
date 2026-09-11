const {
    delay,
    saveMediaToStorage,
    publishGcsUri,
    applyCors,
    requireAuth,
    agentFetch,
    gcsOutputPrefix
} = require("./_vertex.js");

const VIDEO_MODEL = "gemini-omni-flash-preview";

const MUSIC_MODELS = {
    clip: { id: "lyria-3-clip-preview", maxSeconds: 30, mode: "generate-lyria-clip" },
    pro: { id: "lyria-3-pro-preview", maxSeconds: 180, mode: "generate-lyria-pro" }
};

const VIDEO_TASKS = {
    "text-to-video": "text_to_video",
    "image-to-video": "image_to_video",
    "first-last": "image_to_video",
    reference: "reference_to_video",
    extend: "extend",
    edit: "extend"
};

const MAX_WAIT_MS = 40000;
const POLL_INTERVAL_MS = 5000;

const handler = async (req, res) => {
    if (!applyCors(req, res)) return;
    if (!requireAuth(req, res)) return;

    const body = req.body || {};

    try {
        if (body.mode === "poll") return res.status(200).json(await pollJob(body));
        if (body.mode === "music") return res.status(200).json(await startJob(buildMusicRequest(body), musicMeta(body)));
        if (body.mode === "video") return res.status(200).json(await startJob(buildVideoRequest(body), videoMeta(body)));
        throw new Error("不支援的生成模式");
    } catch (error) {
        console.error("Media API Error:", error);
        res.status(500).json({ error: { message: error.message } });
    }
};

const musicModel = (body) => MUSIC_MODELS[body.model] || MUSIC_MODELS.pro;

const clampVideoSeconds = (value) => Math.min(10, Math.max(3, parseInt(value, 10) || 8));

const clampMusicSeconds = (body) => {
    const seconds = parseInt(body.duration, 10);
    if (!seconds) return null;
    return Math.min(musicModel(body).maxSeconds, Math.max(10, seconds));
};

const clampBpm = (body) => {
    const bpm = parseInt(body.bpm, 10);
    if (!bpm) return null;
    return Math.min(200, Math.max(60, bpm));
};

const buildVideoPrompt = (body) => {
    const images = Array.isArray(body.images) ? body.images : [];
    const task = body.task || "text-to-video";
    const segments = [];

    if (task === "first-last" && images.length >= 2) {
        segments.push("[# Sources <FIRST_FRAME>@Image1 <LAST_FRAME>@Image2]");
    } else if (task === "image-to-video" && images.length >= 1) {
        segments.push("[# Sources <FIRST_FRAME>@Image1]");
    } else if (task === "reference" && images.length >= 1) {
        const refs = images.map((item, index) => `<IMAGE_REF_${index}>@Image${index + 1}`).join(" ");
        segments.push(`[# References ${refs}]`);
    }

    const scene = String(body.prompt || "").trim();
    if (!scene && task !== "extend") throw new Error("請先輸入影片描述");
    if (scene) segments.push(scene);

    return segments.join("\n");
};

const buildVideoRequest = (body) => {
    const images = Array.isArray(body.images) ? body.images : [];
    const task = body.task || "text-to-video";
    const follow = task === "extend" || task === "edit";

    if (follow && !body.previousUri) throw new Error("延伸或編輯需要先有一段已生成的影片");

    const input = [{ type: "text", text: buildVideoPrompt(body) }];

    if (follow) {
        input.push({ type: "video", uri: body.previousUri, mime_type: "video/mp4" });
    } else {
        images.slice(0, 3).forEach((item) => {
            if (!item || !item.base64Data) return;
            input.push({ type: "image", data: item.base64Data, mime_type: item.mimeType || "image/png" });
        });
    }

    const output = { type: "video", delivery: "uri", gcs_uri: gcsOutputPrefix("video") };

    if (!follow) {
        output.aspect_ratio = body.aspectRatio === "9:16" ? "9:16" : "16:9";
        output.resolution = ["720p", "1080p", "4k"].includes(body.resolution) ? body.resolution : "720p";
        output.duration = `${clampVideoSeconds(body.duration)}s`;
    }

    return {
        model: VIDEO_MODEL,
        input,
        response_format: [output],
        generation_config: { video_config: { task: VIDEO_TASKS[task] || "text_to_video" } },
        background: true
    };
};

const buildMusicRequest = (body) => {
    const scene = String(body.prompt || "").trim();
    if (!scene) throw new Error("請先描述你想要的音樂");

    const details = [];
    const seconds = clampMusicSeconds(body);
    const bpm = clampBpm(body);
    if (seconds) details.push(`Target length: about ${seconds} seconds`);
    if (bpm) details.push(`Tempo: ${bpm} BPM`);
    if (body.language) details.push(`Vocal language: ${body.language}`);

    if (body.vocals === "instrumental") details.push("Instrumental only, absolutely no vocals");
    else if (body.vocals) details.push(`Vocals: ${body.vocals}`);

    const segments = details.length ? [scene, details.join("\n")] : [scene];
    if (body.lyrics) segments.push(`Use these lyrics, keeping the section markers:\n${String(body.lyrics).trim()}`);
    else if (body.vocals !== "instrumental") segments.push("Write original lyrics and label each section with markers such as [Verse] and [Chorus].");

    const input = [{ type: "text", text: segments.join("\n\n") }];
    (Array.isArray(body.images) ? body.images : []).slice(0, 10).forEach((item) => {
        if (!item || !item.base64Data) return;
        input.push({ type: "image", data: item.base64Data, mime_type: item.mimeType || "image/png" });
    });

    return { model: musicModel(body).id, input };
};

const videoMeta = (body) => {
    const follow = body.task === "extend" || body.task === "edit";
    return {
        type: "video",
        prompt: body.prompt,
        aspectRatio: body.aspectRatio === "9:16" ? "9:16" : "16:9",
        size: body.resolution || "720p",
        duration: follow ? "已延伸" : `${clampVideoSeconds(body.duration)} 秒`,
        mode: "generate-omni"
    };
};

const musicMeta = (body) => ({
    type: "audio",
    prompt: body.prompt,
    aspectRatio: "-",
    size: clampMusicSeconds(body) ? `約 ${clampMusicSeconds(body)} 秒` : "長度由 AI 決定",
    mode: musicModel(body).mode
});

const startJob = async (payload, meta) => {
    const created = await agentFetch("/interactions", { method: "POST", body: JSON.stringify(payload) });
    const interaction = await waitForResult(created);

    if (interaction.status === "completed") return { status: "completed", meta, media: await finalize(interaction, meta) };
    assertNotFailed(interaction);
    return { status: "processing", interactionId: interaction.id, meta };
};

const pollJob = async (body) => {
    if (!body.interactionId) throw new Error("缺少工作編號");

    const current = await agentFetch(`/interactions/${encodeURIComponent(body.interactionId)}`);
    const interaction = await waitForResult(current);
    const meta = body.meta && typeof body.meta === "object" ? body.meta : { type: "video" };

    if (interaction.status === "completed") return { status: "completed", meta, media: await finalize(interaction, meta) };
    assertNotFailed(interaction);
    return { status: "processing", interactionId: interaction.id, meta };
};

const waitForResult = async (interaction) => {
    const deadline = Date.now() + MAX_WAIT_MS;
    let current = interaction;

    while (current.status !== "completed" && !isFailed(current) && Date.now() < deadline) {
        await delay(POLL_INTERVAL_MS);
        current = await agentFetch(`/interactions/${encodeURIComponent(current.id)}`);
    }
    return current;
};

const isFailed = (interaction) => ["failed", "cancelled", "expired"].includes(interaction.status);

const assertNotFailed = (interaction) => {
    if (!isFailed(interaction)) return;
    const reason = interaction.error?.message || extractContent(interaction).text;
    throw new Error(reason ? `生成失敗：${reason.substring(0, 200)}` : "生成失敗，請調整描述後再試一次");
};

const extractContent = (interaction) => {
    const blocks = [];
    const texts = [];
    const seen = new Set();

    const walk = (node) => {
        if (!node || typeof node !== "object" || seen.has(node)) return;
        seen.add(node);

        if (Array.isArray(node)) return node.forEach(walk);
        if (node.type === "user_input") return;

        const mime = node.mime_type || node.mimeType || "";
        const data = node.data || node.audioContent || node.bytesBase64Encoded;
        const uri = typeof node.uri === "string" && node.uri.startsWith("gs://") ? node.uri : node.gcsUri;

        if ((data || uri) && (node.type === "audio" || node.type === "video" || /^(audio|video)\//.test(mime))) {
            blocks.push({
                type: node.type === "video" || /^video\//.test(mime) ? "video" : "audio",
                data,
                uri,
                mime_type: mime || undefined
            });
            return;
        }

        if (node.type === "text" && node.text) texts.push(node.text);

        for (const [key, value] of Object.entries(node)) {
            if (key === "usage" || key === "input") continue;
            walk(value);
        }
    };

    walk(interaction);
    return { blocks, text: texts.join("\n").trim() };
};

const finalize = async (interaction, meta) => {
    const { blocks, text } = extractContent(interaction);
    const label = meta.type === "audio" ? "音樂" : "影片";

    if (blocks.length === 0) {
        throw new Error(text ? `模型未輸出${label}：${text.substring(0, 300)}` : `模型未輸出${label}，請調整描述後再試一次`);
    }

    const items = [];
    const inline = [];

    for (const block of blocks) {
        if (block.uri) {
            const published = await publishGcsUri(block.uri, meta.type);
            items.push({ ...published, prompt: meta.prompt, aspectRatio: meta.aspectRatio, size: meta.size, duration: meta.duration, mode: meta.mode, thoughts: text, gcsUri: block.uri });
        } else if (block.data) {
            inline.push({ base64Data: block.data, mimeType: block.mime_type || undefined });
        }
    }

    if (inline.length > 0) items.push(...await saveMediaToStorage(inline, { ...meta, thoughts: text }));
    if (items.length === 0) throw new Error(`模型未輸出${label}，請調整描述後再試一次`);

    return items.map((item) => ({ ...item, interactionId: interaction.id, canExtend: meta.type === "video" && Boolean(item.gcsUri) }));
};

module.exports = handler;
module.exports.config = { api: { bodyParser: { sizeLimit: "10mb" } } };
