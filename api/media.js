const {
    delay,
    saveMediaToStorage,
    applyCors,
    requireAuth,
    geminiFetch,
    geminiDownload
} = require("./_vertex.js");

const VIDEO_MODEL = "gemini-omni-1.1-flash";

const MUSIC_MODELS = {
    full: "lyria-3.5",
    clip: "lyria-3-clip-preview"
};

const CAMERA_PRESETS = {
    "push-in": "the camera slowly pushes in toward the subject",
    "pull-out": "the camera slowly pulls back away from the subject",
    "pan-left": "the camera pans smoothly to the left",
    "pan-right": "the camera pans smoothly to the right",
    "tilt-up": "the camera tilts upward",
    "tilt-down": "the camera tilts downward",
    "orbit": "the camera orbits around the subject in a smooth arc",
    "crane-up": "a crane shot rising high above the scene",
    "dolly-zoom": "a dolly zoom vertigo effect centred on the subject",
    "handheld": "handheld documentary camera with subtle natural shake",
    "drone": "a sweeping aerial drone shot",
    "static": "a locked-off static tripod shot",
    "follow": "the camera tracks and follows the subject from behind"
};

const SHOT_PRESETS = {
    "close-up": "close-up shot",
    "medium": "medium shot",
    "wide": "wide establishing shot",
    "extreme-wide": "extreme wide landscape shot",
    "macro": "macro detail shot",
    "over-shoulder": "over-the-shoulder shot",
    "low-angle": "low angle shot looking up",
    "high-angle": "high angle shot looking down",
    "pov": "first person point-of-view shot"
};

const STYLE_PRESETS = {
    cinematic: "cinematic film look, shallow depth of field, anamorphic lens, 35mm film grain",
    documentary: "natural documentary realism, available light",
    anime: "hand-drawn Japanese anime style, cel shaded",
    "3d": "stylised 3D animated feature film render",
    claymation: "stop-motion claymation with visible fingerprints",
    noir: "high contrast black and white film noir",
    vintage: "vintage 1970s film stock, warm faded colours",
    hyperreal: "hyper realistic, ultra detailed, photographic"
};

const LIGHTING_PRESETS = {
    golden: "golden hour sunlight with long warm shadows",
    blue: "blue hour twilight with cool ambient tones",
    neon: "neon night lighting with saturated colour reflections",
    soft: "soft diffused studio lighting",
    hard: "hard directional key light with deep shadows",
    backlit: "strong backlight creating a rim glow",
    overcast: "flat overcast daylight"
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

const preset = (table, key) => (key && table[key]) || "";

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

    const looks = [
        preset(SHOT_PRESETS, body.shot),
        preset(CAMERA_PRESETS, body.camera),
        preset(STYLE_PRESETS, body.style),
        preset(LIGHTING_PRESETS, body.lighting)
    ].filter(Boolean);

    if (looks.length > 0) segments.push(`Cinematography: ${looks.join("; ")}.`);

    if (body.audio === "silent") segments.push("Audio: ambient only, no dialogue and no music.");
    else if (body.audio === "dialogue") segments.push("Audio: include natural spoken dialogue for the characters.");
    else if (body.audio === "score") segments.push("Audio: include a fitting instrumental score and sound effects.");

    if (body.negative) segments.push(`Do not include: ${String(body.negative).trim()}.`);

    return segments.join("\n");
};

const buildVideoRequest = (body) => {
    const images = Array.isArray(body.images) ? body.images : [];
    const task = body.task || "text-to-video";

    if ((task === "extend" || task === "edit") && !body.previousId) {
        throw new Error("延伸或編輯需要先有一段已生成的影片");
    }

    const input = [{ type: "text", text: buildVideoPrompt(body) }];
    if (task !== "extend" && task !== "edit") {
        images.slice(0, 3).forEach((item) => {
            if (!item || !item.base64Data) return;
            input.push({ type: "image", data: item.base64Data, mime_type: item.mimeType || "image/png" });
        });
    }

    return {
        model: VIDEO_MODEL,
        input,
        response_format: {
            type: "video",
            aspect_ratio: body.aspectRatio === "9:16" ? "9:16" : "16:9",
            resolution: ["360p", "720p", "1080p", "4k"].includes(body.resolution) ? body.resolution : "720p",
            delivery: "uri"
        },
        background: true,
        store: true,
        ...(body.previousId && { previous_interaction_id: body.previousId })
    };
};

const buildMusicRequest = (body) => {
    const scene = String(body.prompt || "").trim();
    if (!scene) throw new Error("請先描述你想要的音樂");

    const details = [];
    if (body.genre) details.push(`Genre: ${body.genre}`);
    if (body.mood) details.push(`Mood: ${body.mood}`);
    if (body.instruments) details.push(`Instrumentation: ${body.instruments}`);
    if (body.bpm) details.push(`Tempo: around ${parseInt(body.bpm, 10) || 100} BPM`);
    if (body.key) details.push(`Key: ${body.key}`);
    if (body.language) details.push(`Vocal language: ${body.language}`);

    if (body.vocals === "instrumental") details.push("Instrumental only, absolutely no vocals");
    else if (body.vocals) details.push(`Vocals: ${body.vocals}`);

    const seconds = parseInt(body.duration, 10);
    if (body.musicModel !== "clip" && seconds > 0) details.push(`Target length: about ${seconds} seconds`);

    const segments = [scene];
    if (details.length > 0) segments.push(details.join("\n"));
    if (body.lyrics) segments.push(`Use these lyrics, keeping the section markers:\n${String(body.lyrics).trim()}`);
    else if (body.vocals !== "instrumental") segments.push("Write original lyrics and label each section with markers such as [Verse] and [Chorus].");
    segments.push("Before the audio, output the final lyrics and a timecoded structure outline.");

    const input = [{ type: "text", text: segments.join("\n\n") }];
    (Array.isArray(body.images) ? body.images : []).slice(0, 10).forEach((item) => {
        if (!item || !item.base64Data) return;
        input.push({ type: "image", data: item.base64Data, mime_type: item.mimeType || "image/png" });
    });

    return {
        model: MUSIC_MODELS[body.musicModel] || MUSIC_MODELS.full,
        input,
        background: true,
        store: true,
        ...(body.format === "wav" && { response_format: { type: "audio" } })
    };
};

const videoMeta = (body) => ({
    type: "video",
    prompt: body.prompt,
    aspectRatio: body.aspectRatio === "9:16" ? "9:16" : "16:9",
    size: body.resolution || "720p",
    mode: "generate-omni"
});

const musicMeta = (body) => ({
    type: "audio",
    prompt: body.prompt,
    aspectRatio: "-",
    size: body.musicModel === "clip" ? "30 秒" : `約 ${parseInt(body.duration, 10) || 120} 秒`,
    mode: body.musicModel === "clip" ? "generate-lyria-clip" : "generate-lyria"
});

const startJob = async (payload, meta) => {
    const created = await geminiFetch("/interactions", { method: "POST", body: JSON.stringify(payload) });
    const interaction = await waitForResult(created);

    if (interaction.status === "completed") return { status: "completed", meta, media: await finalize(interaction, meta) };
    assertNotFailed(interaction);
    return { status: "processing", interactionId: interaction.id, meta };
};

const pollJob = async (body) => {
    if (!body.interactionId) throw new Error("缺少工作編號");

    const current = await geminiFetch(`/interactions/${encodeURIComponent(body.interactionId)}`);
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
        current = await geminiFetch(`/interactions/${encodeURIComponent(current.id)}`);
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
    let text = "";

    for (const step of interaction.steps || []) {
        if (step.type === "user_input") continue;
        for (const content of step.content || []) {
            if (content.type === "text" && content.text) text += `${content.text}\n`;
            if (content.type === "video" || content.type === "audio") blocks.push(content);
        }
    }
    return { blocks, text: text.trim() };
};

const finalize = async (interaction, meta) => {
    const { blocks, text } = extractContent(interaction);
    const label = meta.type === "audio" ? "音樂" : "影片";

    if (blocks.length === 0) {
        throw new Error(text ? `模型未輸出${label}：${text.substring(0, 200)}` : `模型未輸出${label}，請調整描述後再試一次`);
    }

    const items = [];
    for (const block of blocks) {
        const base64Data = block.data || await geminiDownload(block.uri);
        items.push({ base64Data, mimeType: block.mime_type || undefined });
    }

    const saved = await saveMediaToStorage(items, { ...meta, thoughts: text });
    return saved.map((item) => ({ ...item, interactionId: interaction.id, canExtend: meta.type === "video" }));
};

module.exports = handler;
module.exports.config = { api: { bodyParser: { sizeLimit: "10mb" } } };
